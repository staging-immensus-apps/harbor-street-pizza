#!/usr/bin/env node
// FIXED — rule 14: every page module under src/pages/** and
// src/App.tsx must BOOT — bundle the real module the way Vite would, mount it under jsdom
// with the API client stubbed, and require that it renders something without throwing
// and without a console.error. 59 green suites once sat beside a blank page in production
// because each had exercised a fragment; a page that cannot boot passes a test of its parts.
//
// Coverage is DISCOVERED, not listed: a page added under src/pages/ is booted on its first
// PR with nothing to remember. A module that renders nothing is a failure too — an empty
// container is exactly what a TDZ crash below a top-level await looks like to a user.
//
// Each page boots in its own child process (clean globals; a rejection is attributable to
// one file). Hermetic: esbuild and jsdom are devDependencies, the API stub answers every
// request from fixtures, no network, no git, no clock.

// TWO ROOTS, AND THEY ARE DIFFERENT THINGS. `TREE` is the checkout whose pages are under test
// and comes from `process.cwd()`; `TOOLS` is the checkout whose `node_modules` resolves React,
// the router and the rest, and is resolved against THIS FILE. The split was already half here —
// `bootPage({root})` has always taken the tree as a parameter, which is how the negative
// controls below boot synthesized pages out of a temp dir that has no `node_modules` — and the
// only thing missing was that the real run hard-coded this file's own location for both.
//
// Why `process.cwd()` for the tree: `scripts/run-suites.js` can be driven over a
// tree the PLATFORM wrote, because it reads `process.cwd()`, and that is what gives Tier A's
// `suites` check cover against an app that has edited its own runner into one that reports
// green over anything. Tier A's `boot` check
// spawns THIS file and had no equivalent cover, for one reason only: it took its root from
// here. Now it does not, so the same decoy works on it. Ordinary use is unchanged — `npm run
// page-boot-acceptance` and `run-suites.js` both spawn with the package root as the cwd.
//
// TOOLS must NOT follow the cwd, and that is not an inconsistency to tidy away: a decoy tree
// the platform writes has no `node_modules`, so resolving the toolchain there would make this
// probe fail on every tree but its own — "always red", which is a probe that can no longer give
// a verdict either way, and that is the second of the two ways an instrument stops
// discriminating.

import { join, relative, dirname, resolve } from 'node:path'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ROOT as TOOLS, checker, walk } from './probe/harness.js'

const TREE = process.cwd()

// ── WHETHER THIS APP HAS PAGES AT ALL ─────────────────────
//
// **The problem.** The floor below — *at least one page module under `src/`* — is a property of a web
// single-page app, not of an application. An HTTP interface other software talks to has no pages and
// cannot clear it, so this probe refused a correct app; and because the platform's Tier A treats
// a red `boot` as a blocker, that refusal reached the user as a product failure about an app that was
// fine. (The floor was once *two or more* and is now one module, for the same
// reason one level in: two was the platform deciding how many screens a customer's app had to have.)
//
// **It is read from OUTSIDE the tree, and that is the whole of the safety argument.** `IMMENSUS_APP_KIND`
// is set by the platform from the kind the user confirmed in the build wizard.
// **This file deliberately does not read `.immensus/template.json`.**
// The whole tree is the app's own after its first build, so a floor
// keyed on a file in the tree is a floor clearable by editing that file — a route to green, which is
// `page-boot-kind-acceptance`'s own negative control in as many words. The manifest's own `appKind` is provenance to
// cross-check against the kind that travelled, never a substitute for it.
//
// **An absent or unrecognised value means "expect pages", which is this probe unchanged.** That is the
// conservative direction in both senses: it is byte-identical to the behaviour before the gate existed for every
// app that exists today, and a kind this copy of the table has never heard of cannot talk its way past
// the floor. A generated app diverges from the template the moment it builds, so an app seeded a year
// from now with a kind added since will read it as unknown and apply the floor — red, visible, and the
// safe way round.
//
// **A CROSS-REPO COPY, LABELLED AS ONE**.
// The platform's app-kind table is the authority; this is the one fact this probe needs
// out of it. Read 2026-10-08. When that
// table moves, this is the list to re-read — and `page-boot-kind-acceptance` transcribes the same
// four independently and reds when the two disagree, so a drift is visible rather than silent. (An
// earlier version of this sentence named `harness-acceptance`, which asserts nothing of the kind: a
// wrong sentence about which gate covers something is exactly where the next gap goes unnoticed.)
const KINDS_WITH_PAGES = { web_app: true, service: false, agent: false, pipeline: false }
const DECLARED_KIND = (process.env.IMMENSUS_APP_KIND ?? '').trim()
// `Object.hasOwn` rather than a bare lookup, so a declaration of `constructor` or `__proto__` reads
// as an unrecognised kind rather than as an inherited property that happens not to be `false`. The
// old form failed closed too — anything not exactly `false` means "expect pages" — but the intent is
// worth being explicit about on the one line that decides whether a gate applies.
const HAS_PAGES = !(Object.hasOwn(KINDS_WITH_PAGES, DECLARED_KIND) && KINDS_WITH_PAGES[DECLARED_KIND] === false)

