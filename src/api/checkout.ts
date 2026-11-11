// Guest checkout (resources/CheckoutApi.js). Public — there are no customer accounts. `quoteCart`
// writes nothing and is safe to call on every basket change; `placeOrder` re-prices the same way and
// then creates the order. Both throw (isApiError) on a 400 — an empty basket, a bad quantity, an
// item no longer on the menu, ordering paused, or an unusable postcode — so a caller always has
// `err.error` to show and sometimes `err.code` to act on (see lib/pricing.js, resources/CheckoutApi.js).

import { api } from './client'
import type { QuoteRequest, QuoteResponse, OrderRequest, OrderResponse } from './types'

export function quoteCart(body: QuoteRequest): Promise<QuoteResponse> {
  return api.post<QuoteResponse>('CheckoutApi/quote', body)
}

export function placeOrder(body: OrderRequest): Promise<OrderResponse> {
  return api.post<OrderResponse>('CheckoutApi/order', body)
}
