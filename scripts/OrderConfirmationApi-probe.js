#!/usr/bin/env node
// GENERATED — OrderConfirmationApi has no owner field at all: the order's own 32-character random
// `code` IS the customer's whole claim on it (lib/orders.js header). This probe drives the
// resource AS SHIPPED over the stub runtime and proves: the right code returns exactly that
// order and nothing of any OTHER order's code, id, name or phone appears anywhere in the body;
// the forbidden keys (customerPhone, paymentRef, queue, id) never appear; there is no listing and
// no enumeration — no code, a second segment and a query parameter all answer the same 404 a
// wrong code gets; a cleared order comes back with its personal fields null but its items, totals
// and status intact; a blank or absurdly long code is a 404 and never a throw; anonymous gets 200
// for a valid code (that is the point — this is public); and nothing ever writes. Every leak and
// forbidden-key check is self-tested against a synthetic positive FIRST.
//
// Hermetic: clock frozen, no network, no git.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { freezeClock } from './probe/frozen-clock.js'
freezeClock()
process.env.SESSION_SECRET = 'suite-secret-not-a-real-one'

const { checker } = await import('./probe/harness.js')
const { tables, resetTables } = await import('./probe/harperdb-stub.js')
const { call, transcript, responseRulesVerdict } = await import('./probe/resource-call.js')
const { OrderConfirmationApi } = await import('../resources/OrderConfirmationApi.js')

const { check, section, done, failures } = checker('OrderConfirmationApi-probe')

/** Which of `needles` show up verbatim in `haystack` (a JSON-stringified response). */
function mentions (haystack, needles) {
  return needles.filter((n) => n != null && String(n).length && haystack.includes(String(n)))
}

section('negative control: the leak check can say yes')
{
  const synthetic = JSON.stringify({ order: { code: 'AAA', customerName: 'Zed Other' } })
  const found = mentions(synthetic, ['Zed Other', 'some-other-code'])
  check('a synthetic response naming another order\'s name is caught', found.includes('Zed Other'))
  const clean = mentions(JSON.stringify({ order: { code: 'AAA' } }), ['Zed Other'])
  check('…and a clean one is not (NEG)', clean.length === 0)
}

section('negative control: the forbidden-keys check can say yes')
{
  const FORBIDDEN = ['customerPhone', 'paymentRef', 'queue', 'id']
  const dirty = new Set(Object.keys({ customerPhone: 'x', code: 'y' }))
  check('a response carrying customerPhone is caught', FORBIDDEN.some((k) => dirty.has(k)))
  const clean = new Set(Object.keys({ code: 'y' }))
  check('…and a clean one is not (NEG)', !FORBIDDEN.some((k) => clean.has(k)))
}
if (failures.length) process.exit(done())

resetTables()

const now = '2026-06-01T12:00:00.000Z'
const A_CODE = 'a'.repeat(32)
const B_CODE = 'b'.repeat(32)
const C_CODE = 'c'.repeat(32)

const orderA = {
  id: 'order-a', code: A_CODE, placedAt: now, status: 'received', queue: 'active',
  fulfilment: 'delivery', customerName: 'Ada Lovelace', customerPhone: '555-0100-AAA',
  deliveryAddress: '1 Analytical Engine Way', deliveryPostcode: 'AB1 2CD',
  items: [{ menuItemId: 'm1', name: 'Margherita', priceCents: 900, quantity: 1 }],
  itemsTotalCents: 900, deliveryFeeCents: 300, totalCents: 1200,
  paymentStatus: 'pay_at_store', paymentRef: null, readyEstimate: '2026-06-01T12:45:00.000Z',
  personalDetailsClearedAt: null, updatedAt: now,
}
const orderB = {
  id: 'order-b', code: B_CODE, placedAt: '2025-01-01T00:00:00.000Z', status: 'collected', queue: 'done',
  fulfilment: 'pickup', customerName: 'Bea Cleared', customerPhone: '555-0200-BBB',
  deliveryAddress: null, deliveryPostcode: null,
  items: [{ menuItemId: 'm2', name: 'Pepperoni', priceCents: 1100, quantity: 2 }],
  itemsTotalCents: 2200, deliveryFeeCents: 0, totalCents: 2200,
  paymentStatus: 'paid', paymentRef: 'pi_abc', readyEstimate: '2025-01-01T00:30:00.000Z',
  personalDetailsClearedAt: '2026-01-01T00:00:00.000Z', updatedAt: now,
}
// Belongs to a third, unrelated customer — the one whose data must never show up beside A's or B's.
const orderC = {
  id: 'order-c', code: C_CODE, placedAt: now, status: 'preparing', queue: 'active',
  fulfilment: 'pickup', customerName: 'Cora Stranger', customerPhone: '555-0300-CCC',
  deliveryAddress: null, deliveryPostcode: null,
  items: [{ menuItemId: 'm3', name: 'Veggie', priceCents: 1000, quantity: 1 }],
  itemsTotalCents: 1000, deliveryFeeCents: 0, totalCents: 1000,
  paymentStatus: 'unpaid', paymentRef: 'pi_xyz', readyEstimate: '2026-06-01T12:30:00.000Z',
  personalDetailsClearedAt: null, updatedAt: now,
}
await tables.Order.put(orderA)
await tables.Order.put(orderB)
await tables.Order.put(orderC)
const SNAPSHOT = new Map([...tables.Order.rows].map(([id, row]) => [id, { ...row }]))

