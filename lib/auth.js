// SIGN-IN KIT — Google id-token verify, PBKDF2 password, HMAC session cookie, requireAuth
// throwing a Response 403, requireAdmin re-reading the row, and magic-link issue/redeem with
// a per-user rate limit and always-200 requests.
//
// One cookie: `__Host-im_session`. The `__Host-` prefix makes the browser refuse it unless
// it is Secure, Path=/ and carries NO Domain attribute, which is exactly the shape we want:
// host-only, so an app on its Immensus subdomain and the same app on a custom domain never
// share or shadow a session.
//
// NEVER 401. Harper's response layer appends `WWW-Authenticate: Basic` to every 401 it
// renders and the browser pops its native basic-auth dialog over our fetch (rule 20). Auth
// failures are a THROWN Response 403 with `code: 'auth_required'`; lib/http.js runAuthed()
// serves it as-is. The client treats that code as "go to sign-in".

import crypto from 'node:crypto'
import { db, selectedDatabaseName } from './db.js'
import { DEFAULT_DATABASE } from './config.js'
import { config } from './sign-in-config.js'
import { ROLE_ADMIN, ROLE_MEMBER, MAGIC_LINK_TTL_SECONDS, normalizeEmail, userIdFor, newUser, hashToken, generateToken, isAlreadyExists } from './identity.js'
import { headerOf, json } from './http.js'
import { publicBaseFor } from './sign-in-support.js'

export const COOKIE_NAME = '__Host-im_session'

// ── identity helpers (re-exported from lib/identity.js) ────────────────────────

// The PURE derivations live in lib/identity.js, which imports no `harperdb`, so
// anything seeding an account or a sign-in link from OUTSIDE a Harper worker —
// scripts/mint-signin-link.js, and the builder's QA seed through it — computes the same ids
// this file does instead of re-deriving them by reading the source. Every existing importer
// keeps importing them from here, and auth-acceptance asserts the two modules hand back the
// same function objects, so there is one implementation rather than a copy with a gate on it.
//
// RE-EXPORTED FROM THE LOCAL BINDINGS, never as `export { … } from './identity.js'`, and that
// is not style — measured on a real cluster. An `export … from` beside the `import …
// from` above makes TWO module requests for one specifier, and Harper's ESM linker then left
// this module UNLINKED: every resource 500'd with `ResourceLoadError … request for
// 'node:crypto' can not be resolved on module lib/auth.js that is not linked`, naming an
// import that had been there all along. Rule 24's shape, one level out — the unlinkable thing
// is the duplicate request, not the builtin. All 20 hermetic suites were green, because the
// probe loader resolves with Node's own linker.
export {
  ROLE_ADMIN, ROLE_MEMBER, MAGIC_LINK_TTL_SECONDS,
  normalizeEmail, userIdFor, newUser, hashToken, generateToken, isAlreadyExists,
}

export async function findUserByEmail (email) {
  const needle = normalizeEmail(email)
  if (!needle) return null
  for await (const row of db.User.search({ conditions: [{ attribute: 'email', value: needle }], limit: 1 })) return row
  return null
}

export async function findUserByGoogleSub (sub) {
  if (!sub) return null
  for await (const row of db.User.search({ conditions: [{ attribute: 'googleSub', value: String(sub) }], limit: 1 })) return row
  return null
}

export async function findUserById (id) {
  if (!id) return null
  return (await db.User.get(id)) ?? null
}

/** What a resource may hand back about a user. Never the hash, never the timestamps. */
export function sanitizeUser (row) {
  if (!row) return null
  return { id: row.id, email: row.email, name: row.name ?? null, role: row.role ?? ROLE_MEMBER, createdAt: row.createdAt ?? null }
}

