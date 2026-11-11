// The owner's live order queue (resources/OrderAdminApi.js). Admin-only; the only place customer
// names, phone numbers and delivery addresses are listed. No POST or DELETE: CheckoutApi creates an
// order and it is never removed, only advanced.

import { api, BASE } from './client'
import type { OrderAdminListResponse, OrderAdminOneResponse, Queue, OrderStatus } from './types'

export function listOrders(queue: Queue = 'active'): Promise<OrderAdminListResponse> {
  return api.get<OrderAdminListResponse>(`OrderAdminApi?queue=${encodeURIComponent(queue)}`)
}

export function getOrderById(id: string): Promise<OrderAdminOneResponse> {
  return api.get<OrderAdminOneResponse>(`OrderAdminApi/${encodeURIComponent(id)}`)
}

/** PUT, not PATCH: resources/OrderAdminApi.js records that Harper's REST layer answered PATCH with a
 * 400 before the resource's own handler ran (measured on a real cluster), and PUT is the update verb
 * every reviewed resource in this platform uses. The resource keeps patch() as an alias. */
export function setOrderStatus(id: string, status: OrderStatus): Promise<OrderAdminOneResponse> {
  return api.put<OrderAdminOneResponse>(`OrderAdminApi/${encodeURIComponent(id)}`, { status })
}

/** The URL an `EventSource` opens for the live queue — the same path as the list, which answers the
 * stream instead when asked with `Accept: text/event-stream`. Built from `BASE` so the preview copy
 * subscribes to its own copy's resource (rule 30). The stream is an ACCELERATOR, never the source of
 * truth: whatever it delivers, the page re-reads the list (see src/pages/admin/Orders.tsx). */
export function ordersStreamUrl(queue: Queue = 'active'): string {
  return `${BASE}/OrderAdminApi?queue=${encodeURIComponent(queue)}`
}
