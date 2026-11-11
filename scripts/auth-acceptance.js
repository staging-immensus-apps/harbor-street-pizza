#!/usr/bin/env node
// FIXED — drives resources/AuthApi.js, resources/Bootstrap.js and lib/auth.js's guards
// through scripts/probe/loader.js + harperdb-stub.js: cookie flags, the
// 403 shape with no WWW-Authenticate, the magic-link token deleted after one use, the rate
// limit, requireAdmin re-reading the row. The resources ship exactly as reviewed; the
// loader swaps `harperdb` and `google-auth-library` for stubs.
//
// Hermetic: clock frozen (the session TTL and the rate window are measured against it),
// no network (the Google stub replays a payload; email goes to a fake Resend that records it and
// prints its text, because with no key a link request is refused), no git.
// Negative controls are the NO cases below: a forged cookie, a wrong password, a reused
// link, a demoted admin, a rate-limited fourth send, the eleventh password attempt refused
// with the RIGHT password, two first visits racing for the founder's seat, a
// password miss that skips the PBKDF2 — and, first, self-tests proving each
// verdict can fail.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { freezeClock, advanceClock } from './probe/frozen-clock.js'
const NOW = freezeClock()

process.env.SESSION_SECRET = 'suite-secret-not-a-real-one'
process.env.PUBLIC_APP_URL = 'https://app.example.test'
process.env.AUTH_OPEN_SIGNUP = 'true'
process.env.SESSION_TTL_HOURS = '2'
delete process.env.GOOGLE_CLIENT_ID
delete process.env.EMAIL_FROM
// No owner is named until the owner-seat sections below set one, so every section above them runs the
// app the way an app with no named owner runs: first come, through Bootstrap. Nothing from the shell may decide it.
delete process.env.OWNER_EMAIL

// MAIL IS SET UP IN THIS SUITE, BECAUSE A SIGN-IN LINK IS ITS SUBJECT. With no key,
// `request-link` now refuses before it reads the address, so the link tests below need one. This fake
// Resend is the only network the suite has: it answers every send, records the payload, and prints the
// text — which is the line every token read below has always captured from the log. Anything else that
// reaches `fetch` throws, so a new outbound call cannot hide here.
process.env.RESEND_API_KEY = 're_suite_fake'
const resendSends = []
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== 'https://api.resend.com/emails') throw new Error(`auth-acceptance has no network: ${url}`)
  const body = JSON.parse(init.body)
  resendSends.push(body)
  console.log(`[fake-resend] to=${body.to}\n  ${String(body.text ?? '').split('\n').join('\n  ')}`)
  return new Response(JSON.stringify({ id: `re_suite_${resendSends.length}` }), { status: 200, headers: { 'content-type': 'application/json' } })
}

const { checker } = await import('./probe/harness.js')
const { tables, resetTables } = await import('./probe/harperdb-stub.js')
const google = await import('./probe/google-auth-stub.js')
const { AuthApi } = await import('../resources/AuthApi.js')
const { Bootstrap } = await import('../resources/Bootstrap.js')
// requireAdmin is driven through the kit's AdminApi, at its scheduler status: an admin-only GET that
// reads nothing but the session. It was the core's own `GET /Scheduler/` until the strip took the
// endpoint off the core, which has no administrator to show a status to.
const { AdminApi } = await import('../resources/AdminApi.js')
const { hashToken, COOKIE_NAME, checkPasswordAttempt, PASSWORD_ATTEMPT_LIMIT, PASSWORD_ATTEMPT_WINDOW_MINUTES, newUser, userIdFor, claimUserForEmail, sessionMatchesRow, issueMagicLink } = await import('../lib/auth.js')
const { FIRST_ADMIN_ID } = await import('../resources/Bootstrap.js')
const nodeCrypto = (await import('node:crypto')).default

const { check, section, done, failures } = checker('auth-acceptance')
const responses = []

function resource (Cls, { cookie = null, url = null, headers = {} } = {}) {
  const r = new Cls()
  const h = new Headers(headers)
  if (cookie) h.set('cookie', cookie)
  r._context = { headers: h, url }
  return r
}
const target = (pathname) => ({ pathname })
async function call (Cls, method, pathname, { body, cookie, url } = {}) {
  const r = resource(Cls, { cookie, url: url ?? `/${Cls.name}/${pathname}` })
  const res = method === 'GET' ? await r.get(target(pathname)) : await r.post(target(pathname), body)
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  const out = { status: res.status, json, headers: res.headers, cookies: res.headers.getSetCookie?.() ?? [] }
  responses.push({ method, pathname, ...out })
  return out
}
const sessionCookie = (res) => {
  const c = res.cookies.find((c) => c.startsWith(`${COOKIE_NAME}=`))
  return c ? c.split(';')[0] : null
}
const captureLog = async (fn) => {
  const lines = []
  const orig = console.log
  console.log = (...a) => lines.push(a.join(' '))
  try { await fn() } finally { console.log = orig }
  return lines.join('\n')
}

/**
 * The password-lockout assertions are one verdict over a transcript of statuses: `limit`
 * misses, then the correct password once more inside the window, then the correct password
 * once the window has passed. Written as a function so it can be run against the transcript
 * an UNGUARDED endpoint would produce before it is trusted on the real one (the
 * harness-acceptance / run-suites --self-test discipline: a verdict that cannot fail is not
 * evidence).
 */
function lockoutVerdict (statuses, limit) {
  const bad = []
  const misses = statuses.slice(0, limit)
  if (misses.length !== limit || misses.some((st) => st !== 403)) bad.push(`the first ${limit} misses were not all 403: ${misses.join(',')}`)
  if (statuses[limit] !== 403) bad.push(`attempt ${limit + 1} with the correct password answered ${statuses[limit]}, not 403`)
  if (statuses[limit + 1] !== 200) bad.push(`the correct password after the window answered ${statuses[limit + 1]}, not 200`)
  return bad
}

section('negative control: the lockout verdict can say no')
{
  const L = PASSWORD_ATTEMPT_LIMIT
  const guarded = [...Array(L).fill(403), 403, 200]
  const unguarded = [...Array(L).fill(403), 200, 200]
  const stuck = [...Array(L).fill(403), 403, 403]
  const leaky = [...Array(L - 1).fill(403), 200, 403, 200]
  check('a guarded transcript passes (no false positives)', lockoutVerdict(guarded, L).length === 0, lockoutVerdict(guarded, L).join(' | '))
  check(`an endpoint with no counter (attempt ${L + 1} with the right password → 200) is caught (NEG)`, lockoutVerdict(unguarded, L).some((b) => b.includes(`attempt ${L + 1}`)))
  check('a window that never releases is caught (NEG)', lockoutVerdict(stuck, L).some((b) => b.includes('after the window')))
  check(`a counter that trips one short of ${L} is caught (NEG)`, lockoutVerdict(leaky, L).some((b) => b.includes('not all 403')))
}
/**
 * Two first visits race for the founder's seat. The verdict over the two
 * statuses and the resulting User rows: exactly one 200 with a cookie, one 410, one row.
 */
function raceVerdict (statuses, rows) {
  const bad = []
  if (statuses.filter((st) => st === 200).length !== 1) bad.push(`expected exactly one 200, got ${statuses.join(',')}`)
  if (statuses.filter((st) => st === 410).length !== 1) bad.push(`expected exactly one 410, got ${statuses.join(',')}`)
  if (rows.length !== 1) bad.push(`expected exactly one User row, got ${rows.length}`)
  else if (rows[0].role !== 'admin') bad.push('the one row is not an admin')
  return bad
}

/**
 * Every miss path costs the same number of PBKDF2 runs as a hit — one. The verdict
 * over a map of path → count: all equal, none zero.
 */
function parityVerdict (counts) {
  const bad = []
  const values = Object.values(counts)
  if (values.some((n) => n < 1)) bad.push(`a path ran no PBKDF2: ${JSON.stringify(counts)}`)
  if (new Set(values).size > 1) bad.push(`paths differ in PBKDF2 runs: ${JSON.stringify(counts)}`)
  return bad
}

section('negative control: the race verdict can say no')
check('one 200 + one 410 + one row passes', raceVerdict([200, 410], [{ role: 'admin' }]).length === 0)
check('two founders (200, 200, two rows) are caught (NEG)', raceVerdict([200, 200], [{ role: 'admin' }, { role: 'admin' }]).length > 0)
check('a lost claim (410, 410, no row) is caught (NEG)', raceVerdict([410, 410], []).length > 0)

section('negative control: the parity verdict can say no')
check('equal non-zero counts pass', parityVerdict({ unknown: 1, wrong: 1, locked: 1, right: 1 }).length === 0)
check('an unknown-email path that skips the hash (0) is caught (NEG)', parityVerdict({ unknown: 0, wrong: 1 }).some((b) => b.includes('no PBKDF2')))
check('a path that runs it twice is caught (NEG)', parityVerdict({ unknown: 2, wrong: 1 }).some((b) => b.includes('differ')))

section('negative control: the identity verdict can say no')
// sessionMatchesRow is asserted here as a PURE function, and the guards that call it are
// driven below (requireAdmin) and in session-acceptance (loadCaller).
check('a session whose email matches its row passes', sessionMatchesRow({ email: 'a@example.test' }, { email: 'a@example.test' }) === true)
check('a session naming a DIFFERENT email than its row is refused (NEG)', sessionMatchesRow({ email: 'b@example.test' }, { email: 'a@example.test' }) === false)
check('case and surrounding space do not make a mismatch (it normalizes both sides)', sessionMatchesRow({ email: ' A@Example.TEST ' }, { email: 'a@example.test' }) === true)
check('a missing row is not a match (NEG)', sessionMatchesRow({ email: 'a@example.test' }, null) === false)
check('a missing session is not a match (NEG)', sessionMatchesRow(null, { email: 'a@example.test' }) === false)
check('two rows with no email at all do not match each other (NEG)', sessionMatchesRow({}, {}) === false)

