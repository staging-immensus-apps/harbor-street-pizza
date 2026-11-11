// The shapes the app's own resources answer with. Types only: pages import values
// from '@/api/client' alone, which page-boot-acceptance stubs — a value exported from here would not
// be stubbed, and a type costs nothing at runtime.
//
// The template core has no resources that answer anything but the build stamp, so this file starts
// empty. A kit the platform copies in brings its own types beside it (the sign-in kit's are
// src/api/sign-in.ts). What follows is this app's own: MenuApi/MenuAdminApi, StoreInfoApi/
// StoreSettingsApi, CheckoutApi, OrderConfirmationApi and OrderAdminApi (api-plan.json).

export type Fulfilment = 'pickup' | 'delivery'

// ---- MenuApi / MenuAdminApi (lib/menu.js) --------------------------------------------------

export type MenuItem = {
  id: string
  name: string
  description: string | null
  priceCents: number
  category: string
}

export type MenuItemAdmin = MenuItem & {
  available: boolean
  sortOrder: number
  createdAt: string | null
  updatedAt: string | null
}

export type MenuCategory = { category: string; items: MenuItem[] }

/** GET /MenuApi — always 200, even with an empty menu. */
export type MenuResponse = {
  categories: MenuCategory[]
  items: MenuItem[]
  acceptingOrders: boolean
  storeName: string
}

/** The body POST/PATCH /MenuAdminApi accepts; every field optional on PATCH. */
export type MenuItemWrite = {
  name: string
  description?: string
  priceCents: number
  category?: string
  available?: boolean
  sortOrder?: number
}

export type MenuAdminListResponse = { items: MenuItemAdmin[] }
export type MenuAdminItemResponse = { item: MenuItemAdmin }

// ---- StoreInfoApi / StoreSettingsApi (lib/shop.js) -----------------------------------------

export type StoreInfo = {
  storeName: string
  acceptingOrders: boolean
  pausedMessage: string | null
  pickupEnabled: boolean
  deliveryEnabled: boolean
  deliveryFeeCents: number
  deliveryPostcodes: string[]
  pickupEstimateMinutes: number
  deliveryEstimateMinutes: number
}

export type StoreInfoResponse = { store: StoreInfo }

/** GET/PUT /StoreSettingsApi — the same facts as StoreInfo, plus the admin-only fields. */
export type StoreSettings = StoreInfo & { saved: boolean; updatedAt: string | null }

export type StoreSettingsResponse = { settings: StoreSettings; lastDetailsClearedAt: string | null }

/** The body PUT /StoreSettingsApi accepts; every field optional, defaults fill the rest. */
export type StoreSettingsWrite = {
  storeName?: string
  acceptingOrders?: boolean
  pausedMessage?: string
  pickupEnabled?: boolean
  deliveryEnabled?: boolean
  deliveryFeeCents?: number
  deliveryPostcodes?: string[]
  pickupEstimateMinutes?: number
  deliveryEstimateMinutes?: number
}

// ---- CheckoutApi (lib/pricing.js, lib/orders.js) ---------------------------------------------

/** A basket line as the browser sends it — the price is never trusted, only the id and quantity. */
export type CartLine = { menuItemId: string; quantity: number }

export type QuoteRequest = {
  lines: CartLine[]
  fulfilment: Fulfilment
  deliveryPostcode?: string
}

/** A priced line, snapshotted from MenuItem at the moment of pricing. */
export type PricedLine = {
  menuItemId: string
  name: string
  priceCents: number
  quantity: number
  lineTotalCents: number
}

/** POST /CheckoutApi/quote — writes nothing; a 400 (empty basket, bad quantity, item gone) throws. */
export type QuoteResponse = {
  lines: PricedLine[]
  itemsTotalCents: number
  deliveryFeeCents: number
  totalCents: number
  fulfilment: Fulfilment
  estimateMinutes: number
  deliveryAvailable: boolean
  postcodeCovered: boolean
  acceptingOrders: boolean
  pausedMessage: string | null
}

export type OrderRequest = QuoteRequest & {
  customerName: string
  customerPhone: string
  deliveryAddress?: string
}

/** The order row POST /CheckoutApi/order writes, as it answers it — not filtered the way the public
 * confirmation view is, because this is the one response the customer's own browser just produced it with. */
export type OrderRow = {
  id: string
  code: string
  placedAt: string
  status: string
  queue: string
  fulfilment: Fulfilment
  customerName: string
  customerPhone: string
  deliveryAddress: string | null
  deliveryPostcode: string | null
  items: PricedLine[]
  itemsTotalCents: number
  deliveryFeeCents: number
  totalCents: number
  paymentStatus: string
  paymentRef: string | null
  readyEstimate: string | null
  personalDetailsClearedAt: string | null
}

/** paymentUrl is set only once a Stripe key is configured; otherwise the order is already placed. */
export type OrderResponse = { order: OrderRow; orderUrl: string; paymentUrl: string | null }

// ---- OrderConfirmationApi (lib/orders.js publicOrderView) ----------------------------------

export type OrderConfirmationView = {
  code: string
  placedAt: string | null
  status: string | null
  fulfilment: Fulfilment | null
  items: PricedLine[]
  itemsTotalCents: number
  deliveryFeeCents: number
  totalCents: number
  paymentStatus: string | null
  readyEstimate: string | null
  customerName: string | null
  deliveryAddress: string | null
  deliveryPostcode: string | null
  personalDetailsCleared: boolean
}

export type OrderConfirmationResponse = { order: OrderConfirmationView }

// ---- OrderAdminApi (lib/orders.js adminOrderView) ------------------------------------------

export type Queue = 'pending_payment' | 'active' | 'done'
export type OrderStatus = 'awaiting_payment' | 'received' | 'preparing' | 'ready' | 'collected' | 'cancelled'

export type AdminOrder = {
  id: string
  code: string
  placedAt: string | null
  status: OrderStatus | null
  queue: Queue | null
  fulfilment: Fulfilment | null
  customerName: string | null
  customerPhone: string | null
  deliveryAddress: string | null
  deliveryPostcode: string | null
  items: PricedLine[]
  itemsTotalCents: number
  deliveryFeeCents: number
  totalCents: number
  paymentStatus: string | null
  paymentRef: string | null
  readyEstimate: string | null
  personalDetailsClearedAt: string | null
  /** The one tap this order's screen offers next — received→preparing→ready→collected — or null. */
  nextStatus: OrderStatus | null
  updatedAt: string | null
}

export type OrderAdminListResponse = {
  orders: AdminOrder[]
  queue: Queue
  counts: Record<Queue, number>
}

export type OrderAdminOneResponse = { order: AdminOrder }
