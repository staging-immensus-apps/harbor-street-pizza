#!/usr/bin/env node
// FIXED — rule 16: every runtime import from resources/, lib/ and routes/
// resolves to `dependencies`. Fabric installs with `npm install --omit=dev`, so one runtime
// import of a devDependency link-fails EVERY resource (`ERR_VM_MODULE_LINK_FAILURE`).
// `harperdb` is the host and is never listed; node builtins are always linkable.
//
// AND THE SAME SUBJECT ONE LEVEL OUT: an import that resolves in THIS checkout and not
// where the code actually runs. Rule 16's version is a devDependency against `--omit=dev`; the
// harness-boundary section at the bottom of this file is the test harness against a generated
// app, which does not have one. Both are "green here, broken there", which is why they live in
// one suite rather than two.
//
// Hermetic: reads package.json and source bytes, no install, no network, no clock.

import { join, resolve, dirname, sep } from 'node:path'
import { existsSync, writeFileSync, rmSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { ROOT, checker, fixture, discard, walk, read, importSpecifiers, stripComments } from './probe/harness.js'

const HOST = new Set(['harperdb'])
const BUILTINS = new Set(builtinModules)

export function packageName (spec) {
  if (spec.startsWith('@')) { const [scope, name] = spec.split('/'); return `${scope}/${name}` }
  return spec.split('/')[0]
}

export function audit (root) {
  const bad = []
  let pkg
  try { pkg = JSON.parse(read(join(root, 'package.json'))) } catch { return ['package.json does not parse'] }
  const deps = new Set(Object.keys(pkg.dependencies ?? {}))
  const dev = new Set(Object.keys(pkg.devDependencies ?? {}))
  const used = new Set()
  for (const dir of ['resources', 'lib', 'routes']) {
    for (const f of walk(join(root, dir))) {
      const rel = f.slice(root.length + 1)
      for (const spec of importSpecifiers(read(f))) {
        if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) continue
        const bare = spec.startsWith('node:') ? spec.slice(5) : spec
        if (BUILTINS.has(bare) || BUILTINS.has(packageName(bare))) continue
        const name = packageName(spec)
        if (HOST.has(name)) continue
        used.add(name)
        if (deps.has(name)) continue
        if (dev.has(name)) bad.push(`${rel} imports "${spec}" which is only in devDependencies — --omit=dev link-fails every resource`)
        else bad.push(`${rel} imports "${spec}" which is in neither dependencies nor devDependencies`)
      }
    }
  }
  return { bad, used: [...used].sort(), deps: [...deps].sort() }
}

// ---- the harness boundary ---------------------------------------------------------------
//
// The test harness is Immensus's and is NOT seeded into a
// customer's repository. An
// app's tree holds its own suites and not the instrument that executes them, so the suites may
// import the harness and nothing else may: a product file that does resolves here and throws
// `ERR_MODULE_NOT_FOUND` in every generated app.
//
// This section asserts the DEPENDENCY and says nothing about where the files currently sit. They
// are still in this repository and still seeded; moving them needs the platform to mount the
// harness into a workspace first, which is another repository's work. Severing the dependency is
// what has to be true before that can land, and it is checkable now.
//
// WHY THE RULE IS PATH ARITHMETIC AND NOT MODULE RESOLUTION, which is the whole of its value: the
// state this exists for is the one where `scripts/probe/` is ABSENT. A check that only flagged an
// import it could resolve would find nothing precisely then and report green — an instrument that stops discriminating
// goes green, not red. `resolve()` is arithmetic
// on strings and needs no target, so the finding survives the change it exists to enable, and the
// control below deletes the harness from the fixture to prove it.
//
// WHAT IT DOES NOT CATCH, written down rather than made cleverer, which is the same judgement
// `stripComments` and `stripAtRules` record: a reader that is deliberately not a parser
// needs its limits stated. This sees **string-literal specifiers beginning with `.`** and nothing
// else, so a computed or template-literal `import(`${dir}/probe/x.js`)`, or a bare or absolute
// specifier, passes. Those shapes appear nowhere in this repository and a sweep for `probe/` in any
// string would red on prose, which is a cry-wolf gate. Stated, NOT asserted — a
// control proving the gap is tolerated would encode it as expected (a negative control
// that certifies the bug).