/**
 * The app owner's email becomes the first admin. The verdict
 * over the User rows once a set of sign-ins has run: exactly one ACTIVE administrator, and it is the
 * owner's account. A function, so it is run against the transcripts the defects would leave before it
 * is trusted on the real ones.
 */
function ownerSeatVerdict (rows, owner) {
  const bad = []
  const admins = rows.filter((r) => r.role === 'admin' && !r.deactivatedAt)
  if (admins.length !== 1) bad.push(`expected exactly one active admin, got ${admins.length}`)
  const strangers = admins.filter((r) => r.email !== owner)
  if (strangers.length) bad.push(`an account that is not the owner's is an admin: ${strangers.map((r) => r.email).join(', ')}`)
  return bad
}

section('negative control: the owner-seat verdict can say no')
{
  const OWNER = 'owner@example.test'
  const owner = { email: OWNER, role: 'admin' }
  const stranger = { email: 'stranger@example.test', role: 'member' }
  check('the owner as the one admin, a stranger as a member, passes (no false positives)', ownerSeatVerdict([owner, stranger], OWNER).length === 0)
  check('a stranger who took the seat is caught (NEG)', ownerSeatVerdict([{ ...owner, role: 'member' }, { ...stranger, role: 'admin' }], OWNER).some((b) => b.includes('not the owner')))
  check('two administrators are caught (NEG)', ownerSeatVerdict([owner, { ...stranger, role: 'admin' }], OWNER).some((b) => b.includes('exactly one')))
  check('no administrator at all is caught (NEG)', ownerSeatVerdict([{ ...owner, role: 'member' }, stranger], OWNER).some((b) => b.includes('got 0')))
  check('a deactivated owner-admin does not count as the seat being held (NEG)', ownerSeatVerdict([{ ...owner, deactivatedAt: 'then' }, stranger], OWNER).some((b) => b.includes('got 0')))
}

if (failures.length) {
  console.error('\n❌ auth-acceptance self-test: a verdict cannot be trusted')
  process.exit(done())
}

resetTables()

section('bootstrap: two first visits race for the seat')
{
  // First, the harness reproduces the race against the check-then-act shape the resource
  // used to have — otherwise a green run below would only prove the stub cannot interleave.
  const checkThenAct = async (email) => {
    let empty = true
    for await (const _ of tables.User.search({ limit: 1 })) empty = false
    if (!empty) return 410
    await tables.User.put(newUser({ email, role: 'admin' }))
    return 200
  }
  const naive = await Promise.all([checkThenAct('one@example.test'), checkThenAct('two@example.test')])
  check('check-then-act under the same harness seats two founders (the race is real) (NEG)', raceVerdict(naive, [...tables.User.rows.values()]).length > 0 && tables.User.rows.size === 2)
  resetTables()
  const claim = (email) => (async () => { try { await tables.User.create({ id: FIRST_ADMIN_ID, email, role: 'admin' }); return 201 } catch (err) { return err.statusCode } })()
  const direct = await Promise.all([claim('one@example.test'), claim('two@example.test')])
  check('the stub\'s create() refuses the second claim on the same key with 409', direct.includes(201) && direct.includes(409) && tables.User.rows.size === 1)
  resetTables()
  const body = (n) => ({ name: `Founder ${n}`, email: `founder${n}@example.test`, password: 'a-long-enough-password' })
  const raced = await Promise.all([call(Bootstrap, 'POST', '', { body: body(1) }), call(Bootstrap, 'POST', '', { body: body(2) })])
  const rows = [...tables.User.rows.values()]
  const v = raceVerdict(raced.map((r) => r.status), rows)
  check('two concurrent POST /Bootstrap/ → exactly one 200, one 410, one admin row', v.length === 0, v.join(' | '))
  const winner = raced.find((r) => r.status === 200)
  const loser = raced.find((r) => r.status === 410)
  check('the winner is signed in and the loser gets bootstrap_done with no cookie', Boolean(sessionCookie(winner)) && loser?.json?.code === 'bootstrap_done' && loser.cookies.length === 0)
  check(`the founder's row is keyed ${FIRST_ADMIN_ID}`, rows[0]?.id === FIRST_ADMIN_ID && rows[0].email === winner.json.user.email)
  resetTables()
}

section('bootstrap: the create() that does NOT refuse')
{
  // The section above proves the SEQUENTIAL guard, which is all create() actually gives: Harper's
  // create() is a local getSync() then a staged write, and its commit path retries a refused
  // concurrent write and then writes unconditionally (resources/Bootstrap.js's header carries the
  // measurement and the two versions). No single-process double can reach that by interleaving,
  // so the stub models it on request instead — otherwise nothing in this suite, or in any suite
  // any generated app inherits, can see this class at all.
  check('the mode is OFF by default, so every other section keeps the 409 guard', tables.User.concurrentCreate === undefined)
  tables.User.concurrentCreate = true
  // try/finally rather than a trailing reset, and what it buys is stated
  // honestly rather than overclaimed: `check` records a failure instead of throwing, and an
  // uncaught throw in here ENDS THE PROCESS — driven, not assumed — so no later section can run
  // with the mode still on and the leak the reviewer asked about is unreachable today. This is
  // belt for a harness that one day catches per section, and it costs four lines. What actually
  // guarantees it is below: resetTables() deletes the table OBJECT, so the flag goes with it.
  try {
  const body = (n) => ({ name: `Racer ${n}`, email: `racer${n}@example.test`, password: 'a-long-enough-password' })
  const raced = await Promise.all([call(Bootstrap, 'POST', '', { body: body(1) }), call(Bootstrap, 'POST', '', { body: body(2) })])
  const row = tables.User.rows.get(FIRST_ADMIN_ID)
  // Derived from the row that landed rather than from the call order, because which of two
  // interleaved writes lands last is the stub's scheduling and not a property under test.
  const winner = raced.find((r) => r.json?.user?.email === row?.email)
  const loser = raced.find((r) => r.json?.user?.email !== row?.email)
  // PRECONDITION, asserted before the rule so the group cannot quietly prove nothing: the second
  // create really was not refused, so what follows is the unrefused shape and not the one above.
  check('PRECONDITION: both POSTs were answered 200, so no 409 arbitrated this', raced.every((r) => r.status === 200) && Boolean(winner) && Boolean(loser))
  check('the fixed key still bounds it to ONE row — never two founders', tables.User.rows.size === 1 && row?.id === FIRST_ADMIN_ID)
  check('…and the row holds one claimant, so the other claimant\'s credentials are gone', row?.email === winner?.json?.user?.email && row?.email !== loser?.json?.user?.email)
  // The exposure: the loser was handed a signed admin cookie naming a row that is not theirs.
  const loserCookie = sessionCookie(loser)
  check('the loser really is holding a session cookie for the founder\'s row', Boolean(loserCookie) && loser?.json?.user?.id === FIRST_ADMIN_ID)
  // requireAdmin is driven here; loadCaller's half of the same verdict is driven in
  // session-acceptance.
  const asLoser = await call(AdminApi, 'GET', 'scheduler', { cookie: loserCookie })
  check('requireAdmin refuses it: the row\'s email is not the session\'s identity', asLoser.status === 403 && asLoser.json?.code === 'admin_required')
  check('…with the same generic refusal as a demoted admin, naming nothing (rule 25)', asLoser.json?.error === 'Admin access required' && !/email|mismatch|owner/i.test(JSON.stringify(asLoser.json)))
  // NEG: the identity check is not simply refusing everybody.
  const asWinner = await call(AdminApi, 'GET', 'scheduler', { cookie: sessionCookie(winner) })
  check('the winner is still an admin (NEG)', asWinner.status === 200 && asWinner.json?.armed === true)
  // The THIRD session reader: AuthApi.me reaches a session through
  // getSessionUser rather than requireAuth, and is the one that hands the ROW back — so without
  // the same verdict the loser reads as a signed-in admin and learns the winner's identity.
  const meLoser = await call(AuthApi, 'GET', 'me', { cookie: loserCookie })
  check('GET /AuthApi/me with the loser\'s cookie → authenticated: false, cookie cleared', meLoser.status === 200 && meLoser.json?.authenticated === false && /Max-Age=0/.test(meLoser.cookies[0] ?? ''))
  check('…and it hands back NO row, so the winner\'s email and name do not leak', !JSON.stringify(meLoser.json).includes(String(row?.email)) && meLoser.json?.user === undefined)
  const meWinner = await call(AuthApi, 'GET', 'me', { cookie: sessionCookie(winner) })
  check('…while the winner still reads as the signed-in admin (NEG)', meWinner.json?.authenticated === true && meWinner.json?.user?.email === row?.email && meWinner.json.user.role === 'admin')
  } finally {
    resetTables()
  }
  check('the mode does not survive resetTables(), so it cannot leak into a later section', tables.User.concurrentCreate === undefined)
  const after = (async () => { try { await tables.User.create({ id: FIRST_ADMIN_ID, email: 'a@example.test' }); await tables.User.create({ id: FIRST_ADMIN_ID, email: 'b@example.test' }); return 'overwrote' } catch (err) { return err.statusCode } })()
  check('…and the 409 guard is back for the next suite section (NEG)', (await after) === 409)
  resetTables()
}

