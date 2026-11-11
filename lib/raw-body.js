// PAYMENTS KIT — the request's own bytes, kept alongside the parsed body, for the one caller that needs
// them: verifying a webhook signature (resources/StripeWebhook.js).
//
// THE PROBLEM. A signature is a claim about BYTES. Stripe signs the exact UTF-8 string it sent and
// names "reordering keys, stripping whitespace, converting to JSON, or changing encoding" as causes
// of verification failure — its own printed example body is pretty-printed, so the whitespace is not
// hypothetical. A Harper `Resource` is handed the PARSED value and never the bytes, so the one step
// that turns money into access could not be checked at all, and `StripeWebhook` was correctly
// refusing every event with `503 raw_body_unavailable` rather than guessing.
//
// WHY THERE IS NOWHERE ELSE TO PUT THIS. Measured in the published source of both versions this
// project runs — `harper@5.2.13` (control plane and builder) and `harper@5.3.1` (the app clusters),
// read 2026-10-08 via `npm pack harper@<version>`, and byte-identical in every line below:
//
//   server/REST.ts            request.data = getDeserializer(content-type, true)(request.body, …)
//   contentTypes.ts           getDeserializer → (stream) => streamToBuffer(stream).then(deserialize)
//   contentTypes.ts           streamToBuffer accumulates into a LOCAL array and resolves
//                             Buffer.concat(buffers) straight into the parser, retaining nothing
//   resources/Resource.ts     when(data, …) resolves that promise before the resource's method runs
//
// and there is no `rawBody` anywhere in either tree. So the deserializer is the LAST place the bytes
// exist, and `getDeserializer` reads it out of the registry on every request —
// `mediaTypes.get(contentType.type)?.deserialize` — rather than caching it at startup. That is what
// makes wrapping the registry entry work at all, and it is the fact to re-measure on a version bump.
//
// ⚠ THAT LAST FACT IS READ FROM SOURCE AND HAS NOT BEEN DRIVEN ON A CLUSTER, and it is the one this
// whole file rests on, so it says so rather than reading as a measurement. A deployed Harper
// could in principle resolve the deserializer
// earlier than its source suggests, and the symptom would be `503 raw_body_unavailable` on every
// real event — loud, and the honest refusal rather than a wrong verification, which is why this is
// safe to ship ahead of the evidence. Driving it takes one signed, pretty-printed
// Stripe test-mode delivery to a real node.
//
// WHY THIS IS NOT THE "CHANGES EVERY RESOURCE" COST. The obvious shape is to
// REPLACE `application/json`'s deserializer with one that returns the bytes beside the value, which
// changes what every resource in the app receives. This does not do that. It WRAPS the deserializer
// Harper registered, returns that deserializer's own value unchanged, and files the bytes in a
// WeakMap keyed by it. So:
//
//   - every other resource receives the identical value it received before — not a wrapper, not a
//     copy, and not even an extra property. `Object.keys`, `JSON.stringify`, spread, destructuring
//     and `Object.getOwnPropertySymbols` all answer exactly what they answered before, because the
//     object is not touched. A Symbol-keyed property would have been nearly as invisible; a WeakMap
//     is invisible, and the difference is worth the two extra lines in a file seeded into every app;
//   - the bytes are released when the parsed value is, because a WeakMap holds its key weakly. A
//     body is at most HTTP_MAXREQUESTBODYSIZE (10 MB by default) and lives as long as the request;
//   - Harper's own parser is preserved rather than reimplemented. That is load-bearing and not
//     politeness: Harper chooses `JSONParse = SERIALIZATION_BIGINT ? parse : JSON.parse` from its
//     own configuration, so a hand-written `JSON.parse` here would silently drop BigInt handling for
//     the whole app. Wrapping cannot get that wrong; replacing can.
//
// IT IS INSTALLED UNCONDITIONALLY, which is a decision rather than laziness. Gating it on
// `STRIPE_WEBHOOK_SECRET` would narrow it to apps that take payments, and it was rejected: config is
// loaded by a different Harper plugin (`loadEnv`), so the gate would depend on plugin start-up
// ORDER, and the failure mode of getting that wrong is the worst one this area has — payments that
// silently cannot work. The cost of not gating it is one WeakMap write per JSON request.
//
// NOTHING HERE THROWS, EVER. It runs at module scope in a resource, and Harper's ESM linker takes
// every route down when a module fails to load (rule 28) — so a Harper that stops exporting
// `contentTypes`, or stops registering `application/json`, must leave this app serving every other
// route and must leave `StripeWebhook` refusing exactly as it refuses today. `captureRawBody()`
// reports what it did and the caller logs it; it never decides anything.
//
// AND IT NEVER MAKES VERIFICATION EASIER. If the capture did not install, `rawBodyOf` answers null
// and the resource answers `503 raw_body_unavailable`. There is deliberately no path from "no bytes"
// to "verify over something else": re-serialising the parsed value is the exact mutation Stripe
// names, and a 403 for it would blame the sender for the platform's gap.

