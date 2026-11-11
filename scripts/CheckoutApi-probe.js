#!/usr/bin/env node
// GENERATED — resources/CheckoutApi.js is public guest checkout, the most load-bearing resource in
// the app: it is where a basket becomes money. This probe proves the cart arriving from the browser
// is never trusted (every line re-priced from MenuItem, every total computed server-side, no field
// of the body reaches the stored row except what was validated), both payment paths work, and a
// Stripe failure never advances an order past pending_payment.
//
// Hermetic: clock frozen, no network (Stripe is driven through an injected fetch), no git.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { freezeClock } from './probe/frozen-clock.js'
freezeClock()
process.env.SESSION_SECRET = 'suite-secret-not-a-real-one'
delete process.env.STRIPE_SECRET_KEY

const { checker } = await import('./probe/harness.js')
const { tables, resetTables } = await import('./probe/harperdb-stub.js')
const { call, transcript, responseRulesVerdict } = await import('./probe/resource-call.js')
const { CheckoutApi } = await import('../resources/CheckoutApi.js')
const { STORE_ID } = await import('../lib/shop.js')

const { check, section, done, failures } = checker('CheckoutApi-probe')

section('negative control: the sweep can say no')
{
  const synthetic = [{ cls: 'X', method: 'GET', pathname: '', status: 401, headers: new Headers({ 'cache-control': 'no-store' }) }]
  check('the sweep catches a 401 (NEG)', responseRulesVerdict(synthetic).some((b) => b.includes('401')))
}
if (failures.length) process.exit(done())

async function seed () {
  resetTables()
  await tables.MenuItem.put({ id: 'pizza-1', name: 'Margherita', priceCents: 900, category: 'Pizza', available: true, sortOrder: 1 })
  await tables.MenuItem.put({ id: 'pizza-2', name: 'Pepperoni', priceCents: 1100, category: 'Pizza', available: true, sortOrder: 2 })
  await tables.MenuItem.put({ id: 'pizza-gone', name: 'Retired Special', priceCents: 1500, category: 'Pizza', available: false, sortOrder: 3 })
  await tables.StoreSetting.put({
    id: STORE_ID,
    storeName: 'Ada\'s Pizza',
    acceptingOrders: true,
    pausedMessage: 'Back soon',
    pickupEnabled: true,
    deliveryEnabled: true,
    deliveryFeeCents: 350,
    deliveryPostcodes: ['N17'],
    pickupEstimateMinutes: 20,
    deliveryEstimateMinutes: 40,
  })
}

await seed()

section('a quote prices from the TABLE, never from the body (NEG)')
{
  check('PRECONDITION: the fixture\'s menu price differs from the forged one, so this check can fail', tables.MenuItem.rows.get('pizza-1').priceCents !== 1)
  const r = await call(CheckoutApi, 'POST', 'quote', { body: { lines: [{ menuItemId: 'pizza-1', quantity: 2, priceCents: 1 }], fulfilment: 'pickup' } })
  check('200, priced from the menu (900 * 2 = 1800), not the forged 1', r.status === 200 && r.json?.itemsTotalCents === 1800)
  check('the quote carries no priceCents: 1 anywhere in its lines', (r.json?.lines ?? []).every((l) => l.priceCents === 900))
}

section('quantity is validated: 0, -1, 2.5 and 999 are all 400')
{
  for (const quantity of [0, -1, 2.5, 999]) {
    const r = await call(CheckoutApi, 'POST', 'quote', { body: { lines: [{ menuItemId: 'pizza-1', quantity }], fulfilment: 'pickup' } })
    check(`quantity ${quantity} → 400`, r.status === 400 && r.json?.code === 'bad_quantity')
  }
}

section('an unavailable or unknown item is 400 and writes no Order row (NEG)')
{
  const unavailable = await call(CheckoutApi, 'POST', 'order', { body: { lines: [{ menuItemId: 'pizza-gone', quantity: 1 }], fulfilment: 'pickup', customerName: 'Ada', customerPhone: '07000000000' } })
  check('an unavailable item → 400 item_unavailable', unavailable.status === 400 && unavailable.json?.code === 'item_unavailable')
  const unknown = await call(CheckoutApi, 'POST', 'order', { body: { lines: [{ menuItemId: 'no-such-item', quantity: 1 }], fulfilment: 'pickup', customerName: 'Ada', customerPhone: '07000000000' } })
  check('an unknown item → 400 item_unavailable', unknown.status === 400 && unknown.json?.code === 'item_unavailable')
  check('neither wrote a row', tables.Order.rows.size === 0)
}

section('an empty basket is 400 on both endpoints')
{
  const q = await call(CheckoutApi, 'POST', 'quote', { body: { lines: [], fulfilment: 'pickup' } })
  check('empty basket quote → 400 empty_basket', q.status === 400 && q.json?.code === 'empty_basket')
  const o = await call(CheckoutApi, 'POST', 'order', { body: { lines: [], fulfilment: 'pickup', customerName: 'Ada', customerPhone: '07000000000' } })
  check('empty basket order → 400 empty_basket', o.status === 400 && o.json?.code === 'empty_basket')
  check('still no row written', tables.Order.rows.size === 0)
}

