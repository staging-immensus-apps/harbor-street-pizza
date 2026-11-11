// The confirmation page's only data source (resources/OrderConfirmationApi.js). Public, but reached
// only by the order's own random code — an unknown code is a 404, never a list.

import { api } from './client'
import type { OrderConfirmationResponse } from './types'

export function getOrderByCode(code: string): Promise<OrderConfirmationResponse> {
  return api.get<OrderConfirmationResponse>(`OrderConfirmationApi/${encodeURIComponent(code)}`)
}
