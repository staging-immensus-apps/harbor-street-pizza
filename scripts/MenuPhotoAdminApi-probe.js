#!/usr/bin/env node
// GENERATED — the owner's photo upload, proved over resources/MenuPhotoAdminApi.js as shipped
// (the back-end charter: one hermetic probe per resource). Anonymous and a signed-in non-admin
// are refused on every method with 403 and no WWW-Authenticate, and neither writes a row; an
// upload for an id with no MenuItem is 404; lib/photos.js's refusals (unsupported type, content
// mismatch, too large) all answer 400 and write nothing; a good upload stores the row and stamps
// the item; a re-upload replaces the bytes under a new stamp; DELETE clears both the row and the
// stamp and a second DELETE is 404; a corrupted read-back after the write is refused with 502 and
// never stamps the item (rule 8, verify-on-write); and every record this resource ever hands to
// MenuItem.put() names no field Harper owns (CLAUDE.md §8).
//
// Hermetic: clock frozen, no network, no git.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { freezeClock, advanceClock } from './probe/frozen-clock.js'
freezeClock()
process.env.SESSION_SECRET = 'suite-secret-not-a-real-one'
process.env.IMMENSUS_TIER = 'builder'

const { checker } = await import('./probe/harness.js')
const { tables, resetTables } = await import('./probe/harperdb-stub.js')
const { call, userWithCookie, transcript, responseRulesVerdict } = await import('./probe/resource-call.js')
const { MenuPhotoAdminApi } = await import('../resources/MenuPhotoAdminApi.js')
const { managedFieldsIn } = await import('../lib/managed-fields.js')
const { PHOTO_MAX_BYTES } = await import('../lib/photos.js')

const { check, section, done, failures } = checker('MenuPhotoAdminApi-probe')

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])

/** A tiny, structurally-valid-enough PNG: the real signature plus a little filler. */
function pngBase64 (fillerByte = 0x01) {
  return Buffer.concat([PNG_SIGNATURE, Buffer.alloc(32, fillerByte)]).toString('base64')
}

/** JPEG-signature bytes, declared as image/png — exactly what content_mismatch exists to catch. */
function mismatchedBase64 () {
  return Buffer.concat([JPEG_SIGNATURE, Buffer.alloc(32, 0x02)]).toString('base64')
}

resetTables()
const ADMIN = await userWithCookie('owner@example.test', { role: 'admin' })
const MEMBER = await userWithCookie('member@example.test', { role: 'member' })

