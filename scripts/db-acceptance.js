#!/usr/bin/env node
// SEEDED — lib/db.js: the app's table set is bound to a
// database chosen at DEPLOY TIME, so a staging build and a published one are the identical tree
// with a different value in CONFIG.env.
//
// WHAT THIS SUITE IS FOR, and it is one defect rather than four: the lookup has to be LAZY. The
// shape first sketched on that issue resolved `databases[name]` once, at module load, which
// captures `undefined` for good if the component is deployed before the database exists —
// measured on a live 5.3.1 cluster, a new database reaches every worker on both nodes in
// 0.08–0.49 s, so the window is short and real. Nothing about a wrongly-captured handle is
// visible afterwards: every table access throws a message naming neither the database nor the
// variable, out of whichever resource happened to touch a table first.
//
// So the naive shape is SYNTHESIZED AND DRIVEN FIRST, below. Without that, "the lazy one works"
// would pass against either implementation, because a suite that creates the database before
// importing the module never enters the window.
//
// IT READS NOTHING FROM THE ENVIRONMENT. `IMMENSUS_DATABASE` is deleted before anything loads
// and set explicitly per section: a hermetic suite whose verdict depends on the developer's
// shell is green everywhere it is run and proves nothing.
//
// Hermetic: the harperdb stub, a temp directory, no network, no git, no clock.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

delete process.env.IMMENSUS_DATABASE

const { checker, ROOT, fixture, discard } = await import('./probe/harness.js')
const { tables, databases, makeDatabase, resetDatabases } = await import('./probe/harperdb-stub.js')
const { config, DEFAULT_DATABASE } = await import('../lib/config.js')
const { db, missingDatabaseError } = await import('../lib/db.js')

const { check, section, done } = checker('db-acceptance')

const STAGE = 'suite-stage'
const work = fixture(ROOT, [])

/** Read one table off `db`, returning the error instead of throwing it. */
const touch = (table) => {
  try { return { ok: true, value: db[table] } } catch (err) { return { ok: false, err } }
}

section('the naive shape first — the load-order window is real')
{
  // The first sketch of this, self-contained so it needs no copy of lib/. It reads
  // the same variable and resolves at module load, which is the whole of the defect.
  const file = join(work, 'eager-db.js')
  writeFileSync(file, [
    "import { tables, databases } from 'harperdb'",
    "const name = process.env.IMMENSUS_DATABASE || 'data'",
    "export const db = name === 'data' ? tables : databases[name]",
    '',
  ].join('\n'))

  resetDatabases()
  process.env.IMMENSUS_DATABASE = STAGE
  check('PRECONDITION: the named database really is absent when the module loads, so the import below is inside the window',
    databases[STAGE] === undefined)

  const eager = await import(pathToFileURL(file).href)
  check('the eager shape captured nothing', eager.db === undefined)

  // The database now exists, exactly as it would moments after provisioning created it.
  databases[STAGE] = makeDatabase()
  let threw = null
  try { void eager.db.Thing } catch (err) { threw = err }
  check('…and it STAYS broken after the database appears — a module-load lookup is never rescued',
    threw !== null && /Cannot read propert/.test(String(threw.message)), String(threw && threw.message))

  delete process.env.IMMENSUS_DATABASE
  resetDatabases()
}

section('lib/db.js resolves on access, so the same window is harmless')
{
  resetDatabases()
  process.env.IMMENSUS_DATABASE = STAGE
  check('PRECONDITION: absent again, and lib/db.js was imported at the top of this file — long before now',
    databases[STAGE] === undefined)

  const before = touch('Thing')
  check('while the database is absent the access is refused', before.ok === false)

  databases[STAGE] = makeDatabase()
  const after = touch('Thing')
  check('…and the very next access succeeds once it exists — the refusal poisoned nothing',
    after.ok === true && after.value === databases[STAGE].Thing, after.ok ? 'wrong table object' : String(after.err?.message))

  delete process.env.IMMENSUS_DATABASE
  resetDatabases()
}

section('unset means the default database')
{
  delete process.env.IMMENSUS_DATABASE
  check('config.databaseName() falls back to the ONE declared default', config.databaseName() === DEFAULT_DATABASE)
  check('db.X IS tables.X — the same object Harper hands every application, by identity',
    db.User === tables.User && db.Member === tables.Member)
  check('…and the default is reached without touching `databases` at all: that global and `tables` agree',
    databases[DEFAULT_DATABASE] === tables)
  check('asking db what it holds answers about the real database, not about an empty object',
    Object.keys(db).includes('User') && 'User' in db)
  resetDatabases()
}

section('a database that is not there is named, not a TypeError')
{
  resetDatabases()
  process.env.IMMENSUS_DATABASE = 'nowhere'
  const r = touch('User')
  const msg = String(r.err?.message ?? '')
  check('the access is refused', r.ok === false)
  check('…the message names the variable', msg.includes('IMMENSUS_DATABASE'))
  check('…and the value, so a typo is findable from the sentence alone', msg.includes('nowhere'))
  check('…and says what unsetting it would do', msg.includes(DEFAULT_DATABASE))
  check('…and it is NOT the bare member-access error a module-load lookup produces',
    !/Cannot read propert/.test(msg), msg)
  // A symbol is never a table name, so inspecting `db` while the
  // database is missing must not throw — the one moment somebody is most likely to reach for
  // `console.log(db)`. The stub's own proxy answers undefined for a non-string the same way.
  let inspected = null
  try { inspected = String(db[Symbol.toStringTag]) } catch (err) { inspected = 'THREW: ' + err.message }
  check('…and a SYMBOL access does not throw at all, so inspecting db stays harmless',
    inspected === 'undefined', inspected)
  delete process.env.IMMENSUS_DATABASE
  resetDatabases()
}

section('the other refusal branch, which no suite can reach through db')
{
  // `tables` is present wherever Harper is, so the default branch of the refusal is unreachable
  // from here. Driven directly rather than promised.
  const def = missingDatabaseError(DEFAULT_DATABASE)
  check('the default-database refusal does NOT mention the variable, because nothing declared it',
    !def.message.includes('IMMENSUS_DATABASE'), def.message)
  check('…and it says where that leaves the caller', def.message.includes(DEFAULT_DATABASE))
  const named = missingDatabaseError('elsewhere')
  check('CONTROL: the named-database refusal DOES mention the variable, so the two are really different sentences',
    named.message.includes('IMMENSUS_DATABASE') && named.message.includes('elsewhere'))
}

section('the two databases are separate, driven both directions')
{
  resetDatabases()
  databases[STAGE] = makeDatabase()

  process.env.IMMENSUS_DATABASE = STAGE
  await db.Member.put({ id: 'only-in-stage', name: 'dummy' })
  check('a row written through db under the staging name is there', await db.Member.get('only-in-stage') !== null)
  check('…and is NOT in the default database', await tables.Member.get('only-in-stage') === null)

  delete process.env.IMMENSUS_DATABASE
  await db.Member.put({ id: 'only-in-default', name: 'real' })
  check('a row written with nothing set is in the default database', await tables.Member.get('only-in-default') !== null)
  check('…and the staging row is not visible from there', await db.Member.get('only-in-stage') === null)

  process.env.IMMENSUS_DATABASE = STAGE
  check('…nor the default row from staging — the same `db` follows the variable both ways, so the remembered handle cannot pin the wrong one',
    await db.Member.get('only-in-default') === null && await db.Member.get('only-in-stage') !== null)

  delete process.env.IMMENSUS_DATABASE
  resetDatabases()
}

discard(work)
process.exit(done())