/**
 * Create the account for an address, or return the one that already exists, inside the accounts
 * quota.
 *
 * ⚠ NOT atomic, and this comment claimed it was (read 2026-10-08). It said create()
 * "refuses a key that exists inside the write, so of two concurrent claims exactly one creates".
 * Harper's create() is a LOCAL getSync() then a staged write, and its commit path retries a
 * failed absence condition and then writes unconditionally — resources/Bootstrap.js's header
 * carries the measurement and the versions. So two concurrent claims on one address can both
 * create, and both are told they did.
 * What keeps this safe anyway is the OTHER half of it: the id is derived from the address
 * (userIdFor), so the race cannot produce two accounts that shadow each other on every lookup.
 * It produces one row holding one of the two writers'
 * name/role/googleSub, and two callers that each believe `created: true` — so the quota is
 * re-counted after the write below, and a caller must not read `created` as proof it was first.
 * The 409 branch is still right and still runs: it is the SEQUENTIAL guard, which is what
 * catches a double submit or a retry.
 *
 * Returns { user, created, refused }. `refused` is the 403 quota_exceeded Response when the
 * app's `members` quota (GENERATED lib/plan.js, loaded lazily like the other seams; absent
 * means unlimited) would be exceeded: checked before the write and re-counted after it, the
 * loser deleting the row it made. The caller decides how to serve it — AuthApi/request-link
 * still answers { ok } so the quota cannot be used to tell new addresses from known ones.
 *
 * Every place that turns an address into an account goes through here (AuthApi's open
 * sign-up and Google paths, AdminApi's invite), so the quota has one enforcement site;
 * Bootstrap claims its own fixed key and is never subject to it — and neither is the OWNER's
 * account while the administrator's seat is still theirs to take (`exemptFromQuota`, passed only by
 * AuthApi and only when `ownerMayJoin` says so). Without that, a stranger could fill the
 * quota with sign-ups — open sign-up makes the account before any email is read — and the owner could
 * then never make the account that becomes the administrator: another person's sign-up closing the
 * seat, which is the one thing the owner-seat rule forbids. It is one account, the same exemption the
 * first-come founder has always had.
 */
export async function claimUserForEmail ({ email, name = null, role = ROLE_MEMBER, googleSub = null, exemptFromQuota = false }) {
  const user = newUser({ email, name, role, googleSub })
  const plan = exemptFromQuota ? null : await loadPlan()
  const cap = plan ? plan.quota('members') : Infinity
  if (plan && await plan.atQuota(db.User, [], cap)) return { user: null, created: false, refused: plan.quotaResponse('members') }
  try {
    await db.User.create(user)
  } catch (err) {
    if (!isAlreadyExists(err)) throw err
    const existing = await findUserById(user.id)
    if (!existing) throw err
    return { user: existing, created: false, refused: null }
  }
  if (plan && await plan.overQuotaAfterWrite(db.User, [], cap)) {
    await db.User.delete(user.id)
    return { user: null, created: false, refused: plan.quotaResponse('members') }
  }
  return { user, created: true, refused: null }
}

let planModule
/** lib/plan.js is GENERATED: present in every built app, absent in a bare template, never required here. */
async function loadPlan () {
  if (planModule !== undefined) return planModule
  try {
    planModule = await import('./plan.js')
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') console.error('[auth] lib/plan.js failed to load; sign-ups are unbounded:', err?.message ?? err)
    planModule = null
  }
  return planModule
}

// ── the first administrator ──────────────────────────────────────────────────────

// THE PROBLEM. An app's first administrator used to be whoever posted to `POST /Bootstrap/` while the
// app had no account at all, so ANY first account closed the seat for good: on a real app a
// sign-in request made before the owner had set up created an ordinary member,
// and the owner's only way in was a hand-written database edit. Once sign-in email works, the first
// visitor who asks for a link does the same.
//
// THE RULE: the app owner's email
// becomes the first admin. The control plane delivers the owner's address as `OWNER_EMAIL`
// (lib/config.js `ownerEmail`), and the first sign-in FROM that address while
// the app has no active administrator makes that account the administrator. Nobody else's sign-up
// closes anything. That was chosen over keeping the seat open until an admin exists (first come, still) and
// over refusing sign-ups until one does (visitors turned away, and the seat still first come).
//
// WHAT COUNTS AS A SIGN-IN FROM THE ADDRESS is a proof of control over it, never a claim: a magic link
// or an invite redeemed at `AuthApi/verify` (the link went to that inbox), or a Google identity Google
// marked verified. Requesting a link proves nothing and promotes nothing. So the comparison is made
// twice, on the account's own address AND on the address the proof came from, and both must be the
// owner's: a Google account found by its `sub` whose row carries some other address is that other
// person's account.
//
// WHY THERE IS NO CLAIM PRIMITIVE HERE, and it is the same reason `Bootstrap.js`'s header spends a
// page on: Harper's create() is not an arbiter. Nothing needs one. The owner's account is keyed
// by their address (`userIdFor`), so every concurrent sign-in by the owner lands on ONE row and writes
// the same role into it — two promotions of one row are one administrator. And no other row can be
// promoted, because no other row carries the owner's address. The only other way to an administrator
// with none present is `POST /Bootstrap/`, and that is refused while an owner is named.
//
// ABSENT OR BLANK `OWNER_EMAIL` IS TODAY'S BEHAVIOUR, exactly: no promotion, and `Bootstrap` first
// come. A value that is set and is NOT an address is not absent — it is a platform defect — so it keeps
// `Bootstrap` refused (a stranger must not inherit the seat from our mistake) and promotes nobody, and
// says so once in the log without printing the value.