import * as harper from 'harperdb'

/** The media type Stripe posts. The only one wrapped, because it is the only one that needs it. */
const MEDIA_TYPE = 'application/json'

/**
 * Parsed value → the bytes it was parsed from.
 *
 * WeakMap and not a property on the value: see the header. The key is the object Harper's own
 * deserializer returned, so a caller that was handed that object can ask for its bytes and nobody
 * else can tell the object ever passed through here.
 */
const bytesByValue = new WeakMap()

/**
 * Marks a deserializer as ours, so installing twice wraps once.
 *
 * `Symbol.for` and not a module-local Symbol: a component reload can evaluate this module again in
 * the same realm against the same registry, and two module instances must recognise each other's
 * wrapper or the chain nests once per reload.
 */
const WRAPPED = Symbol.for('immensus.rawBodyCapture')

/**
 * The bytes `parsed` was parsed from, or `null`.
 *
 * `null` is the honest answer in every case the capture is not in force — no registry, no JSON
 * entry, a body that arrived by some other route — and every caller must treat it as "cannot
 * verify" rather than "verify some other way".
 */
export function rawBodyOf (parsed) {
  if (parsed === null || typeof parsed !== 'object') return null
  return bytesByValue.get(parsed) ?? null
}

/**
 * Wrap `application/json`'s deserializer so the bytes survive, and say what happened.
 *
 * Returns a sentence, never throws, and is idempotent. Call it once at module scope from the
 * resource that needs it.
 */
export function captureRawBody () {
  try {
    // READ OFF THE NAMESPACE INSIDE THE `try`, for the reason in the header: a missing export is
    // `undefined` here and a decline below, where a named import would have been a link failure.
    // `contentTypes` is a declared package export in both versions this project runs (`export
    // declare const contentTypes` in index.ts), but this file may be running under a double, a
    // future Harper, or a plain node script — so the shape is checked rather than assumed.
    const contentTypes = harper?.contentTypes
    if (!contentTypes || typeof contentTypes.get !== 'function' || typeof contentTypes.set !== 'function') {
      return 'not installed: harperdb exports no content-type registry'
    }
    const entry = contentTypes.get(MEDIA_TYPE)
    const inner = entry?.deserialize
    if (typeof inner !== 'function') {
      return `not installed: no ${MEDIA_TYPE} deserializer to wrap`
    }
    if (inner[WRAPPED]) return 'already installed'

    // ONE ARGUMENT, because that is all Harper passes. `getDeserializer(type, true)` returns
    // `(stream) => streamToBuffer(stream).then(deserialize)`, and `.then` calls its callback with
    // the Buffer alone — REST.ts passes `request.headers` to the streaming wrapper and the wrapper
    // drops them. A wrapper written against the two-argument non-streaming signature would read
    // `undefined` for the second and look like it worked.
    const wrapped = (data) => {
      const value = inner(data)
      // Only an object can key a WeakMap, so a body that parses to a number, a string, `true` or
      // `null` keeps no bytes. No caller needs them: a webhook event is an object, and a resource
      // handed a primitive has nothing to verify a signature over anyway.
      if (value !== null && typeof value === 'object' && Buffer.isBuffer(data)) bytesByValue.set(value, data)
      return value
    }
    wrapped[WRAPPED] = true

    // Spread the entry rather than writing a fresh one: `serialize`, `serializeStream` and `q` are
    // Harper's and decide how this app RESPONDS. Replacing the entry with `{ deserialize }` alone
    // would silently drop JSON response serialization and content negotiation for the whole app.
    contentTypes.set(MEDIA_TYPE, { ...entry, deserialize: wrapped })
    return 'installed'
  } catch (err) {
    // Reaching here means the registry rejected a write — a frozen Map in some future Harper, say.
    // The app must still serve; `StripeWebhook` will refuse events, which is what it does today.
    return `not installed: ${err?.message ?? String(err)}`
  }
}
