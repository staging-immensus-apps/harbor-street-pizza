#!/usr/bin/env node
// SEEDED — CAN EVERY SUITE IN THIS APP ACTUALLY FAIL?
//
// THE PROBLEM. The harness's `checker()` hands a suite a `done()` that prints the verdict and gives
// back an exit code. `scripts/run-suites.js` judges a suite on its exit STATUS and nothing else —
// deliberately, because suites legitimately print elapsed milliseconds. So a suite that does not
// turn `done()`'s answer into an exit code exits 0 with its assertions failing, and the runner
// reports it `✅`. Four of the seven suites in one template were written that way, which is how it
// was found; no suite was in that state where this guard first landed, so the guard exists while it
// is cheap rather than after a build has reported green on a silent suite.
//
// **AND SUCH A SUITE IS SILENT AND NOT MERELY MIS-SCORED, which is what makes a spelling check worth
// having at all.** `run-suites.js:203` spawns each suite with `encoding: 'utf8'` and no `stdio`, so
// the default is `pipe`: the suite's output is captured and then replayed only inside `if (!ok)`. On
// exit 0 that branch never runs and the `❌` lines are discarded. Measured on a one-suite fixture
// driving the real runner — `❌` appeared **zero** times in the entire run, which the runner closed
// with `✅ 1/1 suites passed`. So there is no output for a reader to notice, and a check over the
// SPELLING is the only thing that can speak before the exit code is wrong.
//
// WHY THIS EXISTS RATHER THAN THE HARNESS FIX BEING ENOUGH, and both halves are needed.
//   - `done()` now sets `process.exitCode = 1` itself, so the shape above cannot be got wrong by
//     any caller. That closes rule A's defect at the source and rule A is now a belt: it keeps the
//     spelling honest and it is what still speaks in an app whose own harness has been replaced.
//   - **It does NOT close rule B's hole, and nothing in the harness can.** A suite that obtains a
//     `done` and NEVER CALLS IT prints no verdict and exits 0. Rule A cannot see it — there is no
//     bare call to find — and the harness cannot either, because `done()` never runs. So the two
//     rules and the harness fix are three controls over two holes, and no two of them substitute
//     for the third.
//   - A generated app owns and rewrites its own suites, so a
//     control over them has to travel with the app. The harness does not: the platform mounts it
//     per build, so a fix in it reaches an app only when the platform's pinned commit moves
//     to one carrying it.
//
// WHAT IT CANNOT SEE, said plainly — and the list is longer than the obvious one, because a comment
// that overstates its own check is a map of where the check does not go.
//   - This reads the SPELLING of how a suite ends, not its behaviour. It cannot run a suite with an
//     injected failure, because injecting one means editing the file. So it catches the shapes that
//     were actually wrong and would not catch, say, a suite that swallowed its own exception before
//     reaching `done()`.
//   - **RULE A matches a `done()` call that stands ALONE AS A STATEMENT on its own line, and nothing
//     else.** `if (x) done()`, a `done()` inside a callback body, and a `done()` on the same line as
//     another statement are all invisible to it. Each of those still fails the exit code, so the
//     harness's own `process.exitCode = 1` is what covers them — which is the division of labour
//     rather than a gap, and is why rule A is a belt and the harness is the braces.
//   - **RULE B only applies to a suite that DESTRUCTURES `done`** out of `checker()`. A suite that
//     kept the checker object and called `c.done()` is covered by rule A but not rule B, and a suite
//     that obtains `done` under another name is outside rule B on purpose, because the alternative is
//     flagging hand-rolled suites that never used the harness at all.
//   - **RULE B asks whether `done()` is CALLED, not whether its value is used**, so it cannot tell a
//     suite that calls it in a branch nothing reaches from one that calls it on every path. That is
//     the same limit the spelling-based reading has everywhere in this file, and it is the price of
//     not running the suite.
//   - Neither rule can see a suite that is not REGISTERED in `package.json`, because that is the
//     list the runner itself works from. An unregistered suite file is not run by anything.
//   - **It asserts nothing about WHICH suites this app has**, deliberately: an app owns and retires
//     its own suites, so a count or a name from the template would red
//     a correct app. The rule a seeded suite follows is that it may assert only what the TEMPLATE
//     owns, and what is owned here is the shape of an ending — not the inventory.
//
// Hermetic: reads this tree, runs nothing, needs no Harper, reads no clock.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