let warnedMalformedOwner = false

/**
 * Who sets up this app's administrator. `{ declared: false }` when no owner is named — `Bootstrap`
 * first come — and `{ declared: true, email }` when one is, with `email` the normalized
 * address, or `null` when the value is not one. Read per call: the value can arrive at a restart.
 */
export function ownerSetting () {
  const raw = config.ownerEmail()
  if (raw == null) return { declared: false, email: null }
  const email = normalizeEmail(raw)
  if (!email && !warnedMalformedOwner) {
    warnedMalformedOwner = true
    console.warn('[auth] OWNER_EMAIL is set and is not an email address, so nobody can become this app\'s first administrator until it is corrected')
  }
  return { declared: true, email }
}

/** Does the app have an administrator who can act? A deactivated admin cannot, so it does not count. */
export async function hasActiveAdmin () {
  for await (const row of db.User.search({ conditions: [{ attribute: 'role', value: ROLE_ADMIN }] })) if (!row.deactivatedAt) return true
  return false
}

/**
 * Is `email` the owner's, while the administrator's seat is still theirs to take? AuthApi asks this
 * before making the owner's account, so that the owner gets in on an invite-only app (nobody else can
 * invite them: there is no administrator) and inside a full accounts quota (`claimUserForEmail`'s
 * header). It grants nothing on its own — the account it lets AuthApi make is an ordinary member until
 * the owner proves the address at sign-in (`ownerTakesSeat`).
 */
export async function ownerMayJoin (email) {
  const { email: owner } = ownerSetting()
  if (!owner || normalizeEmail(email) !== owner) return false
  return !(await hasActiveAdmin())
}

/**
 * Does THIS sign-in make `row` the administrator? True when an owner is named, the account and the
 * address the sign-in proved are both the owner's, the account is active and not already an admin, and
 * the app has no active administrator. Callers write `role: 'admin'` into the same put that records
 * the sign-in, so a session minted from that row says admin from its first request.
 */
export async function ownerTakesSeat (row, provenEmail) {
  if (!row || row.deactivatedAt || row.role === ROLE_ADMIN) return false
  const { email: owner } = ownerSetting()
  if (!owner) return false
  if (normalizeEmail(row.email) !== owner || normalizeEmail(provenEmail) !== owner) return false
  return !(await hasActiveAdmin())
}

// ── Google ─────────────────────────────────────────────────────────────────────

let googleClient = null
/**
 * Verify a Google-issued ID token. Returns { email, name, picture, sub } or null.
 *
 * `google-auth-library` is a runtime dependency (deps-acceptance pins it), loaded LAZILY:
 * a static import puts every module that imports this file in an unlinked state on Fabric
 * if the package ever fails to resolve, and the probe runtime
 * never needs it — scripts/probe/loader.js points the specifier at a stub.
 */
