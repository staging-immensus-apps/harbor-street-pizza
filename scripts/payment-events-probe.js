#!/usr/bin/env node
// WHAT A PAID ORDER IS, driven (lib/stripe-events.js — the seam resources/StripeWebhook.js loads):
//
//   1. An order joins the owner's queue ONLY when Stripe says the money arrived. Nothing else in
//      this app sets `paymentStatus: 'paid'`, and this suite asserts that too, over the tree.
//   2. The handler is idempotent. The webhook's own ledger is check-then-act, so two concurrent
//      deliveries of one event can both reach it; a redelivery must change nothing.
//   3. A session that completed WITHOUT the money (a bank debit still processing) does not promote
//      the order — that arrives later as `async_payment_succeeded`.
//   4. An event this app does not care about returns `false`, which the webhook ledgers as
//      `ignored` and acks; it never throws, because a throw tells Stripe to retry for three days.
//
// Hermetic: the frozen clock, the harperdb stub, no network, no Stripe.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { freezeClock } from './probe/frozen-clock.js'
freezeClock()

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const { checker, stripComments } = await import('./probe/harness.js')
const { tables, resetTables } = await import('./probe/harperdb-stub.js')
const { handleStripeEvent } = await import('../lib/stripe-events.js')

const { check, section, done, failures } = checker('payment-events-probe')

const SESSION = 'cs_test_abc123'
const AWAITING = {
  id: 'order-x', code: 'Hs7Qk2mVzT4bPn9wRxL6yCd3Ja1Ue8Fg', placedAt: '2026-11-11T17:00:00.000Z',
  status: 'awaiting_payment', queue: 'pending_payment', fulfilment: 'delivery',
  customerName: 'Ada', customerPhone: '07700 900111', deliveryAddress: '1 Lordship Lane', deliveryPostcode: 'N174AB',
  items: [{ menuItemId: 'menu-margherita', name: 'Margherita', priceCents: 950, quantity: 2 }],
  itemsTotalCents: 1900, deliveryFeeCents: 400, totalCents: 2300,
  paymentStatus: 'unpaid', paymentRef: SESSION, readyEstimate: null, personalDetailsClearedAt: null,
}

const completed = (overrides = {}) => ({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: SESSION, payment_status: 'paid', ...overrides } } })

function promoted (id) {
  const row = tables.Order.rows.get(id)
  return row?.paymentStatus === 'paid' && row.status === 'received' && row.queue === 'active'
}

section('negative control: the verdict can say no')
resetTables()
await tables.Order.put({ ...AWAITING })
check('an untouched order is not reported as promoted (NEG)', promoted('order-x') === false)
if (failures.length) process.exit(done())

section('a paid session promotes exactly one order')
{
  const out = await handleStripeEvent(completed())
  check('the handler applied it', out !== false)
  check('the order is paid, received and in the active queue', promoted('order-x'))
  check('a ready estimate was set as it joined the queue', typeof tables.Order.rows.get('order-x').readyEstimate === 'string')
  check('the money, the lines and the customer were not rewritten', tables.Order.rows.get('order-x').totalCents === 2300 && tables.Order.rows.get('order-x').items.length === 1 && tables.Order.rows.get('order-x').customerPhone === '07700 900111')
  check('no second order row appeared', tables.Order.rows.size === 1)
}

section('a redelivery changes nothing (the ledger is check-then-act)')
{
  const before = JSON.stringify(tables.Order.rows.get('order-x'))
  const out = await handleStripeEvent(completed())
  check('the handler still reports it dealt with', out !== false)
  check('…and the row is byte-identical', JSON.stringify(tables.Order.rows.get('order-x')) === before)
  // The owner has moved it along; a late redelivery must not drag it back to `received`.
  await tables.Order.put({ ...tables.Order.rows.get('order-x'), status: 'ready' })
  await handleStripeEvent(completed())
  check('an order the owner has advanced is not reset by a redelivery (NEG)', tables.Order.rows.get('order-x').status === 'ready')
}

