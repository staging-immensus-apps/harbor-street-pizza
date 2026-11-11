#!/usr/bin/env node
// SEEDED — lib/stripe.js talks to STRIPE, with the USER's own key, and to nothing else.
//
// THE PROBLEM. Until 2026-10-08 this file's subject was the opposite: `immensus-auth-acceptance`
// drove three calls to a proxy on the control plane and read back the Immensus token they carried.
// So the suite that watched payments asserted that Immensus was in the payment path, and satisfying
// it was the one thing a correct implementation could not do. This suite replaces that half.
//
// FOUR properties, each with its negative control run FIRST against a synthesized defect, because a
// check that has degraded into always-OK is indistinguishable from a working one when you only ever
// watch it pass:
//
//   1. WHERE the requests go. Every call lib/stripe.js makes addresses `https://api.stripe.com/v1/`,
//      carries the configured key as `Authorization: Bearer`, pins an API version, and names no
//      Immensus host and no Immensus header.
//   2. WHAT IS REFUSED BEFORE A CALL. No key, or a webhook signing secret pasted into the key slot,
//      is refused locally with NOTHING sent. The second case is the whole reason the prefix guard
//      exists: Stripe refuses a signing secret with the byte-identical 401 it gives a revoked key.
//   3. THAT NO KEY VALUE CAN REACH A LOG, A THROWN MESSAGE OR A RESPONSE BODY. Driven against the
//      REAL measured shape of Stripe's 401, which echoes the first eight and the LAST FOUR
//      characters of the key it refused (measured against api.stripe.com, 2026-10-08). The negative
//      control is the obvious implementation — relay `error.message`, which is what
//      a real app's lib/stripe.js does — and the same scan must catch it.
//   4. THE HONEST STATE. `checkStripe()` answers a code for every branch and never throws, and the
//      mode comes from the key the app was given rather than from any setting of ours.
//   5. THAT THE KEY HAS EXACTLY ONE READER, and it is lib/stripe.js. Property 1 says where that
//      file's requests go; this says nothing else in the app can send the key anywhere at all. One
//      site means there is no second one to get wrong — the same argument as for the
//      single site that writes a password hash.
//
// Portable by construction: every expectation is derived from the module's own exports
// and from keys this file builds, never from a line of a generated file.
//
// Hermetic: fetch is injected and never reached, no git, no clock, and the key material below is
// assembled at run time so that pr-check.yml's secret scan sees no prefix followed by a payload —
// a gate that cannot tell a suite's fixture from a real credential is right not to try.

import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { ROOT, checker, fixture, discard, walk, read, stripComments } from './probe/harness.js'

const COMPONENT_DIRS = ['lib', 'resources', 'routes']

// --------------------------------------------------------------------------- key material
// Built, never written as a literal. The tail is a distinctive marker so the leak scan below can
// look for it without the risk of matching an ordinary English substring.
const TAIL = 'ZQ7X'
const key = (kind, mode) => `${kind}_${mode}_` + '0123456789abcdefghij' + TAIL
const SK_TEST = key('sk', 'test')
const SK_LIVE = key('sk', 'live')
const RK_TEST = key('rk', 'test')
const RK_LIVE = key('rk', 'live')
// A signing secret, which is what a user is most likely to paste into the key field by mistake.
const WHSEC = 'whsec_' + Buffer.from('suite-signing-secret-not-real').toString('base64')

process.env.STRIPE_SECRET_KEY = SK_TEST
process.env.STRIPE_WEBHOOK_SECRET = WHSEC

const stripe = await import('../lib/stripe.js')

const { check, section, done } = checker('stripe-acceptance')

// ------------------------------------------------------------------------------- helpers

/** Header lookup that does not care how the request built its header bag. */
function headerValue (headers, name) {
  const want = String(name).toLowerCase()
  if (!headers) return undefined
  if (typeof headers.get === 'function') return headers.get(want) ?? undefined
  for (const [k, v] of Object.entries(headers)) if (String(k).toLowerCase() === want) return v
  return undefined
}

/**
 * The verdict on ONE recorded outbound request: where it went and what it carried. Exported shape
 * so the controls below can drive it on synthesized requests before it is trusted on real ones.
 */
