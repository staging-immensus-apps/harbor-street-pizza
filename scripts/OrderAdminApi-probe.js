#!/usr/bin/env node
// GENERATED — OrderAdminApi over resources/OrderAdminApi.js, the shop's owner-only live queue and
// the only resource that ever serves a customer's name, phone number or delivery address
// (CLAUDE.md §9). Proves every entry point — GET list, GET one, POST status, PUT/PATCH aliases
// and the live stream's connect() — refuses anonymous, a signed-in non-admin and a demoted admin
// with 403 and no WWW-Authenticate, that none of those refusals leak a customer's details, that
// connect() never reaches subscribe() without passing requireAdmin first, that the default list is
// the active queue and a junk ?queue= falls back to it, and that a status update keeps the queue in
// lockstep with the status while the body cannot smuggle a change to any other field.
// `POST /OrderAdminApi/status` with the id in the BODY is the route the front end actually calls,
// so it gets its own full negative-control pass, and PUT/PATCH on the record path are kept covered
// as aliases. That shape was adopted on the theory that Harper refuses a write aimed at a record
// path, and QA on this build falsified it: POST status answers 400 on the deployment too. The cause
// is unresolved (CLAUDE.md §7 "OPEN QUESTION"), and NOTHING IN THIS FILE SPEAKS TO IT — these
// assertions run in-process against the stub and pass for either shape.
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
const { managedFieldsIn } = await import('../lib/managed-fields.js')

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

section('negative control: the managed-fields verdict can say yes (so the capture below means something)')
check('a synthesized record naming updatedAt is caught', managedFieldsIn({ id: 'x', status: 'y', updatedAt: 123 }, 'Order').includes('updatedAt'))
check('a clean record passes', managedFieldsIn({ id: 'x', status: 'y' }, 'Order').length === 0)
if (failures.length) process.exit(done())

resetTables()

// EVERY RECORD a write ever hands db.Order.put/.patch, captured by wrapping the SAME Table
// instance the resource writes through — db.Order and tables.Order are one object (the stub's
// own header: databases[DEFAULT] and tables are the same object, and lib/db.js resolves db.Order
// from there). The stub does not refuse a record naming updatedAt — nothing short of a real
// Harper cluster does — so this capture stands in for the 400 the live app actually threw: a
// write this probe calls "clean" that is not would be exactly the regression this probe exists to
// catch. `checkWritesSince()` scopes the assertion to the writes a route call actually made
// (never the fixtures this file seeds directly, which legitimately carry updatedAt).
const orderWrites = []
const realOrderPut = tables.Order.put.bind(tables.Order)
tables.Order.put = async (record) => {
  orderWrites.push({ method: 'put', record: { ...record } })
  return realOrderPut(record)
}
const realOrderPatch = tables.Order.patch ? tables.Order.patch.bind(tables.Order) : null
tables.Order.patch = async (id, data) => {
  orderWrites.push({ method: 'patch', record: { ...data } })
  if (realOrderPatch) return realOrderPatch(id, data)
}

/** Every write captured since `mark`, asserted clean of a field Harper owns for Order. */
function checkWritesSince (mark, label) {
  const made = orderWrites.slice(mark)
  const bad = made.filter((w) => managedFieldsIn(w.record, 'Order').length > 0)
  check(`${label}: ${made.length} write(s) via the resource name no Harper-owned field`, made.length > 0 && bad.length === 0, bad.map((w) => `${w.method} ${JSON.stringify(w.record)}`).join(' | '))
}

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

  for (const verb of ['PUT', 'PATCH']) {
    const before = { ...tables.Order.rows.get(A1) }
    const upd = await call(OrderAdminApi, verb, A1, { cookie, body: { status: 'preparing' } })
    check(`${label}: ${verb} → 403 ${expectCode}, and the row is untouched`, upd.status === 403 && upd.json?.code === expectCode && tables.Order.rows.get(A1).status === before.status)
  }

  const beforePost = { ...tables.Order.rows.get(A1) }
  const postUpd = await call(OrderAdminApi, 'POST', 'status', { cookie, body: { id: A1, status: 'preparing' } })
  check(`${label}: POST status → 403 ${expectCode}, and the row is untouched`, postUpd.status === 403 && postUpd.json?.code === expectCode && tables.Order.rows.get(A1).status === beforePost.status)
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

