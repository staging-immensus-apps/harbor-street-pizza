#!/usr/bin/env node
// GENERATED — the one check that holds `lib/managed-fields.js`'s MANAGED_FIELDS against the SDL.
//
// MANAGED_FIELDS is hand-transcribed, and until this suite existed nothing compared it to anything:
// `MenuAdminApi-probe` and `OrderAdminApi-probe` assert captured writes through `managedFieldsIn()`,
// which reads that same map, so the map was checked against itself. The drift is one-directional and
// silent — adding `@updatedTime` to a new field or a new table would leave the list stale and bring
// back the bare `400 Bad Request` on every save, with every probe still green.
//
// So the expected value is PARSED OUT OF THE SCHEMA FILES rather than restated here: every
// `schema*.graphql` in the repo root is read, each `@createdTime` / `@updatedTime` field is
// collected per table, and the result must equal MANAGED_FIELDS exactly — no missing table, no extra
// table, no missing or extra field. That covers the kit schemas too, which is how
// `User.createdAt`/`updatedAt` are held OUT of the map: the sign-in kit declares them as plain
// `String` columns with no directive, and the kit's own code writes them.
//
// Negative controls synthesize the drift rather than anchoring on text: a new table carrying
// `@updatedTime`, a directive deleted from a table that has one, and a field renamed — each must be
// reported by the same comparison that passes over the real files.
//
// Hermetic: reads files, no network, no git, no wall clock.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { freezeClock } from './probe/frozen-clock.js'
import { checker, ROOT } from './probe/harness.js'
import { MANAGED_FIELDS } from '../lib/managed-fields.js'

freezeClock()

const { check, section, done } = checker('managed-fields-probe')

/**
 * `{ Table: [field, ...] }` for every field in `sdl` carrying `@createdTime` or `@updatedTime`.
 * A table with none is absent, which is what MANAGED_FIELDS does too.
 */
function parseManaged (sdl) {
  const out = {}
  // GraphQL comments quote the very directives this parser looks for (schema.graphql's header does),
  // so they come off first or the header alone would invent fields.
  const src = sdl.replace(/#[^\n]*/g, '')
  const block = /type\s+(\w+)\s*(?:@[\w]+\s*(?:\([^)]*\))?\s*)*\{([^}]*)\}/g
  let m
  while ((m = block.exec(src)) !== null) {
    const [, table, body] = m
    const fields = []
    for (const line of body.split('\n')) {
      if (!/@createdTime|@updatedTime/.test(line)) continue
      const named = line.trim().match(/^(\w+)\s*:/)
      if (named) fields.push(named[1])
    }
    if (fields.length) out[table] = fields.sort()
  }
  return out
}

/** Every way `actual` disagrees with `expected`, as readable strings. Empty means they match. */
function differences (expected, actual) {
  const out = []
  for (const table of Object.keys(expected)) {
    if (!actual[table]) { out.push(`${table}: in the schema, missing from MANAGED_FIELDS`); continue }
    const want = [...expected[table]].sort().join(',')
    const got = [...actual[table]].sort().join(',')
    if (want !== got) out.push(`${table}: schema has [${want}], MANAGED_FIELDS has [${got}]`)
  }
  for (const table of Object.keys(actual)) {
    if (!expected[table]) out.push(`${table}: in MANAGED_FIELDS, no such managed field in any schema`)
  }
  return out
}

const schemaFiles = readdirSync(ROOT).filter((f) => /^schema.*\.graphql$/.test(f)).sort()
const sources = schemaFiles.map((f) => readFileSync(join(ROOT, f), 'utf8'))

section(`the schema files were found and parsed (${schemaFiles.length})`)
{
  check('at least schema.graphql is present', schemaFiles.includes('schema.graphql'))
  check('the kit schemas are read too, so a kit field cannot be missed', schemaFiles.includes('schema.sign-in.graphql') && schemaFiles.includes('schema.payments.graphql'))
}

const expected = {}
for (const sdl of sources) for (const [table, fields] of Object.entries(parseManaged(sdl))) expected[table] = fields

section('the parser reads the SDL rather than a list of its own')
{
  check('it found at least one managed field in the real schema', Object.keys(expected).length > 0, JSON.stringify(expected))
  check('MenuItem.createdAt is picked up from its @createdTime directive', (expected.MenuItem ?? []).includes('createdAt'))
  check('a plain field beside it is NOT picked up (NEG)', !(expected.MenuItem ?? []).includes('name') && !(expected.MenuItem ?? []).includes('priceCents'))
  check('User is absent: the sign-in kit declares createdAt/updatedAt with no directive (NEG)', !('User' in expected))
}

section('MANAGED_FIELDS equals the set of @createdTime / @updatedTime fields in the schema')
{
  const diff = differences(expected, MANAGED_FIELDS)
  check('no table or field drifts between lib/managed-fields.js and schema*.graphql', diff.length === 0, diff.join(' | '))
}

section('the comparison can say no — each drift synthesized, not quoted from a file')
{
  const added = parseManaged('type Widget @table {\n  id: ID @primaryKey\n  touchedAt: Long @updatedTime\n}\n')
  check('a NEW table carrying @updatedTime is reported as missing from the map (NEG)', differences({ ...expected, ...added }, MANAGED_FIELDS).some((d) => d.startsWith('Widget:')))

  const victim = Object.keys(expected)[0]
  const dropped = { ...expected }
  delete dropped[victim]
  check(`a table that LOSES its directive is reported as an extra in the map (NEG, ${victim})`, differences(dropped, MANAGED_FIELDS).some((d) => d.startsWith(`${victim}:`)))

  const renamed = { ...expected, [victim]: [...expected[victim].slice(1), 'renamedAt'] }
  check(`a RENAMED managed field is reported (NEG, ${victim})`, differences(renamed, MANAGED_FIELDS).some((d) => d.startsWith(`${victim}:`)))

  check('and the same comparison holds over the real pair (NEG control for the three above)', differences(expected, MANAGED_FIELDS).length === 0)
}

process.exit(done())
