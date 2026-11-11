// PAYMENTS KIT — STRIPE'S OWN webhooks, Stripe-signature verified, idempotent by event id.
//
//   POST /StripeWebhook/   a raw Stripe event, `stripe-signature` header
//
// THE PROBLEM. A payment is only half finished when the member pays: something has to hear that it
// happened and turn it into a membership. Stripe says so by posting the event here.
//
// STRIPE POSTS TO THIS APP DIRECTLY, with the user's own webhook signing secret. This file used to
// expect an event the control plane had verified and RE-SIGNED with an Immensus HMAC, which made
// Immensus a required part of getting paid; that whole shape is rejected, so the app verifies
// Stripe's own signature and there is no hop. No STRIPE_WEBHOOK_SECRET → every event is REFUSED (503), never accepted
// unsigned: a generated app must not be one blank environment variable away from trusting anyone
// who can reach this endpoint, and this endpoint is public by nature.
//
// Idempotency ledger: `StripeEvent` (expiration 30 days) keyed by the Stripe event id. A
// redelivery finds the row and nothing runs twice — and Stripe redelivers on purpose, so this is
// the half of the file that was always right. The row is written AFTER the handler with its
// outcome, so a handler that threw is not silently marked done.
//
// ⚠ A FAILED HANDLER ANSWERS 500, NOT 200, AND THE OLD COMMENT HERE WAS WRONG ABOUT WHY.
// It said 200 was answered either way "because a retry storm on billing is worse than a missed
// event, which the ledger row makes visible". That was written for the rejected design, where the
// control plane was the redeliverer. **Stripe retries on a non-2xx and STOPS on a 2xx**, so a 200
// after a handler threw tells Stripe the event was processed: the absent ledger row then means
// nothing, nobody is watching it, and the payment never becomes a membership. A 500 is the signal
// Stripe's own troubleshooting table tells an operator to go and read their logs for, and Stripe's
// retry schedule is bounded (with backoff, up to three days) rather than a storm.
//
// ⚠ AN APP WITH NO HANDLER REFUSES TOO, AND THAT IS A DECISION RATHER THAN A SIDE EFFECT.
// This branch used to ledger the event `unhandled` and ack 200 — so Stripe never sent it
// again, and an app that wrote its handler the following week had lost every event that arrived
// before it. It is the same defect as the 200-on-throw above, one branch over: a 2xx is an
// instruction to stop retrying, not a status. So an absent seam answers 503 and NOTHING is
// ledgered, which leaves the event at Stripe where it can still be redelivered.
//
// The cost is stated rather than smoothed: a misconfiguration nobody fixes means an endpoint that
// fails every delivery, and Stripe disables an endpoint that fails for long enough. That is still
// the right side of the trade, and the reason is an asymmetry rather than a preference — a disabled
// endpoint is loud, is visible in Stripe's own dashboard, and a human re-enables it; an acked event
// that nothing processed is a payment taken that never becomes a membership, with no red anywhere
// and nothing able to recover it. (Everything this file says about what Stripe does with a status
// code is Stripe's PUBLISHED behaviour, and none of it has been driven against a real delivery by
// anybody: it needs a registered endpoint and its signing secret.)
//
// AND THE BRANCH BESIDE IT IS WHAT MAKES THIS ONE RULE RATHER THAN TWO. A handler that returns
// `false` is `ignored`, ledgered, and acked 200 — because the app LOOKED at the event and said it
// does not care, which is a decision. An app with no handler has said nothing. Acking a decision
// and refusing silence is one rule.
//
// ⚠ THE DEDUPE IS STILL CHECK-THEN-ACT, AND THAT IS A MEASURED DECISION RATHER THAN A
// DEFERRAL. `get` then handler then `put` lets two concurrent deliveries of one event both pass the
// `get` and both reach the handler. The obvious fix is this package's own atomic precedent —
// `resources/Bootstrap.js` refuses a second first-admin with `create()` on a fixed id, "inside the
// write, not at a check the other request already passed" — and it was taken apart and refused on
// three findings, all read from `harper@5.3.1`'s own source on 2026-10-08:
//
//   1. `create()`'s duplicate check is `primaryStore.getSync(id)` (resources/Table.ts, immediately
//      above its `Record already exists` 409) — a LOCAL, synchronous, non-transactional read. So
//      the 409 is not a cluster-wide guarantee. An app cluster has more than one node and Stripe
//      load-balances its deliveries, so two nodes would both see nothing locally and both claim: a
//      claim built on it would NOT deliver "the handler runs once", the only property worth the
//      change. **An independent measurement of the same thing went further**, and
//      its finding is the one to quote rather than this paragraph: the commit path "retries a
//      refused absence condition and then escalates to an unconditional write", so the 409 is a
//      SEQUENTIAL GUARD and not an arbiter — it is not a claim even within one node.
//   2. A claim released by the table's own TTL — `@table(expiration: N)`, which is how rule 10
//      already handles short-lived tokens — looked like the shape that needs no clock of ours. It
//      does not work either: expiration is enforced on RETRIEVAL (`entry.expiresAt < Date.now()` in
//      the read paths) while `create()` reads through `getSync`, which applies no expiry at all, so
//      an expired claim would keep answering 409 until a best-effort background scan evicted it.
//   3. Claiming before the handler introduces a failure this shape does not have. A process killed
//      between the claim and its release leaves the claim standing with nothing to clear it — and
//      `harper deploy . restart=rolling` kills workers on every publish, so that is routine
//      rather than exotic. The event is then either acked and lost, or refused for ever.
//
// `Table.lock()` is the primitive that would settle it and is deliberately not used: it throws
// `Not yet implemented` before 5.3, Harper has told us the 5.3 implementation still has work
// outstanding, and this app must run on any Harper instance — so a lock would make payments work on some clusters and not others.
//
// So the requirement stays where Stripe itself puts it, and §3 states it beside the seam:
// **`handleStripeEvent` must be idempotent** ("Guard against duplicated event receipts by logging
// the event IDs you've processed"). A double run is a hazard the seam is told to defend; a wedged
// event is one nothing defends. Trading the first for the second while gaining no atomicity is a
// bad trade.
//
// AND THERE IS NO PRIMITIVE WAITING: nothing is pending that would make this atomic. What would
// change the answer is a Harper that offers a claim holding across nodes (`Table.lock()`, once its
// 5.3 implementation is finished and every cluster an app may be deployed to has it), and that is
// a dependency bump rather than an issue on this board.
//
// ⚠⚠ THE SIGNATURE IS OVER THE RAW BYTES, AND A HARPER RESOURCE IS NOT GIVEN THEM. MEASURED, BOTH
// SIDES, 2026-10-08 — read this before changing anything here.
//
// STRIPE'S SIDE, from its own documentation: "The request body must be the exact UTF-8 string
// Stripe sent, without any modifications… Some frameworks parse or mutate the request body before
// your code sees it — by reordering keys, stripping whitespace, converting to JSON, or changing
// encoding — which causes signature verification to fail." Its printed example of a body is
// PRETTY-PRINTED, with newlines and indentation.
//
// HARPER'S SIDE, read from the published source of both versions this project runs (`harper@5.2.13`,
// the control plane and the builder; `harper@5.3.1`, the app clusters): for `application/json`,
// `server/REST.ts` sets `request.data = streamToBuffer(request.body).then(JSONParse)` and hands the
// RESOLVED value to `resource.post(target, data, request)` (`resources/Resource.ts`'s `when(data,
// …)` is what resolves it, which is also why a resource never sees a pending promise). The Buffer
// is a local inside `streamToBuffer` and is dropped; `request.body` is drained; and there is no
// `rawBody` anywhere in either tree. So the bytes Stripe signed do not exist by the time this code
// runs, and `JSON.stringify(parsed)` is a DIFFERENT document — Stripe names stripping whitespace as
// a cause of failure in as many words.
//
// ✓ IT IS RESOLVED AT THE LAST PLACE THE BYTES EXIST, WHICH IS THE DESERIALIZER ITSELF.
// `lib/raw-body.js` wraps the `application/json` deserializer Harper registered in its own public
// `contentTypes` export and files the Buffer in a WeakMap keyed by the value that deserializer
// returned. That file's header carries the measurements, the two candidates refused, and why
// this is not the "changes body parsing for every resource in every generated app" cost it
// was weighed at: every other resource receives the identical value it received before — not a
// wrapper, not a copy, not even an extra property — because the object is never touched.
//
// THIS WAS NOT A REGRESSION THE STRIPE-SIGNATURE CHECK INTRODUCED. The version before it verified
// an Immensus HMAC over the same re-serialised bytes, on an event re-signed by a control-plane proxy that was never built
// (zero commits for its three files) — so no event had ever reached this file and the hazard could
// not be seen. Giving it a real sender is what made it measurable.
//
// AND THE REFUSAL STAYS, because the capture can be absent. A body reaching `post` with no bytes
// behind it is refused `503 raw_body_unavailable` and never `403 invalid signature`: a 403 says the
// sender got something wrong when what is missing is the platform's, and it would send an operator
// to Stripe's dashboard instead of to this file. There is deliberately no third branch that
// verifies over something else. Do NOT loosen the check to make an event pass.