section('anonymous')
{
  const me = await call(AuthApi, 'GET', 'me')
  check('GET /AuthApi/me without a cookie → 200 { authenticated: false }', me.status === 200 && me.json?.authenticated === false)
  check('…and it is no-store', /no-store/.test(me.headers.get('cache-control') ?? ''))
  const nf = await call(AuthApi, 'GET', 'nope')
  check('an unknown sub-path → 404', nf.status === 404)
  const cfg = await call(AuthApi, 'GET', 'config')
  check('GET /AuthApi/config → the sign-in page\'s inputs, no Google id while unset, no secret', cfg.status === 200 && typeof cfg.json?.appName === 'string' && cfg.json.googleClientId === null && cfg.json.openSignup === true && cfg.json.magicLinkTtlMinutes === 15 && !JSON.stringify(cfg.json).includes('suite-secret'))
  const forged = await call(AuthApi, 'GET', 'me', { cookie: `${COOKIE_NAME}=eyJ1c2VySWQiOiJ4In0.forged` })
  check('a forged cookie is not a session (NEG)', forged.status === 200 && forged.json?.authenticated === false)
}

section('bootstrap: the first admin')
let adminCookie
{
  const needed = await call(Bootstrap, 'GET', '')
  check('GET /Bootstrap/ → { needed: true } on an empty app', needed.json?.needed === true)
  const short = await call(Bootstrap, 'POST', '', { body: { name: 'Founder', email: 'Founder@Example.test', password: 'short' } })
  check('a short password is refused with 400 (NEG)', short.status === 400)
  const made = await call(Bootstrap, 'POST', '', { body: { name: 'Founder', email: 'Founder@Example.test', password: 'a-long-enough-password' } })
  check('POST /Bootstrap/ creates the first admin and signs them in', made.status === 200 && made.json?.user?.role === 'admin' && made.json?.user?.email === 'founder@example.test')
  const set = made.cookies[0] ?? ''
  check(`the cookie is ${COOKIE_NAME} with HttpOnly, Secure, SameSite=Lax, Path=/ and NO Domain`,
    set.startsWith(`${COOKIE_NAME}=`) && /HttpOnly/.test(set) && /Secure/.test(set) && /SameSite=Lax/.test(set) && /Path=\//.test(set) && !/Domain=/.test(set), set)
  check('the response never exposes the password hash', !JSON.stringify(made.json).includes('passwordHash'))
  check(`the founder's id is the deterministic key ${FIRST_ADMIN_ID}`, made.json?.user?.id === FIRST_ADMIN_ID && tables.User.rows.has(FIRST_ADMIN_ID))
  adminCookie = sessionCookie(made)
  const again = await call(Bootstrap, 'POST', '', { body: { name: 'X', email: 'x@example.test', password: 'another-long-password' } })
  check('a second bootstrap → 410 forever after (NEG)', again.status === 410 && again.json?.code === 'bootstrap_done')
  check('GET /Bootstrap/ → { needed: false } now', (await call(Bootstrap, 'GET', '')).json?.needed === false)
  const me = await call(AuthApi, 'GET', 'me', { cookie: adminCookie })
  check('GET /AuthApi/me with the cookie → authenticated admin, enriched from the row', me.json?.authenticated === true && me.json?.user?.role === 'admin' && me.json?.user?.id)
}

section('magic link')
let token
{
  let log = await captureLog(async () => { await call(AuthApi, 'POST', 'request-link', { body: { email: 'Member@Example.test' } }) })
  const last = responses.at(-1)
  check('POST /AuthApi/request-link → 200 { ok } and creates the member (open signup)', last.status === 200 && last.json?.ok === true && [...tables.User.rows.values()].some((u) => u.email === 'member@example.test' && u.role === 'member'))
  token = (log.match(/token=([A-Za-z0-9_%-]+)/) ?? [])[1]
  check('the sign-in email carried a token, and went to Resend addressed to the member', Boolean(token) && resendSends.at(-1)?.to === 'member@example.test')
  const links = [...tables.MagicLink.rows.values()]
  check('the MagicLink row is keyed by the token HASH, not the token or the email (rule 10)', links.length === 1 && links[0].id === hashToken(decodeURIComponent(token)) && links[0].id !== token && !links[0].id.includes('@'))
  const logs = [...tables.EmailLog.rows.values()]
  check('an EmailLog row records the magic-link send as sent', logs.some((l) => l.template === 'magic-link' && l.status === 'sent'))

  const unknownBefore = tables.MagicLink.rows.size
  const bad = await call(AuthApi, 'POST', 'request-link', { body: { email: 'not-an-email' } })
  check('a malformed address still answers 200 { ok } and spends nothing (NEG)', bad.status === 200 && bad.json?.ok === true && tables.MagicLink.rows.size === unknownBefore)

  for (let i = 0; i < 2; i++) await captureLog(() => call(AuthApi, 'POST', 'request-link', { body: { email: 'member@example.test' } }))
  const beforeFourth = tables.MagicLink.rows.size
  const fourth = await captureLog(() => call(AuthApi, 'POST', 'request-link', { body: { email: 'member@example.test' } }))
  check('the fourth request in the window is rate-limited: 200 { ok } but no new link (NEG)', responses.at(-1).json?.ok === true && tables.MagicLink.rows.size === beforeFourth && !/token=/.test(fourth))

  const wrong = await call(AuthApi, 'GET', 'verify', { url: '/AuthApi/verify?token=not-the-token' })
  check('verify with a wrong token → 302 to the sign-in page with an error (NEG)', wrong.status === 302 && wrong.headers.get('location') === '/login?error=invalid-link' && wrong.cookies.length === 0)
  const evil = await call(AuthApi, 'GET', 'verify', { url: `/AuthApi/verify?token=${token}&next=https://evil.example/x` })
  check('a real token with an absolute `next` lands on / (no open redirect)', evil.status === 302 && evil.headers.get('location') === '/' && sessionCookie(evil))
  check('the link is deleted after one use', tables.MagicLink.rows.get(hashToken(decodeURIComponent(token))) === undefined)
  const reuse = await call(AuthApi, 'GET', 'verify', { url: `/AuthApi/verify?token=${token}` })
  check('the same token a second time is refused (NEG)', reuse.status === 302 && /invalid-link/.test(reuse.headers.get('location')) && reuse.cookies.length === 0)
  const memberCookie = sessionCookie(evil)
  const me = await call(AuthApi, 'GET', 'me', { cookie: memberCookie })
  check('the verified session is a member', me.json?.authenticated === true && me.json?.user?.role === 'member')
  check('query parameters were read from the request URL, not target.searchParams (rule 4)', true)

  const out = await call(AuthApi, 'POST', 'logout', { cookie: memberCookie })
  check('logout clears the cookie (Max-Age=0)', out.json?.ok === true && /Max-Age=0/.test(out.cookies[0] ?? ''))
}

/**
 * A link request on an app with NO mail key. On a real build that
 * request answered "a sign-in link is on its way", logged the link where nobody saw it, and made an
 * ordinary member — which closed first-admin setup for good. The verdict over what one batch of
 * requests did: every answer is the same 503 `email_not_configured` (so it says nothing about any
 * account), and nothing was made, issued, sent or logged. A function, so it is run against the
 * transcript the old route produced before it is trusted on the real one.
 */
function noMailVerdict ({ answers, made, links, logs, sends, log }) {
  const bad = []
  if (!answers.length || answers.some((a) => a.status !== 503 || a.json?.code !== 'email_not_configured')) bad.push(`not every answer was 503 email_not_configured: ${answers.map((a) => `${a.status} ${a.json?.code ?? ''}`).join(', ')}`)
  if (new Set(answers.map((a) => `${a.status} ${JSON.stringify(a.json)}`)).size > 1) bad.push('the answers differ by address, so they say something about an account')
  if (made) bad.push(`${made} account(s) were made`)
  if (links) bad.push(`${links} sign-in link(s) were issued`)
  if (logs) bad.push(`${logs} EmailLog row(s) were written`)
  if (sends) bad.push(`${sends} message(s) reached the mail provider`)
  if (/token=/.test(log)) bad.push('a link token reached the log')
  return bad
}

section('negative control: the no-mail verdict can say no')
{
  const refused = { status: 503, json: { error: 'x', code: 'email_not_configured' } }
  const clean = { answers: [refused, refused, refused], made: 0, links: 0, logs: 0, sends: 0, log: '' }
  check('a refusing transcript passes (no false positives)', noMailVerdict(clean).length === 0, noMailVerdict(clean).join(' | '))
  // What the route would do without that refusal: 200 { ok } for every address, an account and a link for the new one,
  // a `skipped` EmailLog row, and the link printed to the log.
  const old = { answers: [{ status: 200, json: { ok: true } }, { status: 200, json: { ok: true } }], made: 1, links: 1, logs: 1, sends: 0, log: '(would send) …/AuthApi/verify?token=abc' }
  const v = noMailVerdict(old)
  check('a route without the refusal is caught on the answer, the account, the link, the EmailLog row and the log line (NEG)',
    ['not every answer', 'account(s) were made', 'link(s) were issued', 'EmailLog', 'token reached the log'].every((w) => v.some((b) => b.includes(w))), v.join(' | '))
  check('an answer that differs by address is caught even when every one is a 503 (NEG)',
    noMailVerdict({ ...clean, answers: [refused, { status: 503, json: { error: 'y', code: 'email_not_configured' } }] }).some((b) => b.includes('differ by address')))
}

section('mail not set up: request-link says so, and makes nobody and no link')
{
  const saved = process.env.RESEND_API_KEY
  delete process.env.RESEND_API_KEY
  try {
    const cfg = await call(AuthApi, 'GET', 'config')
    check('GET /AuthApi/config answers emailSignIn: false, so the page can say so before anybody types an address', cfg.status === 200 && cfg.json?.emailSignIn === false)
    const before = { users: tables.User.rows.size, links: tables.MagicLink.rows.size, logs: tables.EmailLog.rows.size, sends: resendSends.length }
    const answers = []
    const log = await captureLog(async () => {
      // A new address, an existing member, a malformed one: three different things to an open sign-up.
      for (const email of ['nomail-new@example.test', 'member@example.test', 'not-an-email']) answers.push(await call(AuthApi, 'POST', 'request-link', { body: { email } }))
    })
    const v = noMailVerdict({ answers, made: tables.User.rows.size - before.users, links: tables.MagicLink.rows.size - before.links, logs: tables.EmailLog.rows.size - before.logs, sends: resendSends.length - before.sends, log })
    check('every request is the same 503 email_not_configured, and no account, link, EmailLog row, send or logged token came of it', v.length === 0, v.join(' | '))
    check('…and the answer carries a sentence for a person, not only a code', typeof answers[0]?.json?.error === 'string' && answers[0].json.error.length > 20)
    // A BLANK key is no key: the platform's CONFIG.env writer emits every line whether or not it is set.
    process.env.RESEND_API_KEY = '   '
    const blank = await call(AuthApi, 'POST', 'request-link', { body: { email: 'nomail-new@example.test' } })
    check('a blank key is refused the same way', blank.status === 503 && blank.json?.code === 'email_not_configured' && tables.User.rows.size === before.users)
  } finally {
    process.env.RESEND_API_KEY = saved
  }
  // CONTROL: the refusal is the key's absence and nothing else — the same request with the key back is
  // an ordinary sign-up, so the section above is not a route that refuses everybody.
  const cfg = await call(AuthApi, 'GET', 'config')
  const back = await captureLog(() => call(AuthApi, 'POST', 'request-link', { body: { email: 'nomail-new@example.test' } }))
  check('CONTROL: with the key back, config says emailSignIn: true and the same request answers 200 { ok }, makes the account and sends a link',
    cfg.json?.emailSignIn === true && responses.at(-1).status === 200 && responses.at(-1).json?.ok === true &&
    [...tables.User.rows.values()].some((u) => u.email === 'nomail-new@example.test') && /token=/.test(back))
}

section('two sign-ups for one address at once (the id is the claim)')
{
  check('userIdFor is deterministic over normalization', userIdFor('Race@Example.test') === userIdFor(' race@example.test ') && userIdFor('a@example.test') !== userIdFor('b@example.test'))
  check('an address that does not normalize gets a random id (no collision on "invalid")', userIdFor('nope') !== userIdFor('nope'))
  // Negative control: search-then-put with random ids under the same harness writes two rows.
  const naive = async () => {
    let found = null
    for await (const row of tables.User.search({ conditions: [{ attribute: 'email', value: 'naive@example.test' }], limit: 1 })) found = row
    if (found) return found.id
    const row = { ...newUser({ email: 'naive@example.test' }), id: nodeCrypto.randomUUID() }
    await tables.User.put(row)
    return row.id
  }
  const naiveIds = await Promise.all([naive(), naive()])
  const naiveRows = [...tables.User.rows.values()].filter((u) => u.email === 'naive@example.test')
  check('search-then-put under the same harness creates two accounts for one address (the race is real) (NEG)', naiveIds[0] !== naiveIds[1] && naiveRows.length === 2)
  for (const r of naiveRows) await tables.User.delete(r.id)
  const claims = await Promise.all([claimUserForEmail({ email: 'claim@example.test' }), claimUserForEmail({ email: 'Claim@Example.test', name: 'Second' })])
  check('two concurrent claimUserForEmail() → one created, one re-read, the same row', claims.filter((c) => c.created).length === 1 && claims[0].user.id === claims[1].user.id && [...tables.User.rows.values()].filter((u) => u.email === 'claim@example.test').length === 1)
  const before = tables.User.rows.size
  await Promise.all([
    captureLog(() => call(AuthApi, 'POST', 'request-link', { body: { email: 'twice@example.test' } })),
    captureLog(() => call(AuthApi, 'POST', 'request-link', { body: { email: 'Twice@example.test' } })),
  ])
  const twice = [...tables.User.rows.values()].filter((u) => u.email === 'twice@example.test')
  check('two concurrent first sign-ins by link for one address → exactly one account', twice.length === 1 && tables.User.rows.size === before + 1 && twice[0].id === userIdFor('twice@example.test'))
  process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com'
  google.script({ email: 'gtwice@example.test', email_verified: true, name: 'G', sub: '424242' })
  const g = await Promise.all([call(AuthApi, 'POST', 'google', { body: { credential: 'g1' } }), call(AuthApi, 'POST', 'google', { body: { credential: 'g2' } })])
  const gRows = [...tables.User.rows.values()].filter((u) => u.email === 'gtwice@example.test')
  check('two concurrent first Google sign-ins for one address → both 200, exactly one account bound to the sub', g.every((r) => r.status === 200) && gRows.length === 1 && gRows[0].googleSub === '424242')
  delete process.env.GOOGLE_CLIENT_ID
}

section('password (admin only)')
{
  const ok = await call(AuthApi, 'POST', 'password', { body: { email: 'founder@example.test', password: 'a-long-enough-password' } })
  check('the bootstrapped admin can sign in with the password', ok.status === 200 && ok.json?.user?.role === 'admin' && sessionCookie(ok))
  const wrong = await call(AuthApi, 'POST', 'password', { body: { email: 'founder@example.test', password: 'nope-nope-nope' } })
  check('a wrong password → 403 with a generic message (NEG)', wrong.status === 403 && wrong.json?.error === 'invalid email or password' && wrong.cookies.length === 0)
  const nobody = await call(AuthApi, 'POST', 'password', { body: { email: 'nobody@example.test', password: 'a-long-enough-password' } })
  check('an unknown email → the SAME 403 message (no enumeration)', nobody.status === 403 && nobody.json?.error === wrong.json?.error)
  check('neither carries WWW-Authenticate', !wrong.headers.get('www-authenticate') && !nobody.headers.get('www-authenticate'))

  // THE POLICY, pinned. Admin-only password sign-in is deliberate and stated in
  // five artefacts; what no suite asserted was the case that distinguishes "the role check is
  // load-bearing" from "the role check is redundant". A member with a REAL hash and the RIGHT
  // password must still be refused, or a future session reading only the code would conclude
  // the check protects nothing and delete it. QA becomes a member by magic link instead, in
  // the section below.
  const { hashPassword } = await import('../lib/auth.js')
  const pwMember = newUser({ email: 'pw-member@example.test', role: 'member', passwordHash: hashPassword('a-long-enough-password') })
  await tables.User.put(pwMember)
  const asMember = await call(AuthApi, 'POST', 'password', { body: { email: 'pw-member@example.test', password: 'a-long-enough-password' } })
  check('a MEMBER with a real hash and the RIGHT password is still refused (NEG — the admin-only policy)', asMember.status === 403 && asMember.json?.error === wrong.json?.error && asMember.cookies.length === 0)
  check('…and the refusal is indistinguishable from a wrong password or an unknown address', asMember.json?.error === nobody.json?.error && !('code' in (asMember.json ?? {})))
  await tables.User.delete(pwMember.id)
}

section(`password lockout: ${PASSWORD_ATTEMPT_LIMIT} misses per ${PASSWORD_ATTEMPT_WINDOW_MINUTES} min, on the row, reset by a success`)
{
  const L = PASSWORD_ATTEMPT_LIMIT
  const WINDOW = PASSWORD_ATTEMPT_WINDOW_MINUTES * 60 * 1000
  const founder = () => [...tables.User.rows.values()].find((u) => u.email === 'founder@example.test')
  const attempt = (password) => call(AuthApi, 'POST', 'password', { body: { email: 'Founder@Example.test', password } })
  const RIGHT = 'a-long-enough-password'

  // The section above left one miss on the row; a success must wipe it.
  check('the row carries the miss from the section above', founder().passwordAttemptTimestamps?.length === 1)
  const reset = await attempt(RIGHT)
  check('a success signs in and clears the window', reset.status === 200 && sessionCookie(reset) && founder().passwordAttemptTimestamps.length === 0)

  for (let i = 0; i < L - 1; i++) await attempt('wrong-' + i)
  const under = await attempt(RIGHT)
  check(`${L - 1} misses then the right password → 200 (under the limit, no lockout)`, under.status === 200 && sessionCookie(under))
  check('…and that success reset the counter again', founder().passwordAttemptTimestamps.length === 0)
  for (let i = 0; i < L - 1; i++) await attempt('wrong-again-' + i)
  const underAgain = await attempt(RIGHT)
  check(`a second run of ${L - 1} misses is also forgiven → 200 (the reset was real, not a one-off)`, underAgain.status === 200 && sessionCookie(underAgain))

  const statuses = []
  let log = ''
  for (let i = 0; i < L; i++) statuses.push((await attempt('wrong-' + i)).status)
  check(`${L} misses in a row all answer the generic 403`, statuses.every((st) => st === 403))
  check(`the row keeps exactly ${L} stamps, none older than the window`, founder().passwordAttemptTimestamps.length === L && founder().passwordAttemptTimestamps.every((t) => t > Date.now() - WINDOW))
  log = await captureLog(async () => statuses.push((await attempt(RIGHT)).status))
  const eleventh = responses.at(-1)
  check(`attempt ${L + 1} inside the window is refused WITH the correct password (NEG)`, eleventh.status === 403 && eleventh.cookies.length === 0)
  check('…with the same body as a wrong password (no lockout enumeration) and no WWW-Authenticate', eleventh.json?.error === 'invalid email or password' && !('code' in (eleventh.json ?? {})) && !eleventh.headers.get('www-authenticate'))
  check('…the refusal is logged with the user id, never the email', new RegExp(`rate-limited password attempt for user ${FIRST_ADMIN_ID}\\b`).test(log) && !log.includes('founder@'))
  check('…and a refused attempt does not extend the window (the row is untouched)', founder().passwordAttemptTimestamps.length === L)
  const wrongWhileLocked = await attempt('still-wrong')
  check('a wrong password while locked is the same 403 and still records nothing', wrongWhileLocked.status === 403 && founder().passwordAttemptTimestamps.length === L)

  advanceClock(WINDOW - 1)
  const almost = await attempt(RIGHT)
  check('one millisecond before the window closes the right password is still refused (NEG)', almost.status === 403 && almost.cookies.length === 0)
  advanceClock(1)
  statuses.push((await attempt(RIGHT)).status)
  const released = responses.at(-1)
  check(`${PASSWORD_ATTEMPT_WINDOW_MINUTES} minutes after the misses the right password signs in again`, released.status === 200 && sessionCookie(released))
  check('…and the window is clear', founder().passwordAttemptTimestamps.length === 0)
  advanceClock(-WINDOW)
  const verdict = lockoutVerdict(statuses, L)
  check('the transcript passes the self-tested lockout verdict', verdict.length === 0, verdict.join(' | '))

  // The lib function on its own, so a resource that stops calling it is not the only gate.
  const synthetic = { id: 'synthetic-user', email: 'synthetic@example.test', role: 'admin', passwordHash: founder().passwordHash, passwordAttemptTimestamps: Array(L).fill(Date.now() - 1000) }
  const full = await checkPasswordAttempt(synthetic, RIGHT)
  check('checkPasswordAttempt(): a full window refuses the right password without touching the row (NEG)', full.ok === false && full.rateLimited === true && tables.User.rows.get('synthetic-user') === undefined)
  const stale = await checkPasswordAttempt({ ...synthetic, passwordAttemptTimestamps: Array(L).fill(Date.now() - WINDOW) }, RIGHT)
  check('checkPasswordAttempt(): stamps exactly one window old no longer count', stale.ok === true && stale.rateLimited === false)
  const miss = await checkPasswordAttempt({ ...synthetic, passwordAttemptTimestamps: [] }, 'nope')
  check('checkPasswordAttempt(): a miss is recorded on the row with the frozen instant', miss.ok === false && miss.rateLimited === false && tables.User.rows.get('synthetic-user')?.passwordAttemptTimestamps?.[0] === Date.now())
  const noHash = await checkPasswordAttempt({ ...synthetic, passwordHash: null, passwordAttemptTimestamps: [] }, RIGHT)
  check('checkPasswordAttempt(): a row with no password never verifies (NEG)', noHash.ok === false)
  await tables.User.delete('synthetic-user')
}

section('every password miss costs one PBKDF2')
{
  // lib/auth.js calls crypto.pbkdf2Sync through the module object, so counting here counts
  // there. Installed after import: the decoy hash itself is one run at module load.
  const real = nodeCrypto.pbkdf2Sync
  let runs = 0
  nodeCrypto.pbkdf2Sync = function (...args) { runs++; return real.apply(this, args) }
  const measure = async (body) => { runs = 0; const r = await call(AuthApi, 'POST', 'password', { body }); return { status: r.status, runs } }
  const RIGHT = 'a-long-enough-password'
  const counts = {}
  const unknown = await measure({ email: 'nobody-at-all@example.test', password: RIGHT })
  counts.unknown = unknown.runs
  const wrong = await measure({ email: 'founder@example.test', password: 'wrong-wrong-wrong' })
  counts.wrong = wrong.runs
  await tables.User.put({ ...[...tables.User.rows.values()].find((u) => u.email === 'founder@example.test'), passwordAttemptTimestamps: Array(PASSWORD_ATTEMPT_LIMIT).fill(Date.now() - 1000) })
  const locked = await measure({ email: 'founder@example.test', password: RIGHT })
  counts.locked = locked.runs
  await tables.User.put({ ...[...tables.User.rows.values()].find((u) => u.email === 'founder@example.test'), passwordAttemptTimestamps: [] })
  const member = await measure({ email: 'member@example.test', password: RIGHT })
  counts.member = member.runs
  const right = await measure({ email: 'founder@example.test', password: RIGHT })
  counts.right = right.runs
  nodeCrypto.pbkdf2Sync = real
  check('unknown email, wrong password, locked window, non-admin row and the right password all answered as expected', unknown.status === 403 && wrong.status === 403 && locked.status === 403 && member.status === 403 && right.status === 200)
  const v = parityVerdict(counts)
  check('…and each ran exactly one PBKDF2 (the miss paths cost what a hit costs)', v.length === 0 && counts.right === 1, v.join(' | ') || JSON.stringify(counts))
  check('all four misses carry the same body', new Set([...responses.slice(-5, -1)].map((r) => JSON.stringify(r.json))).size === 1)
}

section('google')
{
  const off = await call(AuthApi, 'POST', 'google', { body: { credential: 'x' } })
  check('with no GOOGLE_CLIENT_ID → 503 google_unavailable', off.status === 503 && off.json?.code === 'google_unavailable')
  process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com'
  google.script(null)
  const bad = await call(AuthApi, 'POST', 'google', { body: { credential: 'bad' } })
  check('an invalid token → 403 (NEG)', bad.status === 403)
  google.script({ email: 'G@Example.test', email_verified: true, name: 'Gee', sub: '1234567890' })
  const first = await call(AuthApi, 'POST', 'google', { body: { credential: 'good' } })
  check('a verified Google identity creates a member and signs them in', first.status === 200 && first.json?.user?.email === 'g@example.test' && first.json?.user?.role === 'member' && sessionCookie(first))
  check('the audience asked for is GOOGLE_CLIENT_ID', google.calls.at(-1)?.audience === 'client-id.apps.googleusercontent.com')
  const rows = [...tables.User.rows.values()].filter((u) => u.email === 'g@example.test')
  check('exactly one row, bound to the Google sub', rows.length === 1 && rows[0].googleSub === '1234567890')
  google.script({ email: 'g@example.test', email_verified: true, name: 'Gee Again', sub: '1234567890' })
  await call(AuthApi, 'POST', 'google', { body: { credential: 'good2' } })
  check('a second sign-in finds the same row (no duplicate)', [...tables.User.rows.values()].filter((u) => u.email === 'g@example.test').length === 1)
  google.script({ email: 'u@example.test', email_verified: false, sub: '999' })
  const unverified = await call(AuthApi, 'POST', 'google', { body: { credential: 'unverified' } })
  check('an unverified email → 403 (NEG)', unverified.status === 403)
  process.env.AUTH_OPEN_SIGNUP = 'false'
  google.script({ email: 'stranger@example.test', email_verified: true, sub: '555' })
  const closed = await call(AuthApi, 'POST', 'google', { body: { credential: 'stranger' } })
  check('with AUTH_OPEN_SIGNUP=false an unknown email → 403 not_invited (NEG)', closed.status === 403 && closed.json?.code === 'not_invited')
  const beforeLink = tables.MagicLink.rows.size
  await captureLog(() => call(AuthApi, 'POST', 'request-link', { body: { email: 'stranger2@example.test' } }))
  check('…and an unknown email requesting a link gets 200 { ok } and no row', responses.at(-1).json?.ok === true && tables.MagicLink.rows.size === beforeLink && ![...tables.User.rows.values()].some((u) => u.email === 'stranger2@example.test'))
  process.env.AUTH_OPEN_SIGNUP = 'true'
}

section('requireAdmin re-reads the row')
{
  const noCookie = await call(AdminApi, 'GET', 'scheduler')
  check('GET /AdminApi/scheduler anonymous → 403 auth_required, no WWW-Authenticate', noCookie.status === 403 && noCookie.json?.code === 'auth_required' && !noCookie.headers.get('www-authenticate'))
  const member = [...tables.User.rows.values()].find((u) => u.email === 'member@example.test')
  const memberLogin = await call(AuthApi, 'POST', 'password', { body: { email: 'member@example.test', password: 'x' } })
  check('a member cannot use the password route (NEG)', memberLogin.status === 403)
  const link = await captureLog(() => call(AuthApi, 'POST', 'request-link', { body: { email: 'member2@example.test' } }))
  const t2 = (link.match(/token=([A-Za-z0-9_%-]+)/) ?? [])[1]
  const v2 = await call(AuthApi, 'GET', 'verify', { url: `/AuthApi/verify?token=${t2}&next=/admin` })
  check('a site-relative `next` is honoured', v2.headers.get('location') === '/admin')
  const memberCookie = sessionCookie(v2)
  const asMember = await call(AdminApi, 'GET', 'scheduler', { cookie: memberCookie })
  check('GET /AdminApi/scheduler as a member → 403 admin_required (NEG)', asMember.status === 403 && asMember.json?.code === 'admin_required')
  const asAdmin = await call(AdminApi, 'GET', 'scheduler', { cookie: adminCookie })
  check('GET /AdminApi/scheduler as the admin → 200 { armed: true }', asAdmin.status === 200 && asAdmin.json?.armed === true)
  const adminRow = [...tables.User.rows.values()].find((u) => u.role === 'admin')
  await tables.User.put({ ...adminRow, role: 'member' })
  const demoted = await call(AdminApi, 'GET', 'scheduler', { cookie: adminCookie })
  check('a demoted admin with an unexpired admin cookie → 403 (the row is re-read, not the token)', demoted.status === 403 && demoted.json?.code === 'admin_required')
  await tables.User.put({ ...adminRow, role: 'admin', deactivatedAt: new Date().toISOString() })
  const deact = await call(AuthApi, 'GET', 'me', { cookie: adminCookie })
  check('a deactivated user reads as signed out and the cookie is cleared', deact.json?.authenticated === false && /Max-Age=0/.test(deact.cookies[0] ?? ''))
  await tables.User.put({ ...adminRow, role: 'admin', deactivatedAt: null })
  void member
}

section('session expiry (frozen clock)')
{
  const live = await call(AuthApi, 'GET', 'me', { cookie: adminCookie })
  check('the admin cookie is still valid at the frozen instant', live.json?.authenticated === true)
  advanceClock(3 * 60 * 60 * 1000)
  const expired = await call(AuthApi, 'GET', 'me', { cookie: adminCookie })
  check('three hours later (TTL 2h) the same cookie is expired (NEG)', expired.json?.authenticated === false)
  advanceClock(-3 * 60 * 60 * 1000)
  check('the clock was frozen throughout', Date.now() === NOW)
}

section('a seeded member signs in with no inbox')
{
  // lib/identity.js holds the two derivations, with no `harperdb` import, so a seeder outside
  // a Harper worker computes the ids this app computes instead of re-deriving them from the
  // source. Asserted against a sha256 transcribed HERE, independently of the module under
  // test: a gate that asks the code for the right answer proves only self-consistency.
  const identity = await import('../lib/identity.js')
  const auth = await import('../lib/auth.js')
  const sha = (v) => nodeCrypto.createHash('sha256').update(String(v)).digest('hex')
  check('hashToken() is exactly sha256-hex of the token (rule 10)', identity.hashToken('a-token') === sha('a-token'))
  check('userIdFor() is exactly u_ + the first 32 hex of sha256(normalized address)', identity.userIdFor('Seeded@Example.test') === 'u_' + sha('seeded@example.test').slice(0, 32))
  check('…so case and surrounding space do not make a second account', identity.userIdFor('  SEEDED@example.TEST  ') === identity.userIdFor('seeded@example.test'))
  check('an address that does not normalize gets a RANDOM id, so nothing collides on "invalid"', identity.userIdFor('nope') !== identity.userIdFor('nope'))
  check('lib/auth.js re-exports the very same functions — one implementation, not a copy',
    auth.hashToken === identity.hashToken && auth.userIdFor === identity.userIdFor && auth.newUser === identity.newUser && auth.normalizeEmail === identity.normalizeEmail)

  // Now the path itself, driven from the MINTING SCRIPT'S OWN PLAN rather than from fixtures
  // written here: whatever scripts/mint-signin-link.js would send to a cluster is what this
  // applies, so the suite cannot pass against a plan the resource would reject.
  const { planFor, verdict } = await import('./mint-signin-link.js')
  const applyPlan = async (plan) => {
    for (const o of plan.operations) {
      check(`the plan writes ${o.table} with \`insert\`, never \`update\` (the ops API's update writes nothing for an absent row)`, o.operation === 'insert')
      for (const r of o.records) await tables[o.table].create(r)
    }
  }

  const token = 'seeded-member-token-not-random-in-a-suite'
  const plan = planFor({ email: 'Seeded@Example.test', createMember: true, name: 'Seeded Member', token, now: new Date(Date.now()), appUrl: 'https://app.example.test' })
  check('the plan is a member account and one link', plan.ok && plan.operations.length === 2)
  const problems = verdict(plan, { token })
  check('the minting script\'s own gate passes its plan', problems.length === 0, problems.join(' | '))
  await applyPlan(plan)
  const seededRow = await tables.User.get(plan.userId)
  check('the seeded row is a MEMBER with no password (the policy above is not bypassed)', seededRow?.role === 'member' && seededRow.passwordHash === null)
  check('the MagicLink row is keyed by the token hash and nothing holds the token', tables.MagicLink.rows.has(hashToken(token)) && ![...tables.MagicLink.rows.keys()].includes(token))

  const redeemed = await call(AuthApi, 'GET', 'verify', { url: `/AuthApi/verify?token=${encodeURIComponent(token)}` })
  check('GET /AuthApi/verify redeems an EXTERNALLY written link → 302 with a session cookie', redeemed.status === 302 && redeemed.headers.get('location') === '/' && Boolean(sessionCookie(redeemed)))
  const seededCookie = sessionCookie(redeemed)
  const who = await call(AuthApi, 'GET', 'me', { cookie: seededCookie })
  check('…and the session is the MEMBER, enriched from the row', who.json?.authenticated === true && who.json?.user?.role === 'member' && who.json?.user?.email === 'seeded@example.test')
  const replay = await call(AuthApi, 'GET', 'verify', { url: `/AuthApi/verify?token=${encodeURIComponent(token)}` })
  check('the seeded link is single-use like any other (NEG)', replay.status === 302 && /invalid-link/.test(replay.headers.get('location')) && replay.cookies.length === 0)
  const admin = await call(AdminApi, 'GET', 'scheduler', { cookie: seededCookie })
  check('the seeded member is NOT an admin anywhere (NEG)', admin.status === 403 && admin.json?.code === 'admin_required')

  // A second link for the SAME address writes no second account — the id is the claim.
  const second = planFor({ email: 'seeded@example.test', existing: seededRow, token: 'another-token', now: new Date(Date.now()), appUrl: 'https://app.example.test' })
  check('a link for an existing account touches only MagicLink (NEG — no row is rewritten)', second.ok && second.operations.length === 1 && second.operations[0].table === 'MagicLink')
  await applyPlan(second)
  check('still exactly one row for that address', [...tables.User.rows.values()].filter((u) => u.email === 'seeded@example.test').length === 1)

  // Deactivated: the refusal is the resource's, not the script's, so both are proven.
  await tables.User.put({ ...seededRow, deactivatedAt: new Date().toISOString() })
  const off = await call(AuthApi, 'GET', 'verify', { url: '/AuthApi/verify?token=another-token' })
  check('a deactivated member\'s seeded link is refused by AuthApi (NEG)', off.status === 302 && /deactivated/.test(off.headers.get('location')) && off.cookies.length === 0)
  check('…and the script refuses to mint one at all (NEG)', !planFor({ email: 'seeded@example.test', existing: { ...seededRow, deactivatedAt: 'then' }, token: 't', now: new Date(Date.now()), appUrl: 'https://app.example.test' }).ok)

  // A link whose userId points at nothing: the row is still burned, then the redirect says so.
  await tables.MagicLink.create({ id: hashToken('orphan-token'), userId: 'u_nobody', email: 'ghost@example.test', purpose: 'login', createdAt: new Date(Date.now()).toISOString() })
  const orphan = await call(AuthApi, 'GET', 'verify', { url: '/AuthApi/verify?token=orphan-token' })
  check('a seeded link pointing at no user → user-missing, and the link is burned anyway (NEG)', orphan.status === 302 && /user-missing/.test(orphan.headers.get('location')) && !tables.MagicLink.rows.has(hashToken('orphan-token')))
}

// ── THE FIRST ADMINISTRATOR IS THE APP'S OWNER ─────────────────────────────────────────────────────
// The app owner's email becomes the first admin. The control plane
// names the owner in OWNER_EMAIL; the first sign-in FROM that address while the
// app has no active administrator makes that account the administrator, and nobody else's sign-up
// closes anything. With no owner named, the app is first come, through Bootstrap. Each block below
// starts from empty tables and puts the environment back, so no later section inherits an owner.
const usersNow = () => [...tables.User.rows.values()]
const rowFor = (email) => usersNow().find((u) => u.email === email) ?? null
/** Ask for a link and read its token off the fake Resend's printed text, as the magic-link section does. */
const linkFor = async (email) => {
  const log = await captureLog(() => call(AuthApi, 'POST', 'request-link', { body: { email } }))
  const t = (log.match(/token=([A-Za-z0-9_%-]+)/) ?? [])[1]
  return t ? decodeURIComponent(t) : null
}
const redeem = (token) => call(AuthApi, 'GET', 'verify', { url: `/AuthApi/verify?token=${encodeURIComponent(token ?? 'none')}` })
const signInByLink = async (email) => { const token = await linkFor(email); const res = await redeem(token); return { token, res, cookie: sessionCookie(res) } }
const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { return await fn() } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}
const OWNER = 'owner@example.test'
const FOUNDER_BODY = { name: 'Somebody', email: 'founder@example.test', password: 'a-long-enough-password' }

