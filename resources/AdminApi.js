// SIGN-IN KIT (the baseline a generated app adapts) — the admin area's one resource. Every method
// opens with `await requireAdmin(this)`, which re-reads the User row, so a demoted admin's
// unexpired cookie is refused on the next request. Sub-paths come from target.pathname and
// the query from queryParams(target, this) with the getContext() fallback, because
// target.searchParams is empty on a sub-path route (rule 4).
//
//   GET  /AdminApi/scheduler                        the scheduler's own status (resources/Scheduler.js schedulerStatus)
//   GET  /AdminApi/users?q=&role=                   users, sanitized plus deactivatedAt / lastLoginAt / sign-in methods
//   GET  /AdminApi/users/:id                        one user
//   PUT  /AdminApi/users/:id/role                   { role: 'admin' | 'member' }
//   PUT  /AdminApi/users/:id/deactivated            { deactivated: boolean }
//   POST /AdminApi/users/invite                     { email, name?, role? } → { ok, user, existing } and an invite email
//
// The last-admin guard: a change that would leave the app with no active admin — demoting
// or deactivating the only one, yourself included — is refused with 409 `last_admin`. The
// count is re-read from the table on every such write, never taken from the session, and
// re-read AGAIN after the write: "count, then write" is check-then-act, and two admins
// demoting each other at once both pass the first count. There is no single key to claim for
// a count, so the request that finds the seat empty after its write puts its row back and
// answers 409 (settleAdminSeat). At rest there is always an admin.
// scripts/admin-acceptance.js drives every method anonymous, as a member and as an admin.

import { Resource } from 'harperdb'
import { db } from '../lib/db.js'
import { requireAdmin, findUserById, findUserByEmail, claimUserForEmail, sanitizeUser, normalizeEmail, issueMagicLink, ROLE_ADMIN, ROLE_MEMBER, MAGIC_LINK_TTL_SECONDS } from '../lib/auth.js'
import { json, segmentsOf, queryParams } from '../lib/http.js'
import { publicBaseFor, runAuthed, schedulerStatus } from '../lib/sign-in-support.js'
import { sendEmail, emailShell, escapeHtml } from '../lib/email.js'
import { config } from '../lib/sign-in-config.js'

const ROLES = Object.freeze([ROLE_ADMIN, ROLE_MEMBER])
// Scan ceilings, not safety rails: a list that hits one says so (`truncated`), because a
// short scan and a complete one are the same observation at the call site.
const USER_SCAN_LIMIT = 1000
const COUNT_CAP = 10000

export class AdminApi extends Resource {
  static loadAsInstance = false

