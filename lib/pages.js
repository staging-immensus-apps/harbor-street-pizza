// SEEDED — serves the app's pages and its build stamp, at THIS COPY's own address.
//
// THE PROBLEM. Every page route answers with `web/index.html` and the single-page app routes from
// there, and `GET /build` answers the build stamp a deploy is proven by. Fastify served both once
// — and Harper serves only ONE component's `fastifyRoutes` per
// process: a second component's routes folder is dropped with one WARN line while that component still
// reports healthy (Harper's `fastifyRoutes.ts:61-98`, "Root plugin has already booted").
// An update to a published app runs two copies of this app in one process, so the preview copy's
// pages and stamp would simply not exist. Which copy loses is not something the app chooses.
//
// → each copy registers its own `server.http` listener (resources/Pages.js) and this module is what it
// answers with. Each answers under its own mount (lib/copy.js's `copyBase()`): the published copy at
// the root, the preview copy at `/preview`, a sharing app at `/<its slug>` and that app's preview copy
// at `/<its slug>/preview`. The first two measured working both ways on a real
// `harper@5.3.1` and on a two-node Fabric cluster. Two different trees, one at the root and
// one at `/tracker`, were measured on a real `harper@5.3.1` by a spike the platform ran
// (2026-10-20, 13 of 13) — but the spike wrote those trees itself, so this
// module's half at a sharing app's mount is proven only by the suites here, against the stub.
//
// TWO LISTENERS IN ONE CHAIN MUST NEVER BOTH CLAIM A PATH, and the rule that guarantees it is here
// rather than in an ordering nobody controls: every copy registers `before: 'rest'` in the main chain,
// and which runs first is component load order. So a copy answers only under its own mount, and inside
// it DECLINES two kinds of path — even one its own route table would match, such as a `/:slug` or
// `/*` page: its own `<mount>/preview`, which is its preview copy's, and every other app's mount that
// sits under it (`IMMENSUS_SHARING_MOUNTS`, which only the app at the root has). That makes `/preview`
// a reserved path in every app, which it already was, and a sharing app's slug a reserved path in the
// app at the root.
//
// IMPORTS NO HARPER, so a suite drives `createPagesListener` with a plain request object and a recorded
// `nextLayer`. The one line that touches Harper is resources/Pages.js.

import { readFileSync, readdirSync } from 'node:fs'
import { SPA_ROUTES } from '../routes/spa.js'
import { buildStamp } from '../routes/build.js'
import { apexTarget } from '../routes/apex.js'
import { config } from './config.js'
import { PREVIEW_PREFIX } from './copy.js'

export const STAMP_PATH = '/build'

// ── A KIT'S PAGE ROUTES, FOUND BY FILE NAME ─────────────────────────────────────
//
// THE PROBLEM. When a plan says people sign in, the platform copies the sign-in kit into the app, and it
// copies only NEW files — it never edits one the app already has, so it cannot add `/login` to
// routes/spa.js. So a kit brings its routes as `routes/spa.<kit>.json` and this module serves every such
// file beside routes/spa.js. The browser reads the same files (src/discovery.ts), so the two cannot
// disagree about a kit's routes.
//
// JSON AND NOT A MODULE, deliberately: it is read here SYNCHRONOUSLY, at load, with the `node:fs` this
// file already uses for the shell — no dynamic import, no top-level await (which Harper refuses in a
// `jsResource` module), and nothing that can reach `harperdb` (rule 5). Each route is the same
// `{ path, page, admin? }` shape src/routes.ts uses; only `path` matters here.
//
// A KIT FILE THAT CANNOT BE READ IS REPORTED AND SKIPPED, never thrown: a throw here takes resources/
// Pages.js down with it, and every page with it, over one kit's file. `spa-routes-acceptance` is what
// refuses a malformed one before it ships.
export const KIT_ROUTE_FILE = /^spa\.([a-z0-9][a-z0-9-]*)\.json$/
const ROUTES_DIR = new URL('../routes/', import.meta.url)

/** Is this entry of a kit route file a route? An absolute path and a non-empty page name. */
export const isKitRoute = (r) => !!r && typeof r === 'object' && typeof r.path === 'string' && r.path.startsWith('/') && typeof r.page === 'string' && r.page !== ''

