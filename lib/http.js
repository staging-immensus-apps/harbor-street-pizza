// FIXED — request and response helpers every resource uses.
// Imports nothing, reaches nothing: safe for routes/ and for the probe runtime alike.

// Nothing a resource serves is cacheable by default: /AuthApi/me is session state, and a
// 200 with NO cache directives is not "uncached" — RFC 9111 §4.2.2 lets a client cache
// apply heuristic freshness to it. `no-store` is the directive that
// matters; the rest are belt and braces for caches that store anyway.
export const NO_STORE = 'no-store, no-cache, must-revalidate'

/**
 * JSON response. `cookies` is an ARRAY appended one at a time: a plain headers object can
 * carry only one Set-Cookie, and silently keeping the last one is how a nonce-clearing
 * cookie goes missing next to a session cookie.
 */
export function json (body, status = 200, { headers = {}, cookies = [] } = {}) {
  const h = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': NO_STORE })
  for (const [k, v] of Object.entries(headers)) h.set(k, v)
  for (const c of cookies) h.append('Set-Cookie', c)
  return new Response(JSON.stringify(body), { status, headers: h })
}

export function redirect (url, { cookies = [], status = 302 } = {}) {
  const h = new Headers({ Location: url, 'Cache-Control': NO_STORE })
  for (const c of cookies) h.append('Set-Cookie', c)
  return new Response(null, { status, headers: h })
}

/**
 * The sub-path after the resource name, without slashes: `/AuthApi/me` → `me`.
 *
 * For `/XApi?a=1`, with no slash before the query, Harper sets no `pathname` and the target's string
 * form is `?a=1` (`harper@5.3.5`, `resources/RequestTarget.ts`, run 2026-11-05). So the query is cut
 * here, or a resource looks `?a=1` up as a record id and answers 404 (#111).
 */
export function pathFrom (target) {
  return (target?.pathname ?? String(target ?? '')).split('?')[0].replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Split a sub-path into DECODED segments: `users/42/role` → ['users', '42', 'role'],
 * `items/a%3Ab/history` → ['items', 'a:b', 'history'].
 *
 * `target.pathname` is what Harper read off the wire, so it is percent-encoded: a browser encodes a
 * reserved character in a path parameter. A resource that looks up the raw segment looks up the
 * literal `%3A` and answers 404 for every row whose id holds one — and a composite key such as
 * `memberId:lessonId` is what the builder's Architect is told to use wherever "exactly once"
 * matters. This copy once split without decoding, and a real
 * build's QA failed three stories on it, every one an id with a colon in it.
 *
 * Decoded AFTER the split, never before: decoding the whole path first would turn `%2F` into a
 * separator and give a request an extra segment past a route's own length check. And it never
 * throws: a malformed escape is kept verbatim, so it matches no stored id and lands on the route's
 * own 404. `decodeSegment` is the copy service-, agent- and pipeline-template already carry.
 */
export function segmentsOf (target) {
  const p = pathFrom(target)
  return p ? p.split('/').map(decodeSegment) : []
}

/** One path segment, decoded — or verbatim when the escape is malformed. Never throws. */
function decodeSegment (s) {
  if (!s.includes('%')) return s
  try { return decodeURIComponent(s) } catch { return s }
}

/**
 * Query parameters, with the getContext() fallback (rule 4).
 *
 * `target.searchParams` is populated on the resource root (`/XApi/?q=1`) but EMPTY on a
 * sub-path (`/XApi/items?q=1`) — and a suite written against a fixture that populated it
 * passed 57/57 while every escalation card in production answered "contact required". The
 * request context's raw URL always carries the query, so it is the source of truth here;
 * the stub deliberately never populates `searchParams` so that a resource which forgets
 * this helper fails its suite the way it would fail Harper.
 */
export function queryParams (target, self) {
  const fromTarget = target?.searchParams
  if (fromTarget && [...fromTarget.keys()].length) return fromTarget
  const raw = (() => {
    try {
      const ctx = self?.getContext?.()
      return ctx?.request?.url ?? ctx?.url ?? null
    } catch { return null }
  })()
  if (raw) {
    try {
      return new URL(raw.startsWith('http') ? raw : `http://x${raw.startsWith('/') ? '' : '/'}${raw}`).searchParams
    } catch { /* fall through */ }
  }
  return fromTarget ?? new URLSearchParams()
}

/** One request header, or null. Never throws — the stub and Harper both expose Headers. */
export function headerOf (self, name) {
  try { return self?.getContext?.()?.headers?.get?.(name) ?? null } catch { return null }
}

/**
 * Wrap a resource method body so:
 *   - a thrown auth Response (requireAuth / requireAdmin, in the sign-in kit's lib/auth.js) is SERVED, not
 *     rendered by Harper's error path, and
 *   - a downstream 401 (an upstream API rejecting a token) is transmuted to 502, because
 *     Harper decorates every 401 it renders with `WWW-Authenticate: Basic` and the browser
 *     pops its basic-auth dialog (rule 20).
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

/** The client IP as the edge reports it — for rate limits, never for auth. */
export function clientIp (self) {
  const xff = headerOf(self, 'x-forwarded-for')
  if (xff) return xff.split(',')[0].trim() || null
  return headerOf(self, 'cf-connecting-ip') ?? null
}
