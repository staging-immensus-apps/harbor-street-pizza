#!/usr/bin/env node
// GENERATED — resources/AdminApi.js as shipped, through the stub runtime:
// every method on every path refuses anonymous callers (403 auth_required) and members (403
// admin_required), never a 401; requireAdmin re-reads the row; the users list, role change,
// deactivation and invites work for an admin; the last active admin cannot be demoted or
// deactivated, themselves included. The refusal sweep is self-tested first against a
// synthesized resource that forgets requireAdmin.
//
// Hermetic: clock frozen, no network (email has no key and logs), no git.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { freezeClock } from './probe/frozen-clock.js'
freezeClock()
process.env.SESSION_SECRET = 'suite-secret-not-a-real-one'
process.env.PUBLIC_APP_URL = 'https://app.example.test'
process.env.APP_NAME = 'Suite App'
process.env.IMMENSUS_TIER = 'builder'
delete process.env.RESEND_API_KEY

const { checker } = await import('./probe/harness.js')
const { tables, resetTables, Resource } = await import('./probe/harperdb-stub.js')
const { call, userWithCookie, captureLog, transcript, responseRulesVerdict } = await import('./probe/resource-call.js')
const { AdminApi } = await import('../resources/AdminApi.js')
const { AccountApi } = await import('../resources/AccountApi.js')
const { json } = await import('../lib/http.js')
const { hashToken } = await import('../lib/auth.js')

const { check, section, done, failures } = checker('admin-acceptance')

// Every route the resource documents, so a new one is refused from its first PR.
const ROUTES = [
  ['GET', ''], ['GET', 'scheduler'], ['GET', 'users'], ['GET', 'users/some-id'],
  ['POST', 'users/invite', { email: 'x@example.test' }],
  ['PUT', 'users/some-id/role', { role: 'admin' }], ['PUT', 'users/some-id/deactivated', { deactivated: true }],
  ['DELETE', 'users/some-id'],
]

/** Every (method, path) must answer 403 with the expected code and no WWW-Authenticate. */
async function refusalVerdict (Cls, cookie, code) {
  const bad = []
  for (const [m, p, body] of ROUTES) {
    let r
    try { r = await call(Cls, m, p, { cookie, body }) } catch (err) { bad.push(`${m} ${p} threw ${err.message}`); continue }
    if (r.status !== 403) bad.push(`${m} /${Cls.name}/${p} answered ${r.status}, not 403`)
    else if (r.json?.code !== code) bad.push(`${m} /${Cls.name}/${p} → 403 with code ${r.json?.code}, not ${code}`)
    if (r.headers.get('www-authenticate')) bad.push(`${m} ${p} carried WWW-Authenticate`)
  }
  return bad
}

section('negative control: the refusal sweep catches a resource that forgets requireAdmin')
{
  class LeakyAdminApi extends Resource {
    async get () { return json({ ok: true }) }
    async post () { return json({ ok: true }) }
    async put () { return json({ ok: true }) }
    async delete () { return json({ ok: true }) }
  }
  const bad = await refusalVerdict(LeakyAdminApi, null, 'auth_required')
  check('an unguarded resource fails every route of the sweep', bad.length === ROUTES.length, `${bad.length} of ${ROUTES.length}`)
  transcript.length = 0
}
if (failures.length) process.exit(done())

resetTables()
const ADMIN = await userWithCookie('admin@example.test', { role: 'admin', name: 'Founder' })
const MEMBER = await userWithCookie('member@example.test', { name: 'Mem Ber' })
const OTHER = await userWithCookie('other@example.test')

section('every method refuses anonymous and member callers')
{
  const anon = await refusalVerdict(AdminApi, null, 'auth_required')
  check(`anonymous → 403 auth_required on all ${ROUTES.length} routes`, anon.length === 0, anon.join(' | '))
  const mem = await refusalVerdict(AdminApi, MEMBER.cookie, 'admin_required')
  check(`a member → 403 admin_required on all ${ROUTES.length} routes`, mem.length === 0, mem.join(' | '))
  check('no row changed under any of that', tables.User.rows.size === 3)
}

section('requireAdmin re-reads the row')
{
  const demoted = await userWithCookie('was-admin@example.test', { role: 'admin' })
  await tables.User.put({ ...demoted.user, role: 'member' })
  const r = await call(AdminApi, 'GET', 'users', { cookie: demoted.cookie })
  check('an admin-shaped cookie for a row that is now a member → 403 admin_required', r.status === 403 && r.json?.code === 'admin_required')
  await tables.User.delete(demoted.user.id)
}

