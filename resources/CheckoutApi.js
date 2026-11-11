// Guest checkout — the one resource where a basket becomes money. PUBLIC: there are no customer
// accounts (CLAUDE.md §1), so neither endpoint reads or requires a session.
//
//   POST /CheckoutApi/quote   { lines, fulfilment, deliveryPostcode } → 200 priced quote, writes nothing
//   POST /CheckoutApi/order   same body plus customerName, customerPhone, deliveryAddress → 201 { order, orderUrl, paymentUrl }
//
// THE BASKET ARRIVING FROM A BROWSER IS A REQUEST, NEVER A PRICE, and lib/pricing.js's priceCart()
// is the one place that turns it into one — both endpoints here call exactly that function, so the
// number quoted and the number charged cannot disagree. Every Order row is built field by field from
// the quote, the validated customer and the clock; the request body is NEVER spread into it, so a
// caller cannot smuggle status, queue, paymentStatus, paymentRef, code, id or a total of their own
// choosing into a row.
//
// TWO PAYMENT PATHS, both load-bearing (CLAUDE.md §1): with no Stripe key the order is placed
// immediately, pay_at_store; with one, the order is written FIRST as pending_payment so it exists
// before the customer ever reaches Stripe, then a Checkout Session is requested and the row is
// updated with the session id as paymentRef. This resource never writes paymentStatus: 'paid' —
// only the payments kit's StripeWebhook does that, because Stripe saying so is the only proof a
// payment happened.

import crypto from 'node:crypto'
import { Resource } from 'harperdb'
import { db } from '../lib/db.js'
import { json, segmentsOf, runAuthed } from '../lib/http.js'
import { priceCart, normalizeFulfilment } from '../lib/pricing.js'
import { loadStoreSettings } from '../lib/shop.js'
import {
  newOrderCode, orderUrl, checkoutUrl, readyEstimateAt, validateCustomer,
  QUEUE_ACTIVE, QUEUE_PENDING, STATUS_RECEIVED, STATUS_AWAITING_PAYMENT,
  PAYMENT_AT_STORE, PAYMENT_UNPAID,
} from '../lib/orders.js'
import { stripeConfigured, createOrderCheckoutSession, stripeFailureResponse } from '../lib/stripe.js'

export class CheckoutApi extends Resource {
  static loadAsInstance = false

  async get (target) {
    target.checkPermission = false
    return json({ error: 'not found' }, 404)
  }

  async post (target, data) {
    target.checkPermission = false
    return runAuthed(async () => {
      const [sub] = segmentsOf(target)
      const body = data && typeof data === 'object' ? data : {}
      if (sub === 'quote') return this.quote(body)
      if (sub === 'order') return this.order(body)
      return json({ error: 'not found' }, 404)
    })
  }

  async put (target) {
    target.checkPermission = false
    return json({ error: 'not found' }, 404)
  }

  async patch (target) {
    target.checkPermission = false
    return json({ error: 'not found' }, 404)
  }

  async delete (target) {
    target.checkPermission = false
    return json({ error: 'not found' }, 404)
  }

  /** Price a cart. Writes nothing — the basket screen calls this on every change. */
  async quote (body) {
    const settings = await loadStoreSettings()
    const fulfilment = normalizeFulfilment(body.fulfilment)
    const priced = await priceCart({ lines: body.lines, fulfilment, deliveryPostcode: body.deliveryPostcode, settings })
    if (priced.error) return json({ error: priced.error, code: priced.code }, 400)
    return json({
      ...priced,
      acceptingOrders: settings.acceptingOrders,
      pausedMessage: settings.acceptingOrders ? null : settings.pausedMessage,
    })
  }

  /**
   * Place an order. Re-prices the cart the same way `quote()` does — the same function, so the
   * number shown and the number charged are one computation — then refuses in order: ordering
   * paused, an unpriceable cart, the chosen fulfilment switched off, an uncovered delivery
   * postcode, invalid customer details. Only then is a row written.
   */
  async order (body) {
    const settings = await loadStoreSettings()
    if (!settings.acceptingOrders) return json({ error: 'we are not taking orders right now', code: 'ordering_paused' }, 400)

    const fulfilment = normalizeFulfilment(body.fulfilment)
    const priced = await priceCart({ lines: body.lines, fulfilment, deliveryPostcode: body.deliveryPostcode, settings })
    if (priced.error) return json({ error: priced.error, code: priced.code }, 400)
    if (priced.deliveryAvailable === false) return json({ error: `${fulfilment} is not available right now`, code: 'fulfilment_unavailable' }, 400)
    if (priced.postcodeCovered === false) return json({ error: 'we do not deliver to that postcode', code: 'postcode_not_covered' }, 400)

    const customer = validateCustomer(body, { fulfilment })
    if (customer.error) return json({ error: customer.error, code: 'bad_customer' }, 400)

    const now = Date.now()
    const id = crypto.randomUUID()
    const code = newOrderCode()
    // Every field here comes from priceCart, validateCustomer or the clock — never from `body`
    // directly, so a caller cannot write its own status, queue, totals, code or id into the row.
    const base = {
      id,
      code,
      placedAt: new Date(now).toISOString(),
      fulfilment,
      customerName: customer.value.customerName,
      customerPhone: customer.value.customerPhone,
      deliveryAddress: customer.value.deliveryAddress,
      deliveryPostcode: customer.value.deliveryPostcode,
      items: priced.lines,
      itemsTotalCents: priced.itemsTotalCents,
      deliveryFeeCents: priced.deliveryFeeCents,
      totalCents: priced.totalCents,
      personalDetailsClearedAt: null,
    }

    if (!stripeConfigured()) {
      const row = {
        ...base,
        status: STATUS_RECEIVED,
        queue: QUEUE_ACTIVE,
        paymentStatus: PAYMENT_AT_STORE,
        paymentRef: null,
        readyEstimate: readyEstimateAt(settings, fulfilment, now),
      }
      await db.Order.put(row)
      return json({ order: row, orderUrl: orderUrl(code), paymentUrl: null }, 201)
    }

    // The row exists BEFORE Stripe is ever called: a customer who never finishes paying still has
    // an order the owner's queue (and the webhook, once it arrives) can find by code.
    const pendingRow = {
      ...base,
      status: STATUS_AWAITING_PAYMENT,
      queue: QUEUE_PENDING,
      paymentStatus: PAYMENT_UNPAID,
      paymentRef: null,
      readyEstimate: null,
    }
    await db.Order.put(pendingRow)

    let session
    try {
      session = await createOrderCheckoutSession({
        lines: priced.lines,
        successUrl: orderUrl(code),
        cancelUrl: checkoutUrl(),
        metadata: { orderId: id, orderCode: code },
      }, { idempotencyKey: code })
    } catch (err) {
      // The order stays pending_payment, unpromoted — a retry or the webhook can still complete it.
      return stripeFailureResponse(err)
    }

    const row = { ...pendingRow, paymentRef: session.id }
    await db.Order.put(row)
    return json({ order: row, orderUrl: orderUrl(code), paymentUrl: session.url }, 201)
  }
}
