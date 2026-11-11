// SIGN-IN KIT — /AuthApi/{me,request-link,verify,google,password,logout}.
//
//   GET  /AuthApi/config             { appName, googleClientId, openSignup, magicLinkTtlMinutes, emailSignIn } — what the sign-in page renders from
//   GET  /AuthApi/me                 { authenticated, user? } — session state, enriched from the row
//   GET  /AuthApi/verify?token=      redeem a magic link → session cookie → 302 to `next` or /
//   GET  /AuthApi/logout             clear the cookie (also POST)
//   POST /AuthApi/request-link       { email } → { ok: true }, sending a link when it may; 503 email_not_configured when this app has no mail key
//   POST /AuthApi/google             { credential } → session cookie + { ok, user }
//   POST /AuthApi/password           { email, password } → admin-only password sign-in, 10 misses / 15 min per email
//   POST /AuthApi/logout
//
// Rules this file embodies (CLAUDE.md §4): loadAsInstance = false and checkPermission =
// false (1); sub-paths via target.pathname and query via queryParams() with the
// getContext() fallback (4); auth failures are 403, never 401 (20); every response is
// no-store (lib/http.js json()); magic-link requests answer 200 whether or not the address
// exists, so the endpoint cannot enumerate accounts — and the one refusal it has, mail not set up,
// is decided before the address is read, so it is the same for every request; a redeemed link is deleted before
// anything else is checked (lib/auth.js redeemMagicLink); and when the app names its owner (`OWNER_EMAIL`),
// the owner's first sign-in by link, invite or Google while the app has no administrator makes them it
// (lib/auth.js `ownerTakesSeat`), and nobody else's sign-in does.

import { Resource } from 'harperdb'
import { db } from '../lib/db.js'
import {
  ROLE_ADMIN, ROLE_MEMBER, MAGIC_LINK_TTL_SECONDS,
  normalizeEmail, findUserByEmail, findUserByGoogleSub, findUserById, claimUserForEmail, sanitizeUser,
  verifyGoogleIdToken, checkPasswordAttempt, burnPasswordVerify, createSessionToken, buildSessionCookie, buildLogoutCookie,
  getSessionUser, sessionMatchesRow, issueMagicLink, redeemMagicLink, magicLinkUrl,
  ownerMayJoin, ownerTakesSeat,
} from '../lib/auth.js'
import { json, pathFrom, queryParams } from '../lib/http.js'
import { clientIp, previewPath, redirect, runAuthed } from '../lib/sign-in-support.js'
import { sendEmail, emailShell, escapeHtml } from '../lib/email.js'
import { config } from '../lib/sign-in-config.js'

// Where a failed link lands. A site-relative path on purpose — never a full URL from the
// request — and the same page the client sends a 403 `auth_required` to (src/api/client.ts).
const SIGN_IN_PATH = '/login'

// MAIL THAT IS NOT SET UP IS SAID, NOT HIDDEN. On a real build the app had
// no mail key, answered "a sign-in link is on its way", wrote the link only to its own server log, and
// — because open sign-up makes the account before sending — created an ordinary member, which closed
// first-admin setup for good. So with no key this route refuses BEFORE it reads the address: no account
// is made, no link is issued and nothing is logged. Because the check comes before any lookup, every
// request gets the same answer, so it says nothing about whether an account exists. The sentence is
// PLACEHOLDER wording. 503 and a code, like Google's `google_unavailable` below:
// this app cannot do it right now, and the visitor did nothing wrong.
// THIS COVERS LOCAL DEV TOO, deliberately: `harper dev .` with no key used to print the link to the
// console, and now refuses like any other app with no mail. Sign in there with the admin password
// (`POST /AuthApi/password`), mint a link with `scripts/mint-signin-link.js`, or set a key.
const EMAIL_NOT_CONFIGURED = Object.freeze({
  error: 'This app cannot send sign-in emails yet, so no link was sent. Ask the owner of this app to finish setting up email.',
  code: 'email_not_configured',
})