section('the users list')
{
  const root = await call(AdminApi, 'GET', '', { cookie: ADMIN.cookie })
  check('there is no status page here: GET /AdminApi/ → 404 for an admin', root.status === 404)
  const list = await call(AdminApi, 'GET', 'users', { cookie: ADMIN.cookie })
  check('GET /AdminApi/users lists every user, sanitized', list.status === 200 && list.json?.users?.length === 3 && !JSON.stringify(list.json).includes('passwordHash') && !JSON.stringify(list.json).includes('Timestamps'))
  check('…with the admin view fields', list.json.users.every((u) => 'deactivatedAt' in u && 'lastLoginAt' in u && typeof u.signIn?.google === 'boolean'))
  const q = await call(AdminApi, 'GET', 'users', { cookie: ADMIN.cookie, query: 'q=mem+ber' })
  check('?q= filters by email or name and was read from the request URL on a sub-path (rule 4)', q.status === 200 && q.json?.users?.length === 1 && q.json.users[0].id === MEMBER.user.id, JSON.stringify(q.json?.users?.map((u) => u.email)))
  const role = await call(AdminApi, 'GET', 'users', { cookie: ADMIN.cookie, query: 'role=admin' })
  check('?role= filters too', role.json?.users?.length === 1 && role.json.users[0].id === ADMIN.user.id)
  const one = await call(AdminApi, 'GET', `users/${MEMBER.user.id}`, { cookie: ADMIN.cookie })
  check('GET /AdminApi/users/:id → the one user', one.status === 200 && one.json?.user?.id === MEMBER.user.id)
  const nf = await call(AdminApi, 'GET', 'users/nope', { cookie: ADMIN.cookie })
  check('an unknown id → 404', nf.status === 404)
}

section('role change and the last-admin guard')
{
  const bad = await call(AdminApi, 'PUT', `users/${MEMBER.user.id}/role`, { cookie: ADMIN.cookie, body: { role: 'owner' } })
  check('an unknown role → 400 and no change (NEG)', bad.status === 400 && tables.User.rows.get(MEMBER.user.id).role === 'member')
  const self = await call(AdminApi, 'PUT', `users/${ADMIN.user.id}/role`, { cookie: ADMIN.cookie, body: { role: 'member' } })
  check('the only admin demoting themselves → 409 last_admin and the row is untouched (NEG)', self.status === 409 && self.json?.code === 'last_admin' && tables.User.rows.get(ADMIN.user.id).role === 'admin')
  const deact = await call(AdminApi, 'PUT', `users/${ADMIN.user.id}/deactivated`, { cookie: ADMIN.cookie, body: { deactivated: true } })
  check('the only admin deactivating themselves → 409 last_admin (NEG)', deact.status === 409 && deact.json?.code === 'last_admin' && !tables.User.rows.get(ADMIN.user.id).deactivatedAt)
  const promote = await call(AdminApi, 'PUT', `users/${MEMBER.user.id}/role`, { cookie: ADMIN.cookie, body: { role: 'admin' } })
  check('promoting a member → 200 changed', promote.status === 200 && promote.json?.changed === true && tables.User.rows.get(MEMBER.user.id).role === 'admin')
  const same = await call(AdminApi, 'PUT', `users/${MEMBER.user.id}/role`, { cookie: ADMIN.cookie, body: { role: 'admin' } })
  check('setting the same role again → 200 changed: false', same.status === 200 && same.json?.changed === false)
  const selfNow = await call(AdminApi, 'PUT', `users/${ADMIN.user.id}/role`, { cookie: ADMIN.cookie, body: { role: 'member' } })
  check('with a second admin, self-demotion → 200', selfNow.status === 200 && tables.User.rows.get(ADMIN.user.id).role === 'member')
  const locked = await call(AdminApi, 'GET', 'users', { cookie: ADMIN.cookie })
  check('…and the demoted admin is refused on their very next request', locked.status === 403 && locked.json?.code === 'admin_required')
  const lastNow = await call(AdminApi, 'PUT', `users/${MEMBER.user.id}/role`, { cookie: MEMBER.cookie, body: { role: 'member' } })
  check('the new only admin cannot demote themselves either → 409 (NEG)', lastNow.status === 409 && lastNow.json?.code === 'last_admin')
  const restore = await call(AdminApi, 'PUT', `users/${ADMIN.user.id}/role`, { cookie: MEMBER.cookie, body: { role: 'admin' } })
  check('the new admin restores the founder → 200', restore.status === 200 && tables.User.rows.get(ADMIN.user.id).role === 'admin')
  const demoteBack = await call(AdminApi, 'PUT', `users/${MEMBER.user.id}/role`, { cookie: ADMIN.cookie, body: { role: 'member' } })
  check('with two admins, demoting one → 200', demoteBack.status === 200 && tables.User.rows.get(MEMBER.user.id).role === 'member')
}

