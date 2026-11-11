#!/usr/bin/env node
// THE KIT'S OWN HELPERS: THE SCHEDULER STATUS IT CANNOT VENDOR, AND THE COPIES IT CAN.
//
// **Why this suite exists.** `lib/sign-in-support.js` was added so the sign-in kit drops into a
// template that does not export the twelve helpers it used to borrow. Two things about it are not
// visible in a diff:
//
//   1. **The scheduler status.** It imports `resources/Scheduler.js` DYNAMICALLY, because a headless
//      application has none and a static import of a missing module fails the whole component at
//      load. Four answers have to be distinguishable: the real status, a genuine absence, a module
//      that exports no status, and a module that is there and THROWS. The first cut collapsed the
//      last into the second with a bare `catch {}` — so a `web_app` whose scheduler was broken would
//      have shown the administrator a calm "none". That is a false all-clear, which is worse than a
//      false alarm because nobody investigates it.
//   2. **The duplicated helpers.** In a `web_app` the core also exports `redirect`, `clientIp`,
//      `runAuthed`, `previewPath`, `publicBaseFor` and `refuseOnPreview`, and the sign-in code now
//      uses the kit's — so a later edit to one copy would diverge silently. **That comparison is NOT
//      here; it is in `kits/assemble.mjs --self-test`.** It was here, and it could not
//      stay: this suite SHIPS WITH THE KIT into agent, service and
//      pipeline applications, and comparing against core helpers those templates do not export would
//      have failed in exactly the applications this work exists to unblock — a red `suites` row on a
//      correct application, which is the cry-wolf shape. A check that must run in one checkout and
//      not another is scoped by repository rather than by a marker in the tree, and the
//      self-test is the file that is never seeded.
//
// **Everything left here works in ANY application**, because each case builds its own temporary tree
// with stub siblings rather than reading the core's files. That is what makes it safe to ship with
// the kit.
//
// Hermetic: temp directories, no network, no git, no clock.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, checker, discard, fixture } from './probe/harness.js'

const { check, section, done } = checker('sign-in-support-acceptance')
const workdirs = []

// ── 1. the scheduler status, in all four states ──────────────────────────────────────────────────
section('the scheduler status: the real one, a stated absence, a silent module, and a stated error')

// The three siblings the module imports, reduced to exactly what it reads. A stub rather than the
// core's own files because this section is about the dynamic import and nothing else.
//
// WHAT DRIVES THIS MODULE AGAINST THE REAL CORE IS NOT IN THIS FILE AND IS NOT IN YOUR APPLICATION:
// it is `kits/assemble.mjs --self-test` in the template repository, which assembles the kit over the
// core and holds every helper this module vendors to the core's own answers. It cannot ship with the
// kit, because it needs core exports that `agent-template`, `service-template` and
// `pipeline-template` do not have — a suite that compared them here would red a correct application.
const SIBLINGS = {
  'lib/config.js': 'export function ownConfig () { return null }\nexport function readKey () { return undefined }\n',
  'lib/copy.js': "export const PREVIEW_PREFIX = '/preview'\nexport function isPreviewCopy () { return false }\n",
  'lib/http.js': "export const NO_STORE = 'no-store'\nexport const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s })\nexport const headerOf = () => null\n"
}
const SUPPORT = readFileSync(join(ROOT, 'lib', 'sign-in-support.js'), 'utf8')

async function statusWith (name, scheduler) {
  const w = fixture(ROOT, [], `sched-${name}-`)
  workdirs.push(w)
  mkdirSync(join(w, 'lib'), { recursive: true })
  mkdirSync(join(w, 'resources'), { recursive: true })
  for (const [p, body] of Object.entries(SIBLINGS)) writeFileSync(join(w, p), body)
  // THE MODULE UNDER TEST, COPIED VERBATIM rather than reimplemented — a reimplementation would be a
  // fixture holding the product of the step under test.
  writeFileSync(join(w, 'lib', 'sign-in-support.js'), SUPPORT)
  if (scheduler !== null) writeFileSync(join(w, 'resources', 'Scheduler.js'), scheduler)
  try {
    const mod = await import(`file://${join(w, 'lib', 'sign-in-support.js')}`)
    return { value: await mod.schedulerStatus() }
  } catch (e) { return { threw: String(e?.message ?? e) } }
}

const absent = await statusWith('absent', null)
check('with NO resources/Scheduler.js the answer is a stated absence, not a crash', !absent.threw && absent.value?.scheduler === 'none', absent.threw ?? JSON.stringify(absent.value))
check('…and says what that means in words an administrator can read', /runs no scheduled work/.test(absent.value?.detail ?? ''), absent.value?.detail)

const real = await statusWith('real', "export async function schedulerStatus () { return { scheduler: 'running', loops: 2 } }\n")
check('CONTROL: where the module IS there, its real status comes back untouched', !real.threw && real.value?.scheduler === 'running' && real.value?.loops === 2, real.threw ?? JSON.stringify(real.value))

const silent = await statusWith('silent', 'export const somethingElse = 1\n')
check('a Scheduler that exports no status is `none` with its OWN reason, distinguishable from an absent file', silent.value?.scheduler === 'none' && /reports no status/.test(silent.value?.detail ?? ''), JSON.stringify(silent.value))

