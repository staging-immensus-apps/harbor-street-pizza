// One order, in the three shapes the app serves it in — the customer's confirmation, the owner's
// queue, and the row itself — plus the status machine every writer goes through.
//
// WHY THE CODE IS THE ONLY KEY A CUSTOMER EVER HOLDS. There are no customer accounts (CLAUDE.md §1),
// so the link sent after checkout is the whole of the customer's claim on their order. The code is
// therefore 32 characters of random, never derived from the time, the phone number or a counter, and
// `OrderConfirmationApi` is the only public reader — there is no listing to enumerate.
//
// LINE ITEMS ARE A SNAPSHOT. `items` holds `{ menuItemId, name, priceCents, quantity }` copied from
// `MenuItem` at checkout, so a later price change or a deleted item never rewrites an order that has
// already been placed. Nothing in this app reads a price back through `menuItemId`.

import crypto from 'node:crypto'
import { config } from './config.js'
import { publicBaseFor } from './copy.js'

export const QUEUE_PENDING = 'pending_payment'
export const QUEUE_ACTIVE = 'active'
export const QUEUE_DONE = 'done'
export const QUEUES = [QUEUE_PENDING, QUEUE_ACTIVE, QUEUE_DONE]

export const STATUS_AWAITING_PAYMENT = 'awaiting_payment'
export const STATUS_RECEIVED = 'received'
export const STATUS_PREPARING = 'preparing'
export const STATUS_READY = 'ready'
export const STATUS_COLLECTED = 'collected'
export const STATUS_CANCELLED = 'cancelled'
export const STATUSES = [STATUS_AWAITING_PAYMENT, STATUS_RECEIVED, STATUS_PREPARING, STATUS_READY, STATUS_COLLECTED, STATUS_CANCELLED]

/** The statuses the owner may set from the queue screen. `awaiting_payment` is Stripe's to clear. */
export const OWNER_SETTABLE_STATUSES = [STATUS_RECEIVED, STATUS_PREPARING, STATUS_READY, STATUS_COLLECTED, STATUS_CANCELLED]

/** Which queue a status belongs in — one function, so a status change can never leave the two apart. */
export function queueForStatus (status) {
  if (status === STATUS_AWAITING_PAYMENT) return QUEUE_PENDING
  if (status === STATUS_COLLECTED || status === STATUS_CANCELLED) return QUEUE_DONE
  return QUEUE_ACTIVE
}

/** The one tap the owner's screen offers next, or null at the end of the line. */
export function nextStatus (status) {
  if (status === STATUS_RECEIVED) return STATUS_PREPARING
  if (status === STATUS_PREPARING) return STATUS_READY
  if (status === STATUS_READY) return STATUS_COLLECTED
  return null
}

export const PAYMENT_UNPAID = 'unpaid'
export const PAYMENT_PAID = 'paid'
export const PAYMENT_AT_STORE = 'pay_at_store'

export const FULFILMENT_PICKUP = 'pickup'
export const FULFILMENT_DELIVERY = 'delivery'

/** The four columns the twelve-month retention sweep clears (CLAUDE.md §8). */
export const PERSONAL_FIELDS = ['customerName', 'customerPhone', 'deliveryAddress', 'deliveryPostcode']

/**
 * A new order's code: 32 URL-safe characters of randomness.
 *
 * base64url of 24 bytes is exactly 32 characters with no padding, so there is nothing to trim and
 * no shorter code can be produced by accident.
 */
export function newOrderCode () {
  return crypto.randomBytes(24).toString('base64url')
}

/** The absolute link a customer is sent to after checkout — preview-aware (rule 30). */
export function orderUrl (code) {
  return `${publicBaseFor(config.publicAppUrl())}/order/${encodeURIComponent(code)}`
}

/** Where Stripe returns a customer who backed out of paying. */
export function checkoutUrl () {
  return `${publicBaseFor(config.publicAppUrl())}/checkout`
}

/** Have this order's personal details been cleared by the retention sweep? */
export function detailsCleared (row) {
  return Boolean(row?.personalDetailsClearedAt)
}