section('two admins removing each other at once (the guard holds under concurrency)')
{
  const X = await userWithCookie('x-admin@example.test', { role: 'admin' })
  const Y = await userWithCookie('y-admin@example.test', { role: 'admin' })
  await tables.User.put({ ...tables.User.rows.get(ADMIN.user.id), role: 'member' })
  await tables.User.put({ ...tables.User.rows.get(MEMBER.user.id), role: 'member' })
  const activeAdmins = () => [...tables.User.rows.values()].filter((u) => u.role === 'admin' && !u.deactivatedAt)
  check('exactly two active admins to start', activeAdmins().length === 2)
  // Negative control: the check-then-act shape under the same harness empties the seat.
  const naive = async (targetId) => {
    let n = 0
    for await (const u of tables.User.search({ conditions: [{ attribute: 'role', value: 'admin' }] })) if (!u.deactivatedAt) n++
    if (n <= 1) return 409
    await tables.User.put({ ...tables.User.rows.get(targetId), role: 'member' })
    return 200
  }
  const naiveOut = await Promise.all([naive(Y.user.id), naive(X.user.id)])
  check('count-then-write under the same harness leaves NO admin (the race is real) (NEG)', naiveOut.every((st) => st === 200) && activeAdmins().length === 0)
  await tables.User.put({ ...tables.User.rows.get(X.user.id), role: 'admin' })
  await tables.User.put({ ...tables.User.rows.get(Y.user.id), role: 'admin' })
  const raced = await Promise.all([
    call(AdminApi, 'PUT', `users/${Y.user.id}/role`, { cookie: X.cookie, body: { role: 'member' } }),
    call(AdminApi, 'PUT', `users/${X.user.id}/role`, { cookie: Y.cookie, body: { role: 'member' } }),
  ])
  check('two concurrent demotions of each other → at least one 409 last_admin', raced.some((r) => r.status === 409 && r.json?.code === 'last_admin'), raced.map((r) => r.status).join(','))
  check('…and at rest at least one active admin remains', activeAdmins().length >= 1, JSON.stringify(activeAdmins().map((u) => u.email)))
  await tables.User.put({ ...tables.User.rows.get(X.user.id), role: 'admin', deactivatedAt: null })
  await tables.User.put({ ...tables.User.rows.get(Y.user.id), role: 'admin', deactivatedAt: null })
  const racedOff = await Promise.all([
    call(AdminApi, 'PUT', `users/${Y.user.id}/deactivated`, { cookie: X.cookie, body: { deactivated: true } }),
    call(AdminApi, 'PUT', `users/${X.user.id}/deactivated`, { cookie: Y.cookie, body: { deactivated: true } }),
  ])
  check('two concurrent deactivations of each other → at least one 409 and an admin remains', racedOff.some((r) => r.status === 409) && activeAdmins().length >= 1, racedOff.map((r) => r.status).join(','))
  // The revert must not be a lost update: rename the row underneath the revert and require
  // the rename to survive it. The hook fires on exactly the revert's write — a patch of role
  // (the shipped shape) or a put restoring admin to a row that is a member right now (the
  // whole-row shape this guards against) — and lands a profile change first.
  await tables.User.put({ ...tables.User.rows.get(X.user.id), role: 'admin', deactivatedAt: null, name: 'X before' })
  await tables.User.put({ ...tables.User.rows.get(Y.user.id), role: 'admin', deactivatedAt: null, name: 'Y before' })
  const origPut = tables.User.put.bind(tables.User)
  const origPatch = tables.User.patch.bind(tables.User)
  let renamed = 0
  const renameUnder = async (id) => { renamed++; await origPut({ ...tables.User.rows.get(id), name: 'renamed meanwhile' }) }
  const isRevert = (id, role) => [X.user.id, Y.user.id].includes(id) && role === 'admin' && tables.User.rows.get(id)?.role === 'member'
  tables.User.put = async (row) => { if (isRevert(row.id, row.role)) await renameUnder(row.id); return origPut(row) }
  tables.User.patch = async (id, data) => { if (isRevert(id, data?.role)) await renameUnder(id); return origPatch(id, data) }
  const underRevert = await Promise.all([
    call(AdminApi, 'PUT', `users/${Y.user.id}/role`, { cookie: X.cookie, body: { role: 'member' } }),
    call(AdminApi, 'PUT', `users/${X.user.id}/role`, { cookie: Y.cookie, body: { role: 'member' } }),
  ])
  tables.User.put = origPut
  tables.User.patch = origPatch
  const survivors = [X.user.id, Y.user.id].map((id) => tables.User.rows.get(id))
  check('a revert happened and the profile change made underneath it survived (only role/deactivatedAt are restored)', renamed >= 1 && survivors.filter((u) => u.name === 'renamed meanwhile').length === renamed && survivors.filter((u) => u.name === 'renamed meanwhile').every((u) => u.role === 'admin'), `renamed ${renamed}, rows ${JSON.stringify(survivors.map((u) => [u.name, u.role]))}, statuses ${underRevert.map((r) => r.status).join(',')}`)
  await tables.User.put({ ...tables.User.rows.get(X.user.id), role: 'admin', deactivatedAt: null })
  await tables.User.put({ ...tables.User.rows.get(Y.user.id), role: 'admin', deactivatedAt: null })
  const mixed = await Promise.all([
    call(AdminApi, 'PUT', `users/${Y.user.id}/role`, { cookie: X.cookie, body: { role: 'member' } }),
    call(AdminApi, 'PUT', `users/${X.user.id}/deactivated`, { cookie: Y.cookie, body: { deactivated: true } }),
  ])
  check('a demotion racing a deactivation → an admin remains', mixed.some((r) => r.status === 409) && activeAdmins().length >= 1, mixed.map((r) => r.status).join(','))
  for (const u of [X, Y]) await tables.User.delete(u.user.id)
  await tables.User.put({ ...tables.User.rows.get(ADMIN.user.id), role: 'admin', deactivatedAt: null })
}