const { readFileSync } = await import('node:fs')
const { join, relative } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const { checker, ROOT, stripComments } = await import('./probe/harness.js')

// ⚠ THE NAME IS DERIVED AND NEVER TYPED, which is what lets this file be BYTE-IDENTICAL IN ALL FOUR
// TEMPLATES whatever each one calls it. Most files are duplicated across the four, and
// nothing can tell when three of them are stale, and this file is one of them — so the defence is that there is nothing
// per-repository in it to drift. Typing the name would also put it in places that can disagree with
// the filename and with `package.json`. The registered script name IS the basename by convention,
// and a control at the foot of this file pins that against the discovered list rather than assuming
// it.
//
// **AN EARLIER DRAFT HAD A PER-TEMPLATE BLOCK HERE — a suite-count floor of 20 and two real suite
// names — AND THE REVIEWER RED IT TWICE AS ONE CLASS.** A seeded suite may assert only what the
// TEMPLATE owns, and a count of suites and the names in it belong to the APP: a
// headless app that drops its web-only suites, or any app that retires one, would have failed a
// number this template chose, about an app that is correct. `members-probe` was worse still — it is
// GENERATED baseline, so an app without a `Member` entity never had it. That is a seeded suite asserting
// what the template does not own. **What replaced it owns nothing**:
// the floor is 1, and the
// discovery controls run against synthesized names.
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).split('\\').join('/')
const NAME = SELF.replace(/^scripts\//, '').replace(/\.js$/, '')

const { check, section, done } = checker(NAME)

// The runner's own discovery, transcribed from `scripts/run-suites.js` rather than imported: a suite
// is an npm script whose NAME ends `-acceptance`/`-probe` or begins `check-`. Transcribed because
// importing the runner would make this check agree with it by construction instead of on purpose.
const SUITE_NAME = /(-acceptance|-probe)$/
const SUITE_PREFIX = /^check-/

/**
 * RULE A — lines where `done()`'s return value goes nowhere.
 *
 * The defect is a call standing alone as a statement, in either spelling: `done()` or `c.done()`.
 * Comments are stripped first, so the warning paragraph in a suite's own footer is not mistaken for
 * the call it warns about.
 */
function bareDoneLines (src) {
  return stripComments(src)
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /^(?:[A-Za-z_$][\w$]*\.)?done\s*\(\s*\)\s*;?$/.test(line))
    .map(({ n }) => n)
}

/**
 * RULE B — does the suite CALL `done()` at all?
 *
 * Rule A alone leaves a hole, and it is measured rather than imagined: a suite that obtains a `done`
 * and NEVER CALLS IT exits 0 with a failing assertion and prints no verdict line, and rule A passes
 * it because there is no bare call to find. Driven on a copy of a real suite with its `done()`
 * deleted and a failing assertion added: exit 0 — **even with the harness fix in place**, because
 * `done()` is what sets the code and it never runs.
 *
 * **IT ASKS WHETHER `done()` IS CALLED, NOT WHETHER ITS RETURN VALUE IS CONSUMED, and that narrowing
 * is deliberate**.
 * The first draft matched only `process.exit(done())` and `process.exitCode = done()`, which
 * **hard-reds a correct suite** written
 * `const code = done(); process.exit(code)` — a style choice, in a file a generated app owns and
 * rewrites — a gate that reds for reasons unrelated to its subject gets muted, and the next real
 * failure ships behind it — in the one rule that is supposed to prevent silence.
 *
 * Calling is also the *right* question now rather than a looser one. Since `done()` sets
 * `process.exitCode` itself, a call whose value goes nowhere still exits correctly; the only
 * remaining way to exit 0 with failures is for `done()` never to run. So this predicate is both
 * narrower and more accurate than the one it replaces, and it cannot red any spelling of a suite
 * that does call it — bare, assigned, conditional, object-form or wrapped.
 */
