// SIGN-IN KIT (the baseline a generated app adapts) — the member's own account.
//
//   GET    /AccountApi/          { user }
//   PUT    /AccountApi/profile   { name } → { ok, user }
//   PUT    /AccountApi/password  { currentPassword?, newPassword } → { ok }   (this app's addition)
//   DELETE /AccountApi/          delete my account, keeping my orders  (this app's addition)
//
// Everything here is the caller's own User row: no id is accepted from the request, so there
// is nothing to scope and nothing to leak. The profile write restates every field that is
// not `name` from the stored row, so the body cannot reach role, passwordHash or the counters.
//
// ── THIS APP'S ADDITIONS, and why they live in the kit's resource rather than beside it ───────────
//
// The shop's customers have accounts now (resources/AuthApi.js's header), so two things a customer
// expects of one had to exist: changing their own password, and deleting the account. Both are
// operations on the caller's own `User` row, which is exactly what this resource is, so they are
// here; a second resource for them would be a second place the rules about a `User` row live.
//
// DELETING AN ACCOUNT DOES NOT DELETE ORDERS. A placed order is the shop's record of a sale — its
// lines, its totals and its status are what the owner's books are made of — so the account's link
// to each order is cleared (`customerUserId` back to null, exactly the shape a guest order has) and
// the order itself stays. The personal details on it are already on their own twelve-month clock
// (CLAUDE.md §8), which is the promise the shop made about them and is not shortened or lengthened
// here. The confirmation the page shows says precisely this before anything is deleted.

import { Resource } from 'harperdb'
import { db } from '../lib/db.js'
import { loadCaller } from '../lib/session.js'
import { sanitizeUser, hashPassword, verifyPassword, buildLogoutCookie } from '../lib/auth.js'
import { withoutManaged } from '../lib/managed-fields.js'
import { json, segmentsOf } from '../lib/http.js'
import { runAuthed } from '../lib/sign-in-support.js'

const NAME_MAX = 120
const PASSWORD_MIN = 8
const PASSWORD_MAX = 200

// One sweep is bounded, and a customer with more orders than this deletes their account in two
// passes rather than in one unbounded search. Nothing in this app places anywhere near it.
const UNLINK_LIMIT = 1000

export class AccountApi extends Resource {
  static loadAsInstance = false

  async get (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      const caller = await loadCaller(this)
      const [sub] = segmentsOf(target)
      if (sub) return json({ error: 'not found' }, 404)
      return json({ user: sanitizeUser(caller.row) })
    })
  }

  async put (target, data) {
    target.checkPermission = false
    return runAuthed(async () => {
      const caller = await loadCaller(this)
      const [sub, more] = segmentsOf(target)
      const body = data && typeof data === 'object' ? data : {}
      if (sub === 'password' && !more) return this.setPassword(caller, body)
      if (sub !== 'profile' || more) return json({ error: 'not found' }, 404)
      // Blank is absent (rule 11): clearing the name stores null, and the UI falls back to the email.
      const name = String(body.name ?? '').trim()
      if (name.length > NAME_MAX) return json({ error: `name must be at most ${NAME_MAX} characters` }, 400)
      const row = { ...caller.row, name: name || null, updatedAt: new Date().toISOString() }
      await db.User.put(row)
      return json({ ok: true, user: sanitizeUser(row) })
    })
  }

  async delete (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      const caller = await loadCaller(this)
      const [sub] = segmentsOf(target)
      if (sub) return json({ error: 'not found' }, 404)

      // The orders are unlinked BEFORE the row goes, so a failure half way through leaves an
      // account whose orders are partly unlinked — recoverable by asking again — rather than
      // orders pointing at a user id that no longer exists.
      const mine = []
      for await (const row of db.Order.search({ conditions: [{ attribute: 'customerUserId', value: caller.userId }], limit: UNLINK_LIMIT })) mine.push(row)
      for (const order of mine) {
        // withoutManaged: this restates a stored row, and `Order.updatedAt` is Harper's — the
        // spread is the trap, not the literal (CLAUDE.md §8).
        await db.Order.put({ ...withoutManaged(order, 'Order'), customerUserId: null })
      }
      await db.User.delete(caller.userId)
      globalThis.logger?.warn(`[account] a customer deleted their account; ${mine.length} order(s) kept with no account attached`)
      return json({ ok: true, ordersKept: mine.length }, 200, { cookies: [buildLogoutCookie()] })
    })
  }

  /**
   * Set or replace the caller's own password.
   *
   * `currentPassword` is required when the row already has one, so a borrowed screen cannot lock
   * the owner of the account out of it; a customer who got in by magic link has no hash yet and
   * sets their first password with the session alone, which is the "set a new password" the page
   * offers after a forgotten-password link. Either way the row is restated field by field from the
   * stored one, so the body reaches nothing but the hash.
   */
  async setPassword (caller, body) {
    const next = String(body.newPassword ?? '')
    if (next.length < PASSWORD_MIN) return json({ error: `a password must be at least ${PASSWORD_MIN} characters`, code: 'password_too_short' }, 400)
    if (next.length > PASSWORD_MAX) return json({ error: 'that password is too long', code: 'password_too_long' }, 400)
    if (caller.row.passwordHash && !verifyPassword(String(body.currentPassword ?? ''), caller.row.passwordHash)) {
      return json({ error: 'that is not your current password', code: 'wrong_password' }, 403)
    }
    const row = { ...caller.row, passwordHash: hashPassword(next), passwordAttemptTimestamps: [], updatedAt: new Date().toISOString() }
    await db.User.put(row)
    return json({ ok: true, user: sanitizeUser(row) })
  }
}