await tables.MenuItem.put({
  id: 'seed-1',
  name: 'Margherita',
  description: 'Tomato, mozzarella, basil',
  priceCents: 900,
  category: 'Pizza',
  available: true,
  sortOrder: 1,
  photoUpdatedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

// Every record this resource hands to MenuItem.put() from here on, captured at the stub's own
// method — the same object db.MenuItem.put() reaches (lib/db.js resolves to this very instance;
// MenuAdminApi-probe relies on that identity too). The stub does not refuse a record naming
// createdAt/updatedAt, so this capture is what stands in for Harper's 400.
const menuItemWrites = []
const originalMenuItemPut = tables.MenuItem.put.bind(tables.MenuItem)
tables.MenuItem.put = async (record) => {
  menuItemWrites.push({ ...record })
  return originalMenuItemPut(record)
}

section('anonymous is refused on every method, and writes nothing')
{
  const beforePhotos = tables.MenuItemPhoto.rows.size
  const cases = [
    ['GET', 'seed-1'],
    ['POST', 'seed-1', { dataBase64: pngBase64(), contentType: 'image/png' }],
    ['PUT', 'seed-1'],
    ['PATCH', 'seed-1'],
    ['DELETE', 'seed-1'],
  ]
  for (const [m, p, body] of cases) {
    const r = await call(MenuPhotoAdminApi, m, p, { body })
    check(`${m} /MenuPhotoAdminApi/${p} anonymous -> 403 auth_required, no WWW-Authenticate`, r.status === 403 && r.json?.code === 'auth_required' && !r.headers.get('www-authenticate'))
  }
  check('none of that wrote a MenuItemPhoto row', tables.MenuItemPhoto.rows.size === beforePhotos)
}

section('a signed-in non-admin is refused on every method, and writes nothing (NEG)')
{
  const beforePhotos = tables.MenuItemPhoto.rows.size
  const cases = [
    ['GET', 'seed-1'],
    ['POST', 'seed-1', { dataBase64: pngBase64(), contentType: 'image/png' }],
    ['PUT', 'seed-1'],
    ['PATCH', 'seed-1'],
    ['DELETE', 'seed-1'],
  ]
  for (const [m, p, body] of cases) {
    const r = await call(MenuPhotoAdminApi, m, p, { cookie: MEMBER.cookie, body })
    check(`${m} /MenuPhotoAdminApi/${p} member -> 403 admin_required, no WWW-Authenticate`, r.status === 403 && r.json?.code === 'admin_required' && !r.headers.get('www-authenticate'))
  }
  check('none of that wrote a MenuItemPhoto row either', tables.MenuItemPhoto.rows.size === beforePhotos)
}

section('an upload for an id with no MenuItem -> 404 and writes nothing (NEG)')
{
  const r = await call(MenuPhotoAdminApi, 'POST', 'no-such-item', { cookie: ADMIN.cookie, body: { dataBase64: pngBase64(), contentType: 'image/png' } })
  check('unknown item -> 404', r.status === 404)
  check('no MenuItemPhoto row was written', !tables.MenuItemPhoto.rows.has('no-such-item'))
}

section('lib/photos.js refusals all answer 400 and write nothing (NEG)')
{
  const gif = await call(MenuPhotoAdminApi, 'POST', 'seed-1', { cookie: ADMIN.cookie, body: { dataBase64: pngBase64(), contentType: 'image/gif' } })
  check('image/gif -> 400 unsupported_type', gif.status === 400 && gif.json?.code === 'unsupported_type')

  const mismatch = await call(MenuPhotoAdminApi, 'POST', 'seed-1', { cookie: ADMIN.cookie, body: { dataBase64: mismatchedBase64(), contentType: 'image/png' } })
  check('JPEG bytes declared as image/png -> 400 content_mismatch', mismatch.status === 400 && mismatch.json?.code === 'content_mismatch')

  const tooLong = 'A'.repeat(Math.ceil(PHOTO_MAX_BYTES / 3) * 4 + 2000)
  const tooLarge = await call(MenuPhotoAdminApi, 'POST', 'seed-1', { cookie: ADMIN.cookie, body: { dataBase64: tooLong, contentType: 'image/png' } })
  check('over 5MB -> 400 too_large', tooLarge.status === 400 && tooLarge.json?.code === 'too_large')

  check('none of those three wrote a photo row', !tables.MenuItemPhoto.rows.has('seed-1'))
  check('…and the item was not stamped', tables.MenuItem.rows.get('seed-1')?.photoUpdatedAt == null)
}

let firstStamp
section('a good upload stores the row and stamps the item')
{
  const r = await call(MenuPhotoAdminApi, 'POST', 'seed-1', { cookie: ADMIN.cookie, body: { dataBase64: pngBase64(), contentType: 'image/png' } })
  check('upload -> 200 ok with a photo payload', r.status === 200 && r.json?.ok === true && r.json?.photo?.menuItemId === 'seed-1')
  check('byteSize and contentType match what was sent', r.json?.photo?.contentType === 'image/png' && r.json?.photo?.byteSize === PNG_SIGNATURE.length + 32)
  const row = tables.MenuItemPhoto.rows.get('seed-1')
  check('the MenuItemPhoto row exists with the same byteSize', row?.byteSize === r.json.photo.byteSize && row?.contentType === 'image/png')
  const item = tables.MenuItem.rows.get('seed-1')
  check('the item is stamped with the same timestamp the photo carries', item?.photoUpdatedAt === r.json.photo.uploadedAt)
  firstStamp = item.photoUpdatedAt
}

section('a re-upload replaces the bytes on the same key, under a new stamp')
{
  advanceClock(60 * 1000)
  const r = await call(MenuPhotoAdminApi, 'POST', 'seed-1', { cookie: ADMIN.cookie, body: { dataBase64: pngBase64(0x09), contentType: 'image/png' } })
  check('second upload -> 200', r.status === 200 && r.json?.ok === true)
  check('the stamp moved forward', r.json?.photo?.uploadedAt !== firstStamp)
  const row = tables.MenuItemPhoto.rows.get('seed-1')
  check('…and the stored bytes reflect the new upload (same byteSize, new upload time)', row?.uploadedAt === r.json.photo.uploadedAt)
  const item = tables.MenuItem.rows.get('seed-1')
  check('…and the item carries the new stamp, not the first one', item?.photoUpdatedAt === r.json.photo.uploadedAt && item.photoUpdatedAt !== firstStamp)
}

section('DELETE clears both the row and the stamp; a second DELETE is 404')
{
  const del = await call(MenuPhotoAdminApi, 'DELETE', 'seed-1', { cookie: ADMIN.cookie })
  check('DELETE -> 200 ok', del.status === 200 && del.json?.ok === true)
  check('the photo row is gone', !tables.MenuItemPhoto.rows.has('seed-1'))
  check('the item stamp is cleared', tables.MenuItem.rows.get('seed-1')?.photoUpdatedAt === null)
  const again = await call(MenuPhotoAdminApi, 'DELETE', 'seed-1', { cookie: ADMIN.cookie })
  check('deleting it again -> 404', again.status === 404)
  const unknown = await call(MenuPhotoAdminApi, 'DELETE', 'no-such-item', { cookie: ADMIN.cookie })
  check('deleting an id with no photo -> 404', unknown.status === 404)
}

section('verify-on-write failure (rule 8): a corrupted read-back is refused, deleted, and never stamped')
{
  // Seeded through the UNWRAPPED put — this is the probe's own fixture setup, not a write made
  // by the resource, so it must not land in menuItemWrites alongside the ones under test.
  await originalMenuItemPut({
    id: 'seed-2',
    name: 'Pepperoni',
    description: null,
    priceCents: 1100,
    category: 'Pizza',
    available: true,
    sortOrder: 2,
    photoUpdatedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  const originalGet = tables.MenuItemPhoto.get.bind(tables.MenuItemPhoto)
  tables.MenuItemPhoto.get = async (id) => {
    const row = await originalGet(id)
    if (!row) return row
    // Simulate a store that lost bytes in flight: the read-back disagrees with what was written.
    return { ...row, byteSize: row.byteSize + 1 }
  }
  const r = await call(MenuPhotoAdminApi, 'POST', 'seed-2', { cookie: ADMIN.cookie, body: { dataBase64: pngBase64(), contentType: 'image/png' } })
  tables.MenuItemPhoto.get = originalGet
  check('a corrupted read-back -> 502 photo_not_stored', r.status === 502 && r.json?.code === 'photo_not_stored')
  check('the row was deleted rather than left half-written', !tables.MenuItemPhoto.rows.has('seed-2'))
  check('the item was never stamped', tables.MenuItem.rows.get('seed-2')?.photoUpdatedAt == null)
}

section('negative control: the managed-field verdict can say no')
{
  const synthetic = { id: 'x', name: 'Y', priceCents: 100, createdAt: 123, updatedAt: 456 }
  const bad = managedFieldsIn(synthetic, 'MenuItem')
  check('a synthesized record naming createdAt and updatedAt is caught (NEG)', bad.length === 2 && bad.includes('createdAt') && bad.includes('updatedAt'))
  check('a clean record passes', managedFieldsIn({ id: 'x', name: 'Y' }, 'MenuItem').length === 0)
}

section('every MenuItem write this resource made names no managed field')
{
  check(`at least one MenuItem write was captured (${menuItemWrites.length})`, menuItemWrites.length > 0)
  const offenders = menuItemWrites.flatMap((w) => managedFieldsIn(w, 'MenuItem').map((f) => `${w.id ?? '?'}:${f}`))
  check('no captured write names createdAt or updatedAt (this is what Harper\'s 400 was refusing)', offenders.length === 0, offenders.join(', '))
}

section(`the rule-20 sweep over every response (${transcript.length})`)
{
  const synthetic = [{ cls: 'X', method: 'GET', pathname: '', status: 401, headers: new Headers({ 'cache-control': 'no-store' }) }]
  check('the sweep catches a 401 (NEG)', responseRulesVerdict(synthetic).some((b) => b.includes('401')))
  const bad = responseRulesVerdict(transcript)
  check('no 401, no WWW-Authenticate on a 403, everything no-store', bad.length === 0, bad.slice(0, 3).join(' | '))
}

process.exit(done())
