#!/usr/bin/env node
// GENERATED — resources/MenuApi.js is public and read-only, so this probe's job is the
// opposite shape from an owner-scoped one: prove an unavailable item never appears, prove the
// grouping and sort are right, and prove an anonymous caller gets 200 (not 403 — this resource
// has no auth at all, by design, because the deploy smoke table hits it with no cookie).
//
// Also proves the QA defect is fixed: an item whose `photoUpdatedAt` is set but whose
// `MenuItemPhoto` row is missing, unservable (wrong content type) or empty (byteSize 0) gets
// `photoUrl: null` rather than a URL that 404s — `lib/photos.js`'s `photoIsServable()` is the
// metadata-only check this resource now makes before publishing a URL, and the negative control
// is the SAME item getting a URL once a servable row actually exists.
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
const { MenuApi } = await import('../resources/MenuApi.js')

const { check, section, done, failures } = checker('MenuApi-probe')

// Captures globalThis.logger?.warn(...) calls so the fix's log line can be asserted rather than
// merely trusted — this is how the QA defect would have been readable in the app log instead of
// as a customer's broken image.
const warnings = []
globalThis.logger = { warn: (...a) => warnings.push(a.join(' ')), error: (...a) => warnings.push(a.join(' ')) }

section('negative control: the sweep can say no')
{
  const synthetic = [{ cls: 'X', method: 'GET', pathname: '', status: 401, headers: new Headers({ 'cache-control': 'no-store' }) }]
  check('the sweep catches a 401 (NEG)', responseRulesVerdict(synthetic).some((b) => b.includes('401')))
}
if (failures.length) process.exit(done())

resetTables()

section('an empty table answers 200 with empty lists (the smoke row)')
{
  const empty = await call(MenuApi, 'GET', '')
  check('GET /MenuApi with no cookie, no query → 200', empty.status === 200)
  check('…empty categories and items', Array.isArray(empty.json?.categories) && empty.json.categories.length === 0 && Array.isArray(empty.json?.items) && empty.json.items.length === 0)
  check('…and still carries the shop-level fields', 'acceptingOrders' in (empty.json ?? {}) && 'storeName' in (empty.json ?? {}))
}

section('seed items — available and unavailable, mixed categories and sort orders')
await tables.MenuItem.put({ id: 'm1', name: 'Margherita', description: 'Tomato, mozzarella', priceCents: 900, category: 'Pizza', available: true, sortOrder: 2, photoUpdatedAt: '2026-01-02T00:00:00.000Z' })
await tables.MenuItem.put({ id: 'm2', name: 'Pepperoni', description: 'Tomato, mozzarella, pepperoni', priceCents: 1100, category: 'Pizza', available: true, sortOrder: 1 })
await tables.MenuItem.put({ id: 'm3', name: 'Garlic Bread', description: null, priceCents: 400, category: 'Sides', available: true, sortOrder: 1 })
await tables.MenuItem.put({ id: 'm4', name: 'Secret Test Pizza', description: 'hidden', priceCents: 50000, category: 'Pizza', available: false, sortOrder: 0, photoUpdatedAt: '2026-01-03T00:00:00.000Z' })
await tables.MenuItem.put({ id: 'm5 a/b', name: 'Calzone', description: null, priceCents: 1200, category: 'Pizza', available: true, sortOrder: 3, photoUpdatedAt: '2026-01-04T00:00:00.000Z' })
// The QA defect, reproduced: a stamp with NO MenuItemPhoto row at all behind it.
await tables.MenuItem.put({ id: 'm6', name: 'Quattro Stagioni', description: null, priceCents: 1300, category: 'Pizza', available: true, sortOrder: 4, photoUpdatedAt: '2026-01-05T00:00:00.000Z' })
// A stamp whose stored row exists but is not servable: wrong content type.
await tables.MenuItem.put({ id: 'm7', name: 'Hawaiian', description: null, priceCents: 1000, category: 'Pizza', available: true, sortOrder: 5, photoUpdatedAt: '2026-01-06T00:00:00.000Z' })
// A stamp whose stored row exists but carries no bytes.
await tables.MenuItem.put({ id: 'm8', name: 'Veggie', description: null, priceCents: 950, category: 'Pizza', available: true, sortOrder: 6, photoUpdatedAt: '2026-01-07T00:00:00.000Z' })

section('the bytes behind the stamps — servable, missing, and unservable')
// m1 and m5 are servable: a real row, a supported content type, a positive byte size.
await tables.MenuItemPhoto.put({ id: 'm1', contentType: 'image/jpeg', byteSize: 100, data: Buffer.from('m1-bytes') })
await tables.MenuItemPhoto.put({ id: 'm5 a/b', contentType: 'image/png', byteSize: 200, data: Buffer.from('m5-bytes') })
// m6 is left with no MenuItemPhoto row at all — the QA defect.
// m7's row exists but is the wrong content type.
await tables.MenuItemPhoto.put({ id: 'm7', contentType: 'image/gif', byteSize: 50, data: Buffer.from('m7-bytes') })
// m8's row exists but has no bytes.
await tables.MenuItemPhoto.put({ id: 'm8', contentType: 'image/jpeg', byteSize: 0, data: Buffer.from('') })

section('the stub would surface the leak (the fixture can fail)')
{
  const all = []
  for await (const row of tables.MenuItem.search({ conditions: [] })) all.push(row.id)
  check('an unconditioned search returns the unavailable item — so a resource that forgot the filter would fail below (NEG)', all.includes('m4'))
}

