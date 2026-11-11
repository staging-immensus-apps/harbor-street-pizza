#!/usr/bin/env node
// GENERATED — OrderAdminApi over resources/OrderAdminApi.js, the shop's owner-only live queue and
// the only resource that ever serves a customer's name, phone number or delivery address
// (CLAUDE.md §9). Proves every entry point — GET list, GET one, PATCH and the live stream's
// connect() — refuses anonymous, a signed-in non-admin and a demoted admin with 403 and no
// WWW-Authenticate, that none of those refusals leak a customer's details, that connect() never
// reaches subscribe() without passing requireAdmin first, that the default list is the active
// queue and a junk ?queue= falls back to it, and that a status PATCH keeps the queue in lockstep
// with the status while the body cannot smuggle a change to any other field.
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
const { call, resource, userWithCookie, transcript, responseRulesVerdict } = await import('./probe/resource-call.js')
const { OrderAdminApi } = await import('../resources/OrderAdminApi.js')

const { check, section, done, failures } = checker('OrderAdminApi-probe')

const ALL_NAMES = ['Ada Lovelace', 'Grace Hopper', 'Done Person', 'Pending Person']
const ALL_PHONES = ['555-0100', '555-0200', '555-0300', '555-0400']

/** Does a response body (or any JS value) mention a customer's name or phone, as text? */
function leaksCustomerInfo (body, names, phones) {
  const text = JSON.stringify(body ?? {})
  return names.some((n) => text.includes(n)) || phones.some((p) => text.includes(p))
}

section('negative control: the leak check can say yes')
check('a synthetic body naming a customer is caught', leaksCustomerInfo({ error: 'x', note: 'Ada Lovelace was here' }, ALL_NAMES, ALL_PHONES))
check('a synthetic body naming a phone is caught', leaksCustomerInfo({ note: 'call 555-0300' }, ALL_NAMES, ALL_PHONES))
check('a clean body passes', !leaksCustomerInfo({ error: 'not found' }, ALL_NAMES, ALL_PHONES))
if (failures.length) process.exit(done())

resetTables()

function makeOrder (o) {
  return {
    id: o.id,
    code: o.code ?? `code-${o.id}`,
    placedAt: o.placedAt,
    status: o.status,
    queue: o.queue,
    fulfilment: o.fulfilment ?? 'pickup',
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    deliveryAddress: o.deliveryAddress ?? null,
    deliveryPostcode: o.deliveryPostcode ?? null,
    items: [{ menuItemId: 'm1', name: 'Pizza', priceCents: 1000, quantity: 1 }],
    itemsTotalCents: 1000,
    deliveryFeeCents: 0,
    totalCents: 1000,
    paymentStatus: o.paymentStatus ?? 'pay_at_store',
    paymentRef: o.paymentRef ?? null,
    readyEstimate: null,
    personalDetailsClearedAt: null,
    updatedAt: o.placedAt,
  }
}

const A1 = 'order-a1'
const A2 = 'order-a2'
const D1 = 'order-d1'
const P1 = 'order-p1'

await tables.Order.put(makeOrder({ id: A1, placedAt: '2026-01-01T00:00:00.000Z', status: 'received', queue: 'active', customerName: 'Ada Lovelace', customerPhone: '555-0100' }))
await tables.Order.put(makeOrder({ id: A2, placedAt: '2026-01-02T00:00:00.000Z', status: 'received', queue: 'active', customerName: 'Grace Hopper', customerPhone: '555-0200' }))
await tables.Order.put(makeOrder({ id: D1, placedAt: '2026-01-03T00:00:00.000Z', status: 'collected', queue: 'done', customerName: 'Done Person', customerPhone: '555-0300' }))
await tables.Order.put(makeOrder({ id: P1, placedAt: '2026-01-04T00:00:00.000Z', status: 'awaiting_payment', queue: 'pending_payment', customerName: 'Pending Person', customerPhone: '555-0400', paymentStatus: 'unpaid' }))

