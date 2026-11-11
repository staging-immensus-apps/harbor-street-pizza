#!/usr/bin/env node
// GENERATED — lib/plan.js: the tier comes from IMMENSUS_TIER and anything
// unrecognised fails CLOSED to trial; every quota has a getter; the accounts cap and the
// helpers an app's own resource wires its row cap with refuse with 403 quota_exceeded and never
// 401. The fail-closed verdict is self-tested against a permissive resolver first.
//
// Hermetic: clock frozen, no git, and no network but a fake Resend (below).

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { freezeClock } from './probe/frozen-clock.js'
freezeClock()
process.env.SESSION_SECRET = 'suite-secret-not-a-real-one'
process.env.PUBLIC_APP_URL = 'https://app.example.test'
delete process.env.IMMENSUS_TIER
delete process.env.EMAIL_FROM
delete process.env.OWNER_EMAIL
// MAIL IS SET UP, because the link requests below are about the accounts quota and a link request on
// an app with no mail key is refused before the quota is reached. The fake answers every send
// and prints its text, which is where the `token=` reads below look; any other `fetch` throws.
process.env.RESEND_API_KEY = 're_suite_fake'
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== 'https://api.resend.com/emails') throw new Error(`plan-acceptance has no network: ${url}`)
  const body = JSON.parse(init.body)
  console.log(`[fake-resend] to=${body.to}\n  ${String(body.text ?? '')}`)
  return new Response(JSON.stringify({ id: 're_suite' }), { status: 200, headers: { 'content-type': 'application/json' } })
}

const { checker } = await import('./probe/harness.js')
const { tables, resetTables, Resource } = await import('./probe/harperdb-stub.js')
const { call, userWithCookie, captureLog, transcript, responseRulesVerdict } = await import('./probe/resource-call.js')
const plan = await import('../lib/plan.js')
const { AdminApi } = await import('../resources/AdminApi.js')
const { AuthApi } = await import('../resources/AuthApi.js')
const google = await import('./probe/google-auth-stub.js')
const { loadCaller } = await import('../lib/session.js')
const { json } = await import('../lib/http.js')
const { runAuthed } = await import('../lib/sign-in-support.js')

const { check, section, done, failures } = checker('plan-acceptance')
const { TIERS, QUOTA_NAMES, DEFAULT_TIER, currentTier, quota, withinQuota, quotaResponse, countRows, atQuota, overQuotaAfterWrite } = plan

/** A resolver fails closed when every unrecognised value lands on the default, never on a bigger tier. */
function failClosedVerdict (resolve) {
  const bad = []
  for (const v of ['', ' ', 'enterprise', 'BUILDER ', 'builder;', 'undefined', 'null']) {
    const t = resolve(v)
    if (t !== DEFAULT_TIER) bad.push(`"${v}" resolved to ${t}, not ${DEFAULT_TIER}`)
  }
  return bad
}
const withTier = (v, fn) => { const prev = process.env.IMMENSUS_TIER; if (v === undefined) delete process.env.IMMENSUS_TIER; else process.env.IMMENSUS_TIER = v; try { return fn() } finally { if (prev === undefined) delete process.env.IMMENSUS_TIER; else process.env.IMMENSUS_TIER = prev } }

section('negative control: the fail-closed verdict can say no')
check('a resolver that answers builder for anything is caught', failClosedVerdict(() => 'builder').length > 0)
check('a resolver that trims and lowercases is caught too (" BUILDER " must not become builder)', failClosedVerdict((v) => (v.trim().toLowerCase() in TIERS ? v.trim().toLowerCase() : DEFAULT_TIER)).some((b) => b.includes('BUILDER')))
check('a resolver that always answers trial passes', failClosedVerdict(() => DEFAULT_TIER).length === 0)
if (failures.length) process.exit(done())