const CALLS_DONE = /(?:^|[^\w$.])(?:[A-Za-z_$][\w$]*\.)?done\s*\(\s*\)/
const callsDone = (src) => CALLS_DONE.test(stripComments(src))

/**
 * The last line of real code in a file — used ONLY by the self-check below, and it exists because a
 * whole-file scan cannot judge THIS file.
 *
 * **FOUND BY PROVOKING THE SELF-CHECK, and it is this pull request's own subject turned on its own
 * guard.** `stripComments` strips comments and **not string literals**, and this file's negative
 * controls contain `'process.exit(done())'` and `'done()'` as fixture *strings*. So a whole-file
 * `callsDone(src)` is satisfied by the controls no matter how the file ends: deleting the real
 * `process.exit(done())` left the self-check **green**, which is a control that cannot fail. The
 * reference implementation this was ported from has the same hole — measured, not assumed.
 *
 * Judging the final statement cannot be fooled that way, and it is the stricter and more honest
 * question for a file whose whole claim is about how it ends. It is deliberately NOT used for other
 * suites: they legitimately end with a conditional early exit or a closing brace, and demanding a
 * particular last line of somebody else's suite is that same cry-wolf shape.
 */
const lastStatement = (src) => stripComments(src)
  .split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''

/** What this file's own final statement must look like: the code handed straight to `process.exit`. */
const CONSUMES_LAST = /^process\.exit\s*\(\s*(?:[A-Za-z_$][\w$]*\.)?done\s*\(\s*\)\s*\)\s*;?$/

