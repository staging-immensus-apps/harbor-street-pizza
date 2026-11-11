#!/usr/bin/env node
// lib/session.js — the two helpers every owner-scoped resource in an app opens with (rule 19), driven
// through a resource this suite writes itself, because the sign-in kit ships no owner-scoped table of its
// own. loadCaller re-reads the row on every request, so a deactivated user, a changed
// role or a row reassigned under a live cookie takes effect on the next request; canSee decides every read
// and every write on a known row. The canSee verdict is self-tested against a leaky one first.
//
// Hermetic: clock frozen, no network, no git.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { freezeClock } from './probe/frozen-clock.js'
freezeClock()
process.env.SESSION_SECRET = 'suite-secret-not-a-real-one'

const { checker } = await import('./probe/harness.js')
const { tables, resetTables, Resource } = await import('./probe/harperdb-stub.js')
const { call, userWithCookie, transcript, responseRulesVerdict } = await import('./probe/resource-call.js')
const { loadCaller, canSee } = await import('../lib/session.js')
const { json, segmentsOf } = await import('../lib/http.js')
const { runAuthed } = await import('../lib/sign-in-support.js')

const { check, section, done, failures } = checker('session-acceptance')

/** Who may see a row, as a resource decides it: `see` is the rule under test. */
function visibilityVerdict (see) {
  const owner = { userId: 'a', isAdmin: false }
  const stranger = { userId: 'b', isAdmin: false }
  const admin = { userId: 'c', isAdmin: true }
  const row = { id: 'r', ownerUserId: 'a' }
  const bad = []
  if (!see(owner, row)) bad.push('the owner cannot see their own row')
  if (!see(admin, row)) bad.push('an admin cannot see across owners')
  if (see(stranger, row)) bad.push('LEAK: a stranger can see the row')
  if (see(owner, null)) bad.push('a missing row reads as visible')
  if (see(null, row)) bad.push('no caller can see the row')
  return bad
}

section('negative control: the visibility verdict can say no')
check('a rule that lets everybody see is caught as a leak', visibilityVerdict(() => true).some((b) => b.startsWith('LEAK')))
check('a rule that lets nobody see is caught too', visibilityVerdict(() => false).includes('the owner cannot see their own row'))
if (failures.length) process.exit(done())

section('canSee')
{
  const bad = visibilityVerdict(canSee)
  check('the owner and an admin see a row, a stranger does not, and a missing row or caller is not visible', bad.length === 0, bad.join(' | '))
  check('isAdmin must be exactly true: a truthy value is not an admin (NEG)', canSee({ userId: 'b', isAdmin: 'true' }, { ownerUserId: 'a' }) === false)
  check('another owner field can be named', canSee({ userId: 'a' }, { reporterUserId: 'a' }, 'reporterUserId') === true && canSee({ userId: 'a' }, { ownerUserId: 'a' }, 'reporterUserId') === false)
}

// The shape every owner-scoped resource an app writes takes: loadCaller, then canSee. Not exported anywhere.
class NotesApi extends Resource {
  static loadAsInstance = false
  async get (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      const caller = await loadCaller(this)
      const [id] = segmentsOf(target)
      if (!id) return json({ userId: caller.userId, isAdmin: caller.isAdmin })
      const row = await tables.Note.get(id)
      if (!canSee(caller, row)) return json({ error: 'not found' }, 404)
      return json({ note: row })
    })
  }
}

resetTables()
const A = await userWithCookie('a@example.test')
const B = await userWithCookie('b@example.test')
const ADMIN = await userWithCookie('admin@example.test', { role: 'admin' })
const GONE = await userWithCookie('gone@example.test', { deactivatedAt: '2026-06-01T00:00:00.000Z' })
await tables.Note.put({ id: 'of-a', ownerUserId: A.user.id })

section('loadCaller: anonymous and deactivated')
{
  const anon = await call(NotesApi, 'GET', '')
  check('anonymous → 403 auth_required, no WWW-Authenticate (rule 20)', anon.status === 403 && anon.json?.code === 'auth_required' && !anon.headers.get('www-authenticate'))
  const gone = await call(NotesApi, 'GET', '', { cookie: GONE.cookie })
  check('a deactivated user with a live cookie → 403 (the row is re-read)', gone.status === 403 && gone.json?.code === 'auth_required')
}

