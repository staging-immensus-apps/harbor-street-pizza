#!/usr/bin/env node
// SEEDED — `lib/http.js`'s contract, and the one assertion in it that exists because a defect
// shipped: a path segment is DECODED.
//
// Hermetic: imports one module that imports nothing. No clock, no network, no git, no Harper.

import { checker } from './probe/harness.js'
import { NO_STORE, headerOf, json, pathFrom, queryParams, segmentsOf } from '../lib/http.js'

const { check, section, done, failures } = checker('http-acceptance')

section('negative control: these assertions can say no')
// The control is first and it is about the SUBJECT, not about the checker. If a decoder that does
// nothing would satisfy the real assertions below, they prove nothing — so the thing that must fail
// is an undecoded split, which is what `lib/http.js` once did.
const undecoded = (t) => {
  const p = (t?.pathname ?? String(t ?? '')).replace(/^\/+/, '').replace(/\/+$/, '')
  return p ? p.split('/') : []
}
// NOT compared against `segmentsOf` here, and that is the point. A control that compares the
// stand-in to the subject fires FIRST when the subject regresses and then exits, so the real
// assertions never run and nobody learns whether they discriminate — measured, by reddening this
// suite on purpose. The control's only job is to show the stand-in really is undecoded.
check('an UNDECODED split leaves the escape in place, so the assertions below have something to be unlike',
  undecoded({ pathname: '/items/a%3Ab' })[1] === 'a%3Ab')
check('…and it splits on a real slash, so it is a plausible stand-in and not a stub that answers nothing',
  undecoded({ pathname: '/items/42/history' }).length === 3)
// The shape that failed on a real build: a composite id with two
// colons. The stand-in must miss its row, or the composite case below could not fail.
const COMPOSITE = 'aud-7:meta:1729500000'
const COMPOSITE_PATH = '/aud-7%3Ameta%3A1729500000/file'
check('…and an UNDECODED split misses a two-colon composite row, so the composite case below can fail',
  undecoded({ pathname: COMPOSITE_PATH })[0] !== COMPOSITE)
if (failures.length) process.exit(done())

section('a sub-path is split into decoded segments')
check('plain segments survive unchanged', segmentsOf({ pathname: '/items/42/history' }).join(',') === 'items,42,history')
check('an escaped reserved character is DECODED', segmentsOf({ pathname: '/items/a%3Ab/history' })[1] === 'a:b')
check('an escaped SLASH stays inside its own segment rather than splitting the path',
  segmentsOf({ pathname: '/items/a%2Fb' }).length === 2 && segmentsOf({ pathname: '/items/a%2Fb' })[1] === 'a/b')
// This check's subject is "does not throw", so a throw is caught and reported as its verdict rather
// than ending the suite with every later assertion unrun.
const malformed = (() => { try { return segmentsOf({ pathname: '/items/100%' })[1] } catch (err) { return `threw ${err?.name}` } })()
check('a malformed escape is kept verbatim rather than throwing', malformed === '100%', malformed)
check('a segment with no escape in it is not put through the decoder at all', segmentsOf({ pathname: '/items/a+b' })[1] === 'a+b')
check('the resource root is no segments, not one empty one', segmentsOf({ pathname: '/' }).length === 0 && segmentsOf({ pathname: '' }).length === 0)
check('a plain string target works as well as a URL-ish one', segmentsOf('items/7')[1] === '7')
// Harper's `RequestTarget` for `/XApi?sort=a` and `/XApi/?sort=a`, as `harper@5.3.5` builds them (#111).
const noSlashQuery = { pathname: undefined, toString: () => '?sort=a' }
const slashQuery = { pathname: '/', toString: () => '/?sort=a' }
check('a query with no slash before it is the resource root, not a record id', pathFrom(noSlashQuery) === '' && segmentsOf(noSlashQuery).length === 0, String(segmentsOf(noSlashQuery)))
check('CONTROL: the same query with a slash gives the same answer', segmentsOf(slashQuery).length === 0)
check('a plain string target loses its query too, and keeps its path', segmentsOf('items/7?x=1').join(',') === 'items,7')
check('CONTROL: an ESCAPED question mark is part of an id and survives', segmentsOf({ pathname: '/items/a%3Fb' })[1] === 'a?b')
// What a resource does with the first segment is look a row up by it, so these two are asserted as
// lookups: the id the plan stored is the key, and the request has to land on it.
const rows = new Map([[COMPOSITE, { id: COMPOSITE }]])
const [compositeId, compositeSub] = segmentsOf({ pathname: COMPOSITE_PATH })
check('a two-colon composite id, requested percent-encoded, reaches its row and keeps its sub-route',
  rows.get(compositeId)?.id === COMPOSITE && compositeSub === 'file', JSON.stringify([compositeId, compositeSub]))