export async function verifyGoogleIdToken (idToken) {
  if (!idToken) return null
  const audience = config.google.clientId()
  if (!audience) {
    console.warn('[auth] GOOGLE_CLIENT_ID is not set — Google sign-in is disabled')
    return null
  }
  try {
    if (!googleClient) {
      const { OAuth2Client } = await import('google-auth-library')
      googleClient = new OAuth2Client(audience)
    }
    const ticket = await googleClient.verifyIdToken({ idToken, audience })
    const payload = ticket.getPayload()
    if (!payload?.email || !payload.email_verified) return null
    return {
      email: payload.email.toLowerCase(),
      name: payload.name ?? payload.email.split('@')[0],
      picture: payload.picture ?? null,
      sub: String(payload.sub),
    }
  } catch (err) {
    console.warn('[auth] Google ID token verification failed:', err?.message ?? err)
    return null
  }
}

// ── passwords (admin only; every other user signs in by link or Google) ─────────

/** PBKDF2-SHA512, 100k rounds, per-user salt. Stored as "salt:hash". */
export function hashPassword (password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.pbkdf2Sync(String(password), salt, 100000, 64, 'sha512').toString('hex')
  return `${salt}:${hash}`
}

/** Timing-safe compare. False on any structural error rather than a throw. */
export function verifyPassword (password, stored) {
  if (!stored || typeof stored !== 'string') return false
  const parts = stored.split(':')
  if (parts.length !== 2) return false
  const [salt, hash] = parts
  const attempt = crypto.pbkdf2Sync(String(password ?? ''), salt, 100000, 64, 'sha512').toString('hex')
  const a = Buffer.from(hash, 'hex')
  const b = Buffer.from(attempt, 'hex')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// Every miss must cost one PBKDF2. verifyPassword() is the only expensive step
// in a password check, and a path that skips it — an unknown email, a full attempt window —
// answers measurably sooner than a wrong password: the account enumeration the generic 403
// body exists to prevent, moved into the clock. The throwaway hash is made once per process
// from random bytes, so the password handed to it can never match.
const DECOY_PASSWORD_HASH = hashPassword(crypto.randomBytes(16).toString('hex'))

/** Spend one PBKDF2 on a compare that cannot succeed. Always false. */
export function burnPasswordVerify (password) {
  verifyPassword(password, DECOY_PASSWORD_HASH)
  return false
}

// The only path that can mint an admin session from a guessable secret gets the same
// fixed-window counter the magic-link sender has (issueMagicLink below). Ten misses in
// fifteen minutes is far above any human's typo rate and far below any useful guess rate
// against a PBKDF2 hash; auth-acceptance pins both numbers.
export const PASSWORD_ATTEMPT_LIMIT = 10
export const PASSWORD_ATTEMPT_WINDOW_MINUTES = 15

/**
 * Verify a password behind a fixed-window attempt counter kept on the User row
 * (`passwordAttemptTimestamps`, the shape of `magicLinkSendTimestamps`).
 *
 * Returns { ok, rateLimited }. While the window is full the REAL hash is not checked — the
 * eleventh attempt is refused even with the right password, and the row is untouched, so
 * the window is fixed from the failures that filled it rather than extended by hammering.
 * The refusal still spends one PBKDF2 on the decoy hash (burnPasswordVerify), so a locked
 * account answers in the same time as a wrong password.
 * A miss under the limit is recorded on the row; a hit records nothing, and the caller
 * clears the list on the login write (AuthApi.password), so a success resets the window.
 *
 * Keyed by the row, i.e. the lowercased email, on purpose: the client IP (lib/http.js
 * clientIp) comes from a forwarded header — "for rate limits and Turnstile, never for
 * auth" — and a key that includes it is reset by rotating that header. The IP is logged
 * for the operator instead. A locked admin can still sign in by magic link or Google.
 */
export async function checkPasswordAttempt (user, password, { now = Date.now(), ip = null } = {}) {
  const windowMs = PASSWORD_ATTEMPT_WINDOW_MINUTES * 60 * 1000
  const recent = (Array.isArray(user.passwordAttemptTimestamps) ? user.passwordAttemptTimestamps : []).filter((t) => t > now - windowMs)
  if (recent.length >= PASSWORD_ATTEMPT_LIMIT) {
    console.log(`[auth] rate-limited password attempt for user ${user.id} from ${ip ?? 'unknown ip'} (${recent.length} misses in the last ${PASSWORD_ATTEMPT_WINDOW_MINUTES}min)`)
    return { ok: burnPasswordVerify(password), rateLimited: true }
  }
  // A row with no hash (every member; only admins have one) burns the decoy instead of
  // skipping the step, or "is this address an admin?" would be readable from the clock.
  const ok = user.passwordHash ? verifyPassword(password, user.passwordHash) : burnPasswordVerify(password)
  if (ok) return { ok: true, rateLimited: false }
  await db.User.put({ ...user, passwordAttemptTimestamps: [...recent, now].slice(-PASSWORD_ATTEMPT_LIMIT), updatedAt: new Date(now).toISOString() })
  return { ok: false, rateLimited: false }
}

// ── session cookie ─────────────────────────────────────────────────────────────

/**
 * HMAC-SHA256 over a base64url payload. Identity only — `role` is carried for the client's
 * routing convenience, but every admin action re-reads the row (requireAdmin below).
 *
 * ── `db` IS WHICH DATABASE THIS SESSION WAS MINTED AGAINST, AND IT IS A SECURITY FIELD ─────────
 *
 * `/preview` reads the staging database and is PUBLIC, and it shares ONE
 * origin with the app's own address. The cookie is `__Host-`, so it is `Path=/` and reaches both
 * by construction — that is the point of `__Host-` and must not change. Without this field the two
 * environments were one trust boundary:
 *
 * **The attack, which is why this field exists.** The
 * staging database is created by the platform and is not guaranteed to hold a `User` row, so
 * `POST /preview/Bootstrap` could be an OPEN first-admin claim. A visitor posts a name, a password
 * and **the founder's email**, gets an admin session whose `userId` is the fixed `first-admin`, and
 * replays the cookie on production — where `requireAdmin` re-reads `first-admin`, and
 * `sessionMatchesRow` compares the session's email against the row's and **passes**. Admin on real
 * data, from a public path, with every signature valid.
 *
 * **So the stamp is inside the signed payload** rather than beside it: a cookie name or a
 * `Path=/preview` could not be the guard, because a production cookie still reaches `/preview` and
 * a client controls neither.
 *
 * **ONE COOKIE SLOT IS SHARED BY THE TWO ENVIRONMENTS, AND THAT IS A VISIBLE SIDE EFFECT RATHER
 * THAN A LEAK.** The cookie is `__Host-`, so it is `Path=/` with no `Domain` — which is the shape
 * we want and is what makes it un-spoofable — and both environments are served from ONE origin. So
 * there is one slot: signing in on `/preview` overwrites a live session and the reverse, and the
 * stamp then **refuses** whichever was overwritten. A founder with the live app and the preview open
 * in two tabs is signed out of one of them.
 *
 * **Named rather than fixed, and the alternative is written down so the decision is visible.** A
 * different cookie NAME under the prefix would avoid it, and it is a bigger change than the preview
 * warrants: two slots, two logout paths, and a second thing that must not weaken the stamp — which
 * is the actual guard. The failure here is a sign-in prompt, not a wrong answer.
 *
 * **AN ABSENT STAMP IS THE DEFAULT DATABASE, which is the safe reading rather than a lenient one.**
 * Every token that exists today was minted before `/preview` did, so production is what issued it —
 * `verifySessionToken` therefore accepts an unstamped token on `data` and REFUSES it under the
 * prefix. The cost is stated: on a deploy whose own address reads `stage`, an unstamped token stops
 * working, which signs people out of a QA deploy and is the direction to be wrong in.
 */
export function createSessionToken (user, now = Date.now()) {
  const payload = {
    userId: user.id,
    email: user.email,
    name: user.name ?? null,
    role: user.role ?? ROLE_MEMBER,
    db: selectedDatabaseName(),
    exp: now + config.session.ttlHours() * 60 * 60 * 1000,
  }
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', config.session.secret()).update(payloadStr).digest('base64url')
  return `${payloadStr}.${sig}`
}

export function verifySessionToken (token, now = Date.now()) {
  if (!token || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payloadStr, sig] = parts
  const expectedSig = crypto.createHmac('sha256', config.session.secret()).update(payloadStr).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expectedSig)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString())
    if (!payload.exp || now > payload.exp) return null
    if (!payload.userId || !payload.email) return null
    // THE ENVIRONMENT CHECK. A signature proves we minted the token; it does not prove we minted it
    // against the rows now being read. See `createSessionToken`'s header for the attack this
    // refuses and why an absent stamp reads as the default database.
    if ((payload.db ?? DEFAULT_DATABASE) !== selectedDatabaseName()) return null
    return { userId: payload.userId, email: payload.email, name: payload.name ?? null, role: payload.role ?? ROLE_MEMBER }
  } catch {
    return null
  }
}