section('loadCaller and canSee together: a row is its owner\'s, or 404')
{
  check('the owner reads it', (await call(NotesApi, 'GET', 'of-a', { cookie: A.cookie })).status === 200)
  const cross = await call(NotesApi, 'GET', 'of-a', { cookie: B.cookie })
  check('another owner gets 404, not 403, and no row data (NEG)', cross.status === 404 && !cross.json?.note)
  const missing = await call(NotesApi, 'GET', 'no-such-row', { cookie: B.cookie })
  check('a missing row gets the same 404', missing.status === 404 && missing.json?.error === cross.json?.error)
  check('an admin reads across owners', (await call(NotesApi, 'GET', 'of-a', { cookie: ADMIN.cookie })).status === 200)
}

section('the role comes from the row, not the cookie')
{
  const before = await call(NotesApi, 'GET', '', { cookie: ADMIN.cookie })
  check('PRECONDITION: the cookie reads as an admin', before.json?.isAdmin === true)
  await tables.User.put({ ...ADMIN.user, role: 'member' })
  const demoted = await call(NotesApi, 'GET', '', { cookie: ADMIN.cookie })
  check('a demoted admin with an unexpired cookie is a member on the next request', demoted.status === 200 && demoted.json?.isAdmin === false)
  check('…and can no longer read across owners (NEG)', (await call(NotesApi, 'GET', 'of-a', { cookie: ADMIN.cookie })).status === 404)
  await tables.User.put({ ...ADMIN.user, role: 'admin' })
}

section('a session whose ROW was reassigned is refused across owners')
{
  // loadCaller's half of sessionMatchesRow (lib/auth.js). requireAdmin's half is driven in auth-acceptance;
  // this is the half that matters for rule 19, because canSee() lets an admin read and write ACROSS owners,
  // so a session left pointing at a reassigned admin row reaches every row in the table. The state is the one
  // a lost bootstrap race produces: a validly signed cookie naming a row whose email is now somebody else's
  // (resources/Bootstrap.js's header has the measurement). Written by rewriting the row rather than by racing
  // Bootstrap, because what is under test is the GUARD, not the mechanism that produces the state.
  const works = await call(NotesApi, 'GET', 'of-a', { cookie: ADMIN.cookie })
  check('PRECONDITION: that cookie reads across owners while it still matches its row', works.status === 200)
  await tables.User.put({ ...ADMIN.user, email: 'someone-else@example.test' })
  const reassigned = await call(NotesApi, 'GET', 'of-a', { cookie: ADMIN.cookie })
  check('after the row is reassigned the same cookie → 403 auth_required', reassigned.status === 403 && reassigned.json?.code === 'auth_required')
  check('…and it names nothing about why (rule 25: the same refusal a deactivated row gets)', reassigned.json?.error === 'Authentication required' && !/email|mismatch|owner|reassign/i.test(JSON.stringify(reassigned.json)))
  // NEG: the guard is refusing the MISMATCH and not the cookie. Put the row's email back.
  await tables.User.put({ ...ADMIN.user, email: ADMIN.user.email })
  check('the very same cookie works again once the row is its own (NEG)', (await call(NotesApi, 'GET', 'of-a', { cookie: ADMIN.cookie })).status === 200)
}

section(`the rule-20 sweep over every response (${transcript.length})`)
{
  const synthetic = [{ cls: 'X', method: 'GET', pathname: '', status: 401, headers: new Headers({ 'cache-control': 'no-store' }) }]
  check('the sweep catches a 401 (NEG)', responseRulesVerdict(synthetic).some((b) => b.includes('401')))
  const bad = responseRulesVerdict(transcript)
  check('no 401, no WWW-Authenticate on a 403, everything no-store', bad.length === 0, bad.slice(0, 3).join(' | '))
}
process.exit(done())