// Every section below runs once per verb, PUT first (the route the front end actually calls)
// then PATCH (kept as an alias), each on its OWN fresh pair of rows so the two runs cannot step
// on each other's writes. The row ids are namespaced by verb; everything else about the fixture
// (statuses, queues, customer fields) mirrors A1/A2/D1/P1 above.
for (const verb of ['PUT', 'PATCH']) {
  const tag = verb.toLowerCase()
  const vA1 = `order-${tag}-a1`
  const vA2 = `order-${tag}-a2`
  const vD1 = `order-${tag}-d1`
  const vP1 = `order-${tag}-p1`
  await tables.Order.put(makeOrder({ id: vA1, placedAt: '2026-02-01T00:00:00.000Z', status: 'received', queue: 'active', customerName: 'Ada Lovelace', customerPhone: '555-0100' }))
  await tables.Order.put(makeOrder({ id: vA2, placedAt: '2026-02-02T00:00:00.000Z', status: 'received', queue: 'active', customerName: 'Grace Hopper', customerPhone: '555-0200' }))
  await tables.Order.put(makeOrder({ id: vD1, placedAt: '2026-02-03T00:00:00.000Z', status: 'collected', queue: 'done', customerName: 'Done Person', customerPhone: '555-0300' }))
  await tables.Order.put(makeOrder({ id: vP1, placedAt: '2026-02-04T00:00:00.000Z', status: 'awaiting_payment', queue: 'pending_payment', customerName: 'Pending Person', customerPhone: '555-0400', paymentStatus: 'unpaid' }))
  const writeMark = orderWrites.length

  section(`${verb} advances status and keeps the queue in lockstep`)
  {
    const toDone = await call(OrderAdminApi, verb, vA1, { cookie: ADMIN.cookie, body: { status: 'collected' } })
    check(`${verb} status: collected → 200, status and queue both move`, toDone.status === 200 && toDone.json?.order?.status === 'collected' && toDone.json.order.queue === 'done')
    check('…and the stored row agrees (read from the table, not the response)', tables.Order.rows.get(vA1).status === 'collected' && tables.Order.rows.get(vA1).queue === 'done')

    const toPreparing = await call(OrderAdminApi, verb, vA2, { cookie: ADMIN.cookie, body: { status: 'preparing' } })
    check(`${verb} status: preparing → 200, queue stays active`, toPreparing.status === 200 && toPreparing.json?.order?.status === 'preparing' && toPreparing.json.order.queue === 'active')
    check('…and the stored row agrees', tables.Order.rows.get(vA2).status === 'preparing' && tables.Order.rows.get(vA2).queue === 'active')

    const toCancelled = await call(OrderAdminApi, verb, vA2, { cookie: ADMIN.cookie, body: { status: 'cancelled' } })
    check(`${verb} status: cancelled → 200, queue moves to done`, toCancelled.status === 200 && toCancelled.json?.order?.queue === 'done')
    check('…and the stored row agrees', tables.Order.rows.get(vA2).status === 'cancelled' && tables.Order.rows.get(vA2).queue === 'done')
  }

  section(`${verb} refuses a status the owner may not set, and changes nothing when it does (NEG)`)
  {
    const before = { ...tables.Order.rows.get(vD1) }
    const awaiting = await call(OrderAdminApi, verb, vD1, { cookie: ADMIN.cookie, body: { status: 'awaiting_payment' } })
    check('status: awaiting_payment is Stripe\'s to clear → 400, row untouched', awaiting.status === 400 && awaiting.json?.error && tables.Order.rows.get(vD1).status === before.status && tables.Order.rows.get(vD1).queue === before.queue)

    const invented = await call(OrderAdminApi, verb, vD1, { cookie: ADMIN.cookie, body: { status: 'hungry' } })
    check('an invented status → 400, row untouched', invented.status === 400 && invented.json?.error && tables.Order.rows.get(vD1).status === before.status)

    const missing = await call(OrderAdminApi, verb, vD1, { cookie: ADMIN.cookie, body: {} })
    check('a missing status → 400, row untouched', missing.status === 400 && missing.json?.error && tables.Order.rows.get(vD1).status === before.status)

    const missingId = await call(OrderAdminApi, verb, 'no-such-order', { cookie: ADMIN.cookie, body: { status: 'preparing' } })
    check('an unknown id → 404', missingId.status === 404)

    const deep = await call(OrderAdminApi, verb, `${vD1}/extra`, { cookie: ADMIN.cookie, body: { status: 'preparing' } })
    check('an unknown sub-path → 404', deep.status === 404)
  }

  section(`${verb} cannot smuggle a change to a protected field (NEG)`)
  {
    const before = { ...tables.Order.rows.get(vP1) }
    const forged = await call(OrderAdminApi, verb, vP1, { cookie: ADMIN.cookie, body: { status: 'received', id: 'forged-id', totalCents: 999999, paymentStatus: 'paid', paymentRef: 'forged-ref', code: 'forged-code', customerPhone: '000-0000', items: [{ menuItemId: 'forged', name: 'Forged', priceCents: 1, quantity: 99 }] } })
    check('status is applied…', forged.status === 200 && forged.json?.order?.status === 'received')
    check('…but id, code, items, totalCents, paymentStatus, paymentRef and customerPhone are all unchanged', forged.json.order.id === vP1 && forged.json.order.totalCents === before.totalCents && forged.json.order.paymentStatus === before.paymentStatus && forged.json.order.paymentRef === before.paymentRef && forged.json.order.code === before.code && forged.json.order.customerPhone === before.customerPhone && JSON.stringify(forged.json.order.items) === JSON.stringify(before.items))
    check('…and the stored row agrees', tables.Order.rows.get(vP1).id === vP1 && tables.Order.rows.get(vP1).totalCents === before.totalCents && tables.Order.rows.get(vP1).paymentStatus === before.paymentStatus && tables.Order.rows.get(vP1).paymentRef === before.paymentRef && tables.Order.rows.get(vP1).code === before.code && tables.Order.rows.get(vP1).customerPhone === before.customerPhone)
  }

  checkWritesSince(writeMark, `${verb}`)
}

