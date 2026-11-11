// THE BASKET ARRIVING FROM A BROWSER IS A REQUEST, NOT A PRICE.
//
// This module is the one place a cart becomes money, and `CheckoutApi` runs both of its endpoints —
// the quote the basket screen shows and the order it finally places — through exactly this function,
// so the number the customer is shown and the number the order is written with cannot disagree.
//
// Every line is re-read from `MenuItem` by id and priced from the row: the caller sends an id and a
// quantity and NOTHING else is believed. An unknown or unavailable item is a refusal rather than a
// line priced at zero. The delivery fee comes from `StoreSetting` (lib/shop.js), never from the body.

import { db } from './db.js'
import { postcodeAllowed } from './shop.js'
import { FULFILMENT_PICKUP, FULFILMENT_DELIVERY } from './orders.js'

export const MAX_LINES = 40
export const MAX_QUANTITY = 50

/** `pickup` unless the caller asked for delivery in as many words. */
export function normalizeFulfilment (value) {
  return String(value ?? '').trim().toLowerCase() === FULFILMENT_DELIVERY ? FULFILMENT_DELIVERY : FULFILMENT_PICKUP
}

/**
 * Price a cart against the menu and the shop's settings. Writes nothing and reads no session: the
 * customer is a guest.
 *
 * Returns `{ error, code }` when the cart itself cannot be priced — an empty cart, a bad quantity,
 * an item that is not on the menu — and otherwise the full quote:
 *
 *   { lines, itemsTotalCents, deliveryFeeCents, totalCents, fulfilment, estimateMinutes,
 *     deliveryAvailable, postcodeCovered }
 *
 * A postcode outside the delivery area is NOT an error here: the basket screen has to be able to say
 * "we do not deliver to you, collect instead", which it can only do if it is told. Refusing the
 * ORDER is `CheckoutApi`'s job, and it decides it from `postcodeCovered`.
 */
export async function priceCart ({ lines, fulfilment, deliveryPostcode, settings }) {
  const wanted = Array.isArray(lines) ? lines : []
  if (wanted.length === 0) return { error: 'your basket is empty', code: 'empty_basket' }
  if (wanted.length > MAX_LINES) return { error: `at most ${MAX_LINES} different items in one order`, code: 'too_many_lines' }

  const chosen = normalizeFulfilment(fulfilment)
  const priced = []
  let itemsTotalCents = 0

  for (const raw of wanted) {
    const menuItemId = String(raw?.menuItemId ?? '').trim()
    if (!menuItemId) return { error: 'a basket line has no item', code: 'bad_line' }
    const quantity = raw?.quantity
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      return { error: `quantity must be a whole number between 1 and ${MAX_QUANTITY}`, code: 'bad_quantity' }
    }
    const item = await db.MenuItem.get(menuItemId)
    // An item taken off the menu between the basket and the order is the common case here, and it
    // reads the same as an id that was never ours: the customer is told which line to drop.
    if (!item || item.available === false) {
      return { error: 'one of the items in your basket is no longer available', code: 'item_unavailable', menuItemId }
    }
    const priceCents = Number.isInteger(item.priceCents) ? item.priceCents : 0
    const lineTotalCents = priceCents * quantity
    itemsTotalCents += lineTotalCents
    // The snapshot the order stores: the name and the price AS THEY ARE NOW (lib/orders.js).
    priced.push({ menuItemId, name: item.name ?? '', priceCents, quantity, lineTotalCents })
  }

  const postcodeCovered = chosen === FULFILMENT_DELIVERY ? postcodeAllowed(settings, deliveryPostcode) : true
  const deliveryFeeCents = chosen === FULFILMENT_DELIVERY ? settings.deliveryFeeCents : 0
  const estimateMinutes = chosen === FULFILMENT_DELIVERY ? settings.deliveryEstimateMinutes : settings.pickupEstimateMinutes

  return {
    lines: priced,
    itemsTotalCents,
    deliveryFeeCents,
    totalCents: itemsTotalCents + deliveryFeeCents,
    fulfilment: chosen,
    estimateMinutes,
    deliveryAvailable: chosen === FULFILMENT_DELIVERY ? settings.deliveryEnabled === true : settings.pickupEnabled === true,
    postcodeCovered,
  }
}
