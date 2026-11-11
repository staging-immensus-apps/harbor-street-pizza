// The owner's live order queue (resources/OrderAdminApi.js). Admin-only; the only place customer
// names, phone numbers and delivery addresses are listed. No POST or DELETE: CheckoutApi creates an
// order and it is never removed, only advanced.

import { api } from './client'
import type { OrderAdminListResponse, OrderAdminOneResponse, Queue, OrderStatus } from './types'

export function listOrders(queue: Queue = 'active'): Promise<OrderAdminListResponse> {
  return api.get<OrderAdminListResponse>(`OrderAdminApi?queue=${encodeURIComponent(queue)}`)
}

export function getOrderById(id: string): Promise<OrderAdminOneResponse> {
  return api.get<OrderAdminOneResponse>(`OrderAdminApi/${encodeURIComponent(id)}`)
}

export function setOrderStatus(id: string, status: OrderStatus): Promise<OrderAdminOneResponse> {
  return api.patch<OrderAdminOneResponse>(`OrderAdminApi/${encodeURIComponent(id)}`, { status })
}
