// PAYMENTS KIT — the app's only Stripe surface. It holds the USER's own Stripe secret key and calls
// Stripe itself; nothing of Immensus's is in the payment path.
//
// THE PROBLEM THIS SHAPE SOLVES. A customer has to keep taking money when we are not there. The
// previous version of this file was a thin client to a proxy on the control plane, which held the
// platform's keys and called Stripe with `Stripe-Account` for each app — so an app could take a
// payment only while Immensus was reachable and still paying for it, and a copy of the repository
// deployed on another Harper instance could take none at all. Both halves are ruled out: payments
// run through the user's own Stripe account, and our server never sits in the middle of a payment.
// That is a requirement rather than a preference: a generated app must run on any Harper instance,
// and platform services stop thirty days after a customer leaves.
//
// So: no proxy, no platform Stripe client, no `Stripe-Account`, no application fee, and no
// `X-Immensus-App-Token` — that header's only caller was the proxy and it is struck. A member
// clicks Join, this file calls Stripe with the user's key, and the money lands in the user's
// account. The proxy was never built on the control plane (zero commits for its three files,
// `dependencies: {}`, and its `config.yaml` declares no `fastifyRoutes` to serve a route on,
// re-verified 2026-10-08), so nothing had to be unbuilt — only this half, which was.
//
// `Authorization: Bearer` IS CORRECT HERE, and that is not a breach of rule 27. Rule 27 is about
// Harper claiming that header at its own REST boundary and answering 401 before any resource runs,
// which makes a bearer scheme unreachable against an IMMENSUS endpoint. `api.stripe.com` is not a
// Harper app; `Authorization: Bearer <secret key>` is Stripe's own documented scheme. The rule and
// this file now say the same thing from opposite sides: the header is right for a third party and
// forbidden for ours. Gate: `immensus-auth-acceptance` holds the rule over the whole tree and
// proves a Stripe call site is not flagged by it; `stripe-acceptance` proves every request this
// file makes goes to Stripe.
//
// ⚠ STRIPE'S OWN ERROR MESSAGE CARRIES PART OF THE KEY IT REFUSED, SO IT IS NEVER RELAYED.
// MEASURED against the real api.stripe.com on 2026-10-08, two bogus keys, both answered 401 with
// `type: invalid_request_error` and no `code`:
//
//     a 14-character key  →  "Invalid API Key provided: <prefix>**<the last four characters>"
//     a 37-character key  →  "Invalid API Key provided: <prefix>*************<the last four>"
//
// Stripe leaves the first eight and the LAST FOUR characters in the clear and masks the middle, so
// a short key comes back almost whole. The last four are exactly the fragment every dashboard uses
// to identify a key. Relaying `error.message` is the obvious, helpful thing and is what this
// package does for a Harper or a Cloudflare refusal — and here it would put a piece of the user's
// own credential into an HTTP response body (`runAuthed` puts a thrown message in `detail`), into
// the cluster log, and into whatever support ticket quotes it. So `message` is dropped unread:
// `type` and `status` are read, named, and turned into a code of ours. The same measurement found
// the second reason for the prefix guard below — a webhook signing secret presented as an API key
// is refused with the byte-identical shape, so a 401 cannot tell "wrong kind of secret" from
// "revoked key", and only a local check can.
//
// A real app's `lib/stripe.js` is the precedent for the request layer and the form encoder, and
// this file deviates from it in exactly one place, for the reason above: that app relays
// `data.error.message` and this does not.

import crypto from 'node:crypto'
import { config } from './payments-config.js'
import { json } from './http.js'

const API_BASE = 'https://api.stripe.com/v1'

/**
 * Stripe's API version, pinned.
 *
 * An unpinned call is a claim about whatever Stripe ships next. Pinning is Stripe's own
 * recommendation, and it is what makes a suite that drove this code last month still describe what
 * the cluster does today. It is the same version the platform's own verification pins, so the
 * check that lets a key be saved and the calls that use it speak to one API.
 */
export const STRIPE_API_VERSION = '2024-06-20'

/** One attempt, no retry. See `TIMEOUT_MS`'s note on why there is no idempotency key. */
const TIMEOUT_MS = 15000

/**
 * The cheapest authenticated call Stripe has that reads nothing of a customer's and creates
 * nothing: it proves the key is live and reports `livemode`. `checkStripe` uses it as a readiness
 * probe, and the platform uses the same endpoint to decide whether a pasted key may be
 * sealed — one probe, so the two cannot disagree about what "working" means.
 */