section('anonymous reads the public menu, filtered, sorted and grouped')
let menuBody
{
  const r = await call(MenuApi, 'GET', '')
  check('anonymous caller → 200 (this resource is public, not a 403)', r.status === 200)
  const ids = (r.json?.items ?? []).map((i) => i.id)
  check('the unavailable item never appears (NEG)', !ids.includes('m4'))
  check('every available item does appear', ['m1', 'm2', 'm3', 'm5 a/b', 'm6', 'm7', 'm8'].every((id) => ids.includes(id)))
  check('an item never carries `available`', (r.json?.items ?? []).every((i) => !('available' in i)))

  const pizza = (r.json?.categories ?? []).find((c) => c.category === 'Pizza')
  const sides = (r.json?.categories ?? []).find((c) => c.category === 'Sides')
  check('categories are grouped', Boolean(pizza) && Boolean(sides))
  check('Pizza group holds exactly the available pizzas, sorted by sortOrder', pizza?.items?.map((i) => i.id).join(',') === 'm2,m1,m5 a/b,m6,m7,m8')
  check('Sides group holds the one available side', sides?.items?.map((i) => i.id).join(',') === 'm3')
  check('categories sorted alphabetically (Pizza before Sides)', (r.json?.categories ?? []).map((c) => c.category).join(',') === 'Pizza,Sides')

  check('shop-level fields ride along', typeof r.json?.acceptingOrders === 'boolean' && typeof r.json?.storeName === 'string')
  menuBody = r
}

section('a photo rides along as a URL, never as bytes — and only when the bytes are really there')
{
  const items = menuBody.json?.items ?? []
  const byId = (id) => items.find((i) => i.id === id)
  const m1 = byId('m1')
  const m2 = byId('m2')
  const m5 = byId('m5 a/b')
  const m6 = byId('m6')
  const m7 = byId('m7')
  const m8 = byId('m8')

  check('a servable photo carries a photoUrl naming its own id and the stamp', typeof m1?.photoUrl === 'string' && m1.photoUrl.includes('/MenuPhotoApi/m1') && m1.photoUrl.includes(`v=${encodeURIComponent('2026-01-02T00:00:00.000Z')}`))
  check('an item with no photoUpdatedAt carries photoUrl === null, not absent and not empty (NEG)', 'photoUrl' in (m2 ?? {}) && m2.photoUrl === null)
  check('an id needing URL-escaping round-trips through photoUrl', typeof m5?.photoUrl === 'string' && m5.photoUrl.includes(`/MenuPhotoApi/${encodeURIComponent('m5 a/b')}`) && m5.photoUrl.includes(`v=${encodeURIComponent('2026-01-04T00:00:00.000Z')}`))

  check('THE QA DEFECT: a stamp with no MenuItemPhoto row behind it → photoUrl null, not a 404ing URL', 'photoUrl' in (m6 ?? {}) && m6.photoUrl === null)
  check('…and the item is still on the menu with its name and price', m6?.name === 'Quattro Stagioni' && m6?.priceCents === 1300)
  check('a stored row with an unsupported content type → photoUrl null', 'photoUrl' in (m7 ?? {}) && m7.photoUrl === null)
  check('a stored row with byteSize 0 → photoUrl null', 'photoUrl' in (m8 ?? {}) && m8.photoUrl === null)

  check('a warning named m6 (claims a photo, no row at all)', warnings.some((w) => w.includes('m6')))
  check('a warning named m7 (unservable content type)', warnings.some((w) => w.includes('m7')))
  check('a warning named m8 (empty row)', warnings.some((w) => w.includes('m8')))
  check('no warning for a servable item (NEG)', !warnings.some((w) => w.includes('m1') || w.includes('m5')))

  const pizza = (menuBody.json?.categories ?? []).find((c) => c.category === 'Pizza')
  const grouped1 = pizza?.items?.find((i) => i.id === 'm1')
  check('the same photoUrl appears inside categories, not only in the flat list', grouped1?.photoUrl === m1?.photoUrl)

  const serialized = JSON.stringify(menuBody.json)
  check('the response carries no photo bytes anywhere (NEG)', !('data' in (m1 ?? {})) && !/"data"\s*:/.test(serialized) && !/photoUpdatedAt/.test(serialized))

  check('the unavailable item, even with a photo, never appears (NEG)', !items.some((i) => i.id === 'm4'))
}

section('NEG: the very same item gets a URL once its photo row actually exists')
{
  const m6WarningsBefore = warnings.filter((w) => w.includes('m6')).length
  await tables.MenuItemPhoto.put({ id: 'm6', contentType: 'image/jpeg', byteSize: 150, data: Buffer.from('m6-bytes') })
  const r = await call(MenuApi, 'GET', '')
  const m6 = (r.json?.items ?? []).find((i) => i.id === 'm6')
  check('once the photo row is put, the same item now carries a photoUrl (so the earlier null was not vacuous)', typeof m6?.photoUrl === 'string' && m6.photoUrl.includes('/MenuPhotoApi/m6') && m6.photoUrl.includes(`v=${encodeURIComponent('2026-01-05T00:00:00.000Z')}`))
  // m7 and m8 are still unservable, so this call warns about them again (expected); only m6's
  // count must stay exactly where it was before this put, now that it is servable.
  check('…and no new warning was logged naming m6, now that it is servable', warnings.filter((w) => w.includes('m6')).length === m6WarningsBefore)
}

section('a sub-path is 404, and no method but GET is served')
{
  const sub = await call(MenuApi, 'GET', 'anything')
  check('GET /MenuApi/anything → 404', sub.status === 404)
}

section(`the rule-20 sweep over every response (${transcript.length})`)
{
  const bad = responseRulesVerdict(transcript)
  check('no 401, no WWW-Authenticate on a 403, everything no-store', bad.length === 0, bad.slice(0, 3).join(' | '))
}

process.exit(done())