export function buildSessionCookie (token) {
  const maxAge = config.session.ttlHours() * 60 * 60
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`
}

export function buildLogoutCookie () {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`
}

export function readSessionCookie (resource) {
  const cookieHeader = headerOf(resource, 'cookie') ?? ''
  const match = cookieHeader.match(/(?:^|;\s*)__Host-im_session=([^;]+)/)
  return match ? match[1] : null
}

/** The verified session payload, or null. Never throws. */
export function getSessionUser (resource) {
  try {
    const raw = readSessionCookie(resource)
    if (!raw) return null
    return verifySessionToken(raw)
  } catch {
    return null
  }
}

// ── guards ─────────────────────────────────────────────────────────────────────

/**
 * 403, never 401 (see the header). `code` is what the client branches on:
 * `auth_required` → sign-in; `admin_required` → the admin area is not for this user.
 * No `WWW-Authenticate` header is ever set here, and auth-acceptance asserts it stays that way.
 */
export function authFailResponse (message, code = 'auth_required') {
  return json({ error: message, code }, 403)
}

/**
 * Does the session's identity still match the row it names? ONE implementation, called by
 * requireAdmin below and by loadCaller in lib/session.js — a verdict in two places is a copy
 * with a gate on it, a verdict in one place is a verdict.
 *
 * Why it is needed at all: a session is signed by us and carries { userId, email }, so a
 * token stays valid while the row underneath it is REASSIGNED — and a row can be reassigned,
 * because create() on a deterministic key does not refuse a concurrent writer
 * (resources/Bootstrap.js's header carries the measurement). Every caller already has the row
 * in hand, so this costs no read, and requireAuth stays token-only.
 *
 * THE CALLERS ARE THE THREE THINGS THAT TURN A COOKIE INTO AN IDENTITY, and listing them is the
 * point: requireAdmin below, loadCaller in lib/session.js, and AuthApi.me — which reaches a
 * session through getSessionUser rather than requireAuth, and is the one that hands the ROW back
 * to the caller. An earlier version of this comment said "nothing outside this file and
 * lib/session.js calls requireAuth", which was TRUE and was the wrong question: me() was
 * unguarded and the sentence read as though it were covered. So grep for
 * what turns a cookie into an identity — getSessionUser, verifySessionToken — and not for one
 * function's callers. A new session reader must call this, and no gate can tell you that, which
 * is why the three are named here.
 *
 * Each caller keeps its OWN refusal, and each is the generic one it already uses for a
 * re-read failure (rule 25): never a distinct code, which would tell a caller "this row is not
 * yours" — something they should not learn here.
 */