const BALANCE_PATH = '/balance'

// Lowercase: this one is LOOKED UP on an inbound request (resources/StripeWebhook.js). It is
// Stripe's own header now, posted by Stripe to this app, not an Immensus one on a re-signed event.
export const SIGNATURE_HEADER = 'stripe-signature'

// Every prefix Stripe issues for a key that may be sent as `Authorization: Bearer`, with the mode
// it names. A restricted key (`rk_`) is a secret key with a narrower grant and is deliberately
// allowed: a user who pastes one has reduced their own exposure and should not be refused for it.
const KEY_PREFIXES = [
  ['sk_live_', 'live'],
  ['sk_test_', 'test'],
  ['rk_live_', 'live'],
  ['rk_test_', 'test'],
]

/**
 * Which mode a key names, read from its own prefix — `'live' | 'test' | null`.
 *
 * Local, offline, and the only reading available before a call. Stripe issues test and live keys
 * separately, which is why this is a property of the credential the app was given rather than of a
 * setting: "go live" is the user swapping the key. `null` means the string is not a Stripe secret
 * key at all, which is the case the prefix guard exists for.
 */
export function keyMode (key) {
  const k = String(key ?? '')
  for (const [prefix, mode] of KEY_PREFIXES) if (k.startsWith(prefix)) return mode
  return null
}

/** Whether this app has a Stripe secret key at all. False = a payment is refused, not attempted. */
export function stripeConfigured () {
  return Boolean(config.stripe.secretKey())
}

/** Whether Stripe can reach this app's webhook endpoint with a verifiable signature. */
export function webhookConfigured () {
  return Boolean(config.stripe.webhookSecret())
}

/**
 * An error this file raises, carrying a CODE a resource can branch on and a message that is ours.
 *
 * `status` is set for the HTTP statuses `runAuthed` already knows how to transmute (rule 20: a 401
 * must never reach Harper's error path, which decorates it with `WWW-Authenticate: Basic` and pops
 * the browser's basic-auth dialog). Nothing from Stripe's body is ever attached — see the header.
 */
function stripeError (code, message, { status = null, detail = null } = {}) {
  const err = new Error(message)
  err.code = code
  if (status !== null) err.status = status
  if (detail && Object.keys(detail).length) err.detail = detail
  return err
}

/**
 * What of Stripe's own answer may be relayed: its FIXED-VOCABULARY fields, and no free text.
 *
 * `type` and `code` are enumerations of Stripe's, and `param` names a parameter of the request we
 * ourselves built — none of the three is a place a credential belongs, while `message` demonstrably
 * is (see the header). Dropping `message` alone would lose the one genuinely useful thing Stripe
 * says about a malformed request, which is which parameter was wrong, and a generated app's own
 * checkout code is going to need it.
 *
 * AND THERE IS A BACKSTOP, WHICH IS THE PART WORTH COPYING. Each field is dropped if it contains
 * the key or its last four characters. A redactor that has to be taught every provider's key shape
 * is always one provider behind — but THIS app holds its own key, so it can recognise exactly that
 * string and needs to know nothing about anybody's prefixes. The four-character test can in
 * principle drop a parameter name by coincidence, and that asymmetry is deliberate: losing a hint
 * costs a debugging session, and leaking the tail of a live key costs a rotation.
 */
function safeDetail (data, secret) {
  const out = {}
  for (const field of ['type', 'code', 'param']) {
    const v = data?.error?.[field]
    if (typeof v !== 'string' || v === '') continue
    const kept = withoutKey(v, secret)
    if (kept !== null) out[field] = kept.slice(0, 80)
  }
  return out
}

/**
 * `text` if it carries no part of the key, else `null` — the one guard, used everywhere anything
 * from outside this file is about to be written down.
 *
 * It is the same backstop as `safeDetail`'s and it is a SEPARATE function because the other caller
 * is the one that was nearly missed: the catch below logs the message of whatever the fetch threw,
 * which is Node's own text in production and arbitrary text from an injected fetch in a suite. The
 * rule this file states is that nothing free-text is written down unchecked, and a rule with one
 * unchecked caller is a rule with a hole in it.
 */
