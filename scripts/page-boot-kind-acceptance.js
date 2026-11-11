#!/usr/bin/env node
// SEEDED — the page-boot floor is a property of a WEB app, not of an application.
//
// **AN EARLIER VERSION OF THIS HEADER SAID "NOT SEEDED" AND WAS WRONG, and the correction is worth
// more than the file.** Leaving a path out of `SEEDED_PATHS` keeps it out of
// `.immensus/template.json` — the PROVENANCE RECORD — and does nothing whatever about what ships.
// The platform's seeding code is the authority, read there rather than inferred: it
// returns every blob in this repository's tree with no path filter, and withholds
// exactly two shapes — `scripts/run-suites.js` and `scripts/probe/`. Everything
// else in this tree, `package.json` included, becomes the app's root commit. So this file and its
// `package.json` script entry reach every generated app, and the runner discovers it there by name.
//
// So the cost is REAL and is accepted rather than avoided: **21.9 s per run** against
// `page-boot-acceptance`'s own 4.6 s (measured 2026-10-08 via `run-suites.js`), and `run-suites.js`
// re-runs each suite at three clock instants, so about a minute of every build. Against a build
// measured at 25–35 minutes that is ~3%, and `CLAUDE.md` is explicit that cost is recorded rather
// than targeted. What it buys is the only cover anybody has for the kind gate specifically: the
// platform's `instruments` check drives this app's probe over a decoy tree to ask whether it still
// discriminates, but it does not vary `IMMENSUS_APP_KIND`, so nothing else in the system would
// notice a skip that had widened to every kind.
//
// **It is in `SEEDED_PATHS` so provenance tracks it.** Shipping untracked was the reverse of what the
// old header claimed to achieve: `--diff` and the manifest would never have mentioned a file every
// app runs.
//
// **THREE things it is anchored on that an app may change**, said plainly:
// it spawns `scripts/page-boot-acceptance.js`, and also `look-acceptance.js` and
// `spa-routes-acceptance.js` to prove their skips still discriminate. What it MATCHES in their output
// is the harness's own skip wording rather than theirs, which is as narrow as that coupling gets; what
// it cannot avoid is that the files have to exist and run. An app that deletes or rewrites any of the
// three turns this suite red — and that is a REPORTED red rather than a stop, because `suites` is the app's own
// check since 2026-10-07 and never blocks a release. The tree is the app's; a suite of ours
// inside it can say what it thinks and cannot refuse.
//
// **This suite drives the probe as a CHILD PROCESS over synthesized trees and reads its exit code**,
// rather than importing anything out of it. Two reasons, and the second is the one that matters: the
// probe `process.exit(0)`s on the skip path, which cannot be asserted in-process at all; and the thing
// under test is a gate, so the only honest question is *what verdict does it give*, which is an exit
// code. A suite that imported a predicate would be testing the predicate and not the gate.
//
// **THE NEGATIVE CONTROLS ARE THE POINT.** A skip that widened to every kind would be worse than the
// bug, and it is exactly the shape that passes a suite written to prove a skip works. So every case
// below that must still RED is asserted:
//
//   - a web app with one page module reds, with no declaration, with `web_app` declared, with a kind
//     nobody has heard of, and with an empty string;
//   - a tree with no `src/` at all and no declaration reds, because nothing has said it has no pages;
//   - **a page that throws at import reds**, which is the property the publish smoke cannot see;
//   - and the route to green that has to stay closed: a web app whose own
//     `.immensus/template.json` claims to be a `service` still reds, because the whole
//     tree is the app's own and a floor keyed on a file in the tree is a floor the app can edit away.
//
// Hermetic (scripts/run-suites.js): no network, no secrets, no git, no wall clock. The trees are
// synthesized in a temp dir and have no `node_modules` — the probe resolves its toolchain against its
// own location, which is what makes that possible.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import * as harness from './probe/harness.js'
const { checker, importSpecifiers, walk } = harness
// ── THE HARNESS IS PINNED BY THE PLATFORM, SO THESE NAMES MAY BE ABSENT ──────
//
// **Measured, and it would have failed every build rather than only a headless one.** The platform
// mounts the harness at a pinned 40-hex commit, not from this
// repository's `main` — the pin exists precisely so a build does not run whatever the template's head
// happens to be. On 2026-10-13 it was `08dfb89`, which predates this change, and a NAMED import of
// `appHasPages` from a harness that has not got it is a link-time `SyntaxError` that no `try` can
// catch: driven with that harness mounted over this tree, `3/23 suites failed` on a WEB tree, with
// `The requested module './probe/harness.js' does not provide an export named 'appHasPages'`.
//
// That is the ordering rule — the half that lands first decides whether the gap is merely
// unenforced or **unsatisfiable**, and the second is strictly worse. This repository could
// not land the other half: the pin is the platform's.
//
// So the import is a NAMESPACE import, which does not fail on a missing name, and each of these names has a
// fallback that is **exactly the behaviour before the skips existed**: expect pages, skip nothing, assert everything.
// A stale harness therefore costs an app the fix and nothing else, which is the same direction an
// unrecognised kind fails in. When the pin reaches this commit the suites get their skips; until then
// they behave as they did yesterday.
//
// **AND HERE THE FALLBACK CANNOT SILENTLY STAND IN**, because this file's kind-reader controls have the
// predicate itself as their subject: a constant fallback would red *"the predicate is not constant"*
// for the right reason about the wrong thing. So a stale harness makes those controls PRINT A NAMED
// SKIP naming the pin, and the rest of this suite — the 19 child processes —
// runs exactly as before.
const APP_KINDS_WITH_PAGES = harness.APP_KINDS_WITH_PAGES ?? null
const appHasPages = harness.appHasPages ?? (() => true)
const declaredAppKind = harness.declaredAppKind ?? (() => '')
const skipForNoPages = harness.skipForNoPages ?? (() => 0)
const HARNESS_HAS_KIND_READER = Boolean(harness.APP_KINDS_WITH_PAGES && harness.appHasPages && harness.declaredAppKind && harness.skipForNoPages)

