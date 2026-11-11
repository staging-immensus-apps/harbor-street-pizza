#!/usr/bin/env node
// SEEDED — rule 27: an app NEVER authenticates to an IMMENSUS
// endpoint with the `Authorization` header. Measured on the live control cluster (2026-09-23):
// Harper authenticates that header at its own REST boundary and answers 401 `{"error":"invalid
// token"}` before any resource runs — for a valid token, an invalid one, and even for a route that
// does not exist. Every Immensus endpoint is a Harper app, so a bearer scheme against one is
// unreachable by construction: the app would see a 401 it can neither read nor explain, and Harper
// decorates 401s with `WWW-Authenticate: Basic`, which pops the browser's dialog (rule 20).
//
// ⚠ THE RULE SURVIVES AND ITS ONLY EXAMPLE IS GONE, which changes what this suite can assert.
// Until 2026-10-08 the example was `lib/stripe.js` sending `X-Immensus-App-Token` to a Stripe proxy
// on the control plane, and this suite drove all three of those calls and read the headers back.
// That design was rejected — payments run through the user's own Stripe account with the
// platform out of the path — so the proxy is struck, the header has no
// caller left, and there is now NO call to an Immensus endpoint anywhere in this tree.
//
// So this suite stops driving requests and keeps the half that is still enforceable: the rule, held
// over the whole tree by a scan, with its controls. Driving the absence instead would be
// a seam asserted EMPTY, which is a seam no app may use — an app that legitimately calls an Immensus
// endpoint one day must red for using the wrong header, not for making the call.
//
// AND ONE CONTROL IS NEW AND LOAD-BEARING: this tree now contains a bearer token for the first
// time, because `lib/stripe.js` sends the user's key to `api.stripe.com` as `Authorization: Bearer`,
// which is Stripe's own documented scheme and not a breach of anything. A gate that reds for that
// is a gate that gets muted, so "a bearer call to somebody else's API is NOT flagged" is driven
// against the real shipped file as well as a synthesized one. `stripe-acceptance` holds the other
// side: that the key goes to Stripe and nowhere else.
//
// Two things are checked, each with its negative control run FIRST against a synthesized defect —
// a check that has degraded into "always OK" is indistinguishable from a working one when you only
// ever watch it pass:
//   1. that the scan can tell an Immensus call with an Authorization header from every neighbouring
//      shape: another host, a lowercase key, an injected fetch, a comment about the defect
//   2. what this repository actually sends: every `fetch`-shaped call site in lib/, resources/ and
//      routes/ that names an Immensus endpoint, scanned for an Authorization header
//
// Portable by construction: every expectation is derived from the app's own files, and
// every control is synthesized rather than string-replaced out of a generated line.
//
// Hermetic: no network, no secrets, no git, no clock.

import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { ROOT, checker, fixture, discard, walk, read, stripComments } from './probe/harness.js'

const COMPONENT_DIRS = ['lib', 'resources', 'routes']

/**
 * Every `fetch`-shaped call in a source, as the text between its parentheses — `fetch`,
 * `fetchImpl`, `myFetch`, anything a call site might name it. Quotes are tracked while
 * balancing so a parenthesis inside a URL string does not end the call early.
 */
export function fetchCallTexts (src) {
  const code = stripComments(src)
  const out = []
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!/fetch/i.test(m[1])) continue
    const start = m.index + m[0].length
    let depth = 1
    let quote = null
    let i = start
    for (; i < code.length && depth > 0; i++) {
      const c = code[i]
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = null
        continue
      }
      if (c === "'" || c === '"' || c === '`') quote = c
      else if (c === '(') depth++
      else if (c === ')') depth--
    }
    out.push(code.slice(start, i - 1))
  }
  return out
}