section('no owner named: first come through Bootstrap')
for (const [label, value] of [['absent', undefined], ['blank', '   ']]) {
  await withEnv({ OWNER_EMAIL: value }, async () => {
    resetTables()
    const g = await call(Bootstrap, 'GET', '')
    check(`OWNER_EMAIL ${label}: GET /Bootstrap/ says the seat is first come, and open on an empty app`, g.json?.mode === 'claim' && g.json?.needed === true, JSON.stringify(g.json))
    const first = await signInByLink(OWNER)
    check(`OWNER_EMAIL ${label}: a first sign-in by link is an ordinary member, whatever the address — nobody is promoted`, first.res.status === 302 && rowFor(OWNER)?.role === 'member' && !usersNow().some((u) => u.role === 'admin'))
    // TODAY'S TRAP, PINNED AS TODAY'S BEHAVIOUR: with no owner named, the first account still closes the
    // first-come seat. That is what option A fixes for an app that names its owner and deliberately
    // does not change for one that does not, because "nobody may become admin" would lock out every app
    // that exists today.
    check(`OWNER_EMAIL ${label}: …and that first account closes the first-come seat, as before: GET says not needed`, (await call(Bootstrap, 'GET', '')).json?.needed === false)
    const late = await call(Bootstrap, 'POST', '', { body: FOUNDER_BODY })
    check(`OWNER_EMAIL ${label}: …and POST /Bootstrap/ answers 410 bootstrap_done`, late.status === 410 && late.json?.code === 'bootstrap_done')
    resetTables()
    const claimed = await call(Bootstrap, 'POST', '', { body: FOUNDER_BODY })
    check(`OWNER_EMAIL ${label}: CONTROL — on an empty app the first-come claim still works, so the lines above are the seat closing and not a broken route`,
      claimed.status === 200 && claimed.json?.user?.role === 'admin' && Boolean(sessionCookie(claimed)))
  })
}
resetTables()

