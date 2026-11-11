#!/usr/bin/env node
// THE SIGN-IN KIT'S MAIL — drives resources/InboundEmailApi.js through the stub runtime, and
// lib/email.js's suppression list with it:
//   - the endpoint REFUSES without a secret (503) and on a bad or stale signature (403)
//   - a hard bounce or complaint suppresses; a soft bounce only counts; suppression is one-way;
//     sendEmail() honours the list and FAILS CLOSED when it cannot read it
//
// Copied into an app with the rest of the sign-in kit when a plan says people sign in.
// It was the mail half of `webhooks-acceptance`; the Stripe half is the payments
// kit's `stripe-webhook-acceptance`.
//
// The svix signer is an independent implementation (scripts/probe/svix-sign.js), so the verifier is
// proven against a well-formed signature rather than against its own output. Hermetic: frozen clock
// (signature tolerance is measured against it), no network, no git.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { freezeClock } from './probe/frozen-clock.js'
const NOW = freezeClock()

const RESEND_SECRET = 'whsec_' + Buffer.from('suite-resend-secret-bytes-not-real').toString('base64')
process.env.RESEND_WEBHOOK_SECRET = RESEND_SECRET
delete process.env.RESEND_API_KEY

const { checker } = await import('./probe/harness.js')
const { tables, resetTables } = await import('./probe/harperdb-stub.js')
const { signSvix } = await import('./probe/svix-sign.js')
const { InboundEmailApi } = await import('../resources/InboundEmailApi.js')
const { sendEmail, emailSendability } = await import('../lib/email.js')

const { check, section, done } = checker('inbound-email-acceptance')

async function post (Cls, pathname, body, headers = {}) {
  const r = new Cls()
  r._context = { headers: new Headers(headers), url: `/${Cls.name}/${pathname}` }
  const res = await r.post({ pathname }, body)
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers }
}

resetTables()

section('InboundEmailApi: signature')
{
  const body = JSON.stringify({ type: 'email.bounced', data: { to: ['Dead@Example.test'], bounce: { type: 'Permanent', subType: 'General', message: 'no such user' } } })
  const ts = String(Math.floor(NOW / 1000))
  const good = signSvix({ secret: RESEND_SECRET, id: 'msg_1', timestamp: ts, body })
  const secret = process.env.RESEND_WEBHOOK_SECRET
  process.env.RESEND_WEBHOOK_SECRET = ''
  check('with no RESEND_WEBHOOK_SECRET the event is REFUSED (503)', (await post(InboundEmailApi, 'webhook', body, good)).status === 503)
  process.env.RESEND_WEBHOOK_SECRET = secret
  check('an unsigned event → 403 (NEG)', (await post(InboundEmailApi, 'webhook', body)).status === 403)
  const bad = signSvix({ secret: 'whsec_' + Buffer.from('other').toString('base64'), id: 'msg_1', timestamp: ts, body })
  check('a signature under another secret → 403 (NEG)', (await post(InboundEmailApi, 'webhook', body, bad)).status === 403)
  const stale = signSvix({ secret: RESEND_SECRET, id: 'msg_1', timestamp: String(Math.floor(NOW / 1000) - 600), body })
  check('a stale svix timestamp → 403 (NEG)', (await post(InboundEmailApi, 'webhook', body, stale)).status === 403)
  check('a wrong sub-path → 404', (await post(InboundEmailApi, 'nope', body, good)).status === 404)
}