const { check, section, done } = checker('page-boot-acceptance')

// **THE SKIP IS BEFORE THE esbuild IMPORT, AND THAT ORDER IS MEASURED RATHER THAN TIDY.** Driven
// against a real headless tree on 2026-10-08 — `app-template@898926f` with `src/`, `index.html`,
// `vite.config.ts` and the web toolchain removed from `node_modules` and `devDependencies`, which is
// what a `service` template would actually ship — this file's top-level `await import('esbuild')`
// throws `ERR_MODULE_NOT_FOUND` before any line of the probe runs. So a skip placed after it would
// never be reached: there is nothing to skip past, because the probe cannot start. esbuild, jsdom and
// React are the toolchain a page needs and an app with no pages has no reason to install.
//
// **What that costs, said plainly rather than left for somebody to discover: this probe cannot give a
// verdict either way on an app with no pages, including about itself.** The negative controls below —
// the synthesized pages that prove it can still tell a broken module from a sound one — need the same
// toolchain, so they do not run. That is why the platform has to drop `boot` and the `boot`
// half of its `instruments` check from a headless template's declared set **together**: `instruments`
// drives this file over a decoy tree to ask whether it still discriminates, and a probe that reports
// a clean skip over a broken decoy is `boot-probe-always-green` — an instrument that stopped
// discriminating, reported as a pass.
if (!HAS_PAGES) {
  section(`skipped — this app is "${DECLARED_KIND}", which has no pages`)
  console.log(`  ⏭  no page modules are expected of a "${DECLARED_KIND}" app, so the floor below (at least one under src/) does not apply, and neither do the per-page boots`)
  console.log('     the kind came from IMMENSUS_APP_KIND, which the platform sets from the kind the user confirmed — not from this tree')
  console.log('     nothing was checked, so this is not evidence that any page renders')
  console.log('')
  process.exit(0)
}

const { build } = await import('esbuild')

// ── WHAT THE STUBBED API ANSWERS, AND THE PROPS A PAGE IS BOOTED WITH ──────────────────────────────────
//
// The core has no resources that answer anything, so the core answers `{}` to every GET and `{ ok: true }`
// to everything else, and boots every page with no props. A kit the platform copies in brings its own
// pages, and they need the data their resources would answer — so a kit also brings
// `scripts/page-boot.<kit>.json`, `{ "pageProps": {…}, "fixtures": { "<path>": <answer> } }`, and this
// probe reads every such file in the tree it is booting. The sign-in kit's file
// signs the page in as an administrator, so an admin page renders its content rather than a redirect.
export const BOOT_FILE = /^page-boot\.([a-z0-9][a-z0-9-]*)\.json$/
export function bootData (root) {
  const out = { pageProps: {}, fixtures: {} }
  const dir = join(root, 'scripts')
  let names = []
  try { names = readdirSync(dir).filter((n) => BOOT_FILE.test(n)).sort() } catch { return out }
  for (const n of names) {
    const d = JSON.parse(readFileSync(join(dir, n), 'utf8'))
    Object.assign(out.pageProps, d.pageProps ?? {})
    Object.assign(out.fixtures, d.fixtures ?? {})
  }
  return out
}

