// SEEDED — which copy of this app is running here, and at which path: the published copy or the preview
// copy, at the root of the cluster or at a sharing app's mount.
//
// THE PROBLEM. A build or an update has to be looked at before it goes live, against dummy data, while
// the published app keeps serving its members. So for an update, TWO COPIES of this app run on the
// app's one cluster at once:
//
//   · the PUBLISHED copy — this repository deployed as it is, at the app's own address, reading `data`;
//   · the PREVIEW copy — the same tree, deployed by the builder under its own component name with
//     every URL mounted under `/preview` and every table declared in `stage`, reading `stage`.
//
// The builder makes the preview copy at DEPLOY time, in its own checkout, and never commits any of it,
// so this repository deployed as-is anywhere is an ordinary app at
// the root on `data`. Measured on one `harper@5.3.1` and on a two-node
// Fabric cluster at 5.3.0, two copies built that way do not cross: 31 of 31, 11 of 11,
// and ~19,400 samples per copy with no request answered by the other copy's code or database.
//
// ── HOW A COPY KNOWS WHICH IT IS: its own `CONFIG.env`, never the request ──────────────────────────
//
// `config.previewCopy()` is `IMMENSUS_PREVIEW=true` in the preview copy's own file and absent from
// every other (lib/config.js says why a copy's own file is the only safe source). It is a property of
// the PROCESS'S COPY, not of the request, which is what replaced the per-request mechanism this module
// used to hold (lib/preview.js, lib/preview-request.js, resources/Preview.js — a middleware that marked
// any request under `/preview` and rewrote its URL). That mechanism cannot coexist with a second copy:
// in the published copy it would rewrite `/preview/AuthApi` to `/AuthApi` ahead of REST, so the
// preview address would serve the PUBLISHED code reading `stage`. So it is
// gone, and every caller below asks the copy instead of the request.
//
// IMPORTS ONLY lib/config.js, which imports only `node:fs`, so a route module, a page listener and a
// plain node script may all import it.

import { config } from './config.js'

// ── WHERE THIS COPY IS MOUNTED, AND WHY THAT IS NOT THE SAME QUESTION AS "IS THIS THE PREVIEW?" ─────
//
// A SHARING APP — an app that runs in another app's cluster — is served
// at `/<its slug>`, and its own preview copy at `/<its slug>/preview`. So the path a
// copy serves under is not always `/preview` or nothing, and a copy at a path is not always a preview:
//
//   copy                                IMMENSUS_URL_PATH   IMMENSUS_PREVIEW   copyBase()
//   an app at the root of its cluster   absent              absent             ''
//   its preview copy                    preview             true               /preview
//   a sharing app's published copy      tracker             absent             /tracker
//   that sharing app's preview copy     tracker/preview     true               /tracker/preview
//
// Everything that composes a URL follows `copyBase()`: `previewPath()`, `publicBaseFor()`, the page
// listener (lib/pages.js) and, in the browser, src/api/client.ts's `BASE`, which reads the same mount
// out of the URL the builder gave the shell's own script. Everything that asks whether this copy is
// looking at dummy data keeps asking `isPreviewCopy()`: `refuseOnPreview()`, the scheduler, `Bootstrap`
// and the database guard in lib/db.js. A sharing app's published copy therefore takes its own webhooks
// and runs its own scheduler. A preview copy deployed before the builder wrote `IMMENSUS_URL_PATH` has no
// path in its file, and `copyBase()` answers `/preview` for it, as it always did.

// The preview copy's own segment, below whatever the app is mounted at. The builder mounts the root
// app's preview copy here and a sharing app's at `/<slug>/preview`, and lib/pages.js declines it in
// every copy that is not the preview, so `/preview` is a reserved path in every app.
export const PREVIEW_PREFIX = '/preview'

// One segment of a mount, in the builder's own grammar: lower-case letters, digits and hyphens, which is the shape
// of every slug the control plane mints and of `preview`. A value made of anything else THROWS, naming
// the key, rather than being repaired: a mount repaired here would differ from the address the platform
// recorded, and a `..` segment would compose links that leave this copy for the app at the root.
const SEGMENT = /^[a-z0-9][a-z0-9-]*$/