function withoutKey (text, secret) {
  const t = String(text ?? '')
  if (!secret) return t
  if (t.includes(secret)) return null
  // The last-four test needs a secret long enough for four characters to BE a tail rather than most
  // of it. Every key this file accepts is at least eight characters of prefix plus a payload, so the
  // guard is unreachable here — it is stated because this function is generic and the invariant that
  // makes the test meaningful lives in `localRefusal`, two screens away. Without it, a short secret
  // would make the test match almost any text and silently withhold every detail.
  if (secret.length >= 12 && t.includes(secret.slice(-4))) return null
  return t
}

/**
 * Why a call cannot be made, or `null` if it can — the local half, before any network.
 *
 * Both branches exist because Stripe cannot tell them apart for us. An absent key is the most
 * likely caller of all, and a webhook signing secret pasted into the key field is the single most
 * likely paste error there is: its 401 is byte-identical to a revoked key's, so without this guard
 * a user would be told to roll a key that was never the problem.
 */
function localRefusal (key) {
  if (!key) return ['not_configured', 'Stripe is not connected for this app — no STRIPE_SECRET_KEY']
  if (keyMode(key) === null) {
    return ['wrong_credential_kind', 'STRIPE_SECRET_KEY is not a Stripe secret key (it must begin sk_ or rk_) — a webhook signing secret in this slot is refused by Stripe with the same 401 as a revoked key, so it is refused here instead']
  }
  return null
}

/**
 * Encode a JS object into Stripe's flat form shape:
 *   { line_items: [{ price: 'x' }] }  →  line_items[0][price]=x
 *   { expand: ['a', 'b'] }            →  expand[]=a&expand[]=b
 *   { metadata: { plan: 'yearly' } }  →  metadata[plan]=yearly
 *
 * `undefined` and `null` are SKIPPED rather than sent as the strings "undefined"/"null", which is
 * rule 11's shape: absent means absent. Exported so a suite can drive the encoder on its own
 * rather than only through a recorded request.
 */
