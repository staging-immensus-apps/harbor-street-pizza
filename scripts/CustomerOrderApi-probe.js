#!/usr/bin/env node
// GENERATED — rule 19 for Order.customerUserId, as a functional probe over
// resources/CustomerOrderApi.js (the back-end charter: one owner-scope suite per owner-scoped
// entity, and the app's OWN DESCRIPTION of this resource: "the app's ONE owner-scoped
// resource"). Two customers and an admin drive the resource as shipped through the stub
// runtime: A never sees B's orders, a guest order (customerUserId null OR the attribute absent
// entirely) is reachable by nobody here, ?owner= and a request body are both ignored, an admin
// calling this resource sees only their own orders, every non-GET is a 404, and anonymous, a
// deactivated row and a session whose row was reassigned all get 403 with no WWW-Authenticate.
// The leak verdict is self-tested against a leaky list FIRST.
//
// Hermetic: clock frozen, no network, no git.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { freezeClock } from './probe/frozen-clock.js'
freezeClock()
process.env.SESSION_SECRET = 'suite-secret-not-a-real-one'
process.env.IMMENSUS_TIER = 'builder'

const { checker } = await import('./probe/harness.js')
const { tables, resetTables } = await import('./probe/harperdb-stub.js')
const { call, userWithCookie, transcript, responseRulesVerdict } = await import('./probe/resource-call.js')
const { CustomerOrderApi, LIST_LIMIT } = await import('../resources/CustomerOrderApi.js')

const { check, section, done, failures } = checker('CustomerOrderApi-probe')

/** Which codes a caller saw vs. which they own and which belong to someone else (or nobody). */
function leakVerdict (visibleCodes, ownCodes, foreignCodes) {
  const bad = []
  for (const code of foreignCodes) if (visibleCodes.includes(code)) bad.push(`LEAK: ${code} does not belong to this caller and was returned`)
  for (const code of ownCodes) if (!visibleCodes.includes(code)) bad.push(`MISSING: own order ${code} was not returned`)
  return bad
}

section('negative control: the leak verdict can say no')
check('a clean list passes', leakVerdict(['a1', 'a2'], ['a1', 'a2'], ['b1']).length === 0)
check('a foreign order in the list is a LEAK', leakVerdict(['a1', 'a2', 'b1'], ['a1', 'a2'], ['b1']).some((b) => b.startsWith('LEAK')))
check('an own order missing from the list is caught', leakVerdict(['a1'], ['a1', 'a2'], ['b1']).some((b) => b.startsWith('MISSING')))
if (failures.length) process.exit(done())

resetTables()
const A = await userWithCookie('a@example.test')
const B = await userWithCookie('b@example.test')
const ADMIN = await userWithCookie('admin@example.test', { role: 'admin' })
const GONE = await userWithCookie('gone@example.test', { deactivatedAt: '2026-06-01T00:00:00.000Z' })

section('anonymous and deactivated callers')
for (const [m, p] of [['GET', ''], ['GET', 'x'], ['POST', ''], ['PUT', 'x'], ['PATCH', 'x'], ['DELETE', 'x']]) {
  const r = await call(CustomerOrderApi, m, p, {})
  check(`${m} /CustomerOrderApi/${p} anonymous → 403 auth_required, no WWW-Authenticate`, r.status === 403 && r.json?.code === 'auth_required' && !r.headers.get('www-authenticate'))
}
{
  const r = await call(CustomerOrderApi, 'GET', '', { cookie: GONE.cookie })
  check('a deactivated user with a live cookie → 403 (the row is re-read)', r.status === 403 && r.json?.code === 'auth_required')
}
check('none of that wrote an Order row — this resource writes nothing, ever', tables.Order.rows.size === 0)

section('the stub would surface a leak (the fixture can fail)')
{
  await tables.Order.put({ id: 'seed-b', code: 'seed-b-code', customerUserId: B.user.id, placedAt: '2026-01-01T00:00:00.000Z' })
  const all = []
  for await (const row of tables.Order.search({ conditions: [] })) all.push(row.code)
  check('an unconditioned search returns another customer\'s order — so a resource that forgot the condition would fail below (NEG)', all.includes('seed-b-code'))
  await tables.Order.delete('seed-b')
}