/**
 * What the holder of the order's link may see.
 *
 * The customer's own name and delivery address are here because they are what the person checks on
 * the confirmation screen; the PHONE NUMBER is not, because nothing on that screen needs it and the
 * link may be forwarded. Once the sweep has cleared the row, the fields come back null and the
 * order itself — its lines, its totals, its status — is still readable.
 */
export function publicOrderView (row) {
  return {
    code: row.code,
    placedAt: row.placedAt ?? null,
    status: row.status ?? null,
    fulfilment: row.fulfilment ?? null,
    items: Array.isArray(row.items) ? row.items : [],
    itemsTotalCents: row.itemsTotalCents ?? 0,
    deliveryFeeCents: row.deliveryFeeCents ?? 0,
    totalCents: row.totalCents ?? 0,
    paymentStatus: row.paymentStatus ?? null,
    readyEstimate: row.readyEstimate ?? null,
    customerName: detailsCleared(row) ? null : (row.customerName ?? null),
    deliveryAddress: detailsCleared(row) ? null : (row.deliveryAddress ?? null),
    deliveryPostcode: detailsCleared(row) ? null : (row.deliveryPostcode ?? null),
    personalDetailsCleared: detailsCleared(row),
  }
}

/**
 * What the owner sees: everything on the row, including the phone number and the Stripe reference.
 * This is the only view that carries a customer's phone, and `OrderAdminApi` is the only resource
 * that serves it (CLAUDE.md §9).
 */
export function adminOrderView (row) {
  return {
    id: row.id,
    code: row.code,
    placedAt: row.placedAt ?? null,
    status: row.status ?? null,
    queue: row.queue ?? null,
    fulfilment: row.fulfilment ?? null,
    customerName: row.customerName ?? null,
    customerPhone: row.customerPhone ?? null,
    deliveryAddress: row.deliveryAddress ?? null,
    deliveryPostcode: row.deliveryPostcode ?? null,
    items: Array.isArray(row.items) ? row.items : [],
    itemsTotalCents: row.itemsTotalCents ?? 0,
    deliveryFeeCents: row.deliveryFeeCents ?? 0,
    totalCents: row.totalCents ?? 0,
    paymentStatus: row.paymentStatus ?? null,
    paymentRef: row.paymentRef ?? null,
    readyEstimate: row.readyEstimate ?? null,
    personalDetailsClearedAt: row.personalDetailsClearedAt ?? null,
    nextStatus: nextStatus(row.status ?? null),
    updatedAt: row.updatedAt ?? null,
  }
}

/** The customer's details, validated. `{ error }` or `{ value }`. */
export function validateCustomer (body, { fulfilment }) {
  const b = body && typeof body === 'object' ? body : {}
  const customerName = String(b.customerName ?? '').trim()
  if (!customerName) return { error: 'a name is required' }
  if (customerName.length > 120) return { error: 'name must be at most 120 characters' }
  const customerPhone = String(b.customerPhone ?? '').trim()
  if (!customerPhone) return { error: 'a phone number is required' }
  if (customerPhone.length > 40) return { error: 'phone must be at most 40 characters' }
  if (!/[0-9]{6}/.test(customerPhone.replace(/[^0-9]/g, ''))) return { error: 'phone is not a phone number' }

  if (fulfilment !== FULFILMENT_DELIVERY) return { value: { customerName, customerPhone, deliveryAddress: null, deliveryPostcode: null } }

  const deliveryAddress = String(b.deliveryAddress ?? '').trim()
  if (!deliveryAddress) return { error: 'a delivery address is required' }
  if (deliveryAddress.length > 400) return { error: 'address must be at most 400 characters' }
  const deliveryPostcode = String(b.deliveryPostcode ?? '').trim()
  if (!deliveryPostcode) return { error: 'a delivery postcode is required' }
  return { value: { customerName, customerPhone, deliveryAddress, deliveryPostcode } }
}

/** `readyEstimate` as an ISO instant: now plus the shop's estimate for this fulfilment. */
export function readyEstimateAt (settings, fulfilment, now = Date.now()) {
  const minutes = fulfilment === FULFILMENT_DELIVERY ? settings.deliveryEstimateMinutes : settings.pickupEstimateMinutes
  return new Date(now + minutes * 60 * 1000).toISOString()
}