const ADMIN = await userWithCookie('admin@example.test', { role: 'admin' })
const MEMBER = await userWithCookie('member@example.test', { role: 'member' })
const GONE = await userWithCookie('gone@example.test', { role: 'admin', deactivatedAt: '2026-06-01T00:00:00.000Z' })
const DEMOTED = await userWithCookie('demoted@example.test', { role: 'admin' })

section('anonymous and non-admin callers are refused on every REST entry point, and nothing leaks')
for (const [label, cookie, expectCode] of [['anonymous', null, 'auth_required'], ['a signed-in member', MEMBER.cookie, 'admin_required'], ['a deactivated admin', GONE.cookie, 'admin_required']]) {
  const list = await call(OrderAdminApi, 'GET', '', { cookie })
  check(`${label}: GET list → 403 ${expectCode}, no WWW-Authenticate`, list.status === 403 && list.json?.code === expectCode && !list.headers.get('www-authenticate'))
  check(`${label}: …and the refusal body names no customer`, !leaksCustomerInfo(list.json, ALL_NAMES, ALL_PHONES))

  const one = await call(OrderAdminApi, 'GET', A1, { cookie })
  check(`${label}: GET one → 403 ${expectCode}`, one.status === 403 && one.json?.code === expectCode)
  check(`${label}: …and no customer data either`, !leaksCustomerInfo(one.json, ALL_NAMES, ALL_PHONES))

  const before = { ...tables.Order.rows.get(A1) }
  const patch = await call(OrderAdminApi, 'PATCH', A1, { cookie, body: { status: 'preparing' } })
  check(`${label}: PATCH → 403 ${expectCode}, and the row is untouched`, patch.status === 403 && patch.json?.code === expectCode && tables.Order.rows.get(A1).status === before.status)
}

section('connect(): the live stream is admin-only and never reaches subscribe without passing it')
{
  async function tryConnect (cookie) {
    let called = false
    tables.Order.subscribe = (opts) => {
      called = true
      return { opts, async *[Symbol.asyncIterator] () {} }
    }
    const inst = resource(OrderAdminApi, { cookie })
    let result = null
    let thrown = null
    try { result = await inst.connect() } catch (err) { thrown = err }
    const resp = thrown ?? (result instanceof Response ? result : null)
    if (resp) transcript.push({ cls: 'OrderAdminApi', method: 'CONNECT', pathname: '', status: resp.status, headers: resp.headers })
    return { called, result, thrown, resp }
  }

  const anon = await tryConnect(null)
  check('connect() anonymous throws the 403 Response, never reaching subscribe', anon.called === false && anon.resp instanceof Response && anon.resp.status === 403)
  check('…no WWW-Authenticate on it', !anon.resp.headers.get('www-authenticate'))
  const anonBody = JSON.parse(await anon.resp.clone().text())
  check('…and its body names no customer', !leaksCustomerInfo(anonBody, ALL_NAMES, ALL_PHONES))

  const member = await tryConnect(MEMBER.cookie)
  check('connect() a signed-in non-admin is refused the same way, subscribe not called', member.called === false && member.resp instanceof Response && member.resp.status === 403)

  const admin = await tryConnect(ADMIN.cookie)
  check('connect() an admin reaches subscribe', admin.called === true && admin.thrown === null && admin.result != null)
}

section('the stub would surface a cross-queue leak (the fixture can fail)')
{
  const all = []
  for await (const row of tables.Order.search({ conditions: [] })) all.push(row.id)
  check('an unconditioned search returns rows from every queue — so a resource that forgot the queue condition would fail below (NEG)', [A1, A2, D1, P1].every((id) => all.includes(id)))
}