section('a quote writes nothing, whatever it prices')
{
  await call(CheckoutApi, 'POST', 'quote', { body: { lines: [{ menuItemId: 'pizza-1', quantity: 3 }], fulfilment: 'delivery', deliveryPostcode: 'N17 4AB' } })
  check('tables.Order is still empty after several quotes', tables.Order.rows.size === 0)
}

section('ordering paused: quote still 200, order is 400')
{
  await tables.StoreSetting.put({ ...tables.StoreSetting.rows.get(STORE_ID), acceptingOrders: false })
  const q = await call(CheckoutApi, 'POST', 'quote', { body: { lines: [{ menuItemId: 'pizza-1', quantity: 1 }], fulfilment: 'pickup' } })
  check('quote still answers 200 while paused', q.status === 200)
  check('…and reports the pause', q.json?.acceptingOrders === false && typeof q.json?.pausedMessage === 'string')
  const o = await call(CheckoutApi, 'POST', 'order', { body: { lines: [{ menuItemId: 'pizza-1', quantity: 1 }], fulfilment: 'pickup', customerName: 'Ada', customerPhone: '07000000000' } })
  check('order → 400 ordering_paused', o.status === 400 && o.json?.code === 'ordering_paused')
  check('no row written while paused', tables.Order.rows.size === 0)
  await tables.StoreSetting.put({ ...tables.StoreSetting.rows.get(STORE_ID), acceptingOrders: true })
}

section('a delivery order to an uncovered postcode: postcodeCovered false on the quote, 400 on the order')
{
  const q = await call(CheckoutApi, 'POST', 'quote', { body: { lines: [{ menuItemId: 'pizza-1', quantity: 1 }], fulfilment: 'delivery', deliveryPostcode: 'SW1A 1AA' } })
  check('quote → 200 with postcodeCovered: false', q.status === 200 && q.json?.postcodeCovered === false)
  const o = await call(CheckoutApi, 'POST', 'order', { body: { lines: [{ menuItemId: 'pizza-1', quantity: 1 }], fulfilment: 'delivery', deliveryPostcode: 'SW1A 1AA', customerName: 'Ada', customerPhone: '07000000000', deliveryAddress: '1 Road' } })
  check('order → 400 postcode_not_covered', o.status === 400 && o.json?.code === 'postcode_not_covered')
  check('no row written', tables.Order.rows.size === 0)
}

section('delivery adds exactly the settings\' fee; pickup adds none')
{
  const pickup = await call(CheckoutApi, 'POST', 'quote', { body: { lines: [{ menuItemId: 'pizza-1', quantity: 1 }], fulfilment: 'pickup' } })
  check('pickup adds no fee', pickup.status === 200 && pickup.json?.deliveryFeeCents === 0 && pickup.json?.totalCents === 900)
  const delivery = await call(CheckoutApi, 'POST', 'quote', { body: { lines: [{ menuItemId: 'pizza-1', quantity: 1 }], fulfilment: 'delivery', deliveryPostcode: 'N17 4AB' } })
  check('delivery adds exactly the settings fee (350)', delivery.status === 200 && delivery.json?.deliveryFeeCents === 350 && delivery.json?.totalCents === 1250)
}

section('a body that tries to set status, queue, paymentStatus, paymentRef, code, totalCents or id changes none of them (NEG)')
{
  const before = tables.Order.rows.size
  const forged = await call(CheckoutApi, 'POST', 'order', {
    body: {
      lines: [{ menuItemId: 'pizza-1', quantity: 1 }],
      fulfilment: 'pickup',
      customerName: 'Ada',
      customerPhone: '07000000000',
      status: 'collected',
      queue: 'done',
      paymentStatus: 'paid',
      paymentRef: 'forged-ref',
      code: 'FORGED-CODE-THAT-IS-NOT-32-CHARS',
      totalCents: 1,
      id: 'forged-id',
    },
  })
  check('201 created', forged.status === 201 && tables.Order.rows.size === before + 1)
  const stored = [...tables.Order.rows.values()].find((o) => o.id !== 'forged-id')
  check('the stored row ignores every forged field', Boolean(stored)
    && stored.status === 'received'
    && stored.queue === 'active'
    && stored.paymentStatus === 'pay_at_store'
    && stored.paymentRef === null
    && stored.code !== 'FORGED-CODE-THAT-IS-NOT-32-CHARS'
    && stored.totalCents === 900
    && stored.id !== 'forged-id')
  check('…and the response agrees with the stored row', forged.json?.order?.id === stored.id && forged.json.order.code === stored.code)
}

section('two orders get different 32-character codes')
{
  const a = await call(CheckoutApi, 'POST', 'order', { body: { lines: [{ menuItemId: 'pizza-1', quantity: 1 }], fulfilment: 'pickup', customerName: 'A', customerPhone: '07000000000' } })
  const b = await call(CheckoutApi, 'POST', 'order', { body: { lines: [{ menuItemId: 'pizza-1', quantity: 1 }], fulfilment: 'pickup', customerName: 'B', customerPhone: '07000000000' } })
  check('both 201 with 32-character codes', a.status === 201 && b.status === 201 && a.json?.order?.code?.length === 32 && b.json?.order?.code?.length === 32)
  check('the two codes differ', a.json?.order?.code !== b.json?.order?.code)
}