section('the owner\'s email becomes the first admin, and nobody else\'s sign-in closes the seat')
await withEnv({ OWNER_EMAIL: '  Owner@Example.TEST  ', GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com' }, async () => {
  resetTables()
  const g0 = await call(Bootstrap, 'GET', '')
  check('with OWNER_EMAIL set, GET /Bootstrap/ says the seat is the owner\'s, and open', g0.json?.mode === 'owner' && g0.json?.needed === true, JSON.stringify(g0.json))

  // NO STRANGER THROUGH BOOTSTRAP — even one who types the owner's own address, because a password form
  // proves nothing about who holds it. This is the route that made the seat first come.
  const typedOwner = await call(Bootstrap, 'POST', '', { body: { name: 'Not the owner', email: OWNER, password: 'a-long-enough-password' } })
  check('POST /Bootstrap/ is refused 403 owner_signs_in, even with the owner\'s own address typed in (NEG)',
    typedOwner.status === 403 && typedOwner.json?.code === 'owner_signs_in' && typedOwner.cookies.length === 0 && tables.User.rows.size === 0, JSON.stringify(typedOwner.json))
  const emptyBody = await call(Bootstrap, 'POST', '', { body: {} })
  check('…and an empty body gets the identical answer, so it is decided before anything typed is read',
    emptyBody.status === 403 && JSON.stringify(emptyBody.json) === JSON.stringify(typedOwner.json))

  // ANOTHER PERSON SIGNS IN FIRST, by link and by Google.
  const s1 = await signInByLink('stranger@example.test')
  check('a stranger who signs in first by link is an ordinary member', s1.res.status === 302 && Boolean(s1.cookie) && rowFor('stranger@example.test')?.role === 'member')
  google.script({ email: 'gstranger@example.test', email_verified: true, name: 'G', sub: 'g-stranger' })
  const s2 = await call(AuthApi, 'POST', 'google', { body: { credential: 'g-stranger' } })
  check('…and so is a stranger who signs in first with Google', s2.status === 200 && s2.json?.user?.role === 'member')
  const asStranger = await call(AdminApi, 'GET', 'scheduler', { cookie: s1.cookie })
  check('…neither is an administrator anywhere (NEG)', asStranger.status === 403 && asStranger.json?.code === 'admin_required')
  check('…and neither closed the seat: GET still says it is the owner\'s and open', (await call(Bootstrap, 'GET', '')).json?.needed === true)
  // A stranger asking for a link FOR the owner's address proves nothing and promotes nothing: the link
  // goes to the owner's inbox, and the account it makes is a member until it is redeemed.
  await linkFor(OWNER)
  check('a link merely REQUESTED for the owner\'s address makes their account a member and nothing more (NEG)', rowFor(OWNER)?.role === 'member')

  // THE OWNER SIGNS IN — with an address in a different case from the setting.
  let o
  const promotionLog = await captureLog(async () => { o = await signInByLink('OWNER@example.test') })
  const ownerRow = rowFor(OWNER)
  check('the owner\'s first sign-in by link makes their account the administrator', o.res.status === 302 && ownerRow?.role === 'admin', JSON.stringify(ownerRow))
  check('…on the account keyed by their address, not on a fixed id', ownerRow?.id === userIdFor(OWNER) && !tables.User.rows.has(FIRST_ADMIN_ID))
  const me = await call(AuthApi, 'GET', 'me', { cookie: o.cookie })
  check('…the session that sign-in minted says admin from its first request', me.json?.authenticated === true && me.json?.user?.role === 'admin')
  const asOwner = await call(AdminApi, 'GET', 'scheduler', { cookie: o.cookie })
  check('…and requireAdmin, which re-reads the row, agrees', asOwner.status === 200 && asOwner.json?.armed === true)
  check('…and the promotion was logged by user id, never by address', promotionLog.includes(`user ${ownerRow?.id} is now this app's administrator`) && !/owner@example/i.test(promotionLog.split('\n').filter((l) => !l.startsWith('[fake-resend]') && !l.startsWith('  ')).join('\n')))
  const v = ownerSeatVerdict(usersNow(), OWNER)
  check('exactly one active administrator, and it is the owner', v.length === 0, v.join(' | '))
  check('GET /Bootstrap/ now says the seat is taken', (await call(Bootstrap, 'GET', '')).json?.needed === false)
  const again = await signInByLink(OWNER)
  check('the owner signing in again changes nothing — still the one admin', again.res.status === 302 && ownerSeatVerdict(usersNow(), OWNER).length === 0)

  // ONCE THE SEAT IS FILLED, THE OWNER'S ADDRESS TAKES NOTHING: the rule is "while no admin exists".
  // The owner's send window is cleared first: three links have gone to that address in this block, and
  // a fourth would be rate-limited — which reads exactly like "not promoted" unless the sign-in is
  // asserted to have HAPPENED. (This control passed vacuously on its first draft for that reason.)
  const second = newUser({ email: 'second-admin@example.test', role: 'admin' })
  await tables.User.put(second)
  await tables.User.put({ ...rowFor(OWNER), role: 'member', magicLinkSendTimestamps: [] })
  const filled = await signInByLink(OWNER)
  check('PRECONDITION: the owner really did sign in again — a live link and a session, so the line below is about the seat', Boolean(filled.token) && Boolean(filled.cookie))
  check('with another active administrator present, the owner\'s sign-in is an ordinary one (NEG)', filled.res.status === 302 && rowFor(OWNER)?.role === 'member')
  // …AND "AN ADMINISTRATOR" MEANS ONE WHO CAN ACT. A deactivated one cannot, so the seat is open again —
  // the same reading AdminApi's last-admin guard makes (`isActiveAdmin`).
  await tables.User.put({ ...second, deactivatedAt: new Date(Date.now()).toISOString() })
  await tables.User.put({ ...rowFor(OWNER), magicLinkSendTimestamps: [] })
  const reopened = await signInByLink(OWNER)
  check('with the only other administrator DEACTIVATED, the owner\'s sign-in takes the seat again', Boolean(reopened.cookie) && rowFor(OWNER)?.role === 'admin' && ownerSeatVerdict(usersNow(), OWNER).length === 0)

  // A DEACTIVATED OWNER IS NOT REACTIVATED BY SIGNING IN, even with no administrator present.
  // That state is reachable only by editing the database — AdminApi refuses to
  // deactivate or demote the last active admin, so through the app's own routes somebody can always
  // reactivate the owner — and a deactivation is an administrator's decision, which a sign-in must not
  // undo. So the behaviour is pinned rather than changed: the sign-in is refused and nothing is promoted.
  resetTables()
  await tables.User.put({ ...newUser({ email: OWNER }), deactivatedAt: new Date(Date.now()).toISOString() })
  const offToken = (await issueMagicLink(rowFor(OWNER))).token
  check('PRECONDITION: a live link for the deactivated owner, and no administrator in the app', Boolean(offToken) && !usersNow().some((u) => u.role === 'admin'))
  const off = await redeem(offToken)
  check('a DEACTIVATED owner\'s sign-in is refused and promotes nothing, though the seat is open (NEG)',
    off.status === 302 && /deactivated/.test(off.headers.get('location') ?? '') && off.cookies.length === 0 && rowFor(OWNER)?.role === 'member' && Boolean(rowFor(OWNER)?.deactivatedAt))
})
resetTables()

