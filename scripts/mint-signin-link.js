#!/usr/bin/env node
// FIXED — mint a single-use sign-in link for an address on a DEPLOYED cluster.
//
//   node scripts/mint-signin-link.js <email> [--create-member] [--name "Ada"]
//                                   [--purpose login] [--app-url https://…] [--database data]
//                                   [--dry-run] [--self-test] [--json]
//
// WHY THIS EXISTS. Members of a generated app sign in by magic link (or Google); only the
// first admin ever has a password, and `POST /AuthApi/password` enforces that (lib/auth.js,
// schema.graphql, CLAUDE.md — five artefacts say so, and `claimUserForEmail` writes
// `passwordHash: null` on every account-creating path, so the policy is structural and not
// just a role check). QA has no inbox. So the only honest way for QA to be a MEMBER is the
// member's own route: write a MagicLink row and redeem it at GET /AuthApi/verify?token=…,
// single-use and expiring in 15 minutes (`MagicLink @table(expiration: 900)`).
//
// IT GRANTS NOTHING NEW. It runs over the ops API with the instance credentials
// `scripts/deploy.js` already needs, and whoever holds those can write any row in the
// database — including `role: admin` and a password hash. This is a convenience over a
// capability that is already total, which is the only shape such a tool may have. It
// therefore refuses to be part of a privilege escalation: it writes no `passwordHash` and no
// role but `member`, and `verdict()` below is a gate on its own output, self-tested first.
//
// ONE THING IT DOES BYPASS, said out loud so a later reader does not read it as a hole:
// writing the `MagicLink` row directly skips `issueMagicLink`, so it does not touch
// `magicLinkSendTimestamps` and is not counted by rule 25's per-address send limit. That limit
// exists to stop an ANONYMOUS caller using `POST /AuthApi/request-link` as a mail cannon; the
// caller here is already authenticated to the database as an instance user and could clear the
// counter with one write. It also deliberately does NOT send mail, so there is nothing to
// flood. Minting a link for an existing ADMIN is allowed for the same reason, and
// `--self-test` asserts it so the decision is on the record rather than inferred from silence.
//
// WHY IT USES `insert`. The ops API's `update` answers HTTP 200 and writes NOTHING when the
// record does not exist — the id comes back in `skipped_hashes` — so a writer that checks
// only the status code reports success forever (CLAUDE.md §6). Creating through it is not
// creating. Every write here is an `insert`, and `verdict()` refuses a plan containing an
// `update`.
//
// Hermetic: `--self-test` drives the pure functions only — no network, no clock of its own
// (`now` is a parameter), no git. `npm run check-signin-link` is what the suite runner sees.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { ROLE_MEMBER, normalizeEmail, userIdFor, newUser, hashToken, generateToken } from '../lib/identity.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_DATABASE = 'data'
// Harper owns the `Authorization` header at its REST boundary, but the ops API on 9925 IS
// Harper's own operations surface and Basic auth is how it authenticates (rule 27 is about
// IMMENSUS endpoints, which are Harper apps — a different boundary entirely).
export const DEFAULT_OPS_PORT = 9925

// ── the pure core ──────────────────────────────────────────────────────────────

/**
 * PURE plan: the operations that mint a link, or a refusal. Nothing here does I/O.
 *
 * `existing` is the User row already on the cluster, or null. A row that exists is never
 * written to — not even to clear a rate-limit counter — so minting a link cannot change an
 * account's role, name or state.
 */