/** Does this file take a `done` out of `checker()` by destructuring? Then rule B applies to it. */
const obtainsDone = (src) => /\{[^{}]*\bdone\b[^{}]*\}\s*=\s*checker\s*\(/.test(stripComments(src))

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const suites = Object.entries(pkg.scripts ?? {})
  .filter(([name]) => SUITE_NAME.test(name) || SUITE_PREFIX.test(name))
  .map(([name, command]) => ({ name, command, file: (command.match(/scripts\/[\w.-]+\.js/) ?? [])[0] }))

// ⚠ THIS FILE IS CHECKED FIRST AND NOT THROUGH `check()`, because `done()` IS THE THING UNDER TEST.
// Route it through `check()` and the guard would find its own instance, print the red verdict and then
// exit 0 — the defect eating the only thing that can see it. So this case reports and exits WHERE IT IS
// FOUND, before any machinery that depends on being exited correctly. Driven on this file: with a bare
// `done()` as its last line it printed the two lines below and exited 1.
// The path comes from `import.meta.url` rather than a hard-coded name, so renaming this file cannot
// silently skip its own self-check.
{
  const src = readFileSync(join(ROOT, SELF), 'utf8')
  const bare = bareDoneLines(src)
  // ⚠ THE SECOND HALF IS `lastStatement` AND NOT `callsDone`, because a whole-file scan is satisfied
  // by this file's own fixture STRINGS and so could not fail. See `lastStatement`'s own note.
  if (bare.length || !CONSUMES_LAST.test(lastStatement(src))) {
    console.error(`  ❌ ${SELF}: ${bare.length
      ? `calls done() and throws the code away at line(s) ${bare.join(', ')}`
      : `does not END by consuming done() — its last statement is ${JSON.stringify(lastStatement(src))}`} — use process.exit(done())`)
    console.error(`\n❌ ${NAME}: the guard itself cannot report a failure, so nothing here can be trusted`)
    process.exit(1)
  }
}

section('every suite this app registers must be able to report its own failure')
check('this guard is registered in package.json, so the runner actually discovers it',
  suites.some((s) => s.file === SELF))
// ⚠ THE FLOOR IS 1 AND NOT THE REAL COUNT, and that is the reviewer's correction rather than
// timidity. The invariant the TEMPLATE owns is that discovery is non-empty and includes this guard —
// the check above asserts the second half. How many suites an app has is the app's, so any higher
// number is a template deciding something about an app it has never seen.
check('discovery is not empty, so a botched package.json cannot leave this checking nothing',
  suites.length >= 1,
  `found ${suites.length}: ${suites.map((s) => s.name).join(', ') || '(none)'}`)
check('…and every one of them resolves to a file in scripts/', suites.every((s) => s.file),
  suites.filter((s) => !s.file).map((s) => `${s.name} -> ${s.command}`).join('\n') || undefined)
// ⚠ NO ASSERTION FOR THE SELF-CHECK, DELIBERATELY. A `check(…, true)` sat here, copied from the
// reference implementation, and it is the always-OK shape a suite must not contain: it reported a real
// invariant as though it had just been measured, when the thing that actually enforces it is the
// early block above — which exits on its own and never reaches an assertion. It also inflated the
// count. The verdict for this file is that block's `process.exit(1)`, so the honest artefact is a log
// line.
console.log(`  ·  ${SELF}: its own ending was checked first, above, because done() is the subject — a refusal there exits before this line`)

// ⚠ A SUITE WHOSE FILE CANNOT BE READ IS A REPORTED FAILURE AND NEVER A THROW. Driven: registering
// `"weird-probe": "echo nope"` made `join(ROOT, undefined)` throw `ERR_INVALID_ARG_TYPE` out of this
// loop, and an uncaught throw took the process down mid-run — so every later assertion, including all
// of the negative controls below, never reported. It exited 1, which is the safe direction, but a
// harness that dies mid-run leaves the reader a count that looks like a pass of a smaller suite.
const sourceOf = (s) => {
  if (!s.file) return { src: null, why: `the script is ${JSON.stringify(s.command)}, which does not resolve to a scripts/*.js file, so there is nothing to read` }
  try { return { src: readFileSync(join(ROOT, s.file), 'utf8'), why: null } }
  catch (err) { return { src: null, why: `${s.file} is registered and cannot be read: ${err.code ?? err.message}` } }
}

for (const s of suites) {
  if (s.file === SELF) continue
  const { src, why } = sourceOf(s)
  if (src === null) {
    check(`${s.name}: its source can be read at all, which is the precondition for judging it`, false, why)
    continue
  }
  const bare = bareDoneLines(src)
  check(`${s.name}: calls done() nowhere that throws the code away`, bare.length === 0,
    bare.length ? `${s.file} calls done() as a bare statement at line(s) ${bare.join(', ')} — use process.exit(done())` : undefined)
  if (obtainsDone(src)) {
    check(`${s.name}: …and calls done(), which is what sets the exit code`, callsDone(src),
      callsDone(src) ? undefined : `${s.file} takes a done() out of checker() and never calls it, so nothing prints a verdict and nothing sets the exit code — call it, as process.exit(done())`)
  }
}

section('negative controls for rule A: the reader finds the defect, and does not invent it')
{
  // ⚠ EVERY ONE OF THESE WAS PROVOKED. The checks above went green on their first run, and a green
  // line says nothing about whether it could ever have been red — so the reader is driven against
  // sources that are wrong on purpose.
  check('a bare done() is found', bareDoneLines('check("x", true)\ndone()\n').length === 1)
  check('…with a semicolon too', bareDoneLines('done();\n').length === 1)
  check('…and indented', bareDoneLines('  done()\n').length === 1)
  check('…and with spaces inside the parentheses', bareDoneLines('done( )\n').length === 1)
  check('…and in the object spelling, c.done()', bareDoneLines('c.done()\n').length === 1)
  check('process.exit(done()) is not the defect', bareDoneLines('process.exit(done())\n').length === 0)
  check('process.exitCode = done() is not either', bareDoneLines('process.exitCode = done()\n').length === 0)
  check('a done() inside a line comment is not the defect, which is why comments are stripped first',
    bareDoneLines('// never a bare done()\nprocess.exit(done())\n').length === 0)
  check('…nor one inside a block comment',
    bareDoneLines('/*\n done()\n*/\nprocess.exit(done())\n').length === 0)
  check('…nor a destructured declaration of it', bareDoneLines('const { check, done } = checker("x")\n').length === 0)
  check('…nor a reference that is passed somewhere', bareDoneLines('after(done)\n').length === 0)
  check('…nor the word inside a string', bareDoneLines('const s = "done()"\n').length === 0)
  check('the line number reported is the line it is on', bareDoneLines('a\nb\ndone()\n')[0] === 3)
  check('a file with no done() at all is not flagged by rule A — which is the hole rule B exists for',
    bareDoneLines('export const x = 1\n').length === 0)
}

section('negative controls for rule B: the measured hole rule A leaves open')
{
  const obtains = 'const { check, section, done } = checker("x")\n'
  check('a suite that obtains done() and never calls it is caught, which rule A cannot see',
    obtainsDone(obtains + 'check("x", false)\n') === true &&
    callsDone(obtains + 'check("x", false)\n') === false)
  check('…and the same source is invisible to rule A, so the two rules are not the same check',
    bareDoneLines(obtains + 'check("x", false)\n').length === 0)
  check('process.exit(done()) satisfies rule B', callsDone(obtains + 'process.exit(done())\n') === true)
  check('…and so does process.exitCode = done()', callsDone(obtains + 'process.exitCode = done()\n') === true)
  check('…and so does an early exit guarded by a condition, which is a shape suites really use',
    callsDone(obtains + 'if (failures.length) process.exit(done())\n') === true)
  check('…and so does the object spelling', callsDone('const c = checker("x")\nprocess.exit(c.done())\n') === true)
  // ⚠ THE FOUR BELOW ARE THE FALSE REDS THE FIRST DRAFT OF RULE B WOULD HAVE GIVEN A CORRECT SUITE,
  // and they are the reason the rule asks whether `done()` is CALLED rather than whether its value is
  // consumed in one of two spellings.
  // Every one of them exits correctly, because `done()` sets `process.exitCode` itself.
  check('a result assigned and then exited is NOT a finding — the spelling that would have red a correct suite',
    callsDone(obtains + 'const code = done()\nprocess.exit(code)\n') === true)
  check('…nor one assigned and handed to process.exitCode',
    callsDone(obtains + 'const code = done()\nprocess.exitCode = code\n') === true)
  check('…nor a bare call, which rule A judges on spelling and rule B must not call silent',
    callsDone(obtains + 'done()\n') === true)
  check('…nor a call inside a callback body',
    callsDone(obtains + 'after(() => { done() })\n') === true)
  check('a call that is only inside a comment does not satisfy rule B',
    callsDone(obtains + '// process.exit(done())\n') === false)
  check('…and neither does the bare word without a call, so a reference passed somewhere is not a call',
    callsDone(obtains + 'after(done)\n') === false)
  check('…nor a longer identifier that merely ENDS in the word, which a bare match would have taken',
    callsDone(obtains + 'notdone()\n') === false)
  // ⚠ AND THE HOLE THAT MAKES THE SELF-CHECK USE A DIFFERENT READER. These two are why the block
  // above judges `lastStatement` rather than `callsDone`: `stripComments` does not strip STRING
  // literals, so this file's own fixtures satisfy a whole-file scan forever. Provoked: with the real
  // ending deleted, the whole-file form stayed green.
  check('a whole-file scan is fooled by a call that is only inside a STRING, which is why the self-check does not use it',
    callsDone('const fixture = "process.exit(done())"\n') === true)
  check('…while the final-statement reader is not fooled by the same source',
    CONSUMES_LAST.test(lastStatement('const fixture = "process.exit(done())"\n')) === false)
  check('…and it accepts the real ending', CONSUMES_LAST.test(lastStatement('a\nprocess.exit(done())\n')) === true)
  check('…with a semicolon, and in the object spelling',
    CONSUMES_LAST.test(lastStatement('process.exit(done());\n')) === true &&
    CONSUMES_LAST.test(lastStatement('process.exit(c.done())\n')) === true)
  check('…and it ignores trailing blank lines and comments when finding the last statement',
    CONSUMES_LAST.test(lastStatement('process.exit(done())\n\n// a trailing note\n\n')) === true)
  check('…and reports a bare done() ending as not consuming',
    CONSUMES_LAST.test(lastStatement('done()\n')) === false)
  check('a file that never obtains done() is OUT of rule B, so a hand-rolled suite cannot be falsely flagged',
    obtainsDone('process.exitCode = 1\n') === false)
  check('…and obtaining it under a different name is also out of rule B rather than wrongly red',
    obtainsDone('const { check } = checker("x")\n') === false)
}

section('negative controls: an unreadable suite is reported, not thrown')
{
  // ⚠ PROVOKED. Both of these threw out of the loop above before this reader existed, which took every
  // assertion after the throw with it — the control that cannot survive its own NO case.
  check('a script that resolves to no file is reported with its command, not thrown',
    sourceOf({ name: 'weird-probe', command: 'echo nope', file: undefined }).src === null)
  check('…and a registered file that is absent is reported with its errno, not thrown',
    sourceOf({ name: 'ghost-probe', command: 'node scripts/ghost-probe.js', file: 'scripts/ghost-probe.js' }).why?.includes('ENOENT') === true)
  check('…while a real one reads normally, so the reader discriminates',
    typeof sourceOf({ name: SELF, command: `node ${SELF}`, file: SELF }).src === 'string')
}

section('negative control: the suite list itself comes from package.json and not from a guess')
{
  // ⚠ SYNTHESIZED NAMES AND NEVER THIS APP'S OWN. These controls exist to prove the two REGEXES
  // match the runner's three arms, which needs no real suite to be named — and naming one would make
  // a seeded control depend on an inventory the app owns. An
  // earlier draft used
  // `look-acceptance` and `members-probe`; the second is GENERATED baseline, so it does not exist in
  // an app without a `Member` entity.
  check('the discovery matches the runner on a name that ends -acceptance',
    SUITE_NAME.test('synthesized-acceptance') === true)
  check('…and on one that ends -probe', SUITE_NAME.test('synthesized-probe') === true)
  check('…and on a check- prefix, which is the runner\'s third arm whether or not this file uses it',
    SUITE_PREFIX.test('check-synthesized') === true)
  check('…and NOT on an ordinary script, which is why `start` and `suites` are not checked',
    SUITE_NAME.test('an-ordinary-script') === false && SUITE_PREFIX.test('an-ordinary-script') === false)
  // ⚠ THE DERIVED NAME IS HELD TO THE DISCOVERED LIST. `NAME` comes from this file's own path, and a
  // basename that does not match the registered script name would leave this suite checking a list
  // it is not in — green, and about nothing. This is the assertion that makes deriving the name safe
  // rather than merely tidy.
  check(`this very suite's derived name (${NAME}) is in the list it built, so the check includes itself`,
    suites.some((s) => s.name === NAME),
    `derived "${NAME}" from ${SELF}; registered: ${suites.map((s) => s.name).join(', ')}`)
  check('…and that name is one the runner would discover at all',
    SUITE_NAME.test(NAME) || SUITE_PREFIX.test(NAME))
}

// ⚠ `process.exit(done())` AND NEVER A BARE `done()` — which is the whole subject of this file.
process.exit(done())
