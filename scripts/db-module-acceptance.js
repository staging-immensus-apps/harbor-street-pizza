#!/usr/bin/env node
// SEEDED — rule 18, as it reads since the database became a deploy-time value
//: `lib/db.js` is the only module in resources/, lib/ or
// routes/ that reaches Harper's table set. Everything else reads `db.<Table>`.
//
// THIS WAS `no-export-acceptance` AND IT CHECKED TWO RULES. The `@export` prohibition was removed
// platform-wide on 2026-11-02, so the schema half is gone and
// this file is named for what is left. The rename is not tidying: a gate called `no-export` that no
// longer checks exports is a stale instruction, and it is how
// a withdrawn rule gets read back as live.
//
// WHY THAT IS THE RULE RATHER THAN THE OLD ONE. Rule 18 used to read "`tables.<Table>` from
// `harperdb`; never `databases.<other>`", enforced by looking for the dotted form
// `databases.x`. One database per app is still the rule — what changed is that the one is chosen
// at deploy time, so the app has to select it somewhere, and a `databases[name]` lookup slips
// under a check for `databases.x` by syntax. Being unreachable by a gate is not the same as
// being allowed, so the gate says what it means now.
//
// AND THE NEW CLAUSE IS THE ONE THAT MATTERS: a `tables.X` left anywhere in product code reads
// the DEFAULT database while every line around it reads the configured one. A staging deploy
// would write to `stage` and that one resource would read production, with nothing red
// anywhere. Nothing in the old rule could see it.
//
// `tables` AND `databases` ARE TRUE GLOBALS in a Harper application, not only module exports
// (measured 2026-10-08: `harper@5.3.1 dist/index.d.ts:35` declares both inside `declare
// global`), so checking the import alone would leave a bare `tables.User` with no import
// resolving to the real global. Both shapes are checked.
//
// Hermetic: reads bytes on disk, no network, no git, no clock. Negative controls first.

import { join } from 'node:path'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { ROOT, checker, fixture, discard, walk, read, stripComments } from './probe/harness.js'

// The one module that may reach Harper's table set. A PATH and not a marker in the file,
// because a condition that relaxes a check must be something the subject cannot grant itself
//: a file claiming to be the seam would be a file exempting itself.
export const DB_MODULE = 'lib/db.js'

const HARPER_NAMES = ['tables', 'databases']