export function planFor ({ email, existing = null, createMember = false, name = null, purpose = 'login', token, now = new Date(), appUrl, database = DEFAULT_DATABASE }) {
  const normalized = normalizeEmail(email)
  if (!normalized) return { ok: false, reason: `"${email ?? ''}" is not an email address`, operations: [], url: null }
  if (!appUrl) return { ok: false, reason: 'no app URL — pass --app-url or set PUBLIC_APP_URL', operations: [], url: null }
  if (!token) return { ok: false, reason: 'no token was generated', operations: [], url: null }
  if (!existing && !createMember) {
    return { ok: false, reason: `no account for ${normalized} — pass --create-member to make one as a member`, operations: [], url: null }
  }
  if (existing?.deactivatedAt) {
    return { ok: false, reason: `${normalized} is deactivated; AuthApi/verify would refuse the link anyway`, operations: [], url: null }
  }

  const userId = existing ? existing.id : userIdFor(normalized)
  const operations = []
  if (!existing) {
    // The same row shape lib/auth.js's claimUserForEmail() writes, from the same function:
    // role member, no password, counters empty. That is the point of lib/identity.js.
    operations.push({ operation: 'insert', database, table: 'User', records: [newUser({ email: normalized, name, role: ROLE_MEMBER, now })] })
  }
  operations.push({
    operation: 'insert',
    database,
    table: 'MagicLink',
    // id is the token's HASH (rule 10): the cluster never holds anything that can be
    // replayed, and the token exists only in the URL this prints.
    records: [{ id: hashToken(token), userId, email: normalized, purpose, createdAt: now.toISOString() }],
  })
  return {
    ok: true,
    reason: existing ? `link for the existing account ${normalized}` : `new member ${normalized} and a link`,
    operations,
    url: `${String(appUrl).replace(/\/+$/, '')}/AuthApi/verify?token=${encodeURIComponent(token)}`,
    userId,
  }
}

/**
 * PURE verdict on a plan: the problems, or an empty list. This is the gate — it is run on
 * every real invocation before anything is sent, and self-tested against synthesized
 * defective plans first, so a plan that would escalate privilege or write through `update`
 * cannot leave this process.
 *
 * The sha256 is transcribed here independently of lib/identity.js on purpose: a gate that
 * asks the code under test what the right answer is proves only that it agrees with itself.
 */
export function verdict (plan, { token } = {}) {
  const bad = []
  if (!plan?.ok) return bad
  const ops = plan.operations ?? []
  const records = ops.flatMap((o) => o.records ?? [])
  for (const o of ops) {
    if (o.operation === 'update') bad.push(`an \`update\` on ${o.table}: the ops API answers 200 and writes nothing for a record that does not exist (CLAUDE.md §6)`)
    else if (o.operation !== 'insert') bad.push(`${o.table}: unexpected operation \`${o.operation}\``)
  }
  for (const r of records) {
    if (r.passwordHash != null) bad.push('a record carries a passwordHash — this tool never mints a credential')
    if ('role' in r && r.role !== ROLE_MEMBER) bad.push(`a record carries role "${r.role}" — this tool only ever writes a member`)
  }
  const links = ops.filter((o) => o.table === 'MagicLink')
  if (links.length !== 1) bad.push(`expected exactly one MagicLink write, got ${links.length}`)
  const link = links[0]?.records?.[0]
  if (link && token) {
    const expected = crypto.createHash('sha256').update(String(token)).digest('hex')
    if (link.id !== expected) bad.push('the MagicLink id is not the sha256 of the token (rule 10)')
    if (link.id === token) bad.push('the MagicLink id IS the token — the cluster would hold a replayable secret')
    if (String(link.id).includes('@')) bad.push('the MagicLink id contains an address — rule 10 forbids keying a token table by PII')
    if (link.userId !== plan.userId) bad.push('the MagicLink points at a different user than the plan does')
  }
  if (token) {
    const serialized = JSON.stringify(ops)
    if (serialized.includes(token)) bad.push('the raw token appears in an operation — only its hash may be written')
    if (!String(plan.url ?? '').includes(encodeURIComponent(token))) bad.push('the printed URL does not carry the token')
  }
  const users = ops.filter((o) => o.table === 'User')
  const user = users[0]?.records?.[0]
  if (user && user.id !== userIdFor(user.email)) bad.push('the User id is not derived from the address (lib/identity.js userIdFor)')
  return bad
}

