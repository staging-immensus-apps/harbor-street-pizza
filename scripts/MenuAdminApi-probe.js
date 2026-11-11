#!/usr/bin/env node
// GENERATED — the owner-only menu editor, proved over resources/MenuAdminApi.js as shipped
// (the back-end charter: one hermetic probe per resource). Anonymous and a signed-in non-admin are
// refused on every method with 403 and no WWW-Authenticate, and neither one writes or deletes a
// row; an admin sees every item including hidden ones; a malformed price is 400 and writes
// nothing; a forged id or createdAt in the body changes neither; a partial update leaves the other
// fields alone; a demoted admin with an unexpired cookie is refused because the row is re-read;
// delete removes the row and a second delete is 404; and deleting an item never touches an Order
// row that snapshot it.
//
// THE UPDATE AND DELETE ROUTES ARE POST /MenuAdminApi/update and POST /MenuAdminApi/delete, BODY
// CARRIES THE id: Harper's REST layer refuses a write whose path names a record
// (`/MenuAdminApi/:id`) on a custom Resource, with a 400 before this resource's code ever runs
// (measured on a real cluster, 2026-11-11). `PUT`/`PATCH`/`DELETE` at `/:id` are kept working as
// aliases, so every assertion below is driven over both shapes — the action routes as the proven
// ones, the verb-on-id routes as aliases — to prove the body and the merge are identical either way.
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
    ['POST', 'update', { id: 'seed-1', name: 'X' }], ['POST', 'delete', { id: 'seed-1' }],
    ['PUT', 'seed-1', { name: 'X' }], ['PATCH', 'seed-1', { name: 'X' }], ['DELETE', 'seed-1'],
  ]
  for (const [m, p, body] of cases) {
    const r = await call(MenuAdminApi, m, p, { body })
    check(`${m} /MenuAdminApi/${p} anonymous -> 403 auth_required, no WWW-Authenticate`, r.status === 403 && r.json?.code === 'auth_required' && !r.headers.get('www-authenticate'))
  }
  check('none of that wrote or deleted a row', tables.MenuItem.rows.size === before)
  check('…and the seeded row itself is untouched', tables.MenuItem.rows.get('seed-1')?.name === 'Margherita')
}

section('a signed-in non-admin is refused on every method, and writes nothing (NEG)')
{
  const before = tables.MenuItem.rows.size
  const cases = [
    ['GET', '', undefined], ['GET', 'seed-1', undefined], ['POST', '', { name: 'X', priceCents: 100 }],
    ['POST', 'update', { id: 'seed-1', name: 'X' }], ['POST', 'delete', { id: 'seed-1' }],
    ['PUT', 'seed-1', { name: 'X' }], ['PATCH', 'seed-1', { name: 'X' }], ['DELETE', 'seed-1', undefined],
  ]
  for (const [m, p, body] of cases) {
    const r = await call(MenuAdminApi, m, p, { cookie: MEMBER.cookie, body })
    check(`${m} /MenuAdminApi/${p} member -> 403 admin_required, no WWW-Authenticate`, r.status === 403 && r.json?.code === 'admin_required' && !r.headers.get('www-authenticate'))
  }
  check('none of that wrote or deleted a row either', tables.MenuItem.rows.size === before)
  check('…and the seeded row itself is untouched', tables.MenuItem.rows.get('seed-1')?.name === 'Margherita')
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
}