export class AuthApi extends Resource {
  static loadAsInstance = false

  async get (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      const path = pathFrom(target)
      if (path === 'config') return this.configForClient()
      if (path === 'me') return this.me()
      if (path === 'verify') return this.verify(queryParams(target, this))
      if (path === 'logout') return this.logout()
      return json({ error: 'not found' }, 404)
    })
  }

  async post (target, data) {
    target.checkPermission = false
    return runAuthed(async () => {
      const path = pathFrom(target)
      const body = data && typeof data === 'object' ? data : {}
      if (path === 'request-link') return this.requestLink(body)
      if (path === 'google') return this.google(body)
      if (path === 'password') return this.password(body)
      if (path === 'logout') return this.logout()
      return json({ error: 'not found' }, 404)
    })
  }

  /**
   * Public, and only what the sign-in page needs: the Google client id is the same value the
   * rendered button carries, and open signup decides whether the page says "create an
   * account" or "ask for an invite". Nothing here is a secret; lib/config.js keeps those.
   */
  configForClient () {
    return json({
      appName: config.appName(),
      googleClientId: config.google.clientId() || null,
      openSignup: config.auth.openSignup(),
      magicLinkTtlMinutes: MAGIC_LINK_TTL_SECONDS / 60,
      // So the page can say mail is not set up BEFORE anybody types an address. A fact about this
      // app's configuration and about no account.
      emailSignIn: config.email.configured(),
    })
  }

  async me () {
    const session = getSessionUser(this)
    if (!session) return json({ authenticated: false })
    // Enriched from the row so a role change shows on the next page load, and a
    // deactivated user reads as signed out even while their token is unexpired.
    // sessionMatchesRow is the third caller of the same verdict requireAdmin and loadCaller use
    // (lib/auth.js): a token stays validly signed while the row underneath it is
    // reassigned, and this method is the one that hands the ROW back to the caller — so without
    // it the loser of a bootstrap race reads `authenticated: true` with the winner's email, name
    // and role: 'admin', learning an identity that is not theirs and being drawn by the SPA as a
    // signed-in admin whose every data call then 403s. Treated exactly like the deactivated
    // case, cookie cleared, because both mean "this cookie is no longer anybody's session".
    const row = await findUserById(session.userId)
    if (!row || row.deactivatedAt || !sessionMatchesRow(session, row)) return json({ authenticated: false }, 200, { cookies: [buildLogoutCookie()] })
    return json({ authenticated: true, user: sanitizeUser(row) })
  }

  logout () {
    return json({ ok: true }, 200, { cookies: [buildLogoutCookie()] })
  }

  async requestLink (data) {
    // FIRST, above the address: see EMAIL_NOT_CONFIGURED. Moved below the lookup or the claim, the
    // answer would depend on the account, and an unsendable request would make a member again.
    if (!config.email.configured()) return json(EMAIL_NOT_CONFIGURED, 503)
    const email = normalizeEmail(data?.email)
    // Malformed input still answers ok: a helpful error would leak that a specific address
    // does not exist. We just do not spend a send on it.
    if (!email) return json({ ok: true })
    let user = await findUserByEmail(email)
    // THE OWNER'S ADDRESS GETS ITS ACCOUNT EVEN ON AN INVITE-ONLY APP AND INSIDE A FULL QUOTA, while the
    // administrator's seat is still theirs (lib/auth.js `ownerMayJoin`): nobody can invite
    // them, because there is no administrator, and a quota filled by strangers must not close their
    // seat. The account is an ordinary member until the link is redeemed — this proves nothing yet.
    // The BODY is the same { ok } either way. The work is not, and that is an accepted limit rather than
    // an oversight: the owner's address takes one extra indexed read, and on an
    // invite-only app an account and a send, so timing could tell "this is the owner's address" from
    // another unknown one while no admin exists. Strangers' addresses take no extra read
    // (`ownerMayJoin` returns before reading).
    const ownerJoins = !user && await ownerMayJoin(email)
    // A claim, not a put: two first requests for one address write one row (lib/auth.js).
    if (!user && (config.auth.openSignup() || ownerJoins)) {
      const claim = await claimUserForEmail({ email, role: ROLE_MEMBER, exemptFromQuota: ownerJoins })
      // Over the accounts quota the answer is still { ok } — anything else would say which
      // addresses are new — but no row is made and no link is sent.
      if (claim.refused) {
        console.log('[auth] sign-up by link refused: the accounts quota is reached')
        return json({ ok: true })
      }
      user = claim.user
    }
    if (!user || user.deactivatedAt) {
      console.log(`[auth] magic link requested for ${user ? 'a deactivated' : 'an unknown'} address`)
      return json({ ok: true })
    }
    const { token, rateLimited } = await issueMagicLink(user)
    if (rateLimited) return json({ ok: true })
    const url = magicLinkUrl(token)
    const name = config.appName()
    await sendEmail({
      to: email,
      subject: `Sign in to ${name}`,
      template: 'magic-link',
      // The one send that skips the suppression list: the recipient asked for it this
      // second, and "we could not check the list" must not read as "the link never came".
      force: true,
      text: `Sign in to ${name}:\n\n${url}\n\nThis link expires in ${MAGIC_LINK_TTL_SECONDS / 60} minutes and works once. If you didn't request it, ignore this email.`,
      html: emailShell({
        title: `Sign in to ${name}`,
        preheader: 'Your one-time sign-in link.',
        body: `<p>Click the button to sign in. The link works once and expires in ${MAGIC_LINK_TTL_SECONDS / 60} minutes.</p>
<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#1c1917;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Sign in</a></p>
<p style="font-size:13px;color:#78716c;">Or paste this link into your browser:<br><span style="word-break:break-all;">${escapeHtml(url)}</span></p>
<p style="font-size:12px;color:#a8a29e;">If you didn't request this, you can ignore it.</p>`,
      }),
    })
    return json({ ok: true })
  }

  /**
   * Redirect on every failure, never a 4xx: the visitor arrived from an email, not from
   * fetch(), so a JSON error would be a dead end and a 401 would be a basic-auth dialog.
   */
  async verify (params) {
    const token = params.get('token')
    const link = await redeemMagicLink(token)
    if (!link) return redirect(previewPath(`${SIGN_IN_PATH}?error=invalid-link`))
    const user = await findUserById(link.userId)
    if (!user) return redirect(previewPath(`${SIGN_IN_PATH}?error=user-missing`))
    if (user.deactivatedAt) return redirect(previewPath(`${SIGN_IN_PATH}?error=deactivated`))
    const now = new Date().toISOString()
    // THE OWNER'S FIRST SIGN-IN WHILE THE APP HAS NO ADMINISTRATOR MAKES THEM IT. A redeemed
    // link is the proof — it went to that inbox — and an invite is a link too, so this covers both. The
    // role rides on the same put, so the cookie minted below says admin from its first request.
    const promote = await ownerTakesSeat(user, link.email)
    const updated = { ...user, ...(promote ? { role: ROLE_ADMIN } : {}), lastLoginAt: now, updatedAt: now }
    await db.User.put(updated)
    if (promote) console.log(`[auth] the app owner signed in, and user ${user.id} is now this app's administrator`)
    // EVERY `Location` THIS ROUTE ISSUES IS PREFIXED IN THE PREVIEW COPY.
    // The cookie minted just above is stamped `stage` and is REFUSED by the published copy, so an
    // unprefixed redirect lands the person signed out on the live app — which is the flow
    // `publicBaseFor` exists to keep whole. `preview-acceptance` asserts every redirect here goes
    // through `previewPath`, so a fifth one added without it reds.
    return redirect(previewPath(safeNext(params.get('next'))), { cookies: [buildSessionCookie(createSessionToken(updated))] })
  }

  async google (data) {
    const idToken = data?.credential ?? data?.idToken
    if (!idToken) return json({ error: 'missing credential' }, 400)
    if (!config.google.clientId()) return json({ error: 'Google sign-in is not configured', code: 'google_unavailable' }, 503)
    const google = await verifyGoogleIdToken(idToken)
    if (!google) return json({ error: 'invalid token' }, 403)

    let user = (await findUserByGoogleSub(google.sub)) ?? (await findUserByEmail(google.email))
    if (!user) {
      // The owner's address is let in on an invite-only app and inside a full quota while the seat is
      // theirs — requestLink above says why.
      const ownerJoins = await ownerMayJoin(google.email)
      if (!config.auth.openSignup() && !ownerJoins) return json({ error: 'This email is not invited', code: 'not_invited' }, 403)
      const claim = await claimUserForEmail({ email: google.email, name: google.name, role: ROLE_MEMBER, googleSub: google.sub, exemptFromQuota: ownerJoins })
      // A Google sign-in that cannot make an account says so: 403 quota_exceeded, never 401.
      if (claim.refused) return claim.refused
      user = claim.user
    }
    if (user.deactivatedAt) return json({ error: 'Account is deactivated', code: 'deactivated' }, 403)
    const now = new Date().toISOString()
    // A verified Google identity is a proof of the address, so the owner's first sign-in here takes the
    // administrator's seat exactly as a redeemed link does (lib/auth.js `ownerTakesSeat`
    // compares the account's address AND Google's, so a row found by `sub` that is somebody else's
    // account is never promoted).
    const promote = await ownerTakesSeat(user, google.email)
    // Bind the Google identity and fill a blank name; never clobber a name or role the row has — the
    // owner's promotion is the one role this route ever writes.
    const updated = { ...user, ...(promote ? { role: ROLE_ADMIN } : {}), googleSub: user.googleSub ?? google.sub, name: user.name ?? google.name ?? null, lastLoginAt: now, updatedAt: now }
    await db.User.put(updated)
    if (promote) console.log(`[auth] the app owner signed in with Google, and user ${user.id} is now this app's administrator`)
    return json({ ok: true, user: sanitizeUser(updated) }, 200, { cookies: [buildSessionCookie(createSessionToken(updated))] })
  }

  async password (data) {
    const email = normalizeEmail(data?.email)
    const password = String(data?.password ?? '')
    if (!email || !password) return json({ error: 'email and password required' }, 400)
    const row = await findUserByEmail(email)
    // One message for "no user", "not an admin", "no password set", "wrong password" and
    // "too many misses": this endpoint must not tell a prober which of those it hit. The
    // counter runs on every existing row, admin or not, and is checked before the role, so
    // its verdict cannot be read as a role either.
    // An unknown email spends the same PBKDF2 a wrong password does, so the two
    // misses are the same size on the clock as well as on the wire.
    const attempt = row ? await checkPasswordAttempt(row, password, { ip: clientIp(this) }) : { ok: burnPasswordVerify(password), rateLimited: false }
    const ok = attempt.ok && !row.deactivatedAt && row.role === ROLE_ADMIN
    if (!ok) return json({ error: 'invalid email or password' }, 403)
    const now = new Date().toISOString()
    // A success closes the window: the misses before it were the owner's typos, not a probe.
    const updated = { ...row, passwordAttemptTimestamps: [], lastLoginAt: now, updatedAt: now }
    await db.User.put(updated)
    return json({ ok: true, user: sanitizeUser(updated) }, 200, { cookies: [buildSessionCookie(createSessionToken(updated))] })
  }
}

/** Only a site-relative path may be a post-login destination — never an open redirect. */
function safeNext (next) {
  const s = typeof next === 'string' ? next : ''
  return /^\/(?!\/)[^\s]*$/.test(s) ? s : '/'
}
