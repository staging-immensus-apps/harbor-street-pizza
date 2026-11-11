#!/usr/bin/env node
// GENERATED — admin-only shop settings, as a functional probe over resources/StoreSettingsApi.js.
// Anonymous, a member and a deactivated admin are all refused with 403/auth_required and no
// WWW-Authenticate, and none of that touches the StoreSetting table. A real admin reads built-in
// defaults before anything is saved, a bad PUT changes nothing, a valid PUT creates exactly one
// row keyed by the fixed id regardless of what the body names, postcodes come back normalised
// and deduplicated, a second save updates that same row, and lastDetailsClearedAt reads the
// newest FINISHED clear-personal-details LoopRun row and ignores a newer unfinished one.
//
// Hermetic: clock frozen, no network, no git.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { freezeClock } from './probe/frozen-clock.js'
freezeClock()
process.env.SESSION_SECRET = 'suite-secret-not-a-real-one'
process.env.IMMENSUS_TIER = 'builder'

const { checker } = await import('./probe/harness.js')
const { tables, resetTables } = await import('./probe/harperdb-stub.js')
const { call, userWithCookie, transcript, responseRulesVerdict } = await import('./probe/resource-call.js')
const { StoreSettingsApi } = await import('../resources/StoreSettingsApi.js')

const { check, section, done, failures } = checker('StoreSettingsApi-probe')

resetTables()
const ADMIN = await userWithCookie('owner@example.test', { role: 'admin' })
const MEMBER = await userWithCookie('member@example.test')
const GONE = await userWithCookie('gone@example.test', { role: 'admin', deactivatedAt: '2026-06-01T00:00:00.000Z' })

section('anonymous, a member, and a deactivated admin are all refused')
for (const [m, body] of [['GET', undefined], ['PUT', { deliveryFeeCents: 500 }]]) {
  const anon = await call(StoreSettingsApi, m, '', { body })
  check(`${m} anonymous → 403 auth_required, no WWW-Authenticate`, anon.status === 403 && anon.json?.code === 'auth_required' && !anon.headers.get('www-authenticate'))
  const member = await call(StoreSettingsApi, m, '', { cookie: MEMBER.cookie, body })
  check(`${m} a member → 403 admin_required, no WWW-Authenticate`, member.status === 403 && member.json?.code === 'admin_required' && !member.headers.get('www-authenticate'))
  const gone = await call(StoreSettingsApi, m, '', { cookie: GONE.cookie, body })
  check(`${m} a deactivated admin with a live cookie → 403 (the row is re-read)`, gone.status === 403 && gone.json?.code === 'admin_required')
}
check('none of that wrote or changed a StoreSetting row (NEG)', tables.StoreSetting.rows.size === 0)

section('a sub-path is not found, even for the admin')
{
  const g = await call(StoreSettingsApi, 'GET', 'x', { cookie: ADMIN.cookie })
  check('GET /StoreSettingsApi/x → 404', g.status === 404)
  const p = await call(StoreSettingsApi, 'PUT', 'x', { cookie: ADMIN.cookie, body: { deliveryFeeCents: 1 } })
  check('PUT /StoreSettingsApi/x → 404', p.status === 404)
  check('…and still no row', tables.StoreSetting.rows.size === 0)
}

section('GET before any save answers the built-in defaults')
{
  const r = await call(StoreSettingsApi, 'GET', '', { cookie: ADMIN.cookie })
  check('200, saved: false, and no cleared date (no LoopRun yet either)', r.status === 200 && r.json?.settings?.saved === false && r.json?.lastDetailsClearedAt === null)
}

section('a bad PUT is refused and changes nothing')
{
  const noPostcodes = await call(StoreSettingsApi, 'PUT', '', { cookie: ADMIN.cookie, body: { pickupEnabled: true, deliveryEnabled: true, deliveryPostcodes: [] } })
  check('delivery on with an empty postcode list → 400 (NEG)', noPostcodes.status === 400)
  const floatFee = await call(StoreSettingsApi, 'PUT', '', { cookie: ADMIN.cookie, body: { pickupEnabled: true, deliveryFeeCents: 4.5 } })
  check('a non-integer fee → 400 (NEG)', floatFee.status === 400)
  const negFee = await call(StoreSettingsApi, 'PUT', '', { cookie: ADMIN.cookie, body: { pickupEnabled: true, deliveryFeeCents: -1 } })
  check('a negative fee → 400 (NEG)', negFee.status === 400)
  const zeroEstimate = await call(StoreSettingsApi, 'PUT', '', { cookie: ADMIN.cookie, body: { pickupEnabled: true, pickupEstimateMinutes: 0 } })
  check('an estimate of 0 → 400 (NEG)', zeroEstimate.status === 400)
  const bigEstimate = await call(StoreSettingsApi, 'PUT', '', { cookie: ADMIN.cookie, body: { pickupEnabled: true, pickupEstimateMinutes: 181 } })
  check('an estimate of 181 → 400 (NEG)', bigEstimate.status === 400)
  check('none of those wrote a row', tables.StoreSetting.rows.size === 0)
}

