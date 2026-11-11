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

/**
 * THE ORDER'S ID TRAVELS IN THE BODY, NOT IN THE PATH. `PUT /OrderAdminApi/<id>` answered 400 on the
 * live /preview deployment for every action — Mark preparing, Mark ready, Cancel — across distinct
 * orders, and so did PATCH before it. The verb was never the variable: the refusal is Harper's REST
 * layer declining a write aimed at a RECORD PATH on a custom Resource, which is why swapping PATCH
 * for PUT changed nothing and why `PUT /StoreSettingsApi` (no record segment) was 200 throughout.
 * The page showed the bare statusText "Bad Request", which `errorText()` reaches only when the body
 * has no `error` key — so our handler, whose every 400 names the allowed statuses, never ran.
 *
 * `POST /OrderAdminApi/status` is the shape proven live here (`POST /CheckoutApi/order`,
 * `POST /AuthApi/request-link`). The signature is unchanged, so src/pages/admin/Orders.tsx is not
 * touched; the resource keeps put() and patch() at `/<id>` for anything that still reaches them.
 */
export function setOrderStatus(id: string, status: OrderStatus): Promise<OrderAdminOneResponse> {
  return api.post<OrderAdminOneResponse>('OrderAdminApi/status', { id, status })
}

/** The URL an `EventSource` opens for the live queue — the same path as the list, which answers the
 * stream instead when asked with `Accept: text/event-stream`. Built from `BASE` so the preview copy
 * subscribes to its own copy's resource (rule 30). The stream is an ACCELERATOR, never the source of
 * truth: whatever it delivers, the page re-reads the list (see src/pages/admin/Orders.tsx). */
export function ordersStreamUrl(queue: Queue = 'active'): string {
  return `${BASE}/OrderAdminApi?queue=${encodeURIComponent(queue)}`
}