const { check, section, done } = checker('page-boot-kind-acceptance')
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PROBE = join(ROOT, 'scripts', 'page-boot-acceptance.js')

// The four kinds, transcribed here independently of the probe's own copy and of the builder's. A fixture
// computed from the code under test proves nothing — and this is the assertion that makes a drift in
// the platform's table visible instead of silent.
const KINDS = { web_app: true, service: false, agent: false, pipeline: false }

const GOOD = "export default function P () { return <main><h1>ok</h1></main> }\n"
const THROWS = "export default function P () { throw new Error('boom') }\n"

const made = []
/** A tree the probe can be pointed at. `pages` are extra modules under `src/pages/`. */
function tree ({ app = GOOD, pages = {}, manifest = null } = {}) {
  const w = mkdtempSync(join(tmpdir(), 'pbk-'))
  made.push(w)
  if (app !== null) {
    mkdirSync(join(w, 'src', 'pages'), { recursive: true })
    writeFileSync(join(w, 'src', 'App.tsx'), app)
    for (const [name, body] of Object.entries(pages)) writeFileSync(join(w, 'src', 'pages', `${name}.tsx`), body)
  }
  if (manifest) {
    mkdirSync(join(w, '.immensus'), { recursive: true })
    writeFileSync(join(w, '.immensus', 'template.json'), JSON.stringify(manifest))
  }
  return w
}

/** Run the probe over `cwd`. `kind` undefined means the variable is not set at all, which is not the
 *  same fact as an empty string and is asserted separately below.
 *
 *  `IMMENSUS_PAGE_BOOT_CONTROLS=skip` on every child: the probe's own negative controls — six
 *  synthesized pages, a bundle and a jsdom child each — prove the same verdicts in every run, and this
 *  suite runs it over many trees. They are proven once per suite pass by the probe's own registered run
 *  and by the platform's `boot` check, neither of which sets the variable; here they were three quarters
 *  of a web app's suite time (measured on a real app). `controlsRan` below is the control that only
 *  the exact value skips them. */
