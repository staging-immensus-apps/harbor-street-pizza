#!/usr/bin/env node
// GENERATED — the rules this pass added to the sign-in kit's own resources, driven as shipped.
//
// The shop's customers now have accounts (resources/AuthApi.js's header says why that was an
// extension of the kit rather than a second sign-in beside it). Three rules came with that, and
// each one is the kind that is invisible until somebody is signed in as the wrong person:
//
//   1. `POST /AuthApi/register` makes a MEMBER with a password, and never an administrator — and it
//      REFUSES the shop owner's address, so the row the owner's first magic link promotes can never
//      already carry a password a stranger chose.
//   2. `POST /AuthApi/password` admits any ACTIVE row that HAS a hash. A row with no hash — every
//      member made by invitation or by a link — is still refused whatever is sent.
//   3. `DELETE /AccountApi/` unlinks the caller's orders and deletes the caller's row, and touches
//      NOBODY ELSE'S order. The shop keeps the sale; the account stops existing.
//
// scripts/auth-acceptance.js carries the kit's own password section, including the PBKDF2 parity
// and the lockout; this suite is only what this app added. Hermetic: clock frozen, no network.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { freezeClock } from './probe/frozen-clock.js'
freezeClock()
process.env.SESSION_SECRET = 'suite-secret-not-a-real-one'
process.env.IMMENSUS_TIER = 'builder'
// The shop's owner, as the control plane delivers it. Set before anything reads it, because
// `ownerSetting()` is what makes the refusal below a refusal.
process.env.OWNER_EMAIL = 'owner@example.test'
// Invite-only, as this app is deployed (`accessModel.signUp: "invited"`). Customer registration is
// deliberately not governed by it, and asserting that here is the point: with this set to false a
// customer must still be able to make an account.
process.env.AUTH_OPEN_SIGNUP = 'false'

const { checker } = await import('./probe/harness.js')
const { tables, resetTables } = await import('./probe/harperdb-stub.js')
const { call, userWithCookie, sessionCookie, transcript, responseRulesVerdict } = await import('./probe/resource-call.js')
const { AuthApi } = await import('../resources/AuthApi.js')
const { AccountApi } = await import('../resources/AccountApi.js')
const { userIdFor } = await import('../lib/identity.js')

const { check, section, done, failures } = checker('customer-accounts-probe')

const CUSTOMER = 'casey@example.test'
const PASSWORD = 'pizza-night-2026'

/** Which of `ids` still exist as Order rows, and which of them still name an owner. */
function ordersVerdict (expectOwned, expectUnowned) {
  const bad = []
  for (const [id, owner] of expectOwned) {
    const row = tables.Order.rows.get(id)
    if (!row) bad.push(`GONE: order ${id} was deleted and should have been kept`)
    else if (row.customerUserId !== owner) bad.push(`UNLINKED: order ${id} should still belong to ${owner}, carries ${String(row.customerUserId)}`)
  }
  for (const id of expectUnowned) {
    const row = tables.Order.rows.get(id)
    if (!row) bad.push(`GONE: order ${id} was deleted and should have been kept`)
    else if (row.customerUserId != null) bad.push(`STILL LINKED: order ${id} carries ${String(row.customerUserId)}`)
  }
  return bad
}

section('negative control: the orders verdict can say no')
{
  resetTables()
  tables.Order.rows.set('a', { id: 'a', customerUserId: 'u1' })
  tables.Order.rows.set('b', { id: 'b', customerUserId: null })
  check('a correct arrangement passes', ordersVerdict([['a', 'u1']], ['b']).length === 0)
  check('an order that should be unlinked and is not is caught (NEG)', ordersVerdict([], ['a']).some((b) => b.startsWith('STILL LINKED')))
  check('an order that should still belong to somebody and does not is caught (NEG)', ordersVerdict([['b', 'u1']], []).some((b) => b.startsWith('UNLINKED')))
  check('a deleted order is caught (NEG)', ordersVerdict([['missing', 'u1']], []).some((b) => b.startsWith('GONE')))
}
if (failures.length) process.exit(done())