import { Resource } from 'harperdb'
import { db } from '../lib/db.js'
import { verifyStripeSignature, SIGNATURE_HEADER } from '../lib/stripe.js'
import { captureRawBody, rawBodyOf } from '../lib/raw-body.js'
import { json, pathFrom, headerOf } from '../lib/http.js'
import { refuseOnPreview } from '../lib/payments-support.js'
import { config } from '../lib/payments-config.js'

// AT MODULE SCOPE, because the body of request one is already gone by the time any handler could ask
// for it. Nothing branches on the status: `lib/raw-body.js` never throws, and an app whose Harper
// has no content-type registry must go on serving every other route while this endpoint refuses
// events exactly as it did before the capture existed. The log line is the only report there is, so
// it says what a reader has to do with it.
const CAPTURE = captureRawBody()
if (CAPTURE !== 'installed' && CAPTURE !== 'already installed') {
  console.error(`[stripe-webhook] the raw request body capture is ${CAPTURE} — Stripe's signature cannot be checked against the bytes it signed on this deployment, so every event will be refused 503 raw_body_unavailable`)
}

let handlerModule
async function loadHandler () {
  if (handlerModule !== undefined) return handlerModule
  try {
    const mod = await import('../lib/stripe-events.js')
    handlerModule = typeof mod.handleStripeEvent === 'function' ? mod : null
    if (!handlerModule) console.warn('[stripe-webhook] lib/stripe-events.js has no handleStripeEvent export — events will be REFUSED, not acked')
  } catch (err) {
    // Absent in the template; a generated app that bills has one. Latch either way — the
    // module graph does not heal between requests.
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') console.error('[stripe-webhook] lib/stripe-events.js failed to load:', err?.message ?? err)
    handlerModule = null
  }
  return handlerModule
}