const HARNESS_DIR = 'scripts/probe'
const HARNESS_RUNNER = 'scripts/run-suites.js'
const SUITE_FILE = /(?:-acceptance|-probe)\.m?js$/

/**
 * Trees that have to work in a generated app, with the extensions each one actually uses. `src/`
 * is in the list because a TypeScript import of the harness would break `vite build` rather than a
 * resource, which is the same defect with a different error message.
 */
const PRODUCT_TREES = [
  ['resources', /\.(m?js|cjs)$/],
  ['lib', /\.(m?js|cjs)$/],
  ['routes', /\.(m?js|cjs)$/],
  ['scripts', /\.(m?js|cjs)$/],
  ['src', /\.(m?js|cjs|tsx?|jsx)$/],
]

/**
 * The root's own files, non-recursively — `vite.config.ts`, `tailwind.config.js`,
 * `postcss.config.js` and whatever an app adds beside them. They are product files in the most
 * load-bearing sense available: `typecheck` and `build` are the platform's
 * command configured by the APP's file, so a harness import in one of them fails a Tier A check
 * rather than a suite. Found by sweeping this diff for a class of defect —
 * a description claiming more than the code does — because the section header said "every product
 * file" while the walk covered five directories and not the root.
 */
const ROOT_FILE = /\.(m?js|cjs|tsx?|jsx)$/

/**
 * May this file import the harness? Only the harness itself and the suites it exists to serve.
 *
 * TWO OF THE SUITE CONVENTION'S THREE ARMS, DELIBERATELY. `run-suites.js` discovers
 * `*-acceptance`, `*-probe` AND `check-*` (CLAUDE.md §6), and the third is exempted here on
 * purpose: `check-*` names a **package.json script**, not a file — `check-build-stamp` runs
 * `scripts/build-stamp.js --self-test` and `check-signin-link` runs `scripts/mint-signin-link.js
 * --self-test`. Both of those FILES are product code (`build-stamp.js` is the deploy-time stamp
 * reader), so they must not depend on the harness even though their self-tests run as suites. A
 * `scripts/check-*.js` file is therefore flagged, which is correct rather than merely safe: a
 * self-test that needs the harness belongs in a suite file. Pinned by a control below, so the
 * decision cannot read as an oversight.
 *
 * AND THE NAME IS ONLY A SUITE'S NAME INSIDE `scripts/`. Testing the name
 * against the whole path exempted `lib/foo-probe.js`, `resources/x-acceptance.js` and
 * `src/pages/y-probe.js` — product files, and `lib/` is the worst of them, because a harness import
 * there is reached by every resource at load time and takes every route down. Suites
 * live in `scripts/`; §6 and the charters both say so, and nothing the template or the builder does
 * puts one elsewhere. An app that nevertheless does gets a finding rather than silence, which is
 * the safe direction, and the message names where a suite lives. **Deliberately NOT read from
 * `package.json`'s discovered scripts**, even though that is where the runner reads them: a
 * declaration the app can edit to relax the check is a hazard — adding
 * `"x-probe": "node lib/anything.js"` would exempt a product file — where a fixed convention
 * cannot be relaxed from inside.
 */
export function mayImportHarness (rel) {
  const p = rel.split(sep).join('/')
  return p === HARNESS_RUNNER || p.startsWith(`${HARNESS_DIR}/`) || (p.startsWith('scripts/') && SUITE_FILE.test(p))
}

/**
 * Every specifier a file names — imports, re-exports, dynamic imports and `require`, plus the
 * first argument of `register(...)`. The last one is not an import and `importSpecifiers` cannot
 * see it, but it is how six suites reach `probe/loader.js`, so a product file could reach the
 * harness that way with every import clean.
 */