/** Every kit route file's routes, in file-name order: `[{ kit, path, page, admin }]`. */
export function kitRoutes (dir = ROUTES_DIR) {
  let names = []
  try { names = readdirSync(dir).filter((n) => KIT_ROUTE_FILE.test(n)).sort() } catch { return [] }
  const out = []
  for (const name of names) {
    const kit = KIT_ROUTE_FILE.exec(name)[1]
    let list
    try { list = JSON.parse(readFileSync(new URL(name, dir), 'utf8')) } catch (err) {
      console.error(`[pages] routes/${name} could not be read (${err?.message ?? err}); its routes are not served`)
      continue
    }
    if (!Array.isArray(list)) { console.error(`[pages] routes/${name} is not an array of routes; its routes are not served`); continue }
    // The same predicate src/discovery.ts uses, so the browser and the server never disagree about which
    // entries are routes: an absolute path AND a page name. An entry with no page renders nothing in the
    // browser, so serving its shell here would be a page that only redirects home.
    for (const r of list) if (isKitRoute(r)) out.push({ kit, path: r.path, page: r.page, admin: r.admin === true })
  }
  return out
}

/**
 * Every page route this copy answers: the app's own (routes/spa.js) and every kit's. Read ONCE, when the
 * module loads: a kit is copied in by a build and reaches the cluster in a deploy, which restarts the
 * component, so a route file added to a running process is served after that restart and not before.
 */
export const PAGE_ROUTES = [...SPA_ROUTES, ...kitRoutes().map((r) => r.path)]

/**
 * The part of `pathname` this copy owns, relative to its base, or `null` when it is not this copy's.
 *
 * A copy at `base` (`''` at the root, else `/preview`, `/tracker`, `/tracker/preview`) owns `base`
 * itself (which is its `/`) and what is under it, EXCEPT `<base>/preview` and every entry of
 * `declined` strictly under `base`, with what is under each of those. An entry that is not strictly
 * under `base` is ignored, so a copy handed its own mount still answers. Exact rather than
 * `startsWith(PREFIX)`: `/previewish` and `/trackers` are the root copy's.
 */
export function relativeTo (pathname, base = '', declined = []) {
  const p = typeof pathname === 'string' && pathname.startsWith('/') ? pathname : null
  if (p === null) return null
  const under = (prefix) => p === prefix || p.startsWith(`${prefix}/`)
  if (base && !under(base)) return null
  const others = [`${base}${PREVIEW_PREFIX}`, ...declined.filter((m) => typeof m === 'string' && m.startsWith(`${base}/`))]
  if (others.some(under)) return null
  const rest = p.slice(base.length)
  return rest === '' ? '/' : rest
}

// One trailing slash is ignored, as Harper's Fastify did (`ignoreTrailingSlash: true`), so `/login/`
// is `/login`. The root stays `/`.
const normalize = (p) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)

/**
 * Does a route in the router's own syntax answer `path`?
 *
 * Three shapes, and they are the three src/routes.ts uses: an exact path, a `:name` segment matching
 * one non-empty segment, and a trailing `/*` matching the prefix itself AND everything below it —
 * `/admin/*` answers `/admin`, `/admin/` and `/admin/users/7` (the bare path is the one a person
 * types). Case-sensitive, as Harper's own routing is.
 */
export function routeMatches (route, path) {
  const want = normalize(String(route))
  const got = normalize(path)
  if (want === '/*') return true
  if (want.endsWith('/*')) {
    // The prefix's own segments must match the path's leading ones; anything may follow them.
    const prefix = want.slice(0, -2)
    const n = prefix.split('/').length
    const parts = got.split('/')
    return parts.length >= n && matchSegments(prefix, parts.slice(0, n).join('/'))
  }
  return matchSegments(want, got)
}

function matchSegments (route, path) {
  const r = route.split('/')
  const p = path.split('/')
  if (r.length !== p.length) return false
  for (let i = 0; i < r.length; i++) {
    if (r[i].startsWith(':')) { if (!p[i]) return false; continue }
    if (r[i] !== p[i]) return false
  }
  return true
}

