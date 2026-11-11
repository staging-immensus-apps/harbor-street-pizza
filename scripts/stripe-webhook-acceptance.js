#!/usr/bin/env node
// THE PAYMENTS KIT — drives resources/StripeWebhook.js through the stub runtime:
//   - the endpoint REFUSES without a secret (503) and on a bad or stale signature (403)
//   - an event STRIPE posted, signed with the user's own webhook secret, is ledgered once; a
//     redelivery is a no-op (idempotent), which is what Stripe's own retries require
//
// Copied into an app with the rest of the payments kit when a plan calls api.stripe.com.
// It was the Stripe half of `webhooks-acceptance`, which tested the two inbound
// webhooks together while both shipped in every app; the mail half is the sign-in kit's
// `inbound-email-acceptance`. Hermetic: frozen clock (signature tolerance is measured against it), no
// network, no git.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { createHmac } from 'node:crypto'
import { freezeClock } from './probe/frozen-clock.js'
const NOW = freezeClock()

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_' + Buffer.from('suite-stripe-signing-secret').toString('base64')

const { checker } = await import('./probe/harness.js')
const { tables, resetTables } = await import('./probe/harperdb-stub.js')
const { StripeWebhook } = await import('../resources/StripeWebhook.js')
const { signStripePayload, verifyStripeSignature, SIGNATURE_HEADER } = await import('../lib/stripe.js')

const { check, section, done } = checker('stripe-webhook-acceptance')

// The child the handler-outcome section spawns. It lives in the fixture tree, so
// `resources/StripeWebhook.js`'s lazy `../lib/stripe-events.js` resolves to the module the test
// just wrote — which is how every outcome is driven without a seam in the resource.
//
// IT DELIVERS THROUGH THE REGISTRY, pretty-printed, which is the shape Stripe actually posts: the
// bytes go through the deserializer the capture wrapped and the resource has to find them again. A
// child that posted a string would drive the easy path and prove nothing about the capture.
//
// `handler-runs.log` is how the handler reports that it RAN, one character per call, because a
// ledger row proves what was written and not what was executed — and "the handler runs once" is the
// property the dedupe exists for.
const DRIVER = `import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)
import { readFileSync, existsSync } from 'node:fs'
import { freezeClock } from './probe/frozen-clock.js'
const NOW = freezeClock()
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_' + Buffer.from('suite-stripe-signing-secret').toString('base64')
const { tables, resetTables, deserializeBody } = await import('./probe/harperdb-stub.js')
const { StripeWebhook } = await import('../resources/StripeWebhook.js')
const { signStripePayload, SIGNATURE_HEADER } = await import('../lib/stripe.js')
resetTables()
const mode = process.argv[2]
const id = 'evt_child_' + mode
const event = { id, type: 'invoice.paid', data: { object: { id: 'cs_c' } } }
const bytes = Buffer.from(JSON.stringify(event, null, 2), 'utf8')
const sig = signStripePayload({ secret: process.env.STRIPE_WEBHOOK_SECRET, body: bytes, now: NOW })
async function deliverOnce () {
  const r = new StripeWebhook()
  r._context = { headers: new Headers({ [SIGNATURE_HEADER]: sig }), url: '/StripeWebhook/' }
  const res = await r.post({ pathname: '' }, await deserializeBody('application/json', bytes))
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}
const first = await deliverOnce()
const second = mode === 'twice' ? await deliverOnce() : null
const runs = existsSync('handler-runs.log') ? readFileSync('handler-runs.log', 'utf8').length : 0
console.log(JSON.stringify({ ...first, second, runs, ledgered: Boolean(await tables.StripeEvent.get(id)), rows: tables.StripeEvent.rows.size }))
`

// A handler fixture that records each call before doing `body`. Written as source rather than
// composed from a template so the suite's own fixtures stay readable in the diff.
const handlerFixture = (body) => `import { appendFileSync } from 'node:fs'
export async function handleStripeEvent () {
  appendFileSync('handler-runs.log', 'x')
  ${body}
}
`


async function post (Cls, pathname, body, headers = {}) {
  const r = new Cls()
  r._context = { headers: new Headers(headers), url: `/${Cls.name}/${pathname}` }
  const res = await r.post({ pathname }, body)
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers }
}

/**
 * Did this delivery get PAST verification and into the app's own handler?
 *
 * ⚠ THIS REPLACES A `503 no_event_handler` TEST AND IT IS NOT A WEAKENING — it is the same question
 * asked of a different tree. The kit's copy of this suite ran in the bare template, where there is
 * no `lib/stripe-events.js`, so "got past the signature" was visible as the refusal that comes
 * immediately after it. THIS app ships a handler (`lib/stripe-events.js`, which turns a paid
 * Checkout Session into an order in the owner's queue), so the same deliveries now reach it and are
 * answered `200 { outcome }`. Pinning the old refusal here would red on every app that does what the
 * kit exists to enable. The absent-handler branch is still driven, in the child-process section at
 * the end of this file, against a fixture tree with the module removed — which is the only honest
 * way to drive it from an app that has one, because `loadHandler()` latches in module scope.
 *
 * `outcome` is the proof: it is written only after the signature, the raw bytes, the dedupe and the
 * handler have all been passed, so a 200 carrying one cannot be produced by any earlier branch.
 */