section('the tier')
check('the three tiers exist with every quota', ['trial', 'tinkerer', 'builder'].every((t) => t in TIERS && QUOTA_NAMES.every((q) => q in TIERS[t])))
check('quotas grow with the tier and builder rows are unlimited', TIERS.trial.rowsPerOwner < TIERS.tinkerer.rowsPerOwner && TIERS.tinkerer.rowsPerOwner < TIERS.builder.rowsPerOwner && TIERS.builder.rowsPerOwner === Infinity)
check('unset IMMENSUS_TIER → trial', withTier(undefined, currentTier) === 'trial')
check('IMMENSUS_TIER=tinkerer → tinkerer; builder → builder', withTier('tinkerer', currentTier) === 'tinkerer' && withTier('builder', currentTier) === 'builder')
check('the match is exact: "Builder" and "builder " are misconfigurations and read as trial (NEG)', withTier('Builder', currentTier) === 'trial' && withTier('builder ', currentTier) === 'trial')
{
  const bad = failClosedVerdict((v) => withTier(v, currentTier))
  check('every unrecognised value fails closed to trial', bad.length === 0, bad.join(' | '))
}
check('quota() reads the current tier and an explicit one', withTier('trial', () => quota('rowsPerOwner')) === TIERS.trial.rowsPerOwner && quota('members', 'builder') === Infinity)
check('quota() throws on a name it does not define (a typo is not "unlimited")', (() => { try { quota('rowsPerOwnr'); return false } catch { return true } })())
check('withinQuota is strict', withinQuota('rowsPerOwner', TIERS.trial.rowsPerOwner - 1, 'trial') === true && withinQuota('rowsPerOwner', TIERS.trial.rowsPerOwner, 'trial') === false)
{
  const r = quotaResponse('rowsPerOwner', 'trial')
  const body = JSON.parse(await r.text())
  check('quotaResponse is 403 quota_exceeded, no-store, no WWW-Authenticate, with the limit and tier', r.status === 403 && body.code === 'quota_exceeded' && body.limit === TIERS.trial.rowsPerOwner && body.tier === 'trial' && /no-store/.test(r.headers.get('cache-control')) && !r.headers.get('www-authenticate'))
  const b = JSON.parse(await quotaResponse('members', 'builder').text())
  check('an unlimited quota serializes as limit: null, never Infinity', b.limit === null && !JSON.stringify(b).includes('Infinity'))
}

section('countRows is bounded by its cap')
resetTables()
for (let i = 0; i < 10; i++) await tables.Item.put({ id: `r${i}`, ownerUserId: 'o', createdAt: '2026-06-01T00:00:00.000Z' })
check('10 rows, cap 3 → 3', await countRows(tables.Item, [{ attribute: 'ownerUserId', value: 'o' }], 3) === 3)
check('10 rows, no cap → 10', await countRows(tables.Item, [{ attribute: 'ownerUserId', value: 'o' }]) === 10)
check('a condition that matches nothing → 0', await countRows(tables.Item, [{ attribute: 'ownerUserId', value: 'nobody' }], 3) === 0)
{
  const origSearch = tables.Item.search.bind(tables.Item)
  let searches = 0
  tables.Item.search = (...a) => { searches++; return origSearch(...a) }
  const inf = await atQuota(tables.Item, [{ attribute: 'ownerUserId', value: 'o' }], Infinity)
  check('atQuota with an infinite cap answers false and reads NOTHING', inf === false && searches === 0)
  const finite = await atQuota(tables.Item, [{ attribute: 'ownerUserId', value: 'o' }], 5)
  check('atQuota with a finite cap reads once and answers by the cap', finite === true && searches === 1)
  tables.Item.search = origSearch
}