// ── the cluster side ───────────────────────────────────────────────────────────

/** Minimal .env reader, the shape scripts/deploy.js uses. Never prints a value. */
export function parseEnvFile (text) {
  const out = {}
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim().startsWith('#')) continue
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

export const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?)$/i

/**
 * `{ ok, url, reason }` for a CLI_TARGET, which may be a bare host, an app URL or an ops URL.
 * A bare host defaults to https. An explicit `http://` is REFUSED for anything but loopback:
 * this request carries the instance password in a Basic header, and `scripts/deploy.js` only
 * ever had to refuse localhost, so there was no precedent to inherit. Fail closed rather than
 * silently upgrading, so an operator learns their CLI_TARGET is wrong here instead of
 * wondering why one tool reached a host another could not.
 */
export function opsUrlFor (cliTarget, port = DEFAULT_OPS_PORT) {
  const raw = String(cliTarget ?? '').trim()
  if (!raw) return { ok: false, url: null, reason: 'CLI_TARGET is not set' }
  let u
  try { u = new URL(raw.includes('://') ? raw : `https://${raw}`) } catch { return { ok: false, url: null, reason: `CLI_TARGET "${raw}" is not a URL` } }
  if (u.protocol === 'http:' && !LOOPBACK.test(u.hostname)) {
    return { ok: false, url: null, reason: `CLI_TARGET is http://${u.hostname} — this call sends the instance password in a Basic header, so plain HTTP is refused for anything but loopback` }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, url: null, reason: `CLI_TARGET scheme ${u.protocol} is not http(s)` }
  return { ok: true, url: `${u.protocol}//${u.hostname}:${u.port || port}/`, reason: `ops API at ${u.hostname}:${u.port || port}` }
}

function makeOps ({ url, username, password, timeoutMs = 20000 }) {
  const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
  return async function op (body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* not JSON */ }
    return { status: res.status, json, text }
  }
}

/**
 * Read the User row for an address, or null. `search_by_id` on the DERIVED id, so this asks
 * the same question `findUserById` does rather than a search that depends on an index.
 */
async function readUser (op, { email, database }) {
  const r = await op({ operation: 'search_by_id', database, table: 'User', ids: [userIdFor(email)], get_attributes: ['id', 'email', 'role', 'deactivatedAt'] })
  if (r.status >= 400) throw new Error(`search_by_id -> ${r.status} ${r.text.slice(0, 200)}`)
  const rows = Array.isArray(r.json) ? r.json : (r.json?.records ?? [])
  return rows.find((row) => row && row.id) ?? null
}

/** Run the plan. Throws on the first operation the cluster refuses, or on a silent skip. */
async function apply (op, plan) {
  const results = []
  for (const operation of plan.operations) {
    const r = await op(operation)
    if (r.status >= 400) throw new Error(`${operation.operation} ${operation.table} -> ${r.status} ${r.text.slice(0, 300)}`)
    // An `insert` that skipped is a duplicate key, not a success. The ops API reports it in
    // the body with a 200, which is the whole reason this check is not the status code.
    const skipped = r.json?.skipped_hashes ?? []
    if (skipped.length) throw new Error(`${operation.operation} ${operation.table} wrote nothing: ${JSON.stringify(skipped).slice(0, 200)} already exists`)
    // The two inserts are not one transaction. A User insert that succeeds before a MagicLink
    // insert that fails leaves the member row behind, which is harmless and self-healing: the
    // next run reads that row and writes only the link. Said here so the operator does not go
    // looking for a cleanup step that is not needed.
    if (operation.table === 'User') results.push({ table: 'User', status: r.status, inserted: (r.json?.inserted_hashes ?? []).length, note: 'kept if a later step fails; a rerun reuses it' })
    if (operation.table !== 'User') results.push({ table: operation.table, status: r.status, inserted: (r.json?.inserted_hashes ?? []).length })
  }
  return results
}