function reachedHandler (r) {
  return r.status === 200 && (r.json?.outcome === 'applied' || r.json?.outcome === 'ignored')
}

/**
 * Deliver an event THE WAY STRIPE DOES: `application/json` bytes, deserialized through the
 * registry, so `StripeWebhook` is handed the parsed value and has to find the bytes behind it.
 *
 * The signature is computed over the same Buffer the registry is given, so nothing in the suite
 * re-encodes what it is about to claim was signed — which is the defect the resource exists to
 * refuse, and it would be an odd thing for its own suite to commit.
 */
async function deliver (bytes, { secret = process.env.STRIPE_WEBHOOK_SECRET, now = NOW, mutate = null, signBytes = null } = {}) {
  const { deserializeBody } = await import('./probe/harperdb-stub.js')
  const data = await deserializeBody('application/json', bytes)
  if (mutate) mutate(data)
  // `signBytes` signs something OTHER than what is delivered — the in-flight mutation Stripe names.
  // It defaults to the delivered bytes, so the honest case needs no argument and cannot be the one
  // somebody forgets.
  return post(StripeWebhook, '', data, { [SIGNATURE_HEADER]: signStripePayload({ secret, body: signBytes ?? bytes, now }) })
}
resetTables()

// ⚠ WHICH SHAPE EACH ASSERTION DRIVES, because two of them reach this resource and they are not
// interchangeable. This note used to say the STRING-body assertions described a path production
// could not reach — rule 4's own failure, a fixture richer than the runtime — and the capture closed that
// gap rather than the note having to keep apologising for it.
//
//   - a STRING body is what Harper's own `text/plain` deserializer produces (`data.toString()`).
//     Real, reachable by any sender that declares a text media type, and the cheapest way to drive
//     the signature rules, so the signature section below uses it.
//   - a PARSED body with its bytes behind it is what STRIPE's delivery produces, because Stripe
//     posts `application/json`. Driven through `deserializeBody` from the stub, which applies the
//     registry's deserializer the one way `REST.ts` applies it, so the capture in `lib/raw-body.js`
//     is exercised rather than described. This is the live path and the capture section is first.
//   - a PARSED body with NO bytes behind it — a value the capture never saw — must still be refused
//     `503 raw_body_unavailable`. That is the fail-safe, and it is the control that keeps the other
//     two honest: if `rawBodyOf` ever answered something truthy for any object, it reds.
section('StripeWebhook: the raw body capture')
{
  const { contentTypes, deserializeBody } = await import('./probe/harperdb-stub.js')
  const { captureRawBody, rawBodyOf } = await import('../lib/raw-body.js')

  // `resources/StripeWebhook.js` installs the capture at module scope, and it was imported above —
  // so by the time this runs the registry is already wrapped. Asserted rather than assumed, because
  // every other check in this section and the next rests on it.
  check('importing the resource installed the capture — a second call says so', captureRawBody() === 'already installed')

  const original = contentTypes.get('application/json')
  check('…and the registry still holds exactly one entry for the media type Stripe posts', typeof original?.deserialize === 'function')

  // THE VALUE A RESOURCE RECEIVES IS HARPER'S OWN, UNTOUCHED. This is the cost the chosen candidate
  // was costed at — "it changes body parsing for every resource in every generated app" — so
  // it is the group that has to discriminate. Driven against an UNWRAPPED parse of the same bytes.
  const bytes = Buffer.from('{"b":2,"a":1,"n":null,"arr":[1,2],"s":"x"}', 'utf8')
  const viaCapture = await deserializeBody('application/json', bytes)
  const plain = JSON.parse(bytes.toString('utf8'))
  check('the parsed value is deep-equal to Harper\'s own parse of the same bytes', JSON.stringify(viaCapture) === JSON.stringify(plain))
  check('…with the same own keys in the same order', Object.keys(viaCapture).join(',') === Object.keys(plain).join(','))
  check('…and JSON.stringify of it is byte-identical to the input', JSON.stringify(viaCapture) === bytes.toString('utf8'))
  // THE STRONGEST FORM OF THAT CLAIM, and the reason the bytes live in a WeakMap rather than on the
  // object: a Symbol-keyed property would have been invisible to `Object.keys` and to
  // `JSON.stringify` and would still show up HERE. Nothing is attached at all.
  check('…and the object carries NO extra own symbol, because it is never touched', Object.getOwnPropertySymbols(viaCapture).length === 0)
  check('…and no extra own property of any kind', Reflect.ownKeys(viaCapture).length === Reflect.ownKeys(plain).length)

  check('the bytes come back for the value the capture saw, as the SAME Buffer', rawBodyOf(viaCapture) === bytes)
  check('rawBodyOf of a value the capture never saw → null (NEG)', rawBodyOf({ id: 'x' }) === null)
  check('rawBodyOf of a string → null, because a primitive cannot carry bytes (NEG)', rawBodyOf('{"a":1}') === null)
  check('rawBodyOf of null → null rather than a throw (NEG)', rawBodyOf(null) === null)
  check('rawBodyOf of a number → null rather than a throw (NEG)', rawBodyOf(7) === null)
  // A JSON body may parse to a primitive, which cannot key a WeakMap. It must come back unchanged
  // rather than throwing inside the deserializer, where a throw is a 400 on a well-formed request.
  check('a JSON body that parses to a primitive is returned unchanged and keeps no bytes', await deserializeBody('application/json', Buffer.from('42')) === 42)
  check('…and so is one that parses to null', await deserializeBody('application/json', Buffer.from('null')) === null)

  // WHAT THE WRAPPER PRESERVES, driven on a SENTINEL entry rather than asserted about the live one:
  // the install happened at import time, so there is nothing left to compare the live entry against.
  // `q` and the two serializers are Harper's and decide how this app RESPONDS — replacing the entry
  // with `{ deserialize }` alone would silently drop JSON response serialization and content
  // negotiation for the whole app, and `somethingNew` is the forward-compatibility half: a future
  // Harper adding a field must not lose it.
  const sentinelSerialize = () => 'sentinel'
  const sentinelStream = () => 'sentinel-stream'
  contentTypes.set('application/json', { serialize: sentinelSerialize, serializeStream: sentinelStream, deserialize: (b) => JSON.parse(b), q: 0.42, somethingNew: 7 })
  check('a fresh entry is wrapped and reported installed', captureRawBody() === 'installed')
  const after = contentTypes.get('application/json')
  check('…preserving serialize, serializeStream, q and a key the wrapper has never heard of', after.serialize === sentinelSerialize && after.serializeStream === sentinelStream && after.q === 0.42 && after.somethingNew === 7, JSON.stringify(Object.keys(after)))
  check('…and replacing deserialize and nothing else', typeof after.deserialize === 'function' && Object.keys(after).length === 5)
  check('installing again reports already installed', captureRawBody() === 'already installed')
  check('…and does not nest the wrapper: the registry holds the same function', contentTypes.get('application/json').deserialize === after.deserialize)

  // THE THREE WAYS IT MUST DECLINE RATHER THAN THROW. This runs at module scope in a resource, and
  // Harper's ESM linker takes every route down when a module fails to load (rule 28) — so a
  // Harper that stopped exporting the registry, stopped registering the media type, or froze the
  // Map must leave the app serving and leave this endpoint refusing exactly as it refused before.
  // ⚠ A THROW IS CAUGHT AND REPORTED AS THE VERDICT, and that is not politeness: these three are the
  // only assertions in the suite whose subject is "it does not throw", so letting a throw propagate
  // makes the one defect they exist for arrive as a stack trace instead of a named failure — AND it
  // aborts every assertion after it, including the restore below, so the sections that follow would
  // fail about a registry this one broke. Found by provoking it: an implementation that throws on
  // each branch crashed the suite at the first control with the other two never reached and 100
  // later assertions skipped. A control that cannot survive its own NO case reports once and then
  // stops telling the truth.
  const statusOf = (label) => { try { return captureRawBody() } catch (err) { return `THREW (${label}): ${err?.message ?? err}` } }

  try {
    contentTypes.delete('application/json')
    const noEntry = statusOf('no entry')
    check('no entry for the media type → declines by name, no throw (NEG)', noEntry === 'not installed: no application/json deserializer to wrap', noEntry)

    const realGet = contentTypes.get
    contentTypes.get = undefined
    const noRegistry = statusOf('no registry')
    contentTypes.get = realGet
    check('no registry interface at all → declines by name, no throw (NEG)', noRegistry === 'not installed: harperdb exports no content-type registry', noRegistry)

    contentTypes.set('application/json', { deserialize: (b) => JSON.parse(b) })
    const realSet = contentTypes.set
    contentTypes.set = () => { throw new Error('the registry is frozen in this Harper') }
    const refused = statusOf('frozen registry')
    contentTypes.set = realSet
    check('a registry that refuses the write → declines, carrying the reason, no throw (NEG)', refused === 'not installed: the registry is frozen in this Harper', refused)
  } finally {
    // RESTORED IN A `finally`, for the reason above: the registry is process-wide, so leaving it
    // mutated turns every later section's failure into a puzzle about this one.
    contentTypes.set('application/json', original)
  }
  // …and the restore is ASSERTED rather than trusted, because `finally` having run is not the same
  // as it having put back something that works.
  check('the registry is restored to the wrapped entry the resource installed (NEG for the three above)', contentTypes.get('application/json') === original)
  const restored = await deserializeBody('application/json', bytes)
  check('…and the capture is working again through it', rawBodyOf(restored) === bytes)

  // ⚠ THE ONE CASE THIS PROCESS CANNOT REACH, driven in a CHILD against a `harperdb` double that
  // exports no registry at all.
  //
  // `lib/raw-body.js` is imported at module scope by a resource, so if it failed to LINK, Harper
  // would take the whole resource set down with `ResourceLoadError` naming a line nobody touched —
  // and a named import of an export that does not exist is exactly a link failure, so
  // the `try`/`catch` inside `captureRawBody()` would never run and the file's "nothing here throws"
  // header would be promising the opposite of what it does. It is a NAMESPACE import for that
  // reason. Nothing in this process can see it: the stub beside this suite always exports
  // `contentTypes`, and suites resolve modules with Node's own linker, so the one runtime where
  // this cannot happen is the one every suite runs in. The child brings its own loader and its own
  // two-line double.
  {
    const { spawnSync } = await import('node:child_process')
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { ROOT, fixture, discard } = await import('./probe/harness.js')
    const w = fixture(ROOT, ['lib', 'scripts/probe', 'package.json'])
    mkdirSync(join(w, 'scripts', 'bare'), { recursive: true })
    writeFileSync(join(w, 'scripts', 'bare', 'harperdb.js'), 'export class Resource {}\n')
    writeFileSync(join(w, 'scripts', 'bare', 'loader.js'), `export async function resolve (specifier, context, next) {
  if (specifier === 'harperdb') return { url: new URL('./harperdb.js', import.meta.url).href, shortCircuit: true }
  return next(specifier, context)
}
`)
    writeFileSync(join(w, 'scripts', 'bare', 'driver.mjs'), `import { register } from 'node:module'
register('./loader.js', import.meta.url)
const m = await import('../../lib/raw-body.js')
console.log(JSON.stringify({ loaded: true, status: m.captureRawBody(), raw: m.rawBodyOf({ a: 1 }) }))
`)
    const spawned = spawnSync(process.execPath, [join(w, 'scripts', 'bare', 'driver.mjs')], { encoding: 'utf8', cwd: w })
    let out
    try { out = JSON.parse(spawned.stdout.trim().split('\n').pop()) } catch { out = { error: (spawned.stdout + spawned.stderr).slice(0, 300) } }
    check('a harperdb with NO contentTypes export still LOADS this module — a named import would have failed to link', out.loaded === true, JSON.stringify(out))
    check('…and it declines by name rather than throwing', out.status === 'not installed: harperdb exports no content-type registry', JSON.stringify(out))
    check('…and rawBodyOf answers null, so the resource refuses rather than verifying over something else', out.raw === null, JSON.stringify(out))
    // THE PRECONDITION, READ BACK OFF DISK so it is about the fixture the child actually loaded and
    // not about a literal in this file: the double really does export nothing but `Resource`.
    // Without it the three above would hold against a double that had a registry after all.
    const { readFileSync } = await import('node:fs')
    check('…and the double the child loaded really exports no registry — the premise of the three above', !/contentTypes/.test(readFileSync(join(w, 'scripts', 'bare', 'harperdb.js'), 'utf8')))
    discard(w)
  }
}

