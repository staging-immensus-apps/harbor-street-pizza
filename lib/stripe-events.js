// THE SEAM resources/StripeWebhook.js LOADS: what this app does with a Stripe event.
//
// An order paid online is created `queue: 'pending_payment'`, `status: 'awaiting_payment'`,
// `paymentStatus: 'unpaid'` (CheckoutApi), and it joins the owner's queue HERE and nowhere else —
// the only proof a payment happened is Stripe saying so over a signature-verified webhook. A
// customer returning to the confirmation page proves nothing and promotes nothing.
//
// MUST BE IDEMPOTENT, and the webhook's own ledger is not enough: its dedupe is check-then-act, so
// two concurrent deliveries of one event can both reach this module (that file's header has the
// measurement and why no atomic claim is available). Every branch below is therefore written to be
// harmless twice — an order already `paid` is left exactly as it is, and an order already in the
// done queue is never re-cancelled.
//
// `false` means "this app looked at the event and does not care": the webhook ledgers it `ignored`
// and acks 200. A throw means the event was not dealt with, answers 500, and Stripe retries.

import { db } from './db.js'
import { loadStoreSettings } from './shop.js'
import {
  QUEUE_ACTIVE, QUEUE_DONE,
  STATUS_RECEIVED, STATUS_CANCELLED, STATUS_AWAITING_PAYMENT,
  PAYMENT_PAID, readyEstimateAt,
} from './orders.js'

const PAID_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded']
const FAILED_EVENTS = ['checkout.session.expired', 'checkout.session.async_payment_failed']

export async function handleStripeEvent (event) {
  const type = event?.type
  if (PAID_EVENTS.includes(type)) return markPaid(event)
  if (FAILED_EVENTS.includes(type)) return markAbandoned(event)
  return false
}

/**
 * The order a Checkout Session belongs to, or null.
 *
 * `paymentRef` is the session id and is indexed, so this is one indexed equality. The metadata id is
 * the fallback for a session created before this app wrote the reference back — it is a second
 * reading of the same fact, never a second way to name an order.
 */
async function orderForSession (session) {
  const ref = typeof session?.id === 'string' ? session.id : ''
  if (ref) {
    for await (const row of db.Order.search({ conditions: [{ attribute: 'paymentRef', value: ref }], limit: 1 })) return row
  }
  const id = typeof session?.metadata?.orderId === 'string' ? session.metadata.orderId : ''
  if (id) return (await db.Order.get(id)) ?? null
  return null
}

async function markPaid (event) {
  const session = event?.data?.object ?? {}
  // Stripe sends `checkout.session.completed` for a session whose payment is still processing
  // (bank debits); the money is confirmed by `async_payment_succeeded`, which arrives later and
  // carries `payment_status: 'paid'`. Promoting on the first would put an unpaid order in the
  // kitchen's queue.
  if (session.payment_status && session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') return false

  const order = await orderForSession(session)
  if (!order) {
    console.warn(`[stripe-events] ${event.type}: no order matches session ${session?.id ?? '(none)'} — nothing to do`)
    return false
  }
  // Idempotent by state, not by a flag: a redelivery finds an order that is already paid and
  // changes nothing, which is also the right answer if the owner has since moved it along.
  if (order.paymentStatus === PAYMENT_PAID) return true

  const settings = await loadStoreSettings()
  await db.Order.put({
    ...order,
    paymentStatus: PAYMENT_PAID,
    paymentRef: typeof session.id === 'string' ? session.id : (order.paymentRef ?? null),
    status: STATUS_RECEIVED,
    queue: QUEUE_ACTIVE,
    // Recomputed as the order joins the queue: the kitchen starts when the payment lands, not when
    // the customer opened the checkout screen.
    readyEstimate: readyEstimateAt(settings, order.fulfilment),
  })
  console.log(`[stripe-events] order ${order.id} paid (${event.type})`)
  return true
}

async function markAbandoned (event) {
  const session = event?.data?.object ?? {}
  const order = await orderForSession(session)
  if (!order) return false
  // Only an order still waiting for this payment is cancelled. A paid order whose session later
  // expires, and an order the owner has already dealt with, are both left alone.
  if (order.status !== STATUS_AWAITING_PAYMENT || order.paymentStatus === PAYMENT_PAID) return false
  await db.Order.put({ ...order, status: STATUS_CANCELLED, queue: QUEUE_DONE })
  console.log(`[stripe-events] order ${order.id} cancelled (${event.type})`)
  return true
}
