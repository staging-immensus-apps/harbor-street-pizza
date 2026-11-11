#!/usr/bin/env node
// GENERATED — resources/AccountApi.js as shipped: the caller's own row only, sanitized;
// the profile write reaches `name` and nothing else. Immensus plan limits are not shown to an
// app's own users, which a control below holds.
// Anonymous and deactivated callers get 403 with no WWW-Authenticate.
//
// Hermetic: clock frozen, no network, no git.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { freezeClock } from './probe/frozen-clock.js'
freezeClock()
process.env.SESSION_SECRET = 'suite-secret-not-a-real-one'

const { checker } = await import('./probe/harness.js')
const { tables, resetTables } = await import('./probe/harperdb-stub.js')
const { call, userWithCookie, transcript, responseRulesVerdict } = await import('./probe/resource-call.js')
const { AccountApi } = await import('../resources/AccountApi.js')

const { check, section, done } = checker('account-acceptance')
resetTables()
const A = await userWithCookie('a@example.test', { name: 'Ada', passwordHash: 'salt:hash-that-must-never-leak' })
const B = await userWithCookie('b@example.test', { googleSub: '123' })
const GONE = await userWithCookie('gone@example.test', { deactivatedAt: '2026-06-01T00:00:00.000Z' })

section('anonymous and deactivated')
for (const [m, p, body] of [['GET', ''], ['PUT', 'profile', { name: 'x' }]]) {
  const r = await call(AccountApi, m, p, { body })
  check(`${m} /AccountApi/${p} anonymous → 403 auth_required, no WWW-Authenticate`, r.status === 403 && r.json?.code === 'auth_required' && !r.headers.get('www-authenticate'))
}
{
  const r = await call(AccountApi, 'GET', '', { cookie: GONE.cookie })
  check('a deactivated user → 403', r.status === 403 && r.json?.code === 'auth_required')
}

section('GET /AccountApi/')
{
  const r = await call(AccountApi, 'GET', '', { cookie: A.cookie })
  check('→ the caller\'s own user, sanitized', r.status === 200 && r.json?.user?.id === A.user.id && r.json.user.email === 'a@example.test' && !JSON.stringify(r.json).includes('hash-that-must-never-leak') && !('passwordHash' in r.json.user))
  check('→ the user and nothing else: no plan, no quota, no usage (NEG)', Object.keys(r.json ?? {}).join() === 'user')
  const rb = await call(AccountApi, 'GET', '', { cookie: B.cookie })
  check('B sees B', rb.status === 200 && rb.json?.user?.id === B.user.id)
  const sub = await call(AccountApi, 'GET', 'profile', { cookie: A.cookie })
  check('an unknown sub-path → 404', sub.status === 404)
}

section('PUT /AccountApi/profile')
{
  const r = await call(AccountApi, 'PUT', 'profile', { cookie: A.cookie, body: { name: '  Ada Lovelace  ', role: 'admin', passwordHash: 'x', email: 'evil@example.test', id: 'other' } })
  check('→ 200 with the trimmed name', r.status === 200 && r.json?.ok === true && r.json.user?.name === 'Ada Lovelace')
  const row = tables.User.rows.get(A.user.id)
  check('the stored row changed name and nothing else (role, hash, email, id untouched) (NEG)', row.name === 'Ada Lovelace' && row.role === 'member' && row.passwordHash === 'salt:hash-that-must-never-leak' && row.email === 'a@example.test' && row.id === A.user.id)
  const blank = await call(AccountApi, 'PUT', 'profile', { cookie: A.cookie, body: { name: '   ' } })
  check('a blank name clears it to null (rule 11: blank is absent)', blank.status === 200 && blank.json?.user?.name === null && tables.User.rows.get(A.user.id).name === null)
  const long = await call(AccountApi, 'PUT', 'profile', { cookie: A.cookie, body: { name: 'x'.repeat(121) } })
  check('a 121-character name → 400 (NEG)', long.status === 400)
  const wrong = await call(AccountApi, 'PUT', 'other', { cookie: A.cookie, body: { name: 'x' } })
  check('PUT to another sub-path → 404', wrong.status === 404)
  check('B\'s row was never touched', tables.User.rows.get(B.user.id).name === null)
}

section(`the rule-20 sweep over every response (${transcript.length})`)
{
  const bad = responseRulesVerdict(transcript)
  check('no 401, no WWW-Authenticate on a 403, everything no-store', bad.length === 0, bad.slice(0, 3).join(' | '))
}
process.exit(done())