resetTables()

section('register: a visitor creates a customer account')
{
  const bad = await call(AuthApi, 'POST', 'register', { body: { email: 'not-an-address', password: PASSWORD } })
  check('an address that is not one → 400 bad_email, no row (NEG)', bad.status === 400 && bad.json?.code === 'bad_email' && tables.User.rows.size === 0)
  const short = await call(AuthApi, 'POST', 'register', { body: { email: CUSTOMER, password: 'short' } })
  check('a password under 8 characters → 400 password_too_short, no row (NEG)', short.status === 400 && short.json?.code === 'password_too_short' && tables.User.rows.size === 0)

  const made = await call(AuthApi, 'POST', 'register', { body: { email: 'Casey@Example.test', password: PASSWORD, name: '  Casey  ' } })
  check('a valid registration → 201 with a session cookie', made.status === 201 && made.json?.ok === true && Boolean(await sessionCookie(made)))
  check('…the address is normalized and the name trimmed', made.json?.user?.email === CUSTOMER && made.json?.user?.name === 'Casey')
  check('…the role is member, and AUTH_OPEN_SIGNUP=false did not stop a CUSTOMER account', made.json?.user?.role === 'member')
  const row = tables.User.rows.get(userIdFor(CUSTOMER))
  check('…the row is keyed by the address and carries a hash, which is never handed back', Boolean(row?.passwordHash) && !('passwordHash' in (made.json?.user ?? {})))

  const asAdmin = await call(AuthApi, 'POST', 'register', { body: { email: 'sneaky@example.test', password: PASSWORD, role: 'admin' } })
  check('a body asking for role admin gets a member (NEG)', asAdmin.status === 201 && asAdmin.json?.user?.role === 'member' && tables.User.rows.get(userIdFor('sneaky@example.test')).role === 'member')

  const again = await call(AuthApi, 'POST', 'register', { body: { email: CUSTOMER, password: 'a-different-password' } })
  check('registering the same address again → 409 already_registered, no cookie (NEG)', again.status === 409 && again.json?.code === 'already_registered' && again.cookies.length === 0)
  check('…and the stored hash is the FIRST one, not the second (NEG — a retry is not a password reset)', tables.User.rows.get(userIdFor(CUSTOMER)).passwordHash === row.passwordHash)
}

section("the owner's address is not a customer account (the seat cannot be pre-loaded)")
{
  const owner = await call(AuthApi, 'POST', 'register', { body: { email: 'Owner@Example.test', password: PASSWORD } })
  check('registering the owner\'s address → 403 owner_address', owner.status === 403 && owner.json?.code === 'owner_address')
  check('…and no row was made for it, so the owner\'s first link still promotes a clean row', !tables.User.rows.has(userIdFor('owner@example.test')))
  check('…and no session was issued', owner.cookies.length === 0)
  // NEG: the refusal is about THAT address and not about registration being closed.
  const other = await call(AuthApi, 'POST', 'register', { body: { email: 'someone-else@example.test', password: PASSWORD } })
  check('a different address registers fine in the same conditions (NEG)', other.status === 201)
}

