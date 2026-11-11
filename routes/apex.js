/**
 * FIXED — 301 apex → www when a custom domain is attached.
 *
 * The founder's domain gets two Domain rows on Fabric — `www.example.com` and the apex —
 * and the app sends the apex to www so there is one canonical host and one host-only
 * session cookie. `APEX_REDIRECT_TO` is the canonical hostname (`www.example.com`); the
 * apex is that hostname without its first label. Unset (the Immensus subdomain, local
 * dev) → nothing redirects.
 *
 * lib/pages.js calls `apexTarget()` before serving any page, which covers every URL a browser
 * lands on; API calls always follow a page load and therefore already carry the www host.
 *
 * Reads lib/config.js and nothing else (rule 5).
 */

import { config } from '../lib/config.js'

/** `{ apex, to }` or null when no custom domain is configured. */
export function apexConfig (value = config.apexRedirectTo()) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!raw || !raw.includes('.')) return null
  const labels = raw.split('.')
  if (labels.length < 3) return null
  return { apex: labels.slice(1).join('.'), to: raw }
}

/** The redirect target for this request, or null when the host is not the apex. */
export function apexTarget (host, url, cfg = apexConfig()) {
  if (!cfg) return null
  const h = String(host ?? '').toLowerCase().replace(/:\d+$/, '')
  if (h !== cfg.apex) return null
  const path = typeof url === 'string' && url.startsWith('/') ? url : '/'
  return `https://${cfg.to}${path}`
}
