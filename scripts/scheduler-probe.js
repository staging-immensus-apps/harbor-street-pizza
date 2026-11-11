#!/usr/bin/env node
// FIXED — runs one tick of resources/Scheduler.js under freezeClock() with an injected
// loop list (the back-end charter's "a scheduler gets a probe that runs one tick"):
// loops run when due and not before, a throwing loop is recorded and does not stop its
// siblings, every run writes a LoopRun row, and the status endpoint is admin-only.
// Importing the module arms its interval; both timers are unref'd, so this process exits.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { freezeClock, advanceClock } from './probe/frozen-clock.js'
const NOW = freezeClock()
process.env.SESSION_SECRET = 'suite-secret-not-a-real-one'

const { checker, ROOT } = await import('./probe/harness.js')
const { tables, resetTables } = await import('./probe/harperdb-stub.js')
const schedulerModule = await import('../resources/Scheduler.js')
const { tick, schedulerStatus, TICK_MINUTES, FIRST_TICK_DELAY_MS } = schedulerModule

const { check, section, done } = checker('scheduler-probe')
resetTables()

const runs = { fast: 0, slow: 0, bad: 0 }
const loops = [
  { name: 'immensus-probe-fast', everyMinutes: 10, run: async () => { runs.fast++; return { outcome: 'ok', notes: `run ${runs.fast}` } } },
  { name: 'immensus-probe-slow', everyMinutes: 60, run: async () => { runs.slow++; return { outcome: 'noop' } } },
  { name: 'immensus-probe-bad', everyMinutes: 10, run: async () => { runs.bad++; throw new Error('boom') } },
]

section('one tick')
check('the module armed itself once at import (globalThis guard)', globalThis.__immensusSchedulerStarted === true)
const first = await tick({ now: Date.now(), loops })
check('every loop runs on the first tick', runs.fast === 1 && runs.slow === 1 && runs.bad === 1)
check('a throwing loop is recorded as `threw` and its siblings still ran', first.some((l) => l.startsWith('immensus-probe-bad: threw — boom')) && first.length === 3)
const rows = [...tables.LoopRun.rows.values()]
check('one LoopRun row per run, with outcome and node', rows.length === 3 && rows.every((r) => r.loop && r.startedAt && r.outcome && r.node && r.triggeredBy === 'schedule'))
check('the row for the throwing loop carries the error', rows.some((r) => r.loop === 'immensus-probe-bad' && r.outcome === 'threw' && r.notes === 'boom'))

section('not before it is due (NEG)')
const same = await tick({ now: Date.now(), loops })
check('a second tick at the same instant runs nothing', same.length === 0 && runs.fast === 1)
advanceClock(TICK_MINUTES * 60 * 1000)
const five = await tick({ now: Date.now(), loops })
check('five minutes later, ten-minute loops are still not due', five.length === 0 && runs.fast === 1)
advanceClock(5 * 60 * 1000)
const ten = await tick({ now: Date.now(), loops })
check('ten minutes after the first run, the ten-minute loops run and the hourly one does not', runs.fast === 2 && runs.bad === 2 && runs.slow === 1 && ten.length === 2)
check('a loop with no everyMinutes defaults to the tick interval', (await tick({ now: Date.now(), loops: [{ name: 'immensus-probe-default', run: async () => ({}) }] })).length === 1)
check('a tick with nothing registered runs nothing (NEG)', (await tick({ now: Date.now(), loops: [] })).length === 0)

// What the app registered in the seam, whatever that is. The template ships no lib/loops,
// a real app shipped four, and this suite is FIXED — so it asserts the SHAPE of
// the registered list and the FIXED tick's behaviour over it, never that the seam is empty
// (the old assertion "the empty template has no loops registered" made every app with a
// loop fail Tier A, and a real app worked around the suite by leaving the seam
// unwired). The loops' own bodies are the app's business and are never run here: a generated
// loop sends email and spends money, which a hermetic suite must not do. Each is replaced by
// a recorder carrying the same name and cadence, so the ledger and the due-window belong to
// the FIXED scheduler and the loop list belongs to the app. (The seam is imported, so the
// app's loop modules DO evaluate — the same evaluation Harper does at startup. What never
// runs here is a loop's run() body.)
section('the registered loops (lib/loops/index.js)')
const SEAM = join(ROOT, 'lib', 'loops', 'index.js')
let registered = []
if (!existsSync(SEAM)) {
  check('no lib/loops/index.js: the seam is optional and the scheduler tolerates it', (await tick({ now: Date.now() })).length === 0)
} else {
  // Deliberately NOT try/catch: the seam exists, so an import that fails is a broken app,
  // not an absent one. resources/Scheduler.js swallows ERR_MODULE_NOT_FOUND so production
  // tolerates the missing file — inheriting that here would let one typo'd import inside
  // lib/loops/ read as "no loops registered" and pass, which is the same defect again.
  const mod = await import(pathToFileURL(SEAM).href)
  check('lib/loops/index.js exports a LOOPS array', Array.isArray(mod.LOOPS), `got ${typeof mod.LOOPS}`)
  registered = Array.isArray(mod.LOOPS) ? mod.LOOPS : []
}
const names = registered.map((l) => String(l?.name ?? ''))
check(`every registered loop has a unique name, a positive cadence and a run() (${registered.length}: ${names.join(', ') || 'none'})`,
  registered.every((l) => l?.name && typeof l.run === 'function' && (l.everyMinutes === undefined || Number(l.everyMinutes) > 0)) &&
  new Set(names).size === names.length)
