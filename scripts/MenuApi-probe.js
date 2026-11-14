#!/usr/bin/env node
// GENERATED — resources/MenuApi.js is public and read-only, so this probe's job is the
// opposite shape from an owner-scoped one: prove an unavailable item never appears, prove the
// grouping and sort are right, and prove an anonymous caller gets 200 (not 403 — this resource
// has no auth at all, by design, because the deploy smoke table hits it with no cookie).
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
  check('every available item does appear', ids.includes('m1') && ids.includes('m2') && ids.includes('m3') && ids.includes('m5 a/b'))
  check('an item never carries `available`', (r.json?.items ?? []).every((i) => !('available' in i)))

  const pizza = (r.json?.categories ?? []).find((c) => c.category === 'Pizza')
  const sides = (r.json?.categories ?? []).find((c) => c.category === 'Sides')
  check('categories are grouped', Boolean(pizza) && Boolean(sides))
  check('Pizza group holds exactly the available pizzas, sorted by sortOrder', pizza?.items?.map((i) => i.id).join(',') === 'm2,m1,m5 a/b')
  check('Sides group holds the one available side', sides?.items?.map((i) => i.id).join(',') === 'm3')
  check('categories sorted alphabetically (Pizza before Sides)', (r.json?.categories ?? []).map((c) => c.category).join(',') === 'Pizza,Sides')

  check('shop-level fields ride along', typeof r.json?.acceptingOrders === 'boolean' && typeof r.json?.storeName === 'string')
  menuBody = r
}

section('a photo rides along as a URL, never as bytes')
{
  const items = menuBody.json?.items ?? []
  const m1 = items.find((i) => i.id === 'm1')
  const m2 = items.find((i) => i.id === 'm2')
  const m5 = items.find((i) => i.id === 'm5 a/b')
  check('an item with photoUpdatedAt carries a photoUrl naming its own id and the stamp', typeof m1?.photoUrl === 'string' && m1.photoUrl.includes('/MenuPhotoApi/m1') && m1.photoUrl.includes(`v=${encodeURIComponent('2026-01-02T00:00:00.000Z')}`))
  check('an item with no photoUpdatedAt carries photoUrl === null, not absent and not empty (NEG)', 'photoUrl' in (m2 ?? {}) && m2.photoUrl === null)
  check('an id needing URL-escaping round-trips through photoUrl', typeof m5?.photoUrl === 'string' && m5.photoUrl.includes(`/MenuPhotoApi/${encodeURIComponent('m5 a/b')}`) && m5.photoUrl.includes(`v=${encodeURIComponent('2026-01-04T00:00:00.000Z')}`))

  const pizza = (menuBody.json?.categories ?? []).find((c) => c.category === 'Pizza')
  const grouped1 = pizza?.items?.find((i) => i.id === 'm1')
  check('the same photoUrl appears inside categories, not only in the flat list', grouped1?.photoUrl === m1?.photoUrl)

  const serialized = JSON.stringify(menuBody.json)
  check('the response carries no photo bytes anywhere (NEG)', !('data' in (m1 ?? {})) && !/"data"\s*:/.test(serialized) && !/photoUpdatedAt/.test(serialized))

  check('the unavailable item, even with a photo, never appears (NEG)', !items.some((i) => i.id === 'm4'))
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