/**
 * The bytes this request's signature was computed over, or `null` if they are not available.
 *
 * `null` is a refusal and never a licence to verify over something else.
 */
function rawBodyFrom (data) {
  // A STRING arrives when the sender declared a text media type: Harper's own `text/plain`
  // deserializer is `data.toString()`. Kept because it is correct, and because it is the one shape
  // a caller can hand this resource without the capture being in force.
  if (typeof data === 'string') return data
  // THE LIVE PATH. Stripe posts `application/json`, so the Buffer comes back from the capture.
  return rawBodyOf(data)
}

export class StripeWebhook extends Resource {
  static loadAsInstance = false

  async post (target, data) {
    target.checkPermission = false

    // REFUSED BY THE PREVIEW COPY. An inbound webhook's caller
    // is a third-party machine and never the person looking at their own build, so refusing it
    // at the public preview address costs a preview nothing and takes a surface off the internet —
    // enforced here rather than left to the convention that nobody registers this URL.
    const refused = refuseOnPreview(json, { error: 'Payment events are delivered to the live address, not to the preview.', code: 'webhook_not_on_preview' })
    if (refused) return refused
    if (pathFrom(target) !== '') return json({ error: 'not found' }, 404)

    const secret = config.stripe.webhookSecret()
    if (!secret) {
      console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set — refusing the event')
      return json({ error: 'webhook secret not configured' }, 503)
    }
    // The secret is checked FIRST on purpose: it is the half a user can fix, and reporting the
    // platform's gap ahead of it would hide a missing secret for as long as the gap lasts.
    const raw = rawBodyFrom(data)
    if (raw === null) {
      console.error('[stripe-webhook] this request\'s own bytes are not available, so Stripe\'s signature cannot be checked against what Stripe signed — refusing, and NOT reporting this as a bad signature (see the header)')
      return json({ error: 'raw request body unavailable', code: 'raw_body_unavailable' }, 503)
    }
    const check = verifyStripeSignature({ secret, header: headerOf(this, SIGNATURE_HEADER), body: raw })
    if (!check.ok) {
      console.warn(`[stripe-webhook] signature check failed: ${check.reason}`)
      return json({ error: 'invalid signature', reason: check.reason }, 403)
    }

    // PARSED FROM `raw`, NOT FROM `data`, even when the capture handed back bytes Harper had already
    // parsed. The document that was verified has to be the document that is acted on; taking the
    // event from a second derivation of the same bytes would make "what was signed" and "what ran"
    // two separate readings, which is the class of gap this whole file is about.
    const event = safeParse(typeof raw === 'string' ? raw : raw.toString('utf8'))
    if (!event?.id || !event?.type) return json({ error: 'missing event id or type' }, 400)

    if (await db.StripeEvent.get(event.id)) return json({ ok: true, duplicate: true })

    const handler = await loadHandler()
    if (!handler) {
      // REFUSED AND NOT LEDGERED, so the event stays at Stripe and a redelivery still finds nothing
      // here to short-circuit on. The header has the trade; what makes it the right one is that an
      // event arrives at all only if a webhook endpoint was deliberately registered, so reaching
      // this branch means payments were set up and the handler was never written.
      console.error(`[stripe-webhook] ${event.type} (${event.id}) REFUSED: this app has no lib/stripe-events.js, so there is nothing to turn this event into a membership. Stripe will retry; write that module (§3) and the retry applies it.`)
      return json({ error: 'no Stripe event handler in this app', code: 'no_event_handler' }, 503)
    }

    let outcome = 'applied'
    try {
      const result = await handler.handleStripeEvent(event)
      if (result === false) outcome = 'ignored'
    } catch (err) {
      // Neither ledgered NOR acked: Stripe retries on a non-2xx and stops on a 2xx (see the header).
      // The handler's own message is logged and NOT relayed — it is the app's code and may say
      // anything, and this endpoint is public.
      console.error(`[stripe-webhook] handler for ${event.type} threw:`, err?.stack ?? err)
      return json({ error: 'event handler failed', type: event.type }, 500)
    }
    await db.StripeEvent.put({ id: event.id, type: event.type, receivedAt: new Date().toISOString(), outcome })
    return json({ ok: true, type: event.type, outcome })
  }
}

// THE ONE CONVERSION LEFT, AND IT IS EXPLICIT ON PURPOSE. `JSON.parse` coerces a Buffer through
// `toString()` anyway, so this changes no behaviour — it makes the single utf8 decode visible in a
// file whose whole subject is that nothing may re-encode the body. It sits AFTER verification, so
// the signature was checked against the exact bytes and this is only how the verified document is
// read; an implicit coercion here would leave a reader working out whether that was still true.
function safeParse (s) { try { return JSON.parse(s) } catch { return null } }