if (registered.length) {
  // A SECOND evaluation of the scheduler, so its module-scope run ledger starts empty: the
  // fixture loops above already populated this process's, and an app whose loop shares a
  // name with one of them would otherwise be "not due" here.
  const { tick: freshTick } = await import(`${pathToFileURL(join(ROOT, 'resources', 'Scheduler.js')).href}?registered-loops`)
  const ran = []
  const stand = registered.map((l) => ({ name: l.name, everyMinutes: l.everyMinutes, run: async () => { ran.push(l.name); return { outcome: 'ok' } } }))
  const before = tables.LoopRun.rows.size
  const lines = await freshTick({ now: Date.now(), loops: stand })
  check('every registered loop is due on the first tick and runs once', ran.length === registered.length && new Set(ran).size === registered.length && lines.length === registered.length)
  check('each one wrote its own LoopRun row', tables.LoopRun.rows.size === before + registered.length)
  const again = await freshTick({ now: Date.now(), loops: stand })
  check('none of them runs twice at the same instant (NEG)', again.length === 0 && ran.length === registered.length)
}

section('armed at module scope, once (rule 17)')
check('the first tick is delayed five minutes and the interval is five minutes', FIRST_TICK_DELAY_MS === 5 * 60 * 1000 && TICK_MINUTES === 5)
{
  // The guard is only proven by re-evaluating the module: a second copy that armed its own
  // timer would double every loop's cadence on every rolling restart. The instrument is
  // self-tested first — the same re-evaluation with the flag cleared MUST arm a timer, or a
  // counter that never counts would read as a guard that always works.
  const realSetTimeout = globalThis.setTimeout
  const rearm = async (tag) => {
    const armedTimers = []
    globalThis.setTimeout = (...a) => { const t = realSetTimeout(...a); armedTimers.push(t); return t }
    try { await import(`${pathToFileURL(join(ROOT, 'resources', 'Scheduler.js')).href}?${tag}`) } finally { globalThis.setTimeout = realSetTimeout }
    // Cleared, not merely unref'd: the callback the control armed would call the app's real
    // loops five minutes on, and no suite may leave that scheduled behind it.
    for (const t of armedTimers) clearTimeout(t)
    return armedTimers.length
  }
  delete globalThis.__immensusSchedulerStarted
  check('with the flag cleared, a re-evaluation DOES arm a timer (the control)', (await rearm('unguarded')) === 1)
  check('a second evaluation arms no second timer (globalThis guard)', (await rearm('guarded')) === 0)
  check('the flag is set again after both', globalThis.__immensusSchedulerStarted === true)
}

section('no endpoint of its own, and a status for whatever has one')
{
  // The template core has no administrator to show a status to, so this module exports no
  // Resource: a class here would be a public endpoint with nobody to guard it. The sign-in kit's
  // AdminApi serves `schedulerStatus()` at GET /AdminApi/scheduler, admin-only.
  const exported = Object.entries(schedulerModule).filter(([, v]) => typeof v === 'function' && /^class\b/.test(Function.prototype.toString.call(v)))
  check('resources/Scheduler.js exports no class, so jsResource registers no endpoint for it', exported.length === 0, exported.map(([k]) => k).join(', '))
  const st = await schedulerStatus()
  check('schedulerStatus() reports armed, the cadence and the ticks run so far', st.armed === true && st.tickMinutes === TICK_MINUTES && st.firstTickDelayMinutes === FIRST_TICK_DELAY_MS / 60000 && typeof st.ticksCompleted === 'number' && Array.isArray(st.registered), JSON.stringify(st).slice(0, 200))
}
check('the clock only moved when the probe moved it', Date.now() === NOW + 10 * 60 * 1000)
process.exit(done())
