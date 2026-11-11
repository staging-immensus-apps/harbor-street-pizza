#!/usr/bin/env node
// THE TWELVE-MONTH RETENTION RULE, driven (lib/retention.js, lib/loops/index.js):
//
//   1. An order older than twelve months loses its name, phone and address and KEEPS its lines and
//      its totals. An order inside the window is not touched.
//   2. The sweep is claimed by a deterministic key, `clear-personal-details:YYYY-MM-DD`, so a second
//      tick on the same day does nothing — every worker of every node ticks the scheduler and the
//      timer is not a cluster lock.
//   3. It is idempotent anyway: a row that has already been cleared is skipped, so even a claim that
//      failed to hold cannot clear twice or clear the wrong thing.
//   4. The loop is registered on the scheduler's seam, which is the only automation surface this app
//      has — a loop that is not in LOOPS never runs.
//
// `now` is passed in explicitly everywhere, so this suite has the same verdict at any wall clock
// (run-suites re-runs it at two shifted instants).

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { freezeClock } from './probe/frozen-clock.js'
freezeClock()

const { checker } = await import('./probe/harness.js')
const { tables, resetTables } = await import('./probe/harperdb-stub.js')
const { RETENTION_LOOP, RETENTION_MONTHS, runIdFor, cutoffFor, sweepPersonalDetails, lastDetailsClearedAt } = await import('../lib/retention.js')
const { LOOPS } = await import('../lib/loops/index.js')
const { PERSONAL_FIELDS } = await import('../lib/orders.js')

const { check, section, done, failures } = checker('retention-probe')

const NOW = Date.parse('2026-11-11T02:00:00.000Z')
const OLD = '2025-01-04T18:00:00.000Z' // ~22 months back
const JUST_OLD = '2025-10-01T18:00:00.000Z' // ~13 months back
const RECENT = '2026-11-01T18:00:00.000Z'

/** Which of these orders still carry a person's details? The verdict this suite is built on. */
function stillPersonal (ids) {
  return ids.filter((id) => PERSONAL_FIELDS.some((f) => tables.Order.rows.get(id)?.[f] != null))
}

section('negative control: the verdict can say no')
resetTables()
await tables.Order.put({ id: 'probe', placedAt: OLD, customerName: 'Someone' })
check('a row with a name is reported as still personal', stillPersonal(['probe']).length === 1)
await tables.Order.put({ id: 'probe', placedAt: OLD, customerName: null })
check('…and a cleared row is not (NEG)', stillPersonal(['probe']).length === 0)
check('the cutoff really is twelve months back', cutoffFor(NOW).slice(0, 7) === '2025-11' && RETENTION_MONTHS === 12)
check('the claim key is the day', runIdFor(NOW) === `${RETENTION_LOOP}:2026-11-11`)
if (failures.length) process.exit(done())

section('the sweep clears the old and leaves the recent alone')
resetTables()
const LINES = [{ menuItemId: 'menu-margherita', name: 'Margherita', priceCents: 950, quantity: 2 }]
await tables.Order.put({ id: 'old-1', code: 'c1', placedAt: OLD, status: 'collected', queue: 'done', items: LINES, itemsTotalCents: 1900, totalCents: 1900, customerName: 'Ada', customerPhone: '07700 900111', deliveryAddress: '1 Lordship Lane', deliveryPostcode: 'N174AB' })
await tables.Order.put({ id: 'old-2', code: 'c2', placedAt: JUST_OLD, status: 'collected', queue: 'done', items: LINES, totalCents: 1900, customerName: 'Bea', customerPhone: '07700 900222' })
await tables.Order.put({ id: 'new-1', code: 'c3', placedAt: RECENT, status: 'ready', queue: 'active', items: LINES, totalCents: 1900, customerName: 'Cal', customerPhone: '07700 900333', deliveryAddress: '9 Broad Lane', deliveryPostcode: 'N159RT' })
check('PRECONDITION: all three carry a person', stillPersonal(['old-1', 'old-2', 'new-1']).length === 3)
{
  const result = await sweepPersonalDetails({ now: NOW, triggeredBy: 'suite' })
  check('the sweep reports ok and says how many it cleared', result.outcome === 'ok' && /cleared 2 order/.test(result.notes))
  check('both orders past twelve months lost every personal field', stillPersonal(['old-1', 'old-2']).length === 0)
  check('the order inside the window kept its details (NEG)', tables.Order.rows.get('new-1').customerName === 'Cal' && tables.Order.rows.get('new-1').deliveryPostcode === 'N159RT')
  const cleared = tables.Order.rows.get('old-1')
  check('the lines, the totals and the status survived — only the person went', JSON.stringify(cleared.items) === JSON.stringify(LINES) && cleared.itemsTotalCents === 1900 && cleared.totalCents === 1900 && cleared.status === 'collected' && cleared.code === 'c1')
  check('the cleared row is stamped', typeof cleared.personalDetailsClearedAt === 'string' && cleared.personalDetailsClearedAt.endsWith('Z'))
  check('the un-cleared row is NOT stamped (NEG)', tables.Order.rows.get('new-1').personalDetailsClearedAt == null)
}