section('InboundEmailApi: the suppression list')
const signed = (payload, id = 'msg_x') => {
  const body = JSON.stringify(payload)
  return [body, signSvix({ secret: RESEND_SECRET, id, timestamp: String(Math.floor(NOW / 1000)), body })]
}
{
  const hard = await post(InboundEmailApi, 'webhook', ...signed({ type: 'email.bounced', data: { to: ['Dead@Example.test'], bounce: { type: 'Permanent', subType: 'General', message: 'no such user' } } }))
  check('a permanent bounce → 200, one address suppressed', hard.status === 200 && hard.json?.suppressed === 1)
  const row = await tables.EmailSuppression.get('dead@example.test')
  check('the row is keyed by the normalized address with reason hard_bounce', row?.reason === 'hard_bounce' && row?.suppressedAt && row?.softBounceCount === 0)
  const soft = await post(InboundEmailApi, 'webhook', ...signed({ type: 'email.bounced', data: { to: ['dead@example.test'], bounce: { type: 'Transient', subType: 'MailboxFull' } } }))
  const after = await tables.EmailSuppression.get('dead@example.test')
  check('a later soft bounce cannot clear it (one-way) and only counts', soft.status === 200 && after.reason === 'hard_bounce' && after.softBounceCount === 1 && after.detail === 'no such user')
  await post(InboundEmailApi, 'webhook', ...signed({ type: 'email.bounced', data: { to: ['Full@Example.test'], bounce: { type: 'Transient', subType: 'MailboxFull' } } }))
  const full = await tables.EmailSuppression.get('full@example.test')
  check('a soft bounce on a clean address does NOT suppress (NEG)', full && full.reason === null && full.softBounceCount === 1 && (await emailSendability('full@example.test')).ok === true)
  const complaint = await post(InboundEmailApi, 'webhook', ...signed({ type: 'email.complained', data: { to: ['Angry@Example.test'], complaint: { message: 'spam' } } }))
  check('a complaint suppresses', complaint.json?.suppressed === 1 && (await tables.EmailSuppression.get('angry@example.test'))?.reason === 'complaint')
  const untyped = await post(InboundEmailApi, 'webhook', ...signed({ type: 'email.bounced', data: { to: ['Gone@Example.test'], bounce: { subType: 'NoEmail' } } }))
  check('an untyped bounce with an unambiguous permanent subtype suppresses', untyped.json?.suppressed === 1)
  const general = await post(InboundEmailApi, 'webhook', ...signed({ type: 'email.bounced', data: { to: ['Maybe@Example.test'], bounce: { subType: 'General' } } }))
  check('an untyped General bounce is SOFT — never guess a customer dead (NEG)', general.json?.suppressed === 0)
  const delivered = await post(InboundEmailApi, 'webhook', ...signed({ type: 'email.delivered', data: { to: ['ok@example.test'] } }))
  check('email.delivered is acked and ignored', delivered.status === 200 && delivered.json?.ignored === 'email.delivered')
  const received = await post(InboundEmailApi, 'webhook', ...signed({ type: 'email.received', data: { email_id: 'em_1' } }))
  check('email.received with no lib/inbound-email.js is acked and ignored (no Resend call)', received.status === 200 && received.json?.ignored === 'email.received')
  const noRecipient = await post(InboundEmailApi, 'webhook', ...signed({ type: 'email.bounced', data: {} }))
  check('a bounce naming no recipient is acked, not errored', noRecipient.status === 200)
}

section('sendEmail honours the list')
{
  const blocked = await sendEmail({ to: 'dead@example.test', subject: 'hi', text: 'x', template: 't' })
  check('a suppressed address is not sent to', blocked.ok === false && blocked.suppressed === true && blocked.reason === 'hard_bounce')
  check('…and the refusal is logged', [...tables.EmailLog.rows.values()].some((l) => l.to === 'dead@example.test' && l.status === 'suppressed'))
  const logged = await sendEmail({ to: 'Clean@Example.test', subject: 'hi', text: 'x', template: 't' })
  check('a clean address with no RESEND_API_KEY is logged as skipped (nothing leaves)', logged.ok === true && logged.skipped === true && [...tables.EmailLog.rows.values()].some((l) => l.to === 'clean@example.test' && l.status === 'skipped'))
  const forced = await sendEmail({ to: 'dead@example.test', subject: 'link', text: 'x', template: 'magic-link', force: true })
  check('force: true skips the list (a sign-in link the person just asked for)', forced.ok === true && forced.skipped === true)
  const realGet = tables.EmailSuppression.get
  tables.EmailSuppression.get = async () => { throw new Error('read failed') }
  const closed = await emailSendability('anyone@example.test')
  check('a suppression-list read failure FAILS CLOSED (lookup_failed)', closed.ok === false && closed.reason === 'lookup_failed')
  tables.EmailSuppression.get = realGet
  const realSearch = tables.EmailSuppression.search
  tables.EmailSuppression.search = () => { throw new Error('read failed') }
  const deferred = await post(InboundEmailApi, 'webhook', ...signed({ type: 'email.bounced', data: { to: ['x@example.test'], bounce: { type: 'Permanent' } } }))
  check('a delivery event whose row cannot be read → 503 so Resend redelivers (nothing written)', deferred.status === 503 && deferred.json?.unrecorded === 1 && !(await tables.EmailSuppression.rows.get('x@example.test')))
  tables.EmailSuppression.search = realSearch
}
check('the clock was frozen throughout', Date.now() === NOW)
process.exit(done())