section('the update action route (POST /MenuAdminApi/update, the proven route): partial, and a forged id/createdAt changes neither')
{
  const created = await call(MenuAdminApi, 'POST', '', { cookie: ADMIN.cookie, body: { name: 'Calzone', description: 'Folded pizza', priceCents: 800, category: 'Pizza' } })
  check('setup create -> 201', created.status === 201)
  const id = created.json.item.id
  const createdAt = created.json.item.createdAt

  const priced = await call(MenuAdminApi, 'POST', 'update', { cookie: ADMIN.cookie, body: { id, priceCents: 999 } })
  check('a price-only update -> 200 and the price really changed', priced.status === 200 && priced.json?.item?.priceCents === 999)
  check('…and the row in the table agrees', tables.MenuItem.rows.get(id)?.priceCents === 999)
  check('…name and category are untouched', priced.json?.item?.name === 'Calzone' && priced.json.item.category === 'Pizza')

  const described = await call(MenuAdminApi, 'POST', 'update', { cookie: ADMIN.cookie, body: { id, description: 'Folded pizza, extra cheese' } })
  check('a description-only update -> 200 and only the description changed', described.status === 200 && described.json?.item?.description === 'Folded pizza, extra cheese')
  check('…name and price are untouched by the description-only update', described.json?.item?.name === 'Calzone' && described.json.item.priceCents === 999)

  const toggled = await call(MenuAdminApi, 'POST', 'update', { cookie: ADMIN.cookie, body: { id, available: false } })
  check('an availability toggle -> 200 and available is now false', toggled.status === 200 && toggled.json?.item?.available === false)
  check('…nothing else moved', toggled.json?.item?.priceCents === 999 && toggled.json.item.description === 'Folded pizza, extra cheese')

  const forged = await call(MenuAdminApi, 'POST', 'update', { cookie: ADMIN.cookie, body: { id, name: 'Calzone (edited)', createdAt: '1999-01-01T00:00:00.000Z', forgedId: 'other-id' } })
  check('a body naming createdAt changes neither id nor createdAt (NEG)', forged.status === 200 && forged.json?.item?.id === id && forged.json.item.createdAt === createdAt && forged.json.item.name === 'Calzone (edited)')

  const unknown = await call(MenuAdminApi, 'POST', 'update', { cookie: ADMIN.cookie, body: { id: 'no-such-id', name: 'X' } })
  check('an unknown id -> 404 and writes nothing new', unknown.status === 404 && !tables.MenuItem.rows.has('no-such-id'))

  const sizeBefore = tables.MenuItem.rows.size
  const missingId = await call(MenuAdminApi, 'POST', 'update', { cookie: ADMIN.cookie, body: { name: 'X' } })
  check('a missing id -> 404 (NEG)', missingId.status === 404)
  const blankId = await call(MenuAdminApi, 'POST', 'update', { cookie: ADMIN.cookie, body: { id: '   ', name: 'X' } })
  check('a blank id -> 404 (NEG)', blankId.status === 404)
  check('neither of those created a row', tables.MenuItem.rows.size === sizeBefore)

  const badPrice = await call(MenuAdminApi, 'POST', 'update', { cookie: ADMIN.cookie, body: { id, priceCents: -5 } })
  check('a malformed price -> 400 with an error field, and the row is unchanged (NEG)', badPrice.status === 400 && typeof badPrice.json?.error === 'string' && tables.MenuItem.rows.get(id).priceCents === 999)

  const extra = await call(MenuAdminApi, 'POST', 'update/extra', { cookie: ADMIN.cookie, body: { id, name: 'X' } })
  check('a sub-path under update -> 404', extra.status === 404)
}