/** Is `path` (relative to this copy) one of the app's page routes? */
export function isPage (path, routes = PAGE_ROUTES) {
  return routes.some((route) => routeMatches(route, path))
}

/**
 * Stamp `?v=<processStartedAt>` on UNHASHED site-relative public URLs (favicon, manifest, OG card) so a
 * redeploy invalidates them; Vite's `<web>/assets/*` are content-hashed and left alone. `webBase` is
 * the copy's asset mount — `/web/` at the root, `/<mount>/web/` in a copy at a mount, whose shell the
 * builder rebases onto that root at deploy time. Two guards: only site-relative references
 * (an absolute og:image stays byte-stable so shared links are not re-scraped), and idempotent (a URL
 * that already carries a query is not stamped twice).
 */
export function stampPublicUrls (source, version, webBase = '/web/') {
  const v = encodeURIComponent(version)
  const base = webBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return String(source).replace(
    new RegExp(`(["'(,]\\s*)${base}(?!assets/)([a-zA-Z0-9._/-]+\\.(?:ico|png|jpg|jpeg|svg|webp|avif|gif|json|webmanifest|txt|xml))(?![?\\w])`, 'g'),
    (_, lead, file) => `${lead}${webBase}${file}?v=${v}`,
  )
}

const INDEX_URL = new URL('../web/index.html', import.meta.url)
const STARTED = new Date().toISOString()

// THE APP'S NAME IS A DEPLOY-TIME VALUE AND THE SHELL IS BUILT BEFORE IT, so the server writes it into the
// shell's title, where the page header and the browser tab both read it (src/components/shell.tsx). Only the
// title the template ships: an app that wrote its own keeps it.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
export const titled = (shell, name) => String(shell).replace('<title>App</title>', () => `<title>${String(name).replace(/[&<>]/g, (c) => HTML_ESCAPES[c])}</title>`)

/**
 * The listener. `base` is the copy's own mount (lib/copy.js's `copyBase()`) and `declined` the other
 * apps' mounts (`sharingMounts()`), both passed by resources/Pages.js; the other options are seams for a
 * suite and production passes none of them.
 *
 * `readShell` is read LAZILY and its success is cached: `web/` is BUILT and gitignored, so it is absent
 * under `harper dev .` before the first `npm run build`, and a module that threw at import would take
 * the listener down with it. The 503 says what to run.
 */
export function createPagesListener ({ base = '', declined = [], routes = PAGE_ROUTES, readShell = () => readFileSync(INDEX_URL, 'utf8'), stamp = buildStamp, apex = apexTarget, started = STARTED, name = config.appName } = {}) {
  let shell = null
  const webBase = `${base}/web/`
  const shellBody = () => {
    if (shell) return shell
    let source
    try {
      source = readShell()
    } catch (err) {
      console.warn(`[pages] ${INDEX_URL.pathname} unreadable: ${err?.message ?? err}`)
      return null
    }
    // Outside the try: a CONFIG.env that cannot be read throws (rule 30), and a 503 saying to run a build
    // would blame the wrong thing.
    shell = stampPublicUrls(titled(source, name()), started, webBase)
    return shell
  }
  return function pages (request, nextLayer) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return nextLayer(request)
    const rel = relativeTo(request.pathname ?? String(request.url ?? '').split('?')[0], base, declined)
    if (rel === null) return nextLayer(request)
    const path = normalize(rel)
    if (path === STAMP_PATH) {
      const s = stamp()
      // A cached build stamp is worse than none: it would answer "whose build is this?" with a
      // snapshot from before the deploy it is meant to detect.
      return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, max-age=0', 'x-build-sha': s.sha ?? 'unstamped' }, body: JSON.stringify(s) }
    }
    if (!isPage(path, routes)) return nextLayer(request)
    const target = apex(request.headers?.get?.('host'), request.url)
    if (target) return { status: 301, headers: { location: target, 'cache-control': 'no-store' }, body: '' }
    const body = shellBody()
    if (!body) return { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: 'web/index.html is missing — run `npm run build` before deploying or serving pages.\n' }
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }, body }
  }
}