function apiStub (fixtures) {
  return `
export const BASE = ''
// \`go()\` as the real client exports it, for the hard navigations a page makes. The stub's BASE is
// '' — a page is booted at the root here, never under /preview — so this is the identity, which is
// exactly what the real one answers off the prefix. It is a REAL implementation rather than an identity
// stub for one reason: a page that built a URL by string concatenation instead of calling it would
// render identically either way, and \`preview-acceptance\` is what holds the live sites to \`go()\`.
export function go (path) {
  if (typeof path !== 'string' || !path.startsWith('/') || BASE === '') return path
  if (path === BASE || path.startsWith(BASE + '/') || path.startsWith(BASE + '?')) return path
  return \`\${BASE}\${path}\`
}
// A kit's extension registers its 403 redirects at load; nothing is fetched here, so nothing redirects.
export function onApiRefusal () {}
const FIXTURES = ${JSON.stringify(fixtures)}
async function answer (method, path) {
  const key = path.replace(/^\\//, '').split('?')[0]
  if (key in FIXTURES) return FIXTURES[key]
  return method === 'GET' ? {} : { ok: true }
}
export const api = {
  get: (p) => answer('GET', p), post: (p) => answer('POST', p), put: (p) => answer('PUT', p), patch: (p) => answer('PATCH', p), delete: (p) => answer('DELETE', p),
}
export function isApiError (e) { return !!e && typeof e === 'object' && 'status' in e }
`
}

// jsdom by absolute URL: the runner lives in a temp dir, and ESM ignores NODE_PATH.
const JSDOM_URL = import.meta.resolve('jsdom')
const RUNNER = `
import { JSDOM } from ${JSON.stringify(JSDOM_URL)}
import { pathToFileURL } from 'node:url'
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'Text', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage', 'location', 'history', 'DOMParser', 'SVGElement', 'Image']) {
  if (dom.window[k] !== undefined && (globalThis[k] === undefined || k === 'location' || k === 'navigator')) {
    try { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }) } catch {}
  }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const errors = []
const origError = console.error
console.error = (...a) => { errors.push(a.map(String).join(' ')); origError(...a) }
try {
  const mod = await import(pathToFileURL(process.argv[2]).href)
  const html = await mod.boot(document.getElementById('root'))
  process.stdout.write(JSON.stringify({ ok: true, html, errors }))
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.stack || err), errors }))
}
// jsdom's timers keep the event loop alive; without this the child sits until it is killed.
process.exit(0)
`

function entryFor (pagePath, props) {
  return `
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import Page from ${JSON.stringify(pagePath)}
export async function boot (container) {
  const root = createRoot(container)
  const el = React.createElement(MemoryRouter, { initialEntries: ['/'] }, React.createElement(Page, ${JSON.stringify(props)}))
  await act(async () => { root.render(el) })
  // Let the first effects settle (session load, list fetch) and re-render.
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return container.innerHTML
}
`
}

/**
 * Boot one page module. `root` is the repo whose node_modules and src/ resolve the
 * imports; `clientPath` is the file the API stub replaces (any import resolving there).
 */