const spellings = ['/aud-7%3Ameta%3A1729500000', '/aud-7%3ameta%3a1729500000', '/aud-7:meta:1729500000']
  .map((pathname) => segmentsOf({ pathname })[0])
check('every spelling of that id reaches the same row — upper- and lower-case escapes and the literal colon',
  spellings.every((id) => rows.get(id)?.id === COMPOSITE), JSON.stringify(spellings))

section('pathFrom strips the slashes a caller cannot control')
check('leading and trailing slashes come off', pathFrom({ pathname: '/a/b/' }) === 'a/b')
check('the root is the empty string', pathFrom({ pathname: '/' }) === '')
check('pathFrom does NOT decode — segmentsOf is the only decoder', pathFrom({ pathname: '/a%3Ab' }) === 'a%3Ab')

section('query parameters, including the sub-path case that bit')
check('the resource root populates searchParams and it is used',
  queryParams({ searchParams: new URLSearchParams('sensor=a') }, null).get('sensor') === 'a')
// THE CASE THE HELPER EXISTS FOR. On a sub-path Harper leaves `searchParams` empty, so a resource
// that reads it directly silently ignores every filter it was given.
const onSubPath = { pathname: '/by-sensor', searchParams: new URLSearchParams() }
const self = { getContext: () => ({ request: { url: '/SummaryApi/by-sensor?sensor=a&since=2026-01-01' } }) }
check('an EMPTY searchParams falls back to the request context', queryParams(onSubPath, self).get('sensor') === 'a')
check('…and reads every parameter from it, not just the first', queryParams(onSubPath, self).get('since') === '2026-01-01')
check('a context that throws is survived rather than propagated',
  queryParams(onSubPath, { getContext: () => { throw new Error('no context here') } }).get('sensor') === null)
check('no context and no searchParams is empty, not a throw', [...queryParams({}, null).keys()].length === 0)

section('a JSON response carries no-store and the status it was given')
const r = json({ error: 'bad_since' }, 400)
check('the status is the one passed', r.status === 400)
check('the content type is JSON', r.headers.get('content-type') === 'application/json')
check('the response is not cacheable', r.headers.get('cache-control') === NO_STORE)
check('an extra header is merged rather than replacing the defaults',
  json({}, 200, { headers: { 'x-thing': '1' } }).headers.get('x-thing') === '1' &&
  json({}, 200, { headers: { 'x-thing': '1' } }).headers.get('cache-control') === NO_STORE)
check('the body is the serialized payload', await json({ a: 1 }).text() === '{"a":1}')

section('headerOf never throws, whatever it is handed')
check('a present header is returned', headerOf({ getContext: () => ({ headers: new Headers({ 'x-a': 'b' }) }) }, 'x-a') === 'b')
check('an absent header is null', headerOf({ getContext: () => ({ headers: new Headers() }) }, 'x-a') === null)
check('no context at all is null', headerOf(null, 'x-a') === null)
check('a throwing context is null', headerOf({ getContext: () => { throw new Error('x') } }, 'x-a') === null)

process.exit(done())