section('POST /OrderAdminApi/status — the route the front end actually calls, id in the body')
{
  const pA1 = 'order-post-a1'
  const pD1 = 'order-post-d1'
  const pP1 = 'order-post-p1'
  await tables.Order.put(makeOrder({ id: pA1, placedAt: '2026-03-01T00:00:00.000Z', status: 'received', queue: 'active', customerName: 'Ada Lovelace', customerPhone: '555-0100' }))
  await tables.Order.put(makeOrder({ id: pD1, placedAt: '2026-03-02T00:00:00.000Z', status: 'collected', queue: 'done', customerName: 'Done Person', customerPhone: '555-0300' }))
  await tables.Order.put(makeOrder({ id: pP1, placedAt: '2026-03-03T00:00:00.000Z', status: 'awaiting_payment', queue: 'pending_payment', customerName: 'Pending Person', customerPhone: '555-0400', paymentStatus: 'unpaid' }))
  const writeMark = orderWrites.length

  // received → preparing → ready → collected: each step both status and queue move, read from
  // the stored row rather than trusted from the response.
  const toPreparing = await call(OrderAdminApi, 'POST', 'status', { cookie: ADMIN.cookie, body: { id: pA1, status: 'preparing' } })
  check('received → preparing → 200, queue stays active', toPreparing.status === 200 && toPreparing.json?.order?.status === 'preparing' && toPreparing.json.order.queue === 'active')
  check('…stored row agrees', tables.Order.rows.get(pA1).status === 'preparing' && tables.Order.rows.get(pA1).queue === 'active')

  const toReady = await call(OrderAdminApi, 'POST', 'status', { cookie: ADMIN.cookie, body: { id: pA1, status: 'ready' } })
  check('preparing → ready → 200, queue stays active', toReady.status === 200 && toReady.json?.order?.status === 'ready' && toReady.json.order.queue === 'active')
  check('…stored row agrees', tables.Order.rows.get(pA1).status === 'ready' && tables.Order.rows.get(pA1).queue === 'active')

  const toCollected = await call(OrderAdminApi, 'POST', 'status', { cookie: ADMIN.cookie, body: { id: pA1, status: 'collected' } })
  check('ready → collected → 200, queue moves to done', toCollected.status === 200 && toCollected.json?.order?.status === 'collected' && toCollected.json.order.queue === 'done')
  check('…stored row agrees', tables.Order.rows.get(pA1).status === 'collected' && tables.Order.rows.get(pA1).queue === 'done')

  const toCancelled = await call(OrderAdminApi, 'POST', 'status', { cookie: ADMIN.cookie, body: { id: pP1, status: 'cancelled' } })
  check('cancelled lands in queue done too', toCancelled.status === 200 && toCancelled.json?.order?.status === 'cancelled' && toCancelled.json.order.queue === 'done')
  check('…stored row agrees', tables.Order.rows.get(pP1).status === 'cancelled' && tables.Order.rows.get(pP1).queue === 'done')

  const missingId = await call(OrderAdminApi, 'POST', 'status', { cookie: ADMIN.cookie, body: { id: 'no-such-order', status: 'preparing' } })
  check('an unknown id → 404 (NEG)', missingId.status === 404)

  const blankId = await call(OrderAdminApi, 'POST', 'status', { cookie: ADMIN.cookie, body: { status: 'preparing' } })
  check('no id at all → 404 (NEG)', blankId.status === 404)

  {
    const before = { ...tables.Order.rows.get(pD1) }
    const invented = await call(OrderAdminApi, 'POST', 'status', { cookie: ADMIN.cookie, body: { id: pD1, status: 'hungry' } })
    check('an invented status → 400 with an error field, row untouched (NEG)', invented.status === 400 && typeof invented.json?.error === 'string' && tables.Order.rows.get(pD1).status === before.status && tables.Order.rows.get(pD1).queue === before.queue)

    const awaiting = await call(OrderAdminApi, 'POST', 'status', { cookie: ADMIN.cookie, body: { id: pD1, status: 'awaiting_payment' } })
    check('awaiting_payment is Stripe\'s to clear, not the owner\'s → 400, row untouched (NEG)', awaiting.status === 400 && typeof awaiting.json?.error === 'string' && tables.Order.rows.get(pD1).status === before.status)
  }

  {
    const before = { ...tables.Order.rows.get(pA1) }
    const forged = await call(OrderAdminApi, 'POST', 'status', { cookie: ADMIN.cookie, body: { id: pA1, status: 'received', totalCents: 999999, customerPhone: '000-0000', paymentStatus: 'paid', code: 'forged-code' } })
    check('status is applied…', forged.status === 200 && forged.json?.order?.status === 'received')
    check('…but totalCents, customerPhone, paymentStatus and code are all unchanged (NEG)', forged.json.order.totalCents === before.totalCents && forged.json.order.customerPhone === before.customerPhone && forged.json.order.paymentStatus === before.paymentStatus && forged.json.order.code === before.code)
    check('…and the stored row agrees', tables.Order.rows.get(pA1).totalCents === before.totalCents && tables.Order.rows.get(pA1).customerPhone === before.customerPhone && tables.Order.rows.get(pA1).paymentStatus === before.paymentStatus && tables.Order.rows.get(pA1).code === before.code)
  }

  const bareRoot = await call(OrderAdminApi, 'POST', '', { cookie: ADMIN.cookie, body: { id: pA1, status: 'preparing' } })
  check('POST with no sub-path → 404: an order is created by CheckoutApi, never here (NEG)', bareRoot.status === 404)

  const otherSub = await call(OrderAdminApi, 'POST', 'bogus', { cookie: ADMIN.cookie, body: { id: pA1, status: 'preparing' } })
  check('POST to any other sub-path → 404 (NEG)', otherSub.status === 404)

  checkWritesSince(writeMark, 'POST /OrderAdminApi/status')
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
  for (const verb of ['PUT', 'PATCH']) {
    const before = { ...tables.Order.rows.get(A1) }
    const upd = await call(OrderAdminApi, verb, A1, { cookie: DEMOTED.cookie, body: { status: 'ready' } })
    check(`…and on ${verb}, which changes nothing`, upd.status === 403 && tables.Order.rows.get(A1).status === before.status)
  }
  {
    const before = { ...tables.Order.rows.get(A1) }
    const upd = await call(OrderAdminApi, 'POST', 'status', { cookie: DEMOTED.cookie, body: { id: A1, status: 'ready' } })
    check('…and on POST status, which changes nothing', upd.status === 403 && tables.Order.rows.get(A1).status === before.status)
  }

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