function run (cwd, kind, { controls = 'skip' } = {}) {
  const env = { ...process.env }
  delete env.IMMENSUS_APP_KIND
  delete env.IMMENSUS_PAGE_BOOT_CONTROLS
  if (kind !== undefined) env.IMMENSUS_APP_KIND = kind
  if (controls !== undefined) env.IMMENSUS_PAGE_BOOT_CONTROLS = controls
  const r = spawnSync(process.execPath, [PROBE], { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return { code: r.status, out: (r.stdout ?? '') + (r.error ? String(r.error.message) : ''), err: r.stderr ?? '' }
}

const skipped = r => /skipped — this app is/.test(r.out)
const floored = r => /discovered \d+ page module\(s\) under src\//.test(r.out)
const controlsRan = r => /negative controls \(synthesized pages/.test(r.out) && /a TDZ crash at module scope fails/.test(r.out)

// ── The vocabulary, so a drift in the kind table is visible here ───────────────────────────────────
section('the four kinds, transcribed independently')
check('exactly one of the four kinds has pages, and it is web_app', Object.entries(KINDS).filter(([, v]) => v).map(([k]) => k).join() === 'web_app')
check("the probe's own copy of the table matches this one, so a drift is visible rather than silent", (() => {
  const m = readFileSync(PROBE, 'utf8').match(/const KINDS_WITH_PAGES = \{([^}]*)\}/)
  if (!m) return false
  const parsed = Object.fromEntries(m[1].split(',').map(pair => pair.split(':').map(x => x.trim())).map(([k, v]) => [k, v === 'true']))
  return JSON.stringify(parsed) === JSON.stringify(KINDS)
})(), 'the probe and this suite disagree about which kinds have pages')
// SORTED, not `JSON.stringify` of the objects as written: key order is not a drift, and a gate that
// reds when somebody alphabetises a table is a cry-wolf shape; running the suite would not show it, because
// both tables happen to be in the same order today.
const byKey = t => Object.keys(t).sort().map(k => `${k}=${t[k] === true}`).join(',')
if (!HARNESS_HAS_KIND_READER) {
  section('the kind-reader controls: SKIPPED — the mounted harness predates them')
  console.log("  ⏭  scripts/probe/harness.js here exports no appHasPages/APP_KINDS_WITH_PAGES, so the harness mounted in this workspace predates them")
  console.log('     the platform pins the harness by commit, so this is a PIN that has not caught up and not a defect in this tree')
  console.log("     the suites behave exactly as they did before the skips existed — expect pages, skip nothing — and the checks below this block are unaffected")
  console.log('')
} else {
check("the HARNESS's copy matches it too, so all three statements of the table are held to one verdict", byKey(APP_KINDS_WITH_PAGES) === byKey(KINDS), `harness ${byKey(APP_KINDS_WITH_PAGES)} vs this suite ${byKey(KINDS)}`)
// There are THREE copies of the table in this repository and that is a deliberate cost, so the
// assertion above is what makes it payable. `probe/harness.js` holds the one the web-only suites
// read; `page-boot-acceptance.js` holds its own because it has to skip above its `esbuild` import
// and the platform drives that one file standing alone; and this suite transcribes the four by hand
// so neither of the other two is checked against itself. A rule enforced at two
// call sites is missed at the third — the answer is not one copy, which the two files cannot have,
// but one VERDICT, which is this line and the one above it.
check('and all three agree on the count, so a kind added to one table and not the others is visible', Object.keys(APP_KINDS_WITH_PAGES).length === Object.keys(KINDS).length, `harness ${Object.keys(APP_KINDS_WITH_PAGES).length} vs this suite ${Object.keys(KINDS).length}`)

// ── THE SKIP'S OWN SENTENCE, because a wrong sentence about a gate is where the next gap is ───
//
// Two of the three suites that skip say *nothing was checked*; this one says the opposite, because
// six assertions above its skip really did run. The first version of `skipForNoPages` printed the
// first sentence for every caller, which understated what a reader of THIS suite has and would have
// overstated what a reader of the other two gets the day somebody made them partial. So the
// distinction is a parameter with a control over its WORDING and not only over its exit code —
// a fail-closed default has to say that it defaulted.
{
  // CATCH-AND-REPORT, and the restore is ASSERTED rather than trusted. This control swaps
  // `console.log` for the length of one call, which is process-wide state: an uncaught throw here
  // would take every later assertion in this file down and leave the swap in place for whatever ran
  // next, which is precisely what a webhook suite's `captureRawBody` controls once did
  // — three controls lost, 100 later assertions skipped, and a registry left mutated. `finally`
  // having run is not the same as it having put back something that works.
  const realLog = console.log
  const say = opts => {
    const lines = []
    console.log = m => lines.push(String(m))
    try { skipForNoPages('zz', 'the subject', { env: { IMMENSUS_APP_KIND: 'service' }, ...opts }) } catch (e) { lines.push(`THREW: ${e.message}`) } finally { console.log = realLog }
    return lines.join('\n')
  }
  const whole = say({})
  const partial = say({ partial: true })
  check('skipForNoPages does not throw on either call, and console.log is the real one again afterwards', !/THREW/.test(whole + partial) && console.log === realLog, whole + partial)
  check('a WHOLE skip says nothing was checked', /nothing was checked/.test(whole) && !/DID run/.test(whole), whole)
  check('a PARTIAL skip says the assertions above it are the verdict, and does NOT claim nothing was checked', /DID run/.test(partial) && !/nothing was checked/.test(partial), partial)
  check('both name the kind and say it came from outside the tree, so a reader is never sent looking for a declaration in their own repository', [whole, partial].every(t => /"service"/.test(t) && /IMMENSUS_APP_KIND/.test(t) && /not from this tree/.test(t)))
  check('NO: the two sentences are not the same string, which is the only thing that makes the parameter mean anything', whole !== partial)
}

// ── THE PREDICATE ITSELF, WHICH THE TABLE CONTROLS ABOVE DO NOT COVER ───────
//
// **The hole, measured rather than argued.** The three checks above compare the three TABLES, so a
// drift in the DATA reds. They say nothing about the FUNCTION that reads it — and
// `appHasPages = () => false` bypasses the table entirely: driven on this tree, the whole set
// answered **23/23 passed, exit 0** in 50.57 s instead of 192 s, with every web-only suite silently
// a no-op. That is §5's closing hazard inside the change whose subject is skips: an instrument that
// stops discriminating goes green, not red, and the only tell was a wall-clock time nothing asserts.
// Raised by the agent review and proven by that mutation before it was taken.
//
// Ten cases, written out by hand rather than looped over the table, because a fixture computed from
// the code under test proves nothing (§6). The last two are the ones a bare lookup would get wrong:
// `constructor` and `__proto__` are inherited members of a plain object and neither is `false`, so
// both must read as unrecognised kinds.
section('appHasPages and declaredAppKind, over every shape a declaration can take')
for (const [env, want, why] of [
  [{}, true, 'no declaration at all means expect pages — today unchanged for every app that exists'],
  [{ IMMENSUS_APP_KIND: 'web_app' }, true, 'web_app has pages'],
  [{ IMMENSUS_APP_KIND: 'service' }, false, 'service has none'],
  [{ IMMENSUS_APP_KIND: 'agent' }, false, 'agent has none'],
  [{ IMMENSUS_APP_KIND: 'pipeline' }, false, 'pipeline has none'],
  [{ IMMENSUS_APP_KIND: 'mobile_app' }, true, 'a kind nobody has heard of skips nothing'],
  [{ IMMENSUS_APP_KIND: '' }, true, 'an empty string is not a kind'],
  [{ IMMENSUS_APP_KIND: '   ' }, true, 'whitespace is not a kind either'],
  [{ IMMENSUS_APP_KIND: 'constructor' }, true, 'an inherited member is not a declaration'],
  [{ IMMENSUS_APP_KIND: '__proto__' }, true, 'nor is the other one'],
]) check(`${JSON.stringify(env.IMMENSUS_APP_KIND ?? null)} → hasPages ${want}: ${why}`, appHasPages(env) === want, `got ${appHasPages(env)}`)
check('and the declaration is TRIMMED, so a kind with stray whitespace is still that kind', appHasPages({ IMMENSUS_APP_KIND: '  service  ' }) === false && declaredAppKind({ IMMENSUS_APP_KIND: '  service  ' }) === 'service')
check('NO: the predicate is not constant — it answers both ways, which is what `() => false` and `() => true` each break', appHasPages({}) !== appHasPages({ IMMENSUS_APP_KIND: 'service' }))
check('every kind the table calls page-less reads false, and the one it calls paged reads true, through the PREDICATE and not the table', Object.entries(KINDS).every(([k, v]) => appHasPages({ IMMENSUS_APP_KIND: k }) === v))

// ── NOTHING MAY IMPORT THE TWO SKIPPING SUITES, BECAUSE THEIR SKIP IS A `process.exit` ───────
//
// `spa-routes-acceptance.js` exports `routesFromTs`, `audit` and two patterns, and its skip sits
// mid-file above them — so an importer would be killed outright on a headless app rather than
// getting the export it asked for. Nothing imports it today and nothing may start: that is
// written as a CHECK rather than as a sentence in the file,
// because a sentence is an unchecked claim.
section('the skipping suites stay standalone entry points')
{
  const offenders = []
  for (const f of walk(join(ROOT, 'scripts'))) {
    if (/(spa-routes|look)-acceptance\.js$/.test(f)) continue
    for (const spec of importSpecifiers(readFileSync(f, 'utf8'))) {
      if (/(spa-routes|look)-acceptance(\.js)?$/.test(spec)) offenders.push(`${f.slice(ROOT.length + 1)} → ${spec}`)
    }
  }
  // ITS LIMIT, STATED RATHER THAN MADE CLEVERER: it walks `scripts/` only, so an
  // importer under `lib/`, `resources/` or `routes/` would not be caught. That is the right scope for
  // what it is worth — a product file importing a suite is a different defect with its own gate
  // (`deps-acceptance`'s runtime-import audit) — and naming the gap is this repository's discipline
  // for a reader that is deliberately not exhaustive (`stripAtRules`, `stripComments`).
  check('no file under scripts/ imports spa-routes-acceptance or look-acceptance, whose skips are a process.exit', offenders.length === 0, offenders.join(' | '))
}

}

section('the skip is reached on a tree that cannot import the toolchain')
// Measured 2026-10-08 against a real headless tree (`app-template@898926f` with `src/`, `index.html`,
// `vite.config.ts` and the web toolchain removed from `node_modules`): the probe's top-level
// `await import('esbuild')` throws ERR_MODULE_NOT_FOUND before any line of it runs. So a skip placed
// after that import would never be reached. Asserted on the source, because synthesizing a tree
// without the probe's own `node_modules` is not possible here — it resolves them against its own
// location, which is this checkout.
// **THE COMMENT LINES COME OFF FIRST, AND THE FIRST VERSION OF THESE TWO ASSERTIONS DID NOT DO IT —
// so both failed, and both for the same reason: they were reading the probe's PROSE.** The probe's own
// comment quotes `await import('esbuild')` while explaining why the skip is above it, so `indexOf`
// found the sentence rather than the statement; and it names `.immensus/template.json` while saying it
// deliberately does not read it, so "reads no file for the kind" was refuted by the paragraph
// promising exactly that. An assertion over source has to name the code as its subject or it is
// asserting something about the documentation, which is the lesson of an assertion whose subject
// changed, reached from the other end.
const probeCode = readFileSync(PROBE, 'utf8').split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
check('the kind gate and its process.exit(0) come BEFORE the esbuild import, or a headless tree never reaches them', (() => {
  const gate = probeCode.indexOf('if (!HAS_PAGES)')
  const tool = probeCode.indexOf("await import('esbuild')")
  return gate > -1 && tool > -1 && gate < tool
})())
// NARROWER THAN ITS FIRST NAME: a grep cannot prove
// a file is never read — `JSON.parse(await readFile(...))` would pass it. The behavioural cover is the
// two `liar` controls above, which drive a tree whose own manifest claims the wrong kind; this is a
// cheap tripwire over the two spellings a future edit would most likely reach for, and it earns its
// place only by naming its own weakness.
check('the probe reads IMMENSUS_APP_KIND, and names neither of the two obvious tree readers — a tripwire, not a proof; the `liar` controls above are the cover', /process\.env\.IMMENSUS_APP_KIND/.test(probeCode) && !/template\.json/.test(probeCode) && !/readFileSync\([^)]*immensus/.test(probeCode))

// ── THE DRIVING HALF NEEDS THE TOOLCHAIN, SO A HEADLESS APP STOPS HERE ──────────────────────
//
// Everything above this line reads source and compares tables: it costs nothing and it is what would
// catch a skip that had WIDENED, which is the one failure worse than the bug. Everything below drives
// `page-boot-acceptance.js` as 19 child processes over synthesized trees whose pages are real `.tsx`
// modules — so it needs `esbuild`, `jsdom` and React, which are `devDependencies` a workspace
// installed for an app with no front end does not have. Measured with those absent: **11 assertions
// failed**, every one of them because the child could not start, about a probe that was behaving
// correctly.
//
// **What covers the gate once this stops driving it, said plainly rather than left as a hole.** This
// suite is the only cover there is for the kind gate specifically — the platform's `instruments` check
// drives the probe over a decoy tree but never varies `IMMENSUS_APP_KIND`. On a headless app nothing
// below runs, and the answer is not another check in that app: it is that **this repository's own CI
// sets no `IMMENSUS_APP_KIND` at all**, so `pr-check.yml` always takes the full path on every pull
// request that touches the gate. That is `harness-acceptance`'s own argument for its `bash` skip
// — a skip is acceptable when the thing it stops measuring is measured where the file is
// authored, and a hole when it is not.
if (!appHasPages()) {
  skipForNoPages('page-boot-kind-acceptance', `the 19 child processes that drive page-boot-acceptance.js need esbuild, jsdom and React, which a "${declaredAppKind()}" app's workspace does not install`, { partial: true })
  for (const w of made) rmSync(w, { recursive: true, force: true })
  process.exit(done())
}


// ── THE CONTROL: a web app is unchanged ───────────────────────────────────────────────────────────
section('a web app: unchanged, with and without a declaration')
const web2 = tree({ pages: { Two: GOOD } })
for (const [label, kind] of [['no declaration at all', undefined], ['web_app declared', 'web_app']]) {
  const r = run(web2, kind)
  check(`two page modules pass, ${label}`, r.code === 0 && floored(r) && !skipped(r), `exit ${r.code}${r.err ? ' | ' + r.err.slice(0, 200) : ''}`)
}

// ── THE CONTROLS ARE SKIPPED ONLY ON THE EXACT VALUE ─────────────────────────────────────────
//
// Every other child in this file skips the probe's negative controls, so these two are what keep that
// from widening: a typo, or a value somebody might think means the same, runs them, and the exact value
// says that it skipped them rather than skipping in silence.
section('the probe\'s own negative controls are skipped only by IMMENSUS_PAGE_BOOT_CONTROLS=skip')
{
  const skippedRun = run(web2, undefined)
  check('with the exact value the controls are skipped, and the probe says so', skippedRun.code === 0 && !controlsRan(skippedRun) && /negative controls: skipped/.test(skippedRun.out), `exit ${skippedRun.code}`)
  const otherValue = run(web2, undefined, { controls: '1' })
  check('NO: any other value — here "1" — runs them in full', otherValue.code === 0 && controlsRan(otherValue), `exit ${otherValue.code}`)
}

// ── ONE PAGE MODULE IS AN APP, AND THE FLOOR STOPPED REFUSING IT ───────────────────────────
//
// These five used to assert `code === 1` — a one-page web app red. The
// floor is now *at least one*, so they assert the rule instead of the defect: a single-screen app
// passes, and it still is not SKIPPED, because an unrecognised kind means "expect pages" and the
// per-page boot has to run. The red cases moved to the group below, where the subject is a probe
// with nothing to boot rather than an app with one screen.
section('a web app with ONE page module passes, and is still not skipped')
const web1 = tree()
const KIND_LABELS = [
  ['with no declaration at all', undefined],
  ['with web_app declared', 'web_app'],
  ['with a kind nobody has heard of — unknown means expect pages, not "skip"', 'mobile_app'],
  ['with an empty string, which is not a kind', ''],
  ['with whitespace, which is not a kind either', '   ']
]
for (const [label, kind] of KIND_LABELS) {
  const r = run(web1, kind)
  check(`one page module passes ${label}`, r.code === 0 && floored(r) && !skipped(r), `exit ${r.code}${r.err ? ' | ' + r.err.slice(0, 200) : ''}`)
}

// ── THE NEGATIVE CONTROLS: the floor still discriminates, at zero ─────────────────────────────────
//
// This is where the floor stays able to say no, and it is the group that keeps `boot` worth
// reading. A tree with no page module at all gives the per-page loop nothing to run, so WITHOUT this
// the probe would exit 0 having asserted nothing — `instruments`' `boot-probe-always-green`, reported
// as a pass. Deleting the floor outright was the other option and this group is the measurement that
// refuses it.
//
// TWO declarations here and not the five above, and the reason is a cost this file already pays
// three times a build. What the five variants exercise is the KIND GATE — whether an unrecognised
// kind, an empty string and whitespace all mean "expect pages" — and the group above drives all five
// of them to exhaustion. Once `HAS_PAGES` is true the floor takes one code path, identical for every
// one of the five, so a third, fourth and fifth child process here would re-measure the same branch
// at ~3.5 s each. Two is the belt: the declaration every app that exists has (none) and the one the
// platform actually sends for a web app.
section('NO cases: a web app with NO page module still reds — the probe must have a subject')
for (const [label, kind] of [['with no declaration at all', undefined], ['with web_app declared', 'web_app']]) {
  const r = run(tree({ app: null }), kind)
  check(`no page module at all reds ${label}`, r.code === 1 && floored(r) && !skipped(r), `exit ${r.code}`)
}

section('NO case: the route to green that has to stay closed')
// The app owns its whole tree after its first build and may edit or delete any file in it, so a floor
// keyed on the tree's own manifest is a floor the app can edit away.
// Driven rather than described.
//
// The RED half used to be a one-page tree, which red on the floor of two; now that is a passing
// app, so the liar's red now comes from a page that throws while rendering. The control's subject is
// unchanged and the evidence is stronger: the manifest cannot excuse a per-page boot either, which is
// the half an app would actually want excused.
const liar = tree({ pages: { Boom: THROWS }, manifest: { template: 'ImmensusApp/web-app-template', version: '0.1.0', appKind: 'service', files: {} } })
const liarRun = run(liar, undefined)
check('a web app whose own .immensus/template.json claims to be a service STILL reds — the tree is never the authority', liarRun.code === 1 && floored(liarRun) && !skipped(liarRun), `exit ${liarRun.code}`)
const liarWeb = tree({ manifest: { appKind: 'service' }, pages: { Two: GOOD } })
const liarWebRun = run(liarWeb, 'web_app')
check('...and the manifest cannot talk a declared web app out of its per-page boots either', liarWebRun.code === 0 && floored(liarWebRun) && !skipped(liarWebRun), `exit ${liarWebRun.code}`)

section('NO case: the rendering control the publish smoke cannot see')
// The platform's publish smoke check compares status codes and reads no response body, so a
// page that throws while rendering is invisible to it. This probe is the only thing that sees it, and
// the kind skip must not have cost that.
const boom = tree({ pages: { Boom: THROWS } })
const boomRun = run(boom, undefined)
check('a page module that throws at import still reds', boomRun.code === 1, `exit ${boomRun.code}`)
const boomWeb = run(boom, 'web_app')
check('...and declaring web_app does not excuse it', boomWeb.code === 1, `exit ${boomWeb.code}`)

// ── THE FIX: a kind with no pages is skipped, with its reason printed ─────────────────────────────
section('a kind with no pages: skipped, with the reason printed')
const headless = tree({ app: null })
for (const kind of Object.keys(KINDS).filter(k => !KINDS[k])) {
  const r = run(headless, kind)
  check(`"${kind}" is skipped over a tree with no src/, and exits 0`, r.code === 0 && skipped(r) && !floored(r), `exit ${r.code}${r.err ? ' | ' + r.err.slice(0, 200) : ''}`)
  check(`..."${kind}" says WHICH kind it skipped for`, new RegExp(`skipped — this app is "${kind}"`).test(r.out))
}
const svc = run(headless, 'service')
check('the skip says the kind came from outside the tree, not from the tree', /IMMENSUS_APP_KIND/.test(svc.out) && /not from this tree/.test(svc.out))
// A clean skip is not a pass, and saying so is the half that stops it being read as one — it is why
// the platform has to drop `boot` and the `boot` half of `instruments` together.
check('the skip says plainly that NOTHING was checked, so it is not evidence that any page renders', /nothing was checked/.test(svc.out))
check('a kind with no pages is skipped over a tree that HAS pages too — the kind decides, not the tree', (() => {
  const r = run(web2, 'service')
  return r.code === 0 && skipped(r) && !floored(r)
})())

section('NO case: today is preserved for a tree nobody has declared anything about')
// Every app that exists was seeded before this landed, so none of them sets the variable. A tree with
// no `src/` and no declaration must still red: nothing has said it has no pages, and silence is not a
// declaration.
const undeclared = run(headless, undefined)
check('a tree with no src/ and NO declaration still reds — silence is not a declaration', undeclared.code === 1 && !skipped(undeclared), `exit ${undeclared.code}`)

// ── The skip is before the toolchain import, which is what the measurement settled ───────────────
// ── THE TWO SKIPPING SUITES, DRIVEN BOTH WAYS ───────────────────────────────
//
// The predicate controls above red on `() => false`. These red on something the predicate cannot see:
// a suite that stopped CONSULTING it. Each is spawned twice over this same tree — declared `service`,
// where it must print the skip and assert nothing, and declared `web_app`, where it must assert and
// must NOT print a skip. Two spawns each, about 1.2 s in total against the 19-child block above.
//
// **THEY ARE HERE, BELOW THE KIND SKIP, AND THAT IS NOT AN OVERSIGHT.** The `web_app` half of each
// pair only holds on a tree that HAS pages: on a headless app, `look-acceptance` declared `web_app`
// correctly reds, so a control demanding it pass would fail for the right reason — which is the
// lesson that making a check conditional makes its own controls conditional too. So the question
// *does the skip discriminate* is asked where both branches are reachable, and what covers it for a
// headless app is the same thing that covers the rest of this gate: this repository's CI sets no
// `IMMENSUS_APP_KIND` at all and therefore always takes this path.
// SKIPPED ON A STALE HARNESS for the same reason as the controls above: with the fallback in force
// there is no skip to discriminate, so asserting one would red about a PIN rather than about this
// tree. The child processes above are unaffected, which is why this is the only block here
// that moves.
if (!HARNESS_HAS_KIND_READER) {
  section('the spawn controls: SKIPPED — the mounted harness predates the skip they drive')
  console.log('  ⏭  with no appHasPages in the mounted harness the two suites assert everything, which is the behaviour before the skips existed and has no skip to tell apart')
  console.log('')
} else {
section('the two skipping suites discriminate, driven rather than read')
for (const suite of ['look-acceptance', 'spa-routes-acceptance']) {
  const spawnAs = kind => {
    const env = { ...process.env }
    delete env.IMMENSUS_APP_KIND
    if (kind !== undefined) env.IMMENSUS_APP_KIND = kind
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', `${suite}.js`)], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
  }
  // **WHAT THESE MATCH ON IS DELIBERATELY THE HARNESS'S TEXT AND NOT THE SUITE'S**.
  // Both suites are SEEDED, so an app may rewrite them; the discriminating signal is
  // the skip line, which `skipForNoPages` prints from `probe/harness.js` — the harness is MOUNTED
  // rather than seeded, so that wording is not an app's to change. The `web_app` arm therefore
  // asserts the skip's ABSENCE and exit 0, and deliberately not that the suite printed a verdict:
  // keying on a sibling's own output would red on an app that legitimately edited its own suite,
  // and a red here is a wrong row on that user's screen.
  //
  // **WHAT THAT DOES AND DOES NOT BUY, measured rather than claimed, because the obvious reading of
  // the paragraph above is too generous.** It fixes the `web_app` arm: an app that empties its own
  // `look-acceptance.js` now passes that arm, where matching `/assertions held/` would have red it.
  // It does NOT fix the `service` arm and cannot — proving a suite skips requires the suite to exist
  // and print the skip, so an emptied or deleted sibling still reds here (driven both ways: emptied
  // → 1 red, deleted → 4). That is the exposure this file's own header accepts for all three
  // siblings it spawns, and it is a REPORTED red rather than a stop, because `suites` is the app's
  // own check. Narrowing a coupling is not removing it, and saying otherwise would be this section's
  // own recurring class.
  const svc = spawnAs('service')
  check(`${suite} declared service: exits 0 and PRINTS the skip`, svc.code === 0 && /skipped — this app is "service"/.test(svc.out), `exit ${svc.code} | ${svc.out.slice(0, 200)}`)
  check('...and claims no verdict, so it cannot read as a silent pass', !/assertions held/.test(svc.out), svc.out.slice(0, 200))
  const web = spawnAs('web_app')
  check(`NO: ${suite} declared web_app does NOT skip, which is what a widened skip breaks`, web.code === 0 && !/skipped — this app is/.test(web.out), `exit ${web.code} | ${web.out.slice(-200)}`)
  const none = spawnAs(undefined)
  check('...and with no declaration at all it does not skip either, because unknown means expect pages', none.code === 0 && !/skipped — this app is/.test(none.out), `exit ${none.code} | ${none.out.slice(-200)}`)
}

}

for (const w of made) rmSync(w, { recursive: true, force: true })
process.exit(done())