section('the row cap, as an app\'s own resource wires it')
resetTables()
{
  // The sign-in kit ships no owner-scoped table, so the resource is written here: the
  // shape the platform's worked example teaches, reduced to the part these helpers are for.
  class ItemsApi extends Resource {
    static loadAsInstance = false
    async post (target) {
      target.checkPermission = false
      return runAuthed(async () => {
        const caller = await loadCaller(this)
        const cap = quota('rowsPerOwner')
        const ownerCondition = [{ attribute: 'ownerUserId', value: caller.userId }]
        if (await atQuota(tables.Item, ownerCondition, cap)) return quotaResponse('rowsPerOwner')
        const row = { id: crypto.randomUUID(), ownerUserId: caller.userId, createdAt: '2026-06-01T00:00:00.000Z' }
        await tables.Item.put(row)
        if (await overQuotaAfterWrite(tables.Item, ownerCondition, cap)) {
          await tables.Item.delete(row.id)
          return quotaResponse('rowsPerOwner')
        }
        return json({ item: row }, 201)
      })
    }
  }
  process.env.IMMENSUS_TIER = 'trial'
  const cap = TIERS.trial.rowsPerOwner
  const A = await userWithCookie('a@example.test')
  const B = await userWithCookie('b@example.test')
  for (let i = 0; i < cap - 1; i++) await tables.Item.put({ id: `a${i}`, ownerUserId: A.user.id, createdAt: '2026-06-01T00:00:00.000Z' })
  const last = await call(ItemsApi, 'POST', '', { cookie: A.cookie, body: {} })
  check(`row ${cap} of ${cap} → 201`, last.status === 201)
  const over = await call(ItemsApi, 'POST', '', { cookie: A.cookie, body: {} })
  check(`row ${cap + 1} → 403 quota_exceeded with the limit (NEG)`, over.status === 403 && over.json?.code === 'quota_exceeded' && over.json.limit === cap && over.json.quota === 'rowsPerOwner')
  check('…and the row was not written', [...tables.Item.rows.values()].filter((m) => m.ownerUserId === A.user.id).length === cap)
  const other = await call(ItemsApi, 'POST', '', { cookie: B.cookie, body: {} })
  check('another owner is unaffected → 201 (the cap is per owner)', other.status === 201)
  // Two creates racing at cap − 1: first the naive shape under the same harness overshoots
  // (the race is real), then the helpers, which must never leave the table over the cap at rest.
  const C = await userWithCookie('c@example.test')
  const seedC = async () => { for (const id of [...tables.Item.rows.keys()].filter((k) => tables.Item.rows.get(k).ownerUserId === C.user.id)) await tables.Item.delete(id); for (let i = 0; i < cap - 1; i++) await tables.Item.put({ id: `c${i}`, ownerUserId: C.user.id, createdAt: '2026-06-01T00:00:00.000Z' }) }
  const rowsOfC = () => [...tables.Item.rows.values()].filter((m) => m.ownerUserId === C.user.id).length
  await seedC()
  const naive = async (id) => {
    let n = 0
    for await (const _ of tables.Item.search({ conditions: [{ attribute: 'ownerUserId', value: C.user.id }] })) n++
    if (n >= cap) return 403
    await tables.Item.put({ id, ownerUserId: C.user.id, createdAt: '2026-06-01T00:00:00.000Z' })
    return 201
  }
  const naiveOut = await Promise.all([naive('race-1'), naive('race-2')])
  check('count-then-write under the same harness lands one row over the cap (the race is real) (NEG)', naiveOut.every((st) => st === 201) && rowsOfC() === cap + 1)
  await seedC()
  const raced = await Promise.all([
    call(ItemsApi, 'POST', '', { cookie: C.cookie, body: {} }),
    call(ItemsApi, 'POST', '', { cookie: C.cookie, body: {} }),
  ])
  check('two concurrent creates at cap − 1 → the table is never over the cap at rest', rowsOfC() <= cap, `${rowsOfC()} rows, statuses ${raced.map((r) => r.status).join(',')}`)
  check('…and every refusal was 403 quota_exceeded, every success 201', raced.every((r) => (r.status === 201) || (r.status === 403 && r.json?.code === 'quota_exceeded')))
  process.env.IMMENSUS_TIER = 'builder'
  const origSearch = tables.Item.search.bind(tables.Item)
  let searches = 0
  tables.Item.search = (...a) => { searches++; return origSearch(...a) }
  const unlimited = await call(ItemsApi, 'POST', '', { cookie: A.cookie, body: {} })
  tables.Item.search = origSearch
  check('on builder the same owner may add more → 201', unlimited.status === 201)
  check('…and the write scanned the table zero times (an infinite cap is never counted against) (NEG: a status code alone could not see this)', searches === 0, `${searches} search(es)`)
  process.env.IMMENSUS_TIER = 'nonsense'
  const closed = await call(ItemsApi, 'POST', '', { cookie: A.cookie, body: {} })
  check('an unknown tier enforces trial\'s cap (fails closed) → 403 (NEG)', closed.status === 403 && closed.json?.tier === 'trial')
}

