#!/usr/bin/env node
// GENERATED — resources/StoreInfoApi.js is public and read-only, so there is no owner-scope suite
// here (CLAUDE.md back-end charter). What has to hold instead: it never 404s even with no
// StoreSetting row at all (the published app's first minute), it falls back to STORE_DEFAULTS field
// by field rather than returning a stored null or garbage value, it returns NOTHING outside
// publicStoreInfo()'s fixed key set (checked structurally and self-tested against a synthetic leak),
// it needs no cookie, and a sub-path is 404.
//
// Hermetic: clock frozen, no network, no git.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { freezeClock } from './probe/frozen-clock.js'
freezeClock()
process.env.SESSION_SECRET = 'suite-secret-not-a-real-one'

const { checker } = await import('./probe/harness.js')
const { tables, resetTables } = await import('./probe/harperdb-stub.js')
const { call, transcript, responseRulesVerdict } = await import('./probe/resource-call.js')
const { StoreInfoApi } = await import('../resources/StoreInfoApi.js')
const { STORE_ID, STORE_DEFAULTS } = await import('../lib/shop.js')

const { check, section, done, failures } = checker('StoreInfoApi-probe')

/** The exact key set publicStoreInfo() is allowed to emit. */
const ALLOWED_KEYS = [
  'storeName', 'acceptingOrders', 'pausedMessage', 'pickupEnabled', 'deliveryEnabled',
  'deliveryFeeCents', 'deliveryPostcodes', 'pickupEstimateMinutes', 'deliveryEstimateMinutes',
]

/** Keys present on `obj` that are not in the allowed list — the leak check. */
function leakyKeys (obj) {
  return Object.keys(obj ?? {}).filter((k) => !ALLOWED_KEYS.includes(k))
}

section('negative control: the leak check can say yes')
check('a clean object leaks nothing', leakyKeys({ storeName: 'x', acceptingOrders: true }).length === 0)
check('a synthetic object carrying customerPhone is caught (NEG)', leakyKeys({ storeName: 'x', customerPhone: '0123' }).includes('customerPhone'))
if (failures.length) process.exit(done())

resetTables()

section('no StoreSetting row at all — the published app\'s first minute')
{
  const r = await call(StoreInfoApi, 'GET', '')
  check('answers 200, not 404', r.status === 200)
  const store = r.json?.store
  check('carries the single "store" key and nothing else at the top level', r.json && Object.keys(r.json).length === 1 && 'store' in r.json)
  check('every default from STORE_DEFAULTS is present verbatim', store
    && store.acceptingOrders === STORE_DEFAULTS.acceptingOrders
    // publicStoreInfo nulls pausedMessage out while accepting orders (STORE_DEFAULTS.acceptingOrders
    // is true), so the default-accepting state is null here and the message itself is asserted
    // separately below, once paused.
    && store.pausedMessage === null
    && store.pickupEnabled === STORE_DEFAULTS.pickupEnabled
    && store.deliveryEnabled === STORE_DEFAULTS.deliveryEnabled
    && store.deliveryFeeCents === STORE_DEFAULTS.deliveryFeeCents
    && Array.isArray(store.deliveryPostcodes) && store.deliveryPostcodes.length === STORE_DEFAULTS.deliveryPostcodes.length
    && store.pickupEstimateMinutes === STORE_DEFAULTS.pickupEstimateMinutes
    && store.deliveryEstimateMinutes === STORE_DEFAULTS.deliveryEstimateMinutes)
  check('storeName falls back to something non-blank (the app name)', typeof store?.storeName === 'string' && store.storeName.length > 0)
  check('no key outside the allowed list', leakyKeys(store).length === 0, leakyKeys(store).join(', '))
}

