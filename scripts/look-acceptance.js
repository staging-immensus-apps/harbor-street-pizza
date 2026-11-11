#!/usr/bin/env node
// FIXED — the gate on the restyle seam. Five looks, one apply script, one target file.
//
// WHY THIS SUITE DOES A REAL COMPILE, which is the whole design of it. A token set is the
// shape of the PRE-BAKED FIXTURE defect: `npm run build`
// sat inside the deployer while the core staged the tree first, so the payload carried the
// PREVIOUS build and all 113 hermetic assertions passed, because a suite stages a fixture
// nobody rebuilds. The CI `acceptance` job runs `vite build` BEFORE the suites, so a suite
// that read `web/assets/*.css` would be reading a build of whatever `src/index.css` held at
// that moment — green against a template that ignores every look. So this suite never looks
// at `web/`. It copies the tree, calls the real `applyLook()`, and compiles the result
// itself with the real postcss + tailwind against the fixture's own config, and measures the
// two outputs against each other. The input is produced here; the product is measured here.
//
// The second control is the SEAM'S BLAST RADIUS: `applyLook()` must write `src/index.css`
// and nothing else. That used to be asserted by driving `template-drift-acceptance`'s audit
// over a fixture — "still green after a look is applied, red when `tailwind.config.js` is
// touched" — which measured the right thing through the wrong instrument, and the instrument
// is gone (the template pin is withdrawn; `scripts/template-manifest.js` is what
// is left of it). Two reasons it could not have stayed even if the pin had:
//
//   - IT ASKED THE APP'S HISTORY. That audit compares the tree against `.immensus/template.json`,
//     so on an app whose builder has legitimately edited a seeded file the FIRST assertion —
//     "a faithful copy passes the drift audit" — reds, in a SEEDED suite, over a file this
//     suite has nothing to do with. That is the shape of a suite copied into every app,
//     anchored on something the app is allowed to change.
//   - IT WAS NARROWER THAN THE QUESTION. The pinned set excludes `src/**`, so a look that also
//     wrote `src/App.tsx` passed the audit.
//
// So the measurement is now this suite's own: sha every file in its own fixture, apply the
// look, sha again, and require the changed set to be exactly `src/index.css`. The subject is
// this suite's own operation on its own copy, which is the only thing it was ever entitled to
// assert, and the negative control is the same one as before — touch the theme contract too
// and the comparison has to name it.
//
// THE APP'S OWN `src/index.css` IS IN ONE OF THREE STATES, AND THE STYLESHEET SAYS WHICH.
// The five looks are a starting choice and not a limit. This suite once knew two states — one of the five, or the
// un-looked baseline — so an app with fonts and colours of its own was read as a baseline that had
// drifted and red on every value: a real app's edit failed here on both of its
// passes for doing what the user asked. The third state is a CUSTOM look, declared by
// `CUSTOM_LOOK_LINE` (`scripts/apply-look.js`), and it is held to what every look shares rather than
// to anybody's values: all nineteen colours in both themes, `--radius`, and `.dark` outside
// `@layer base`. It is a declaration and not an inference from "the values differ", because a
// difference is equally what drift looks like and a condition that relaxes a check must be declared
//; an undeclared difference still reds, and its first problem names the line to add.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as harness from './probe/harness.js'
const { ROOT, checker, discard, fixture, read } = harness
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
const appHasPages = harness.appHasPages ?? (() => true)
const declaredAppKind = harness.declaredAppKind ?? (() => '')
const skipForNoPages = harness.skipForNoPages ?? (() => 0)

// ── AN APP WITH NO PAGES HAS NO LOOK, AND THE SKIP HAS TO COME ABOVE THE IMPORTS ────────────
//
// **The problem.** A look is the restyle seam of a React single-page app — nineteen colour
// variables, a radius and a font in `src/index.css`, written by `scripts/apply-look.js` (rule 29).
// Three of the four app kinds have no `src/` to style. On such a tree
// this file did not fail, it **threw at module load**: `ERR_MODULE_NOT_FOUND` for
// `./apply-look.js`. An uncaught throw takes the whole `suites` row down with it, so nineteen
// suites with nothing wrong lose their verdict about an app that is correct.
//
// **WHY THE IMPORTS ARE DYNAMIC, which is the part that is measured rather than tidy.** A static
// `import` is hoisted above every statement in the module, so a skip written above one does not run
// first — the import does. And all three of these are unreachable on the tree this skip exists for:
// `./apply-look.js` is a web-only product script a service template would not ship, and `postcss`
// and `tailwindcss` are `devDependencies`, so a workspace installed for an app with no front end
// has neither. Measured with `esbuild`, `jsdom`, `postcss`, `tailwindcss`, `vite` and `typescript`
// absent from `node_modules`: static imports give exit 1 and a stack trace, and the dynamic form
// below gives exit 0 and a printed skip. This is the same shape and the same reason as
// `page-boot-acceptance.js`'s skip above its `await import('esbuild')`, and that file's header
// carries the measurement for the other half of the toolchain.
//
// The condition is the DECLARED kind and never the tree: `appHasPages` in `probe/harness.js` carries
// why `existsSync('looks/')` or an absent `postcss` would be a route to green rather than a skip.
if (!appHasPages()) process.exit(skipForNoPages('look-acceptance', `no look is expected of a "${declaredAppKind()}" app, so the five token sets, apply-look.js and src/index.css are not asserted`))

const { default: postcss } = await import('postcss')
const { default: tailwindcss } = await import('tailwindcss')
const { SEEDED_PATHS } = await import('./template-manifest.js')
const {
  APP_STYLES_MARKER, BASE_RULES, BASELINE, COLOUR_VARS, CUSTOM_LOOK_LINE, TARGET, applyLook,
  baselineCss, composeIndexCss, isCustomLook, lookById, lookCssPath, lookIds, lookedFrom, manifest,
  provenance, splitLook, stripAtRules, unmanagedCss, unmanagedRefusal,
} = await import('./apply-look.js')

const { check, section, done } = checker('look-acceptance')

/**
 * The declarations inside the first `selector { … }` rule of a stylesheet, as [name, value].
 * The selector is matched at a RULE BOUNDARY, not by `indexOf`: `.dark` also occurs inside
 * `.dark\:bg-x` utilities and inside comments, and a lookup that found one of those would
 * report an empty theme and read as a missing block.
 */
