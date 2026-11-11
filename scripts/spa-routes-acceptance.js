#!/usr/bin/env node
// FIXED — rule 22: routes/spa.js matches src/routes.ts, Vite `base` is /web/, and
// the page listener (lib/pages.js) answers exactly the routes src/routes.ts declares — every route with
// and without a trailing segment, at the published copy's address AND at the preview copy's.
// It drives the REAL listener against the app's own route list,
// because a route LIST that matches src/routes.ts is not a set of URLs that serve the app,
// and it drives the pure helpers — the asset stamp and the apex verdict — since every
// module involved imports only node builtins and runs under bare node.
//
// EVERY expectation here comes from the app's own src/routes.ts. This suite is FIXED: it is
// copied verbatim into an app whose routes, page names and file formatting are nothing like
// the template's, so a literal route or a literal line of the template's routes.ts used as an
// anchor is a suite that silently stops testing (a negative control that mutated the
// string "{ path: '/', page: 'Home' }," was a no-op in any app that wrote that line
// differently, and a control that mutates nothing passes while proving nothing).
//
// A KIT'S PAGE ROUTES ARE `routes/spa.<kit>.json`: the platform copies a kit in
// only as new files, so a kit cannot add to src/routes.ts or routes/spa.js, and the browser
// (src/discovery.ts) and the page listener (lib/pages.js) both read the kit's one file. So there is no
// pair to compare for a kit — what this suite asserts is that every kit route file is a valid flat list
// whose pages exist, and that the listener answers every kit route at both copies' addresses.
//
// Hermetic: no network, no git, no clock (the stamp takes an explicit version).