export function encodeForm (obj, prefix = '') {
  const parts = []
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === undefined || v === null) continue
    const key = prefix ? `${prefix}[${k}]` : k
    if (Array.isArray(v)) {
      for (const [i, item] of v.entries()) {
        if (item !== null && typeof item === 'object') parts.push(encodeForm(item, `${key}[${i}]`))
        else parts.push(`${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(item))}`)
      }
    } else if (typeof v === 'object') {
      parts.push(encodeForm(v, key))
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`)
    }
  }
  return parts.filter(Boolean).join('&')
}

/**
 * One Stripe call. The ONLY place in this repository that reads the user's secret key, and the only
 * place it is sent anywhere — exactly one site, so there is no second one to get wrong.
 *
 * Throws a `stripeError` on anything but a 2xx, so a resource wrapping the call in `runAuthed`
 * answers an honest status instead of leaking a stack trace. `fetchImpl` is injectable for suites,
 * which is how every branch below is driven without a network.
 *
 * THIS FILE NEVER RETRIES, so it mints no `Idempotency-Key` of its own — a key generated per call
 * would promise protection it does not provide. But the caller may retry, and that is the case that
 * costs money: a timeout AFTER Stripe created the customer or the session answers
 * `stripe_unavailable`, and a naive retry then creates a second one. So `idempotencyKey` is a
 * caller's option on every write, and it has to be the caller's because only the caller knows which
 * two attempts are the same intent. An earlier version of this comment said a caller "should pass
 * its own" while no function accepted one, which is a promise with nothing behind it.
 */
async function stripeRequest (method, path, body = null, fetchImpl = null, idempotencyKey = null) {
  const secret = config.stripe.secretKey()
  const refusal = localRefusal(secret)
  if (refusal) throw stripeError(refusal[0], refusal[1], { status: 503 })

  const doFetch = fetchImpl ?? globalThis.fetch
  let res
  try {
    res = await doFetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        'Stripe-Version': STRIPE_API_VERSION,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey) } : {}),
      },
      body: body ? encodeForm(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    // Stripe did not answer. Say that, and never that the key is bad: telling a user to roll a
    // working key because of an outage is the one wrong answer with no way back.
    console.error(`[stripe] ${method} ${path} did not reach Stripe: ${withoutKey(err?.message ?? err, secret) ?? '(withheld)'}`)
    throw stripeError('stripe_unavailable', 'Stripe could not be reached', { status: 502 })
  }

  // `res.text()` is INSIDE the try with the fetch, not after it: a connection reset or a timeout
  // after the headers have arrived throws here, and outside the try it would escape as a raw error
  // that `stripeFailureResponse` reports as `stripe_refused_request` — the file's own words for
  // "Stripe answered and said no", which is the opposite of what happened. It is also unchecked free
  // text on the one path this file promises has none.
  let text
  try {
    text = await res.text()
  } catch (err) {
    console.error(`[stripe] ${method} ${path} → ${res.status}, then the body failed: ${withoutKey(err?.message ?? err, secret) ?? '(withheld)'}`)
    throw stripeError('stripe_unavailable', 'Stripe could not be reached', { status: 502 })
  }
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { /* not JSON; `data` stays null */ }

  if (!res.ok) {
    const code = classifyFailure(res.status)
    const detail = safeDetail(data, secret)
    // Both the log line and the thrown message are ours. `detail` is Stripe's fixed-vocabulary
    // fields only, each already checked against this app's own key — `message` is read by nothing.
    console.error(`[stripe] ${method} ${path} → ${res.status} ${code} ${JSON.stringify(detail)}`)
    throw stripeError(code, messageFor(code, res.status), {
      status: code === 'key_rejected' || code === 'key_lacks_permission' ? 503 : 502,
      detail,
    })
  }
  return data
}

/**
 * Stripe's status → one of our codes. Grouped by what a person would have to DO about it, which is
 * the only distinction that earns a separate code.
 *
 * 401 is measured (above). 403 is NOT measured and is kept separate rather than folded into
 * `key_rejected` deliberately: a restricted key with a narrow grant can be perfectly able to take
 * a payment and still be refused on the readiness probe, so calling that "your key is rejected"
 * would be a gate crying wolf about a working app.
 */
function classifyFailure (status) {
  if (status === 401) return 'key_rejected'
  if (status === 403) return 'key_lacks_permission'
  if (status === 429) return 'stripe_rate_limited'
  if (status >= 500) return 'stripe_unavailable'
  return 'stripe_refused_request'
}

function messageFor (code, status) {
  if (code === 'key_rejected') return 'Stripe refused this app\'s Stripe key'
  if (code === 'key_lacks_permission') return 'This app\'s Stripe key is not permitted to do that'
  if (code === 'stripe_rate_limited') return 'Stripe is rate limiting this app'
  if (code === 'stripe_unavailable') return 'Stripe could not be reached'
  return `Stripe refused the request (${status})`
}

/**
 * Can this app take a payment right now, and if not, why — WITHOUT throwing.
 *
 * This is the honest state a live app owes its own members. A key that was never pasted, a key the
 * user rolled in their Stripe dashboard, and Stripe being down are three different situations with
 * three different next steps, and a stack trace says none of them. The answer is a CODE and never a
 * sentence a person reads: user-facing copy for these states is the baseline design's, and this
 * package does not write it.
 *
 * `{ ok, code, mode, modeFrom }`. `mode` is `'live' | 'test' | null`, and `modeFrom` says which
 * evidence it came from (§6's evidence tiers in a return value): `'stripe'` when Stripe's own
 * answer carried `livemode`, which is tier 1, and `'prefix'` when it was read off the key, which is
 * a fact about the credential rather than about the account. A build's QA must never hold a live
 * key — that is now a property of which credential the app was given, so this REPORTS the mode and
 * deliberately refuses nothing on it: which deploys may hold a live key is a platform decision
 * nobody has made, and a refusal invented here would be one nothing supports.
 */
export async function checkStripe ({ fetchImpl = null } = {}) {
  const secret = config.stripe.secretKey()
  const refusal = localRefusal(secret)
  if (refusal) return { ok: false, code: refusal[0], mode: keyMode(secret), modeFrom: 'prefix' }
  try {
    const balance = await stripeRequest('GET', BALANCE_PATH, null, fetchImpl)
    const live = balance?.livemode
    return typeof live === 'boolean'
      ? { ok: true, code: 'ok', mode: live ? 'live' : 'test', modeFrom: 'stripe' }
      : { ok: true, code: 'ok', mode: keyMode(secret), modeFrom: 'prefix' }
  } catch (err) {
    return { ok: false, code: err?.code ?? 'stripe_refused_request', mode: keyMode(secret), modeFrom: 'prefix' }
  }
}

/**
 * Turn a failure from this file into a response — the ONE line a resource writes, so that the
 * honest state is the easy thing and a leak is not reachable from a call site.
 *
 * It exists because of what the alternative looks like: a resource that writes its own catch block
 * reaches for `err.message` of whatever it caught, and if the error had come from a provider that
 * would be the key fragment. Here the message is already ours, and the body carries the code rather
 * than any prose, because the sentence a person reads for each of these states is the baseline
 * design's and this package does not write it.
 *
 * Never 401 — rule 20. A refused key is 503 (this app cannot serve the request until its user fixes
 * something) and an unreachable Stripe is 502, so nothing from here can reach Harper's error path
 * as a 401 and be decorated with `WWW-Authenticate: Basic`.
 */
export function stripeFailureResponse (err) {
  const code = err?.code ?? 'stripe_refused_request'
  const status = err?.status === 503 ? 503 : 502
  return json({ error: 'payments_unavailable', code, ...(err?.detail ? { detail: err.detail } : {}) }, status)
}

/**
 * A Checkout Session on the user's own account. `mode` is 'subscription' or 'payment'; `priceId`
 * names a Price in the user's own Stripe account, which is the only account involved;
 * `successUrl`/`cancelUrl` are absolute. Returns Stripe's own Session, whose `url` is where the
 * member goes. There is no application fee: a platform can only levy one on a charge it creates,
 * and under this design Immensus creates none.
 */
export function createCheckoutSession ({ mode, priceId, quantity = 1, successUrl, cancelUrl, customerEmail, customerId, metadata = {} }, { fetchImpl, idempotencyKey } = {}) {
  return stripeRequest('POST', '/checkout/sessions', {
    mode,
    line_items: [{ price: priceId, quantity }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    // Stripe refuses a session that names BOTH, so a known customer wins and the address is
    // dropped rather than sent alongside it — the id is the stronger identity and is what the
    // member's own billing history hangs off.
    customer_email: customerId ? undefined : customerEmail,
    customer: customerId,
    metadata,
  }, fetchImpl, idempotencyKey)
}

/**
 * THIS APP'S OWN CHECKOUT: a one-off payment for a basket of menu items, priced here and now.
 *
 * Added beside `createCheckoutSession` rather than folded into it, because the two take their prices
 * from different places and must not be able to be confused. That one names a `Price` the user keeps
 * in their Stripe dashboard, which is right for a membership; a pizza order is a list of lines whose
 * amounts were computed from this app's own `MenuItem` rows seconds earlier (lib/pricing.js), so it
 * sends `price_data` and no Price exists in Stripe at all. The user's Stripe account never has to
 * mirror the menu.
 *
 * `lines` are `{ name, priceCents, quantity }` — the SNAPSHOT the order stores, so Stripe charges
 * for exactly what the order says. Amounts are whole cents, which is Stripe's own unit for every
 * zero-decimal-exponent currency, so nothing is converted on the way.
 *
 * `metadata` carries the app's order id and code back on the event, and `idempotencyKey` should be
 * the order's code: a customer who taps Pay twice must not create two sessions for one order.
 */
export function createOrderCheckoutSession ({ lines, successUrl, cancelUrl, customerEmail = null, metadata = {}, currency = DEFAULT_CURRENCY }, { fetchImpl, idempotencyKey } = {}) {
  return stripeRequest('POST', '/checkout/sessions', {
    mode: 'payment',
    line_items: (lines ?? []).map((line) => ({
      quantity: line.quantity,
      price_data: {
        currency,
        unit_amount: line.priceCents,
        product_data: { name: line.name },
      },
    })),
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: customerEmail || undefined,
    metadata,
  }, fetchImpl, idempotencyKey)
}

/**
 * The currency this app charges in.
 *
 * One constant rather than a setting, because a shop has one till: a currency the owner could change
 * between the quote and the charge would be a different amount of money for the same number of
 * cents, and nothing in the schema records which currency an old order was taken in.
 */
export const DEFAULT_CURRENCY = 'gbp'

/** A Billing Portal session for `customerId`, so a member manages their own subscription. */
export function createPortalSession ({ customerId, returnUrl }, { fetchImpl, idempotencyKey } = {}) {
  return stripeRequest('POST', '/billing_portal/sessions', { customer: customerId, return_url: returnUrl }, fetchImpl, idempotencyKey)
}

/** One subscription, as Stripe reports it. */
export function getSubscription (subscriptionId, { fetchImpl } = {}) {
  return stripeRequest('GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`, null, fetchImpl)
}