function declsIn (css, selector) {
  const re = new RegExp(`(?:^|[};{/*])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'm')
  const m = re.exec(css)
  if (!m) return null
  const at = m.index + m[0].length - 1
  const open = at
  let depth = 0
  let i = open
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') { depth--; if (depth === 0) break }
  }
  const body = css.slice(open + 1, i)
  return [...body.matchAll(/--([a-z-]+):\s*([^;}]+)[;}]?/g)].map((m) => [m[1], m[2].trim()])
}

const varMap = (css, sel) => Object.fromEntries(declsIn(css, sel) ?? [])

/** Design gives both hsl channels and a hex for review; they must say the same colour. */
function hslToHex (s) {
  const [h, sat, lig] = s.split(/\s+/).map((p) => parseFloat(p))
  const S = sat / 100
  const L = lig / 100
  const k = (n) => (n + h / 30) % 12
  const a = S * Math.min(L, 1 - L)
  const f = (n) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return '#' + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
}

/**
 * Compile a fixture's `src/index.css` the way vite does: real postcss, real tailwind, the
 * fixture's own `tailwind.config.js`. `content` is overridden with absolute paths because
 * the config's globs are relative to a cwd this suite does not change, plus one raw snippet
 * for the arbitrary-value utilities the template does not yet ship a component for.
 */
async function compile (work, extraContent = '') {
  const cfg = (await import(pathToFileURL(join(work, 'tailwind.config.js')).href + `?t=${Math.random()}`)).default
  const content = [join(work, 'index.html'), join(work, 'src/**/*.{ts,tsx}')]
  if (extraContent) content.push({ raw: extraContent, extension: 'html' })
  const out = await postcss([tailwindcss({ ...cfg, content })])
    .process(read(join(work, TARGET)), { from: join(work, TARGET) })
  return out.css
}

/** The paths a fixture needs to be a compilable copy of the template. */
const FIXTURE_PATHS = [...SEEDED_PATHS(ROOT), 'src', 'looks', 'package.json', 'data', 'schema.graphql']

/**
 * Every file under `dir`, as `{relative path: sha1 of its bytes}`. Deliberately not the
 * `walk()` in probe/harness.js: that one filters by extension and skips dotfiles, and what is
 * wanted here is EVERYTHING, so a look that wrote `.gitignore` or a `.yaml` would be seen.
 */
function treeShas (dir, base = dir, out = {}) {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules') continue
    const p = join(dir, f)
    if (statSync(p).isDirectory()) treeShas(p, base, out)
    else out[relative(base, p)] = createHash('sha1').update(readFileSync(p)).digest('hex')
  }
  return out
}

/** The files that differ between two `treeShas()` snapshots, added and removed included. */
function changedBetween (before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((k) => before[k] !== after[k]).sort()
}

const IDS = lookIds(ROOT)
const MF = manifest(ROOT)

// ---------------------------------------------------------------------------------------
section('negative controls')

{
  // A compile that is handed the SAME css twice must report no difference. This is the
  // control for every "two looks differ" assertion below: without it, a comparison that
  // silently compared a string with itself would read as a pass.
  const w = fixture(ROOT, FIXTURE_PATHS, 'look-nc-')
  applyLook(w, IDS[0])
  const a = await compile(w)
  const b = await compile(w)
  check('the compiler is deterministic — the same source twice is byte-identical', a === b)
  check('a self-comparison finds ZERO differing variables (so a real difference means something)',
    diffCount(varMap(a, ':root'), varMap(b, ':root')) === 0)

  // A look file that forgets a variable must be caught, not silently applied.
  writeFileSync(lookCssPath(w, IDS[0]), read(lookCssPath(w, IDS[0])).replace(/\s*--popover-foreground:[^;]+;/, ''))
  check('a look missing one of the nineteen colours is caught',
    missingVars(read(lookCssPath(w, IDS[0]))).includes('popover-foreground'))

  // A manifest that disagrees with the CSS is caught. The two are separate files on purpose
  // — the JSON is what review and the builder's recommendation read, the CSS is what ships —
  // so the gate is the only thing stopping them drifting.
  const m = JSON.parse(read(join(w, 'looks/looks.json')))
  m.looks[0].light.primary.hsl = '1 2% 3%'
  writeFileSync(join(w, 'looks/looks.json'), JSON.stringify(m))
  const skew = manifestSkew(w, m)
  check('a manifest value that disagrees with the look CSS is caught', skew.some((s) => s.includes('primary')), skew.join(' | '))

  // THE CONTROL FOR THE HOIST ITSELF. Reading `.dark` back out
  // of a compiled look proves the hoist works; it does not prove the hoist is still
  // NEEDED. So put `.dark` back inside `@layer base` and compile that: Tailwind must drop
  // it. If this assertion ever reds, Tailwind has stopped tree-shaking class selectors in
  // that layer and `hoistDarkBlock()` has become a no-op nobody is testing — which is the
  // signal to re-check Tailwind's behaviour, not to delete this line.
  // Built from the look's own bytes with NO hoist, rather than by editing a hoisted file:
  // that is the exact shape the template shipped before the hoist existed, and it cannot drift from what
  // the look files hold.
  {
    const w2 = fixture(ROOT, FIXTURE_PATHS, 'look-nc3-')
    const { imports, body } = splitLook(read(lookCssPath(w2, IDS[1])))
    writeFileSync(join(w2, TARGET), [...imports, '', '@tailwind base;', '@tailwind components;', '@tailwind utilities;', '', body, '', BASE_RULES, ''].join('\n'))
    const regressed = await compile(w2)
    check('a .dark block put back INSIDE @layer base is dropped by Tailwind — the reason hoistDarkBlock exists',
      declsIn(regressed, '.dark') === null)
    check('and :root survives the same compile, so the drop is selector-specific and not a parse failure',
      declsIn(regressed, ':root') !== null)
    discard(w2)
  }

  // A marker-less file that holds app CSS must be REFUSED, not silently overwritten — and a
  // marker-less file that holds only the old token block must NOT
  // be refused, because an app generated before the marker existed loses nothing.
  //
  // THE PRE-MARKER BLOCK COMES FROM THE PINNED BASELINE, not from the fixture's own
  // `src/index.css`. Deriving it from the target made these two controls depend on the file
  // `applyLook()` overwrites: on an app that had taken a look they were handed a LOOKED
  // stylesheet, tripped over the `@import` defect covered below, and red. A control
  // that silently relies on the initial state of the file under test is not a control.
  {
    const w3 = fixture(ROOT, FIXTURE_PATHS, 'look-nc4-')
    const base = baselineCss(w3)
    const preMarker = base.slice(0, base.indexOf(APP_STYLES_MARKER)).trimEnd() + '\n'
    writeFileSync(join(w3, TARGET), preMarker)
    check('a marker-less stylesheet with only the token block is NOT refused (no cry wolf)', unmanagedRefusal(w3) === null)

    // THE CONTROL THAT WAS MISSING, for a defect that was live in production. A look's
    // font `@import` is a Google Fonts URL whose weight list is semicolon separated, and
    // `unmanagedCss` ended the at-rule at the first semicolon anywhere — so the residue
    // joined the next rule's prelude, the look's own `@layer base` stopped reading as ours,
    // and a marker-less LOOKED stylesheet was refused, naming bytes `applyLook()` itself
    // wrote as CSS that would be lost. Driven off `composeIndexCss()`'s real output for every
    // look, so it cannot drift from what the script writes or from what Design ships.
    for (const id of IDS) {
      const composed = composeIndexCss(w3, id)
      writeFileSync(join(w3, TARGET), composed.slice(0, composed.indexOf(APP_STYLES_MARKER)).trimEnd() + '\n')
      const cry = unmanagedRefusal(w3)
      check(`a marker-less stylesheet already holding ${id} is NOT refused — the look's own block is ours`,
        cry === null, (cry || '').split('\n')[1] || '')
    }
    // The same thing one level down, on the function rather than the refusal. The import line
    // is READ from a look rather than written here, so a redesign that changes a font
    // cannot turn this control into a no-op — and the first assertion is what stops the rest
    // of the group proving nothing if a future look's URL has no semicolon at all.
    const realImport = splitLook(read(lookCssPath(ROOT, IDS[0]))).imports[0]
    check('a look\'s @import really does carry a semicolon inside its URL (else the next three prove nothing)',
      /;/.test(realImport.replace(/;\s*$/, '')), realImport)
    check('stripAtRules removes an @import whose URL contains semicolons, leaving no residue',
      stripAtRules(`${realImport}\n@layer base { :root { --a: 1 } }\n`).trim() === '@layer base { :root { --a: 1 } }',
      JSON.stringify(stripAtRules(`${realImport}\n`)))
    check('so unmanagedCss reports nothing for that import beside our own blocks',
      unmanagedCss(`${realImport}\n@layer base { :root { --a: 1 } }\n.dark { --a: 2 }\n`) === '')
    check('and the import does not hide app CSS that follows it either',
      unmanagedCss(`${realImport}\n.app-only-rule { outline: 1px solid red; }\n`) === '.app-only-rule { outline: 1px solid red; }')

    writeFileSync(join(w3, TARGET), preMarker + '\n.app-only-rule { outline: 1px solid red; }\n')
    const refusal = unmanagedRefusal(w3)
    check('a marker-less stylesheet that holds app CSS IS refused', refusal !== null)
    check('the refusal names the rule that would be lost and how to keep it',
      /\.app-only-rule/.test(refusal || '') && /--force/.test(refusal || '') && (refusal || '').includes(APP_STYLES_MARKER))
    let threw = false
    try { applyLook(w3, IDS[0]) } catch { threw = true }
    check('applyLook() throws rather than writing', threw && read(join(w3, TARGET)).includes('.app-only-rule'))
    const forced = applyLook(w3, IDS[0], { force: true })
    check('--force writes anyway, which is the operator\'s call and not a stage default', forced.includes('--background'))
    check('unmanagedCss ignores comments, @import, @tailwind and our own blocks',
      unmanagedCss('/* c */\n@import url(x);\n@tailwind base;\n@layer base { :root { --a: 1 } }\n.dark { --a: 2 }\n') === '')
    discard(w3)
  }

  // BOTH BRANCHES of `targetTokenProblems()` driven, because the un-looked one cannot be
  // reached on an app that has taken a look and would otherwise be an untested promise.
  // The mutated variable is taken from COLOUR_VARS — which is parsed
  // out of `apply-look.js` — and the defective value is synthesized, so no control here can
  // quietly become a no-op against a stylesheet whose bytes are formatted differently.
  {
    const w5 = fixture(ROOT, FIXTURE_PATHS, 'look-nc5-')
    const VAR = COLOUR_VARS[COLOUR_VARS.length - 1]
    const bend = (css) => css.replace(new RegExp(`--${VAR}:\\s*[^;]+;`), `--${VAR}: 1 2% 3%;`)

    const base = baselineCss(w5)
    writeFileSync(join(w5, TARGET), base)
    check('un-looked: a faithful copy of the pinned baseline has no problems', targetTokenProblems(w5).length === 0,
      targetTokenProblems(w5).join(' | '))
    writeFileSync(join(w5, TARGET), bend(base))
    check(`un-looked: src/index.css drifting from the pinned baseline on --${VAR} IS caught`,
      targetTokenProblems(w5).some((b) => b.includes(`light.${VAR}`)), targetTokenProblems(w5).join(' | '))

    applyLook(w5, IDS[1])
    check('looked: a stylesheet apply-look just wrote has no problems', targetTokenProblems(w5).length === 0,
      targetTokenProblems(w5).join(' | '))
    const looked = read(join(w5, TARGET))
    writeFileSync(join(w5, TARGET), bend(looked))
    check(`looked: a token hand-edited away from ${IDS[1]}'s own value IS caught`,
      targetTokenProblems(w5).some((b) => b.includes(`light.${VAR}`)), targetTokenProblems(w5).join(' | '))
    writeFileSync(join(w5, TARGET), looked.replace(provenance(IDS[1]), provenance('teal')))
    check('a stylesheet whose provenance names a look the manifest does not have IS caught',
      targetTokenProblems(w5).some((b) => /the manifest does not declare/.test(b)), targetTokenProblems(w5).join(' | '))
    discard(w5)
  }

  // The seam's blast radius, and the control that makes it mean something. `src/index.css` is
  // the one file applyLook() may write; `tailwind.config.js` is the theme CONTRACT the look's
  // variables are consumed through, so a look that rewrote it would be redefining the shape of
  // every app's theme from inside one app's restyle.
  const clean = fixture(ROOT, FIXTURE_PATHS, 'look-nc2-')
  const beforeLook = treeShas(clean)
  applyLook(clean, IDS[2])
  const touched = changedBetween(beforeLook, treeShas(clean))
  check(`applying a look writes exactly ${TARGET} and nothing else`,
    touched.length === 1 && touched[0] === TARGET, touched.join(', ') || '(nothing at all — applyLook wrote no file)')
  // The comparison has to be able to say no, or the assertion above is satisfied by a
  // snapshotter that returns the same thing twice.
  writeFileSync(join(clean, 'tailwind.config.js'), read(join(clean, 'tailwind.config.js')) + '\n// a second write, outside the seam\n')
  const touchedTwo = changedBetween(beforeLook, treeShas(clean))
  check('a second write outside the seam IS named by the same comparison',
    touchedTwo.length === 2 && touchedTwo.includes('tailwind.config.js') && touchedTwo.includes(TARGET), touchedTwo.join(', '))

  discard(w)
  discard(clean)
}