section('the right code returns exactly that order, and only that one (anonymous — this is public)')
{
  const r = await call(OrderConfirmationApi, 'GET', A_CODE)
  check('200 for a valid code with no cookie at all', r.status === 200)
  check('the order is A\'s', r.json?.order?.code === A_CODE && r.json.order.customerName === 'Ada Lovelace')
  const text = JSON.stringify(r.json)
  const leaked = mentions(text, [B_CODE, C_CODE, 'order-a', 'order-b', 'order-c', 'Bea Cleared', 'Cora Stranger', '555-0200-BBB', '555-0300-CCC'])
  check('…and nothing of B\'s or C\'s order — or either row\'s id — appears anywhere in the response (NEG)', leaked.length === 0, leaked.join(' | '))
}

section('the forbidden keys never appear')
{
  const r = await call(OrderConfirmationApi, 'GET', A_CODE)
  const keys = new Set(Object.keys(r.json?.order ?? {}))
  const FORBIDDEN = ['customerPhone', 'paymentRef', 'queue', 'id']
  check('no customerPhone, paymentRef, queue or id key on the response', !FORBIDDEN.some((k) => keys.has(k)), [...keys].join(','))
}

section('a cleared order comes back without its personal fields, with everything else intact')
{
  const r = await call(OrderConfirmationApi, 'GET', B_CODE)
  check('200, status/items/totals intact', r.status === 200 && r.json?.order?.status === 'collected' && r.json.order.totalCents === 2200 && Array.isArray(r.json.order.items) && r.json.order.items.length === 1 && r.json.order.items[0].name === 'Pepperoni')
  check('customerName and deliveryAddress are null, and personalDetailsCleared is true', r.json?.order?.customerName === null && r.json.order.deliveryAddress === null && r.json.order.deliveryPostcode === null && r.json.order.personalDetailsCleared === true)
}

section('no listing and no enumeration')
{
  const bare = await call(OrderConfirmationApi, 'GET', '')
  check('GET with no code → 404', bare.status === 404)
  check('…and no array of orders anywhere in the body (NEG)', !('orders' in (bare.json ?? {})) && !Array.isArray(bare.json))
  const sub = await call(OrderConfirmationApi, 'GET', `${A_CODE}/extra`)
  check('a second path segment → 404', sub.status === 404)
  const spoof = await call(OrderConfirmationApi, 'GET', '', { query: `code=${A_CODE}` })
  check('a ?code= query parameter selects nothing (NEG)', spoof.status === 404 && !('order' in (spoof.json ?? {})))
}

section('an unknown code is the same 404 as another unknown code')
{
  const missA = await call(OrderConfirmationApi, 'GET', 'd'.repeat(32))
  const missB = await call(OrderConfirmationApi, 'GET', 'e'.repeat(32))
  check('both unknown codes → 404 with byte-identical bodies (existence is not distinguishable)', missA.status === 404 && missB.status === 404 && JSON.stringify(missA.json) === JSON.stringify(missB.json))
}

section('a malformed code never throws')
{
  const blank = await call(OrderConfirmationApi, 'GET', '')
  check('blank → 404', blank.status === 404)
  const huge = await call(OrderConfirmationApi, 'GET', 'x'.repeat(500))
  check('a 500-character code → 404, not a throw', huge.status === 404)
}

section('every writing verb is refused the same way')
{
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await call(OrderConfirmationApi, m, A_CODE, { body: { status: 'cancelled' } })
    check(`${m} /OrderConfirmationApi/${A_CODE} → 404`, r.status === 404)
  }
}

section('nothing was ever written, by any of that')
{
  check('row count unchanged', tables.Order.rows.size === 3)
  let same = true
  for (const [id, row] of SNAPSHOT) if (JSON.stringify(tables.Order.rows.get(id)) !== JSON.stringify(row)) same = false
  check('…and every stored row is byte-identical to what was seeded', same)
}

section(`the rule-20 sweep over every response (${transcript.length})`)
{
  const synthetic = [{ cls: 'X', method: 'GET', pathname: '', status: 401, headers: new Headers({ 'cache-control': 'no-store' }) }]
  check('the sweep catches a 401 (NEG)', responseRulesVerdict(synthetic).some((b) => b.includes('401')))
  const bad = responseRulesVerdict(transcript)
  check('no 401, every response no-store', bad.length === 0, bad.slice(0, 3).join(' | '))
}

process.exit(done())