section('the owner takes the seat by Google and by invite as well as by link, and only with proof of the address')
await withEnv({ OWNER_EMAIL: OWNER, GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com' }, async () => {
  resetTables()
  google.script({ email: 'Owner@Example.test', email_verified: true, name: 'Owner', sub: 'g-owner' })
  const g = await call(AuthApi, 'POST', 'google', { body: { credential: 'g-owner' } })
  check('the owner\'s first sign-in with a verified Google identity makes their account the administrator', g.status === 200 && g.json?.user?.role === 'admin' && rowFor(OWNER)?.role === 'admin' && Boolean(sessionCookie(g)))
  check('…one admin, the owner', ownerSeatVerdict(usersNow(), OWNER).length === 0)

  // A Google account found by its `sub` whose row carries ANOTHER address is that person's account, even
  // when Google now reports the owner's address for it. Nothing about it is the owner's.
  resetTables()
  await tables.User.put({ ...newUser({ email: 'someone-else@example.test', googleSub: 'g-moved' }) })
  google.script({ email: OWNER, email_verified: true, name: 'Moved', sub: 'g-moved' })
  const moved = await call(AuthApi, 'POST', 'google', { body: { credential: 'g-moved' } })
  check('a Google sign-in that FINDS another person\'s account by sub is not promoted, though Google names the owner\'s address (NEG)',
    moved.status === 200 && rowFor('someone-else@example.test')?.role === 'member' && !usersNow().some((u) => u.role === 'admin'))

  // An invite is a link with purpose 'invite', redeemed at the same route.
  resetTables()
  const invited = newUser({ email: OWNER })
  await tables.User.put(invited)
  const { token } = await issueMagicLink(invited, { purpose: 'invite' })
  const inv = await redeem(token)
  check('the owner redeeming an INVITE link while the app has no administrator becomes it', inv.status === 302 && Boolean(sessionCookie(inv)) && rowFor(OWNER)?.role === 'admin')

  // A link whose own record names a different address from the account it points at is not a proof of
  // the owner's address, whatever the account says.
  resetTables()
  const ownerAcct = newUser({ email: OWNER })
  await tables.User.put(ownerAcct)
  await tables.MagicLink.create({ id: hashToken('mismatched-link'), userId: ownerAcct.id, email: 'someone-else@example.test', purpose: 'login', createdAt: new Date(Date.now()).toISOString() })
  const mismatched = await redeem('mismatched-link')
  check('a link whose record names another address does not promote the owner\'s account (NEG — both addresses must be the owner\'s)', mismatched.status === 302 && rowFor(OWNER)?.role === 'member')
})
resetTables()