export async function bootPage ({ root, pagePath, withProps = true, data = bootData(root) }) {
  const work = mkdtempSync(join(tmpdir(), 'page-boot-'))
  try {
    const stubPath = join(work, 'api-client-stub.js')
    writeFileSync(stubPath, apiStub(data.fixtures))
    // esbuild hands a plugin the REAL path, and a temp directory is a symlink on macOS (/var → /private/var).
    const realRoot = realpathSync(root)
    const clientPath = join(root, 'src', 'api', 'client.ts')
    const result = await build({
      stdin: { contents: entryFor(pagePath, withProps ? data.pageProps : {}), resolveDir: root, loader: 'js' },
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      jsx: 'automatic',
      logLevel: 'silent',
      nodePaths: [join(TOOLS, 'node_modules')],
      define: { 'process.env.NODE_ENV': '"development"' },
      loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl' },
      plugins: [{
        name: 'immensus-page-boot',
        setup (b) {
          // Every spelling of the client — '@/api/client', './api/client', '../api/client' —
          // lands on the same absolute file, and that file becomes the stub.
          const viaStub = (abs) => (resolveTs(abs) === clientPath ? { path: stubPath } : { path: resolveTs(abs) })
          b.onResolve({ filter: /^@\// }, (args) => viaStub(join(root, 'src', args.path.slice(2))))
          b.onResolve({ filter: /^\.{1,2}\// }, (args) => (args.importer.startsWith(root) && !args.importer.includes('node_modules') ? viaStub(join(args.resolveDir, args.path)) : undefined))
          // `import.meta.glob` is Vite's and esbuild has none; src/discovery.ts uses it to find pages, kit
          // routes and kit extensions. Expanded here into the static imports Vite would compile it to.
          b.onLoad({ filter: /\.(?:ts|tsx)$/ }, (args) => {
            if (!(args.path.startsWith(root) || args.path.startsWith(realRoot)) || args.path.includes('node_modules')) return undefined
            const src = readFileSync(args.path, 'utf8')
            if (!src.includes('import.meta.glob')) return undefined
            return { contents: expandGlobs(src, dirname(args.path)), loader: args.path.endsWith('x') ? 'tsx' : 'ts', resolveDir: dirname(args.path) }
          })
        },
      }],
    })
    // A stub that matched nothing leaves the REAL client in the graph, and a page then passes
    // on the empty state its rejected fetch() falls back to (the module-stub-loader lesson).
    // The metafile is the proof: the real file must not be an input of the bundle.
    const realClientBundled = Object.keys(result.metafile.inputs).some((i) => resolveTs(join(root, i)) === clientPath || i === clientPath)
    const bundlePath = join(work, 'bundle.mjs')
    writeFileSync(bundlePath, result.outputFiles[0].text)
    const runnerPath = join(work, 'runner.mjs')
    writeFileSync(runnerPath, RUNNER)
    const r = spawnSync(process.execPath, [runnerPath, bundlePath], { cwd: TOOLS, encoding: 'utf8', env: { ...process.env, NODE_PATH: join(TOOLS, 'node_modules') }, timeout: 20000 })
    let out
    try { out = JSON.parse(r.stdout) } catch { out = { ok: false, error: `runner produced no verdict (exit ${r.status}): ${(r.stderr || '').slice(-800)}` } }
    return { ...out, realClientBundled }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err), errors: [] }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// ── `import.meta.glob`, the three forms src/discovery.ts uses and nothing more ─────────────────────────
//
// `import.meta.glob(<pattern>, { eager: true })` or `{ eager: true, import: '<name>' }`, with a string
// literal pattern relative to the importing file and an optional type argument. Each becomes an object
// literal keyed by the matched path as written (Vite's own keys), its values namespace imports hoisted
// to the top of the module. A form outside that — a lazy glob, a computed pattern — THROWS, naming
// itself, because a probe that quietly expanded it to `{}` would boot an app with no pages and report
// what it rendered.
function globRegex (glob) {
  const parts = glob.split('/')
  return new RegExp('^' + parts.map((seg, idx) => {
    if (seg === '**') return '(?:[^/]+/)*'
    const body = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    return idx === parts.length - 1 ? body : body + '/'
  }).join('') + '$')
}

export function globMatches (pattern, fromDir) {
  if (!/^\.{1,2}\//.test(pattern)) throw new Error(`page-boot expands only relative import.meta.glob patterns, not ${pattern}`)
  const segs = pattern.split('/')
  const firstWild = segs.findIndex((x) => /[*?{[]/.test(x))
  if (firstWild === -1 || /[{[]/.test(segs.slice(firstWild).join('/'))) throw new Error(`page-boot expands only * ** and ? in an import.meta.glob pattern, not ${pattern}`)
  const prefix = segs.slice(0, firstWild)
  const base = resolve(fromDir, prefix.join('/'))
  const re = globRegex(segs.slice(firstWild).join('/'))
  const out = []
  const walkDir = (dir, rel) => {
    let names = []
    try { names = readdirSync(dir).sort() } catch { return }
    for (const n of names) {
      if (n === 'node_modules' || n.startsWith('.')) continue
      const p = join(dir, n)
      const r = rel ? `${rel}/${n}` : n
      if (statSync(p).isDirectory()) walkDir(p, r)
      else if (re.test(r)) out.push([...prefix, r].join('/'))
    }
  }
  walkDir(base, '')
  return out.sort()
}

export function expandGlobs (src, fromDir) {
  const hoisted = []
  let out = ''
  let i = 0
  const marker = 'import.meta.glob'
  for (;;) {
    const at = src.indexOf(marker, i)
    if (at === -1) { out += src.slice(i); break }
    out += src.slice(i, at)
    let k = at + marker.length
    // Only a CALL is expanded: the name followed by a type argument or a paren. A mention in a comment
    // — this file's own header names it — is copied through as text.
    if (src[k] !== '<' && src[k] !== '(') { out += marker; i = k; continue }
    // A type argument may itself hold `<…>` and an arrow's `=>`, so the brackets are counted and an
    // arrow's `>` is not one.
    if (src[k] === '<') { let depth = 0; for (; k < src.length; k++) { if (src[k] === '<') depth++; else if (src[k] === '>' && src[k - 1] !== '=' && --depth === 0) { k++; break } } }
    const call = /^\(\s*(['"])([^'"]+)\1\s*(?:,\s*\{([^}]*)\})?\s*\)/.exec(src.slice(k))
    if (!call) throw new Error(`page-boot cannot expand this import.meta.glob (only a string pattern with { eager: true }): ${src.slice(at, at + 120)}`)
    const opts = call[3] ?? ''
    if (!/\beager\s*:\s*true\b/.test(opts)) throw new Error(`page-boot expands only eager import.meta.glob calls: ${src.slice(at, at + 120)}`)
    const named = /\bimport\s*:\s*(['"])([^'"]+)\1/.exec(opts)?.[2] ?? null
    const entries = globMatches(call[2], fromDir).map((rel) => {
      const id = `__glob${hoisted.length}`
      hoisted.push(`import * as ${id} from ${JSON.stringify(rel)}`)
      return `${JSON.stringify(rel)}: ${named ? `${id}[${JSON.stringify(named)}]` : id}`
    })
    out += `({ ${entries.join(', ')} })`
    i = k + call[0].length
  }
  return hoisted.join('\n') + (hoisted.length ? '\n' : '') + out
}

function resolveTs (p) {
  for (const cand of [p, `${p}.tsx`, `${p}.ts`, join(p, 'index.tsx'), join(p, 'index.ts')]) if (existsSync(cand)) return cand
  return p
}

export function verdict (out) {
  if (!out.ok) return `threw: ${out.error}`
  if (out.realClientBundled) return 'the real src/api/client.ts was bundled — the API stub did not apply'
  if (out.errors?.length) return `console.error during boot: ${out.errors[0].slice(0, 300)}`
  if (!out.html || !out.html.trim()) return 'rendered nothing'
  return null
}

// ── THE NEGATIVE CONTROLS RUN ONCE PER SUITE RUN, NOT ONCE PER INVOCATION ──────────────────────
//
// **The problem.** `page-boot-kind-acceptance` drives this file as a child process over fourteen web
// trees to prove the app-kind gate, and each child re-ran the controls below — six synthesized pages, an
// esbuild bundle and a jsdom child each — to re-prove the same verdicts. Measured on a real app: three
// quarters of a web app's suite time was that one suite, and five of every six boots in it were these.
//
// → that driver sets `IMMENSUS_PAGE_BOOT_CONTROLS=skip` on its children, and this file's OWN registered
// run — the one `run-suites.js` discovers by name, and the one the platform spawns as Tier A's `boot`
// check — never sets it, so the controls still run in every suite pass and every build. Only the exact
// value `skip` skips, and the skip says so: a child that skipped them is not evidence that they hold.
const CONTROLS = process.env.IMMENSUS_PAGE_BOOT_CONTROLS === 'skip' ? 'skip' : 'run'
if (CONTROLS === 'skip') {
  section('negative controls: skipped')
  console.log('  ⏭  IMMENSUS_PAGE_BOOT_CONTROLS=skip — set by page-boot-kind-acceptance on the trees it drives; this')
  console.log('     file\'s own registered run proves the controls in the same suite pass')
} else {
  section('negative controls (synthesized pages in a temp src/)')
  const w = mkdtempSync(join(tmpdir(), 'page-boot-fixture-'))
  mkdirSync(join(w, 'src', 'pages'), { recursive: true })
  mkdirSync(join(w, 'src', 'api'), { recursive: true })
  writeFileSync(join(w, 'src', 'api', 'client.ts'), 'export const api = {}\n')
  // A module-scope read of a const declared further down (TDZ).
  writeFileSync(join(w, 'src', 'pages', 'Tdz.tsx'), "const KEYS = FILTER_KEYS.slice()\nconst FILTER_KEYS = ['a']\nexport default function Tdz () { return <div>{KEYS.length}</div> }\n")
  writeFileSync(join(w, 'src', 'pages', 'Empty.tsx'), 'export default function Empty () { return null }\n')
  writeFileSync(join(w, 'src', 'pages', 'Throws.tsx'), "export default function Throws () { throw new Error('render exploded') }\n")
  writeFileSync(join(w, 'src', 'pages', 'Warns.tsx'), "export default function Warns () { return <ul>{[1, 2].map((n) => <li>{n}</li>)}</ul> }\n")
  writeFileSync(join(w, 'src', 'pages', 'Good.tsx'), "import { useEffect, useState } from 'react'\nimport { api } from '@/api/client'\nexport default function Good () { const [n, setN] = useState('…'); useEffect(() => { api.get('Probe/greeting').then((m: any) => setN(m.email)) }, []); return <main><h1>Hello {n}</h1></main> }\n")
  // The glob form src/discovery.ts uses, expanded the way this probe expands it for esbuild: two pages
  // found by directory and a third in a subdirectory, rendered by the name they were found under.
  // A directory of its own, because an eager glob IMPORTS every match and the TDZ page above throws on import.
  mkdirSync(join(w, 'src', 'globbed', 'deep'), { recursive: true })
  writeFileSync(join(w, 'src', 'globbed', 'Outer.tsx'), 'export default function Outer () { return <b>outer</b> }\n')
  writeFileSync(join(w, 'src', 'globbed', 'deep', 'Inner.tsx'), 'export default function Inner () { return <i>inner</i> }\n')
  writeFileSync(join(w, 'src', 'Globbed.tsx'), "const found = import.meta.glob<{ default: () => any }>('./globbed/**/*.tsx', { eager: true })\nexport default function Globbed () { const names = Object.keys(found).sort(); const Inner = found['./globbed/deep/Inner.tsx'].default; return <main>{names.join(',')}<Inner /></main> }\n")
  writeFileSync(join(w, 'src', 'Lazy.tsx'), "const found = import.meta.glob('./pages/*.tsx')\nexport default function Lazy () { return <main>{Object.keys(found).length}</main> }\n")
  const data = { pageProps: {}, fixtures: { 'Probe/greeting': { email: 'admin@example.test' } } }
  const tdz = await bootPage({ root: w, pagePath: join(w, 'src', 'pages', 'Tdz.tsx'), data })
  check('a TDZ crash at module scope fails', verdict(tdz)?.startsWith('threw') === true, verdict(tdz))
  const empty = await bootPage({ root: w, pagePath: join(w, 'src', 'pages', 'Empty.tsx'), data })
  check('a page that renders nothing fails', verdict(empty) === 'rendered nothing', verdict(empty))
  const throws = await bootPage({ root: w, pagePath: join(w, 'src', 'pages', 'Throws.tsx'), data })
  check('a page that throws while rendering fails', verdict(throws) !== null, verdict(throws))
  const warns = await bootPage({ root: w, pagePath: join(w, 'src', 'pages', 'Warns.tsx'), data })
  check('a page that logs console.error (a missing key) fails', verdict(warns)?.startsWith('console.error') === true, verdict(warns))
  const good = await bootPage({ root: w, pagePath: join(w, 'src', 'pages', 'Good.tsx'), data })
  check('a healthy page with a stubbed API call renders its data', verdict(good) === null && /admin@example\.test/.test(good.html ?? ''), verdict(good) ?? good.html)
  const globbed = await bootPage({ root: w, pagePath: join(w, 'src', 'Globbed.tsx'), data })
  check('an eager import.meta.glob is expanded to the modules Vite would find, keyed as Vite keys them, subdirectories included', verdict(globbed) === null && (globbed.html ?? '').includes('./globbed/Outer.tsx,./globbed/deep/Inner.tsx<i>inner</i>'), verdict(globbed) ?? globbed.html)
  const lazy = await bootPage({ root: w, pagePath: join(w, 'src', 'Lazy.tsx'), data })
  check('NO: a lazy import.meta.glob is refused by name, never expanded to nothing', verdict(lazy)?.includes('only eager import.meta.glob') === true, verdict(lazy))
  rmSync(w, { recursive: true, force: true })
}

section(TREE === TOOLS ? 'this repository' : `the tree at ${TREE}`)
const pages = [join(TREE, 'src', 'App.tsx'), ...walk(join(TREE, 'src', 'pages'), /\.tsx$/)].filter(existsSync)

// ── THE FLOOR IS ONE MODULE, NOT TWO, AND IT IS A CLAIM ABOUT THIS PROBE RATHER THAN ABOUT THE APP ──
//
// **The problem.** This read `pages.length >= 2`, so an app whose whole interface is `src/App.tsx`
// was refused for its SHAPE rather than for failing to work. One page is a correct app — a landing
// page, a calculator, a single screen with no second destination — and `boot` is a DELIVERY check
// (the platform's `ownerOf('boot')` answers `platform`, driven rather than read), so
// the refusal did not merely print a wrong row: it refused the build of every one-page app.
//
// An application only has to be **up**, shown by anything that responds — a page, a service endpoint, a
// WebSocket. The floor of two was the platform deciding what shape a customer's app had to be.
//
// **Why it is ONE and not zero, which is the whole of the judgement here.** Deleting the assertion
// was the other option and it is the worse one: with no modules discovered the loop below runs zero
// times, so the probe would exit 0 having checked nothing and `boot` — the check a build's verdict is
// read from — would report green over an app with no interface at all. That is `instruments`'
// `boot-probe-always-green` by construction, and §5's own closing rule: an instrument that stops
// discriminating goes GREEN, not red. So what survives is the weakest claim that keeps the probe able
// to say no, and it is about the probe and not about the app — *there is something here to boot*. The
// per-page loop below is untouched and is where delivery is actually proven: every module the app
// does ship must render without throwing and without a `console.error`.
check(`discovered ${pages.length} page module(s) under src/ — at least one, so this probe has a subject`, pages.length >= 1, pages.map((p) => relative(TREE, p)).join(', '))
for (const p of pages) {
  const out = await bootPage({ root: TREE, pagePath: p, withProps: !p.endsWith('App.tsx') })
  const v = verdict(out)
  check(`${relative(TREE, p)} boots and renders`, v === null, v ?? '')
}
void dirname
process.exit(done())