export function referencedSpecifiers (src) {
  const out = importSpecifiers(src)
  for (const m of stripComments(src).matchAll(/\bregister\s*\(\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  return out
}

/** Every product file: the five trees, plus the root's own config files. */
function productFiles (root) {
  const out = []
  for (const [dir, re] of PRODUCT_TREES) out.push(...walk(join(root, dir), re))
  for (const f of readdirSync(root)) {
    if (!ROOT_FILE.test(f) || f.startsWith('.')) continue
    const p = join(root, f)
    if (statSync(p).isFile()) out.push(p)
  }
  return out
}

/**
 * Does this resolved path name the harness? Both halves are wider than the obvious comparison, and
 * each closes a gap found by reading rather than by running:
 *
 *   - the probe DIRECTORY itself, where `startsWith(dir + sep)` is false because there is no
 *     trailing separator — `'../scripts/probe'`, and `resolve()` normalises a trailing slash away
 *     too, so one comparison covers both spellings;
 *   - the runner with its extension OMITTED, which ESM forbids but a `.cjs` `require()` permits,
 *     and `.cjs` is in `PRODUCT_TREES` precisely because an app may add one.
 *
 * Closed rather than written into the limits paragraph because each is one comparison. The judgement
 * recorded there — state a limit instead of reaching for a parser — is about the *shape* of a
 * specifier (computed, template-literal, bare); it is not a licence to leave exact comparisons loose.
 */
function namesHarness (target, probeDir, runner) {
  if (target === probeDir.slice(0, -1) || target.startsWith(probeDir)) return true
  return target === runner || [`${target}.js`, `${target}.mjs`, `${target}.cjs`].includes(runner)
}

export function harnessImports (root) {
  const bad = []
  const probeDir = join(root, HARNESS_DIR) + sep
  const runner = join(root, HARNESS_RUNNER)
  for (const f of productFiles(root)) {
    const rel = f.slice(root.length + 1)
    if (mayImportHarness(rel)) continue
    for (const spec of referencedSpecifiers(read(f))) {
      if (!spec.startsWith('.')) continue
      const target = resolve(dirname(f), spec)
      if (!namesHarness(target, probeDir, runner)) continue
      bad.push(`${rel.split(sep).join('/')} reaches the test harness through "${spec}" — the harness is not seeded into a generated app, so this resolves in the template and in nothing the platform builds`)
    }
  }
  return bad
}

const PATHS = ['package.json', 'resources', 'lib', 'routes']
const { check, section, done } = checker('deps-acceptance')

section('negative controls')
{
  const w = fixture(ROOT, PATHS)
  const clean = audit(w)
  check('a faithful copy passes', clean.bad.length === 0, clean.bad.join(' | '))
  writeFileSync(join(w, 'lib', 'oops.js'), "import { build } from 'vite'\nexport { build }\n")
  check('a runtime import of a devDependency is caught', audit(w).bad.some((b) => b.includes('"vite"') && b.includes('devDependencies')))
  writeFileSync(join(w, 'lib', 'oops.js'), "export async function x () { return import('left-pad') }\n")
  check('a dynamic import of an unlisted package is caught', audit(w).bad.some((b) => b.includes('"left-pad"')))
  writeFileSync(join(w, 'lib', 'oops.js'), "import { readFileSync } from 'node:fs'\nimport os from 'os'\nimport { Resource } from 'harperdb'\nexport { readFileSync, os, Resource }\n")
  check('node builtins (with and without node:) and harperdb are NOT flagged', audit(w).bad.length === 0, audit(w).bad.join(' | '))
  writeFileSync(join(w, 'lib', 'oops.js'), "// import { build } from 'vite' — prose\nexport const x = 1\n")
  check('an import mentioned in a comment is NOT flagged', audit(w).bad.length === 0)
  // This is the sharpest NO case in this file because the finding it prevents cannot be
  // cleared from inside a build: `stripComments` tracks quotes and not regex literals, so
  // `/['"]/` opened a "string" nothing on that line closed, and everything after it — comments
  // included — was copied through and scanned as code. The platform runs this same rule as a
  // DELIVERY check, where a false `deps` finding
  // refuses the deploy while nothing in the tree is wrong. The fixture is the issue's own bytes
  // and is deliberately the same shape as
  // the platform's, which is what holds the two
  // implementations to one verdict over one set of bytes.
  writeFileSync(join(w, 'lib', 'oops.js'), "const QUOTED = /['\"]/\nexport const strip = (s) => s.replace(QUOTED, '')\n// import { build } from 'vite'\n")
  check('a regex literal containing a quote does not make a COMMENTED import into a finding', audit(w).bad.length === 0, audit(w).bad.join(' | '))
  writeFileSync(join(w, 'lib', 'oops.js'), "const QUOTED = /['\"]/\nimport { build } from 'vite'\nexport const strip = (s) => String(build) + s.replace(QUOTED, '')\n")
  check('…CONTROL: the same file with that import UNCOMMENTED still reds, so the line above is not the rule going quiet', audit(w).bad.some((b) => b.includes('"vite"')), audit(w).bad.join(' | '))
  discard(w)
}

section('the harness boundary: negative controls')
{
  const w = fixture(ROOT, ['resources', 'lib', 'routes', 'scripts', 'src'])
  check('a faithful copy passes', harnessImports(w).length === 0, harnessImports(w).join(' | '))
  writeFileSync(join(w, 'lib', 'oops.js'), "import { ROOT } from '../scripts/probe/harness.js'\nexport { ROOT }\n")
  check('a lib/ file importing the harness is caught', harnessImports(w).some((b) => b.startsWith('lib/oops.js') && b.includes('probe/harness.js')))
  // THE CONTROL THIS SECTION EXISTS FOR, and the one that would be easiest to leave out: the
  // state of an app's repository is one where `scripts/probe/` is gone, so the finding has to survive
  // the harness being absent. A resolution-based rule passes here while the import is still wrong.
  const probeDir = join(w, 'scripts', 'probe')
  rmSync(probeDir, { recursive: true, force: true })
  check('…and it is STILL caught with scripts/probe/ deleted, which is the state of an app\'s repository', harnessImports(w).some((b) => b.startsWith('lib/oops.js')))
  rmSync(join(w, 'lib', 'oops.js'))
  check('…and with the harness absent a clean tree is still clean (the rule is not firing on absence itself)', harnessImports(w).length === 0, harnessImports(w).join(' | '))
  writeFileSync(join(w, 'lib', 'oops.js'), "export const x = 1\n// import { ROOT } from '../scripts/probe/harness.js' — prose about the rule\n")
  check('an import of the harness inside a COMMENT is NOT flagged', harnessImports(w).length === 0, harnessImports(w).join(' | '))
  // `register()` is not an import and `importSpecifiers` cannot see it, yet it is how six suites
  // reach probe/loader.js — so a product file could take the same route with every import clean.
  writeFileSync(join(w, 'lib', 'oops.js'), "import { register } from 'node:module'\nregister('../scripts/probe/loader.js', import.meta.url)\n")
  check('a register() of the harness loader is caught, which no import scan would see', harnessImports(w).some((b) => b.includes('probe/loader.js')))
  writeFileSync(join(w, 'lib', 'oops.js'), "import { readFileSync } from 'node:fs'\nexport { readFileSync }\n")
  writeFileSync(join(w, 'scripts', 'reaches-runner.js'), "const { main } = await import('./run-suites.js')\nexport { main }\n")
  check('a non-suite script importing the RUNNER is caught too, not only probe/', harnessImports(w).some((b) => b.startsWith('scripts/reaches-runner.js') && b.includes('run-suites.js')))
  rmSync(join(w, 'scripts', 'reaches-runner.js'))
  // Two that must NOT fire, because a rule that refuses the permitted shape is the cry-wolf gate.
  // A suite may import the harness — that is what the harness is for.
  writeFileSync(join(w, 'scripts', 'zz-acceptance.js'), "import { ROOT } from './probe/harness.js'\nexport { ROOT }\n")
  check('a *-acceptance.js suite importing the harness is NOT flagged', harnessImports(w).length === 0, harnessImports(w).join(' | '))
  rmSync(join(w, 'scripts', 'zz-acceptance.js'))
  writeFileSync(join(w, 'scripts', 'zz-probe.js'), "const h = await import('./probe/harperdb-stub.js')\nexport { h }\n")
  check('a *-probe.js suite importing the harness is NOT flagged either', harnessImports(w).length === 0, harnessImports(w).join(' | '))
  rmSync(join(w, 'scripts', 'zz-probe.js'))
  // A src/ file is the same defect with a different error message: it breaks `vite build`.
  // **THE DIRECTORY IS SYNTHESIZED AND NOT BORROWED FROM THE APP, and that is the whole of the fix.**
  // `fixture()` CONTINUES past a source path that is not there, so on an app with no
  // user interface — three of the four kinds — the copy carried no
  // `src/` and this write threw `ENOENT`, taking the whole suite down with it and `suites` with
  // that. §6's rule already says which way out to take: *derive the mutation from what the suite
  // itself parsed, or SYNTHESIZE the defective shape*. This control synthesizes the file, so it
  // synthesizes the directory too, and the three sibling controls below stop disagreeing about who
  // makes it (one of them already did, recursively, and two assumed the app had one).
  // **This suite does NOT skip on the declared kind, deliberately.** Its rule — no product file may
  // import the harness — is true of every kind, and a headless app is the state in which it matters
  // most: the import resolves in this checkout and throws `ERR_MODULE_NOT_FOUND` in the app. So the
  // control is made independent of the app's tree rather than relaxed, which is strictly stronger
  // than a skip: it keeps firing where a skip would have stopped asking.
  mkdirSync(join(w, 'src'), { recursive: true })
  writeFileSync(join(w, 'src', 'oops.ts'), "import { ROOT } from '../scripts/probe/harness.js'\nexport const r = ROOT\n")
  check('a src/ TypeScript file reaching the harness is caught (it would break vite build)', harnessImports(w).some((b) => b.startsWith('src/oops.ts')))
  rmSync(join(w, 'src', 'oops.ts'))
  check('…and removing it clears the finding, so the control above is not a permanent red', harnessImports(w).length === 0, harnessImports(w).join(' | '))
  // The ROOT's own config files, which the five trees do not reach and which the section header
  // claimed before the walk covered them. `typecheck` and `build` are the
  // platform's command configured by the APP's file, so a harness import here
  // fails a Tier A check rather than a suite.
  writeFileSync(join(w, 'vite.config.ts'), "import { ROOT } from './scripts/probe/harness.js'\nexport default { root: ROOT }\n")
  check('a root-level config file reaching the harness is caught (vite.config.ts fails Tier A build, not a suite)', harnessImports(w).some((b) => b.startsWith('vite.config.ts')))
  rmSync(join(w, 'vite.config.ts'))
  // The third arm of the suite convention is a package.json SCRIPT name, not a filename, and the
  // files behind it are product code — so a `check-*.js` FILE is flagged on purpose (see
  // `mayImportHarness`). Pinned so the choice cannot read as an oversight.
  writeFileSync(join(w, 'scripts', 'check-oops.js'), "import { ROOT } from './probe/harness.js'\nexport { ROOT }\n")
  check('a scripts/check-*.js FILE is NOT exempt — check-* names a package.json script whose file is product code', harnessImports(w).some((b) => b.startsWith('scripts/check-oops.js')))
  rmSync(join(w, 'scripts', 'check-oops.js'))
  // A suite's NAME only exempts a file inside scripts/. These three are product
  // files wearing a suite's name, and `lib/` is the worst of them: a harness import there is
  // reached by every resource at load time and takes every route down.
  writeFileSync(join(w, 'lib', 'zz-probe.js'), "import { ROOT } from '../scripts/probe/harness.js'\nexport { ROOT }\n")
  check('a lib/ file wearing a SUITE NAME is still flagged — the name exempts only inside scripts/', harnessImports(w).some((b) => b.startsWith('lib/zz-probe.js')))
  rmSync(join(w, 'lib', 'zz-probe.js'))
  writeFileSync(join(w, 'resources', 'zz-acceptance.js'), "import { ROOT } from '../scripts/probe/harness.js'\nexport { ROOT }\n")
  check('…and so is a resources/ file wearing one', harnessImports(w).some((b) => b.startsWith('resources/zz-acceptance.js')))
  rmSync(join(w, 'resources', 'zz-acceptance.js'))
  mkdirSync(join(w, 'src', 'pages'), { recursive: true })
  writeFileSync(join(w, 'src', 'pages', 'zz-probe.js'), "import { ROOT } from '../../scripts/probe/harness.js'\nexport { ROOT }\n")
  check('…and so is one NESTED under src/, where the suite-name test would have exempted it by path', harnessImports(w).some((b) => b.startsWith('src/pages/zz-probe.js')))
  rmSync(join(w, 'src', 'pages', 'zz-probe.js'))
  // The extension lists are accepted; exercise the two nobody had, because a list
  // accepted and never driven is a list that can stop matching without anything noticing.
  writeFileSync(join(w, 'lib', 'oops.cjs'), "const { ROOT } = require('../scripts/probe/harness.js')\nmodule.exports = { ROOT }\n")
  check('a .cjs product file reaching the harness through require() is caught', harnessImports(w).some((b) => b.startsWith('lib/oops.cjs')))
  rmSync(join(w, 'lib', 'oops.cjs'))
  writeFileSync(join(w, 'src', 'oops.jsx'), "import { ROOT } from '../scripts/probe/harness.js'\nexport const R = () => ROOT\n")
  check('a .jsx product file reaching the harness is caught', harnessImports(w).some((b) => b.startsWith('src/oops.jsx')))
  rmSync(join(w, 'src', 'oops.jsx'))
  // Two exactness gaps found by reading: the probe DIRECTORY, where
  // `startsWith(dir + sep)` is false for want of a trailing separator, and the runner with its
  // extension omitted, which ESM forbids and a `.cjs` require() permits.
  writeFileSync(join(w, 'lib', 'oops.cjs'), "const p = require('../scripts/probe')\nmodule.exports = { p }\n")
  check('a require() of the probe DIRECTORY with no trailing slash is caught', harnessImports(w).some((b) => b.startsWith('lib/oops.cjs')))
  writeFileSync(join(w, 'lib', 'oops.cjs'), "const p = require('../scripts/probe/')\nmodule.exports = { p }\n")
  check('…and with a trailing slash, which resolve() normalises away', harnessImports(w).some((b) => b.startsWith('lib/oops.cjs')))
  writeFileSync(join(w, 'lib', 'oops.cjs'), "const r = require('../scripts/run-suites')\nmodule.exports = { r }\n")
  check('a require() of the RUNNER with the extension omitted is caught', harnessImports(w).some((b) => b.startsWith('lib/oops.cjs') && b.includes('run-suites')))
  rmSync(join(w, 'lib', 'oops.cjs'))
  // …and the widening must not have made a NEIGHBOUR of the harness into a finding.
  writeFileSync(join(w, 'lib', 'oops.js'), "import { x } from '../scripts/probe-helpers.js'\nexport { x }\n")
  check('a sibling path that merely STARTS with the harness name is NOT flagged (scripts/probe-helpers.js)', harnessImports(w).length === 0, harnessImports(w).join(' | '))
  writeFileSync(join(w, 'lib', 'oops.js'), "import { x } from '../scripts/run-suites-helper.js'\nexport { x }\n")
  check('…and neither is run-suites-helper.js, so the extension widening did not become a prefix match', harnessImports(w).length === 0, harnessImports(w).join(' | '))
  rmSync(join(w, 'lib', 'oops.js'))
  check('…and the tree is clean again, so none of the controls above leaves a standing red', harnessImports(w).length === 0, harnessImports(w).join(' | '))
  discard(w)
}

section('this repository')
const harness = harnessImports(ROOT)
for (const b of harness) check(b, false)
check('no product file reaches the test harness, so nothing an app needs depends on it', harness.length === 0)

// ---- THE HARNESS IS WHOLE OR ABSENT, NEVER HALF (the part that is the APP's business) ------
//
// Severing the product surface's dependency was the first half; the other half is that the
// harness is not seeded at all. **Whether
// `SEEDED_PATHS` and the manifest carry it is NOT asserted here**, and that is a decision rather than
// an omission: those are statements about what the TEMPLATE seeds, and this file is SEEDED, so an
// assertion about them reds an app for state the app owns. They live in
// `scripts/template-manifest.js --self-test`, which the suite convention cannot discover and which
// `pr-check.yml` runs under `if: github.repository == 'ImmensusApp/web-app-template'`.
//
// What is left is the half that is true in an app's own workspace too, and it is a real invariant
// rather than a consolation: the harness arrives whole or not at all. A tree with the runner and
// only some of the stubs fails an app's own suites with a message naming the app's own file.
section('the harness is whole or absent, never half')
{
  // NOT SEEDED IS NOT THE SAME AS NOT PRESENT. The ten files stay on disk in the TEMPLATE, because
  // its own `pr-check.yml` runs the runner; and they are present in a generated app's build
  // workspace too, because the platform mounts them (merged and
  // deployed, read on 2026-10-08 — a claim about another repository, so it carries its date).
  // What must never be true in either place is HALF a harness: a tree with the runner and only some of the stubs fails
  // the app's own suites with a message naming the app's own file, which is the worst red this
  // project knows how to produce.
  //
  // **THE REQUIRED SET IS DERIVED FROM THE SUITES THEMSELVES** rather than counted. An earlier draft
  // compared the runner against `probe/harness.js` alone: seven
  // other stubs could have been missing and it stayed green while claiming a whole harness — a check
  // weaker than its own description, which is the shape this file exists to stop. What every suite
  // in this tree imports IS the set that has to be there, so it is read off their own specifiers and
  // there is nothing to keep in step.
  const suitesImportingProbe = walk(join(ROOT, 'scripts'), /\.(m?js|cjs)$/)
    .filter((f) => /(-acceptance|-probe)\.js$/.test(f))
    .map((f) => importSpecifiers(stripComments(read(f))).filter((spec) => /^\.\/probe\//.test(spec)))
    .filter((specs) => specs.length > 0)
  const neededStubs = [...new Set(suitesImportingProbe.flat().map((spec) => `${HARNESS_DIR}/${spec.slice('./probe/'.length)}`))].sort()
  // THE PRECONDITION, not a size requirement. Every check below is vacuous if the derivation
  // silently returns nothing, so it is compared against the thing it is derived FROM — the number of
  // suites that import a probe module — rather than against a floor somebody picked. A magic number
  // here would be the second unexplained count in a section whose whole point is that the set is
  // derived.
  check(`the derivation found probe imports in ${suitesImportingProbe.length} suite(s), so the required set below is not silently empty`,
    suitesImportingProbe.length > 0 && neededStubs.length > 0, `${suitesImportingProbe.length} suite(s) → ${neededStubs.join(', ') || '(none)'}`)

  // A named predicate rather than an expression, so the NO cases can drive the SAME rule over a tree
  // one stub short. An assertion with no way to fail is decoration.
  const halfHarness = (root) => {
    const runner = existsSync(join(root, HARNESS_RUNNER))
    const absent = neededStubs.filter((rel) => !existsSync(join(root, rel)))
    return { runner, absent, half: runner ? absent.length > 0 : absent.length !== neededStubs.length }
  }
  const here = halfHarness(ROOT)
  check('the harness is present as a WHOLE or absent as a whole', here.half === false, `runner ${here.runner}; absent: ${here.absent.join(', ') || 'none'} of ${neededStubs.length}`)

  // THE NO CASES, driven over a fixture rather than over synthesized arrays, because the rule's
  // subject is a TREE and a rule tested only on arrays is a rule nobody has pointed at a tree.
  const w = fixture(ROOT, ['scripts'])
  check('NO case (precondition): the fixture is a whole harness before anything is removed', halfHarness(w).half === false, JSON.stringify(halfHarness(w)))
  rmSync(join(w, neededStubs[0]))
  check(`NO case: a runner with ${neededStubs[0]} missing is caught as HALF a harness`, halfHarness(w).half === true, JSON.stringify(halfHarness(w)))
  rmSync(join(w, HARNESS_RUNNER))
  for (const rel of neededStubs.slice(1)) rmSync(join(w, rel))
  check('...and a tree with NONE of it is not half a harness, so the rule is not firing on absence itself', halfHarness(w).half === false, JSON.stringify(halfHarness(w)))
  // THE ABSENT CASE IS COVERED HERE AND NOWHERE ELSE, said plainly rather than left to be assumed:
  // it is unreachable IN SITU, because this file imports `./probe/harness.js` at the top, so a tree
  // with no harness cannot get as far as running this section. The fixture is the only instrument
  // that can express it, which is why the branch exists at all.
  discard(w)

  // The seed's own path rule is NOT asserted here, and the reason is this section's own lesson one
  // step further on. An earlier change moved the `SEEDED_PATHS` assertion out of this file because a
  // SEEDED suite must not red on state the app owns — and then left the `import … from
  // './template-manifest.js'` behind, which has the identical exposure: that module is one an app may
  // rewrite or delete, so a suite that imports it fails at LOAD with
  // `ERR_MODULE_NOT_FOUND` and takes the harness-boundary and dependency checks down with it.
  // **Moving an assertion out of a seeded suite is not finished while the
  // import is still there.** The constants above are this file's own and predate all of it.
}

const { bad, used, deps } = audit(ROOT)
for (const b of bad) check(b, false)
check(`every runtime import resolves to dependencies (${used.join(', ') || 'none'})`, bad.length === 0)
const unused = deps.filter((d) => !used.includes(d))
check('every dependency is imported by runtime code (nothing ships for nothing)', unused.length === 0, `unused: ${unused.join(', ')}`)
process.exit(done())