  async get (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      const [section, id, sub] = segmentsOf(target)
      const params = queryParams(target, this)
      if (section === 'scheduler' && !id) return json(await schedulerStatus())
      if (section === 'users' && !id) return this.listUsers(params)
      if (section === 'users' && id && !sub) return this.getUser(id)
      return json({ error: 'not found' }, 404)
    })
  }

  async post (target, data) {
    target.checkPermission = false
    return runAuthed(async () => {
      const admin = await requireAdmin(this)
      const [section, id, sub] = segmentsOf(target)
      const body = data && typeof data === 'object' ? data : {}
      if (section === 'users' && id === 'invite' && !sub) return this.invite(admin, body)
      return json({ error: 'not found' }, 404)
    })
  }

  async put (target, data) {
    target.checkPermission = false
    return runAuthed(async () => {
      const admin = await requireAdmin(this)
      const [section, id, sub] = segmentsOf(target)
      const body = data && typeof data === 'object' ? data : {}
      if (section === 'users' && id && sub === 'role') return this.setRole(admin, id, body)
      if (section === 'users' && id && sub === 'deactivated') return this.setDeactivated(admin, id, body)
      return json({ error: 'not found' }, 404)
    })
  }

  async delete (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      // Nothing is hard-deleted from here: users are deactivated.
      void segmentsOf(target)
      return json({ error: 'not found' }, 404)
    })
  }

  // ── users ────────────────────────────────────────────────────────────────────

  async listUsers (params) {
    const q = String(params.get('q') ?? '').trim().toLowerCase()
    const role = String(params.get('role') ?? '').trim()
    const rows = []
    for await (const u of db.User.search({ limit: USER_SCAN_LIMIT })) rows.push(u)
    const users = rows
      .filter((u) => !role || u.role === role)
      .filter((u) => !q || String(u.email ?? '').includes(q) || String(u.name ?? '').toLowerCase().includes(q))
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
      .map(adminView)
    return json({ users, truncated: rows.length >= USER_SCAN_LIMIT })
  }

  async getUser (id) {
    const row = await findUserById(id)
    if (!row) return json({ error: 'not found' }, 404)
    return json({ user: adminView(row) })
  }

  async setRole (admin, id, body) {
    const role = String(body.role ?? '').trim()
    if (!ROLES.includes(role)) return json({ error: `role must be one of ${ROLES.join(', ')}` }, 400)
    const row = await findUserById(id)
    if (!row) return json({ error: 'not found' }, 404)
    if (row.role === role) return json({ ok: true, user: adminView(row), changed: false })
    const removesAdmin = isActiveAdmin(row) && role !== ROLE_ADMIN
    if (removesAdmin && await activeAdminCount() <= 1) return lastAdmin()
    const updated = { ...row, role, updatedAt: new Date().toISOString() }
    await db.User.put(updated)
    if (removesAdmin && !(await settleAdminSeat(row))) return lastAdmin()
    console.log(`[admin] ${admin.userId} set role of ${row.id} to ${role}`)
    return json({ ok: true, user: adminView(updated), changed: true })
  }

  async setDeactivated (admin, id, body) {
    if (typeof body.deactivated !== 'boolean') return json({ error: 'deactivated must be true or false' }, 400)
    const row = await findUserById(id)
    if (!row) return json({ error: 'not found' }, 404)
    const already = Boolean(row.deactivatedAt) === body.deactivated
    if (already) return json({ ok: true, user: adminView(row), changed: false })
    const removesAdmin = body.deactivated && isActiveAdmin(row)
    if (removesAdmin && await activeAdminCount() <= 1) return lastAdmin()
    const updated = { ...row, deactivatedAt: body.deactivated ? new Date().toISOString() : null, updatedAt: new Date().toISOString() }
    await db.User.put(updated)
    if (removesAdmin && !(await settleAdminSeat(row))) return lastAdmin()
    console.log(`[admin] ${admin.userId} ${body.deactivated ? 'deactivated' : 'reactivated'} ${row.id}`)
    return json({ ok: true, user: adminView(updated), changed: true })
  }

  /**
   * Create (or find) the account and email a single-use link to /invite. The link lands on
   * a page with a button rather than on AuthApi/verify directly, so a mail client that
   * prefetches links cannot redeem it before the person does. An existing user is invited as
   * they are — their role is not changed by an invite — and a deactivated one is not revived.
   */
  async invite (admin, body) {
    const email = normalizeEmail(body.email)
    if (!email) return json({ error: 'a valid email is required' }, 400)
    const role = body.role == null || body.role === '' ? ROLE_MEMBER : String(body.role).trim()
    if (!ROLES.includes(role)) return json({ error: `role must be one of ${ROLES.join(', ')}` }, 400)
    const name = String(body.name ?? '').trim() || null
    let user = await findUserByEmail(email)
    let existing = Boolean(user)
    if (user?.deactivatedAt) return json({ error: 'That account is deactivated; reactivate it first', code: 'deactivated' }, 409)
    if (!user) {
      // A claim on the address, not a put (lib/auth.js claimUserForEmail): two invites for one
      // address racing here end with one row, and the loser continues with the winner's. The
      // accounts quota lives inside the claim — pre-check, create, post-write re-count — so
      // this path and AuthApi's self-serve sign-ups enforce it from one place.
      const claim = await claimUserForEmail({ email, name, role })
      if (claim.refused) return claim.refused
      user = claim.user
      existing = !claim.created
    }
    const { token, rateLimited } = await issueMagicLink(user, { purpose: 'invite' })
    if (rateLimited) return json({ error: 'Too many invites to that address recently; try again later', code: 'rate_limited' }, 429)
    const appName = config.appName()
    // PREVIEW-AWARE: the invite's row is in whichever database this copy reads, so the link has to
    // come back to the same copy (lib/copy.js).
    const url = `${publicBaseFor(config.publicAppUrl())}/invite?token=${encodeURIComponent(token)}`
    const inviter = admin.row?.name || admin.email
    const sent = await sendEmail({
      to: email,
      subject: `You're invited to ${appName}`,
      template: 'invite',
      text: `${inviter} invited you to ${appName}.\n\nAccept the invitation:\n${url}\n\nThe link works once and expires in ${MAGIC_LINK_TTL_SECONDS / 60} minutes. If you weren't expecting this, ignore it.`,
      html: emailShell({
        title: `You're invited to ${appName}`,
        preheader: `${inviter} invited you.`,
        body: `<p>${escapeHtml(inviter)} invited you to <strong>${escapeHtml(appName)}</strong>.</p>
<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#1c1917;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Accept invitation</a></p>
<p style="font-size:13px;color:#78716c;">Or paste this link into your browser:<br><span style="word-break:break-all;">${escapeHtml(url)}</span></p>
<p style="font-size:12px;color:#a8a29e;">The link works once and expires in ${MAGIC_LINK_TTL_SECONDS / 60} minutes. If you weren't expecting this, you can ignore it.</p>`,
      }),
    })
    if (sent.suppressed) return json({ error: 'That address is on the suppression list (a bounce or a complaint); the invite was not sent', code: 'email_suppressed', user: adminView(user), existing }, 409)
    if (!sent.ok) return json({ error: `The invite could not be sent: ${sent.error ?? 'unknown error'}`, code: 'send_failed', user: adminView(user), existing }, 502)
    console.log(`[admin] ${admin.userId} invited ${user.id} as ${user.role}`)
    return json({ ok: true, user: adminView(user), existing, skipped: sent.skipped === true })
  }
}