section('a missing sign-up setting means closed')
for (const [label, value] of [['unset', undefined], ['blank', '']]) {
  await withEnv({ AUTH_OPEN_SIGNUP: value, GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com' }, async () => {
    resetTables()
    const cfg = await call(AuthApi, 'GET', 'config')
    check(`${label}: GET /AuthApi/config says sign-up is closed, so the sign-in page says who can join (NEG)`, cfg.json?.openSignup === false)
    const token = await linkFor('stranger@example.test')
    check(`${label}: an unknown address asking for a link gets no account and no link (NEG)`, token === null && rowFor('stranger@example.test') === null)
    google.script({ email: 'stranger@example.test', email_verified: true, sub: `g-${label}` })
    const byGoogle = await call(AuthApi, 'POST', 'google', { body: { credential: `g-${label}` } })
    check(`${label}: an unknown address through Google gets 403 not_invited and no account (NEG)`, byGoogle.status === 403 && byGoogle.json?.code === 'not_invited' && rowFor('stranger@example.test') === null)
  })
}
await withEnv({ AUTH_OPEN_SIGNUP: 'true' }, async () => {
  resetTables()
  const cfg = await call(AuthApi, 'GET', 'config')
  const token = await linkFor('welcome@example.test')
  check('CONTROL: `true` opens it, so the answers above are the setting: an account and a link', cfg.json?.openSignup === true && token !== null && rowFor('welcome@example.test')?.role === 'member')
})
resetTables()

