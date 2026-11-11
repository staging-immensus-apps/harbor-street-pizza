// The typed API client — the api.* wrapper. Every resource speaks
// `/<Name>Api/...`, JSON in and out, cookies included.
//
// A 403 THAT NAMES A CODE CAN SEND THE PERSON SOMEWHERE, and which codes and where is not this file's
// business: the template core knows nothing about accounts. The sign-in kit, when
// the platform has copied it in, registers its two — `auth_required` → its sign-in page,
// `membership_required` → its account page — through `onApiRefusal()` when its extension module loads
// (src/extensions/sign-in.tsx). A redirect is always location.replace(), never a dialog: the server
// never answers 401 (rule 20), so the browser's basic-auth prompt cannot appear either.
//
// Pages import this module and nothing else for data; page-boot-acceptance stubs it.

/**
 * The mount this copy of the app is served under, and so the prefix every request and every redirect in
 * this client is built from.
 *
 * `''` AT THE ROOT, AND THE COPY'S OWN PATH EVERYWHERE ELSE. A build or an update is looked at at
 * `<app>/preview`, served by the PREVIEW COPY of this app reading dummy data, while the published copy
 * serves the real app at `<app>/` (lib/copy.js). A SHARING APP — one that runs in another app's cluster
 * — is served at `/<its slug>` and its own preview copy at `/<its slug>/preview`.
 * Each copy's API is mounted under its path, so a page opened there has to keep asking there or it would
 * reach another copy, or another app, and draw that one's rows.
 *
 * READ FROM THE URL THIS MODULE WAS LOADED FROM, NOT FROM THE PAGE'S. The builder rebases each copy's
 * shell onto `/<mount>/web/` at deploy time, so this bundle is fetched from
 * `/<mount>/web/assets/…` and `import.meta.url` says
 * exactly which copy served it. The page's own pathname cannot: `/tracker/settings` is a sharing app's
 * page and also a path a `/:slug/*` route of the app at the root would match, and only the deploy knows
 * which. Anything that is not an http(s) URL ending in `/web/assets/<file>` — `vite`'s dev server
 * serving `/src/api/client.ts`, or this file imported under node — is the root.
 *
 * ONE CONSTANT RATHER THAN A SECOND CLIENT, and this is why it is worth a paragraph: `BASE` is
 * already what `request()` builds every URL from AND what `redirectTo()` builds every 403
 * redirect from, so deriving it here carries the whole client — including any 403 redirect a kit
 * registers (`onApiRefusal`), which would otherwise step a person out of the copy they are looking at
 * without saying so.
 *
 * READ ONCE, AT MODULE LOAD: the shell the page booted from fixes which copy it is, and an in-app route
 * change must not be able to flip the whole client's copy mid-session, which no screen would show.
 *
 * The body is plain JavaScript under the signature's types on purpose: `preview-acceptance` extracts it
 * and runs it against each copy's server-side `copyBase()`, with no compiler.
 */
export function mountBase(scriptUrl: string): string {
  let path = ''
  try {
    const url = new URL(scriptUrl)
    if (url.protocol === 'http:' || url.protocol === 'https:') path = url.pathname
  } catch {
    return ''
  }
  return path.match(/^((?:\/[^/]+)*?)\/web\/assets\/[^/]+$/)?.[1] ?? ''
}

export const BASE = mountBase(import.meta.url)

/**
 * A site-relative URL for a HARD navigation — `location.replace`, or an `href` the browser follows.
 *
 * `BASE` covers `api.*` and the router's `basename`. Neither reaches a hard navigation, and the
 * flow that breaks is the one the preview exists for: an
 * admin invites from `/preview`, `AdminApi` correctly emails `/preview/invite?token=…`, and then
 * "Accept invitation" posts to **production's** `/AuthApi/verify` — where the `MagicLink` row does
 * not exist, so it answers `?error=invalid-link`. Signing in on `/preview/login` landed on the live
 * app, where the `stage`-stamped cookie is refused, so the person ended up signed out.
 *
 * ONE SEAM, AND A GATE FOR THE FORGOTTEN CASE, which is the same discipline as `previewPath()` on
 * the server: `preview-acceptance` asserts that no `location.replace(` or followed `href` under
 * `src/` is built without `go()`, so a new one reds rather than quietly leaving the preview.
 *
 * Idempotent and absolute-safe, for `previewPath()`'s reasons: a caller cannot double the prefix,
 * and a URL pointing at another origin is never rewritten.
 */
export function go(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || BASE === '') return path
  if (path === BASE || path.startsWith(BASE + '/') || path.startsWith(BASE + '?')) return path
  return `${BASE}${path}`
}

export interface ApiError {
  status: number
  error: string
  code?: string
}

// 403 `code` → the in-app path a person is sent to. Empty in the core; see the header.
const refusalRedirects = new Map<string, string>()

/**
 * Send the person to `path` (in-app, site-relative) when a resource answers 403 with `code`. Called at
 * module load by a kit's extension module; the last registration for a code wins.
 */
export function onApiRefusal(code: string, path: string): void {
  refusalRedirects.set(code, path)
}

let redirecting = false
function redirectTo(path: string) {
  if (redirecting) return
  redirecting = true
  location.replace(`${BASE}${path}`)
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/${path.replace(/^\//, '')}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  const to = res.status === 403 && typeof json?.code === 'string' ? refusalRedirects.get(json.code) : undefined
  if (to) redirectTo(to)
  if (!res.ok) {
    const err: ApiError = { status: res.status, error: json?.error ?? res.statusText, code: json?.code }
    throw err
  }
  return json as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}

export function isApiError(err: unknown): err is ApiError {
  return typeof err === 'object' && err !== null && 'status' in err && 'error' in err
}