section('password sign-in: a hash is the credential, not a role')
{
  const ok = await call(AuthApi, 'POST', 'password', { body: { email: CUSTOMER, password: PASSWORD } })
  check('the customer signs in with their password → 200 and a cookie', ok.status === 200 && Boolean(await sessionCookie(ok)) && ok.json?.user?.role === 'member')
  const wrong = await call(AuthApi, 'POST', 'password', { body: { email: CUSTOMER, password: 'not-it' } })
  check('the wrong password → 403, no cookie (NEG)', wrong.status === 403 && wrong.cookies.length === 0)
  const unknown = await call(AuthApi, 'POST', 'password', { body: { email: 'nobody@example.test', password: PASSWORD } })
  check('…and an unknown address is refused with the SAME body (no enumeration)', unknown.status === 403 && unknown.json?.error === wrong.json?.error)

  // The half of the old admin-only rule that still discriminates: a row with no hash.
  const invited = await userWithCookie('invited@example.test')
  const hashless = await call(AuthApi, 'POST', 'password', { body: { email: 'invited@example.test', password: PASSWORD } })
  check('a member with NO hash is refused whatever is sent (NEG)', hashless.status === 403 && hashless.cookies.length === 0 && invited.user.passwordHash == null)

  await tables.User.put({ ...tables.User.rows.get(userIdFor(CUSTOMER)), deactivatedAt: '2026-06-01T00:00:00.000Z' })
  const gone = await call(AuthApi, 'POST', 'password', { body: { email: CUSTOMER, password: PASSWORD } })
  check('a deactivated row with the RIGHT password is refused (NEG)', gone.status === 403 && gone.cookies.length === 0)
  await tables.User.put({ ...tables.User.rows.get(userIdFor(CUSTOMER)), deactivatedAt: null })
  check('…and the same password works again once the row is active (NEG — the guard is the flag, not the hash)', (await call(AuthApi, 'POST', 'password', { body: { email: CUSTOMER, password: PASSWORD } })).status === 200)
}

section('a customer sets a new password on their own account')
{
  const signedIn = await call(AuthApi, 'POST', 'password', { body: { email: CUSTOMER, password: PASSWORD } })
  const cookie = await sessionCookie(signedIn)

  const anon = await call(AccountApi, 'PUT', 'password', { body: { newPassword: 'whatever-i-like' } })
  check('anonymous → 403 auth_required, no WWW-Authenticate (NEG)', anon.status === 403 && anon.json?.code === 'auth_required' && !anon.headers.get('www-authenticate'))

  const noCurrent = await call(AccountApi, 'PUT', 'password', { cookie, body: { newPassword: 'a-brand-new-password' } })
  check('a row that HAS a hash needs the current password → 403 wrong_password (NEG)', noCurrent.status === 403 && noCurrent.json?.code === 'wrong_password')
  const tooShort = await call(AccountApi, 'PUT', 'password', { cookie, body: { currentPassword: PASSWORD, newPassword: 'abc' } })
  check('a new password under 8 characters → 400 password_too_short (NEG)', tooShort.status === 400 && tooShort.json?.code === 'password_too_short')

  const changed = await call(AccountApi, 'PUT', 'password', { cookie, body: { currentPassword: PASSWORD, newPassword: 'a-brand-new-password' } })
  check('the right current password changes it → 200', changed.status === 200 && changed.json?.ok === true)
  check('the old password no longer signs in (NEG)', (await call(AuthApi, 'POST', 'password', { body: { email: CUSTOMER, password: PASSWORD } })).status === 403)
  check('…and the new one does', (await call(AuthApi, 'POST', 'password', { body: { email: CUSTOMER, password: 'a-brand-new-password' } })).status === 200)

  // A customer who arrived by magic link has no hash yet: the session alone sets the first one.
  const linkUser = await userWithCookie('link-only@example.test')
  const first = await call(AccountApi, 'PUT', 'password', { cookie: linkUser.cookie, body: { newPassword: 'my-first-password' } })
  check('a member with no hash sets their first password with the session alone → 200', first.status === 200)
  check('…and can then sign in with it', (await call(AuthApi, 'POST', 'password', { body: { email: 'link-only@example.test', password: 'my-first-password' } })).status === 200)
}

