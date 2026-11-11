// The menu, shared by the public reader (MenuApi) and the owner's editor (MenuAdminApi), so that an
// item is validated once and ordered the same way on both screens.
//
// Money is whole cents everywhere, never a float: `priceCents` is an `Int` in the schema and a
// price that arrives as 12.5 is a rejected body, not a rounding decision made here.

export const NAME_MAX = 120
export const DESCRIPTION_MAX = 500
export const CATEGORY_MAX = 60
export const PRICE_MAX_CENTS = 1000000

/** Uncategorised items sort last under one visible heading rather than under an empty one. */
export const DEFAULT_CATEGORY = 'Other'

/**
 * The menu's order: category, then the owner's `sortOrder`, then name — all three, because
 * `sortOrder` is the owner's handle and two items sharing one must still come out in a stable order
 * rather than in whatever order the index happened to yield.
 */
export function sortMenu (items) {
  return [...items].sort((a, b) =>
    String(a.category ?? '').localeCompare(String(b.category ?? '')) ||
    (numberOr(a.sortOrder, 0) - numberOr(b.sortOrder, 0)) ||
    String(a.name ?? '').localeCompare(String(b.name ?? '')))
}

/** What a customer sees. Never `available` — an unavailable item is simply not on the menu. */
export function publicMenuItem (row) {
  return {
    id: row.id,
    name: row.name ?? '',
    description: row.description ?? null,
    priceCents: numberOr(row.priceCents, 0),
    category: categoryOf(row),
  }
}

/** What the owner sees: the same item plus the fields only the editor needs. */
export function adminMenuItem (row) {
  return {
    ...publicMenuItem(row),
    available: row.available !== false,
    sortOrder: numberOr(row.sortOrder, 0),
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  }
}

/**
 * The public menu's shape: categories in sorted order, each with its items.
 *
 * Grouped on the server because every page that shows the menu groups it the same way, and a client
 * that regrouped it would be a second opinion about what a category is.
 */
export function groupByCategory (items) {
  const groups = []
  const index = new Map()
  for (const item of items) {
    const category = item.category ?? DEFAULT_CATEGORY
    if (!index.has(category)) {
      index.set(category, { category, items: [] })
      groups.push(index.get(category))
    }
    index.get(category).items.push(item)
  }
  return groups
}

/**
 * The writable fields of a menu item. `{ error }` or `{ value }`; unknown keys are dropped, so a
 * body cannot set `id`, `createdAt` or anything else the resource owns.
 *
 * `partial` is the PATCH case: only the keys present are read, and the rest of the row is left as it
 * is. A price is a whole number of cents, 0 or more — a float, a string or a negative is a 400,
 * because every other reading of "£12.50" is a guess about what the owner meant.
 */
export function validateMenuItem (body, { partial } = { partial: false }) {
  const b = body && typeof body === 'object' ? body : {}
  const value = {}

  if ('name' in b || !partial) {
    const name = String(b.name ?? '').trim()
    if (!name) return { error: 'name is required' }
    if (name.length > NAME_MAX) return { error: `name must be at most ${NAME_MAX} characters` }
    value.name = name
  }
  if ('description' in b || !partial) {
    const description = String(b.description ?? '').trim()
    if (description.length > DESCRIPTION_MAX) return { error: `description must be at most ${DESCRIPTION_MAX} characters` }
    value.description = description || null
  }
  if ('priceCents' in b || !partial) {
    const price = b.priceCents
    if (!Number.isInteger(price) || price < 0) return { error: 'priceCents must be a whole number of cents, 0 or more' }
    if (price > PRICE_MAX_CENTS) return { error: 'priceCents is implausibly large' }
    value.priceCents = price
  }
  if ('category' in b || !partial) {
    const category = String(b.category ?? '').trim()
    if (category.length > CATEGORY_MAX) return { error: `category must be at most ${CATEGORY_MAX} characters` }
    value.category = category || DEFAULT_CATEGORY
  }
  if ('available' in b || !partial) {
    if ('available' in b && typeof b.available !== 'boolean') return { error: 'available must be true or false' }
    value.available = 'available' in b ? b.available : true
  }
  if ('sortOrder' in b || !partial) {
    const order = 'sortOrder' in b ? b.sortOrder : 0
    if (!Number.isInteger(order) || order < 0 || order > 100000) return { error: 'sortOrder must be a whole number between 0 and 100000' }
    value.sortOrder = order
  }
  return { value }
}

function categoryOf (row) {
  const c = typeof row.category === 'string' ? row.category.trim() : ''
  return c || DEFAULT_CATEGORY
}

function numberOr (value, fallback) {
  return Number.isFinite(value) ? value : fallback
}
