#!/usr/bin/env node
// GENERATED — resources/MenuPhotoApi.js is public and read-only, so this probe's job is the
// MenuApi-probe shape: prove the bytes come back right, prove nothing is served that was not
// deliberately stored, and prove an anonymous caller gets 200 (not 403 — this route has no auth
// at all, by design, because a browser's <img> tag sends no cookie).
//
// Hermetic: clock frozen, no network, no git.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { freezeClock } from './probe/frozen-clock.js'
freezeClock()
process.env.SESSION_SECRET = 'suite-secret-not-a-real-one'

const { checker } = await import('./probe/harness.js')
const { tables, resetTables } = await import('./probe/harperdb-stub.js')
const { call, resource, transcript, responseRulesVerdict } = await import('./probe/resource-call.js')
const { MenuPhotoApi } = await import('../resources/MenuPhotoApi.js')
const { PHOTO_CONTENT_TYPES, photoRecord } = await import('../lib/photos.js')

const { check, section, done, failures } = checker('MenuPhotoApi-probe')

section('negative control: the sweep can say no')
{
  const synthetic = [{ cls: 'X', method: 'GET', pathname: '', status: 401, headers: new Headers({ 'cache-control': 'no-store' }) }]
  check('the sweep catches a 401 (NEG)', responseRulesVerdict(synthetic).some((b) => b.includes('401')))
}
if (failures.length) process.exit(done())

resetTables()

// A minimal real PNG signature and a minimal real JPEG signature, each padded with filler bytes
// so there is something past the signature to compare for an exact-bytes assertion.
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-a-fake-png-body')])

section('a stored photo is served with its exact bytes, its stored content type and an immutable cache header')
{
  await tables.MenuItemPhoto.put({ id: 'm1', contentType: 'image/png', byteSize: PNG_BYTES.length, data: PNG_BYTES, uploadedAt: '2026-01-01T00:00:00.000Z' })
  // Driven directly rather than through call(): call() reads the body with res.text(), which is
  // lossy for binary data, so the exact-bytes assertion below needs arrayBuffer() on the real Response.
  const res = await resource(MenuPhotoApi, {}).get({ pathname: 'm1' })
  const body = Buffer.from(await res.arrayBuffer())
  check('GET a stored png → 200', res.status === 200)
  check('…with the exact stored bytes', body.equals(PNG_BYTES))
  check('…the stored content type', res.headers.get('content-type') === 'image/png')
  check('…the right content-length', res.headers.get('content-length') === String(PNG_BYTES.length))
  check('…and a public, immutable, long-lived cache header (the one route that is deliberately cacheable)', res.headers.get('cache-control') === 'public, max-age=31536000, immutable')
}

section('a row stored the way photoRecord() writes it (a real Blob) is served correctly')
{
  const rec = photoRecord('m-blob', { buffer: PNG_BYTES, contentType: 'image/png' })
  await tables.MenuItemPhoto.put(rec)
  const res = await resource(MenuPhotoApi, {}).get({ pathname: 'm-blob' })
  const body = Buffer.from(await res.arrayBuffer())
  check('GET a photoRecord()-shaped row → 200', res.status === 200)
  check('…with the exact stored bytes', body.equals(PNG_BYTES))
  check('…the stored content type', res.headers.get('content-type') === 'image/png')
  check('…the right content-length', res.headers.get('content-length') === String(PNG_BYTES.length))
}

section('every other shape photoBytes() now accepts also serves 200 — a store handing the column back differently is the other candidate cause QA named')
{
  await tables.MenuItemPhoto.put({ id: 'm-buf', contentType: 'image/png', byteSize: PNG_BYTES.length, data: PNG_BYTES, uploadedAt: '2026-01-01T00:00:00.000Z' })
  const rBuf = await resource(MenuPhotoApi, {}).get({ pathname: 'm-buf' })
  check('a raw Buffer in data → 200', rBuf.status === 200 && Buffer.from(await rBuf.arrayBuffer()).equals(PNG_BYTES))

  const u8 = new Uint8Array(PNG_BYTES)
  await tables.MenuItemPhoto.put({ id: 'm-u8', contentType: 'image/png', byteSize: PNG_BYTES.length, data: u8, uploadedAt: '2026-01-01T00:00:00.000Z' })
  const rU8 = await resource(MenuPhotoApi, {}).get({ pathname: 'm-u8' })
  check('a Uint8Array in data → 200', rU8.status === 200 && Buffer.from(await rU8.arrayBuffer()).equals(PNG_BYTES))

  const streamed = { stream () { return (async function * () { yield PNG_BYTES })() } }
  await tables.MenuItemPhoto.put({ id: 'm-stream', contentType: 'image/png', byteSize: PNG_BYTES.length, data: streamed, uploadedAt: '2026-01-01T00:00:00.000Z' })
  const rStream = await resource(MenuPhotoApi, {}).get({ pathname: 'm-stream' })
  check('an object exposing stream() in data → 200', rStream.status === 200 && Buffer.from(await rStream.arrayBuffer()).equals(PNG_BYTES))
}