// ── CLI ────────────────────────────────────────────────────────────────────────

export function parseArgs (argv) {
  const out = { email: null, createMember: false, name: null, purpose: 'login', appUrl: null, database: DEFAULT_DATABASE, dryRun: false, selfTest: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--create-member') out.createMember = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--self-test') out.selfTest = true
    else if (a === '--json') out.json = true
    else if (a === '--name') out.name = argv[++i] ?? null
    else if (a === '--purpose') out.purpose = argv[++i] ?? 'login'
    else if (a === '--app-url') out.appUrl = argv[++i] ?? null
    else if (a === '--database') out.database = argv[++i] ?? DEFAULT_DATABASE
    else if (!a.startsWith('-') && !out.email) out.email = a
  }
  return out
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.selfTest) process.exit(selfTest())
  if (!args.email) {
    console.error('usage: node scripts/mint-signin-link.js <email> [--create-member] [--name "Ada"] [--app-url https://…] [--dry-run]')
    process.exit(2)
  }

  const env = { ...parseEnvFile(existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8') : ''), ...process.env }
  const appUrl = args.appUrl ?? env.PUBLIC_APP_URL ?? null
  const { token } = generateToken()

  let existing = null
  let op = null
  // Said BEFORE the plan, because a dry run's refusal would otherwise read as a fact about
  // the cluster ("no account for …") when nothing was asked.
  if (args.dryRun) console.log('dry run: no cluster is read, so this assumes the address has no account yet.')
  if (!args.dryRun) {
    const target = opsUrlFor(env.CLI_TARGET)
    if (!target.ok) { console.error(`❌ ${target.reason}. --dry-run needs no target at all.`); process.exit(2) }
    if (!env.CLI_TARGET_USERNAME || !env.CLI_TARGET_PASSWORD) {
      console.error('❌ CLI_TARGET_USERNAME and CLI_TARGET_PASSWORD are required (the same credentials `npm run deploy` reads). --dry-run needs none of them.')
      process.exit(2)
    }
    op = makeOps({ url: target.url, username: env.CLI_TARGET_USERNAME, password: env.CLI_TARGET_PASSWORD })
    existing = await readUser(op, { email: args.email, database: args.database })
  }

  const plan = planFor({ ...args, existing, token })
  if (!plan.ok) { console.error(`❌ ${plan.reason}`); process.exit(1) }
  const bad = verdict(plan, { token })
  if (bad.length) { console.error(`❌ refusing to send this plan:\n   - ${bad.join('\n   - ')}`); process.exit(1) }

  if (args.dryRun) {
    // The token is in the URL, so a dry run prints the operations WITHOUT it. It also reaches
    // no cluster, so `existing` is null whatever is really there — said out loud, because
    // "would create a new member" is otherwise read as "there is no account".
    console.log(`would ${plan.reason}:`)
    for (const o of plan.operations) console.log(`  ${o.operation} ${o.database}.${o.table} (${o.records.length} record)`)
    process.exit(0)
  }

  const results = await apply(op, plan)
  if (args.json) console.log(JSON.stringify({ ok: true, userId: plan.userId, url: plan.url, results }))
  else {
    console.log(`✅ ${plan.reason}`)
    for (const r of results) console.log(`   ${r.table}: ${r.inserted} inserted`)
    console.log(`\n${plan.url}\n`)
    console.log('Single use, 15 minutes. GET it and keep the Set-Cookie.')
  }
}

// ── self-test ──────────────────────────────────────────────────────────────────

function selfTest () {
  let failed = 0
  const check = (label, ok, detail = '') => {
    if (!ok) failed++
    console.log(`${ok ? '  ok' : 'FAIL'}  ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  }
  const NOW = new Date('2026-06-01T12:00:00.000Z')
  const base = { email: 'Member@Example.test', appUrl: 'https://app.example.test/', now: NOW, token: 'a-test-token', database: 'data' }

  console.log('negative controls — every verdict must be able to fail')
  {
    const good = planFor({ ...base, createMember: true })
    check('a faithful plan has no problems', verdict(good, { token: base.token }).length === 0, verdict(good, { token: base.token }).join(' | '))
    // Each control mutates the plan this run actually produced, never a literal copy of it,
    // so a control cannot quietly become a no-op when the plan's shape changes.
    const mutate = (fn) => { const p = JSON.parse(JSON.stringify(good)); fn(p); return verdict(p, { token: base.token }) }
    check('an `update` instead of an insert is caught (NEG)', mutate((p) => { p.operations[0].operation = 'update' }).some((b) => b.includes('`update`')))
    check('a passwordHash on any record is caught (NEG)', mutate((p) => { p.operations[0].records[0].passwordHash = 'salt:hash' }).some((b) => b.includes('passwordHash')))
    check('role admin is caught (NEG)', mutate((p) => { p.operations[0].records[0].role = 'admin' }).some((b) => b.includes('only ever writes a member')))
    check('a MagicLink keyed by the raw token is caught (NEG)', mutate((p) => { const l = p.operations.find((o) => o.table === 'MagicLink'); l.records[0].id = base.token }).some((b) => b.includes('IS the token')))
    check('a MagicLink keyed by the address is caught (NEG)', mutate((p) => { const l = p.operations.find((o) => o.table === 'MagicLink'); l.records[0].id = 'member@example.test' }).some((b) => b.includes('rule 10')))
    check('a MagicLink pointing at another user is caught (NEG)', mutate((p) => { const l = p.operations.find((o) => o.table === 'MagicLink'); l.records[0].userId = 'u_somebody-else' }).some((b) => b.includes('different user')))
    check('a second MagicLink write is caught (NEG)', mutate((p) => { p.operations.push(JSON.parse(JSON.stringify(p.operations.find((o) => o.table === 'MagicLink')))) }).some((b) => b.includes('exactly one MagicLink')))
    check('the raw token written into an operation is caught (NEG)', mutate((p) => { p.operations[0].records[0].name = base.token }).some((b) => b.includes('raw token appears')))
    check('a URL with no token is caught (NEG)', mutate((p) => { p.url = 'https://app.example.test/AuthApi/verify' }).some((b) => b.includes('does not carry the token')))
    check('a User id that is not derived from the address is caught (NEG)', mutate((p) => { p.operations[0].records[0].id = 'u_made-up' }).some((b) => b.includes('derived from the address')))
  }

  console.log('refusals')
  {
    check('a malformed address is refused and plans nothing (NEG)', (() => { const p = planFor({ ...base, email: 'not-an-email', createMember: true }); return !p.ok && p.operations.length === 0 })())
    check('no app URL is refused (NEG)', !planFor({ ...base, appUrl: null, createMember: true }).ok)
    check('an unknown address without --create-member is refused (NEG)', (() => { const p = planFor({ ...base }); return !p.ok && /--create-member/.test(p.reason) })())
    check('a deactivated account is refused (NEG)', !planFor({ ...base, existing: { id: userIdFor(base.email), email: 'member@example.test', deactivatedAt: '2026-05-01T00:00:00.000Z' } }).ok)
  }

  console.log('the plan itself')
  {
    const made = planFor({ ...base, createMember: true, name: '  Ada  ' })
    const user = made.operations.find((o) => o.table === 'User')?.records?.[0]
    const link = made.operations.find((o) => o.table === 'MagicLink')?.records?.[0]
    check('a new account is one User insert plus one MagicLink insert', made.operations.length === 2 && made.operations.every((o) => o.operation === 'insert'))
    check('the member row is a member with no password and empty counters', user.role === 'member' && user.passwordHash === null && user.magicLinkSendTimestamps.length === 0 && user.passwordAttemptTimestamps.length === 0)
    check('the address is normalized and the name trimmed', user.email === 'member@example.test' && user.name === 'Ada')
    check('the User id is the derivation lib/identity.js computes', user.id === userIdFor('member@example.test') && user.id === 'u_' + crypto.createHash('sha256').update('member@example.test').digest('hex').slice(0, 32))
    check('the MagicLink id is sha256(token) and the link points at that user', link.id === crypto.createHash('sha256').update(base.token).digest('hex') && link.userId === user.id)
    check('the URL is the verify route with the token url-encoded', made.url === `https://app.example.test/AuthApi/verify?token=${encodeURIComponent(base.token)}`)
    check('createdAt comes from the `now` passed in, not the wall clock', link.createdAt === NOW.toISOString())

    const existing = { id: userIdFor(base.email), email: 'member@example.test', role: 'member', deactivatedAt: null }
    const reuse = planFor({ ...base, existing })
    check('an EXISTING account is never written to — only the link is', reuse.ok && reuse.operations.length === 1 && reuse.operations[0].table === 'MagicLink')
    check('…and the link points at the row that is already there', reuse.operations[0].records[0].userId === existing.id)
    const admin = planFor({ ...base, existing: { id: userIdFor(base.email), email: 'member@example.test', role: 'admin', deactivatedAt: null } })
    check('an admin can be sent a link too, and still nothing is written to their row', admin.ok && admin.operations.length === 1 && verdict(admin, { token: base.token }).length === 0)
  }

  console.log('two different tokens never make one link')
  {
    const a = planFor({ ...base, createMember: true, token: 't-one' })
    const b = planFor({ ...base, createMember: true, token: 't-two' })
    const idOf = (p) => p.operations.find((o) => o.table === 'MagicLink').records[0].id
    check('a different token is a different key', idOf(a) !== idOf(b))
    check('the same address is the same user id', a.userId === b.userId)
    const { token, hash } = generateToken()
    check('generateToken() hands back a token and its own hash', hash === crypto.createHash('sha256').update(token).digest('hex') && token.length > 32)
  }

  console.log('the ops URL')
  {
    check('a bare host defaults to https on the ops port', opsUrlFor('s1.example.test').url === 'https://s1.example.test:9925/')
    check('an app URL becomes the ops port', opsUrlFor('https://app.example.test/').url === 'https://app.example.test:9925/')
    check('an explicit port is kept', opsUrlFor('https://app.example.test:9925').url === 'https://app.example.test:9925/')
    check('nothing is refused (NEG)', opsUrlFor('').ok === false)
    check('not a URL is refused (NEG)', opsUrlFor('http://[bad').ok === false)
    check('plain HTTP to a remote host is REFUSED — this call carries a password (NEG)', (() => { const t = opsUrlFor('http://app.example.test'); return !t.ok && /Basic header/.test(t.reason) })())
    check('…but plain HTTP to loopback is allowed, for a dev instance', opsUrlFor('http://localhost:9925').url === 'http://localhost:9925/')
    check('a non-http scheme is refused (NEG)', opsUrlFor('ftp://app.example.test').ok === false)
    check('parseEnvFile ignores comments and strips quotes, and reports no value it read', (() => {
      const e = parseEnvFile('# CLI_TARGET=commented\nCLI_TARGET="https://x.test"\nexport A=b\n')
      return e.CLI_TARGET === 'https://x.test' && e.A === 'b' && !('# CLI_TARGET' in e)
    })())
  }

  if (failed) console.error(`\n❌ ${failed} self-test case(s) failed — the mint guard is not doing its job.`)
  else console.log('\n✅ mint-signin-link self-test: every case held.')
  return failed ? 1 : 0
}

// Exported helpers above are imported by auth-acceptance, so the CLI must only run when this
// file IS the entry point — an import must not execute it.
function invokedDirectly () {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (invokedDirectly()) await main()
