// THE HELPERS THIS KIT USED TO EXPECT THE APPLICATION TO EXPORT, CARRIED BY THE KIT INSTEAD.
//
// **The problem, measured.** The sign-in kit reached out of itself for twelve helpers across four
// of the core's files. `web-app-template` exports all twelve; `agent-template`, `service-template`
// and `pipeline-template` export none of them. So a plan whose user had approved a sign-in could not
// be given one on any application seeded from the other three templates — and a real build is
// what that cost: dead at its first backend stage, on an unattended social-media agent whose
// own plan had six screens and a `/signin` among them.
//
// This shape was chosen over the two alternatives: the kit carries its own, rather
// than the three headless templates each growing twelve exports (and
// `agent-template` would have gained a `Scheduler` it deliberately has no loop for) or the capability
// simply staying unavailable.
//
// **IT IS MUCH SMALLER THAN THE TWELVE SUGGESTS, and that is the finding rather than a boast.** Every
// one of these is a pure function or a constant that composes from exports **all four templates
// already have** — `readKey` and `ownConfig` from `./config.js`, `isPreviewCopy` and
// `PREVIEW_PREFIX` from `./copy.js`, `NO_STORE`, `json` and `headerOf` from `./http.js`. So nothing
// stateful is duplicated: the configuration reader, the database handle and the preview predicate
// are still the application's own, and this file is composition over them.
//
// **THE COST, STATED RATHER THAN SMOOTHED.** In a `web_app` the core also exports these names, so
// such an application ends up with two definitions of `redirect`, `clientIp`, `runAuthed`,
// `previewPath`, `publicBaseFor` and `refuseOnPreview` — the core's and this one's — and the sign-in
// code uses THIS one. A person editing `lib/http.js` to change how a redirect behaves will not
// change what sign-in does. That is the trade: duplicated once here, inside the thing that needs it,
// rather than three times across templates where nothing could tell when two of them had drifted.
//
// `schedulerStatus` is the one that is NOT vendored, because it cannot be: it reports on a scheduler
// that a headless application does not have. It is a dynamic import with a stated fallback — see its
// own note below.

import { ownConfig, readKey } from './config.js'
import { PREVIEW_PREFIX, isPreviewCopy } from './copy.js'
import { NO_STORE, headerOf, json } from './http.js'

// ── configuration ────────────────────────────────────────────────────────────────────────────────

/** The two values a send needs, by name. The mail provider's key and the address it sends from. */
export const MAIL_PAIR = Object.freeze(['RESEND_API_KEY', 'EMAIL_FROM'])

/** The address whose first sign-in becomes the administrator. */
export const OWNER_KEY = 'OWNER_EMAIL'

/** Absent, or present and nothing but whitespace. The one predicate every default below rests on. */
export const isBlank = (v) => v == null || String(v).trim() === ''

/**
 * Where a per-application value is read from: this copy's own `CONFIG.env` when it carries a
 * non-blank value under `keyName`, else `process.env`, which is where Harper's secret store
 * delivers it. The name is an argument so a probe can drive it under scratch names on a real
 * cluster.
 */
export function secretSource (keyName) {
  const file = ownConfig()
  return file && !isBlank(file[keyName]) ? file : process.env
}

/**
 * A non-negative number from configuration, or the documented default with one warning.
 *
 * A malformed number must not silently become 0 on a guardrail that then reads as "a cap of zero" —
 * which is the whole reason this is not `Number(readKey(name)) || fallback`.
 */