export function requestProblems ({ url, init }, { secret, apiVersion }) {
  const bad = []
  const u = String(url)
  if (!u.startsWith('https://api.stripe.com/v1/')) bad.push(`${u} does not address Stripe`)
  if (/immensus/i.test(u)) bad.push(`${u} names an Immensus host`)
  const headers = init?.headers
  for (const name of Object.keys(headers && typeof headers.get !== 'function' ? headers : {})) {
    if (/^x-immensus-/i.test(name)) bad.push(`${u} carries an Immensus header (${name})`)
  }
  const auth = headerValue(headers, 'authorization')
  if (auth === undefined) bad.push(`${u} carries no Authorization header`)
  else if (auth !== `Bearer ${secret}`) bad.push(`${u} does not send the configured key as a bearer token`)
  if (headerValue(headers, 'stripe-version') !== apiVersion) bad.push(`${u} does not pin Stripe-Version`)
  return bad
}

/**
 * Anything a person or a log could read, scanned for the key. Both the WHOLE key and its last four
 * characters, because those four are what Stripe echoes and what every dashboard uses to identify
 * a key — a check for the whole string alone would pass against the exact shape Stripe sends.
 */
export function leaks (text, secret) {
  const s = String(text ?? '')
  const bad = []
  if (s.includes(secret)) bad.push('carries the whole key')
  if (s.includes(secret.slice(-4))) bad.push('carries the key\'s last four characters')
  return bad
}

/** Stripe's REAL 401 body, measured 2026-10-08: first eight characters, mask, last four. */
function stripe401Body (secret) {
  const masked = secret.slice(0, 8) + '*'.repeat(Math.max(0, secret.length - 12)) + secret.slice(-4)
  return JSON.stringify({ error: { type: 'invalid_request_error', message: `Invalid API Key provided: ${masked}` } })
}

