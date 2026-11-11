// SIGN-IN KIT — Resend send + suppression. One file so the question "may we email this
// person" has one answer and every sender — a generated loop, an admin composer, an
// invite — goes through it.
//
// Three properties, each pinned by webhooks-acceptance:
//   1. sendEmail() consults the suppression list BEFORE the provider, and FAILS CLOSED: a
//      read error answers "do not send".
//   2. A hard bounce or a complaint suppresses; a soft bounce is COUNTED, never acted on.
//      Suppressing wrongly silences a real customer permanently and invisibly; failing to
//      suppress costs one more bounce that shows up in the very stream this reads.
//   3. Suppression is one-way and idempotent: Resend retries anything it did not get a 2xx
//      for, and a second event of any kind cannot clear a suppression.

import crypto from 'node:crypto'
import { db } from './db.js'
import { config } from './sign-in-config.js'
import { normalizeEmail } from './auth.js'
import { publicBaseFor } from './sign-in-support.js'

// ── sending ────────────────────────────────────────────────────────────────────

/**
 * Send a transactional email through Resend. Never throws for a send failure: returns
 * `{ ok: false, error }` so the caller decides whether to surface it. With no RESEND_API_KEY
 * (local dev) it logs the message and returns `{ ok: true, skipped: true }`.
 *
 * `template` is a label for the EmailLog row (e.g. 'magic-link'); `force` skips the
 * suppression check and exists for exactly one caller class: a message the recipient asked
 * for this second (a sign-in link) where "we could not check the list" must not read as
 * "the link never came". Marketing-shaped sends never pass it.
 */
export async function sendEmail ({ to, subject, html, text, from, replyTo, headers, template = null, force = false }) {
  const recipient = normalizeEmail(to)
  if (!recipient) return { ok: false, error: 'no recipient' }
  const fromResolved = from ?? config.email.from()

  if (!force) {
    const sendability = await emailSendability(recipient)
    if (!sendability.ok) {
      console.warn(`[email] not sending to ${recipient}: ${sendability.reason}`)
      await logEmail({ to: recipient, subject, template, status: 'suppressed', error: sendability.reason })
      return { ok: false, skipped: true, suppressed: true, reason: sendability.reason }
    }
  }

  const apiKey = config.email.resendApiKey()
  if (!apiKey) {
    console.log(`[email] (would send) to=${recipient}\n  subject: ${subject}\n  from: ${fromResolved}${text ? `\n  ${text.split('\n').join('\n  ')}` : ''}`)
    await logEmail({ to: recipient, subject, template, status: 'skipped' })
    return { ok: true, skipped: true }
  }

  const payload = { from: fromResolved, to: recipient, subject, html, text }
  if (replyTo) payload.reply_to = replyTo
  if (headers) payload.headers = headers

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.error(`[email] send failed (${res.status}):`, body)
      await logEmail({ to: recipient, subject, template, status: 'failed', error: body?.message ?? `HTTP ${res.status}` })
      return { ok: false, error: body?.message ?? `HTTP ${res.status}`, status: res.status }
    }
    await logEmail({ to: recipient, subject, template, status: 'sent', providerId: body?.id ?? null })
    return { ok: true, id: body?.id }
  } catch (err) {
    console.error('[email] send threw:', err?.message ?? err)
    await logEmail({ to: recipient, subject, template, status: 'failed', error: err?.message ?? String(err) })
    return { ok: false, error: err?.message ?? String(err) }
  }
}

/** Best effort. A log write must never be the reason a send is reported as failed. */
async function logEmail ({ to, subject, template, status, providerId = null, error = null }) {
  try {
    await db.EmailLog.put({
      id: crypto.randomUUID(),
      to,
      subject: String(subject ?? '').slice(0, 500),
      template,
      status,
      providerId,
      error: error ? String(error).slice(0, 500) : null,
      sentAt: new Date().toISOString(),
    })
  } catch (err) {
    console.warn('[email] could not write EmailLog:', err?.message ?? err)
  }
}

/** Fetch the full body of a received inbound email by its Resend id. Null on any error. */
export async function fetchReceivedEmail (emailId) {
  const apiKey = config.email.resendApiKey()
  if (!apiKey || !emailId) return null
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) {
      console.error(`[email] fetch received failed (${res.status})`)
      return null
    }
    return await res.json()
  } catch (err) {
    console.error('[email] fetch received threw:', err?.message ?? err)
    return null
  }
}

/**
 * Base HTML envelope for every transactional email — one look without a templating
 * library. The builder's admin area edits copy, not this shell.
 */