export function nonNegNumber (name, fallback) {
  const raw = readKey(name)
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[sign-in-config] ${name}="${raw}" is not a non-negative number — using default ${fallback}`)
    return fallback
  }
  return n
}

// ── which copy is serving ────────────────────────────────────────────────────────────────────────

// THE PATH THIS COPY IS MOUNTED AT, READ HERE RATHER THAN BORROWED. A copy is at
// the root, at `/preview`, at a sharing app's `/<slug>` or at that app's `/<slug>/preview`, and the
// builder names which in `IMMENSUS_URL_PATH` in the copy's own `CONFIG.env`. `web-app-template`'s
// `lib/copy.js` answers it as `copyBase()`, but a kit may borrow only `PREVIEW_PREFIX` and
// `isPreviewCopy` from `./copy.js` (kits/assemble.mjs `COMMON_CORE`), so this file reads the key through
// `readKey` with the same rules: blank is absent, absent falls back to `/preview` for a preview copy and
// to the root otherwise, and a value that is not lower-case segments THROWS rather than being repaired.
// `kits/assemble.mjs --self-test` holds the two answers to each other at every mount.
const URL_PATH_KEY = 'IMMENSUS_URL_PATH'
const SEGMENT = /^[a-z0-9][a-z0-9-]*$/

function mountBase () {
  const raw = readKey(URL_PATH_KEY)
  const trimmed = isBlank(raw) ? '' : String(raw).trim().replace(/^\/+|\/+$/g, '')
  if (trimmed === '') return isPreviewCopy() ? PREVIEW_PREFIX : ''
  const segments = trimmed.split('/')
  if (!segments.every((seg) => SEGMENT.test(seg))) throw new Error(`${URL_PATH_KEY}=${JSON.stringify(String(raw))} is not a mount: each segment must be lower-case letters, digits and hyphens. Refusing to guess which path this copy serves`)
  return `/${segments.join('/')}`
}

/**
 * A path as THIS copy should serve it. The preview copy answers under `/preview` and a sharing app
 * under its own mount, so a link it writes has to come back there: the `MagicLink` row it needs was
 * written to this copy's database, and a link to another address would either fail there or sign the
 * person in to a different copy, or a different app.
 */
export function previewPath (path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return path
  const base = mountBase()
  if (base === '' || path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}?`)) return path
  return `${base}${path}`
}

/** The absolute base an emailed link should use from this copy. */
export function publicBaseFor (base) {
  const mount = mountBase()
  return mount ? `${String(base).replace(/\/+$/, '')}${mount}` : base
}

/**
 * Refuse this request if this is the preview copy, or `null` to carry on.
 *
 * For a route whose caller is a third party's machine: the payment and mail providers post their
 * events to the live address and nobody previewing their own application posts one to it, so
 * refusing costs a preview nothing and takes a public surface off the internet. It is deliberately
 * not a list of resources judged unsafe for a preview — serving the whole application against dummy
 * data is what a preview is.
 */
export function refuseOnPreview (jsonFn, { error, code }) {
  return isPreviewCopy() ? jsonFn({ error, code }, 403) : null
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────

/** A redirect that is never cached, with any cookies the caller is setting. */
export function redirect (url, { cookies = [], status = 302 } = {}) {
  const h = new Headers({ Location: url, 'Cache-Control': NO_STORE })
  for (const c of cookies) h.append('Set-Cookie', c)
  return new Response(null, { status, headers: h })
}

/** The caller's address, as the proxy in front of this cluster reports it, or null. */
export function clientIp (self) {
  const xff = headerOf(self, 'x-forwarded-for')
  if (xff) return xff.split(',')[0].trim() || null
  return headerOf(self, 'cf-connecting-ip') ?? null
}

/**
 * Run a handler and turn a downstream 401 into a 502.
 *
 * Harper claims the `Authorization` header, so a 401 travelling up from something this application
 * called would make the browser put up its own basic-auth dialog over the application's own sign-in.
 * A 502 says what actually happened: a service we depend on refused us.
 */
export async function runAuthed (fn) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof Response) return err
    if (err?.status === 401 || err?.statusCode === 401) {
      console.error('[auth-wrap] downstream 401 — surfacing as 502 to avoid the browser basic-auth dialog:', err?.message ?? err)
      return json({ error: 'Upstream service auth failed', detail: err?.message ?? String(err) }, 502)
    }
    throw err
  }
}

// ── the one that is not vendored ─────────────────────────────────────────────────────────────────

// Node's ESM loader and Harper's loader name the same absence differently. Both, so neither host sends
// a headless app to the `error` branch for a module it is designed not to have.
export const MISSING_MODULE_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'])