/** An injected fetch that records every request and answers with whatever the test wants. */
function recorder (reply) {
  const sent = []
  const impl = async (url, init) => {
    sent.push({ url, init })
    const r = typeof reply === 'function' ? reply(url, init) : reply
    return new Response(r.body ?? '{}', { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  impl.sent = sent
  return impl
}

/** Capture console.error / console.warn for the duration of `fn`. */
async function capturingConsole (fn) {
  const lines = []
  const realError = console.error
  const realWarn = console.warn
  console.error = (...a) => lines.push(a.map(String).join(' '))
  console.warn = (...a) => lines.push(a.map(String).join(' '))
  try { return { value: await fn(), lines } } finally { console.error = realError; console.warn = realWarn }
}

// ---------------------------------------------------------------- negative controls first

section('negative controls')
{
  const V = stripe.STRIPE_API_VERSION
  const good = { url: 'https://api.stripe.com/v1/checkout/sessions', init: { headers: { Authorization: `Bearer ${SK_TEST}`, 'Stripe-Version': V } } }
  check('a request to Stripe with the configured key is clean', requestProblems(good, { secret: SK_TEST, apiVersion: V }).length === 0, requestProblems(good, { secret: SK_TEST, apiVersion: V }).join(' | '))

  const proxied = { url: 'https://imc15d9ae.immensus.harperfabric.com/connect/stripe/a/checkout', init: { headers: { Authorization: `Bearer ${SK_TEST}`, 'Stripe-Version': V } } }
  const pp = requestProblems(proxied, { secret: SK_TEST, apiVersion: V })
  check('a request to an Immensus host is caught — the rejected design would RED here (NEG)', pp.some((b) => b.includes('does not address Stripe')) && pp.some((b) => b.includes('names an Immensus host')), pp.join(' | '))

  const elsewhere = { url: 'https://api.example.test/v1/charge', init: { headers: { Authorization: `Bearer ${SK_TEST}`, 'Stripe-Version': V } } }
  check('a request to any other host at all is caught (NEG)', requestProblems(elsewhere, { secret: SK_TEST, apiVersion: V }).some((b) => b.includes('does not address Stripe')))

  const appToken = { url: 'https://api.stripe.com/v1/checkout/sessions', init: { headers: { Authorization: `Bearer ${SK_TEST}`, 'Stripe-Version': V, 'X-Immensus-App-Token': 'tok' } } }
  check('an Immensus app-token header is caught wherever it is sent — that header is struck (NEG)', requestProblems(appToken, { secret: SK_TEST, apiVersion: V }).some((b) => b.includes('Immensus header')))

  const naked = { url: 'https://api.stripe.com/v1/balance', init: { headers: { 'Stripe-Version': V } } }
  check('a request with no credential is caught — silence is not safety (NEG)', requestProblems(naked, { secret: SK_TEST, apiVersion: V }).some((b) => b.includes('carries no Authorization')))

  const wrongKey = { url: 'https://api.stripe.com/v1/balance', init: { headers: { Authorization: 'Bearer somebody-elses-key', 'Stripe-Version': V } } }
  check('a request sending something other than the configured key is caught (NEG)', requestProblems(wrongKey, { secret: SK_TEST, apiVersion: V }).some((b) => b.includes('does not send the configured key')))

  const unpinned = { url: 'https://api.stripe.com/v1/balance', init: { headers: { Authorization: `Bearer ${SK_TEST}` } } }
  check('a request that pins no API version is caught (NEG)', requestProblems(unpinned, { secret: SK_TEST, apiVersion: V }).some((b) => b.includes('Stripe-Version')))

  check('the leak scan catches the whole key (NEG)', leaks(`boom: ${SK_TEST}`, SK_TEST).some((b) => b.includes('whole key')))
  check('…and the masked shape Stripe actually sends, which keeps the last four (NEG)', leaks(stripe401Body(SK_TEST), SK_TEST).some((b) => b.includes('last four')))
  check('…and does NOT flag an ordinary sentence — the scan must not cry wolf', leaks('Stripe refused this app\'s Stripe key', SK_TEST).length === 0)
}

// ------------------------------------------------------- 1. where the requests go
section('every call addresses Stripe, with the user\'s own key, and nothing of ours')
{
  const fetchImpl = recorder({ status: 200, body: '{"id":"x","livemode":false}' })
  await stripe.createCheckoutSession({ mode: 'subscription', priceId: 'price_1', successUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/no', customerEmail: 'm@example.test', metadata: { plan: 'yearly' } }, { fetchImpl })
  await stripe.createPortalSession({ customerId: 'cus_1', returnUrl: 'https://app.test/account' }, { fetchImpl })
  await stripe.getSubscription('sub_1', { fetchImpl })
  await stripe.createCustomer({ email: 'm@example.test', name: 'M' }, { fetchImpl })
  await stripe.checkStripe({ fetchImpl })

  const sent = fetchImpl.sent
  check('all five operations made a request', sent.length === 5, `recorded ${sent.length}`)
  const problems = sent.flatMap((r) => requestProblems(r, { secret: SK_TEST, apiVersion: stripe.STRIPE_API_VERSION }))
  check('every one goes to api.stripe.com with the configured key and a pinned version', problems.length === 0, problems.join(' | '))
  check('no request names an Immensus host', !sent.some((r) => /immensus/i.test(String(r.url))))
  check('a checkout session is created on Stripe\'s own path', sent.some((r) => String(r.url) === 'https://api.stripe.com/v1/checkout/sessions'))
  check('the readiness probe reads a balance, which creates nothing', sent.some((r) => String(r.url) === 'https://api.stripe.com/v1/balance'))
  const checkout = sent.find((r) => String(r.url).endsWith('/checkout/sessions'))
  check('the checkout body is Stripe\'s own flat form shape', /line_items%5B0%5D%5Bprice%5D=price_1/.test(String(checkout.init.body)), String(checkout.init.body))
  check('…and carries no application fee — a platform can only levy one on a charge it creates', !/application_fee/.test(String(checkout.init.body)))
  check('…and no connected-account header, because there is no connected account', headerValue(checkout.init.headers, 'stripe-account') === undefined)
  // Stripe refuses a session naming BOTH `customer` and `customer_email`, so one of the two has to
  // lose. Driven both ways rather than asserted in a comment, because a silent drop is only correct
  // if it is the drop somebody chose.
  {
    const f = recorder({ status: 200, body: '{"id":"cs"}' })
    await stripe.createCheckoutSession({ mode: 'payment', priceId: 'p', customerEmail: 'm@example.test' }, { fetchImpl: f })
    await stripe.createCheckoutSession({ mode: 'payment', priceId: 'p', customerEmail: 'm@example.test', customerId: 'cus_1' }, { fetchImpl: f })
    const [emailOnly, both] = f.sent.map((r) => String(r.init.body))
    check('with no customer id the address is sent', /customer_email=m%40example\.test/.test(emailOnly), emailOnly)
    check('with a customer id the address is DROPPED, because Stripe refuses a session naming both', /customer=cus_1/.test(both) && !/customer_email/.test(both), both)
  }
  // A CALLER'S IDEMPOTENCY KEY, on every write. This file never retries, so it mints none of its
  // own — but a timeout AFTER Stripe created the session answers `stripe_unavailable`, and a naive
  // caller retry then creates a second one and charges twice. Only the caller knows which two
  // attempts are one intent, so only the caller can supply the key.
  {
    const f = recorder({ status: 200, body: '{"id":"x"}' })
    await stripe.createCheckoutSession({ mode: 'payment', priceId: 'p' }, { fetchImpl: f, idempotencyKey: 'order-42' })
    await stripe.createCustomer({ email: 'm@example.test' }, { fetchImpl: f, idempotencyKey: 'cust-42' })
    await stripe.createPortalSession({ customerId: 'cus_1', returnUrl: 'https://app.test/a' }, { fetchImpl: f, idempotencyKey: 'portal-42' })
    check('every write forwards a caller-supplied key as Idempotency-Key', f.sent.map((r) => headerValue(r.init.headers, 'idempotency-key')).join(',') === 'order-42,cust-42,portal-42', f.sent.map((r) => headerValue(r.init.headers, 'idempotency-key')).join(','))
    const g = recorder({ status: 200, body: '{"id":"x"}' })
    await stripe.createCheckoutSession({ mode: 'payment', priceId: 'p' }, { fetchImpl: g })
    check('…and no header is invented when the caller supplies none (NEG)', headerValue(g.sent[0].init.headers, 'idempotency-key') === undefined)
    const h = recorder({ status: 200, body: '{"livemode":false}' })
    await stripe.checkStripe({ fetchImpl: h })
    check('…and a read never carries one, because there is nothing to make idempotent (NEG)', headerValue(h.sent[0].init.headers, 'idempotency-key') === undefined)
  }

  check('a GET sends no body and no content type', (() => { const g = sent.find((r) => String(r.url).endsWith('/subscriptions/sub_1')); return g.init.body === undefined && headerValue(g.init.headers, 'content-type') === undefined })())
}

// --------------------------------------------- 2. what is refused before a call is made
section('a key that cannot work is refused locally, with nothing sent')
{
  const fetchImpl = recorder({ status: 200 })
  process.env.STRIPE_SECRET_KEY = ''
  let threw = null
  try { await stripe.createCheckoutSession({ mode: 'payment', priceId: 'price_1' }, { fetchImpl }) } catch (err) { threw = err }
  check('with no key the call throws not_configured and NOTHING is sent', threw?.code === 'not_configured' && fetchImpl.sent.length === 0, `${threw?.code} / sent ${fetchImpl.sent.length}`)
  check('…and stripeConfigured() said so', stripe.stripeConfigured() === false)

  process.env.STRIPE_SECRET_KEY = WHSEC
  threw = null
  try { await stripe.getSubscription('sub_1', { fetchImpl }) } catch (err) { threw = err }
  check('a SIGNING SECRET in the key slot is refused locally — Stripe answers the same 401 as a revoked key, so only this can tell them apart', threw?.code === 'wrong_credential_kind' && fetchImpl.sent.length === 0, `${threw?.code} / sent ${fetchImpl.sent.length}`)
  check('…and its refusal says which prefix is wanted, without quoting the secret', /sk_ or rk_/.test(String(threw?.message)) && leaks(threw?.message, WHSEC).length === 0)

  process.env.STRIPE_SECRET_KEY = SK_TEST
  check('a configured app reads as configured (NEG for the two lines above)', stripe.stripeConfigured() === true)
  check('and a webhook secret is reported separately from the key', stripe.webhookConfigured() === true)
  process.env.STRIPE_WEBHOOK_SECRET = ''
  check('…so an app with a key and no webhook secret is honest about which it has (NEG)', stripe.stripeConfigured() === true && stripe.webhookConfigured() === false)
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC
}

// -------------------------------- 3. no key value reaches a log, a message or a response
section('Stripe echoes the key it refused, and none of it gets out')
{
  const body = stripe401Body(SK_TEST)
  check('the fixture really is the leaky shape — the premise of this section (NEG)', leaks(body, SK_TEST).length > 0)

  const fetchImpl = recorder({ status: 401, body })
  const { value: caught, lines } = await capturingConsole(async () => {
    try { await stripe.getSubscription('sub_1', { fetchImpl }); return null } catch (err) { return err }
  })
  check('a 401 from Stripe becomes key_rejected', caught?.code === 'key_rejected', String(caught?.code))
  check('the thrown message carries no part of the key', leaks(caught?.message, SK_TEST).length === 0, String(caught?.message))
  check('nothing logged carries any part of the key', lines.flatMap((l) => leaks(l, SK_TEST)).length === 0, lines.join(' | '))
  check('something WAS logged — a refusal that logs nothing is its own defect (NEG)', lines.length > 0)
  check('and the log names the status and Stripe\'s own error type, which carry no key material', lines.some((l) => /401/.test(l) && /invalid_request_error/.test(l)))

  const res = stripe.stripeFailureResponse(caught)
  const text = await res.text()
  check('the response a resource serves carries no part of the key', leaks(text, SK_TEST).length === 0, text)
  check('…and is never a 401, which Harper would decorate with a basic-auth dialog (rule 20)', res.status === 503)
  check('…and names the code so a client can branch, without prose this package may not write', JSON.parse(text).code === 'key_rejected')

  // WHAT MAY BE RELAYED, AND THE BACKSTOP OVER IT. Stripe's fixed-vocabulary fields earn their
  // way out because `param` is the one genuinely useful thing it says about a malformed request;
  // its free-text `message` never does. And each relayed field is checked against THIS app's own
  // key, which is the only key material the app has to be able to recognise.
  {
    const malformed = JSON.stringify({ error: { type: 'invalid_request_error', code: 'parameter_missing', param: 'line_items[0][price]', message: `whatever ${SK_TEST} is` } })
    const f = recorder({ status: 400, body: malformed })
    const { value: err, lines: ls } = await capturingConsole(async () => {
      try { await stripe.createCheckoutSession({ mode: 'payment' }, { fetchImpl: f }); return null } catch (e) { return e }
    })
    check('a malformed request relays which PARAMETER Stripe refused', err?.detail?.param === 'line_items[0][price]', JSON.stringify(err?.detail))
    check('…and its own type and code, which are enumerations of Stripe\'s', err?.detail?.type === 'invalid_request_error' && err?.detail?.code === 'parameter_missing')
    check('…and still no part of the key, although the message beside them carried it', leaks(JSON.stringify(err?.detail), SK_TEST).length === 0 && leaks(err?.message, SK_TEST).length === 0, JSON.stringify(err?.detail))
    const body400 = await stripe.stripeFailureResponse(err).text()
    check('…nor in the response a resource serves', leaks(body400, SK_TEST).length === 0, body400)
    check('…nor in the log', ls.flatMap((l) => leaks(l, SK_TEST)).length === 0, ls.join(' | '))

    // THE BACKSTOP, provoked: a fixed-vocabulary field that nevertheless carries the key is DROPPED
    // rather than relayed. Nothing says Stripe would ever do this; the point is that it cannot.
    const poisoned = JSON.stringify({ error: { type: 'invalid_request_error', param: `price_for_${SK_TEST}`, code: `code_${TAIL}` } })
    const g = recorder({ status: 400, body: poisoned })
    const { value: err2 } = await capturingConsole(async () => {
      try { await stripe.getSubscription('sub_1', { fetchImpl: g }); return null } catch (e) { return e }
    })
    check('a fixed-vocabulary field carrying the whole key is DROPPED (NEG)', err2?.detail?.param === undefined, JSON.stringify(err2?.detail))
    check('…and one carrying only its last four characters is dropped too (NEG)', err2?.detail?.code === undefined, JSON.stringify(err2?.detail))
    check('…while the clean field beside them still comes through — the guard is per field, not all-or-nothing', err2?.detail?.type === 'invalid_request_error', JSON.stringify(err2?.detail))
  }

  // A BODY THAT FAILS AFTER THE HEADERS ARRIVED. A reset or a timeout mid-body throws out of
  // `res.text()`, not out of the fetch, so it has to be caught in the same place — outside the try
  // it would escape as a raw error and `stripeFailureResponse` would call it
  // `stripe_refused_request`, which is this file's words for "Stripe answered and said no". It is
  // also the second unchecked free-text path the file promises it has none of.
  {
    const torn = async () => ({ ok: false, status: 500, text: async () => { throw new Error(`socket hang up while presenting ${SK_TEST}`) } })
    const { value: err, lines: ls } = await capturingConsole(async () => {
      try { await stripe.getSubscription('sub_1', { fetchImpl: torn }); return null } catch (e) { return e }
    })
    check('a body that fails after the headers is stripe_unavailable, not a refusal by Stripe', err?.code === 'stripe_unavailable', String(err?.code))
    check('…and 502, because the app could not reach Stripe rather than being told no', err?.status === 502)
    check('…and that path carries no part of the key either', ls.flatMap((l) => leaks(l, SK_TEST)).length === 0 && leaks(err?.message, SK_TEST).length === 0, ls.join(' | '))
  }

  // THE TAIL TEST NEEDS A SECRET LONG ENOUGH FOR FOUR CHARACTERS TO BE A TAIL. With a very short
  // key those four are most of it and the test would match almost any text, withholding every
  // detail — so it is skipped below a threshold, while the WHOLE-key test always applies. Driven
  // both ways, because the guard is the kind of implicit invariant that drifts.
  {
    const short = 'sk_test_a'
    process.env.STRIPE_SECRET_KEY = short
    check('a short key is still a key, so it is not refused locally (the premise)', stripe.keyMode(short) === 'test')
    const tail = JSON.stringify({ error: { type: 'invalid_request_error', param: `price_${short.slice(-4)}_x` } })
    const f1 = recorder({ status: 400, body: tail })
    const { value: e1 } = await capturingConsole(async () => { try { await stripe.getSubscription('s', { fetchImpl: f1 }); return null } catch (e) { return e } })
    check('…and a field merely containing its last four characters is RELAYED, not withheld', e1?.detail?.param !== undefined, JSON.stringify(e1?.detail))
    const whole = JSON.stringify({ error: { type: 'invalid_request_error', param: `price_${short}_x` } })
    const f2 = recorder({ status: 400, body: whole })
    const { value: e2 } = await capturingConsole(async () => { try { await stripe.getSubscription('s', { fetchImpl: f2 }); return null } catch (e) { return e } })
    check('…while a field containing the WHOLE short key is still withheld (NEG)', e2?.detail?.param === undefined, JSON.stringify(e2?.detail))
    process.env.STRIPE_SECRET_KEY = SK_TEST
  }

  // THE CONTROL: the obvious implementation, which a real app's lib/stripe.js really does.
  const relaying = new Error(JSON.parse(body).error.message)
  check('the same scan CATCHES the obvious implementation that relays Stripe\'s message (NEG)', leaks(relaying.message, SK_TEST).length > 0)

  // No branch of this file may ever raise a 401 — rule 20 by construction, not by convention.
  const statuses = []
  for (const status of [401, 403, 429, 500, 400]) {
    const f = recorder({ status, body: stripe401Body(SK_TEST) })
    await capturingConsole(async () => { try { await stripe.getSubscription('sub_1', { fetchImpl: f }) } catch (err) { statuses.push(err?.status) } })
  }
  check('no failure from this file carries status 401 (rule 20)', statuses.length === 5 && !statuses.includes(401), statuses.join(','))
}

// ------------------------------------------------------------------- 4. the honest state
section('checkStripe answers a code for every branch and never throws')
{
  const cases = [
    ['ok, test', { status: 200, body: '{"livemode":false}' }, { ok: true, code: 'ok', mode: 'test', modeFrom: 'stripe' }],
    ['ok, live as Stripe reports it', { status: 200, body: '{"livemode":true}' }, { ok: true, code: 'ok', mode: 'live', modeFrom: 'stripe' }],
    ['ok, no livemode in the answer → the key\'s own prefix, and it says so', { status: 200, body: '{}' }, { ok: true, code: 'ok', mode: 'test', modeFrom: 'prefix' }],
    ['a rolled key', { status: 401, body: stripe401Body(SK_TEST) }, { ok: false, code: 'key_rejected' }],
    ['a restricted key refused on this probe is NOT called rejected', { status: 403, body: '{"error":{"type":"invalid_request_error"}}' }, { ok: false, code: 'key_lacks_permission' }],
    ['rate limited', { status: 429, body: '{}' }, { ok: false, code: 'stripe_rate_limited' }],
    ['Stripe is down', { status: 503, body: '{}' }, { ok: false, code: 'stripe_unavailable' }],
    ['Stripe refused the request itself', { status: 400, body: '{}' }, { ok: false, code: 'stripe_refused_request' }],
  ]
  // Every drive is wrapped, because "never throws" is the property under test and a suite that
  // discovers a throw by DYING reds for the right reason with the wrong verdict — a crash names no
  // assertion, so a reader of the output cannot tell which promise broke.
  const probeState = async (reply) => {
    const f = recorder(reply)
    try {
      const { value } = await capturingConsole(() => stripe.checkStripe({ fetchImpl: f }))
      return value
    } catch (err) {
      return { threw: String(err?.code ?? err?.message ?? err) }
    }
  }
  for (const [label, reply, want] of cases) {
    const state = await probeState(reply)
    check(`checkStripe did not throw: ${label}`, state.threw === undefined, state.threw)
    const got = Object.fromEntries(Object.keys(want).map((k) => [k, state[k]]))
    check(`${label} → ${JSON.stringify(want)}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(state))
  }

  // An outage must never be reported as a bad key: telling a user to roll a working credential is
  // the one wrong answer with no way back, because a Stripe key cannot be read back out of Stripe.
  // PROVOKED, because the control below was passing vacuously: 'ECONNREFUSED' carries no key, so a
  // log line that relayed the throw's message unchecked would have passed this assertion. The
  // thrown text now carries the key, which is what an injected fetch can really do and what Node's
  // own errors do not.
  const dead = async () => { throw new Error(`connect failed while presenting ${SK_TEST}`) }
  let unreachable = { threw: 'nothing ran' }
  let lines = []
  try {
    const captured = await capturingConsole(() => stripe.checkStripe({ fetchImpl: dead }))
    unreachable = captured.value
    lines = captured.lines
  } catch (err) { unreachable = { threw: String(err?.message ?? err) } }
  check('checkStripe did not throw when Stripe was unreachable', unreachable.threw === undefined, unreachable.threw)
  check('an unreachable Stripe is stripe_unavailable and never key_rejected', unreachable.ok === false && unreachable.code === 'stripe_unavailable', JSON.stringify(unreachable))
  check('…and that log line carries no part of the key either', lines.flatMap((l) => leaks(l, SK_TEST)).length === 0, lines.join(' | '))

  process.env.STRIPE_SECRET_KEY = ''
  check('an unconfigured app answers not_configured without a request', (await stripe.checkStripe({ fetchImpl: recorder({ status: 200 }) })).code === 'not_configured')
  process.env.STRIPE_SECRET_KEY = WHSEC
  check('a signing secret in the key slot answers wrong_credential_kind without a request', (await stripe.checkStripe({ fetchImpl: recorder({ status: 200 }) })).code === 'wrong_credential_kind')
  process.env.STRIPE_SECRET_KEY = SK_TEST
}

section('test and live are the user\'s, because the key is')
{
  check('every prefix Stripe issues reads as its own mode', stripe.keyMode(SK_TEST) === 'test' && stripe.keyMode(SK_LIVE) === 'live' && stripe.keyMode(RK_TEST) === 'test' && stripe.keyMode(RK_LIVE) === 'live')
  check('a restricted key is a secret key — a user who narrowed their own grant is not refused for it', stripe.keyMode(RK_LIVE) === 'live')
  check('a signing secret is not a key at all (NEG)', stripe.keyMode(WHSEC) === null)
  check('neither is a blank, nor something arbitrary (NEG)', stripe.keyMode('') === null && stripe.keyMode('pk_test_x') === null && stripe.keyMode(undefined) === null)

  // The mode follows the credential and nothing else: swapping the key is the whole of "go live".
  const probe = () => stripe.checkStripe({ fetchImpl: recorder({ status: 200, body: '{}' }) })
  process.env.STRIPE_SECRET_KEY = SK_LIVE
  const live = await probe()
  process.env.STRIPE_SECRET_KEY = SK_TEST
  const test = await probe()
  check('swapping the key is the whole of going live — nothing else changed', live.mode === 'live' && test.mode === 'test', `${live.mode} / ${test.mode}`)
}

/**
 * Every file under `lib/ resources/ routes/` whose CODE reads the Stripe secret key.
 *
 * Keyed on the configured getter rather than on a line of any file, so it is portable into an app
 * whose own modules are nothing like the template's. Comments are stripped, so prose about the key
 * is not a reader.
 */
export function secretKeyReaders (root) {
  const out = []
  for (const dir of COMPONENT_DIRS) {
    for (const f of walk(join(root, dir))) {
      if (/\bstripe\s*\.\s*secretKey\s*\(/.test(stripComments(read(f)))) out.push(f.slice(root.length + 1))
    }
  }
  return out.sort()
}

section('the key has exactly one reader, and it is lib/stripe.js')
{
  const w = fixture(ROOT, COMPONENT_DIRS)
  check('the shipped tree has exactly one reader, and it is lib/stripe.js', JSON.stringify(secretKeyReaders(w)) === JSON.stringify(['lib/stripe.js']), secretKeyReaders(w).join(' | '))

  const fix = (lines) => { writeFileSync(join(w, 'resources', 'ProbeFixture.js'), lines.join('\n') + '\n'); return secretKeyReaders(w) }

  check('a SECOND reader anywhere in the app is caught (NEG)', fix([
    "import { config } from '../lib/config.js'",
    'export const go = () => config.stripe.secretKey()',
  ]).length === 2)

  check('…including one that forwards it to somebody else, which is the shape that matters (NEG)', fix([
    "import { config } from '../lib/config.js'",
    "export const go = () => fetch('https://telemetry.example.test/', {",
    '  method: \'POST\',',
    '  body: config.stripe.secretKey(),',
    '})',
  ]).length === 2)

  check('prose ABOUT the key is NOT a reader — comments are stripped', fix([
    '// This app never calls config.stripe.secretKey() itself; lib/stripe.js does.',
    'export const go = () => 1',
  ]).length === 1)

  check('and reading the WEBHOOK secret is not reading the key (NEG for the line above)', fix([
    "import { config } from '../lib/config.js'",
    'export const go = () => config.stripe.webhookSecret()',
  ]).length === 1)

  discard(w)
}

section('the form encoder (Stripe\'s flat shape)')
{
  check('a nested object becomes metadata[plan]', stripe.encodeForm({ metadata: { plan: 'yearly' } }) === 'metadata%5Bplan%5D=yearly')
  check('an array of objects becomes line_items[0][price]', stripe.encodeForm({ line_items: [{ price: 'p', quantity: 2 }] }) === 'line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=2')
  check('an array of scalars becomes expand[]', stripe.encodeForm({ expand: ['a', 'b'] }) === 'expand%5B%5D=a&expand%5B%5D=b')
  check('absent means absent — null and undefined are skipped, not sent as their own names (rule 11)', stripe.encodeForm({ a: 1, b: null, c: undefined }) === 'a=1')
  check('…and an EMPTY string is still sent, because blank can be a value Stripe means (NEG)', stripe.encodeForm({ a: '' }) === 'a=')
  check('a value that needs escaping is escaped', stripe.encodeForm({ return_url: 'https://app.test/a?b=c&d=e' }) === 'return_url=https%3A%2F%2Fapp.test%2Fa%3Fb%3Dc%26d%3De')
}

process.exit(done())