section('fixtures: A, B, a guest with customerUserId null, and a guest with the attribute absent')
const A1 = { id: 'o-a1', code: 'code-a1', customerUserId: A.user.id, placedAt: '2026-01-05T00:00:00.000Z', status: 'received', fulfilment: 'pickup', items: [{ menuItemId: 'm1', name: 'Slice', priceCents: 300, quantity: 2 }], itemsTotalCents: 600, deliveryFeeCents: 0, totalCents: 600, paymentStatus: 'paid', readyEstimate: '2026-01-05T00:20:00.000Z' }
const A2 = { id: 'o-a2', code: 'code-a2', customerUserId: A.user.id, placedAt: '2026-02-10T00:00:00.000Z', status: 'ready', fulfilment: 'delivery', items: [], itemsTotalCents: 1200, deliveryFeeCents: 300, totalCents: 1500, paymentStatus: 'paid', readyEstimate: '2026-02-10T00:40:00.000Z' }
const B1 = { id: 'o-b1', code: 'code-b1', customerUserId: B.user.id, placedAt: '2026-01-20T00:00:00.000Z', status: 'received' }
const GUEST_NULL = { id: 'o-guest-null', code: 'code-guest-null', customerUserId: null, placedAt: '2026-01-15T00:00:00.000Z', status: 'received' }
const GUEST_ABSENT = { id: 'o-guest-absent', code: 'code-guest-absent', placedAt: '2026-01-16T00:00:00.000Z', status: 'received' }
await tables.Order.put(A1)
await tables.Order.put(A2)
await tables.Order.put(B1)
await tables.Order.put(GUEST_NULL)
await tables.Order.put(GUEST_ABSENT)
check('five rows exist in the table', tables.Order.rows.size === 5)
check('the guest-absent row really has no customerUserId key at all', !('customerUserId' in GUEST_ABSENT) && !('customerUserId' in tables.Order.rows.get('o-guest-absent')))

section('list filters by the owner (rule 19, read side) and guest orders belong to nobody')
{
  const la = await call(CustomerOrderApi, 'GET', '', { cookie: A.cookie })
  const codesA = (la.json?.orders ?? []).map((o) => o.code)
  const v = leakVerdict(codesA, ['code-a1', 'code-a2'], ['code-b1', 'code-guest-null', 'code-guest-absent'])
  check('A lists exactly A\'s orders, nothing else', la.status === 200 && v.length === 0 && codesA.length === 2, v.join(' | '))
  check('newest first by placedAt', codesA[0] === 'code-a2' && codesA[1] === 'code-a1')
  check('the response names its limit and is not truncated', la.json?.limit === LIST_LIMIT && la.json?.truncated === false)
  check('each order carries its code, so the page can link to /order/<code>', (la.json?.orders ?? []).every((o) => typeof o.code === 'string' && o.code.length > 0))

  const lb = await call(CustomerOrderApi, 'GET', '', { cookie: B.cookie })
  const codesB = (lb.json?.orders ?? []).map((o) => o.code)
  const vb = leakVerdict(codesB, ['code-b1'], ['code-a1', 'code-a2', 'code-guest-null', 'code-guest-absent'])
  check('B lists exactly B\'s orders, nothing else', vb.length === 0 && codesB.length === 1, vb.join(' | '))

  const spoofQuery = await call(CustomerOrderApi, 'GET', '', { cookie: B.cookie, query: `owner=${A.user.id}` })
  const vq = leakVerdict((spoofQuery.json?.orders ?? []).map((o) => o.code), ['code-b1'], ['code-a1', 'code-a2'])
  check('?owner=<A> from B is ignored: still only B\'s orders (NEG)', vq.length === 0 && (spoofQuery.json?.orders ?? []).length === 1, vq.join(' | '))

  const spoofBody = await call(CustomerOrderApi, 'GET', '', { cookie: B.cookie, body: { customerUserId: A.user.id, owner: A.user.id } })
  const vbody = leakVerdict((spoofBody.json?.orders ?? []).map((o) => o.code), ['code-b1'], ['code-a1', 'code-a2'])
  check('a request body naming another owner is ignored (NEG — GET has no body channel at all)', vbody.length === 0 && (spoofBody.json?.orders ?? []).length === 1, vbody.join(' | '))
}

section('a guessed sub-path is not a route, never a cross-owner read')
{
  const own = await call(CustomerOrderApi, 'GET', A1.id, { cookie: A.cookie })
  check('GET /CustomerOrderApi/<own id> → 404, not 200 (no single-row route exists)', own.status === 404 && !own.json?.order)
  const crossById = await call(CustomerOrderApi, 'GET', B1.id, { cookie: A.cookie })
  check('GET /CustomerOrderApi/<B\'s id> from A → the same 404, no data (NEG)', crossById.status === 404 && !crossById.json?.order && crossById.json?.error === own.json?.error)
  const guestById = await call(CustomerOrderApi, 'GET', GUEST_NULL.id, { cookie: A.cookie })
  check('GET /CustomerOrderApi/<a guest order\'s id> → the same 404 (NEG)', guestById.status === 404)
}