function mountPath (value) {
  const trimmed = String(value ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (trimmed === '') return ''
  const segments = trimmed.split('/')
  if (!segments.every((s) => SEGMENT.test(s))) throw new Error(`IMMENSUS_URL_PATH=${JSON.stringify(String(value))} is not a mount: each segment must be lower-case letters, digits and hyphens. Refusing to guess which path this copy serves`)
  return `/${segments.join('/')}`
}

/** Is this process the preview copy? */
export function isPreviewCopy () {
  return config.previewCopy()
}

/** The path every URL this copy serves sits under: `''` at the root, else `/preview`, `/tracker`, `/tracker/preview`. */
export function copyBase () {
  const mount = mountPath(config.urlPath())
  if (mount) return mount
  return isPreviewCopy() ? PREVIEW_PREFIX : ''
}

/**
 * A site-relative path as THIS copy serves it: `/login` → `/preview/login` in the preview copy, and
 * `/tracker/login` in a sharing app's published copy at `/tracker`.
 *
 * FOR A SERVER-ISSUED `Location`, which `src/api/client.ts`'s `BASE` cannot reach. A person who
 * clicks a preview magic link gets a `stage`-stamped cookie and then a 302 — and an unprefixed
 * `Location` sends them to the published copy, which refuses that cookie, so they land signed OUT on
 * the live app instead of signed in on their preview. From a
 * sharing app the same unprefixed `Location` lands in the app at the root, which is a different app.
 *
 * IDEMPOTENT AND ABSOLUTE-SAFE: an already-prefixed path and an absolute URL come back unchanged, so a
 * caller cannot double it and a `Location` pointing at another origin is never rewritten. The cost of
 * idempotence is that an app's own route that begins with its own mount (`/tracker/x` inside the
 * sharing app at `/tracker`) reads as already prefixed, which is why a mount is a reserved path inside
 * its app as `/preview` is. `preview-acceptance` asserts every `redirect(` in `resources/` passes
 * through this, so a redirect added without it reds rather than quietly leaving the copy.
 */
export function previewPath (path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return path
  const base = copyBase()
  if (base === '' || path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}?`)) return path
  return `${base}${path}`
}

/**
 * The absolute base an emailed link should use from THIS copy.
 *
 * `config.publicAppUrl()` is the cluster's own address. From the preview copy a magic link or an invite
 * has to come back to `/preview`, because the `MagicLink` row it needs was written to `stage` — a link
 * to the live address would either fail there or sign the person in on production.
 * From a sharing app it has to come back to that app's mount, or
 * it opens the app at the root. Appending rather than refusing the send keeps a preview usable:
 * refusing would mean no member page could be looked at, which is most of what a preview is for.
 */
export function publicBaseFor (base) {
  const mount = copyBase()
  return mount ? `${String(base).replace(/\/+$/, '')}${mount}` : base
}

/**
 * The mounts of the other apps on this cluster, as absolute paths — `['/tracker']` — which this copy's
 * page listener declines when they sit under its own path (lib/pages.js).
 *
 * EACH ENTRY IS DECLINED AS WRITTEN, its slashes trimmed, and is NOT held to the grammar above,
 * deliberately: a declined path can only make this copy answer less, so a malformed entry costs that
 * one path and nothing else, where a throw here would take down every page of the app at the root.
 */
export function sharingMounts () {
  return String(config.sharingMounts()).split(',').map((s) => s.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean).map((s) => `/${s}`)
}

/**
 * Refuse this request if this is the preview copy, or `null` to carry on.
 *
 * FOR A ROUTE WHOSE CALLER IS A THIRD PARTY'S MACHINE: Stripe and the mail provider post their events
 * to the live address, and nobody previewing their own app posts one to it, so refusing costs a
 * preview nothing and takes a public surface off the internet. `Bootstrap` is refused for its own
 * reason, stated in that file. **It is deliberately not a list of resources judged unsafe for a
 * preview** — serving the whole app against dummy data is what a preview is. It asks
 * `isPreviewCopy()` and not `copyBase()`: a sharing app's published copy is at a path and takes its own
 * webhooks.
 *
 * `json` is passed in so this module stays free of `lib/http.js`, and the `Response` is returned so a
 * call site is one line and cannot forget to return it.
 */
export function refuseOnPreview (json, { error, code }) {
  return isPreviewCopy() ? json({ error, code }, 403) : null
}
