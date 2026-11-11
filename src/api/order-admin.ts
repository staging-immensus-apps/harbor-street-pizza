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
 * The order's id travels in the body and the path names an action. UNRESOLVED, and NOT a measured
 * rule: this shape was adopted on the theory that Harper refuses a write aimed at a record path,
 * and QA on this build falsified it — `POST /OrderAdminApi/status` has no record segment and still
 * answered 400 on two separate orders. An earlier round had already discarded "the verb is the
 * variable" (PATCH→PUT changed nothing). The cause is NOT KNOWN; CLAUDE.md §7 "OPEN QUESTION"
 * records the evidence still missing. Do not reshape this call again before one raw failing
 * response and its server log line have been captured.
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