/**
 * Was the module Node could not find `resources/Scheduler.js` itself, rather than something it
 * imports? `err.url` where the runtime sets it, else the FIRST quoted path in the message, which is
 * the one it was looking for — the second is the importer and reading that would invert the test.
 *
 * **MEASURED ON 2026-10-25, AND HARPER DOES DIFFER**. On a real
 * `harper@5.3.2`, with this file in a real `agent-template` tree that has no `resources/Scheduler.js`:
 * the component loaded **healthy** — so Harper's linker does NOT refuse a dynamic import of an absent
 * module, which was the outcome that would have stopped an application starting — and the throw
 * carried `code: 'MODULE_NOT_FOUND'` with `url: null` and a `Require stack:` in the message, where
 * plain Node gives `ERR_MODULE_NOT_FOUND`. Keying on the ESM code alone therefore sent every headless
 * app to the `error` branch. `MISSING_MODULE_CODES` holds both.
 */
function missingModuleIsScheduler (err) {
  const url = typeof err?.url === 'string' ? err.url : null
  if (url) return /(^|\/)Scheduler\.js$/.test(url.split('?')[0])
  const quoted = /Cannot find (?:module|package) ['"]([^'"]+)['"]/.exec(String(err?.message ?? ''))
  return quoted ? /(^|\/)Scheduler\.js$/.test(quoted[1].split('?')[0]) : false
}

/**
 * The scheduler's own status for the administrator's panel, or a stated absence.
 *
 * **IT CANNOT BE VENDORED, and that is the difference between this and everything above.** The others
 * are pure; this one reports on a `resources/Scheduler.js` that a headless application does not have
 * — `agent-template` is request-driven by design and ships no loop at all. A vendored copy would
 * either lie about a scheduler that is not there or shadow the real one in a `web_app`.
 *
 * So it is a DYNAMIC import: a static import of a module that is not there fails the whole component
 * at load, which would take every route in the application down over one panel on one admin page.
 * Where the module is there, the real status is returned and nothing changes. Where it is not, the
 * panel is told so in as many words rather than shown an empty object it would render as a broken
 * scheduler.
 */
export async function schedulerStatus () {
  try {
    const mod = await import('../resources/Scheduler.js')
    if (typeof mod.schedulerStatus !== 'function') return { scheduler: 'none', detail: 'this app has a Scheduler resource that reports no status' }
    return await mod.schedulerStatus()
  } catch (err) {
    // **ONLY A MISSING MODULE IS "none". EVERYTHING ELSE IS AN ERROR, AND SAYING SO IS THE POINT**
    // A bare `catch {}` here reported every
    // failure as "this app runs no scheduled work" — so on a `web_app`, a scheduler that was
    // genuinely broken, or a `Scheduler.js` with a syntax or link error, would show the
    // administrator a calm "none". That is a gate whose message can be false about what it found,
    // which is the cry-wolf shape inverted: not a false alarm, a false all-clear.
    // **AND IT HAS TO BE *THIS* MODULE THAT IS MISSING**
    // A `Scheduler.js` that exists and imports something that does not ALSO
    // throws `ERR_MODULE_NOT_FOUND` — so keying on the code alone would report "no scheduled work"
    // for an application whose scheduler is broken, which is the same false all-clear the `error`
    // branch was added to remove, one level deeper. Node's message names the module it could not
    // find first (`Cannot find module 'X' imported from Y`), so the specifier is what decides.
    // BOTH CODES, AND THAT IS MEASURED RATHER THAN DEFENSIVE. Node's ESM loader throws
    // `ERR_MODULE_NOT_FOUND`; HARPER'S LOADER THROWS `MODULE_NOT_FOUND` — the CommonJS code, with a
    // `Require stack:` in the message — so keying on the ESM code alone sent every headless app to the
    // `error` branch, which is what this file used to say was UNVERIFIED. Driven on a real
    // `harper@5.3.2` against a real `agent-template` tree with no Scheduler (2026-10-25):
    // the component loaded `healthy` and the throw carried
    // `code: 'MODULE_NOT_FOUND'`, `url: null`.
    if (MISSING_MODULE_CODES.has(err?.code) && missingModuleIsScheduler(err)) return { scheduler: 'none', detail: 'this app runs no scheduled work' }
    // Returned rather than thrown, because `AdminApi` would otherwise answer 500 for the whole admin
    // surface over one panel. An administrator reading `error` with the reason can act; a 500 on
    // `/AdminApi/users` because the scheduler panel broke cannot be acted on at all.
    console.error('[sign-in-support] the scheduler status could not be read:', err?.message ?? err)
    return { scheduler: 'error', detail: String(err?.message ?? err).slice(0, 300) }
  }
}