section('a valid PUT creates exactly one row, keyed by the fixed id, postcodes normalised')
{
  const r = await call(StoreSettingsApi, 'PUT', '', {
    cookie: ADMIN.cookie,
    body: {
      id: 'other',
      storeName: 'Test Pizza',
      acceptingOrders: true,
      pausedMessage: '',
      pickupEnabled: true,
      deliveryEnabled: true,
      deliveryFeeCents: 500,
      deliveryPostcodes: [' n17 ', 'n17', 'E1 '],
      pickupEstimateMinutes: 20,
      deliveryEstimateMinutes: 40,
    },
  })
  check('200 and saved settings come back', r.status === 200 && r.json?.settings?.storeName === 'Test Pizza')
  check('an id in the body is ignored: exactly one row, keyed "store" (NEG)', tables.StoreSetting.rows.size === 1 && tables.StoreSetting.rows.has('store') && !tables.StoreSetting.rows.has('other'))
  const postcodes = r.json?.settings?.deliveryPostcodes ?? []
  check('postcodes are trimmed, upper-cased and deduplicated', postcodes.includes('N17') && postcodes.includes('E1') && postcodes.length === 2)
}

section('a second PUT updates the same row rather than adding one')
{
  const r = await call(StoreSettingsApi, 'PUT', '', {
    cookie: ADMIN.cookie,
    body: {
      storeName: 'Test Pizza',
      pickupEnabled: true,
      deliveryEnabled: true,
      deliveryFeeCents: 600,
      deliveryPostcodes: ['N17'],
      pickupEstimateMinutes: 20,
      deliveryEstimateMinutes: 40,
    },
  })
  check('200, the fee changed', r.status === 200 && r.json?.settings?.deliveryFeeCents === 600)
  check('still exactly one row (NEG)', tables.StoreSetting.rows.size === 1)
}

section('lastDetailsClearedAt reads the newest FINISHED LoopRun, never an unfinished one')
{
  await tables.LoopRun.put({ id: 'r1', loop: 'clear-personal-details', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', outcome: 'ok' })
  await tables.LoopRun.put({ id: 'r2', loop: 'clear-personal-details', startedAt: '2026-02-01T00:00:00.000Z', finishedAt: '2026-02-01T00:01:00.000Z', outcome: 'ok' })
  await tables.LoopRun.put({ id: 'r3', loop: 'clear-personal-details', startedAt: '2026-03-01T00:00:00.000Z', finishedAt: null, outcome: 'ok' })
  const r = await call(StoreSettingsApi, 'GET', '', { cookie: ADMIN.cookie })
  check('the newest FINISHED row is returned', r.json?.lastDetailsClearedAt === '2026-02-01T00:01:00.000Z')
  check('…and not the unfinished, later-started row (NEG)', r.json?.lastDetailsClearedAt !== '2026-03-01T00:00:00.000Z' && r.json?.lastDetailsClearedAt !== null)
  check('…this resource never writes LoopRun', tables.LoopRun.rows.size === 3)
}

section('a demoted admin with an unexpired cookie is refused (the row is re-read, not the token)')
{
  await tables.User.put({ ...ADMIN.user, role: 'member' })
  const r = await call(StoreSettingsApi, 'GET', '', { cookie: ADMIN.cookie })
  check('demoted admin → 403 admin_required', r.status === 403 && r.json?.code === 'admin_required')
  await tables.User.put({ ...ADMIN.user, role: 'admin' })
  const restored = await call(StoreSettingsApi, 'GET', '', { cookie: ADMIN.cookie })
  check('…and works again once restored (NEG)', restored.status === 200)
}

section(`the rule-20 sweep over every response (${transcript.length})`)
{
  const synthetic = [{ cls: 'X', method: 'GET', pathname: '', status: 401, headers: new Headers({ 'cache-control': 'no-store' }) }]
  check('the sweep catches a 401 (NEG)', responseRulesVerdict(synthetic).some((b) => b.includes('401')))
  const bad = responseRulesVerdict(transcript)
  check('no 401, no WWW-Authenticate on a 403, everything no-store', bad.length === 0, bad.slice(0, 3).join(' | '))
}
process.exit(done())
