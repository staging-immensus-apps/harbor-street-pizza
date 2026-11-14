// A signed-in customer's own past orders (resources/CustomerOrderApi.js). Owner-scoped: the
// session decides whose orders come back, never a parameter here — there is no id to pass and
// no admin branch. Shared by Checkout (prefilling name/phone/address from the most recent order)
// and MyOrders (the full list), which is why it lives here rather than beside either page.
//
// Calling this while signed out throws a 403 auth_required, which the client redirects on
// globally (rule 5) — so a caller must check `me.authenticated` first rather than call this
// speculatively from a page a guest can reach.

import { api } from './client'
import type { CustomerOrderListResponse } from './types'

export function listMyOrders(): Promise<CustomerOrderListResponse> {
  return api.get<CustomerOrderListResponse>('CustomerOrderApi')
}