section('StripeWebhook: signature')
{
  // STRIPE'S OWN header name, pinned as a literal on purpose. Everything else in this suite is
  // derived from the module's exports, but this one is an EXTERNAL contract: if the constant ever
  // drifts from what Stripe actually sends, every real event is refused while every suite that
  // derived the name from the module stays green.
  check("the header the resource looks up is Stripe's own", SIGNATURE_HEADER === 'stripe-signature', SIGNATURE_HEADER)
  const event = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } }
  const raw = JSON.stringify(event)
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  process.env.STRIPE_WEBHOOK_SECRET = ''
  const noSecret = await post(StripeWebhook, '', raw, { [SIGNATURE_HEADER]: signStripePayload({ secret, body: raw }) })
  check('with no STRIPE_WEBHOOK_SECRET the event is REFUSED (503), never accepted unsigned', noSecret.status === 503)
  process.env.STRIPE_WEBHOOK_SECRET = secret
  const unsigned = await post(StripeWebhook, '', raw)
  check('an unsigned event → 403 (NEG)', unsigned.status === 403)
  const wrong = await post(StripeWebhook, '', raw, { [SIGNATURE_HEADER]: signStripePayload({ secret: 'someone-else', body: raw }) })
  check('a signature under another secret → 403 (NEG)', wrong.status === 403)
  const stale = await post(StripeWebhook, '', raw, { [SIGNATURE_HEADER]: signStripePayload({ secret, body: raw, now: NOW - 10 * 60 * 1000 }) })
  check('a ten-minute-old signature → 403 stale (NEG)', stale.status === 403 && /stale/.test(stale.json?.reason ?? ''))
  const tampered = await post(StripeWebhook, '', raw.replace('cs_1', 'cs_2'), { [SIGNATURE_HEADER]: signStripePayload({ secret, body: raw }) })
  check('a body edited after signing → 403 (NEG)', tampered.status === 403)
  // STRIPE'S OWN BODY SHAPE, and this is the control the whole file turns on. Stripe's docs: "The
  // request body must be the exact UTF-8 string Stripe sent, without any modifications… stripping
  // whitespace… causes signature verification to fail", and the body it prints is PRETTY-PRINTED.
  // So the suite must drive a pretty-printed body, or it would pass against an implementation that
  // normalises the bytes before checking them — which is exactly the defect this file is about.
  // Its own event id, because a verified event is LEDGERED and the ledger section below drives
  // `evt_1` from a clean slate — a control that quietly consumes another section's fixture is how
  // one assertion's success becomes another's silent precondition.
  const prettyEvent = { id: 'evt_pretty', type: 'checkout.session.completed', data: { object: { id: 'cs_p' } } }
  const pretty = JSON.stringify(prettyEvent, null, 2)
  check('the fixture really is pretty-printed — the premise of the two checks below', /\n  "id"/.test(pretty))
  const prettyOk = await post(StripeWebhook, '', pretty, { [SIGNATURE_HEADER]: signStripePayload({ secret, body: pretty }) })
  // THE SUBJECT IS THE SIGNATURE, NOT THE STATUS. What getting PAST verification looks like depends
  // on the tree: in the bare template, which has no handler, it was `503 no_event_handler`; in this
  // app, which has one, it is a 200 carrying the handler's own outcome (`reachedHandler`, above).
  // Either way the assertion is "the signature was accepted", and pinning the wrong one of them
  // would make a refusal downstream of verification read as a signature defect, in the one suite
  // whose job is telling those apart.
  check("a pretty-printed body — Stripe's own documented shape — verifies when it arrives unmodified", reachedHandler(prettyOk), `${prettyOk.status} ${JSON.stringify(prettyOk.json)}`)
  const prettyMangled = await post(StripeWebhook, '', JSON.stringify(prettyEvent), { [SIGNATURE_HEADER]: signStripePayload({ secret, body: pretty }) })
  check('…and the same body with its whitespace stripped → 403, which is the mutation Stripe names (NEG)', prettyMangled.status === 403)

  // ✓ THE LIVE PATH: the same pretty-printed body delivered the way Stripe delivers it —
  // `application/json` bytes, parsed by the registry — verifies, because the capture kept the bytes.
  // Before the capture this was the one shape a deployed app could actually see and the one shape
  // that could not be verified at all.
  const liveEvent = { id: 'evt_live', type: 'checkout.session.completed', data: { object: { id: 'cs_l' } } }
  const liveBytes = Buffer.from(JSON.stringify(liveEvent, null, 2), 'utf8')
  check('the live fixture really is pretty-printed too — the premise of the two checks below', /\n  "id"/.test(liveBytes.toString('utf8')))
  const live = await deliver(liveBytes)
  check("a pretty-printed body delivered as application/json verifies — the shape a deployed app sees", live.status !== 403 && live.json?.code !== 'raw_body_unavailable', `${live.status} ${JSON.stringify(live.json)}`)
  // …and it reaches this app's own handler, which is the far side of every check the resource makes:
  // the signature was verified against the bytes the capture kept, the id was read out of them, and
  // the dedupe let it through.
  check('…and gets as far as the handler, so the signature really was verified', reachedHandler(live), `${live.status} ${JSON.stringify(live.json)}`)
  // THE MUTATION STRIPE NAMES, on the live path rather than only on the string one: signed
  // pretty-printed, delivered whitespace-stripped. It is the same JSON document either way, which is
  // the point — an implementation that normalised the bytes before checking them would pass.
  const strippedBytes = Buffer.from(JSON.stringify(liveEvent), 'utf8')
  const liveMangled = await deliver(strippedBytes, { signBytes: liveBytes })
  check('…while the same event signed pretty and delivered stripped → 403 on the live path too (NEG)', liveMangled.status === 403, `${liveMangled.status} ${JSON.stringify(liveMangled.json)}`)
  check('…and the stripped bytes signed over THEMSELVES are not refused, so the NEG above is about the mutation and not the shape', (await deliver(strippedBytes)).status !== 403)

  // THE FAIL-SAFE, AND IT IS THE CONTROL THAT KEEPS THE TWO ABOVE HONEST. A parsed value the capture
  // never saw has no bytes behind it, so the signature cannot be checked against what Stripe signed.
  // It must refuse with its OWN code and must NOT report a bad signature, because the sender did
  // nothing wrong — and if `rawBodyOf` ever answered something truthy for an arbitrary object, this
  // is the assertion that reds.
  const parsedEvent = { id: 'evt_parsed', type: 'checkout.session.completed', data: { object: { id: 'cs_q' } } }
  const parsed = await post(StripeWebhook, '', parsedEvent, { [SIGNATURE_HEADER]: signStripePayload({ secret, body: JSON.stringify(parsedEvent) }) })
  check('a parsed body the capture never saw → 503 raw_body_unavailable, never a 403 blaming Stripe', parsed.status === 503 && parsed.json?.code === 'raw_body_unavailable', `${parsed.status} ${JSON.stringify(parsed.json)}`)
  check('…and nothing is ledgered for it — an unverifiable event is not a processed one', !(await tables.StripeEvent.get('evt_parsed')))

  // THE DOCUMENT THAT WAS VERIFIED IS THE DOCUMENT THAT RUNS. The bytes and the parsed value are two
  // derivations of one request and the resource takes the event from the BYTES, so the id it looks
  // up in the ledger comes from what was signed. Driven by mutating the parsed value after the
  // capture saw it, which is what anything sitting between Harper and the resource would look like,
  // and read off the DEDUPE: a pre-seeded row for the bytes' id makes the delivery a duplicate.
  const bytesId = Buffer.from(JSON.stringify({ id: 'evt_from_bytes', type: 'invoice.paid' }), 'utf8')
  await tables.StripeEvent.put({ id: 'evt_from_bytes', type: 'invoice.paid', receivedAt: 'seeded', outcome: 'applied' })
  const fromBytes = await deliver(bytesId, { mutate: (d) => { d.id = 'evt_from_object'; d.type = 'customer.deleted' } })
  check('the id looked up is the one in the verified bytes, not the one on the parsed object', fromBytes.status === 200 && fromBytes.json?.duplicate === true, `${fromBytes.status} ${JSON.stringify(fromBytes.json)}`)
  // THE MIRROR, so the assertion above cannot pass by accident: seeding the OBJECT's id instead
  // leaves the bytes' id unledgered, and the delivery must get past the dedupe.
  await tables.StripeEvent.put({ id: 'evt_from_object_only', type: 'x', receivedAt: 'seeded', outcome: 'applied' })
  const fromObject = await deliver(Buffer.from(JSON.stringify({ id: 'evt_not_seeded', type: 'invoice.paid' }), 'utf8'), { mutate: (d) => { d.id = 'evt_from_object_only' } })
  check('…and seeding only the parsed object\'s id does NOT make it a duplicate (NEG)', reachedHandler(fromObject) && fromObject.json?.duplicate !== true, `${fromObject.status} ${JSON.stringify(fromObject.json)}`)

  const oldHeader = await post(StripeWebhook, '', raw, { 'x-immensus-signature': signStripePayload({ secret, body: raw }) })
  check('a correctly signed event under the REJECTED design\'s header name → 403 (NEG)', oldHeader.status === 403)
  const rotated = verifyStripeSignature({ secret, header: `t=${Math.floor(NOW / 1000)},v1=deadbeef,${signStripePayload({ secret, body: raw }).split(',')[1]}`, body: raw })
  check('several v1 signatures are tolerated during a rotation', rotated.ok === true)
  check('the verifier refuses a 401-shaped mistake: it never throws, it answers { ok:false }', verifyStripeSignature({ secret, header: 'garbage', body: raw }).ok === false)

  // WHICH REFUSAL a reader is told, not just that there is one. Every malformed timestamp must read
  // `bad timestamp` and not `stale` — `t=` with nothing after it is the case that got this wrong,
  // because `Number('')` is 0 and 0 is finite, so it reached the tolerance check and reported a
  // stale signature for a malformed header. A refusal that blames the wrong thing sends somebody
  // looking at their clock.
  for (const [header, label] of [['garbage', 'no t at all'], ['t=abc,v1=ff', 'a non-numeric t'], ['v1=ff', 'a v1 with no t'], ['t=,v1=ff', 'an EMPTY t'], ['t=   ,v1=ff', 'a whitespace t']]) {
    const r = verifyStripeSignature({ secret, header, body: raw })
    check(`${label} → bad timestamp, never stale`, r.ok === false && r.reason === 'bad timestamp', JSON.stringify(r))
  }
  const ancient = verifyStripeSignature({ secret, header: 't=1,v1=ff', body: raw })
  check('…while a real but ancient t DOES reach the tolerance check (NEG for the five above)', ancient.reason === 'stale (>tolerance)', JSON.stringify(ancient))

  // A MALFORMED v1 MUST NOT REACH timingSafeEqual. `Buffer.from(s, 'hex')` truncates silently on
  // odd length or non-hex — 'abc' is one byte, 'zz' is zero — so without the length comparison a
  // short forgery would be compared against a prefix of the real digest, and timingSafeEqual itself
  // THROWS on mismatched lengths, which would turn a forgery into a 500.
  const t = Math.floor(NOW / 1000)
  for (const [v1, label] of [['abc', 'odd-length hex'], ['zz', 'not hex at all'], ['', 'empty'], ['ff', 'one valid byte'], ['f'.repeat(128), 'far too long']]) {
    const r = verifyStripeSignature({ secret, header: `t=${t},v1=${v1}`, body: raw })
    check(`a ${label} v1 is refused without throwing`, r.ok === false, JSON.stringify(r))
  }
  const good = signStripePayload({ secret, body: raw, now: NOW })
  check('…and the correct v1 still verifies (NEG for the five above)', verifyStripeSignature({ secret, header: good, body: raw, now: NOW }).ok === true)

  // ⚠ AN INDEPENDENT SIGNER, AND THE REASON IS A MUTATION THAT GOT THROUGH WITHOUT ONE.
  // `signStripePayload` and `verifyStripeSignature` are the same module and share one
  // `signedPayloadHmac`, so every assertion that signs with the first and checks with the second
  // proves SELF-CONSISTENCY and nothing about Stripe's scheme. Measured: reverting the body
  // handling to `${t}.${body}` — the lossy string coercion this change removed — left the whole
  // group below GREEN, because both sides then coerce identically. This is exactly why the svix
  // half of this suite has had its own signer from the start, and the Stripe half never did.
  //
  // So the signature is computed here straight from Stripe's definition — HMAC-SHA256 over
  // `"<t>."` followed by the raw body — with the body fed in AS BYTES and nothing re-encoded.
  const stripeSignatureOver = (bytes, t = Math.floor(NOW / 1000)) => {
    const mac = createHmac('sha256', secret)
    mac.update(Buffer.from(`${t}.`, 'utf8'))
    mac.update(bytes)
    return `t=${t},v1=${mac.digest('hex')}`
  }

  // THE POSITIVE CONTROL, and it is new: nothing in this suite had ever shown that the verifier
  // implements Stripe's scheme rather than merely agreeing with its own signer.
  const ascii = Buffer.from('{"id":"evt_independent","type":"invoice.paid"}', 'utf8')
  check("an independently computed signature verifies — the verifier implements Stripe's scheme, not just its own signer", verifyStripeSignature({ secret, header: stripeSignatureOver(ascii), body: ascii, now: NOW }).ok === true)
  check('…and the two agree byte for byte on an ordinary body (NEG: a disagreement would red here first)', stripeSignatureOver(ascii) === signStripePayload({ secret, body: ascii, now: NOW }))

  // THE CASE THE COERCION LOSES. The precondition is asserted FIRST, because without it the check
  // below would hold for a body that round-trips cleanly and the group would quietly prove nothing
  // (`look-acceptance`'s `@import` shape).
  const notUtf8 = Buffer.concat([Buffer.from('{"id":"evt_raw","type":"invoice.paid","x":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')])
  check('the fixture really does lose bytes through a string round trip — the premise of the two below', !Buffer.from(notUtf8.toString('utf8'), 'utf8').equals(notUtf8))
  check('…so bytes that are not valid UTF-8 verify against an independent signature over the SAME bytes', verifyStripeSignature({ secret, header: stripeSignatureOver(notUtf8), body: notUtf8, now: NOW }).ok === true)
  check('…and the signer agrees with it, so neither side re-encodes the body', stripeSignatureOver(notUtf8) === signStripePayload({ secret, body: notUtf8, now: NOW }))
}

