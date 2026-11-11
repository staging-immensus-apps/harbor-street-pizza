#!/usr/bin/env node
// GENERATED — the owner-only menu editor, proved over resources/MenuAdminApi.js as shipped
// (the back-end charter: one hermetic probe per resource). Anonymous and a signed-in non-admin are
// refused on every method with 403 and no WWW-Authenticate, and neither one writes or deletes a
// row; an admin sees every item including hidden ones; a malformed price is 400 and writes
// nothing; a forged id or createdAt in the body changes neither; a partial PATCH leaves the other
// fields alone; a demoted admin with an unexpired cookie is refused because the row is re-read;
// delete removes the row and a second delete is 404; and deleting an item never touches an Order
// row that snapshot it.
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
const { MenuAdminApi } = await import('../resources/MenuAdminApi.js')

const { check, section, done, failures } = checker('MenuAdminApi-probe')

resetTables()
const ADMIN = await userWithCookie('owner@example.test', { role: 'admin' })
const MEMBER = await userWithCookie('member@example.test', { role: 'member' })

// A seeded item, written straight to the stub so an unauthenticated / non-admin request has
// something to try to read or touch.
await tables.MenuItem.put({
  id: 'seed-1',
  name: 'Margherita',
  description: 'Tomato, mozzarella, basil',
  priceCents: 900,
  category: 'Pizza',
  available: true,
  sortOrder: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})