/** What an admin sees of a user: sanitizeUser plus the account state, never the hash or the counters. */
function adminView (u) {
  return {
    ...sanitizeUser(u),
    deactivatedAt: u.deactivatedAt ?? null,
    lastLoginAt: u.lastLoginAt ?? null,
    signIn: { google: Boolean(u.googleSub), password: Boolean(u.passwordHash) },
  }
}

function isActiveAdmin (row) {
  return row.role === ROLE_ADMIN && !row.deactivatedAt
}

async function activeAdminCount () {
  let n = 0
  for await (const u of db.User.search({ conditions: [{ attribute: 'role', value: ROLE_ADMIN }], limit: COUNT_CAP })) if (!u.deactivatedAt) n++
  return n
}

/**
 * After a write that removed an admin: is the seat still held? If nobody is left, give the
 * seat back and report false. Reverting only ever ADDS an admin, so any interleaving of
 * concurrent removals ends with at least one; two requests that both see zero both revert,
 * and both answer 409, which is the safe side.
 *
 * The revert is a patch() of role and deactivatedAt — a partial write the store merges —
 * never a put() of the snapshot taken before the write. A whole-row put would overwrite a
 * profile edit or another admin's change that landed in between with stale fields (the lost
 * update this file avoids everywhere else), and even "read the current row, then put" leaves
 * the same window between its read and its write. admin-acceptance renames the row right
 * underneath the revert and requires the new name to survive.
 */
async function settleAdminSeat (previousRow) {
  if (await activeAdminCount() >= 1) return true
  await db.User.patch(previousRow.id, { role: previousRow.role, deactivatedAt: previousRow.deactivatedAt, updatedAt: new Date().toISOString() })
  console.warn(`[admin] refused a change that left no admin; restored the seat of ${previousRow.id}`)
  return false
}

function lastAdmin () {
  return json({ error: 'That would leave the app with no admin. Make someone else an admin first.', code: 'last_admin' }, 409)
}