section('deactivation')
{
  const off = await call(AdminApi, 'PUT', `users/${OTHER.user.id}/deactivated`, { cookie: ADMIN.cookie, body: { deactivated: true } })
  check('deactivating a member → 200 with deactivatedAt set', off.status === 200 && typeof off.json?.user?.deactivatedAt === 'string')
  const asOff = await call(AccountApi, 'GET', '', { cookie: OTHER.cookie })
  check('…and their unexpired cookie is refused everywhere on the next request', asOff.status === 403 && asOff.json?.code === 'auth_required')
  const badBody = await call(AdminApi, 'PUT', `users/${OTHER.user.id}/deactivated`, { cookie: ADMIN.cookie, body: { deactivated: 'yes' } })
  check('a non-boolean → 400 (NEG)', badBody.status === 400)
  const on = await call(AdminApi, 'PUT', `users/${OTHER.user.id}/deactivated`, { cookie: ADMIN.cookie, body: { deactivated: false } })
  check('reactivating → 200 with deactivatedAt null', on.status === 200 && on.json?.user?.deactivatedAt === null)
  const asOn = await call(AccountApi, 'GET', '', { cookie: OTHER.cookie })
  check('…and the same cookie works again', asOn.status === 200)
}

section('invites')
{
  const usersBefore = tables.User.rows.size
  let log = await captureLog(() => call(AdminApi, 'POST', 'users/invite', { cookie: ADMIN.cookie, body: { email: 'New@Example.test', name: 'Newcomer' } }))
  const r = transcript.at(-1)
  check('inviting a new address → 200 ok, existing: false, the row created as a member', r.status === 200 && r.json?.ok === true && r.json.existing === false && r.json.user?.email === 'new@example.test' && r.json.user.role === 'member' && tables.User.rows.size === usersBefore + 1)
  const token = (log.match(/\/invite\?token=([A-Za-z0-9_%-]+)/) ?? [])[1]
  check('the email links to /invite?token=… (a page with a button, not the verify route)', Boolean(token) && !/AuthApi\/verify/.test(log))
  const link = [...tables.MagicLink.rows.values()].find((l) => l.userId === r.json.user.id)
  check('the MagicLink row is keyed by the token hash with purpose invite (rule 10)', link && link.id === hashToken(decodeURIComponent(token)) && link.purpose === 'invite')
  check('the send is logged as skipped (no RESEND_API_KEY) under template invite', [...tables.EmailLog.rows.values()].some((l) => l.template === 'invite' && l.status === 'skipped' && l.to === 'new@example.test'))
  const asAdmin = await call(AdminApi, 'POST', 'users/invite', { cookie: ADMIN.cookie, body: { email: 'admin2@example.test', role: 'admin' } })
  check('an invite may create an admin', asAdmin.status === 200 && asAdmin.json?.user?.role === 'admin')
  const existing = await call(AdminApi, 'POST', 'users/invite', { cookie: ADMIN.cookie, body: { email: MEMBER.user.email, role: 'admin' } })
  check('inviting an existing member with role admin → existing: true and the role is NOT changed', existing.status === 200 && existing.json?.existing === true && tables.User.rows.get(MEMBER.user.id).role === 'member')
  await tables.User.put({ ...tables.User.rows.get(OTHER.user.id), deactivatedAt: '2026-06-01T00:00:00.000Z' })
  const gone = await call(AdminApi, 'POST', 'users/invite', { cookie: ADMIN.cookie, body: { email: OTHER.user.email } })
  check('inviting a deactivated account → 409 deactivated (NEG)', gone.status === 409 && gone.json?.code === 'deactivated')
  await tables.User.put({ ...tables.User.rows.get(OTHER.user.id), deactivatedAt: null })
  const badEmail = await call(AdminApi, 'POST', 'users/invite', { cookie: ADMIN.cookie, body: { email: 'nope' } })
  check('an invalid email → 400 (NEG)', badEmail.status === 400)
  const badRole = await call(AdminApi, 'POST', 'users/invite', { cookie: ADMIN.cookie, body: { email: 'r@example.test', role: 'owner' } })
  check('an unknown role → 400 and no row (NEG)', badRole.status === 400 && ![...tables.User.rows.values()].some((u) => u.email === 'r@example.test'))
  for (let i = 0; i < 2; i++) await captureLog(() => call(AdminApi, 'POST', 'users/invite', { cookie: ADMIN.cookie, body: { email: 'new@example.test' } }))
  const fourth = await call(AdminApi, 'POST', 'users/invite', { cookie: ADMIN.cookie, body: { email: 'new@example.test' } })
  check('the fourth invite to one address in the window → 429 rate_limited (the per-user link limit)', fourth.status === 429 && fourth.json?.code === 'rate_limited')
  const dupBefore = tables.User.rows.size
  await captureLog(() => Promise.all([
    call(AdminApi, 'POST', 'users/invite', { cookie: ADMIN.cookie, body: { email: 'dup@example.test' } }),
    call(AdminApi, 'POST', 'users/invite', { cookie: ADMIN.cookie, body: { email: 'Dup@Example.test', name: 'Second' } }),
  ]))
  const dupRows = [...tables.User.rows.values()].filter((u) => u.email === 'dup@example.test')
  const dupRes = transcript.slice(-2)
  check('two concurrent invites for one address → exactly one account, both answered 200', dupRows.length === 1 && tables.User.rows.size === dupBefore + 1 && dupRes.every((r) => r.status === 200), `rows ${dupRows.length}, statuses ${dupRes.map((r) => r.status).join(',')}`)
  check('…one reports existing: false and the other existing: true', dupRes.filter((r) => r.json?.existing === false).length === 1 && dupRes.filter((r) => r.json?.existing === true).length === 1)
  await tables.EmailSuppression.put({ id: 'bounced@example.test', email: 'bounced@example.test', reason: 'hard_bounce' })
  const suppressed = await call(AdminApi, 'POST', 'users/invite', { cookie: ADMIN.cookie, body: { email: 'bounced@example.test' } })
  check('a suppressed address → 409 email_suppressed and no email sent', suppressed.status === 409 && suppressed.json?.code === 'email_suppressed' && [...tables.EmailLog.rows.values()].some((l) => l.to === 'bounced@example.test' && l.status === 'suppressed'))
  void log
}

section('nothing is hard-deleted')
{
  const del = await call(AdminApi, 'DELETE', `users/${MEMBER.user.id}`, { cookie: ADMIN.cookie })
  check('DELETE is not a thing here → 404 and the user remains', del.status === 404 && tables.User.rows.has(MEMBER.user.id))
}

section(`the rule-20 sweep over every response (${transcript.length})`)
{
  const bad = responseRulesVerdict(transcript)
  check('no 401, no WWW-Authenticate on a 403, everything no-store', bad.length === 0, bad.slice(0, 3).join(' | '))
}
process.exit(done())