/** One Customer on the user's own account. */
export function createCustomer ({ email, name, metadata = {} }, { fetchImpl, idempotencyKey } = {}) {
  return stripeRequest('POST', '/customers', { email, name, metadata }, fetchImpl, idempotencyKey)
}

/**
 * Sign a payload the way Stripe does — for suites, and for anyone reading the verifier below.
 *
 * Stripe's scheme, which is what `stripe listen` and the dashboard produce: `t=<unix seconds>`
 * and one or more `v1=<hex HMAC-SHA256 over "<t>.<raw body>">`.
 */
export function signStripePayload ({ secret, body, now = Date.now() }) {
  const t = Math.floor(now / 1000)
  return `t=${t},v1=${signedPayloadHmac(secret, t, body)}`
}

/**
 * The hex HMAC Stripe's scheme is defined over: SHA-256 of `"<t>."` followed by the raw body.
 *
 * ONE implementation, shared by the signer above and the verifier below, because the two must agree
 * byte-for-byte about what was signed — "a verdict in two places is a copy with a gate on it; a
 * verdict in one place is a verdict". It also puts the Buffer rule in a single place.
 *
 * THE BODY IS FED IN AS BYTES WHEN IT IS BYTES, and that is the point rather than a tidy-up.
 * `${t}.${body}` coerces a Buffer through `toString()`, which is utf8: lossless for the valid UTF-8
 * Stripe sends, and lossy for anything else, where it substitutes U+FFFD and the verifier then
 * answers `no matching v1 signature` — a refusal blaming the sender for a conversion of ours.
 * Updating the hash with the Buffer removes the conversion instead of documenting it, which is the
 * whole lesson: a signature is a claim about bytes, so nothing between the sender and the
 * check may re-encode them. `resources/StripeWebhook.js` now hands this a Buffer on the live path.
 */