section('enforcement: AdminApi accounts')
resetTables()
{
  process.env.IMMENSUS_TIER = 'trial'
  const cap = TIERS.trial.members
  const ADMIN = await userWithCookie('admin@example.test', { role: 'admin' })
  for (let i = tables.User.rows.size; i < cap; i++) await tables.User.put({ id: `u${i}`, email: `u${i}@example.test`, role: 'member', createdAt: '2026-06-01T00:00:00.000Z' })
  check(`${cap} accounts exist`, tables.User.rows.size === cap)
  await captureLog(() => call(AdminApi, 'POST', 'users/invite', { cookie: ADMIN.cookie, body: { email: 'new@example.test' } }))
  const over = transcript.at(-1)
  check(`inviting account ${cap + 1} → 403 quota_exceeded and no row (NEG)`, over.status === 403 && over.json?.code === 'quota_exceeded' && over.json.quota === 'members' && tables.User.rows.size === cap)
  // Two invites racing at cap − 1 (one account freed first).
  await tables.User.delete('u9')
  check(`${cap - 1} accounts`, tables.User.rows.size === cap - 1)
  await captureLog(() => Promise.all([
    call(AdminApi, 'POST', 'users/invite', { cookie: ADMIN.cookie, body: { email: 'race-a@example.test' } }),
    call(AdminApi, 'POST', 'users/invite', { cookie: ADMIN.cookie, body: { email: 'race-b@example.test' } }),
  ]))
  const racedInvites = transcript.slice(-2)
  check('two concurrent invites at cap − 1 → never over the cap at rest', tables.User.rows.size <= cap, `${tables.User.rows.size} accounts, statuses ${racedInvites.map((r) => r.status).join(',')}`)
  check('…each answered 200 or 403 quota_exceeded', racedInvites.every((r) => r.status === 200 || (r.status === 403 && r.json?.code === 'quota_exceeded')))
  for (const e of ['race-a@example.test', 'race-b@example.test']) for (const u of [...tables.User.rows.values()].filter((u) => u.email === e)) await tables.User.delete(u.id)
  await tables.User.put({ id: 'u9', email: 'u9@example.test', role: 'member', createdAt: '2026-06-01T00:00:00.000Z' })
  await captureLog(() => call(AdminApi, 'POST', 'users/invite', { cookie: ADMIN.cookie, body: { email: 'u5@example.test' } }))
  const existing = transcript.at(-1)
  check('re-inviting an existing account is not a new account → 200', existing.status === 200 && existing.json?.existing === true)
  process.env.IMMENSUS_TIER = 'builder'
  const origUserSearch = tables.User.search.bind(tables.User)
  let userSearches = 0
  tables.User.search = (...a) => { userSearches++; return origUserSearch(...a) }
  await captureLog(() => call(AdminApi, 'POST', 'users/invite', { cookie: ADMIN.cookie, body: { email: 'new@example.test' } }))
  tables.User.search = origUserSearch
  const ok = transcript.at(-1)
  check('on builder the invite goes through → 200 and the row exists', ok.status === 200 && tables.User.rows.size === cap + 1)
  check('…and the User table was searched exactly once (the email lookup), never for the count', userSearches === 1, `${userSearches} search(es)`)
}

section('enforcement: the self-serve sign-ups count against accounts too')
resetTables()
{
  process.env.IMMENSUS_TIER = 'trial'
  process.env.AUTH_OPEN_SIGNUP = 'true'
  process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com'
  const cap = TIERS.trial.members
  for (let i = 0; i < cap; i++) await tables.User.put({ id: `u${i}`, email: `u${i}@example.test`, role: 'member', createdAt: '2026-06-01T00:00:00.000Z' })
  const linksBefore = tables.MagicLink.rows.size
  const log = await captureLog(() => call(AuthApi, 'POST', 'request-link', { body: { email: 'stranger@example.test' } }))
  const link = transcript.at(-1)
  check(`at ${cap} accounts a link request for a NEW address still answers 200 { ok } (no enumeration)`, link.status === 200 && link.json?.ok === true)
  check('…but no account was created and no link was issued or logged', tables.User.rows.size === cap && tables.MagicLink.rows.size === linksBefore && !/token=/.test(log))
  const known = await captureLog(() => call(AuthApi, 'POST', 'request-link', { body: { email: 'u3@example.test' } }))
  check('an EXISTING account still gets its link at the cap', /token=/.test(known) && tables.MagicLink.rows.size === linksBefore + 1)
  google.script({ email: 'gstranger@example.test', email_verified: true, name: 'G', sub: '777' })
  const g = await call(AuthApi, 'POST', 'google', { body: { credential: 'new' } })
  check('a first Google sign-in for a NEW address at the cap → 403 quota_exceeded, no row, no cookie', g.status === 403 && g.json?.code === 'quota_exceeded' && g.json.quota === 'members' && tables.User.rows.size === cap && g.cookies.length === 0)
  google.script({ email: 'u4@example.test', email_verified: true, name: 'U4', sub: '444' })
  const gKnown = await call(AuthApi, 'POST', 'google', { body: { credential: 'known' } })
  check('a Google sign-in for an EXISTING account at the cap → 200', gKnown.status === 200 && tables.User.rows.size === cap)
  process.env.IMMENSUS_TIER = 'builder'
  await captureLog(() => call(AuthApi, 'POST', 'request-link', { body: { email: 'stranger@example.test' } }))
  check('on builder the same link request creates the account', tables.User.rows.size === cap + 1)
  delete process.env.GOOGLE_CLIENT_ID
}