import { join } from 'node:path'
import { writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import * as harness from './probe/harness.js'
const { ROOT, checker, discard, fixture, read, stripComments } = harness
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

export function routesFromTs (root) {
  const p = join(root, 'src', 'routes.ts')
  if (!existsSync(p)) return null
  return [...stripComments(read(p)).matchAll(/path:\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
}

// ── THERE IS NO ADMIN-ROUTE REQUIREMENT HERE ANY MORE, AND NOTHING MAY REINTRODUCE ONE ───────
//
// **The problem.** This suite used to require `src/routes.ts` to declare an entry with
// `admin: true`, on the ground that *"the admin area is the one page every app inherits"*. It is not:
// a game, a calculator, a public directory, a landing page and anything API-only inherit no such
// thing, and the template was deciding what shape a customer's app had to be.
//
// **The requirement goes**, as the same shape as the page-module
// floor of two that was already dropped. What the
// platform is answerable for is that the app is **up**, and what an
// app's own routes ARE is the customer's.
//
// **The conditional is gone with it, and that is the point rather than a casualty.** It made the
// requirement conditional on `.immensus/access-model.json` declaring `signIn: "none"`, with absent,
// unreadable, unparseable and unrecognised all meaning `required` so that deleting the artefact could
// not be the cheapest route to green. Every word of that reasoning was right about the check it was
// defending; it is simply no longer defending anything, because the check it relaxed has no
// unconditional half left to relax. So `accessModelState`, `signInMode`, `accessModelClause`,
// `SIGN_IN_MODES`, `ACCESS_MODEL_PATH`, `ADMIN_FLAG` and `declaresAdminRoute` are removed rather than
// left exported with no caller: this suite is SEEDED into every app, and a reader who finds a
// fail-closed access-model parser in it will reasonably conclude something still keys on it. Nothing
// outside this file ever imported any of them (grepped across the tree before removing them).
//
// **What the platform still does, so this is not read as the rule going away everywhere.**
// The platform's access check raises `admin_route` for the OPPOSITE case — an app whose
// plan says nobody signs in and which still gates a route on `admin: true` — and that rule is the
// platform's, lives in one repository, and is app-owned rather than blocking (`ownerOf('access',
// 'admin_route')` answers `app`, driven on 2026-10-13). Two rules with
// one name in two repositories is what that gate's own header warns against, which is why this file
// asserts neither half.
//
// **Do not add an admin-route check back on the strength of the baseline shipping one.** The template
// does declare `/admin/*` and always has; that is the baseline being a members app, not a floor.

export function routesFromSpa (root) {
  const p = join(root, 'routes', 'spa.js')
  if (!existsSync(p)) return null
  const m = stripComments(read(p)).match(/SPA_ROUTES\s*=\s*\[([\s\S]*?)\]/)
  if (!m) return null
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])
}

export const normalizePath = (path) => (String(path).length > 1 && String(path).endsWith('/') ? String(path).replace(/\/+$/, '') : String(path))

/**
 * What a route in src/routes.ts INTENDS to serve — THIS SUITE'S OWN READING, written independently of
 * lib/pages.js so the two can disagree: a wildcard owns its bare path too, a `:name` segment is
 * one non-empty segment, and one trailing slash is not a different path.
 */
export function declares (route, url) {
  const u = normalizePath(url)
  if (route === '/*') return true
  if (route.endsWith('/*')) {
    const base = route.slice(0, -2)
    const b = base.split('/')
    const parts = u.split('/')
    return parts.length >= b.length && b.every((seg, i) => (seg.startsWith(':') ? parts[i].length > 0 : seg === parts[i]))
  }
  const r = normalizePath(route).split('/')
  const parts = u.split('/')
  return r.length === parts.length && r.every((seg, i) => (seg.startsWith(':') ? parts[i].length > 0 : seg === parts[i]))
}

/** Every route with and without a trailing segment, plus one URL no app declares. */
export function probeUrls (routes) {
  const urls = ['/immensus-no-such-route-probe']
  for (const route of routes) {
    if (route.endsWith('/*')) {
      const base = route.slice(0, -2).split('/').map((s) => (s.startsWith(':') ? 'probe-id' : s)).join('/')
      urls.push(base || '/', `${base}/`, `${base}/probe-segment`, `${base}/probe-segment/deep`)
      continue
    }
    const concrete = route.split('/').map((s) => (s.startsWith(':') ? 'probe-id' : s)).join('/')
    urls.push(concrete, concrete === '/' ? '/probe-segment' : `${concrete}/probe-segment`)
  }
  return [...new Set(urls)]
}

/**
 * Where what a server ANSWERS and what src/routes.ts DECLARES disagree — empty means they agree.
 * `serves(url)` is the server under test; the controls hand it synthesized ones.
 */
export function coverage (routes, serves) {
  const bad = []
  const urls = probeUrls(routes)
  if (!urls.some((u) => serves(u))) return ['the page listener answered no page URL at all']
  for (const url of urls) {
    const want = routes.some((r) => declares(r, url))
    const got = serves(url)
    if (want && !got) bad.push(`"${url}" is declared by src/routes.ts but the page listener does not answer it`)
    if (!want && got) bad.push(`"${url}" is not declared by src/routes.ts but the page listener answers it — the SPA answers 200 where the app should 404`)
  }
  return bad
}

export function audit (root) {
  const bad = []
  const ts = routesFromTs(root)
  const spa = routesFromSpa(root)
  if (!ts) bad.push('src/routes.ts is missing')
  if (!spa) bad.push('routes/spa.js has no SPA_ROUTES list')
  if (ts && spa) {
    for (const r of ts) if (!spa.includes(r)) bad.push(`src/routes.ts has "${r}" but routes/spa.js does not — regenerate routes/spa.js`)
    for (const r of spa) if (!ts.includes(r)) bad.push(`routes/spa.js has "${r}" but src/routes.ts does not`)
    for (const r of [...ts, ...spa]) if (!r.startsWith('/')) bad.push(`route "${r}" is not absolute`)
    // `/` is the one route every app has, because the page listener serves `web/index.html` from it
    // and a deploy is proven through an address answering. That is delivery, so it stays. WHICH
    // other routes exist — and whether any of them is an admin area — is the app's own business
    // (see the comment at the top of this file).
    if (!ts.includes('/')) bad.push('src/routes.ts does not declare "/"')
  }
  const vite = join(root, 'vite.config.ts')
  if (!existsSync(vite)) bad.push('vite.config.ts is missing')
  else {
    const v = stripComments(read(vite))
    if (!/base:\s*['"]\/web\/['"]/.test(v)) bad.push("vite.config.ts base is not '/web/' (rule 22)")
    if (!/outDir:\s*['"]web['"]/.test(v)) bad.push("vite.config.ts build.outDir is not 'web'")
  }
  const spaSrc = existsSync(join(root, 'routes', 'spa.js')) ? read(join(root, 'routes', 'spa.js')) : ''
  if (spaSrc) {
    const code = stripComments(spaSrc)
    if (/well-known/.test(spaSrc)) bad.push('routes/spa.js mentions .well-known (rule 23)')
    if (/from\s*['"]harperdb['"]/.test(code)) bad.push('routes/spa.js imports harperdb (rule 5)')
  }
  return bad
}

// ── A KIT'S ROUTE FILES ────────────────────────────────────────────────────────────────────────────
export const KIT_ROUTE_FILE = /^spa\.([a-z0-9][a-z0-9-]*)\.json$/

// A route's page module, found the way src/discovery.ts finds it: `src/pages/**/<Page>.tsx`.
function pageModuleExists (root, page) {
  const walkPages = (dir) => {
    let names = []
    try { names = readdirSync(dir) } catch { return false }
    return names.some((n) => { const q = join(dir, n); return statSync(q).isDirectory() ? walkPages(q) : n === `${page}.tsx` })
  }
  return walkPages(join(root, 'src', 'pages'))
}

/** Every kit route file in `routes/`, with what is wrong with each: `{ files, routes, bad }`. */
export function kitAudit (root) {
  const bad = []
  const routes = []
  let names = []
  try { names = readdirSync(join(root, 'routes')).filter((n) => KIT_ROUTE_FILE.test(n)).sort() } catch {}
  for (const name of names) {
    let list
    try { list = JSON.parse(read(join(root, 'routes', name))) } catch (e) { bad.push(`routes/${name} is not valid JSON (${e.message})`); continue }
    if (!Array.isArray(list)) { bad.push(`routes/${name} is not an array of routes`); continue }
    for (const r of list) {
      if (!r || typeof r !== 'object' || typeof r.path !== 'string' || !r.path.startsWith('/')) { bad.push(`routes/${name} has a route whose path is not an absolute string: ${JSON.stringify(r)}`); continue }
      if (typeof r.page !== 'string' || !r.page) { bad.push(`routes/${name}'s ${r.path} names no page`); continue }
      if (!pageModuleExists(root, r.page)) bad.push(`routes/${name}'s ${r.path} names page ${r.page}, and no src/pages/**/${r.page}.tsx is in the tree`)
      const unknown = Object.keys(r).filter((k) => !['path', 'page', 'admin'].includes(k))
      if (unknown.length) bad.push(`routes/${name}'s ${r.path} carries ${unknown.join(', ')}, which neither the router nor the listener reads — a route is { path, page, admin? }`)
      routes.push(r.path)
    }
  }
  return { files: names, routes, bad }
}

// `.immensus/access-model.json` was listed here while the conditional existed. Nothing reads it
// now, so copying it would be a fixture path with no assertion behind it.
// ── AN APP WITH NO PAGES HAS NO PAGE ROUTES, AND THIS SUITE USED TO THROW RATHER THAN SAY SO ─
//
// Every subject in this file is a user interface: `src/routes.ts`, `routes/spa.js`, the Vite base,
// the registered route table, the asset stamp. Three of the four app kinds have none,
// and on such a tree `fixture()` silently skipped the absent
// `routes/spa.js` — it continues past a source that is not there — and the first assertion below
// then read the copy that was never made: `ENOENT … /routes/spa.js`, under the label
// `a faithful copy passes`. **An uncaught throw is worse than a red here**, because `suites` is one
// Tier A row and the runner reports the whole set failed, so nineteen suites that had nothing wrong
// with them lose their verdict too — in every app of that kind, about an app that is correct.
//
// The condition is the DECLARED kind and never the tree: see `appHasPages` in `probe/harness.js`
// for why `existsSync('routes/spa.js')` would have been a route to green rather than a skip.
//
// **`apexRedirect` is NOT exempted by this skip, and that is a judgement rather than an oversight.**
// It lives in `routes/apex.js`, which is a 301 for a hostname and not a page, so a service app
// behind `www.` wants it as much as a web app does — but it is only ever CALLED from `spa.js`, which
// is the file a headless app has not got. Where it is called from for an app with no page routes is
// the platform's to answer, and asserting half of this file against an absent caller would be a
// precondition that proves nothing.
// **THIS FILE MUST STAY A STANDALONE ENTRY POINT, and that is a consequence of the line below
// rather than a style preference**. The skip is a `process.exit`, and it
// sits ABOVE the exports beneath it — `routesFromTs`, `audit`, `INDEX_PATH_REF`, `APEX_CALL` — so an
// importer on a headless app would be killed outright instead of getting the export it asked for.
// Nothing imports it today and nothing may start: `page-boot-kind-acceptance` checks that no file
// under `scripts/` imports this suite or `look-acceptance`, because a sentence here would be an unchecked claim.
if (!appHasPages()) process.exit(skipForNoPages('spa-routes-acceptance', `no page routes are expected of a "${declaredAppKind()}" app, so routes/spa.js, src/routes.ts, the Vite base and the registered route table are not asserted`))

const PATHS = ['src/routes.ts', 'src/pages', 'routes', 'vite.config.ts']
const { check, section, done } = checker('spa-routes-acceptance')

// Rewrite the SPA_ROUTES literal in a copy of routes/spa.js — derived from what the suite
// itself parses out of the file, so it works on any app's generated spa.js.
function withSpaRoutes (spaSrc, routes) {
  const next = `SPA_ROUTES = [\n${routes.map((r) => `  '${r}',`).join('\n')}\n]`
  const out = spaSrc.replace(/SPA_ROUTES\s*=\s*\[[\s\S]*?\]/, next)
  if (out === spaSrc) throw new Error('could not rewrite SPA_ROUTES — the negative control would prove nothing')
  return out
}

section('negative controls')
{
  const w = fixture(ROOT, PATHS)
  const clean = audit(w)
  check('a faithful copy passes', clean.length === 0, clean.join(' | '))
  const spaPath = join(w, 'routes', 'spa.js')
  const spaSrc = read(spaPath)
  const declared = routesFromSpa(w) ?? []

  writeFileSync(spaPath, withSpaRoutes(spaSrc, declared.slice(0, -1)))
  check('a route in src/routes.ts that routes/spa.js dropped is caught', audit(w).some((b) => b.includes(`has "${declared.at(-1)}" but routes/spa.js does not`)))

  writeFileSync(spaPath, withSpaRoutes(spaSrc, [...declared, '/immensus-stray-route']))
  check('a route routes/spa.js invented is caught', audit(w).some((b) => b.includes('/immensus-stray-route')))

  writeFileSync(spaPath, withSpaRoutes(spaSrc, [...declared, 'immensus-relative-route']))
  check('a route that is not absolute is caught', audit(w).some((b) => b.includes('is not absolute')))

  writeFileSync(spaPath, spaSrc)

  // ── WHAT REPLACED THE CONTROL BLOCK ─────────────────────────────────────────
  //
  // The block that used to sit here was TWELVE call sites and THIRTEEN assertions — one site was a
  // two-iteration loop, so it is counted both ways rather than left to be quoted wrong — and every
  // one of them had the string `declares no admin route` as its subject. `audit()` raises no such
  // finding any more: 46 − 13 + 3 = 36, which is what the runner prints.
  // They are REMOVED rather than inverted or left
  // standing: a control that asserts the absence of a string the file no longer contains passes for
  // ever and proves nothing, which is the shape this suite's own header warns about.
  //
  // What replaces them is the acceptance criterion driven FORWARDS, which is also the regression
  // control: if anybody reintroduces an admin-route requirement — conditional or not — the
  // assertion below goes red, because it demands a CLEAN audit of a tree that gates nothing on
  // `admin: true` and declares no access model at all. That was the strictest case under the old conditional and
  // the one that red.
  //
  // The tree is SYNTHESIZED and the precondition is asserted first, for a reason learned the
  // hard way: this suite is seeded verbatim into apps whose own `src/routes.ts` may already declare
  // no admin route, where a mutation of ROOT's file matches nothing and the control silently stops
  // testing.
  const routesPath = join(w, 'src', 'routes.ts')
  writeFileSync(routesPath, read(routesPath).replace(/\badmin\s*:\s*true\b/g, 'admin: false'))
  check('PRECONDITION: the tree now gates no route on `admin: true`, so the assertion below is not vacuous', !/\badmin\s*:\s*true\b/.test(stripComments(read(routesPath))))
  // A TRIPWIRE, NOT A PRECONDITION, and saying which is the point (the first
  // version of this line was vacuous: `existsSync` on the fixture alone can
  // never be false now that `PATHS` does not copy the file). What makes the verdict below worth
  // anything is that NOTHING put an access model in this tree — because an access model declaring
  // `signIn: "none"` is precisely what used to make this audit clean, so a fixture that acquired one
  // would pass for the old reason and look like it passed for the new one. So the assertion is on
  // `PATHS`, which somebody can widen, as well as on the tree.
  check('TRIPWIRE: nothing copies an access model into this fixture, so the clean audit below cannot be the old relaxation wearing a new label', !PATHS.some((p) => p.includes('access-model')) && !existsSync(join(w, '.immensus', 'access-model.json')))
  check('an app that declares NO admin route passes — what routes an app has is the app\'s own, not a floor the template sets', audit(w).length === 0, audit(w).join(' | '))
  discard(w)
}
{
  const w = fixture(ROOT, PATHS)
  writeFileSync(join(w, 'vite.config.ts'), read(join(w, 'vite.config.ts')).replace(/base:\s*['"][^'"]*['"]/g, "base: '/'"))
  check("Vite base moved off /web/ is caught", audit(w).some((b) => b.includes('base is not')))
  const spaPath = join(w, 'routes', 'spa.js')
  writeFileSync(spaPath, `${read(spaPath)}\nimport 'harperdb'\nexport const x = 1 // from 'harperdb'\n`.replace("import 'harperdb'", "import { tables } from 'harperdb'"))
  check('a routes/spa.js that imports harperdb is caught (rule 5)', audit(w).some((b) => b.includes('imports harperdb')))
  discard(w)
}

section('a kit\'s route files: valid, flat, and naming pages that exist (NEG first)')
{
  // lib/ and package.json too: the last control drives a fresh lib/pages.js inside the fixture, and
  // package.json is what makes a .js file in a temporary directory an ES module.
  const w = fixture(ROOT, [...PATHS, 'lib', 'package.json'])
  mkdirSync(join(w, 'src', 'pages', 'kitx'), { recursive: true })
  writeFileSync(join(w, 'src', 'pages', 'kitx', 'KitPage.tsx'), 'export default function KitPage () { return <i>k</i> }\n')
  writeFileSync(join(w, 'routes', 'spa.kit-x.json'), JSON.stringify([{ path: '/kit-x', page: 'KitPage' }, { path: '/kit-x/area/*', page: 'KitPage', admin: true }]))
  const good = kitAudit(w)
  check('a well-formed kit route file is clean, and its routes are read', good.bad.length === 0 && good.routes.includes('/kit-x') && good.routes.includes('/kit-x/area/*'), good.bad.join(' | '))
  writeFileSync(join(w, 'routes', 'spa.kit-x.json'), JSON.stringify([{ path: '/kit-x', page: 'NoSuchPage' }]))
  check('a kit route naming a page that is not in src/pages/ is caught', kitAudit(w).bad.some((b) => b.includes('names page NoSuchPage')))
  writeFileSync(join(w, 'routes', 'spa.kit-x.json'), '[{ "path": "/kit-x", ')
  check('a kit route file that is not JSON is caught', kitAudit(w).bad.some((b) => b.includes('is not valid JSON')))
  writeFileSync(join(w, 'routes', 'spa.kit-x.json'), JSON.stringify({ path: '/kit-x', page: 'KitPage' }))
  check('a kit route file that is not an array is caught', kitAudit(w).bad.some((b) => b.includes('is not an array')))
  writeFileSync(join(w, 'routes', 'spa.kit-x.json'), JSON.stringify([{ path: 'kit-x', page: 'KitPage' }, { path: '/kit-y', page: 'KitPage', meta: { title: 'x' } }]))
  const shape = kitAudit(w).bad
  check('a relative path, and a route carrying a key nothing reads, are both caught', shape.some((b) => b.includes('not an absolute string')) && shape.some((b) => b.includes('carries meta')), shape.join(' | '))
  writeFileSync(join(w, 'routes', 'spa.kit-x.json'), JSON.stringify([{ path: '/kit-x', page: 'KitPage' }]))
  // The listener reads the same file at load (lib/pages.js), so a fresh copy of the module in the fixture
  // serves the kit's route with no list handed to it — which is the property a kit needs: no core file
  // names it.
  const fixturePages = await import(`${pathToFileURL(join(w, 'lib', 'pages.js')).href}?kit-fixture`).catch((e) => ({ thrown: e }))
  check('PRECONDITION: the fixture carries lib/pages.js, so the next line drives the real module', !fixturePages.thrown, String(fixturePages.thrown ?? ''))
  if (!fixturePages.thrown) {
    const l = fixturePages.createPagesListener({ readShell: () => '<div id="root"></div>', stamp: () => ({ sha: 's' }), apex: () => null, started: 'v' })
    const served = (u) => { const r = l({ method: 'GET', url: u, pathname: u, headers: { get: () => 'app.example' } }, () => 'NEXT'); return r !== 'NEXT' && r?.status === 200 }
    check('the listener, given no route list, serves a kit\'s route from its file — and not a path no file declares (NEG)', served('/kit-x') && !served('/kit-z'))
    const bogus = fixturePages.kitRoutes(join(w, 'no-such-dir'))
    check('…and a routes directory that cannot be read gives no kit routes rather than a throw', Array.isArray(bogus) && bogus.length === 0)
  }
  // A MALFORMED kit file beside a good one: lib/pages.js reads route files at module LOAD, inside the
  // resource that registers every page, so a throw there would take every page down over one kit's
  // file. It must be reported and skipped — and an entry with no page is not a route on either side.
  writeFileSync(join(w, 'routes', 'spa.kit-bad.json'), '[{ "path": "/kit-bad"')
  writeFileSync(join(w, 'routes', 'spa.kit-nopage.json'), JSON.stringify([{ path: '/kit-nopage', page: null }, { path: '/kit-empty', page: '' }]))
  const quiet = console.error
  const logged = []
  console.error = (...a) => { logged.push(a.join(' ')) }
  const reloaded = await import(`${pathToFileURL(join(w, 'lib', 'pages.js')).href}?kit-malformed`).catch((e) => ({ thrown: e }))
  console.error = quiet
  check('a malformed kit route file does NOT stop lib/pages.js loading', !reloaded.thrown, String(reloaded.thrown ?? ''))
  if (!reloaded.thrown) {
    const l = reloaded.createPagesListener({ readShell: () => '<div id="root"></div>', stamp: () => ({ sha: 's' }), apex: () => null, started: 'v' })
    const served = (u) => { const r = l({ method: 'GET', url: u, pathname: u, headers: { get: () => 'app.example' } }, () => 'NEXT'); return r !== 'NEXT' && r?.status === 200 }
    check('…the app\'s own route and the good kit\'s still serve, and nothing from the broken file does', served('/') && served('/kit-x') && !served('/kit-bad'))
    check('…the broken file is SAID, naming it', logged.some((m) => m.includes('spa.kit-bad.json')), logged.join(' | '))
    check('…and an entry with no page name is not served — the browser would render nothing there either', !served('/kit-nopage') && !served('/kit-empty'))
  }
  discard(w)
}

section('this repository')
const bad = audit(ROOT)
for (const b of bad) check(b, false)
check(`routes/spa.js and src/routes.ts agree (${(routesFromTs(ROOT) ?? []).join(', ')}); base is /web/`, bad.length === 0)
const kits = kitAudit(ROOT)
for (const b of kits.bad) check(b, false)
check(`every kit route file is a valid flat list naming pages that exist (${kits.files.join(', ') || 'none in this tree'})`, kits.bad.length === 0)

const spa = await import(pathToFileURL(join(ROOT, 'routes', 'spa.js')).href)
const apex = await import(pathToFileURL(join(ROOT, 'routes', 'apex.js')).href)
const pages = await import(pathToFileURL(join(ROOT, 'lib', 'pages.js')).href)
const { PREVIEW_PREFIX } = await import(pathToFileURL(join(ROOT, 'lib', 'copy.js')).href)

section('the browser and the server read the same kit route files')
{
  // Both read `routes/spa.<kit>.json` — src/discovery.ts through Vite's import.meta.glob, lib/pages.js
  // through readdirSync — so a kit's routes cannot be served by one and missing from the other. That
  // holds only while the two patterns name the same files, so the browser's is READ out of
  // src/discovery.ts (comments stripped, because its header quotes the pattern) and both are run over
  // the same candidate names.
  const disc = existsSync(join(ROOT, 'src', 'discovery.ts')) ? stripComments(read(join(ROOT, 'src', 'discovery.ts'))) : ''
  const glob = (disc.match(/import\.meta\.glob<[^(]*>\(\s*'(\.\.\/routes\/[^']+)'/) ?? disc.match(/import\.meta\.glob\(\s*'(\.\.\/routes\/[^']+)'/))?.[1] ?? null
  check('src/discovery.ts globs a routes/ pattern for kit routes', glob !== null, glob ?? '(none found)')
  if (glob) {
    const name = glob.split('/').pop()
    const re = new RegExp('^' + name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$')
    const candidates = ['spa.sign-in.json', 'spa.payments.json', 'spa.x.json', 'spa.js', 'spa.json', 'build.js', 'spa.sign-in.js', 'other.sign-in.json']
    const disagree = candidates.filter((c) => re.test(c) !== pages.KIT_ROUTE_FILE.test(c))
    check('…and it names exactly the files lib/pages.js reads, over every candidate name', disagree.length === 0, disagree.join(', '))
    check('CONTROL: the candidates include files both read and files neither reads, so the line above is not vacuous',
      candidates.some((c) => pages.KIT_ROUTE_FILE.test(c)) && candidates.some((c) => !pages.KIT_ROUTE_FILE.test(c)))
  }
}


// A request the listener can read, and a listener run to a verdict: `true` when it answered with the
// shell, `false` when it passed the request on. The shell is a fixed string so the listener never
// touches web/, which is BUILT and may not exist where this runs.
const SHELL = '<!doctype html><div id="root"></div>'
const req = (url, method = 'GET', host = 'app.example') => ({ method, url, pathname: url.split('?')[0], headers: { get: (k) => (k === 'host' ? host : undefined) } })
const NEXT = Symbol('next')
const run = (listener, url, method) => listener(req(url, method), () => NEXT)
const listenerFor = (base, routes) => pages.createPagesListener({ base, routes, readShell: () => SHELL, stamp: () => ({ sha: 'probe-sha' }), apex: () => null, started: 'v' })
const answersShell = (listener, prefix = '') => (url) => {
  const r = run(listener, `${prefix}${url}`)
  return r !== NEXT && r?.status === 200 && String(r.body).includes('id="root"')
}

// The URLs the listener ANSWERS, not the route list: a spa.js whose SPA_ROUTES matched
// routes.ts exactly could still 404 the admin landing page, because `/admin/*` is not `/admin`.
section('the page listener against src/routes.ts (NEG first)')
{
  // The controls run against SYNTHESIZED route lists and synthesized servers, never the app's. An app
  // whose own routes.ts ends in a root catch-all (`{ path: '/*', page: 'NotFound' }`) declares every
  // URL there is, so both defects below would come back clean on it and both controls would fail on
  // an app that did nothing wrong.
  const exactOnly = (routes) => (url) => routes.includes(normalizePath(url)) || routes.includes(url)
  const missingBare = coverage(['/', '/x/*'], exactOnly(['/', '/x/*']))
  check('a server that answers a wildcard route only verbatim is caught',
    missingBare.some((b) => b.includes('"/x" is declared')),
    missingBare.join(' | ') || '(clean — this control proves nothing; fix it, do not delete it)')
  const catchAll = coverage(['/', '/a'], () => true)
  check('a catch-all that answers 200 for a URL no route declares is caught',
    catchAll.some((b) => b.includes('is not declared')), catchAll.join(' | ') || '(clean)')
  check('a server that answers nothing is caught', coverage(['/'], () => false).length === 1)
  check('the REAL listener over that same wildcard list is clean (NEG of the NEG)',
    coverage(['/', '/x/*'], answersShell(listenerFor('', ['/', '/x/*']))).length === 0)
  check('…and over a parameter route beside its own wildcard (NEG)',
    coverage(['/', '/x/:id', '/x/:id/*', '/x/y'], answersShell(listenerFor('', ['/', '/x/:id', '/x/:id/*', '/x/y']))).length === 0)

  // The app's own routes AND every kit's: the listener is driven with the list it really serves
  // (`pages.PAGE_ROUTES`, routes/spa.js plus every routes/spa.<kit>.json), against this suite's own
  // reading of src/routes.ts and of the kit files.
  const declared = [...(routesFromTs(ROOT) ?? []), ...kitAudit(ROOT).routes]
  for (const [label, base] of [['the published copy at its own address', ''], ['the preview copy under /preview', PREVIEW_PREFIX]]) {
    const listener = listenerFor(base, pages.PAGE_ROUTES)
    const bad = coverage(declared, answersShell(listener, base))
    for (const b of bad) check(`${label}: ${b}`, false)
    check(`${label}: every route serves with and without a trailing segment (${declared.length} routes)`, bad.length === 0)
  }
  check('the routes the listener serves by default are routes/spa.js and every kit route file, and nothing else',
    JSON.stringify(pages.PAGE_ROUTES) === JSON.stringify([...spa.SPA_ROUTES, ...kitAudit(ROOT).routes]), JSON.stringify(pages.PAGE_ROUTES))
  // Each copy declines the other's address, so two listeners in one chain never both claim a path —
  // in either load order (lib/pages.js says why that is the rule and not the ordering).
  const published = listenerFor('', ['/', '/:slug', '/*'])
  check("the PUBLISHED copy declines /preview and everything under it, even through its own catch-all and /:slug routes",
    run(published, '/preview') === NEXT && run(published, '/preview/') === NEXT && run(published, '/preview/login') === NEXT && run(published, '/preview/build') === NEXT)
  check('…and still answers a path that only STARTS with the word (NEG): /previewish is its own',
    run(published, '/previewish') !== NEXT)
  const preview = listenerFor('/preview', ['/', '/:slug', '/*'])
  check('the PREVIEW copy answers only under /preview, even through a catch-all',
    run(preview, '/') === NEXT && run(preview, '/login') === NEXT && run(preview, '/build') === NEXT && run(preview, '/previewish') === NEXT &&
    run(preview, '/preview') !== NEXT && run(preview, '/preview/anything') !== NEXT)
}

section('the page listener\'s own behaviour')
{
  const l = listenerFor('', ['/', '/a'])
  const stampR = run(l, '/build')
  check('GET /build answers the stamp as JSON, uncached, with x-build-sha', stampR?.status === 200 && JSON.parse(stampR.body).sha === 'probe-sha' &&
    /^application\/json/.test(stampR.headers['content-type']) && /no-store/.test(stampR.headers['cache-control']) && stampR.headers['x-build-sha'] === 'probe-sha')
  check('GET /build/ is the same route (one trailing slash ignored)', run(l, '/build/')?.status === 200)
  const p = listenerFor('/preview', ['/'])
  check('the preview copy answers its stamp at /preview/build and NOT at /build', run(p, '/preview/build')?.status === 200 && run(p, '/build') === NEXT)
  const unstamped = pages.createPagesListener({ base: '', routes: ['/'], readShell: () => SHELL, stamp: () => ({ sha: null }), apex: () => null })
  check('an unstamped process says so in the header rather than inventing a sha', run(unstamped, '/build')?.headers['x-build-sha'] === 'unstamped')
  check('HEAD is answered like GET, because the browser and the stamp sampler both use it', run(l, '/a', 'HEAD')?.status === 200 && run(l, '/build', 'HEAD')?.status === 200)
  check('a POST to a page route is passed on, never answered with the shell (NEG)', run(l, '/a', 'POST') === NEXT && run(l, '/build', 'POST') === NEXT)
  check('a page is served uncached-by-default (no-cache) as text/html', /^text\/html/.test(run(l, '/a')?.headers['content-type']) && run(l, '/a')?.headers['cache-control'] === 'no-cache')
  const noShell = pages.createPagesListener({ base: '', routes: ['/'], readShell: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }, stamp: () => ({ sha: 'x' }), apex: () => null })
  const before = console.warn
  console.warn = () => {}
  const r503 = run(noShell, '/')
  console.warn = before
  check('a missing web/index.html answers 503 naming the command to run, not a crash', r503?.status === 503 && /npm run build/.test(r503.body))
  check('…and /build still answers when the shell is missing, so a broken build can still be identified', run(noShell, '/build')?.status === 200)
  // The app's name reaches the header and the browser tab through the shell's title.
  const named = (shell, name) => run(pages.createPagesListener({ base: '', routes: ['/'], readShell: () => shell, stamp: () => ({ sha: 'x' }), apex: () => null, name: () => name }), '/')?.body
  check('the template\'s title becomes the app\'s name', named('<title>App</title>', 'Tide Tables') === '<title>Tide Tables</title>')
  check('a name is escaped, so it cannot write markup into the page (NEG)', named('<title>App</title>', 'A&B</title><script>') === '<title>A&amp;B&lt;/title&gt;&lt;script&gt;</title>')
  check('a replacement pattern in a name is taken literally (NEG)', named('<title>App</title>', "$' Co") === "<title>$' Co</title>")
  // A CONFIG.env that cannot be read throws (rule 30). That must not read as a missing build.
  const noConfig = pages.createPagesListener({ base: '', routes: ['/'], readShell: () => SHELL, stamp: () => ({ sha: 'x' }), apex: () => null, name: () => { throw new Error('CONFIG.env unreadable') } })
  let configError = null
  try { run(noConfig, '/') } catch (err) { configError = err.message }
  check('an unreadable configuration surfaces as itself, not as a 503 telling you to run a build (NEG)', configError === 'CONFIG.env unreadable')
  check('…and /build still answers, so the copy can still be identified', run(noConfig, '/build')?.status === 200)
  check('an app that wrote its own title keeps it (NEG)', named('<title>My Own</title>', 'Tide Tables') === '<title>My Own</title>')
  const apexL = pages.createPagesListener({ base: '', routes: ['/'], readShell: () => SHELL, stamp: () => ({ sha: 'x' }), apex: (host, url) => (host === 'example.com' ? `https://www.example.com${url}` : null) })
  const r301 = apexL({ method: 'GET', url: '/?x=1', pathname: '/', headers: { get: (k) => (k === 'host' ? 'example.com' : undefined) } }, () => NEXT)
  check('a page on the apex host is redirected first, path and query kept', r301?.status === 301 && r301.headers.location === 'https://www.example.com/?x=1')
  check('the stamp is NOT redirected off the apex — a deploy is proven on whatever host answers (NEG)', apexL({ method: 'GET', url: '/build', pathname: '/build', headers: { get: () => 'example.com' } }, () => NEXT)?.status === 200)
}

section('the pure helpers')
const V = '2026-06-15T12:00:00.000Z'
const stamped = pages.stampPublicUrls('<link href="/web/favicon.svg"><img src=\'/web/og-card.png\'><script src="/web/assets/index-abc123.js"></script><meta content="https://x.example/web/favicon.svg"><a href="/web/manifest.webmanifest?v=old">', V)
check('an unhashed site-relative /web/ file is stamped', stamped.includes(`/web/favicon.svg?v=${encodeURIComponent(V)}`) && stamped.includes(`/web/og-card.png?v=${encodeURIComponent(V)}`))
check('a hashed /web/assets/ file is left alone', stamped.includes('/web/assets/index-abc123.js"'))
check('an absolute URL is left alone (shared links are not re-scraped)', stamped.includes('https://x.example/web/favicon.svg"'))
check('an already-stamped URL is not stamped twice (idempotent)', stamped.includes('manifest.webmanifest?v=old"') && !stamped.includes('?v=old?v='))
check('stamping is idempotent over a second pass', pages.stampPublicUrls(stamped, V) === stamped)
const stampedPreview = pages.stampPublicUrls('<link href="/preview/web/favicon.svg"><script src="/preview/web/assets/i-1.js"></script><link href="/web/favicon.svg">', V, '/preview/web/')
check("the preview copy's shell is stamped under its OWN asset base, and nothing else is",
  stampedPreview.includes(`/preview/web/favicon.svg?v=`) && stampedPreview.includes('/preview/web/assets/i-1.js"') && stampedPreview.includes('<link href="/web/favicon.svg">'))
check('SPA_ROUTES is exported and matches the file', JSON.stringify(spa.SPA_ROUTES) === JSON.stringify(routesFromSpa(ROOT)))

const cfg = apex.apexConfig('www.example.com')
check('apexConfig derives the apex from the www host', cfg?.apex === 'example.com' && cfg?.to === 'www.example.com')
check('the apex host redirects to www, path preserved', apex.apexTarget('example.com', '/lessons/1?x=1', cfg) === 'https://www.example.com/lessons/1?x=1')
check('the apex host with a port still redirects', apex.apexTarget('EXAMPLE.com:443', '/', cfg) === 'https://www.example.com/')
check('the www host does not redirect (NEG)', apex.apexTarget('www.example.com', '/', cfg) === null)
check('an unrelated host does not redirect (NEG)', apex.apexTarget('app.immensus.app', '/', cfg) === null)
check('unset APEX_REDIRECT_TO never redirects (NEG)', apex.apexConfig('') === null && apex.apexTarget('example.com', '/', null) === null)
check('a bare apex in APEX_REDIRECT_TO is refused (NEG)', apex.apexConfig('example.com') === null)
process.exit(done())