function signedPayloadHmac (secret, t, body) {
  const mac = crypto.createHmac('sha256', secret).update(`${t}.`)
  mac.update(Buffer.isBuffer(body) ? body : String(body))
  return mac.digest('hex')
}

/**
 * Verify STRIPE'S OWN signature on an inbound webhook. `{ ok, reason }` — it never throws, because
 * a verifier that throws turns a forged request into a 500 instead of a refusal.
 *
 * Timing-safe, and it tolerates SEVERAL `v1=` signatures, which is the case a single-signature
 * implementation passes every suite and fails on the day a user rotates their signing secret:
 * Stripe sends one per active secret during the overlap.
 *
 * `now` is injectable because the tolerance is the only clock-dependent rule in this file and a
 * hermetic suite must be able to freeze it (§6).
 */
export function verifyStripeSignature ({ secret, header, body, toleranceSeconds = 300, now = Date.now() }) {
  if (!secret) return { ok: false, reason: 'no secret configured' }
  if (!header) return { ok: false, reason: `missing ${SIGNATURE_HEADER} header` }
  const map = {}
  for (const part of String(header).split(',')) {
    const i = part.indexOf('=')
    if (i < 1) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k === 'v1') (map.v1 ??= []).push(v)
    else map[k] = v
  }
  // BLANK IS ABSENT, not a value — `lib/config.js`'s rule, and here it decides which refusal a
  // reader is told. `Number('')` is 0, which is finite, so a header carrying `t=` with nothing after
  // it would pass the guard below and then fail the TOLERANCE check, reporting a stale signature for
  // what is really a malformed header. The verdict is a refusal either way; the reason would blame
  // the wrong thing, which is the same defect as answering 403 for a gap that is the platform's.
  const rawTs = map.t
  const ts = rawTs === undefined || String(rawTs).trim() === '' ? NaN : Number(rawTs)
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' }
  if (Math.abs(Math.floor(now / 1000) - ts) > toleranceSeconds) return { ok: false, reason: 'stale (>tolerance)' }
  if (!map.v1?.length) return { ok: false, reason: 'no v1 signature' }
  const expected = Buffer.from(signedPayloadHmac(secret, ts, body), 'hex')
  for (const sig of map.v1) {
    const a = Buffer.from(sig, 'hex')
    if (a.length === expected.length && crypto.timingSafeEqual(a, expected)) return { ok: true }
  }
  return { ok: false, reason: 'no matching v1 signature' }
}