export function emailShell ({ preheader = '', title, body }) {
  const p = normalizeForPreview(preheader)
  // A preheader that repeats the subject is hidden text for nothing, and hidden text is
  // scored by spam filters. Emit it only when it says something new.
  const preheaderDiv = p && p !== normalizeForPreview(title)
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>\n`
    : ''
  const name = config.appName()
  // PREVIEW-AWARE, so a footer link in an email sent from the preview copy returns to the preview
  // rather than to the live app (lib/copy.js).
  const origin = publicBaseFor(config.publicAppUrl())
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1917;">
${preheaderDiv}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;overflow:hidden;">
      <tr><td style="padding:24px 28px 0 28px;">
        <div style="font-size:18px;font-weight:700;color:#1c1917;">${escapeHtml(name)}</div>
      </td></tr>
      <tr><td style="padding:12px 28px 28px 28px;font-size:15px;line-height:1.55;color:#1c1917;">
        ${body}
      </td></tr>
    </table>
    <div style="color:#78716c;font-size:12px;margin-top:16px;">${escapeHtml(name)} · <a href="${escapeHtml(origin)}" style="color:#1c1917;">${escapeHtml(origin.replace(/^https?:\/\//, ''))}</a></div>
  </td></tr>
</table>
</body>
</html>`
}