section('the owner\'s account is outside the accounts quota while the administrator\'s seat is theirs')
resetTables()
{
  // The app owner's email becomes the first admin, and nobody else's sign-up closes
  // the seat. Open sign-up makes an account BEFORE any email is read, so without this a stranger could
  // fill the quota with made-up addresses and the owner could never make the account that becomes the
  // administrator. The exemption is that one account, and only while no active administrator exists
  // (lib/auth.js `ownerMayJoin`) — the same exemption the first-come founder has always had.
  process.env.IMMENSUS_TIER = 'trial'
  process.env.AUTH_OPEN_SIGNUP = 'true'
  process.env.OWNER_EMAIL = 'owner@example.test'
  process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com'
  const cap = TIERS.trial.members
  const fill = async () => { resetTables(); for (let i = 0; i < cap; i++) await tables.User.put({ id: `u${i}`, email: `u${i}@example.test`, role: 'member', createdAt: '2026-06-01T00:00:00.000Z' }) }
  const tokenIn = (log) => { const t = (log.match(/token=([A-Za-z0-9_%-]+)/) ?? [])[1]; return t ? decodeURIComponent(t) : null }
  try {
    await fill()
    const strangerLog = await captureLog(() => call(AuthApi, 'POST', 'request-link', { body: { email: 'late-stranger@example.test' } }))
    check(`PRECONDITION: at ${cap} accounts a stranger's new address gets no account and no link`, tables.User.rows.size === cap && !/token=/.test(strangerLog))
    const ownerLog = await captureLog(() => call(AuthApi, 'POST', 'request-link', { body: { email: 'Owner@Example.test' } }))
    const token = tokenIn(ownerLog)
    check('the owner\'s address still gets its account and a link, one over the cap', tables.User.rows.size === cap + 1 && Boolean(token))
    const signedIn = await call(AuthApi, 'GET', 'verify', { url: `/AuthApi/verify?token=${encodeURIComponent(token ?? 'none')}` })
    const owner = [...tables.User.rows.values()].find((u) => u.email === 'owner@example.test')
    check('…and redeeming it makes the owner the administrator', signedIn.status === 302 && owner?.role === 'admin')

    await fill()
    google.script({ email: 'owner@example.test', email_verified: true, name: 'Owner', sub: 'g-owner-quota' })
    const g = await call(AuthApi, 'POST', 'google', { body: { credential: 'owner' } })
    check('…and the same by Google at the cap: 200, the administrator, one over the cap', g.status === 200 && g.json?.user?.role === 'admin' && tables.User.rows.size === cap + 1)

    // NEG: ONCE THERE IS AN ADMINISTRATOR, the exemption is gone — the seat it protects is filled.
    await fill()
    await tables.User.put({ ...tables.User.rows.get('u0'), role: 'admin' })
    const afterLog = await captureLog(() => call(AuthApi, 'POST', 'request-link', { body: { email: 'owner@example.test' } }))
    check('with an active administrator present, the owner\'s new address is held to the quota like anyone\'s (NEG)', tables.User.rows.size === cap && !/token=/.test(afterLog))
  } finally {
    delete process.env.OWNER_EMAIL
    delete process.env.GOOGLE_CLIENT_ID
  }
  // CONTROL: with no owner named, that address is a stranger's, so the lines above are the exemption and
  // not a quota that stopped counting.
  await fill()
  const noOwnerLog = await captureLog(() => call(AuthApi, 'POST', 'request-link', { body: { email: 'owner@example.test' } }))
  check('CONTROL: with no OWNER_EMAIL the same address at the cap gets no account', tables.User.rows.size === cap && !/token=/.test(noOwnerLog))
}

section(`the rule-20 sweep over every response (${transcript.length})`)
{
  const bad = responseRulesVerdict(transcript)
  check('no 401, no WWW-Authenticate on a 403, everything no-store', bad.length === 0, bad.slice(0, 3).join(' | '))
}
process.exit(done())