const importsFromHarperdb = (code, name) =>
  new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]harperdb(?:/[^'"]*)?['"]`).test(code)

/**
 * Does this file BIND `name` itself — declare it, destructure it, import it, assign it, or take
 * it as a parameter?
 *
 * ITS LIMITS ARE WRITTEN DOWN RATHER THAN MADE CLEVERER: it reads binding shapes by their
 * syntax and not by scope, so a name bound inside one function and read as Harper's global in
 * another reads as bound. That direction is deliberate — a wrong red in somebody's app is a
 * finding nobody over there can clear, where this miss costs a stale read the app's own suites
 * exercise on the next call.
 *
 * AN EARLIER VERSION ASKED THE WEAKER QUESTION and its header claimed more than it did: it
 * tested whether EVERY occurrence of the identifier was the head of a member access, which a
 * single extra mention defeats — a string literal, an object key, a `console.log('tables')` —
 * in exactly the stale-call-site case the clause exists for. Looking for the
 * binding instead is both narrower and truer, and a wrong sentence about a
 * gate is where the next gap in the gate is.
 */
const bindsName = (code, name) => [
  `\\b(?:const|let|var|function|class)\\s+${name}\\b`,            // const tables = …
  `\\b(?:const|let|var)\\s*[{\\[][^;=]*\\b${name}\\b[^;=]*[}\\]]\\s*=`, // const { tables } = …
  `\\bimport\\b[^;]*\\b${name}\\b[^;]*\\bfrom\\b`,                // import { tables } from …
  `\\b${name}\\s*=[^=]`,                                       // tables = …
  `\\([^()]*\\b${name}\\b[^()]*\\)\\s*(?:=>|\\{)`,                 // (tables) => … / function f (tables) {
].some((src) => new RegExp(src).test(code))

/** Does this file read `name` as Harper's implicit global rather than as something of its own? */
const readsImplicitGlobal = (code, name) =>
  new RegExp(`\\b${name}\\s*(?:\\.|\\[)`).test(code) && !bindsName(code, name)

// Every schema file config.yaml loads: the app's own and each kit's `schema.<kit>.graphql`.
// A kit's table exported is the same REST route around its row rules.
export const SCHEMA_FILE = /^schema(?:\.[a-z0-9][a-z0-9-]*)?\.graphql$/
export function audit (root) {
  const bad = []
  if (!existsSync(join(root, 'schema.graphql'))) bad.push('schema.graphql is missing')
  for (const dir of ['resources', 'lib', 'routes']) {
    for (const f of walk(join(root, dir))) {
      const rel = f.slice(root.length + 1)
      const code = stripComments(read(f))
      for (const name of HARPER_NAMES) {
        if (rel !== DB_MODULE && importsFromHarperdb(code, name)) {
          bad.push(`${rel} imports ${name} from harperdb — only ${DB_MODULE} may; read db.<Table> instead`)
        }
        if (readsImplicitGlobal(code, name)) {
          bad.push(`${rel} reads Harper's global ${name} — read db.<Table> from ${DB_MODULE}, or the configured database is bypassed`)
        }
      }
    }
  }
  return bad
}

const PATHS = [...readdirSync(ROOT).filter((n) => SCHEMA_FILE.test(n)), 'resources', 'lib', 'routes']
const { check, section, done } = checker('db-module-acceptance')

section('negative control — a faithful copy')
{
  const w = fixture(ROOT, PATHS)
  const clean = audit(w)
  check('a faithful copy passes', clean.length === 0, clean.join(' | '))
  discard(w)
}

section('negative controls — only lib/db.js reaches the table set')
{
  const w = fixture(ROOT, PATHS)
  const leak = join(w, 'lib', 'leak.js')

  // The form the old rule caught.
  writeFileSync(leak, "import { databases } from 'harperdb'\nexport const t = databases.other.Thing\n")
  check('a dotted databases.<other> in lib/ is caught', audit(w).some((b) => b.includes('lib/leak.js') && b.includes('databases')))

  // THE FORM THAT SLIPPED UNDER IT, and the reason this suite changed: a bracket lookup is the
  // shape a deploy-time selection needs, so a gate reading only `databases.x` would permit a
  // second one anywhere in the app.
  writeFileSync(leak, "const which = 'other'\nexport const t = databases[which].Thing\n")
  check('a BRACKETED databases[x] is caught — the form a dotted-only check misses',
    audit(w).some((b) => b.includes('lib/leak.js') && b.includes('databases')))

  // The stale call site the rename creates, which is the defect this clause exists for.
  writeFileSync(leak, 'export const t = tables.User\n')
  check("a bare tables.X reading Harper's global is caught (the stale call site)",
    audit(w).some((b) => b.includes('lib/leak.js') && b.includes('tables') && b.includes('global')))

  writeFileSync(leak, "import { tables } from 'harperdb'\nexport const t = tables\n")
  check('importing tables from harperdb outside lib/db.js is caught, even unused',
    audit(w).some((b) => b.includes('lib/leak.js') && b.includes('imports tables from harperdb')))

  // MUST NOT FIRE — see readsImplicitGlobal's note. `tables` is an ordinary noun.
  writeFileSync(leak, 'export function free (all) {\n  const tables = all.filter((t) => !t.taken)\n  return tables.length > 0 ? tables[0] : null\n}\n')
  check('a locally declared `tables` read as an ordinary array is NOT flagged',
    !audit(w).some((b) => b.includes('lib/leak.js')), audit(w).join(' | '))

  // One extra mention of the word used to exempt the file, which is
  // the stale-call-site case this clause exists for. Each of these reads the global AND mentions
  // the word elsewhere in a way that binds nothing, so each must still be caught.
  for (const [label, body] of [
    ['a string literal', "export const t = tables.User\nexport const label = 'tables'\n"],
    ['an object key', "export const t = tables.User\nexport const meta = { tables: 1 }\n"],
    ['a log line', "export const t = tables.User\nconsole.log('tables')\n"],
  ]) {
    writeFileSync(leak, body)
    check(`…and ${label} mentioning the word does NOT buy a pass`,
      audit(w).some((b) => b.includes('lib/leak.js') && b.includes('global')), audit(w).join(' | '))
  }

  // MUST NOT FIRE, the other four binding shapes beside `const`.
  for (const [label, body] of [
    ['a destructured binding', "export function f (o) {\n  const { tables } = o\n  return tables.length\n}\n"],
    ['a parameter', "export function f (tables) {\n  return tables.length\n}\n"],
    ['an assignment', "let x\nexport function f (o) {\n  tables = o\n  return tables.length\n}\nlet tables\n"],
    ['an import from elsewhere', "import { tables } from './seating.js'\nexport const n = tables.length\n"],
  ]) {
    writeFileSync(leak, body)
    check(`${label} of its own is NOT flagged`,
      !audit(w).some((b) => b.includes('lib/leak.js')), audit(w).join(' | '))
  }

  writeFileSync(leak, '// never databases.other or tables.User here\nexport const t = 1\n')
  check('both names inside a COMMENT are NOT flagged (the audit reads stripped code)',
    !audit(w).some((b) => b.includes('lib/leak.js')))

  // CONTROL FOR THE EXEMPTION ITSELF. lib/db.js passes because of what it is, so prove the pass
  // is the path and not the rule having gone quiet: the same bytes at another path must red.
  writeFileSync(join(w, 'lib', 'not-db.js'), read(join(w, DB_MODULE)))
  const moved = audit(w)
  check('lib/db.js is exempt by PATH — its own bytes at another path still red',
    moved.some((b) => b.includes('lib/not-db.js') && b.includes('imports tables from harperdb')), moved.join(' | '))
  check('…and lib/db.js itself is never named by that finding',
    !moved.some((b) => b.startsWith(`${DB_MODULE} imports`)), moved.join(' | '))
  discard(w)
}

section('this repository')
const bad = audit(ROOT)
for (const b of bad) check(b, false)
check('only lib/db.js reaches the table set', bad.length === 0)
process.exit(done())
