// SIGN-IN KIT — the first admin.
//
//   GET  /Bootstrap/   { needed, mode }  — is the administrator's seat still open, and how is it taken?
//   POST /Bootstrap/   { name, email, password } → creates the ONE first admin, signs them in — mode
//                      'claim' only; refused 403 `owner_signs_in` in mode 'owner'
//
// TWO WAYS AN APP GETS ITS FIRST ADMINISTRATOR, and which one is decided by the app's configuration and
// never by anything a visitor sends (the app owner's email becomes the first admin).
//
//   mode 'owner' — the app names its owner in `OWNER_EMAIL`, which the control plane delivers.
//     The owner's first sign-in by link, invite or Google while the app has no
//     active administrator makes that account the administrator (lib/auth.js `ownerTakesSeat`), and no
//     other sign-up closes the seat. POST here is REFUSED, before the body is read: a password form
//     proves nothing about who holds an address, so anyone could type the owner's and take the seat.
//     `needed` is "the app has no active administrator".
//   mode 'claim' — no owner is named, which is every app that predates the setting: first come, here.
//     Self-locking: once any User row exists, POST answers 410 forever, and
//     every later account arrives through AuthApi (magic link / Google) or an admin invite. `needed` is
//     "the app has no user yet".
//
// ⚠ THE CREATE IS NOT THE ARBITER, AND THIS COMMENT SAID IT WAS (read 2026-10-08).
// "No users yet, then put()" really was check-then-act and really did seat two founders,
// so that fix was right about the KEY and wrong about why. create() is check-then-act too:
// Harper's own create() is a LOCAL, non-transactional `primaryStore.getSync(id)` followed by a
// staged write, byte-identical at harper@5.2.13 and @5.3.1 — the two versions this project runs
// — read from the published source of each (`npm pack harper@<version>`;
// the package is `harper`, not `harperdb`, which stops at 4.7.x).
// Two requests that both read "absent" both proceed, and the commit path does not save it: it
// conditions each write on `ifVersion(key, <absent>)`, which IS atomic and does refuse — and
// then, on that refusal, RETRIES with the now-present version and escalates to an exclusive
// transaction that re-reads and writes unconditionally ("return true; // always success",
// LMDBTransaction.ts). So the loser's row overwrites the winner's, between two worker THREADS
// of one node, with no replication involved. Harper has the primitive, uses it internally, and
// discards it by design, because its job is last-writer-wins convergence and not refusal.
//
// WHAT create() STILL BUYS, because it is worth keeping and the over-correction is to drop it:
// it refuses a key that was already committed and locally visible when it ran. That is a sound
// guard against a SEQUENTIAL duplicate — a retry, a double submit, a second bootstrap after the
// first completed — and it is not an arbiter of a concurrent one. It stays for that.
//
// WHAT BOUNDS THE DAMAGE is the fixed key, which is the half of the fix that holds: every
// claimant writes FIRST_ADMIN_ID, so the race converges on ONE row instead of two founders.
// What a deterministic key cannot do is decide WHOSE row it is.
//
// SO THE RESIDUAL, stated rather than papered over: inside that window both claimants are
// answered 200 with an admin session cookie, and the row holds one claimant's email and
// password hash. The loser's cookie names first-admin with role admin, so it is a VALID admin
// session on an account whose credentials are not theirs — worse than two founders, because the
// loser cannot sign in again and is already inside. And first-admin is the ONE User row whose id
// is not derived from its email (this file overrides it), so it is the one row a stranger's
// session can survive on: via loadCaller it read as an admin, and canSee() lets an admin across
// owners, which is rule 19 — the worst bug this codebase can have.
// All THREE session readers now call lib/auth.js's sessionMatchesRow() — ONE verdict, not a copy
// in each — so the loser is refused on its next request by requireAdmin, by loadCaller and by
// AuthApi.me. It costs no extra read, because all three already re-read the row.
// A read-back HERE is deliberately absent rather than forgotten: the losing write lands LAST,
// so the loser re-reads its own row and still concludes it won. It would catch nobody.
// Making the claim exclusive needs a primitive Harper does not expose on the Table API (LMDB's
// atomic ifNoExists is used internally and not surfaced) or Table.lock(), which is real from 5.3
// and deliberately not adopted. That is the remaining half, and it is
// a decision for a human rather than an omission.
//
// The noUsersYet() pre-check remains for the 410 fast path and for a founder seeded under
// another id. auth-acceptance races two POSTs for the sequential guard AND drives the unrefused
// create directly, because no single-process double can reach the concurrent case by
// interleaving.

