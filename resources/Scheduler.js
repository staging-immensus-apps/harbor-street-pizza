// FIXED — the module-scope interval host (rule 17).
//
// Schedulers live HERE, in the jsResource context, and nowhere else. A scheduler written as
// a Fastify plugin never ran once: fastifyRoutes modules cannot import
// harperdb, so every tick's lazy load failed silently. Resource modules execute their body
// at component startup and harperdb imports work, so the interval is armed at module scope
// below, `globalThis`-guarded against a re-evaluation, with the first tick delayed so a
// rolling restart settles before anything runs.
//
// What runs is GENERATED: the builder writes `lib/loops/index.js` exporting
//   export const LOOPS = [{ name, everyMinutes, run: async ({ now, triggeredBy }) => ({ outcome, notes }) }]
// Each loop is due when `everyMinutes` have passed since its last run ON THIS WORKER, and
// every run writes a LoopRun row. EVERY worker on every node ticks — a loop that must run
// exactly once per period (anything that posts publicly, emails, or spends) claims its run
// on a table row first; the template does not pretend a per-process timer is a cluster lock.
//
// IT SERVES NO ENDPOINT. The template core knows nothing about accounts, so it
// has no administrator to show a status to; `schedulerStatus()` is exported for whatever does — the
// sign-in kit's AdminApi answers it at GET /AdminApi/scheduler, admin-only. Like resources/Pages.js,
// this module EXPORTS NO RESOURCE: `jsResource` loads it for its side effect, the armed interval.

import { db } from '../lib/db.js'
import crypto from 'node:crypto'
import os from 'node:os'
import { copyBase, isPreviewCopy } from '../lib/copy.js'

export const TICK_MINUTES = 5
export const FIRST_TICK_DELAY_MS = 5 * 60 * 1000

const state = {
  startedAt: new Date().toISOString(),
  lastTickAt: null,
  lastTickSummary: null,
  ticksCompleted: 0,
  loops: {},
}

let loopsModule
async function loadLoops () {
  if (loopsModule !== undefined) return loopsModule
  try {
    const mod = await import('../lib/loops/index.js')
    loopsModule = Array.isArray(mod.LOOPS) ? mod.LOOPS : []
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') console.error('[scheduler] lib/loops/index.js failed to load:', err?.message ?? err)
    loopsModule = []
  }
  return loopsModule
}

/**
 * One pass over every loop. Exported so a probe can run exactly one tick under
 * freezeClock() with an injected loop list; production passes nothing.
 */
export async function tick ({ now = Date.now(), triggeredBy = 'schedule', loops = null } = {}) {
  const list = loops ?? await loadLoops()
  const lines = []
  for (const loop of list) {
    const name = String(loop?.name ?? 'unnamed')
    const every = Number(loop?.everyMinutes) > 0 ? Number(loop.everyMinutes) : TICK_MINUTES
    const entry = state.loops[name] ??= { lastRunAt: null, lastOutcome: null, runs: 0 }
    if (entry.lastRunAt && now - entry.lastRunAt < every * 60 * 1000 - 1000) continue
    const startedAt = new Date(now).toISOString()
    let outcome = 'ok'
    let notes = null
    try {
      const result = await loop.run({ now, triggeredBy })
      if (result && typeof result === 'object') {
        if (typeof result.outcome === 'string') outcome = result.outcome
        if (result.notes != null) notes = String(result.notes).slice(0, 2000)
      }
    } catch (err) {
      outcome = 'threw'
      notes = String(err?.message ?? err).slice(0, 2000)
      console.error(`[scheduler] ${name} threw:`, err?.stack ?? err)
    }
    entry.lastRunAt = now
    entry.lastOutcome = outcome
    entry.runs++
    try {
      await db.LoopRun.put({ id: crypto.randomUUID(), loop: name, startedAt, finishedAt: new Date().toISOString(), outcome, notes, triggeredBy, node: os.hostname() })
    } catch (err) {
      console.warn(`[scheduler] could not write LoopRun for ${name}:`, err?.message ?? err)
    }
    lines.push(`${name}: ${outcome}${notes ? ' — ' + notes : ''}`)
  }
  state.lastTickAt = new Date().toISOString()
  state.lastTickSummary = lines.length ? lines.join(' | ') : 'no loops due'
  state.ticksCompleted++
  return lines
}

// THE PREVIEW COPY RUNS NO SCHEDULED JOBS,
// and it returns BEFORE touching the guard below. Both copies of this app run in one `globalThis` per
// worker thread (Harper's default `vm-current-context` loader), so a preview copy that set the guard
// first would stop the PUBLISHED app's scheduler — measured four restarts in eight.
// Checking first and setting nothing is what keeps the published copy's loops running on every
// restart with a preview beside it.
export const SCHEDULER_RUNS = !isPreviewCopy()

// ONE GUARD PER MOUNT, because a sharing app's published copy runs in the same process as the app at the
// root of its cluster and is not a preview, so it arms a scheduler too. Under one
// shared name, whichever app loaded second would find the guard set and never run its loops, on every
// restart. The root keeps the name it always had, so nothing that reads it there changes.
export const SCHEDULER_GUARD = `__immensusSchedulerStarted${copyBase()}`

// `.unref()` on both timers: a probe that imports this file must be able to exit; Harper's
// process is kept alive by its servers, not by us.
if (SCHEDULER_RUNS && !globalThis[SCHEDULER_GUARD]) {
  globalThis[SCHEDULER_GUARD] = true
  const first = setTimeout(() => {
    tick().catch((err) => console.error('[scheduler] tick failed:', err?.message ?? err))
    const every = setInterval(() => tick().catch((err) => console.error('[scheduler] tick failed:', err?.message ?? err)), TICK_MINUTES * 60 * 1000)
    every.unref?.()
  }, FIRST_TICK_DELAY_MS)
  first.unref?.()
  console.log(`[scheduler] armed — first tick in ${FIRST_TICK_DELAY_MS / 60000}min, then every ${TICK_MINUTES}min`)
}

/** The scheduler's state on this worker, for an admin page: armed or not, what is registered, and each loop's last run. */
export async function schedulerStatus () {
  const loops = await loadLoops()
  return {
    armed: SCHEDULER_RUNS && !!globalThis[SCHEDULER_GUARD],
    previewCopy: !SCHEDULER_RUNS,
    tickMinutes: TICK_MINUTES,
    firstTickDelayMinutes: FIRST_TICK_DELAY_MS / 60000,
    node: os.hostname(),
    registered: loops.map((l) => ({ name: l.name, everyMinutes: l.everyMinutes ?? TICK_MINUTES })),
    ...state,
  }
}