function diffCount (a, b) {
  return COLOUR_VARS.filter((k) => a[k] !== b[k]).length
}

function missingVars (css) {
  const root = varMap(css, ':root')
  const dark = varMap(css, '.dark')
  return COLOUR_VARS.filter((v) => !(v in root) || !(v in dark))
}

/**
 * True when a `.dark { … }` rule sits INSIDE an `@layer base` block, where Tailwind deletes it at
 * build time. Read from the source rather than only from a compile, so a stylesheet that
 * has to be judged on its own words — a custom look, compared with nobody's values — still has the
 * rule applied to it; the compile in the live section is the behavioural half and a control below
 * shows the two agree. Comments are stripped first, because the template's own comment above its
 * `.dark` block explains this very rule and names both selectors.
 */
function darkInsideBaseLayer (css) {
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const layer = /@layer\s+base\s*\{/g
  let m
  while ((m = layer.exec(s))) {
    const open = m.index + m[0].length - 1
    let depth = 0
    let i = open
    for (; i < s.length; i++) {
      if (s[i] === '{') depth++
      else if (s[i] === '}') { depth--; if (depth === 0) break }
    }
    if (/(?:^|[};{])\s*\.dark\s*\{/.test(s.slice(open + 1, i))) return true
  }
  return false
}

/**
 * What is wrong with a root's OWN `src/index.css`, as a list — empty when it is in one of its
 * three legitimate states. Returned rather than asserted so the controls can drive every
 * branch on a fixture; the live section calls it once.
 *
 * The premise is READ off the file rather than assumed: `apply-look.js`'s provenance line names
 * a look, `CUSTOM_LOOK_LINE` declares the app's own, and a file with neither is the un-looked
 * baseline. A looked stylesheet must resolve its own look's values; an un-looked one must resolve
 * the pinned baseline's, which is what stops the baseline and the shipped `src/index.css` drifting
 * apart; a custom one is compared with no values at all, and is held instead to what every look
 * shares — all nineteen colours in both themes and `--radius`. In every state `.dark` must
 * sit outside `@layer base`.
 *
 * Where a looked or un-looked stylesheet's VALUES are wrong, the first problem says how to declare
 * a custom look, because that is the likeliest reason and the remedy is one line — and
 * the label this list is reported under cannot say it, since it describes the state the file
 * claims rather than the one it may have meant.
 */
function targetTokenProblems (root) {
  const live = read(join(root, TARGET))
  const id = lookedFrom(live)
  const custom = isCustomLook(live)
  if (id && custom) {
    return [`${TARGET} says it was written from looks/${id}.css AND declares a custom look; it is one or the other, so remove whichever comment is no longer true`]
  }
  const look = id ? manifest(root).looks.find((l) => l.id === id) : null
  if (id && !look) return [`${TARGET} names look "${id}", which the manifest does not declare`]
  const bad = []
  if (darkInsideBaseLayer(live)) {
    bad.push(`${TARGET} declares .dark inside @layer base, where Tailwind deletes it at build time; move the .dark block out of the layer`)
  }
  if (custom) {
    for (const [mode, sel] of [['light', ':root'], ['dark', '.dark']]) {
      const have = varMap(live, sel)
      const missing = COLOUR_VARS.filter((v) => !have[v])
      if (missing.length) bad.push(`custom look, ${mode} (${sel}): no value for ${missing.map((v) => `--${v}`).join(', ')}`)
    }
    if (!varMap(live, ':root').radius) bad.push('custom look: no --radius under :root')
    return bad
  }
  const values = []
  for (const [mode, sel] of [['light', ':root'], ['dark', '.dark']]) {
    const have = varMap(live, sel)
    const want = look
      ? Object.fromEntries(COLOUR_VARS.map((v) => [v, look[mode][v].hsl]))
      : varMap(baselineCss(root), sel)
    const source = look ? `${id}'s` : "the pinned baseline's"
    for (const v of COLOUR_VARS) {
      if (have[v] !== want[v]) values.push(`${mode}.${v}: ${have[v]} ≠ ${source} ${want[v]}`)
    }
  }
  const radius = look ? look.radius : varMap(baselineCss(root), ':root').radius
  if (varMap(live, ':root').radius !== radius) {
    values.push(`--radius: ${varMap(live, ':root').radius} ≠ ${look ? `${id}'s` : "the baseline's"} ${radius}`)
  }
  if (values.length) {
    bad.push(look
      ? `${TARGET} says it holds look "${id}" and its values are not ${id}'s. If they are this app's own fonts and colours, replace the "Written by scripts/apply-look.js" comment with ${CUSTOM_LOOK_LINE}; to go back to ${id}, re-apply it`
      : `${TARGET} names no look and its values are not the pinned baseline's. If they are this app's own fonts and colours, put ${CUSTOM_LOOK_LINE} above the tokens; otherwise restore the baseline's values`)
    bad.push(...values)
  }
  return bad
}

/**
 * A custom look written from nothing, for the controls: every colour token in both themes, a
 * radius, Arial on `body`, `.dark` outside `@layer base` and the marker — the shape a real app's
 * edit produced, declared or not. SYNTHESIZED rather than derived by editing a stylesheet,
 * so no control here can turn into a no-op against a file formatted differently, and built
 * off `COLOUR_VARS` so a token added there is a token this sheet carries.
 */
const ARIAL = 'Arial, Helvetica, sans-serif'
const GREEN = {
  light: {
    background: '0 0% 100%', foreground: '150 30% 8%', card: '0 0% 100%', 'card-foreground': '150 30% 8%',
    popover: '0 0% 100%', 'popover-foreground': '150 30% 8%', primary: '142 71% 35%', 'primary-foreground': '0 0% 100%',
    secondary: '140 30% 94%', 'secondary-foreground': '142 60% 18%', muted: '140 20% 95%', 'muted-foreground': '145 10% 40%',
    accent: '140 50% 90%', 'accent-foreground': '142 60% 18%', destructive: '0 84.2% 60.2%', 'destructive-foreground': '0 0% 100%',
    border: '140 20% 86%', input: '140 20% 86%', ring: '142 71% 35%',
  },
  dark: {
    background: '150 30% 6%', foreground: '140 20% 96%', card: '150 30% 8%', 'card-foreground': '140 20% 96%',
    popover: '150 30% 8%', 'popover-foreground': '140 20% 96%', primary: '142 69% 58%', 'primary-foreground': '150 30% 6%',
    secondary: '150 20% 15%', 'secondary-foreground': '140 20% 96%', muted: '150 20% 15%', 'muted-foreground': '140 10% 65%',
    accent: '150 25% 18%', 'accent-foreground': '140 20% 96%', destructive: '0 62.8% 30.6%', 'destructive-foreground': '140 20% 96%',
    border: '150 20% 15%', input: '150 20% 15%', ring: '142 69% 58%',
  },
}

function customSheet ({ declare = true, omit = {}, radius = '0.5rem', darkInLayer = false, above = null, marker = true, below = '' } = {}) {
  const decls = (mode, indent) => COLOUR_VARS
    .filter((v) => !(omit[mode] || []).includes(v))
    .map((v) => `${indent}--${v}: ${GREEN[mode][v] ?? '142 50% 50%'};`)
  const dark = (indent) => [`${indent}.dark {`, ...decls('dark', indent + '  '), `${indent}}`]
  return [
    '@tailwind base;', '@tailwind components;', '@tailwind utilities;', '',
    declare ? CUSTOM_LOOK_LINE : '/* The app\'s theme: Arial, and green. */',
    above,
    '@layer base {',
    '  :root {', ...decls('light', '    '), radius ? `    --radius: ${radius};` : null, '  }',
    ...(darkInLayer ? dark('  ') : []),
    '  * { @apply border-border; }',
    `  body { @apply bg-background text-foreground antialiased; font-family: ${ARIAL}; }`,
    '}', '',
    ...(darkInLayer ? [] : dark('')),
    '',
    marker ? APP_STYLES_MARKER : null,
    below || null,
    '',
  ].filter((l) => l !== null).join('\n')
}

function manifestSkew (root, mf = manifest(root)) {
  const bad = []
  for (const look of mf.looks) {
    const css = read(lookCssPath(root, look.id))
    for (const [mode, sel] of [['light', ':root'], ['dark', '.dark']]) {
      const declared = varMap(css, sel)
      for (const [name, value] of Object.entries(look[mode])) {
        if (declared[name] !== value.hsl) bad.push(`${look.id}.${mode}.${name}: css ${declared[name]} ≠ manifest ${value.hsl}`)
      }
    }
  }
  return bad
}

// ---------------------------------------------------------------------------------------
section('the five looks are a complete token set')

check(`the manifest names five looks in order (${IDS.join(', ')})`, IDS.length === 5 && MF.looks.length === 5)
check('no look is the global default — the builder recommends one per app',
  /no global default/.test(MF.recommendedBy) && !('default' in MF))

for (const id of IDS) {
  const p = lookCssPath(ROOT, id)
  check(`looks/${id}.css exists`, existsSync(p))
  const css = read(p)
  const root = varMap(css, ':root')
  const dark = varMap(css, '.dark')
  check(`${id}: all ${COLOUR_VARS.length} colours under :root`, COLOUR_VARS.every((v) => v in root), COLOUR_VARS.filter((v) => !(v in root)).join(', '))
  check(`${id}: all ${COLOUR_VARS.length} colours under .dark`, COLOUR_VARS.every((v) => v in dark), COLOUR_VARS.filter((v) => !(v in dark)).join(', '))
  check(`${id}: --radius under :root`, 'radius' in root && root.radius === MF.looks.find((l) => l.id === id).radius)
  // Both themes or neither: a variable declared only on :root reads as the light value in
  // dark mode and looks like a deliberate choice rather than an omission.
  check(`${id}: no colour is declared in one theme only`,
    Object.keys(root).filter((k) => k !== 'radius').sort().join() === Object.keys(dark).sort().join())
  // The font has to be bound twice to work: the @import fetches it, the body rule applies
  // it. Either alone renders the fallback and looks like a font that failed to load.
  const look = MF.looks.find((l) => l.id === id)
  check(`${id}: the @import names ${look.font.family}`, css.includes(look.font.google))
  check(`${id}: body font-family is the manifest's stack`, new RegExp(`body\\s*{[^}]*font-family:\\s*${look.font.stack.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(css))
}

{
  const skew = manifestSkew(ROOT)
  check(`the manifest and the CSS agree variable-for-variable in both modes (${IDS.length * 2 * COLOUR_VARS.length} pairs)`, skew.length === 0, skew.slice(0, 6).join('\n'))
  const hexBad = []
  let pairs = 0
  for (const look of MF.looks) {
    for (const mode of ['light', 'dark']) {
      for (const [name, v] of Object.entries(look[mode])) {
        pairs++
        if (hslToHex(v.hsl) !== v.hex) hexBad.push(`${look.id}.${mode}.${name}: ${v.hsl} → ${hslToHex(v.hsl)} ≠ ${v.hex}`)
      }
    }
  }
  check(`every manifest hsl converts to its stated hex (${pairs} pairs)`, hexBad.length === 0, hexBad.slice(0, 6).join('\n'))
}

// ---------------------------------------------------------------------------------------
section('the un-looked baseline declares the same variables')

{
  // The gap this section closes: the template declared seventeen colours and a look sets nineteen.
  // An app that takes NO look still has to resolve every variable a component may read, or
  // `--popover` is empty in exactly the apps nobody chose a look for.
  //
  // READ FROM `looks/baseline.css`, NOT FROM `src/index.css`. This section's TITLE said
  // "the un-looked baseline" while its subject was a file `applyLook()` overwrites, so on an
  // app that had taken a look it went on passing while silently testing the look — a look
  // also declares nineteen colours in both themes, `--radius` and the marker. An assertion
  // that quietly changes subject is worse than one that fails, because nothing reports it.
  const css = baselineCss(ROOT)
  const root = varMap(css, ':root')
  const dark = varMap(css, '.dark')
  check(`the baseline declares all ${COLOUR_VARS.length} colours under :root`, COLOUR_VARS.every((v) => v in root), COLOUR_VARS.filter((v) => !(v in root)).join(', '))
  check(`the baseline declares all ${COLOUR_VARS.length} colours under .dark`, COLOUR_VARS.every((v) => v in dark), COLOUR_VARS.filter((v) => !(v in dark)).join(', '))
  check('the baseline declares --radius', 'radius' in root)
  check('the baseline carries the app-styles marker, so a first apply preserves app CSS', css.includes(APP_STYLES_MARKER))
  check('the baseline names no look and declares no custom one — it is the un-looked reference',
    lookedFrom(css) === null && !isCustomLook(css))
  check(`${BASELINE} is NOT a sixth look: lookIds() excludes it and lookById() refuses it`,
    !lookIds(ROOT).includes('baseline') && (() => {
      try { lookById(ROOT, 'baseline'); return false } catch (e) { return /no look named/.test(e.message) }
    })())
  // The provenance line is the premise this suite reads off a stylesheet rather than assumes,
  // so the writer and the reader of it must not be able to disagree.
  check('lookedFrom() round-trips provenance() for every look id', IDS.every((id) => lookedFrom(provenance(id)) === id))

  // Every look's font comes from the same two hosts, so the hint is look-agnostic and lives
  // in the FIXED index.html. It shortens the chain; it does not remove it.
  // Comments stripped first: the hint is explained in a comment right above itself, and a
  // regex that matched the explanation would hold if the link elements were ever deleted.
  const html = read(join(ROOT, 'index.html')).replace(/<!--[\s\S]*?-->/g, '')
  check('index.html preconnects to both Google font hosts', /preconnect[^>]*fonts\.googleapis\.com/.test(html) && /preconnect[^>]*fonts\.gstatic\.com/.test(html))
  check('and that assertion reads the markup, not the comment explaining it', !/<!--/.test(html) && /<link/.test(html))
  check('every look\'s font is served by one of those two hosts, so the hint stays look-agnostic',
    MF.looks.every((l) => l.font.google.startsWith('https://fonts.googleapis.com/')))
}

// ---------------------------------------------------------------------------------------
section('a custom look: the app\'s own fonts and colours, declared')

{
  // THE DECLARATION AND ITS READER, which everything below rests on. If `isCustomLook()` matched
  // the provenance `apply-look.js` writes, every looked stylesheet would read as custom AND looked
  // and be refused as a contradiction; if it matched prose that merely mentions a custom look, a
  // comment could switch off the baseline comparison by accident.
  check('CUSTOM_LOOK_LINE is one complete CSS comment on one line',
    CUSTOM_LOOK_LINE.startsWith('/*') && CUSTOM_LOOK_LINE.endsWith('*/') &&
    CUSTOM_LOOK_LINE.indexOf('*/') === CUSTOM_LOOK_LINE.length - 2 && !CUSTOM_LOOK_LINE.includes('\n'))
  check('isCustomLook() reads CUSTOM_LOOK_LINE', isCustomLook(CUSTOM_LOOK_LINE))
  check('isCustomLook() does NOT read the phrase part-way through some other comment, nor in lower case',
    !isCustomLook('/* this app has no Custom look: it took harbor */') && !isCustomLook('/* custom look: lower case */'))
  check('and it DOES read a line whose opening is right and whose tail was reworded — only the opening is required',
    isCustomLook('/* Custom look: Arial and green, chosen by the user. */'))
  check('no look\'s provenance line reads as custom, though it tells the reader how to declare one',
    IDS.every((id) => !isCustomLook(provenance(id)) && provenance(id).includes('"Custom look:"') && /CUSTOM_LOOK_LINE/.test(provenance(id))))

  const w = fixture(ROOT, FIXTURE_PATHS, 'look-custom-')
  check('no stylesheet apply-look composes reads as custom, for any of the five',
    IDS.every((id) => !isCustomLook(composeIndexCss(w, id))))

  // THE REFERENCE CASE, reproduced: a real app's edit asked for Arial and
  // green, the Frontend wrote them as the tokens and took out the comment naming the old look, and
  // this suite red with "src/index.css names no look, so every value is the pinned baseline's, in
  // both themes". An undeclared hand-styled sheet STILL fails — a difference from the baseline is
  // also what drift looks like — and what changed is that the first thing it says is the fix.
  writeFileSync(join(w, TARGET), customSheet({ declare: false }))
  const undeclared = targetTokenProblems(w)
  check('THE REFERENCE CASE: Arial and green with NO declaration is still read as the baseline, and fails',
    undeclared.some((b) => b.startsWith('light.primary:')) && undeclared.some((b) => b.startsWith('dark.primary:')), undeclared.slice(0, 3).join(' | '))
  check('and the first problem it reports names CUSTOM_LOOK_LINE, verbatim, as the way to declare it',
    (undeclared[0] || '').includes(CUSTOM_LOOK_LINE), undeclared[0])

  // THE POSITIVE CONTROL: the same bytes plus the line. Nothing else differs between this and the
  // reference case, so the declaration is the whole of what turned the verdict.
  writeFileSync(join(w, TARGET), customSheet())
  const declared = targetTokenProblems(w)
  check('the same Arial-and-green stylesheet WITH CUSTOM_LOOK_LINE has no problems', declared.length === 0, declared.join(' | '))
  check('and it reads as custom and as no look', isCustomLook(read(join(w, TARGET))) && lookedFrom(read(join(w, TARGET))) === null)

  // What a custom look is still held to, each driven: one colour missing in each theme, the
  // radius missing, and `.dark` put back inside `@layer base`. The omitted token is taken from
  // `COLOUR_VARS`, not named here, so the control follows the token list.
  const LAST = COLOUR_VARS[COLOUR_VARS.length - 1]
  writeFileSync(join(w, TARGET), customSheet({ omit: { dark: [LAST] } }))
  check(`a custom look with no --${LAST} under .dark IS caught`,
    targetTokenProblems(w).some((b) => b.startsWith('custom look, dark') && b.includes(`--${LAST}`)), targetTokenProblems(w).join(' | '))
  writeFileSync(join(w, TARGET), customSheet({ omit: { light: [COLOUR_VARS[0]] } }))
  check(`a custom look with no --${COLOUR_VARS[0]} under :root IS caught`,
    targetTokenProblems(w).some((b) => b.startsWith('custom look, light') && b.includes(`--${COLOUR_VARS[0]}`)), targetTokenProblems(w).join(' | '))
  writeFileSync(join(w, TARGET), customSheet({ radius: null }))
  check('a custom look with no --radius IS caught', targetTokenProblems(w).some((b) => /no --radius/.test(b)), targetTokenProblems(w).join(' | '))

  writeFileSync(join(w, TARGET), customSheet({ darkInLayer: true }))
  check('a custom look with .dark INSIDE @layer base IS caught',
    targetTokenProblems(w).some((b) => /\.dark inside @layer base/.test(b)), targetTokenProblems(w).join(' | '))
  // The source rule is not an invention of this suite: compile the same sheet and the real
  // pipeline drops the dark theme, which is the defect the rule exists for.
  const dropped = await compile(w)
  check('and the real compile of that sheet has no .dark rule at all — the source rule and the compiler agree',
    declsIn(dropped, '.dark') === null && declsIn(dropped, ':root') !== null)
  // Comments are stripped before the layer is read: the template's own comment above its `.dark`
  // names both selectors, and an old block commented out INSIDE the layer is not a rule. Written so
  // that, unstripped, the commented block would match — a `;` and a newline before `.dark {`.
  check('the source rule does not fire on a .dark block that is commented out inside @layer base',
    !darkInsideBaseLayer('@layer base {\n  :root { --a: 1; }\n  /* it moved out of the layer;\n  .dark { --a: 2; } */\n}\n.dark { --a: 2; }\n'))

  // Declaring custom and naming a look at once is a stylesheet that says two things about itself.
  writeFileSync(join(w, TARGET), customSheet({ above: provenance(IDS[0]) }))
  check('a stylesheet that declares a custom look AND names a look IS caught as saying both',
    targetTokenProblems(w).some((b) => /one or the other/.test(b)), targetTokenProblems(w).join(' | '))

  // THE EDIT ROUTE, which is how a real app got there: a stylesheet apply-look wrote, its tokens then
  // changed by hand. Left naming the old look it fails against that look's values, with the fix
  // first; with the provenance comment replaced by the line it passes. The provenance is replaced
  // by the string `provenance()` itself returns, so this follows any rewording of it.
  applyLook(w, IDS[1])
  const looked = read(join(w, TARGET))
  const recoloured = looked.replace(new RegExp(`--primary:\\s*[^;]+;`), `--primary: ${GREEN.light.primary};`)
  check('PRECONDITION: the recolour really changed a token, so the next two prove something', recoloured !== looked)
  writeFileSync(join(w, TARGET), recoloured)
  const stale = targetTokenProblems(w)
  check(`a looked stylesheet recoloured by hand but still naming ${IDS[1]} fails, and says first how to declare it`,
    stale.some((b) => b.startsWith('light.primary:')) && (stale[0] || '').includes(CUSTOM_LOOK_LINE) && (stale[0] || '').includes('re-apply'), stale.slice(0, 2).join(' | '))
  writeFileSync(join(w, TARGET), recoloured.replace(provenance(IDS[1]), CUSTOM_LOOK_LINE))
  check('and the same stylesheet with its provenance replaced by CUSTOM_LOOK_LINE passes',
    targetTokenProblems(w).length === 0, targetTokenProblems(w).join(' | '))

  // Applying one of the five over a custom look replaces it — the declaration goes with the tokens
  // — and keeps what is below the marker. A marker-less custom sheet holding only token blocks is
  // not refused, because nothing in it would be lost (the cry-wolf half of `unmanagedRefusal`).
  writeFileSync(join(w, TARGET), customSheet({ below: '.app-only-rule { outline: 1px solid red; }' }))
  const over = applyLook(w, IDS[2])
  check(`applying ${IDS[2]} over a custom look replaces it: names ${IDS[2]}, no longer custom, app CSS kept`,
    lookedFrom(over) === IDS[2] && !isCustomLook(over) && over.includes('.app-only-rule') && targetTokenProblems(w).length === 0,
    targetTokenProblems(w).join(' | '))
  writeFileSync(join(w, TARGET), customSheet({ marker: false }))
  check('a marker-less custom stylesheet holding only token blocks is NOT refused by apply-look', unmanagedRefusal(w) === null, unmanagedRefusal(w) || '')

  // A REAL COMPILE of the declared custom look, because a custom look is the state no look file
  // vouches for: its values have to survive the pipeline in both themes, and its font with them.
  writeFileSync(join(w, TARGET), customSheet())
  const compiled = await compile(w)
  check('the custom look compiles, and every colour it set survives into :root and .dark with its own value',
    COLOUR_VARS.every((v) => varMap(compiled, ':root')[v] === GREEN.light[v] && varMap(compiled, '.dark')[v] === GREEN.dark[v]),
    COLOUR_VARS.filter((v) => varMap(compiled, ':root')[v] !== GREEN.light[v] || varMap(compiled, '.dark')[v] !== GREEN.dark[v]).join(', '))
  check('and its font reaches body in the compiled CSS', new RegExp(`font-family:\\s*${ARIAL}`).test(compiled))
  discard(w)
}

// ---------------------------------------------------------------------------------------
section('this app\'s own src/index.css, in whichever of its three states it is in')

{
  // `src/index.css` is the APP's file, and in a generated app it has taken a look. It is
  // still worth asserting on — it is the stylesheet that actually ships — but the RIGHT
  // assertion depends on its state, which is why the section above could not be it.
  //
  // So the premise is READ off the file (the provenance line, or `CUSTOM_LOOK_LINE`) rather than
  // assumed, and every branch asserts: none is a skip. A suite that skipped on the looked branch
  // would be green in every real app while testing nothing there, which is the degraded-instrument
  // shape — an instrument that stops discriminating goes green, not red. The custom branch is
  // compared with no look's values, so what it asserts is the shared shape, and the real compile
  // below is what shows its values survive.
  const live = read(join(ROOT, TARGET))
  const id = lookedFrom(live)
  const root = varMap(live, ':root')
  const dark = varMap(live, '.dark')

  check(`${TARGET} resolves all ${COLOUR_VARS.length} colours under :root`,
    COLOUR_VARS.every((v) => v in root), COLOUR_VARS.filter((v) => !(v in root)).join(', '))
  check(`${TARGET} resolves all ${COLOUR_VARS.length} colours under .dark`,
    COLOUR_VARS.every((v) => v in dark), COLOUR_VARS.filter((v) => !(v in dark)).join(', '))
  check(`${TARGET} declares --radius and carries the app-styles marker`,
    'radius' in root && live.includes(APP_STYLES_MARKER))
  check(`${TARGET} keeps the template's base rules, look or no look`,
    live.includes('@apply border-border') && live.includes('@apply bg-background text-foreground antialiased'))

  // The two branches live in `targetTokenProblems()` so they can be DRIVEN: the `else` branch
  // is unreachable on an app that has taken a look, so without a control it would be a
  // promise nobody can test — the drift guard between `looks/baseline.css` and `src/index.css`
  // has to be shown able to say no. Both branches are controlled in `negative controls` above.
  const problems = targetTokenProblems(ROOT)
  const custom = isCustomLook(live)
  check(id && custom
    ? `${TARGET} names look "${id}" and declares a custom look — one or the other`
    : id
      ? `every colour and the radius in ${TARGET} is look "${id}"'s own value, in both themes`
      : custom
        ? `${TARGET} declares a custom look: all ${COLOUR_VARS.length} colours in both themes, --radius, and .dark outside @layer base`
        : `${TARGET} names no look and declares no custom one, so every value is the pinned baseline's, in both themes`,
  problems.length === 0, problems.slice(0, 6).join(' | '))

  // And a REAL compile of whatever this app actually ships, because the one defect that is
  // invisible in the source is this one: a `.dark` block inside `@layer base` is
  // tree-shaken away and only the compiled stylesheet shows it. Every other compile in this
  // suite applies a look first; this one compiles the app's own file untouched.
  const w = fixture(ROOT, FIXTURE_PATHS, 'look-live-')
  const compiled = await compile(w)
  check(`${TARGET} compiles, and all ${COLOUR_VARS.length} colours survive into :root`,
    COLOUR_VARS.every((v) => varMap(compiled, ':root')[v]),
    COLOUR_VARS.filter((v) => !varMap(compiled, ':root')[v]).join(', '))
  check(`${TARGET} compiles, and all ${COLOUR_VARS.length} colours survive into .dark (the tree-shake)`,
    declsIn(compiled, '.dark') !== null && COLOUR_VARS.every((v) => varMap(compiled, '.dark')[v]),
    declsIn(compiled, '.dark') === null ? 'the .dark rule is GONE from the compiled CSS' : COLOUR_VARS.filter((v) => !varMap(compiled, '.dark')[v]).join(', '))
  discard(w)
}

// ---------------------------------------------------------------------------------------
section('applying a look is idempotent and preserves app CSS')

{
  const w = fixture(ROOT, FIXTURE_PATHS, 'look-apply-')
  // START FROM THE PINNED BASELINE, not from whatever `src/index.css` holds. Every
  // assertion below describes going from un-looked to looked, and on an app that already held
  // `harbor` the first of them CONTRADICTED the third: applying harbor to a harbor stylesheet
  // writes identical bytes, which is the idempotence this section goes on to require. The
  // fixture has to supply the state the assertions are about.
  const target = join(w, TARGET)
  writeFileSync(target, baselineCss(w) + '\n.app-only-rule { outline: 1px solid red; }\n')

  // Compared with the fixture's OWN pre-apply bytes rather than with `ROOT/src/index.css`,
  // for the same reason: the latter is the file `applyLook()` overwrites.
  const unapplied = read(target)
  const first = applyLook(w, 'harbor')
  check('applying a look rewrites src/index.css', first !== unapplied)
  check('app CSS below the marker survives the apply', first.includes('.app-only-rule'))
  check('the marker is still there afterwards', first.includes(APP_STYLES_MARKER))
  check('the @import is the first line — CSS requires it before any rule', first.startsWith('@import url('))
  check('@tailwind base/components/utilities all survive', ['base', 'components', 'utilities'].every((d) => first.includes(`@tailwind ${d};`)))
  check("the template's own base rules survive (border-border, body colours)",
    first.includes('@apply border-border') && first.includes('@apply bg-background text-foreground antialiased'))

  const second = applyLook(w, 'harbor')
  check('applying the same look twice is byte-identical', first === second)
  applyLook(w, 'bloom')
  const back = applyLook(w, 'harbor')
  check('A → B → A returns the same bytes (a founder may change their mind twice)', back === first)
  check('app CSS still survives after three applies', back.includes('.app-only-rule'))
  check('exactly ONE copy of the app rule survives — the tail is replaced, never appended',
    back.split('.app-only-rule').length - 1 === 1)
  check('exactly one :root block and one .dark block', (back.match(/:root\s*{/g) || []).length === 1 && (back.match(/\.dark\s*{/g) || []).length === 1)
  check('an unknown look id is refused rather than written', (() => {
    try { composeIndexCss(w, 'teal'); return false } catch (e) { return /no look named/.test(e.message) }
  })())
  discard(w)
}

// ---------------------------------------------------------------------------------------
section('two looks, really compiled, really different — in both themes')

{
  // Not "the file changed": the values that the looks disagree about must differ in the
  // compiled output and the values they agree about must still agree, light AND dark. The
  // pair is chosen for being the two furthest apart in the manifest and is read FROM the
  // manifest rather than asserted as a constant, so a redesign that re-colours a look
  // cannot make this assertion stale.
  const A = 'harbor'
  const B = 'bloom'
  const UTILS = '<div class="bg-[hsl(var(--popover))] text-[hsl(var(--popover-foreground))] rounded-lg border-border"></div>'
  const w = fixture(ROOT, FIXTURE_PATHS, 'look-diff-')

  // THE UN-LOOKED REFERENCE IS THE PINNED BASELINE, NOT WHATEVER `src/index.css` HOLDS.
  // Compiling the fixture's own target first made this suite the thing it was written against:
  // on an app that had taken look A, `baseline` WAS look A, so "a looked build is NOT the
  // un-looked baseline" compared harbor with harbor and red. The fixture's own file is
  // compiled too, in its own section above — as the app's stylesheet, which is what it is.
  writeFileSync(join(w, TARGET), baselineCss(w))
  const baseline = await compile(w, UTILS)

  applyLook(w, A)
  const a = await compile(w, UTILS)
  applyLook(w, B)
  const b = await compile(w, UTILS)

  for (const [mode, sel] of [['light', ':root'], ['dark', '.dark']]) {
    const va = varMap(a, sel)
    const vb = varMap(b, sel)
    const ma = MF.looks.find((l) => l.id === A)[mode]
    const mb = MF.looks.find((l) => l.id === B)[mode]
    const shouldDiffer = COLOUR_VARS.filter((v) => ma[v].hsl !== mb[v].hsl)
    const shouldAgree = COLOUR_VARS.filter((v) => ma[v].hsl === mb[v].hsl)
    check(`${mode}: the compiled output declares all ${COLOUR_VARS.length} colours for both looks`,
      COLOUR_VARS.every((v) => va[v] && vb[v]))
    check(`${mode}: all ${shouldDiffer.length} colours the two looks disagree about DIFFER in the compiled CSS`,
      shouldDiffer.length > 0 && shouldDiffer.every((v) => va[v] !== vb[v]),
      shouldDiffer.filter((v) => va[v] === vb[v]).join(', '))
    check(`${mode}: the ${shouldAgree.length} colours they agree about still AGREE`,
      shouldAgree.every((v) => va[v] === vb[v]), shouldAgree.filter((v) => va[v] !== vb[v]).join(', '))
    check(`${mode}: every compiled value is the look's own, not the baseline's`,
      COLOUR_VARS.every((v) => va[v] === ma[v].hsl) && COLOUR_VARS.every((v) => vb[v] === mb[v].hsl))
  }

  // The baseline is the negative control: if applyLook were a no-op, `a` would equal it.
  check('a looked build is NOT the un-looked baseline', a !== baseline && b !== baseline)
  const bl = varMap(baseline, ':root')
  check('no baseline colour value survives into a looked build where the look sets another',
    COLOUR_VARS.filter((v) => bl[v] !== varMap(a, ':root')[v]).length > 0)

  // The font is the one part of a look that is not a colour, and the one that fails
  // silently: a missing @import renders the fallback and looks like a slow network.
  for (const [id, css] of [[A, a], [B, b]]) {
    const look = MF.looks.find((l) => l.id === id)
    check(`${id}: the compiled CSS keeps the @import at the top`, css.trimStart().startsWith('@import url('))
    check(`${id}: the compiled CSS sets body font-family to ${look.font.family}`, css.includes(look.font.stack))
  }

  // --radius is the only non-colour token, and it reaches components through
  // tailwind.config.js's borderRadius map rather than directly.
  check('the two looks have different radii', MF.looks.find((l) => l.id === A).radius !== MF.looks.find((l) => l.id === B).radius)
  check('--radius reaches .rounded-lg through the FIXED theme map', /\.rounded-lg\s*{\s*border-radius:\s*var\(--radius\)/.test(a))
  check(`--radius differs in the compiled output (${varMap(a, ':root').radius} vs ${varMap(b, ':root').radius})`,
    varMap(a, ':root').radius !== varMap(b, ':root').radius)

  // Why nineteen and not seventeen: a component that reads --popover must resolve it. There
  // is no `popover` colour in tailwind.config.js and that file is FIXED, so the kit reaches
  // it by arbitrary value — which is what is compiled and asserted here.
  for (const [id, css] of [[A, a], [B, b]]) {
    check(`${id}: a component using --popover compiles to a rule that reads it`,
      /\.bg-\\\[hsl\\\(var\\\(--popover\\\)\\\)\\\]\s*{\s*background-color:\s*hsl\(var\(--popover\)\)/.test(css))
    check(`${id}: --popover and --popover-foreground resolve in BOTH themes`,
      varMap(css, ':root').popover && varMap(css, ':root')['popover-foreground'] &&
      varMap(css, '.dark').popover && varMap(css, '.dark')['popover-foreground'])
  }
  check('the two looks\' --popover values differ in dark mode too',
    varMap(a, '.dark').popover !== varMap(b, '.dark').popover)

  discard(w)
}

// ---------------------------------------------------------------------------------------
section('every look compiles')

{
  const w = fixture(ROOT, FIXTURE_PATHS, 'look-all-')
  const seen = new Set()
  for (const id of IDS) {
    // Snapshotted either side of applyLook() and BEFORE the compile, so the measurement is of
    // applyLook alone rather than of anything postcss might leave behind.
    const before = treeShas(w)
    applyLook(w, id)
    const touched = changedBetween(before, treeShas(w))
    // NOTHING OUTSIDE THE SEAM, rather than "exactly one file changed", and the difference is
    // load-bearing for an app that SHIPS one of the five. This loop applies every look in
    // `order` over a fixture of the app's OWN src/, so the iteration for the look the app already
    // wears re-composes bytes identical to the ones on disk — applyLook() is a pure compose +
    // writeFileSync with no diffing, so the sha does not move and `touched` is EMPTY. Demanding
    // `length === 1` therefore failed every app whose look is IDS[0], from the app's own data and
    // with nothing wrong with it (this one: CLAUDE.md §1 chose `studio`, and `order` lists studio
    // first). A no-op rewrite of the target is not a blast-radius defect, and the two things that
    // assertion was carrying are both still asserted, each where it can say no: the strict
    // "exactly TARGET and nothing else" lives above with a negative control that adds a second
    // write and requires the comparison to name it, and "the look actually took" is the distinct
    // -stylesheet check below, which reads the compiled CSS rather than the file set.
    check(`${id}: applying it writes nothing outside ${TARGET}`,
      touched.every((f) => f === TARGET), touched.join(', '))
    let css = ''
    let err = null
    try { css = await compile(w) } catch (e) { err = e }
    check(`${id} compiles with the real tailwind pipeline`, !err, err?.message)
    check(`${id} produces a distinct stylesheet`, css.length > 0 && !seen.has(css))
    seen.add(css)
  }
  discard(w)
}

process.exit(done())