section('completed is not paid: money still processing does not promote')
{
  resetTables()
  await tables.Order.put({ ...AWAITING })
  const out = await handleStripeEvent(completed({ payment_status: 'unpaid' }))
  check('the handler declines it', out === false)
  check('the order is still awaiting payment (NEG)', tables.Order.rows.get('order-x').status === 'awaiting_payment' && tables.Order.rows.get('order-x').paymentStatus === 'unpaid')
  const later = await handleStripeEvent({ id: 'evt_2', type: 'checkout.session.async_payment_succeeded', data: { object: { id: SESSION, payment_status: 'paid' } } })
  check('the later success event promotes it', later !== false && promoted('order-x'))
}

section('the order is found by its payment reference, or by the metadata, or not at all')
{
  resetTables()
  await tables.Order.put({ ...AWAITING, paymentRef: null })
  const out = await handleStripeEvent({ id: 'evt_3', type: 'checkout.session.completed', data: { object: { id: 'cs_test_other', payment_status: 'paid', metadata: { orderId: 'order-x' } } } })
  check('metadata names the order when the reference was never written back', out !== false && promoted('order-x'))
  check('…and the session id is recorded on it', tables.Order.rows.get('order-x').paymentRef === 'cs_test_other')
  resetTables()
  const orphan = await handleStripeEvent(completed())
  check('an event for an order this app does not have is ignored, not thrown (NEG)', orphan === false && tables.Order.rows.size === 0)
}

section('an event this app does not care about is ignored')
{
  resetTables()
  await tables.Order.put({ ...AWAITING })
  for (const type of ['customer.subscription.created', 'invoice.paid', 'payment_intent.succeeded', 'charge.refunded']) {
    const out = await handleStripeEvent({ id: `evt_${type}`, type, data: { object: { id: SESSION } } })
    check(`${type} → false, and the order is untouched`, out === false && tables.Order.rows.get('order-x').paymentStatus === 'unpaid')
  }
  check('an event with no type at all is ignored rather than thrown', (await handleStripeEvent({})) === false)
}

section('an abandoned checkout closes the order, and only that one')
{
  resetTables()
  await tables.Order.put({ ...AWAITING })
  const out = await handleStripeEvent({ id: 'evt_4', type: 'checkout.session.expired', data: { object: { id: SESSION } } })
  check('an expired session cancels the order it belongs to', out !== false && tables.Order.rows.get('order-x').status === 'cancelled' && tables.Order.rows.get('order-x').queue === 'done')
  resetTables()
  await tables.Order.put({ ...AWAITING, status: 'received', queue: 'active', paymentStatus: 'paid' })
  const out2 = await handleStripeEvent({ id: 'evt_5', type: 'checkout.session.expired', data: { object: { id: SESSION } } })
  check('a PAID order is never cancelled by a late expiry (NEG)', out2 === false && tables.Order.rows.get('order-x').status === 'received' && tables.Order.rows.get('order-x').paymentStatus === 'paid')
}

section('nothing but this module promotes an order to paid')
{
  // The rule is about the TREE and not about one call, so it is read off the tree: a write of
  // `paymentStatus: paid` must not appear anywhere else. The negative control is that the check
  // finds this module's own writer — without it, a rename would make the sweep vacuously green.
  const offenders = []
  let foundSelf = false
  for (const dir of ['resources', 'lib']) {
    for (const file of readdirSync(join(ROOT, dir))) {
      if (!file.endsWith('.js')) continue
      const rel = `${dir}/${file}`
      const text = stripComments(readFileSync(join(ROOT, dir, file), 'utf8'))
      if (!/paymentStatus\s*:\s*(PAYMENT_PAID|['"]paid['"])/.test(text)) continue
      if (rel === 'lib/stripe-events.js') foundSelf = true
      else offenders.push(rel)
    }
  }
  check('the check finds this module\'s own promotion (NEG: it can see a writer at all)', foundSelf)
  check('and no other resource or library sets paymentStatus to paid', offenders.length === 0, offenders.join(', '))
}

process.exit(done())