// What makes a call site an IMMENSUS call: the control plane by name, the env keys that
// address it, or the proxy-URL helper that builds the path. Deliberately narrow — an app
// that calls somebody else's API with a bearer token is doing nothing wrong, and a gate
// that reds for that gets muted.
const IMMENSUS_CALL = /immensus|proxyurl|apptoken|app_token/i
// The header as a KEY, however it is written: `Authorization:`, `'authorization':`,
// `headers.set('Authorization', …)`, `headers['Authorization'] =`. The leading class keeps
// it from firing inside a longer hyphenated name.
const AUTHORIZATION = /(^|[^\w-])authorization['"`\]]*\s*(:|,|=|\))/i

/** Call sites that talk to Immensus while setting an Authorization header. */
export function scanSource (src, rel) {
  const bad = []
  for (const text of fetchCallTexts(src)) {
    if (!IMMENSUS_CALL.test(text)) continue
    if (AUTHORIZATION.test(text)) bad.push(`${rel} fetches an Immensus endpoint with an Authorization header (rule 25)`)
  }
  return bad
}

export function auditTree (root) {
  const bad = []
  for (const dir of COMPONENT_DIRS) {
    for (const f of walk(join(root, dir))) bad.push(...scanSource(read(f), f.slice(root.length + 1)))
  }
  return bad
}

const { check, section, done } = checker('immensus-auth-acceptance')

// ---------------------------------------------------------------- negative controls first

section('negative controls')
{
  const w = fixture(ROOT, COMPONENT_DIRS)
  const clean = auditTree(w)
  check('a faithful copy of lib/ resources/ routes/ passes', clean.length === 0, clean.join(' | '))

  // THE CONTROL THAT MATTERS MOST, and it is driven against the SHIPPED files rather than a
  // synthesized one: a module that sends a bearer token to somebody else's API — the payments kit's
  // lib/stripe.js sends the user's Stripe key to api.stripe.com, which is Stripe's own scheme — must
  // not be flagged, or the rule reds on every app for doing the right thing and a gate that cries wolf
  // gets muted. Every such module in the tree is scanned on its own; the template core has none since
  // the strip, so here it is the synthesized Stripe call further down that carries this direction,
  // and in a tree the payments kit was copied into it is the real file.
  const bearerSenders = COMPONENT_DIRS.flatMap((d) => walk(join(ROOT, d))).filter((f) => /authorization/i.test(read(f)) && /bearer/i.test(read(f)))
  const flaggedSenders = bearerSenders.flatMap((f) => scanSource(read(f), f.slice(ROOT.length + 1)))
  check(`every shipped module that sends a bearer token to a third party is NOT flagged (${bearerSenders.map((f) => f.slice(ROOT.length + 1)).join(', ') || 'none in this tree'})`, flaggedSenders.length === 0, flaggedSenders.join(' | '))

  const fix = (lines) => { writeFileSync(join(w, 'lib', 'probe-fixture.js'), lines.join('\n') + '\n'); return auditTree(w) }

  // A plausible FUTURE Immensus call rather than the struck proxy — the rule outlives its example.
  check('a bearer call to an Immensus endpoint is caught (NEG)', fix([
    "export const go = (body) => fetch('https://imc15d9ae.immensus.harperfabric.com/Control/thing', {",
    "  method: 'POST',",
    '  headers: { Authorization: `Bearer ${token}`, Accept: \'application/json\' },',
    '  body: JSON.stringify(body),',
    '})',
  ]).some((b) => b.includes('probe-fixture.js') && b.includes('Authorization')))

  check('…however the call is spelled: an injected fetch, a helper, a lowercase key (NEG)', fix([
    "export const go = (body) => fetchImpl(immensusUrl('thing'), {",
    "  method: 'POST',",
    "  headers: { 'authorization': appToken },",
    '})',
  ]).some((b) => b.includes('probe-fixture.js')))

  check('a bearer call to somebody ELSE\'s API is NOT flagged — the gate must not cry wolf', fix([
    "export const go = (key) => fetch('https://api.example.test/v1/thing', {",
    '  headers: { Authorization: `Bearer ${key}` },',
    '})',
  ]).length === 0)

  check('…including Stripe\'s own, which is the one this tree now really makes', fix([
    "export const go = (key) => fetch('https://api.stripe.com/v1/balance', {",
    '  headers: { Authorization: `Bearer ${key}` },',
    '})',
  ]).length === 0)

  check('prose ABOUT the defect is NOT flagged (comments are stripped)', fix([
    '// A comment that spells the forbidden shape: fetch(immensusUrl, { Authorization: x })',
    'export const go = () => 1',
  ]).length === 0)

  discard(w)
}

// ----------------------------------------------------------------- what the APP sends

section('this repository')
{
  const bad = auditTree(ROOT)
  for (const b of bad) check(b, false)
  check(`no fetch to an Immensus endpoint in ${COMPONENT_DIRS.join('/ ')}/ sets an Authorization header`, bad.length === 0)
}

process.exit(done())