section('deleting an account keeps the orders and unlinks only the caller\'s')
{
  const me = userIdFor(CUSTOMER)
  const other = userIdFor('someone-else@example.test')
  await tables.Order.put({ id: 'o-mine-1', code: 'AAA', placedAt: '2026-11-10T10:00:00.000Z', customerUserId: me, totalCents: 1200, updatedAt: 111 })
  await tables.Order.put({ id: 'o-mine-2', code: 'BBB', placedAt: '2026-11-11T10:00:00.000Z', customerUserId: me, totalCents: 1800, updatedAt: 222 })
  await tables.Order.put({ id: 'o-theirs', code: 'CCC', placedAt: '2026-11-11T11:00:00.000Z', customerUserId: other, totalCents: 900 })
  await tables.Order.put({ id: 'o-guest', code: 'DDD', placedAt: '2026-11-11T12:00:00.000Z', customerUserId: null, totalCents: 500 })

  const anon = await call(AccountApi, 'DELETE', '')
  check('anonymous → 403 auth_required, nothing deleted (NEG)', anon.status === 403 && tables.User.rows.has(me) && tables.Order.rows.size === 4)

  const signedIn = await call(AuthApi, 'POST', 'password', { body: { email: CUSTOMER, password: 'a-brand-new-password' } })
  const cookie = await sessionCookie(signedIn)
  const sub = await call(AccountApi, 'DELETE', 'everything', { cookie })
  check('a sub-path → 404 and nothing deleted (NEG)', sub.status === 404 && tables.User.rows.has(me))

  const deleted = await call(AccountApi, 'DELETE', '', { cookie })
  check('the caller deletes their own account → 200, saying how many orders were kept', deleted.status === 200 && deleted.json?.ok === true && deleted.json?.ordersKept === 2)
  check('…the User row is gone', !tables.User.rows.has(me))
  check('…and the response clears the session cookie', deleted.cookies.some((c) => /Max-Age=0/.test(c)))
  const v = ordersVerdict([['o-theirs', other]], ['o-mine-1', 'o-mine-2', 'o-guest'])
  check('every order is KEPT, the caller\'s two are unlinked, and nobody else\'s moved', v.length === 0, v.join(' | '))
  check('…and the two unlinked rows kept their money and their code (the shop\'s record is intact)', tables.Order.rows.get('o-mine-1').totalCents === 1200 && tables.Order.rows.get('o-mine-2').code === 'BBB')
  // CLAUDE.md §8: `Order.updatedAt` is Harper's, and the unlink restates a stored row — the one
  // shape that produced the bare 400 on every admin save. A stub accepts any attribute, so the
  // assertion is on the RECORD, not on the response.
  check('…and neither restated record carried `updatedAt` (NEG for the managed-field trap)', !('updatedAt' in tables.Order.rows.get('o-mine-1')) && !('updatedAt' in tables.Order.rows.get('o-mine-2')))
  // NEG for the line above: the two rows that WERE restated were seeded carrying `updatedAt`, so
  // the absence asserted there is the resource dropping it and not an attribute that was never
  // present — and the row nobody rewrote still carries the owner it was seeded with.
  check('…and the assertion above is about the rewrite: both rows were SEEDED with `updatedAt` (NEG)', tables.Order.rows.get('o-theirs').customerUserId === other && tables.Order.rows.get('o-guest').customerUserId === null)

  const after = await call(AccountApi, 'GET', '', { cookie })
  check('the deleted account\'s cookie no longer reads as anybody → 403 (NEG)', after.status === 403 && after.json?.code === 'auth_required')
}

section(`the rule-20 sweep over every response (${transcript.length})`)
{
  const synthetic = [{ cls: 'X', method: 'GET', pathname: '', status: 401, headers: new Headers({ 'cache-control': 'no-store' }) }]
  check('the sweep catches a 401 (NEG)', responseRulesVerdict(synthetic).some((b) => b.includes('401')))
  const bad = responseRulesVerdict(transcript)
  check('no 401, no WWW-Authenticate on a 403, everything no-store', bad.length === 0, bad.slice(0, 3).join(' | '))
}

process.exit(done())
