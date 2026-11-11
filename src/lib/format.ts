/**
 * A timestamp → YYYY-MM-DD, or a dash. Every list shows dates this way.
 *
 * Takes a number as well as a string: a Harper-assigned @createdTime/@updatedTime field (MenuItem,
 * Order) reads back as epoch milliseconds, while a row written before a fix stopped naming the
 * field by hand may still hold the old ISO string — both are real and both must render.
 */
export function day(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const when = new Date(value)
  if (Number.isNaN(when.getTime())) return '—'
  return when.toISOString().slice(0, 10)
}

/** A timestamp → a date a person reads, in their own locale ("Nov 5, 2026"), or a dash. Accepts an
 * epoch-millisecond number or an ISO string, for the same reason as day() above. */
export function shortDate(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const when = new Date(value)
  if (Number.isNaN(when.getTime())) return '—'
  return when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The error string the API client throws with, or a fallback. */
export function errorText(err: unknown, fallback = 'Something went wrong'): string {
  if (typeof err === 'object' && err !== null && 'error' in err && typeof (err as { error: unknown }).error === 'string') return (err as { error: string }).error
  return fallback
}

/** Whole cents, as the money every price on this app is stored in (never a float) — "£12.50". */
export function money(cents: number | null | undefined): string {
  const value = Number.isFinite(cents) ? (cents as number) : 0
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(value / 100)
}

/**
 * What one order line costs, in whole cents.
 *
 * The extended total is only on a line that came back from a quote; the snapshot stored on an order
 * is `{menuItemId, name, priceCents, quantity}` (CLAUDE.md §8), so price × quantity is the answer
 * for every other line. Reading `lineTotalCents` raw showed every seeded order's lines as £0.00.
 */
export function lineTotal(line: { priceCents?: number | null; quantity?: number | null; lineTotalCents?: number | null } | null | undefined): number {
  if (Number.isFinite(line?.lineTotalCents)) return line?.lineTotalCents as number
  const price = Number.isFinite(line?.priceCents) ? (line?.priceCents as number) : 0
  const quantity = Number.isFinite(line?.quantity) ? (line?.quantity as number) : 0
  return price * quantity
}

/**
 * A ready-by instant as a person reads it — "7:45 pm" for today, "Nov 12, 7:45 pm" otherwise.
 *
 * Every order here is ASAP (CLAUDE.md §1), so the useful part of the estimate is the TIME OF DAY;
 * a bare calendar date tells a customer waiting twenty-five minutes nothing at all.
 */
export function readyTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return '—'
  const clock = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const today = new Date()
  const sameDay = when.getFullYear() === today.getFullYear() && when.getMonth() === today.getMonth() && when.getDate() === today.getDate()
  if (sameDay) return clock
  return `${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${clock}`
}

/** A minutes estimate read back as "25–45 min" or "around 25 min" when there is one number. */
export function minutesEstimate(minutes: number | null | undefined): string {
  return Number.isFinite(minutes) ? `around ${minutes} min` : '—'
}