section('one run per day, claimed by a deterministic key')
{
  const claim = tables.LoopRun.rows.get(runIdFor(NOW))
  check('the run is recorded under the day\'s id, finished', claim?.loop === RETENTION_LOOP && Boolean(claim.finishedAt) && claim.outcome === 'ok')
  check('exactly one LoopRun row exists for that day', [...tables.LoopRun.rows.keys()].filter((k) => k.startsWith(`${RETENTION_LOOP}:`)).length === 1)
  const stamp = tables.Order.rows.get('old-1').personalDetailsClearedAt
  const again = await sweepPersonalDetails({ now: NOW, triggeredBy: 'suite' })
  check('a second tick the same day does nothing and says so', again.outcome === 'skipped')
  check('…and wrote no second LoopRun row', [...tables.LoopRun.rows.keys()].filter((k) => k.startsWith(`${RETENTION_LOOP}:`)).length === 1)
  check('…and did not re-stamp an already cleared order', tables.Order.rows.get('old-1').personalDetailsClearedAt === stamp)
  const tomorrow = await sweepPersonalDetails({ now: NOW + 24 * 60 * 60 * 1000, triggeredBy: 'suite' })
  check('the NEXT day claims its own key and runs (NEG: the skip is the claim, not a latch)', tomorrow.outcome === 'ok' && tables.LoopRun.rows.has(`${RETENTION_LOOP}:2026-11-12`))
  check('…and had nothing left to clear', /cleared 0 order/.test(tomorrow.notes))
}

section('an order written before the column existed is still swept (absent is not null)')
{
  resetTables()
  // No `personalDetailsClearedAt` key at all — the shape a row written by an older build has, and
  // the one a `value: null` search condition would silently skip.
  await tables.Order.put({ id: 'legacy', placedAt: OLD, items: LINES, customerName: 'Dee', customerPhone: '07700 900444' })
  check('PRECONDITION: the column is absent, not null', !('personalDetailsClearedAt' in tables.Order.rows.get('legacy')))
  await sweepPersonalDetails({ now: NOW, triggeredBy: 'suite' })
  check('it was cleared anyway', stillPersonal(['legacy']).length === 0)
}

section('the owner is shown the last FINISHED run')
{
  resetTables()
  check('with no run at all, there is no date (NEG)', (await lastDetailsClearedAt()) === null)
  await tables.LoopRun.put({ id: `${RETENTION_LOOP}:2026-11-09`, loop: RETENTION_LOOP, startedAt: '2026-11-09T02:00:00.000Z', finishedAt: '2026-11-09T02:00:01.000Z', outcome: 'ok' })
  await tables.LoopRun.put({ id: `${RETENTION_LOOP}:2026-11-10`, loop: RETENTION_LOOP, startedAt: '2026-11-10T02:00:00.000Z', finishedAt: '2026-11-10T02:00:01.000Z', outcome: 'ok' })
  await tables.LoopRun.put({ id: `${RETENTION_LOOP}:2026-11-11`, loop: RETENTION_LOOP, startedAt: '2026-11-11T02:00:00.000Z', finishedAt: null, outcome: 'running' })
  await tables.LoopRun.put({ id: 'some-other-loop:2026-11-11', loop: 'some-other-loop', startedAt: '2026-11-11T03:00:00.000Z', finishedAt: '2026-11-11T03:00:01.000Z', outcome: 'ok' })
  check('the newest FINISHED run of THIS loop wins', (await lastDetailsClearedAt()) === '2026-11-10T02:00:01.000Z')
  check('a run still in flight is not a date to show (NEG)', (await lastDetailsClearedAt()) !== '2026-11-11T02:00:00.000Z')
}

section('the loop is on the scheduler\'s seam')
{
  const loop = LOOPS.find((l) => l.name === RETENTION_LOOP)
  check('LOOPS registers the retention sweep', Boolean(loop) && typeof loop.run === 'function')
  check('it is due at least once a day', Number(loop.everyMinutes) > 0 && Number(loop.everyMinutes) <= 24 * 60)
  check('the whole app has exactly one automation (NEG: a second one here would be unaccounted for)', LOOPS.length === 1)
  resetTables()
  await tables.Order.put({ id: 'via-loop', placedAt: OLD, items: LINES, customerName: 'Eve' })
  const out = await loop.run({ now: NOW, triggeredBy: 'suite' })
  check('running it through the seam clears the same row and returns the scheduler\'s shape', out.outcome === 'ok' && typeof out.notes === 'string' && stillPersonal(['via-loop']).length === 0)
}

process.exit(done())