import { Resource } from 'harperdb'
import { db } from '../lib/db.js'
import { ROLE_ADMIN, normalizeEmail, newUser, hashPassword, createSessionToken, buildSessionCookie, sanitizeUser, isAlreadyExists, ownerSetting, hasActiveAdmin } from '../lib/auth.js'
import { json } from '../lib/http.js'
import { isPreviewCopy } from '../lib/copy.js'

const MIN_PASSWORD = 10
// Also what data/*.yaml seed rows point their ownerUserId at, so example rows can belong to
// the founder before the founder exists.
export const FIRST_ADMIN_ID = 'first-admin'

// One object, so the two routes answer identically and a client cannot tell them apart by shape.
const PREVIEW_REFUSAL = Object.freeze({
  error: 'The first administrator is set up on the live address, not on the preview.',
  code: 'bootstrap_not_on_preview',
})

// Mode 'owner' (the header). The same answer for every body, because it is decided before the body is
// read. PLACEHOLDER wording.
const OWNER_REFUSAL = Object.freeze({
  error: 'This app\'s owner becomes its administrator by signing in with their own email address. There is nothing to set up here.',
  code: 'owner_signs_in',
})

export class Bootstrap extends Resource {
  static loadAsInstance = false

  async get (target) {
    target.checkPermission = false
    if (isPreviewCopy()) return json(PREVIEW_REFUSAL, 403)
    // `mode` is a fact about this app's configuration and about no account; the sign-in page reads it to
    // say how the seat is taken. A value that is set and is not an address is still mode 'owner' — a
    // platform defect must not reopen the seat to the first visitor (lib/auth.js `ownerSetting`).
    if (ownerSetting().declared) return json({ needed: !(await hasActiveAdmin()), mode: 'owner' })
    return json({ needed: await noUsersYet(), mode: 'claim' })
  }

  async post (target, data) {
    target.checkPermission = false
    // REFUSED BY THE PREVIEW COPY, AND IT IS THE ONE ROUTE THAT NEEDS SAYING SO. The staging
    // database is not guaranteed to hold a `User` row, and the preview copy
    // answers at a PUBLIC path — so without this, a first-admin claim against
    // staging is open to anyone who types the address. `lib/auth.js`'s session stamp already stops
    // such a session being replayed on production, which is the harm; this stops the claim being
    // made at all, because there is no reason to seat a founder from a preview and an attacker
    // holding stage-admin can still read and rewrite every dummy row a user is looking at.
    //
    // It is deliberately NOT a general rule about the preview copy's resources. Serving the app is
    // what the preview is for; what makes this route different is that it is a once-ever
    // privileged claim with a FIXED id, so it is the one place where "anybody may do this while no
    // row exists" is the designed behaviour.
    if (isPreviewCopy()) return json(PREVIEW_REFUSAL, 403)
    // MODE 'owner' REFUSES, FIRST (the header): the seat is the owner's, and they take it by proving their
    // address at sign-in. Above the body on purpose, so the answer cannot depend on what was typed.
    if (ownerSetting().declared) return json(OWNER_REFUSAL, 403)
    const body = data && typeof data === 'object' ? data : {}
    const email = normalizeEmail(body.email)
    const name = String(body.name ?? '').trim()
    const password = String(body.password ?? '')
    if (!name || !email || !password) return json({ error: 'name, email and password are required' }, 400)
    if (password.length < MIN_PASSWORD) return json({ error: `password must be at least ${MIN_PASSWORD} characters` }, 400)
    // Checked AFTER validation so a malformed first attempt does not read as "already done",
    // and re-checked right before the write to narrow the window between two first visits.
    if (!(await noUsersYet())) return json({ error: 'Bootstrap already complete. Sign in instead.', code: 'bootstrap_done' }, 410)

    const user = newUser({ email, name, role: ROLE_ADMIN, passwordHash: hashPassword(password) })
    user.id = FIRST_ADMIN_ID
    user.lastLoginAt = user.createdAt
    try {
      await db.User.create(user)
    } catch (err) {
      if (!isAlreadyExists(err)) throw err
      return json({ error: 'Bootstrap already complete. Sign in instead.', code: 'bootstrap_done' }, 410)
    }
    return json({ ok: true, user: sanitizeUser(user) }, 200, { cookies: [buildSessionCookie(createSessionToken(user))] })
  }
}

async function noUsersYet () {
  for await (const _ of db.User.search({ limit: 1 })) return false
  return true
}