section('a saved row — the stored values are returned')
{
  await tables.StoreSetting.put({
    id: STORE_ID,
    storeName: 'Ada\'s Pizza',
    acceptingOrders: false,
    pausedMessage: 'Back at 5pm',
    pickupEnabled: true,
    deliveryEnabled: true,
    deliveryFeeCents: 250,
    deliveryPostcodes: ['N17', 'E20AB'],
    pickupEstimateMinutes: 15,
    deliveryEstimateMinutes: 30,
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  const r = await call(StoreInfoApi, 'GET', '')
  const store = r.json?.store
  check('200 with the saved values', r.status === 200
    && store.storeName === 'Ada\'s Pizza'
    && store.acceptingOrders === false
    && store.pausedMessage === 'Back at 5pm'
    && store.pickupEnabled === true
    && store.deliveryEnabled === true
    && store.deliveryFeeCents === 250
    && store.deliveryEstimateMinutes === 30)
  check('postcodes come back normalized, as lib/shop.js stores them', Array.isArray(store.deliveryPostcodes) && store.deliveryPostcodes.length === 2)
  check('acceptingOrders is false, so pausedMessage is the owner\'s own text', store.pausedMessage === 'Back at 5pm')
  await tables.StoreSetting.put({ ...(await tables.StoreSetting.get(STORE_ID)), acceptingOrders: true })
  const r2 = await call(StoreInfoApi, 'GET', '')
  check('once accepting again, pausedMessage is null (publicStoreInfo nulls it out)', r2.json?.store?.pausedMessage === null)
}

section('a null or garbage deliveryFeeCents falls back to the default')
{
  const bad = { id: STORE_ID, storeName: 'Ada\'s Pizza', deliveryFeeCents: null }
  await tables.StoreSetting.put(bad)
  check('PRECONDITION: the fixture really carries the bad value (NEG)', (await tables.StoreSetting.get(STORE_ID)).deliveryFeeCents === null)
  const r = await call(StoreInfoApi, 'GET', '')
  check('the response falls back to STORE_DEFAULTS.deliveryFeeCents rather than returning null', r.status === 200 && r.json?.store?.deliveryFeeCents === STORE_DEFAULTS.deliveryFeeCents)

  await tables.StoreSetting.put({ id: STORE_ID, storeName: 'Ada\'s Pizza', deliveryFeeCents: 'garbage', pickupEstimateMinutes: -5, deliveryPostcodes: 'not-an-array' })
  const r2 = await call(StoreInfoApi, 'GET', '')
  check('a non-integer fee, an out-of-range estimate and a non-array postcode list all fall back to defaults', r2.status === 200
    && r2.json?.store?.deliveryFeeCents === STORE_DEFAULTS.deliveryFeeCents
    && r2.json?.store?.pickupEstimateMinutes === STORE_DEFAULTS.pickupEstimateMinutes
    && Array.isArray(r2.json?.store?.deliveryPostcodes) && r2.json.store.deliveryPostcodes.length === 0)
  check('no key outside the allowed list, even on the garbage row', leakyKeys(r2.json?.store).length === 0)
}

section('no cookie needed; a sub-path is 404')
{
  const anon = await call(StoreInfoApi, 'GET', '')
  check('anonymous (no cookie at all) still gets 200 — this is public', anon.status === 200)
  const sub = await call(StoreInfoApi, 'GET', 'extra')
  check('a sub-path is 404', sub.status === 404)
  const deep = await call(StoreInfoApi, 'GET', 'a/b')
  check('a deeper sub-path is 404 too', deep.status === 404)
}

section('never another table')
{
  check('StoreInfoApi touched only StoreSetting (Order and User are untouched)', tables.Order.rows.size === 0 && tables.User.rows.size === 0)
}

section(`the rule-20 sweep over every response (${transcript.length})`)
{
  const synthetic = [{ cls: 'X', method: 'GET', pathname: '', status: 401, headers: new Headers({ 'cache-control': 'no-store' }) }]
  check('the sweep catches a 401 (NEG)', responseRulesVerdict(synthetic).some((b) => b.includes('401')))
  const bad = responseRulesVerdict(transcript)
  check('no 401, no WWW-Authenticate on a 403, everything no-store', bad.length === 0, bad.slice(0, 3).join(' | '))
}

process.exit(done())
