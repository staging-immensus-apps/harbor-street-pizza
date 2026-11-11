// TWELVE-MONTH RETENTION: an order keeps its lines and its totals for good, and loses the person
// twelve months after it was placed (CLAUDE.md §1, §8).
//
// Run by the scheduler through lib/loops/index.js, and read by StoreSettingsApi so the owner's
// settings screen can say when it last happened. Both go through this file: the sweep and the date
// the owner is shown must be two readings of one thing.
//
// EXACTLY ONCE PER DAY, BY A KEY AND NOT BY A TIMER. Every worker of every node ticks the scheduler,
// so the timer is not a cluster lock and nothing on Harper makes a scheduled job exactly-once. The
// run is therefore claimed on a LoopRun row with the deterministic id
// `clear-personal-details:YYYY-MM-DD`: a second tick on the same day finds the finished row and does
// nothing. The claim is best-effort rather than atomic — `create()` is a sequential guard, not an
// arbiter (resources/StripeWebhook.js's header carries the measurement) — which is why the sweep
// itself is idempotent as well: it only ever clears fields that are already null-safe and it skips
// every row whose `personalDetailsClearedAt` is already set, so a second run has nothing to do.

import os from 'node:os'
import { db } from './db.js'
import { PERSONAL_FIELDS } from './orders.js'

export const RETENTION_LOOP = 'clear-personal-details'
export const RETENTION_MONTHS = 12
/** One sweep touches at most this many orders; the next run takes the rest. */
export const SWEEP_LIMIT = 500

/** The run id for a day — the claim key, and the reason a repeated tick is harmless. */
export function runIdFor (now = Date.now()) {
  return `${RETENTION_LOOP}:${new Date(now).toISOString().slice(0, 10)}`
}

/** Orders placed before this instant have lost their twelve months. */
export function cutoffFor (now = Date.now()) {
  const d = new Date(now)
  d.setUTCMonth(d.getUTCMonth() - RETENTION_MONTHS)
  return d.toISOString()
}

/**
 * Clear the personal details of every order older than the cutoff. Returns the scheduler's
 * `{ outcome, notes }`.
 *
 * `placedAt` is an indexed ISO string, so the cutoff is a one-sided range on an index rather than a
 * table scan. `personalDetailsClearedAt == null` is filtered IN JS and not as a condition, because a
 * row written before that column existed has no value for it at all, and "absent" is not "equal to
 * null" — a condition would silently skip exactly the oldest rows, which are the ones this sweep is
 * for.
 */
export async function sweepPersonalDetails ({ now = Date.now(), triggeredBy = 'schedule' } = {}) {
  const id = runIdFor(now)
  const claimed = await db.LoopRun.get(id)
  if (claimed?.finishedAt) return { outcome: 'skipped', notes: `${id} already ran on this cluster` }

  const startedAt = new Date(now).toISOString()
  await db.LoopRun.put({ id, loop: RETENTION_LOOP, startedAt, finishedAt: null, outcome: 'running', notes: null, triggeredBy, node: os.hostname() })

  const cutoff = cutoffFor(now)
  const stale = []
  for await (const row of db.Order.search({ conditions: [{ attribute: 'placedAt', comparator: 'less_than', value: cutoff }], limit: SWEEP_LIMIT })) {
    if (!row.personalDetailsClearedAt) stale.push(row)
  }

  let cleared = 0
  for (const row of stale) {
    const next = { ...row, personalDetailsClearedAt: startedAt }
    for (const field of PERSONAL_FIELDS) next[field] = null
    await db.Order.put(next)
    cleared++
  }

  const notes = `cleared ${cleared} order(s) placed before ${cutoff}`
  await db.LoopRun.put({ id, loop: RETENTION_LOOP, startedAt, finishedAt: new Date().toISOString(), outcome: 'ok', notes, triggeredBy, node: os.hostname() })
  return { outcome: 'ok', notes }
}

/**
 * When customer details were last cleared, as an ISO instant, or null if the sweep has never
 * finished a run. Read-only: nothing but the sweep writes `LoopRun` for this loop.
 *
 * The newest FINISHED row wins. A row still marked `running` is a run in flight or a worker that
 * died mid-sweep, and neither is a date to show the owner.
 */
export async function lastDetailsClearedAt () {
  let newest = null
  for await (const row of db.LoopRun.search({ conditions: [{ attribute: 'loop', value: RETENTION_LOOP }] })) {
    if (!row.finishedAt || row.outcome === 'threw') continue
    if (!newest || String(row.finishedAt) > String(newest)) newest = row.finishedAt
  }
  return newest
}