section('a caller with no usable userId cannot be made to match a guest order (defence in depth)')
{
  const resourceModule = await import('../resources/CustomerOrderApi.js')
  const instance = new resourceModule.CustomerOrderApi()
  for (const badCaller of [{ userId: null }, { userId: '' }, { userId: undefined }, null, {}]) {
    const res = await instance.list(badCaller)
    const bodyText = await res.text()
    const bodyJson = JSON.parse(bodyText)
    check(`list() with userId ${JSON.stringify(badCaller?.userId)} returns an EMPTY list, never the guest rows (NEG)`, Array.isArray(bodyJson.orders) && bodyJson.orders.length === 0)
  }
}

section('an admin calling this resource sees only their own customer orders')
{
  const adminOnly = await call(CustomerOrderApi, 'GET', '', { cookie: ADMIN.cookie })
  check('an admin with no orders of their own sees an empty list, not everyone\'s', adminOnly.status === 200 && (adminOnly.json?.orders ?? []).length === 0)
  const ADMIN_O = { id: 'o-admin1', code: 'code-admin1', customerUserId: ADMIN.user.id, placedAt: '2026-03-01T00:00:00.000Z', status: 'received' }
  await tables.Order.put(ADMIN_O)
  const adminAfter = await call(CustomerOrderApi, 'GET', '', { cookie: ADMIN.cookie })
  const codesAdmin = (adminAfter.json?.orders ?? []).map((o) => o.code)
  const vAdmin = leakVerdict(codesAdmin, ['code-admin1'], ['code-a1', 'code-a2', 'code-b1'])
  check('…and after placing one, sees exactly that one order and nobody else\'s (NEG)', vAdmin.length === 0 && codesAdmin.length === 1, vAdmin.join(' | '))
}

section('every non-GET is a 404 — this resource writes nothing, ever')
{
  const before = tables.Order.rows.size
  const post = await call(CustomerOrderApi, 'POST', '', { cookie: A.cookie, body: { code: 'forged' } })
  check('POST → 404', post.status === 404)
  const put = await call(CustomerOrderApi, 'PUT', A1.id, { cookie: A.cookie, body: { status: 'cancelled' } })
  check('PUT → 404 and A1 is unchanged', put.status === 404 && tables.Order.rows.get(A1.id).status === 'received')
  const patch = await call(CustomerOrderApi, 'PATCH', A1.id, { cookie: A.cookie, body: { status: 'cancelled' } })
  check('PATCH → 404 and A1 is still unchanged', patch.status === 404 && tables.Order.rows.get(A1.id).status === 'received')
  const del = await call(CustomerOrderApi, 'DELETE', A1.id, { cookie: A.cookie })
  check('DELETE → 404 and A1 still exists', del.status === 404 && tables.Order.rows.has(A1.id))
  check('no row was added or removed by any of that', tables.Order.rows.size === before)
}

section('a session whose row was reassigned is refused (loadCaller\'s own guard)')
{
  const works = await call(CustomerOrderApi, 'GET', '', { cookie: A.cookie })
  check('PRECONDITION: A\'s cookie works while it still matches its row', works.status === 200)
  await tables.User.put({ ...A.user, email: 'someone-else@example.test' })
  const reassigned = await call(CustomerOrderApi, 'GET', '', { cookie: A.cookie })
  check('after the row is reassigned the same cookie → 403 auth_required', reassigned.status === 403 && reassigned.json?.code === 'auth_required')
  check('…and names nothing about why (rule 25: the same refusal a deactivated row gets)', reassigned.json?.error === 'Authentication required' && !/email|mismatch|owner|reassign/i.test(JSON.stringify(reassigned.json)))
  // NEG: the guard is refusing the MISMATCH, not the cookie. Put the row's email back.
  await tables.User.put({ ...A.user, email: A.user.email })
  const restored = await call(CustomerOrderApi, 'GET', '', { cookie: A.cookie })
  check('the very same cookie works again once the row is its own (NEG)', restored.status === 200)
}

section(`the rule-20 sweep over every response (${transcript.length})`)
{
  const synthetic = [{ cls: 'X', method: 'GET', pathname: '', status: 401, headers: new Headers({ 'cache-control': 'no-store' }) }]
  check('the sweep catches a 401 (NEG)', responseRulesVerdict(synthetic).some((b) => b.includes('401')))
  const bad = responseRulesVerdict(transcript)
  check('no 401, no WWW-Authenticate on a 403, everything no-store', bad.length === 0, bad.slice(0, 3).join(' | '))
}
process.exit(done())