section('the default list is the active queue, newest first, with counts')
{
  const active = await call(OrderAdminApi, 'GET', '', { cookie: ADMIN.cookie })
  const ids = (active.json?.orders ?? []).map((o) => o.id)
  check('default (no ?queue=) list → 200, scope active', active.status === 200 && active.json?.queue === 'active')
  check('it holds exactly the two active orders and none from done or pending_payment', ids.length === 2 && ids.includes(A1) && ids.includes(A2) && !ids.includes(D1) && !ids.includes(P1))
  check('newest first: A2 (placed later) before A1', ids[0] === A2 && ids[1] === A1)
  check('counts names at least active, and it is right', typeof active.json?.counts?.active === 'number' && active.json.counts.active === 2)
  check('an admin GET of the active list does carry the customer details (it is allowed to)', active.json.orders.find((o) => o.id === A1)?.customerPhone === '555-0100')

  const doneList = await call(OrderAdminApi, 'GET', '', { cookie: ADMIN.cookie, query: 'queue=done' })
  const doneIds = (doneList.json?.orders ?? []).map((o) => o.id)
  check('?queue=done narrows to the done queue', doneList.status === 200 && doneList.json?.queue === 'done' && doneIds.length === 1 && doneIds[0] === D1)

  const junk = await call(OrderAdminApi, 'GET', '', { cookie: ADMIN.cookie, query: 'queue=nonsense' })
  const junkIds = (junk.json?.orders ?? []).map((o) => o.id)
  check('a junk ?queue= falls back to active, not to everything (NEG)', junk.status === 200 && junk.json?.queue === 'active' && junkIds.length === 2 && !junkIds.includes(D1) && !junkIds.includes(P1))
}

section('GET one order')
{
  const one = await call(OrderAdminApi, 'GET', A1, { cookie: ADMIN.cookie })
  check('an admin reads one order in full, including the phone number', one.status === 200 && one.json?.order?.id === A1 && one.json.order.customerPhone === '555-0100')
  const missing = await call(OrderAdminApi, 'GET', 'no-such-order', { cookie: ADMIN.cookie })
  check('an unknown id → 404', missing.status === 404)
  const deep = await call(OrderAdminApi, 'GET', `${A1}/extra`, { cookie: ADMIN.cookie })
  check('an unknown sub-path → 404', deep.status === 404)
}

section('PATCH advances status and keeps the queue in lockstep')
{
  const toDone = await call(OrderAdminApi, 'PATCH', A1, { cookie: ADMIN.cookie, body: { status: 'collected' } })
  check('PATCH status: collected → 200, status and queue both move', toDone.status === 200 && toDone.json?.order?.status === 'collected' && toDone.json.order.queue === 'done')
  check('…and the stored row agrees (read from the table, not the response)', tables.Order.rows.get(A1).status === 'collected' && tables.Order.rows.get(A1).queue === 'done')

  const toPreparing = await call(OrderAdminApi, 'PATCH', A2, { cookie: ADMIN.cookie, body: { status: 'preparing' } })
  check('PATCH status: preparing → 200, queue stays active', toPreparing.status === 200 && toPreparing.json?.order?.status === 'preparing' && toPreparing.json.order.queue === 'active')
  check('…and the stored row agrees', tables.Order.rows.get(A2).status === 'preparing' && tables.Order.rows.get(A2).queue === 'active')

  const toCancelled = await call(OrderAdminApi, 'PATCH', A2, { cookie: ADMIN.cookie, body: { status: 'cancelled' } })
  check('PATCH status: cancelled → 200, queue moves to done', toCancelled.status === 200 && toCancelled.json?.order?.queue === 'done')
  check('…and the stored row agrees', tables.Order.rows.get(A2).status === 'cancelled' && tables.Order.rows.get(A2).queue === 'done')
}

