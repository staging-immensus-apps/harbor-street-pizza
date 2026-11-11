// SIGN-IN KIT — Resend's webhook: delivery events and inbound mail, svix verified
//
//   POST /InboundEmailApi/webhook   svix-signed Resend event
//
// Two kinds of event, one endpoint, one signature check:
//   email.bounced / email.complained  → the suppression list (lib/email.js). 200 only when
//                                       every recipient's event was recorded; 503 otherwise
//                                       so Resend redelivers rather than losing the event.
//   email.received                    → inbound mail. The payload is metadata; the body is
//                                       fetched from Resend and handed to the GENERATED
//                                       `lib/inbound-email.js` (`handleInboundEmail`) when
//                                       the app has one, else acked and ignored.
// Anything else (sent, delivered, opened) is acked so Resend stops retrying.
//
// No RESEND_WEBHOOK_SECRET → every post is REFUSED (503). The endpoint is public by
// nature; the signature is the only thing standing between it and anyone with curl.

import { Resource } from 'harperdb'
import { verifySvixSignature, classifyDeliveryEvent, recordDeliveryEvent, fetchReceivedEmail } from '../lib/email.js'
import { json, pathFrom, headerOf } from '../lib/http.js'
import { refuseOnPreview } from '../lib/sign-in-support.js'
import { config } from '../lib/sign-in-config.js'

let inboundModule
async function loadInbound () {
  if (inboundModule !== undefined) return inboundModule
  try {
    const mod = await import('../lib/inbound-email.js')
    inboundModule = typeof mod.handleInboundEmail === 'function' ? mod : null
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') console.error('[inbound-webhook] lib/inbound-email.js failed to load:', err?.message ?? err)
    inboundModule = null
  }
  return inboundModule
}

export class InboundEmailApi extends Resource {
  static loadAsInstance = false

  async post (target, data) {
    target.checkPermission = false

    // REFUSED BY THE PREVIEW COPY. An inbound webhook's caller
    // is a third-party machine and never the person looking at their own build, so refusing it
    // at the public preview address costs a preview nothing and takes a surface off the internet —
    // enforced here rather than left to the convention that nobody registers this URL.
    const refused = refuseOnPreview(json, { error: 'Mail events are delivered to the live address, not to the preview.', code: 'webhook_not_on_preview' })
    if (refused) return refused
    if (pathFrom(target) !== 'webhook') return json({ error: 'not found' }, 404)

    const secret = config.email.webhookSecret()
    if (!secret) {
      console.error('[inbound-webhook] RESEND_WEBHOOK_SECRET is not set — refusing the event')
      return json({ error: 'webhook secret not configured' }, 503)
    }
    const rawBody = typeof data === 'string' ? data : JSON.stringify(data ?? {})
    const check = verifySvixSignature({
      secret,
      id: headerOf(this, 'svix-id'),
      timestamp: headerOf(this, 'svix-timestamp'),
      signature: headerOf(this, 'svix-signature'),
      body: rawBody,
    })
    if (!check.ok) {
      console.warn(`[inbound-webhook] signature check failed: ${check.reason}`)
      return json({ error: 'invalid signature', reason: check.reason }, 403)
    }

    const payload = typeof data === 'string' ? safeParse(data) : (data ?? {})

    const delivery = classifyDeliveryEvent(payload)
    if (delivery) return this.recordDelivery(delivery)

    if (payload?.type !== 'email.received') return json({ ok: true, ignored: payload?.type ?? null })

    const emailId = payload?.data?.email_id
    if (!emailId) return json({ error: 'missing email_id' }, 400)
    const inbound = await loadInbound()
    if (!inbound) return json({ ok: true, ignored: 'email.received' })
    const full = await fetchReceivedEmail(emailId)
    if (!full) {
      // 200 so Resend does not retry forever for a permanently broken fetch; already logged.
      return json({ ok: true, error: 'fetch failed' })
    }
    try {
      const result = await inbound.handleInboundEmail({ receivedEmail: full, resendEmailId: emailId })
      return json({ ok: true, ...(result && typeof result === 'object' ? result : {}) })
    } catch (err) {
      console.error('[inbound-webhook] handler threw:', err?.stack ?? err)
      return json({ ok: true, error: err?.message ?? String(err) })
    }
  }

  /** One event can name several recipients; each is recorded independently. */
  async recordDelivery (delivery) {
    let recorded = 0
    let suppressed = 0
    let unrecorded = 0
    for (const email of delivery.emails) {
      try {
        const result = await recordDeliveryEvent(email, delivery)
        if (result.skipped === 'read-failed') { unrecorded++; continue }
        recorded++
        if (result.suppressed) suppressed++
        // Loud on the TRANSITION only: a retried webhook must not read like a second complaint.
        if (result.changed) console.warn(`[delivery] suppressing ${result.email}: ${result.reason} (${delivery.type})`)
      } catch (err) {
        unrecorded++
        console.error(`[delivery] could not record ${delivery.type} for an address: ${err?.message ?? err}`)
      }
    }
    return json({ ok: unrecorded === 0, event: delivery.type, verdict: delivery.verdict, recorded, suppressed, unrecorded }, unrecorded ? 503 : 200)
  }
}

function safeParse (s) { try { return JSON.parse(s) } catch { return null } }