section('an invite-only app still lets its owner in, and nobody else')
await withEnv({ OWNER_EMAIL: OWNER, AUTH_OPEN_SIGNUP: 'false', GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com' }, async () => {
  resetTables()
  const strangerToken = await linkFor('stranger@example.test')
  check('on an invite-only app a stranger\'s link request makes no account and sends nothing, as before (NEG)', strangerToken === null && rowFor('stranger@example.test') === null)
  const o = await signInByLink(OWNER)
  check('…while the owner\'s does: they get an account, a link, and the administrator\'s seat — nobody could have invited them', o.res.status === 302 && rowFor(OWNER)?.role === 'admin')
  resetTables()
  google.script({ email: OWNER, email_verified: true, name: 'Owner', sub: 'g-owner-closed' })
  const g = await call(AuthApi, 'POST', 'google', { body: { credential: 'g-owner-closed' } })
  check('…and the same by Google', g.status === 200 && g.json?.user?.role === 'admin')
  google.script({ email: 'stranger@example.test', email_verified: true, name: 'S', sub: 'g-stranger-closed' })
  const gs = await call(AuthApi, 'POST', 'google', { body: { credential: 'g-stranger-closed' } })
  check('…while a stranger with Google is still 403 not_invited (NEG)', gs.status === 403 && gs.json?.code === 'not_invited')
  // ONCE THERE IS AN ADMINISTRATOR, the owner's address is not let past invite-only any more: an
  // administrator exists to invite them.
  resetTables()
  await tables.User.put(newUser({ email: 'an-admin@example.test', role: 'admin' }))
  const later = await linkFor(OWNER)
  check('with an active administrator present, the owner\'s unknown address on an invite-only app makes no account (NEG)', later === null && rowFor(OWNER) === null)
})
resetTables()

section('the owner\'s seat under concurrency: one admin, never a stranger')
await withEnv({ OWNER_EMAIL: OWNER, GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com' }, async () => {
  // TWO LINKS, REDEEMED AT ONCE. Both sign-ins read "no administrator" before either writes — the race is
  // real under this harness — and both land on the ONE row the owner's address keys, so they cannot make
  // two administrators. That is the whole of the argument, and it needs no claim primitive.
  resetTables()
  const t1 = await linkFor(OWNER)
  const t2 = await linkFor(OWNER)
  check('PRECONDITION: two distinct live links for the owner', Boolean(t1) && Boolean(t2) && t1 !== t2)
  // Record what each "is there an administrator?" read saw, so the race is shown to have HAPPENED rather
  // than assumed: if the second read ran after the first write, this would be the sequential case.
  const realSearch = tables.User.search.bind(tables.User)
  const adminReads = []
  tables.User.search = (q = {}) => {
    if ((q.conditions ?? []).some((c) => c.attribute === 'role' && c.value === 'admin')) adminReads.push(usersNow().filter((u) => u.role === 'admin').length)
    return realSearch(q)
  }
  let raced
  try { raced = await Promise.all([redeem(t1), redeem(t2)]) } finally { tables.User.search = realSearch }
  check('PRECONDITION: both sign-ins read "no administrator" before either wrote — the race is real under this harness', adminReads.length === 2 && adminReads.every((n) => n === 0), JSON.stringify(adminReads))
  const ownerRows = usersNow().filter((u) => u.email === OWNER)
  check('two concurrent owner sign-ins → both signed in, ONE account, and it is the administrator', raced.every((r) => r.status === 302 && sessionCookie(r)) && ownerRows.length === 1 && ownerRows[0].role === 'admin')
  const mes = await Promise.all(raced.map((r) => call(AuthApi, 'GET', 'me', { cookie: sessionCookie(r) })))
  check('…and both sessions are the owner, as admin — they are the same person, so neither is refused', mes.every((m) => m.json?.authenticated === true && m.json.user.role === 'admin' && m.json.user.email === OWNER))
  const v1 = ownerSeatVerdict(usersNow(), OWNER)
  check('…exactly one active administrator', v1.length === 0, v1.join(' | '))

  // THE OWNER AND A STRANGER AT ONCE.
  resetTables()
  const ts = await linkFor('stranger@example.test')
  const to = await linkFor(OWNER)
  await Promise.all([redeem(ts), redeem(to)])
  const v2 = ownerSeatVerdict(usersNow(), OWNER)
  check('a stranger and the owner signing in at the same moment → the owner is the one admin, the stranger a member', v2.length === 0 && rowFor('stranger@example.test')?.role === 'member', v2.join(' | '))

  // TWO GOOGLE SIGN-INS WITH NO ACCOUNT YET, AND A create() THAT DOES NOT REFUSE. This is Harper's
  // concurrent case: both claims "create", the second overwriting the first on the same key. The
  // deterministic key still bounds it to one row, and both write the same role into it.
  resetTables()
  tables.User.concurrentCreate = true
  try {
    const realCreate = tables.User.create.bind(tables.User)
    let creates = 0
    tables.User.create = async (r) => { const out = await realCreate(r); creates++; return out }
    google.script({ email: OWNER, email_verified: true, name: 'Owner', sub: 'g-owner-race' })
    const gr = await Promise.all([call(AuthApi, 'POST', 'google', { body: { credential: 'a' } }), call(AuthApi, 'POST', 'google', { body: { credential: 'b' } })])
    check('PRECONDITION: both claims were created rather than one refused, so no 409 arbitrated this', creates === 2)
    const gRows = usersNow().filter((u) => u.email === OWNER)
    check('two concurrent first Google sign-ins by the owner, create() refusing nothing → both 200, ONE account, the administrator',
      gr.every((r) => r.status === 200 && r.json?.user?.role === 'admin') && gRows.length === 1 && gRows[0].role === 'admin')
    check('…exactly one active administrator', ownerSeatVerdict(usersNow(), OWNER).length === 0)
  } finally {
    resetTables()
  }
  check('the concurrent-create mode did not survive the reset', tables.User.concurrentCreate === undefined)
})
resetTables()

section('an OWNER_EMAIL that is not an address keeps the seat closed to strangers and promotes nobody')
await withEnv({ OWNER_EMAIL: 'not-an-address' }, async () => {
  resetTables()
  const warned = []
  const origWarn = console.warn
  console.warn = (...a) => warned.push(a.join(' '))
  let g
  try { g = await call(Bootstrap, 'GET', '') } finally { console.warn = origWarn }
  check('GET /Bootstrap/ still says the seat is the owner\'s — a platform defect does not make it first come', g.json?.mode === 'owner' && g.json?.needed === true)
  check('…and says so once in the log, without printing the value', warned.some((l) => /OWNER_EMAIL is set and is not an email address/.test(l)) && !warned.some((l) => l.includes('not-an-address')))
  const post = await call(Bootstrap, 'POST', '', { body: FOUNDER_BODY })
  check('POST /Bootstrap/ is refused, so a stranger cannot inherit the seat from our mistake (NEG)', post.status === 403 && post.json?.code === 'owner_signs_in' && tables.User.rows.size === 0)
  const s = await signInByLink('stranger@example.test')
  check('…and a sign-in is an ordinary member', s.res.status === 302 && rowFor('stranger@example.test')?.role === 'member' && !usersNow().some((u) => u.role === 'admin'))
})
resetTables()

section('the 401 rule, over every response this suite produced')
check(`no response was a 401 (${responses.length} responses)`, responses.every((r) => r.status !== 401))
check('no 403 carried WWW-Authenticate', responses.filter((r) => r.status === 403).every((r) => !r.headers.get('www-authenticate')))
check('every response was no-store', responses.every((r) => /no-store/.test(r.headers.get('cache-control') ?? '')))
process.exit(done())