section('with no Stripe key: active/received/pay_at_store, paymentUrl null')
{
  const r = await call(CheckoutApi, 'POST', 'order', { body: { lines: [{ menuItemId: 'pizza-1', quantity: 1 }], fulfilment: 'pickup', customerName: 'Grace', customerPhone: '07000000000' } })
  check('201, pay_at_store', r.status === 201
    && r.json?.order?.queue === 'active'
    && r.json?.order?.status === 'received'
    && r.json?.order?.paymentStatus === 'pay_at_store'
    && r.json?.paymentUrl === null)
  check('readyEstimate is set', typeof r.json?.order?.readyEstimate === 'string' && r.json.order.readyEstimate.length > 0)
  check('…and the stored row agrees', tables.Order.rows.get(r.json.order.id)?.paymentStatus === 'pay_at_store')
}

section('with a Stripe key configured (an injected fetch, no network): pending_payment/awaiting_payment/unpaid')
{
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key_not_real'
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    check('PRECONDITION: the Checkout Session request really goes to Stripe', String(url).startsWith('https://api.stripe.com/'))
    return new Response(JSON.stringify({ id: 'cs_test_x', url: 'https://checkout.stripe.com/x', livemode: false }), { status: 200 })
  }
  try {
    const before = tables.Order.rows.size
    const r = await call(CheckoutApi, 'POST', 'order', { body: { lines: [{ menuItemId: 'pizza-1', quantity: 1 }], fulfilment: 'pickup', customerName: 'Hedy', customerPhone: '07000000000' } })
    check('201 with a Stripe paymentUrl', r.status === 201 && r.json?.paymentUrl === 'https://checkout.stripe.com/x')
    check('the row is pending_payment/awaiting_payment/unpaid with paymentRef cs_test_x', r.json?.order?.queue === 'pending_payment'
      && r.json?.order?.status === 'awaiting_payment'
      && r.json?.order?.paymentStatus === 'unpaid'
      && r.json?.order?.paymentRef === 'cs_test_x')
    check('readyEstimate is null until paid', r.json?.order?.readyEstimate === null)
    check('exactly one new row was written (not the pending write plus a duplicate)', tables.Order.rows.size === before + 1)
    check('…and NOTHING anywhere set paymentStatus: paid', ![...tables.Order.rows.values()].some((o) => o.paymentStatus === 'paid'))
  } finally {
    globalThis.fetch = originalFetch
  }
}

section('a Stripe failure leaves the order pending_payment with a 502/503, never promoted')
{
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { type: 'api_error' } }), { status: 500 })
  try {
    const before = tables.Order.rows.size
    const r = await call(CheckoutApi, 'POST', 'order', { body: { lines: [{ menuItemId: 'pizza-1', quantity: 1 }], fulfilment: 'pickup', customerName: 'Marie', customerPhone: '07000000000' } })
    check('a Stripe 500 → 502 or 503, never 201', r.status === 502 || r.status === 503)
    check('exactly one row exists now (the pending write happened before the failed call)', tables.Order.rows.size === before + 1)
    const pending = [...tables.Order.rows.values()].find((o) => o.customerName === 'Marie')
    check('…and it is pending_payment/awaiting_payment/unpaid, not promoted', Boolean(pending)
      && pending.queue === 'pending_payment'
      && pending.status === 'awaiting_payment'
      && pending.paymentStatus === 'unpaid')
    check('…and still no paymentStatus: paid anywhere', ![...tables.Order.rows.values()].some((o) => o.paymentStatus === 'paid'))
  } finally {
    globalThis.fetch = originalFetch
  }
  delete process.env.STRIPE_SECRET_KEY
}

section('anonymous callers get 200/201 throughout — this resource is public')
{
  check('every call above carried no cookie and none was refused for lack of one', transcript.every((t) => t.status !== 403 || t.json?.code !== 'auth_required'))
}

section('any other sub-path, and any method but POST, is 404')
{
  const badSub = await call(CheckoutApi, 'POST', 'nonsense', { body: {} })
  check('POST /CheckoutApi/nonsense → 404', badSub.status === 404)
  const g = await call(CheckoutApi, 'GET', '')
  check('GET /CheckoutApi → 404', g.status === 404)
  const p = await call(CheckoutApi, 'PUT', '')
  check('PUT /CheckoutApi → 404', p.status === 404)
  const d = await call(CheckoutApi, 'DELETE', '')
  check('DELETE /CheckoutApi → 404', d.status === 404)
}

section(`the rule-20 sweep over every response (${transcript.length})`)
{
  const bad = responseRulesVerdict(transcript)
  check('no 401, no WWW-Authenticate on a 403, everything no-store', bad.length === 0, bad.slice(0, 3).join(' | '))
}

process.exit(done())