const broken = await statusWith('broken', "export async function schedulerStatus () { throw new Error('the loop table could not be read') }\n")
check('**a Scheduler that is there and THROWS is `error`, never `none`** — the false all-clear the bare catch produced', !broken.threw && broken.value?.scheduler === 'error', broken.threw ?? JSON.stringify(broken.value))
check('…carries the reason, so it can be acted on', /loop table could not be read/.test(broken.value?.detail ?? ''), broken.value?.detail)
check('…and is RETURNED rather than thrown, so one broken panel does not 500 the whole admin surface', !broken.threw)

const unparseable = await statusWith('unparseable', 'export async function schedulerStatus ( { syntax error\n')
check('a Scheduler with a syntax error is `error` too — a link failure is not an absence', unparseable.value?.scheduler === 'error', JSON.stringify(unparseable.value))

// **THE CASE THE FIRST FIX STILL GOT WRONG** (the review's second round). A `Scheduler.js` that is
// THERE and imports something that is not also throws `ERR_MODULE_NOT_FOUND` — so keying on the code
// alone reported "no scheduled work" for an application whose scheduler was broken. That is the same
// false all-clear one level deeper, and only a provoked control can tell the two apart.
const nested = await statusWith('nested', "import { nope } from './does-not-exist.js'\nexport async function schedulerStatus () { return { scheduler: 'running' } }\n")
check('**a Scheduler that exists and imports a module that does not is `error`, not `none`** — the same code, a different missing module', nested.value?.scheduler === 'error', JSON.stringify(nested.value))
check('…and its reason names what could not be found, so it can be acted on', /does-not-exist/.test(nested.value?.detail ?? ''), nested.value?.detail)
// AND THE CONTROL BESIDE IT: a genuinely absent Scheduler is still `none`, so the assertion above is
// about which module is missing and not about the branch being unreachable.
check('CONTROL: a genuinely absent Scheduler is still `none`, so the two are distinguished rather than collapsed', absent.value?.scheduler === 'none' && nested.value?.scheduler === 'error')

// **AND THE SHAPE HARPER ACTUALLY GIVES, DRIVEN AND NOT ASSERTED AS A CONSTANT**
// Harper's loader throws the CommonJS
// `MODULE_NOT_FOUND`, with a `Require stack:` in the message and `url: null`, where Node's ESM loader
// throws `ERR_MODULE_NOT_FOUND`. Measured on a real harper@5.3.2 against a real agent-template tree
// with no Scheduler (2026-10-25): the component loaded HEALTHY — so Harper does
// not refuse a dynamic import of an absent module, which was the outcome that would have stopped an
// application starting — and the code was `MODULE_NOT_FOUND`, so keying on the ESM code alone sent
// every headless app to the `error` branch.
//
// No suite running under Node can make Node's loader produce that shape, so a module that THROWS it
// at evaluation stands in: the dynamic import rejects with exactly the error object, which is what
// the `catch` reads. **The message is transcribed from the spike's own output**, relative specifier
// and `Require stack:` suffix included, rather than written to suit the regex — a message shaped to
// pass is a fixture holding the product of the step under test.
const harperThrow = (specifier, code = 'MODULE_NOT_FOUND') =>
  `throw Object.assign(new Error("Cannot find module '${specifier}'\\nRequire stack:\\n- /x/lib/sign-in-support.js"), { code: '${code}', url: null })\n`

const harper = await statusWith('harper', harperThrow('../resources/Scheduler.js'))
check("**Harper's own shape answers `none`** — `MODULE_NOT_FOUND`, `url: null`, a `Require stack:` message", harper.value?.scheduler === 'none' && /runs no scheduled work/.test(harper.value?.detail ?? ''), JSON.stringify(harper.value))

// THE NAME CHECK STILL GUARDS THE BROADER CODE. `MODULE_NOT_FOUND` is CommonJS's code for any
// missing module, not only an absent sibling, so accepting it without asking WHICH module would
// report "no scheduled work" for an application whose scheduler cannot resolve its own dependency.
const harperOther = await statusWith('harper-other', harperThrow('some-package'))
check('CONTROL — the same code naming a DIFFERENT module is `error`, so the name check still guards the broader code', harperOther.value?.scheduler === 'error' && /some-package/.test(harperOther.value?.detail ?? ''), JSON.stringify(harperOther.value))

// AND THE CODE SET IS CONSULTED AND IS NARROW: the Scheduler's own name with a code that is neither
// host's missing-module code is an `error`, so the branch is not reachable by message alone.
const harperWrongCode = await statusWith('harper-wrong-code', harperThrow('../resources/Scheduler.js', 'ERR_INVALID_MODULE_SPECIFIER'))
check('CONTROL — the Scheduler name with a code on NEITHER list is `error`, so the set is read and is narrow', harperWrongCode.value?.scheduler === 'error', JSON.stringify(harperWrongCode.value))

// The set itself, as a secondary — the three cases above are what pin the behaviour; this only says
// the two codes are named rather than one of them being matched some other way.
const { MISSING_MODULE_CODES } = await import(pathToFileURL(join(ROOT, 'lib', 'sign-in-support.js')).href)
check('…and both codes are named in one place rather than spelled at the call site', MISSING_MODULE_CODES.has('MODULE_NOT_FOUND') && MISSING_MODULE_CODES.has('ERR_MODULE_NOT_FOUND') && MISSING_MODULE_CODES.size === 2, [...MISSING_MODULE_CODES].join(', '))

for (const w of workdirs) discard(w)
process.exit(done())
