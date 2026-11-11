// SIGN-IN KIT (the baseline a generated app adapts) — tier quotas. The builder writes this file from the
// account tier and the Reviewer checks it against the spec. The tier itself arrives in
// CONFIG.env as IMMENSUS_TIER, written by the control plane at deploy time. Anything this
// file does not recognise — blank, a typo, a tier it predates — reads as `trial`, so a
// misconfiguration can only tighten a quota, never lift one.
//
// What each quota bounds, and where it is enforced today:
//   rowsPerOwner    rows one user may own in an owner-scoped table   getter only — each generated resource wires it
//   members         User rows the app may hold                        lib/auth.js claimUserForEmail — every sign-up: AuthApi
//                                                                     open sign-up and Google, AdminApi invite (never Bootstrap)
//   emailsPerDay    outbound sends per UTC day                        getter only — lib/email.js is FIXED
//   storageMb       blob bytes across the app                         getter only — the baseline has no blob table
//   loopMinMinutes  floor on a loop's everyMinutes                    getter only — resources/Scheduler.js is FIXED
// A getter without an enforcement site is a number the builder must wire, not a promise;
// plan-acceptance pins the one that is wired, the helpers a resource wires the others with, and the
// fail-closed default.

import { optional } from './config.js'

export const DEFAULT_TIER = 'trial'

export const TIERS = Object.freeze({
  trial: Object.freeze({ label: 'Free trial', rowsPerOwner: 500, members: 100, emailsPerDay: 100, storageMb: 256, loopMinMinutes: 60 }),
  tinkerer: Object.freeze({ label: 'Tinkerer', rowsPerOwner: 5000, members: 1000, emailsPerDay: 1000, storageMb: 2048, loopMinMinutes: 15 }),
  builder: Object.freeze({ label: 'Builder', rowsPerOwner: Infinity, members: Infinity, emailsPerDay: 10000, storageMb: 20480, loopMinMinutes: 5 }),
})

export const QUOTA_NAMES = Object.freeze(['rowsPerOwner', 'members', 'emailsPerDay', 'storageMb', 'loopMinMinutes'])

/**
 * The tier CONFIG.env names, or `trial` when it names nothing this file knows. An EXACT
 * match: no trimming, no case-folding. A writer that emits `Builder` or `builder ` has a bug,
 * and the safe place for that bug to show is a trial-sized quota, not a silently lifted one.
 */
export function currentTier () {
  const raw = optional('IMMENSUS_TIER', '')
  return Object.hasOwn(TIERS, raw) ? raw : DEFAULT_TIER
}

export function plan (tier = currentTier()) {
  return TIERS[tier] ?? TIERS[DEFAULT_TIER]
}

/** One quota by name. Throws on a name this file does not define — a typo must not read as "unlimited". */
export function quota (name, tier = currentTier()) {
  if (!QUOTA_NAMES.includes(name)) throw new Error(`lib/plan.js: no quota named "${name}"`)
  return plan(tier)[name]
}

/** May one more be added when `count` already exist? */
export function withinQuota (name, count, tier = currentTier()) {
  return Number(count) < quota(name, tier)
}

/**
 * The refusal every enforcement site returns: 403 with `code: 'quota_exceeded'` (never 401,
 * rule 20; not `auth_required`, so the client does not bounce to sign-in). `limit` is null
 * rather than Infinity because JSON has no Infinity.
 */
export function quotaResponse (name, tier = currentTier()) {
  const limit = quota(name, tier)
  return new Response(JSON.stringify({
    error: `This app's ${plan(tier).label} plan allows ${limit === Infinity ? 'unlimited' : limit} ${name}`,
    code: 'quota_exceeded',
    quota: name,
    limit: limit === Infinity ? null : limit,
    tier,
  }), { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

/**
 * Count rows matching `conditions`, reading at most `cap` of them. A count that stops at the
 * cap is the cap, and callers compare against a quota that is at most the cap, so the read is
 * bounded by the quota it serves. `conditions` must name @indexed attributes (rule 6).
 */
export async function countRows (table, conditions = [], cap = Infinity) {
  const query = { conditions }
  if (Number.isFinite(cap)) query.limit = cap
  let n = 0
  for await (const _ of table.search(query)) { n++; if (n >= cap) break }
  return n
}

/**
 * The first half of a quota check: are we already at the cap? An infinite cap answers false
 * WITHOUT reading — the count exists only to compare against the cap, and streaming every
 * row to compare it with Infinity is the O(rows) read this file bounds everywhere else, paid
 * on every write by exactly the tier with the most rows. A finite cap reads at most cap rows.
 */
export async function atQuota (table, conditions, cap) {
  if (!Number.isFinite(cap)) return false
  return (await countRows(table, conditions, cap)) >= cap
}

/**
 * The second half of a quota check. "Count, then write" is check-then-act: two writes racing
 * at cap − 1 both pass the count and both land. There is no single key to claim for a count,
 * so the write goes first and is then re-counted with room for one more; a caller that finds
 * the table over the cap deletes what it just wrote and refuses. At rest the table is never
 * over the cap; a race can refuse both writers, which a client retries. plan-acceptance races
 * two creates against this.
 */
export async function overQuotaAfterWrite (table, conditions, cap) {
  if (!Number.isFinite(cap)) return false
  return (await countRows(table, conditions, cap + 1)) > cap
}