await tables.MenuItem.put({
  id: 'seed-hidden',
  name: 'Seasonal special',
  description: null,
  priceCents: 1200,
  category: 'Pizza',
  available: false,
  sortOrder: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

section('anonymous is refused on every method, and writes nothing')
{
  const before = tables.MenuItem.rows.size
  const cases = [
    ['GET', ''], ['GET', 'seed-1'], ['POST', '', { name: 'X', priceCents: 100 }],
    ['PATCH', 'seed-1', { name: 'X' }], ['DELETE', 'seed-1'],
  ]
  for (const [m, p, body] of cases) {
    const r = await call(MenuAdminApi, m, p, { body })
    check(`${m} /MenuAdminApi/${p} anonymous -> 403 auth_required, no WWW-Authenticate`, r.status === 403 && r.json?.code === 'auth_required' && !r.headers.get('www-authenticate'))
  }
  check('none of that wrote or deleted a row', tables.MenuItem.rows.size === before)
}

section('a signed-in non-admin is refused on every method, and writes nothing (NEG)')
{
  const before = tables.MenuItem.rows.size
  const cases = [
    ['GET', '', undefined], ['GET', 'seed-1', undefined], ['POST', '', { name: 'X', priceCents: 100 }],
    ['PATCH', 'seed-1', { name: 'X' }], ['DELETE', 'seed-1', undefined],
  ]
  for (const [m, p, body] of cases) {
    const r = await call(MenuAdminApi, m, p, { cookie: MEMBER.cookie, body })
    check(`${m} /MenuAdminApi/${p} member -> 403 admin_required, no WWW-Authenticate`, r.status === 403 && r.json?.code === 'admin_required' && !r.headers.get('www-authenticate'))
  }
  check('none of that wrote or deleted a row either', tables.MenuItem.rows.size === before)
}

section('the admin sees every item, including hidden ones')
{
  const r = await call(MenuAdminApi, 'GET', '', { cookie: ADMIN.cookie })
  const ids = (r.json?.items ?? []).map((i) => i.id)
  check('the list is 200 and holds both the available and the hidden item', r.status === 200 && ids.includes('seed-1') && ids.includes('seed-hidden'))
  const hidden = r.json.items.find((i) => i.id === 'seed-hidden')
  check('the hidden item carries available: false', hidden?.available === false)
  const sub = await call(MenuAdminApi, 'GET', 'seed-1/extra', { cookie: ADMIN.cookie })
  check('an unknown sub-path -> 404', sub.status === 404)
}

section('create validates the price and ignores a forged id / createdAt')
{
  const before = tables.MenuItem.rows.size
  for (const priceCents of [12.5, -1, '1200']) {
    const r = await call(MenuAdminApi, 'POST', '', { cookie: ADMIN.cookie, body: { name: 'Bad price', priceCents } })
    check(`priceCents ${JSON.stringify(priceCents)} -> 400 (NEG)`, r.status === 400)
  }
  check('none of those malformed bodies wrote a row', tables.MenuItem.rows.size === before)
  const blank = await call(MenuAdminApi, 'POST', '', { cookie: ADMIN.cookie, body: { name: '   ', priceCents: 100 } })
  check('a blank name -> 400 (NEG)', blank.status === 400)
  const created = await call(MenuAdminApi, 'POST', '', { cookie: ADMIN.cookie, body: { name: 'Garlic Bread', priceCents: 450, id: 'forged', createdAt: '1999-01-01T00:00:00.000Z' } })
  check('a valid create -> 201, with a server-minted id and createdAt (NEG)', created.status === 201 && created.json?.item?.id && created.json.item.id !== 'forged' && created.json.item.createdAt !== '1999-01-01T00:00:00.000Z')
  check('the row category defaults when absent', created.json?.item?.category === 'Other')
  check('the row is now in the table', tables.MenuItem.rows.has(created.json.item.id))
  globalThis.__created = created.json.item
}

section('PATCH is partial: one field changes, the rest survive')
{
  const id = globalThis.__created.id
  const patched = await call(MenuAdminApi, 'PATCH', id, { cookie: ADMIN.cookie, body: { priceCents: 500 } })
  check('PATCH priceCents only -> 200 and the price changed', patched.status === 200 && patched.json?.item?.priceCents === 500)
  check('…and name, category untouched', patched.json?.item?.name === 'Garlic Bread' && patched.json.item.category === 'Other')
  const forged = await call(MenuAdminApi, 'PATCH', id, { cookie: ADMIN.cookie, body: { id: 'other-id', createdAt: '1999-01-01T00:00:00.000Z', name: 'Garlic Bread (patched)' } })
  check('a body naming id/createdAt on PATCH changes neither (NEG)', forged.status === 200 && forged.json?.item?.id === id && forged.json.item.createdAt === globalThis.__created.createdAt && forged.json.item.name === 'Garlic Bread (patched)')
  const badPrice = await call(MenuAdminApi, 'PATCH', id, { cookie: ADMIN.cookie, body: { priceCents: -5 } })
  check('a malformed PATCH price -> 400 and the row is unchanged (NEG)', badPrice.status === 400 && tables.MenuItem.rows.get(id).priceCents === 500)
  const missing = await call(MenuAdminApi, 'PATCH', 'no-such-id', { cookie: ADMIN.cookie, body: { name: 'X' } })
  check('PATCH of an unknown id -> 404', missing.status === 404)
}

section('a demoted admin with an unexpired cookie is refused (the row is re-read)')
{
  await tables.User.put({ ...ADMIN.user, role: 'member' })
  const r = await call(MenuAdminApi, 'GET', '', { cookie: ADMIN.cookie })
  check('the same cookie now answers 403 admin_required', r.status === 403 && r.json?.code === 'admin_required')
  await tables.User.put({ ...ADMIN.user, role: 'admin' })
  const restored = await call(MenuAdminApi, 'GET', '', { cookie: ADMIN.cookie })
  check('…and works again once the role is restored (NEG)', restored.status === 200)
}

section('delete removes the row; a second delete is 404; Order rows are untouched')
{
  // An order placed before the item is removed keeps its own snapshot (CLAUDE.md §8); this
  // resource must never read or write Order at all.
  await tables.Order.put({
    id: 'order-1',
    code: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    placedAt: '2026-01-02T00:00:00.000Z',
    status: 'received',
    queue: 'active',
    fulfilment: 'pickup',
    items: [{ menuItemId: 'seed-1', name: 'Margherita', priceCents: 900, quantity: 1 }],
    itemsTotalCents: 900,
    deliveryFeeCents: 0,
    totalCents: 900,
    paymentStatus: 'pay_at_store',
  })
  const orderBefore = { ...tables.Order.rows.get('order-1') }

  const del = await call(MenuAdminApi, 'DELETE', 'seed-1', { cookie: ADMIN.cookie })
  check('DELETE an existing item -> { ok: true } and it is gone', del.status === 200 && del.json?.ok === true && !tables.MenuItem.rows.has('seed-1'))
  const again = await call(MenuAdminApi, 'DELETE', 'seed-1', { cookie: ADMIN.cookie })
  check('deleting it again -> 404', again.status === 404)
  const missing = await call(MenuAdminApi, 'DELETE', 'no-such-id', { cookie: ADMIN.cookie })
  check('deleting an id that never existed -> 404', missing.status === 404)

  const orderAfter = tables.Order.rows.get('order-1')
  check('the Order row referencing the deleted item is byte-for-byte unchanged', JSON.stringify(orderAfter) === JSON.stringify(orderBefore))
}

section(`the rule-20 sweep over every response (${transcript.length})`)
{
  const synthetic = [{ cls: 'X', method: 'GET', pathname: '', status: 401, headers: new Headers({ 'cache-control': 'no-store' }) }]
  check('the sweep catches a 401 (NEG)', responseRulesVerdict(synthetic).some((b) => b.includes('401')))
  const bad = responseRulesVerdict(transcript)
  check('no 401, no WWW-Authenticate on a 403, everything no-store', bad.length === 0, bad.slice(0, 3).join(' | '))
}

process.exit(done())