section('StripeWebhook: this app HAS a handler, so a verified event is dealt with once')
{
  const event = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } }
  const raw = JSON.stringify(event)
  const sig = signStripePayload({ secret: process.env.STRIPE_WEBHOOK_SECRET, body: raw })

  // ⚠ THIS SECTION ASSERTED THE TEMPLATE'S STATE AND NOW ASSERTS THIS APP'S, which is a different
  // tree rather than a lowered bar. The kit ships into an app with no `lib/stripe-events.js`, where
  // a verified event is refused `503 no_event_handler` and NOT ledgered — deliberately, because a
  // 2xx tells Stripe to stop retrying, so acking an event nothing processed loses it for good. This
  // app ships that module (a paid Checkout Session becomes an order in the owner's queue), so the
  // same delivery now reaches the handler and is answered and ledgered. **The refusal branch is not
  // untested by that**: it is driven at the end of this file in a child process whose fixture tree
  // has the module removed — the only way to see both states, since `loadHandler()` latches.
  const first = await post(StripeWebhook, '', raw, { [SIGNATURE_HEADER]: sig })
  check('a well-signed event reaches this app\'s handler and is answered with its outcome', reachedHandler(first), `${first.status} ${JSON.stringify(first.json)}`)
  check('…and IS ledgered, because the app looked at it and decided', (await tables.StripeEvent.get('evt_1'))?.outcome === first.json?.outcome)

  // THE PROPERTY STRIPE'S RETRIES REQUIRE: Stripe redelivers on purpose, so the second delivery of
  // one event id must be short-circuited by the ledger rather than handled again.
  // Its own row is compared rather than the table's size: other sections in this process have
  // ledgered their own events, and a count would make this assertion depend on theirs.
  const ledgerBefore = JSON.stringify(await tables.StripeEvent.get('evt_1'))
  const retry = await post(StripeWebhook, '', raw, { [SIGNATURE_HEADER]: sig })
  check('a redelivery is answered `duplicate` rather than handled twice', retry.status === 200 && retry.json?.duplicate === true, `${retry.status} ${JSON.stringify(retry.json)}`)
  check('…and its ledger row is untouched by the retry', JSON.stringify(await tables.StripeEvent.get('evt_1')) === ledgerBefore)

  // The refusal must come AFTER the signature check, or an unsigned caller would learn whether the
  // app has a handler — and, more to the point, a 403 is the answer a forged request deserves.
  const forged = await post(StripeWebhook, '', raw, { [SIGNATURE_HEADER]: 't=1,v1=ff' })
  check('an unsigned event is still 403 and never reaches the handler check (NEG)', forged.status === 403, `${forged.status} ${JSON.stringify(forged.json)}`)

  const noId = await post(StripeWebhook, '', '{"type":"x"}', { [SIGNATURE_HEADER]: signStripePayload({ secret: process.env.STRIPE_WEBHOOK_SECRET, body: '{"type":"x"}' }) })
  check('an event without an id → 400, before the handler check (NEG)', noId.status === 400)
  const sub = await post(StripeWebhook, 'extra', raw, { [SIGNATURE_HEADER]: sig })
  check('a sub-path → 404', sub.status === 404)
}