section('PATCH refuses a status the owner may not set, and changes nothing when it does (NEG)')
{
  const before = { ...tables.Order.rows.get(D1) }
  const awaiting = await call(OrderAdminApi, 'PATCH', D1, { cookie: ADMIN.cookie, body: { status: 'awaiting_payment' } })
  check('status: awaiting_payment is Stripe\'s to clear → 400, row untouched', awaiting.status === 400 && tables.Order.rows.get(D1).status === before.status && tables.Order.rows.get(D1).queue === before.queue)

  const invented = await call(OrderAdminApi, 'PATCH', D1, { cookie: ADMIN.cookie, body: { status: 'hungry' } })
  check('an invented status → 400, row untouched', invented.status === 400 && tables.Order.rows.get(D1).status === before.status)

  const missing = await call(OrderAdminApi, 'PATCH', D1, { cookie: ADMIN.cookie, body: {} })
  check('a missing status → 400, row untouched', missing.status === 400 && tables.Order.rows.get(D1).status === before.status)
}

section('PATCH cannot smuggle a change to a protected field (NEG)')
{
  const before = { ...tables.Order.rows.get(P1) }
  const forged = await call(OrderAdminApi, 'PATCH', P1, { cookie: ADMIN.cookie, body: { status: 'received', totalCents: 999999, paymentStatus: 'paid', code: 'forged-code', customerPhone: '000-0000' } })
  check('status is applied…', forged.status === 200 && forged.json?.order?.status === 'received')
  check('…but totalCents, paymentStatus, code and customerPhone are all unchanged', forged.json.order.totalCents === before.totalCents && forged.json.order.paymentStatus === before.paymentStatus && forged.json.order.code === before.code && forged.json.order.customerPhone === before.customerPhone)
  check('…and the stored row agrees', tables.Order.rows.get(P1).totalCents === before.totalCents && tables.Order.rows.get(P1).paymentStatus === before.paymentStatus && tables.Order.rows.get(P1).code === before.code && tables.Order.rows.get(P1).customerPhone === before.customerPhone)
}

section('a demoted admin with an unexpired cookie is refused on every entry point')
{
  await tables.User.put({ ...DEMOTED.user, role: 'admin' })
  const works = await call(OrderAdminApi, 'GET', '', { cookie: DEMOTED.cookie })
  check('PRECONDITION: that cookie works while the row is still admin', works.status === 200)

  await tables.User.put({ ...DEMOTED.user, role: 'member' })
  const list = await call(OrderAdminApi, 'GET', '', { cookie: DEMOTED.cookie })
  check('after demotion the same cookie → 403 admin_required on GET list', list.status === 403 && list.json?.code === 'admin_required')
  const one = await call(OrderAdminApi, 'GET', A1, { cookie: DEMOTED.cookie })
  check('…and on GET one', one.status === 403 && one.json?.code === 'admin_required')
  const before = { ...tables.Order.rows.get(A1) }
  const patch = await call(OrderAdminApi, 'PATCH', A1, { cookie: DEMOTED.cookie, body: { status: 'ready' } })
  check('…and on PATCH, which changes nothing', patch.status === 403 && tables.Order.rows.get(A1).status === before.status)

  let called = false
  tables.Order.subscribe = () => { called = true; return { async *[Symbol.asyncIterator] () {} } }
  const inst = resource(OrderAdminApi, { cookie: DEMOTED.cookie })
  let thrown = null
  try { await inst.connect() } catch (err) { thrown = err }
  check('…and on connect(), subscribe never called', called === false && thrown instanceof Response && thrown.status === 403)
}

section(`the rule-20 sweep over every response (${transcript.length})`)
{
  const synthetic = [{ cls: 'X', method: 'GET', pathname: '', status: 401, headers: new Headers({ 'cache-control': 'no-store' }) }]
  check('the sweep catches a 401 (NEG)', responseRulesVerdict(synthetic).some((b) => b.includes('401')))
  const bad = responseRulesVerdict(transcript)
  check('no 401, no WWW-Authenticate on a 403, everything no-store', bad.length === 0, bad.slice(0, 3).join(' | '))
}

process.exit(done())
