/** ISO timestamp → YYYY-MM-DD, or a dash. Every list shows dates this way. */
export function day(iso: string | null | undefined): string {
  return iso ? String(iso).slice(0, 10) : '—'
}

/** ISO timestamp → a date a person reads, in their own locale ("Nov 5, 2026"), or a dash. */
export function shortDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
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

/** A minutes estimate read back as "25–45 min" or "around 25 min" when there is one number. */
export function minutesEstimate(minutes: number | null | undefined): string {
  return Number.isFinite(minutes) ? `around ${minutes} min` : '—'
}
