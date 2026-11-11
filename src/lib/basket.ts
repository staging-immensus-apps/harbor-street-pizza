// The basket — there are no customer accounts and no cart resource on the server (CLAUDE.md §1,
// guest checkout). It lives in this browser only, in localStorage, until Checkout turns it into one
// `CheckoutApi/order` call. Menu, Basket and Checkout all read and write it through this module so
// the three screens can never disagree about what is in it.
//
// `useBasket()` is `useSyncExternalStore` rather than a context, so no provider has to wrap the app
// for three pages to share one value, and a change in one tab (or one component) is seen by every
// other mounted instance through a window event — including the native `storage` event for a second
// tab. The in-memory `cache` is what `getSnapshot` returns, so repeated renders between dispatches
// see the identical array reference (useSyncExternalStore requires that or it loops).

import { useSyncExternalStore } from 'react'

const KEY = 'pizza-shop:basket:v1'
const EVENT = 'pizza-shop:basket-changed'

export type BasketLine = {
  menuItemId: string
  name: string
  priceCents: number
  quantity: number
}

function isLine(v: unknown): v is BasketLine {
  return !!v && typeof v === 'object' &&
    typeof (v as BasketLine).menuItemId === 'string' &&
    typeof (v as BasketLine).name === 'string' &&
    Number.isInteger((v as BasketLine).priceCents) &&
    Number.isInteger((v as BasketLine).quantity)
}

function readStorage(): BasketLine[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(isLine) : []
  } catch {
    return []
  }
}

let cache: BasketLine[] = readStorage()

function write(lines: BasketLine[]) {
  cache = lines
  try { localStorage.setItem(KEY, JSON.stringify(lines)) } catch { /* private mode or full — basket stays in memory for this tab */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT))
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

function getSnapshot(): BasketLine[] {
  return cache
}

function getServerSnapshot(): BasketLine[] {
  return []
}

/** The basket, live: re-renders the caller whenever a line is added, changed or cleared. */
export function useBasket(): BasketLine[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** Add one menu item, or increase its quantity if it is already in the basket. */
export function addToBasket(item: { id: string; name: string; priceCents: number }, quantity = 1): void {
  const lines = readStorage()
  const existing = lines.find((l) => l.menuItemId === item.id)
  if (existing) existing.quantity += quantity
  else lines.push({ menuItemId: item.id, name: item.name, priceCents: item.priceCents, quantity })
  write(lines)
}

/** Set a line's quantity; 0 or less removes it. */
export function setBasketQuantity(menuItemId: string, quantity: number): void {
  const lines = readStorage()
  const next = quantity > 0
    ? lines.map((l) => (l.menuItemId === menuItemId ? { ...l, quantity } : l))
    : lines.filter((l) => l.menuItemId !== menuItemId)
  write(next)
}

export function removeFromBasket(menuItemId: string): void {
  write(readStorage().filter((l) => l.menuItemId !== menuItemId))
}

/** Checkout calls this once an order has actually been placed — never before. */
export function clearBasket(): void {
  write([])
}

export function basketCount(lines: BasketLine[]): number {
  return lines.reduce((n, l) => n + l.quantity, 0)
}

export function basketTotalCents(lines: BasketLine[]): number {
  return lines.reduce((n, l) => n + l.priceCents * l.quantity, 0)
}