section('StripeWebhook: the ledger, driven on the live path with a real handler')
{
  // EVERY OUTCOME HERE IS DRIVEN IN A CHILD PROCESS against a fixture tree carrying a real
  // `lib/stripe-events.js`, and delivered through the registry as `application/json`.
  //
  // Why a child: `loadHandler()` latches the lazily imported seam in module scope, so one process
  // can observe either the absent seam (the section above, which is the template's own state) or a
  // present one, never both. A fixture tree is what supplies the module, so the resource needs NO
  // test seam and ships exactly as reviewed — `scripts/probe/loader.js`'s own stated rule — and the
  // harness is not touched either.
  const { spawnSync } = await import('node:child_process')
  const { writeFileSync, mkdirSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { ROOT, fixture, discard } = await import('./probe/harness.js')
  const w = fixture(ROOT, ['resources', 'lib', 'scripts/probe', 'package.json'])
  mkdirSync(join(w, 'lib'), { recursive: true })
  writeFileSync(join(w, 'scripts', 'driver.mjs'), DRIVER)
  // The run log is cleared BEFORE each child, or every count would be the sum of the runs before
  // it and "the handler ran once" would read as true for a handler that never ran at all.
  const run = (mode) => {
    rmSync(join(w, 'handler-runs.log'), { force: true })
    const r = spawnSync(process.execPath, [join(w, 'scripts', 'driver.mjs'), mode], { encoding: 'utf8', cwd: w })
    try { return JSON.parse(r.stdout.trim().split('\n').pop()) } catch { return { error: r.stdout + r.stderr } }
  }

  // THE ABSENT-HANDLER BRANCH FIRST, because this app can no longer show it in process: its own
  // `lib/stripe-events.js` is latched by `loadHandler()` into every delivery above, and the fixture
  // tree copied it along with the rest of `lib`. Removing it from the COPY puts the child in the
  // state the bare template is in, which is the state every app is in between the day the payments
  // kit lands and the day its handler is written — so it is worth a test in an app that has one.
  //
  // What it must do is refuse and ledger NOTHING. This branch once answered 200 and recorded the
  // event `unhandled`, which told Stripe the event was processed: Stripe never sent it again, and an
  // app that wrote its handler the following week had lost everything that arrived before it. It is
  // the 200-on-throw defect one branch over — a 2xx is an instruction to stop retrying rather than a
  // status. And a row written here would turn every retry into a 200 `duplicate` and lose the event
  // just as surely, which is why the redelivery is driven too.
  rmSync(join(w, 'lib', 'stripe-events.js'), { force: true })
  const absent = run('twice')
  check('a well-signed event with NO handler in the app → 503 no_event_handler, never an ack', absent.status === 503 && absent.body?.code === 'no_event_handler', JSON.stringify(absent))
  check('…and NOTHING is ledgered, so the event stays at Stripe where it can be redelivered', absent.ledgered === false && absent.rows === 0, JSON.stringify(absent))
  check('…and a redelivery is refused again rather than answered `duplicate` (NEG)', absent.second?.status === 503 && absent.second?.body?.code === 'no_event_handler', JSON.stringify(absent))
  check('…and the handler never ran, because there was none (NEG for the three below)', absent.runs === 0, JSON.stringify(absent))

  writeFileSync(join(w, 'lib', 'stripe-events.js'), handlerFixture("throw new Error('the app\\'s own handler blew up, with a message only it chose')"))
  const failed = run('throws')
  check('a handler that threw → 500, so Stripe RETRIES rather than giving up (NEG)', failed.status === 500, JSON.stringify(failed))
  check('…and nothing is ledgered for it, so the retry really does re-run', failed.ledgered === false, JSON.stringify(failed))
  check("…and the handler's own message is NOT relayed — this endpoint is public", !/blew up|only it chose/.test(JSON.stringify(failed.body)), JSON.stringify(failed.body))
  // THE PRECONDITION FOR THE THREE ABOVE: the delivery really did get past the signature, the raw
  // body and the dedupe and into the handler. Without it they would all hold against a 500 raised
  // for some entirely different reason, which is the shape where a group quietly proves nothing.
  check('…and the handler really ran, so those three are about the handler and not an earlier refusal', failed.runs === 1, JSON.stringify(failed))

  writeFileSync(join(w, 'lib', 'stripe-events.js'), handlerFixture('return true'))
  const applied = run('applies')
  check('a handler that returned → 200 applied, and IS ledgered (NEG for the four above)', applied.status === 200 && applied.body?.outcome === 'applied' && applied.ledgered === true, JSON.stringify(applied))
  check('…on the live application/json path, which is what the capture bought', applied.runs === 1, JSON.stringify(applied))

  // THE DEDUPE, END TO END: the same event delivered twice in one process. The RUN COUNT is the
  // assertion, because a ledger row proves what was written and not what was executed, and "the
  // handler runs once" is the only property the dedupe exists for.
  const twice = run('twice')
  check('two deliveries of one event id → the handler runs ONCE', twice.runs === 1, JSON.stringify(twice))
  check('…the first applies and the second answers duplicate', twice.status === 200 && twice.body?.outcome === 'applied' && twice.second?.status === 200 && twice.second?.body?.duplicate === true, JSON.stringify(twice))
  check('…and one ledger row, not two', twice.rows === 1, JSON.stringify(twice))

  writeFileSync(join(w, 'lib', 'stripe-events.js'), handlerFixture('return false'))
  const ignored = run('ignores')
  check('a handler that returned false → 200 ignored, and is ledgered so it is not re-run', ignored.body?.outcome === 'ignored' && ignored.ledgered === true, JSON.stringify(ignored))
  check('…and `ignored` is a DECISION the app made, so the handler was asked', ignored.runs === 1, JSON.stringify(ignored))

  writeFileSync(join(w, 'lib', 'stripe-events.js'), 'export const notTheExport = 1\n')
  const wrongShape = run('applies')
  check('a module with no handleStripeEvent export is refused like an absent one — not a crash, and no longer an ack (NEG)', wrongShape.status === 503 && wrongShape.body?.code === 'no_event_handler', JSON.stringify(wrongShape))
  check('…and nothing is ledgered for it either', wrongShape.ledgered === false, JSON.stringify(wrongShape))
  discard(w)
}
check('the clock was frozen throughout', Date.now() === NOW)
process.exit(done())