export function sessionMatchesRow (session, row) {
  if (!session || !row) return false
  const a = normalizeEmail(row.email)
  const b = normalizeEmail(session.email)
  // normalizeEmail() answers null for anything without an @ (lib/identity.js), so `a === b`
  // alone makes two addresses that BOTH fail to normalize match each other. Fail closed on a
  // null instead: a verdict that cannot establish identity refuses, which is the same
  // discipline userIdFor() already applies by handing an unnormalizable address a random id so
  // nothing collides on "invalid". Found by this function's own negative control.
  if (!a || !b) return false
  return a === b
}

export function requireAuth (resource) {
  const user = getSessionUser(resource)
  if (!user) throw authFailResponse('Authentication required')
  return user
}

/**
 * Admin check reads from the DB, NOT the session token (rule 3 in the back-end charter).
 * A user demoted after they last signed in keeps an admin-shaped token until it expires;
 * re-reading the row makes revocation take effect on the next request. A deactivated row
 * is not an admin either.
 *
 * It also requires sessionMatchesRow() above — the same revocation principle applied to
 * IDENTITY rather than to role. Without it the loser of a bootstrap race holds a
 * valid admin session on the winner's account.
 * An app that ADDS an email-change path signs that user out on their next request, which is
 * correct and is worth knowing before writing one; nothing in this tree rewrites an existing
 * row's email today, because every id is derived from it (userIdFor) and every write preserves
 * it.
 * ⚠ THAT DERIVATION DOES NOT SCOPE THE EXPOSURE TO THIS GUARD, and the first version of this
 * comment said it did. The argument was that because every
 * other User id is userIdFor(email), no member session can point at somebody else's row, so
 * loadCaller needed no check. The premise is true and the conclusion is backwards:
 * resources/Bootstrap.js overrides the id to FIRST_ADMIN_ID, which makes first-admin the ONE
 * User row whose id is not derived from its email — and therefore the one row where loadCaller
 * was exposed too. It re-reads the row, sees role admin and returns isAdmin: true, and canSee()
 * lets an admin read and write ACROSS owners, so the loser's cookie reached every owner-scoped
 * resource: rule 19, the worst bug this codebase can have. Hence one verdict, both callers.
 * The general form is this section's own: an inference drawn in the same breath as a measurement
 * inherits the measurement's authority, and the scoping sentence was the inference.
 */