section('the delete action route (POST /MenuAdminApi/delete, the proven route) removes the row; a second call and an unknown id are 404')
{
  const created = await call(MenuAdminApi, 'POST', '', { cookie: ADMIN.cookie, body: { name: 'Side Salad', priceCents: 350 } })
  check('setup create -> 201', created.status === 201)
  const id = created.json.item.id

  const del = await call(MenuAdminApi, 'POST', 'delete', { cookie: ADMIN.cookie, body: { id } })
  check('POST /MenuAdminApi/delete -> { ok: true } and the row is gone', del.status === 200 && del.json?.ok === true && !tables.MenuItem.rows.has(id))
  const again = await call(MenuAdminApi, 'POST', 'delete', { cookie: ADMIN.cookie, body: { id } })
  check('deleting it again -> 404', again.status === 404)
  const unknown = await call(MenuAdminApi, 'POST', 'delete', { cookie: ADMIN.cookie, body: { id: 'no-such-id' } })
  check('deleting an id that never existed -> 404', unknown.status === 404)
  const missingId = await call(MenuAdminApi, 'POST', 'delete', { cookie: ADMIN.cookie, body: {} })
  check('a missing id -> 404 (NEG)', missingId.status === 404)

  const extra = await call(MenuAdminApi, 'POST', 'delete/extra', { cookie: ADMIN.cookie, body: { id } })
  check('a sub-path under delete -> 404', extra.status === 404)

  const unknownAction = await call(MenuAdminApi, 'POST', 'archive', { cookie: ADMIN.cookie, body: { id: 'seed-hidden' } })
  check('an unrecognized POST action -> 404 and writes nothing', unknownAction.status === 404 && tables.MenuItem.rows.has('seed-hidden'))
}

section('the update route (PUT, proven on the cluster) and its PATCH alias are both partial: one field changes, the rest survive')
for (const verb of ['PUT', 'PATCH']) {
  // Each verb gets its own freshly-created row so the two passes cannot see each other's writes.
  const created = await call(MenuAdminApi, 'POST', '', { cookie: ADMIN.cookie, body: { name: 'Garlic Bread', priceCents: 450 } })
  check(`${verb}: setup create -> 201`, created.status === 201)
  const id = created.json.item.id
  const createdAt = created.json.item.createdAt

  const updated = await call(MenuAdminApi, verb, id, { cookie: ADMIN.cookie, body: { priceCents: 500 } })
  check(`${verb} priceCents only -> 200 and the price changed`, updated.status === 200 && updated.json?.item?.priceCents === 500)
  check(`${verb}: …and name, category untouched`, updated.json?.item?.name === 'Garlic Bread' && updated.json.item.category === 'Other')

  const forged = await call(MenuAdminApi, verb, id, { cookie: ADMIN.cookie, body: { id: 'other-id', createdAt: '1999-01-01T00:00:00.000Z', name: 'Garlic Bread (patched)' } })
  check(`${verb}: a body naming id/createdAt changes neither (NEG)`, forged.status === 200 && forged.json?.item?.id === id && forged.json.item.createdAt === createdAt && forged.json.item.name === 'Garlic Bread (patched)')

  const badPrice = await call(MenuAdminApi, verb, id, { cookie: ADMIN.cookie, body: { priceCents: -5 } })
  check(`${verb}: a malformed price -> 400 with an error field, and the row is unchanged (NEG)`, badPrice.status === 400 && typeof badPrice.json?.error === 'string' && tables.MenuItem.rows.get(id).priceCents === 500)

  const missing = await call(MenuAdminApi, verb, 'no-such-id', { cookie: ADMIN.cookie, body: { name: 'X' } })
  check(`${verb} of an unknown id -> 404`, missing.status === 404)

  const sub = await call(MenuAdminApi, verb, `${id}/extra`, { cookie: ADMIN.cookie, body: { name: 'X' } })
  check(`${verb} of a sub-path -> 404`, sub.status === 404)

  const member = await call(MenuAdminApi, verb, id, { cookie: MEMBER.cookie, body: { name: 'hijack' } })
  check(`${verb}: a signed-in non-admin -> 403 admin_required, no WWW-Authenticate, row unchanged (NEG)`, member.status === 403 && member.json?.code === 'admin_required' && !member.headers.get('www-authenticate') && tables.MenuItem.rows.get(id).name === 'Garlic Bread (patched)')

  const anon = await call(MenuAdminApi, verb, id, { body: { name: 'hijack' } })
  check(`${verb}: anonymous -> 403 auth_required, no WWW-Authenticate, row unchanged (NEG)`, anon.status === 403 && anon.json?.code === 'auth_required' && !anon.headers.get('www-authenticate') && tables.MenuItem.rows.get(id).name === 'Garlic Bread (patched)')
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