section('a row whose data is a shape nothing can read, or is absent → still 404 (NEG: these are not simply "everything serves")')
{
  await tables.MenuItemPhoto.put({ id: 'm-unreadable', contentType: 'image/png', byteSize: PNG_BYTES.length, data: { nothingUsefulHere: true }, uploadedAt: '2026-01-01T00:00:00.000Z' })
  const rUnreadable = await call(MenuPhotoApi, 'GET', 'm-unreadable')
  check('an unreadable data shape → 404 (NEG)', rUnreadable.status === 404 && rUnreadable.json?.error === 'not found')

  await tables.MenuItemPhoto.put({ id: 'm-nodata', contentType: 'image/png', byteSize: 0, uploadedAt: '2026-01-01T00:00:00.000Z' })
  const rNoData = await call(MenuPhotoApi, 'GET', 'm-nodata')
  check('no data column at all → 404 (NEG)', rNoData.status === 404 && rNoData.json?.error === 'not found')
}

section('?v= in the query changes nothing about the answer (QA checked both)')
{
  const withoutV = await call(MenuPhotoApi, 'GET', 'm1')
  const withV = await call(MenuPhotoApi, 'GET', 'm1', { query: 'v=2026-01-01T00%3A00%3A00.000Z' })
  check('with no ?v= → 200', withoutV.status === 200)
  check('with ?v= → 200, same as without', withV.status === 200)
}

section('anonymous reads it with no cookie at all (this route carries no auth, by design)')
{
  const r = await call(MenuPhotoApi, 'GET', 'm1')
  check('GET /MenuPhotoApi/m1 with no cookie → 200, not 403', r.status === 200)
}

section('no id at all → 404 (there is no listing)')
{
  const r = await call(MenuPhotoApi, 'GET', '')
  check('GET /MenuPhotoApi/ → 404', r.status === 404 && r.json?.error === 'not found')
}

section('a missing photo → 404')
{
  const r = await call(MenuPhotoApi, 'GET', 'no-such-item')
  check('GET /MenuPhotoApi/no-such-item → 404', r.status === 404 && r.json?.error === 'not found')
}

section('a sub-path past the id → 404 (read by primary key only)')
{
  const r = await call(MenuPhotoApi, 'GET', 'm1/extra')
  check('GET /MenuPhotoApi/m1/extra → 404', r.status === 404 && r.json?.error === 'not found')
}

section('the stub would surface an unsupported content type (the fixture can fail)')
{
  check('image/gif is not one of the two types this app ever stores (NEG precondition)', !PHOTO_CONTENT_TYPES.includes('image/gif'))
}

section('a stored row carrying a content type the app does not store → 404, never reflected')
{
  await tables.MenuItemPhoto.put({ id: 'm2', contentType: 'image/gif', byteSize: 19, data: Buffer.from('not-checked-anyway!'), uploadedAt: '2026-01-01T00:00:00.000Z' })
  const r = await call(MenuPhotoApi, 'GET', 'm2')
  check('GET /MenuPhotoApi/m2 → 404 (NEG: a stored type outside PHOTO_CONTENT_TYPES is refused, never served as-is)', r.status === 404 && r.json?.error === 'not found')
}

section('a stored row whose bytes do not match their declared signature → 404, and no bytes leak out')
{
  await tables.MenuItemPhoto.put({ id: 'm3', contentType: 'image/png', byteSize: 9, data: Buffer.from('not-a-png'), uploadedAt: '2026-01-01T00:00:00.000Z' })
  const res = await resource(MenuPhotoApi, {}).get({ pathname: 'm3' })
  const text = await res.text()
  check('GET /MenuPhotoApi/m3 → 404 (NEG: declared png, the bytes are not one)', res.status === 404)
  check('…and the body is the plain JSON refusal, not the stored bytes', text === JSON.stringify({ error: 'not found' }))
}

section('every verb but GET is 404, not merely unimplemented')
{
  for (const [m, body] of [['POST', {}], ['PUT', {}], ['DELETE', undefined]]) {
    const r = await call(MenuPhotoApi, m, 'm1', { body })
    check(`${m} /MenuPhotoApi/m1 → 404`, r.status === 404 && r.json?.error === 'not found')
  }
}

section(`the rule-20 sweep (${transcript.length}), split because this route is cacheable on purpose`)
{
  // The photo bytes response is deliberately NOT no-store (resources/MenuPhotoApi.js's header),
  // so the ordinary whole-transcript responseRulesVerdict() cannot run over this probe the way it
  // does in every owner-scoped probe. The 401/WWW-Authenticate half still has to hold everywhere;
  // the no-store half is checked only over the JSON (404) refusals, which transcript entries whose
  // body parsed as JSON — the byte response never parses, so it is excluded by construction.
  const authBad = []
  for (const r of transcript) {
    const where = `${r.cls} ${r.method} ${r.pathname}`
    if (r.status === 401) authBad.push(`${where} answered 401`)
    if (r.status === 403 && r.headers?.get?.('www-authenticate')) authBad.push(`${where} carried WWW-Authenticate`)
  }
  check('no 401 anywhere, no WWW-Authenticate on any 403, over every response', authBad.length === 0, authBad.join(' | '))

  const jsonOnly = transcript.filter((r) => r.json !== null)
  const bad = responseRulesVerdict(jsonOnly)
  check('every JSON refusal is no-store', bad.length === 0, bad.slice(0, 3).join(' | '))
}

process.exit(done())