export async function requireAdmin (resource) {
  const user = requireAuth(resource)
  const row = await findUserById(user.userId)
  if (!row || row.deactivatedAt || row.role !== ROLE_ADMIN) throw authFailResponse('Admin access required', 'admin_required')
  if (!sessionMatchesRow(user, row)) throw authFailResponse('Admin access required', 'admin_required')
  return { ...user, role: ROLE_ADMIN, row }
}

// ── magic links ────────────────────────────────────────────────────────────────

/**
 * Issue a single-use sign-in token for a user, rate-limited per user (N sends per window,
 * timestamps kept on the row, always the caller's job to answer 200
 * either way so an address cannot be enumerated).
 *
 * Returns { token, rateLimited }. `token` is null when rate-limited and the row is untouched.
 */
export async function issueMagicLink (user, { now = Date.now(), purpose = 'login' } = {}) {
  const windowMs = config.auth.magicLinkRateWindowMinutes() * 60 * 1000
  const limit = config.auth.magicLinkRateLimit()
  const recent = (Array.isArray(user.magicLinkSendTimestamps) ? user.magicLinkSendTimestamps : []).filter((t) => t > now - windowMs)
  if (recent.length >= limit) {
    console.log(`[auth] rate-limited magic-link send for user ${user.id} (${recent.length} in the last ${windowMs / 60000}min)`)
    return { token: null, rateLimited: true }
  }
  const { token, hash } = generateToken()
  await db.MagicLink.put({ id: hash, userId: user.id, email: user.email, purpose, createdAt: new Date(now).toISOString() })
  await db.User.put({ ...user, magicLinkSendTimestamps: [...recent, now].slice(-10), updatedAt: new Date(now).toISOString() })
  return { token, rateLimited: false }
}

/**
 * Redeem a token: returns the MagicLink row once and DELETES it, whatever happens next.
 * Deleting before the caller checks the user is deliberate — a link is burned by being
 * presented, so a deactivated user's link cannot be retried after reactivation, and
 * auth-acceptance asserts the row is gone after one use.
 */
export async function redeemMagicLink (token) {
  if (!token || typeof token !== 'string' || token.length > 256) return null
  const hash = hashToken(token)
  const link = await db.MagicLink.get(hash)
  if (!link) return null
  try { await db.MagicLink.delete(hash) } catch (err) { console.warn('[auth] could not delete a redeemed magic link:', err?.message ?? err) }
  return link
}

export function magicLinkUrl (token) {
  // PREVIEW-AWARE: a link sent from the preview copy comes back to `/preview`, where the `MagicLink`
  // row it needs actually lives (lib/copy.js says why that beats refusing the send).
  return `${publicBaseFor(config.publicAppUrl())}/AuthApi/verify?token=${encodeURIComponent(token)}`
}