function normalizeForPreview (s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function escapeHtml (s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// ── the suppression list ───────────────────────────────────────────────────────

/** `reason` values that mean suppressed. A row whose reason is none of these is not. */
export const SUPPRESSION_REASONS = Object.freeze(['hard_bounce', 'complaint'])

export const REASON_LABELS = Object.freeze({
  hard_bounce: 'that address bounced permanently',
  complaint: 'that person marked our email as spam',
  lookup_failed: 'we could not check the suppression list',
})

/**
 * May we send to this address? `{ ok, reason, detail }`; `reason` is one of
 * SUPPRESSION_REASONS or 'lookup_failed'. FAILS CLOSED on a read error.
 */
export async function emailSendability (email) {
  const norm = normalizeEmail(email)
  if (!norm) return { ok: false, reason: 'lookup_failed', detail: 'no address' }
  try {
    const row = await db.EmailSuppression.get(norm)
    if (row && SUPPRESSION_REASONS.includes(row.reason)) return { ok: false, reason: row.reason, detail: row.detail ?? null }
    return { ok: true, reason: null, detail: null }
  } catch (err) {
    console.warn(`[suppression] lookup failed, treating as suppressed: ${err?.message ?? err}`)
    return { ok: false, reason: 'lookup_failed', detail: null }
  }
}

export async function isEmailSuppressed (email) {
  return !(await emailSendability(email)).ok
}

// ── Resend delivery events (pure classification) ───────────────────────────────

export const HANDLED_EVENTS = Object.freeze(['email.bounced', 'email.complained'])

// SES bounce subtypes that are permanent whatever `type` says — used ONLY when Resend omits
// `bounce.type`. `General` is deliberately absent: it appears under both Permanent and
// Transient, and reading it as permanent would suppress full mailboxes.
const PERMANENT_SUBTYPES = Object.freeze(new Set(['noemail', 'suppressed', 'onaccountsuppressionlist']))

function normalizeAddress (value) {
  const s = String(value ?? '').trim().toLowerCase()
  if (!s) return null
  const angled = s.match(/<([^>]+)>/)
  return (angled ? angled[1] : s).trim() || null
}

/** Every recipient the event names. Resend sends `to` as an array; older payloads a string. */
export function recipientsOf (payload) {
  const to = payload?.data?.to ?? payload?.data?.email ?? null
  const list = Array.isArray(to) ? to : [to]
  const seen = new Set()
  for (const entry of list) {
    const addr = normalizeAddress(entry)
    if (addr) seen.add(addr)
  }
  return [...seen]
}

/**
 * What a Resend delivery webhook means. PURE: no DB, no network, no clock.
 * Returns null for "not ours to act on" — delivered, opened, unknown, or no recipient.
 */
export function classifyDeliveryEvent (payload) {
  const type = String(payload?.type ?? '')
  if (!HANDLED_EVENTS.includes(type)) return null
  const emails = recipientsOf(payload)
  if (!emails.length) return null
  const occurredAt = typeof payload?.created_at === 'string' ? payload.created_at
    : (typeof payload?.data?.created_at === 'string' ? payload.data.created_at : null)

  if (type === 'email.complained') {
    // At least as final as a hard bounce: someone told their provider our mail is spam, and
    // continuing to send is the most damaging thing a young domain can do to itself.
    return { type, verdict: 'suppress', reason: 'complaint', emails, bounceType: null, bounceSubType: null, detail: str(payload?.data?.complaint?.message), occurredAt }
  }
  const bounce = payload?.data?.bounce ?? {}
  const bounceType = str(bounce.type)
  const bounceSubType = str(bounce.subType ?? bounce.sub_type)
  const hard = bounceType
    ? bounceType.toLowerCase() === 'permanent'
    : PERMANENT_SUBTYPES.has(String(bounceSubType ?? '').toLowerCase())
  return { type, verdict: hard ? 'suppress' : 'soft', reason: hard ? 'hard_bounce' : null, emails, bounceType, bounceSubType, detail: str(bounce.message), occurredAt }
}

function str (v) {
  const s = typeof v === 'string' ? v.trim() : ''
  return s ? s.slice(0, 500) : null
}

/**
 * Write what a delivery event told us onto the address's row. Idempotent and ONE-WAY: the
 * first suppressing reason and its timestamp are kept forever; a later soft bounce only
 * increments `softBounceCount`. `skipped: 'read-failed'` means nothing was written because
 * the existing row could not be read — the caller answers non-2xx so Resend redelivers.
 */
export async function recordDeliveryEvent (email, decision, now = new Date()) {
  const norm = normalizeEmail(email)
  if (!norm) throw new Error('recordDeliveryEvent: no address')
  const at = decision?.occurredAt ?? now.toISOString()
  const suppressing = decision?.verdict === 'suppress'

  // Read by SEARCH, not get(): a search yields zero rows for a missing key and throws only
  // on a real failure, so "no row" and "could not read" stay distinguishable. On a failed
  // read `existing` would be null and a soft bounce would overwrite a hard_bounce with
  // `reason: null` — silently un-suppressing a complainant.
  let existing = null
  try {
    for await (const row of db.EmailSuppression.search({ conditions: [{ attribute: 'email', value: norm }], limit: 1 })) existing = row
  } catch (err) {
    console.warn(`[suppression] could not read the existing row for a delivery event: ${err?.message ?? err}`)
    return { email: norm, suppressed: null, changed: false, reason: null, skipped: 'read-failed' }
  }

  const alreadySuppressed = !!existing && SUPPRESSION_REASONS.includes(existing.reason)
  const diagnostics = alreadySuppressed
    ? { bounceType: existing.bounceType ?? null, bounceSubType: existing.bounceSubType ?? null, detail: existing.detail ?? null }
    : suppressing
      ? { bounceType: decision.bounceType ?? null, bounceSubType: decision.bounceSubType ?? null, detail: decision.detail ?? null }
      : { bounceType: decision.bounceType ?? existing?.bounceType ?? null, bounceSubType: decision.bounceSubType ?? existing?.bounceSubType ?? null, detail: decision.detail ?? existing?.detail ?? null }

  const row = {
    id: norm,
    email: norm,
    reason: alreadySuppressed ? existing.reason : (suppressing ? decision.reason : (existing?.reason ?? null)),
    suppressedAt: alreadySuppressed ? existing.suppressedAt : (suppressing ? at : (existing?.suppressedAt ?? null)),
    firstSeenAt: existing?.firstSeenAt ?? at,
    lastEventAt: at,
    ...diagnostics,
    softBounceCount: (existing?.softBounceCount ?? 0) + (suppressing ? 0 : 1),
    source: 'resend-webhook',
  }
  await db.EmailSuppression.put(row)
  return { email: norm, suppressed: SUPPRESSION_REASONS.includes(row.reason), changed: !alreadySuppressed && suppressing, reason: row.reason }
}

// ── svix (Resend) webhook signatures ───────────────────────────────────────────

/**
 * Standard svix signing: `${id}.${timestamp}.${body}` HMAC-SHA256 with the secret decoded
 * from base64 after the `whsec_` prefix; the header lists `v1,<base64>` pairs and any one
 * matching passes; the timestamp must be within 5 minutes (replay guard).
 */
export function verifySvixSignature ({ secret, id, timestamp, signature, body, now = Date.now() }) {
  if (!secret) return { ok: false, reason: 'no secret configured' }
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing signing headers' }
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' }
  if (Math.abs(Math.floor(now / 1000) - ts) > 300) return { ok: false, reason: 'stale (>5min)' }
  const keyRaw = String(secret).startsWith('whsec_') ? String(secret).slice(6) : String(secret)
  let key
  try { key = Buffer.from(keyRaw, 'base64') } catch { return { ok: false, reason: 'bad secret encoding' } }
  const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')
  for (const part of String(signature).split(' ')) {
    const [version, sig] = part.split(',')
    if (version !== 'v1' || !sig) continue
    const a = Buffer.from(sig, 'base64')
    const b = Buffer.from(expected, 'base64')
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { ok: true }
  }
  return { ok: false, reason: 'no matching v1 signature' }
}
