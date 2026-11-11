#!/usr/bin/env node
// FIXED — the schema rules, cross-checked against the resources:
//   2  class name ≠ table name (`Conflicting paths for X` at startup)
//   6  every attribute a `search({ conditions, sort })` names is @indexed (or the key)
//   7  @relationship(to:) fields are array-typed
//   9  HNSW only on [Float] fields
//  10  token tables (MagicLink, *Token) carry @table(expiration:)
//  and every @table type has an @primaryKey (the stub keys on `id`; so does Harper)
//
// Every schema file config.yaml loads is read: the app's own schema.graphql and each kit's
// `schema.<kit>.graphql`, so a resource searching a kit's table is judged against
// the kit's declaration.
//
// Hermetic: parses the schema files and source text; no Harper, no network, no clock.

import { join } from 'node:path'
import { writeFileSync, existsSync, readdirSync } from 'node:fs'
import { ROOT, checker, fixture, discard, walk, read, stripComments, stripHashComments } from './probe/harness.js'

/** `{ [typeName]: { args: { expiration? }, fields: { [name]: { type, indexed, primaryKey, relationship } } } }` */
export function parseSchema (text) {
  const src = stripHashComments(text)
  const types = {}
  const re = /type\s+(\w+)\s+@table(?:\(([^)]*)\))?([^{]*)\{([\s\S]*?)\}/g
  for (const m of src.matchAll(re)) {
    const [, name, argText = '', rest, body] = m
    const args = {}
    for (const a of argText.matchAll(/(\w+)\s*:\s*("[^"]*"|\d+|\w+)/g)) args[a[1]] = a[2].replace(/^"|"$/g, '')
    const fields = {}
    for (const line of body.split('\n')) {
      const f = line.trim().match(/^(\w+)\s*:\s*(\[?\w+!?\]?!?)\s*(.*)$/)
      if (!f) continue
      const [, fname, ftype, directives] = f
      fields[fname] = {
        type: ftype,
        indexed: /@indexed\b/.test(directives) || /@primaryKey\b/.test(directives),
        primaryKey: /@primaryKey\b/.test(directives),
        indexedArgs: (directives.match(/@indexed\(([^)]*)\)/) ?? [])[1] ?? null,
        relationship: (directives.match(/@relationship\(([^)]*)\)/) ?? [])[1] ?? null,
      }
    }
    types[name] = { args, fields, exported: /@export\b/.test(rest) }
  }
  return types
}

/**
 * Every `db.<T>.search({...})` call — and the older `tables.<T>.search` — with the attributes it names.
 * `db.` was once missing: rule 18 moved every resource to `db.<Table>` (lib/db.js), and this matched
 * only `tables.`, so it checked the synthesized controls below and none of the real code.
 */
export function searchCalls (code) {
  const out = []
  const re = /\b(?:tables|db)\.(\w+)\.search\s*\(/g
  for (const m of code.matchAll(re)) {
    let depth = 1
    let i = m.index + m[0].length
    while (i < code.length && depth > 0) { if (code[i] === '(') depth++; else if (code[i] === ')') depth--; i++ }
    const argText = code.slice(m.index + m[0].length, i - 1)
    const attrs = [...argText.matchAll(/attribute\s*:\s*['"](\w+)['"]/g)].map((a) => a[1])
    out.push({ table: m[1], attrs })
  }
  return out
}

export const SCHEMA_FILE = /^schema(?:\.[a-z0-9][a-z0-9-]*)?\.graphql$/
export const schemaFiles = (root) => readdirSync(root).filter((n) => SCHEMA_FILE.test(n)).sort()

export function audit (root) {
  const bad = []
  if (!existsSync(join(root, 'schema.graphql'))) return ['schema.graphql is missing']
  const types = {}
  for (const file of schemaFiles(root)) {
    for (const [name, t] of Object.entries(parseSchema(read(join(root, file))))) {
      // Harper does not merge a table declared in two files — the file read last replaces the other's
      // attributes whole (measured on harper@5.3.1, 2026-10-16) — so a second declaration is a defect.
      if (types[name]) bad.push(`${file} declares ${name}, which ${types[name].file} already declares — Harper keeps one of the two and drops the other's attributes silently`)
      types[name] = { ...t, file }
    }
  }
  const tableNames = Object.keys(types)
  if (!tableNames.length) bad.push('schema.graphql declares no @table type')

  for (const [name, t] of Object.entries(types)) {
    if (!Object.values(t.fields).some((f) => f.primaryKey)) bad.push(`type ${name} has no @primaryKey field`)
    if (/Token$|^MagicLink$/.test(name) && !t.args.expiration) bad.push(`type ${name} holds short-lived tokens but has no @table(expiration:) (rule 10)`)
    for (const [fname, f] of Object.entries(t.fields)) {
      if (f.relationship && /\bto\s*:/.test(f.relationship) && !f.type.startsWith('[')) bad.push(`${name}.${fname} is @relationship(to:) but not array-typed (rule 7)`)
      if (f.relationship && /\bfrom\s*:/.test(f.relationship) && f.type.startsWith('[')) bad.push(`${name}.${fname} is @relationship(from:) but array-typed (rule 7)`)
      if (f.indexedArgs && /HNSW/i.test(f.indexedArgs) && f.type !== '[Float]') bad.push(`${name}.${fname} is HNSW-indexed but not [Float] (rule 9)`)
    }
  }

  const classes = []
  for (const f of walk(join(root, 'resources'))) {
    const code = stripComments(read(f))
    for (const m of code.matchAll(/export\s+class\s+(\w+)\s+extends\s+Resource\b/g)) classes.push({ name: m[1], file: f.slice(root.length + 1) })
  }
  for (const c of classes) if (tableNames.includes(c.name)) bad.push(`${c.file} exports class ${c.name}, which is also a table — Conflicting paths (rule 2)`)

  for (const dir of ['resources', 'lib']) {
    for (const f of walk(join(root, dir))) {
      const rel = f.slice(root.length + 1)
      for (const call of searchCalls(stripComments(read(f)))) {
        const t = types[call.table]
        if (!t) { bad.push(`${rel} searches ${call.table}, which no schema file declares`); continue }
        for (const a of call.attrs) {
          if (!t.fields[a]) bad.push(`${rel} searches ${call.table}.${a}, which the schema does not declare`)
          else if (!t.fields[a].indexed) bad.push(`${rel} searches ${call.table}.${a}, which is not @indexed — an unindexed search returns empty silently (rule 6)`)
        }
      }
    }
  }
  return bad
}

const PATHS = [...schemaFiles(ROOT), 'resources', 'lib']
const { check, section, done } = checker('schema-lint-acceptance')

section('negative controls')
// Every defect below is SYNTHESIZED — a table this suite adds — rather than substituted into a line of
// schema.graphql, which is GENERATED: a needle on a line the app may have written differently is a
// control that matches nothing, and `type MagicLink …` became exactly that the day the template
// stopped having one.
const WIDGET = '\ntype Widget @table {\n  id: ID @primaryKey\n  sku: String @indexed\n  note: String\n}\n'
{
  const w = fixture(ROOT, PATHS)
  const clean = audit(w)
  check('a faithful copy passes', clean.length === 0, clean.join(' | '))
  const schema = read(join(w, 'schema.graphql'))
  writeFileSync(join(w, 'schema.graphql'), schema + WIDGET)
  writeFileSync(join(w, 'resources', 'Widget.js'), "import { Resource } from 'harperdb'\nexport class Widget extends Resource { static loadAsInstance = false }\n")
  check('a class named like a table is caught (rule 2)', audit(w).some((b) => b.includes('class Widget')))
  writeFileSync(join(w, 'resources', 'Widget.js'), "import { Resource } from 'harperdb'\nimport { db } from '../lib/db.js'\nexport class WidgetsApi extends Resource { async get () { for await (const r of db.Widget.search({ conditions: [{ attribute: 'note', value: 'x' }] })) return r } }\n")
  check('a db.<Table> search on an unindexed attribute is caught (rule 6)', audit(w).some((b) => b.includes('Widget.note') && b.includes('not @indexed')))
  writeFileSync(join(w, 'resources', 'Widget.js'), "import { Resource, tables } from 'harperdb'\nexport class WidgetsApi extends Resource { async get () { for await (const r of tables.Widget.search({ conditions: [{ attribute: 'note', value: 'x' }] })) return r } }\n")
  check('the older tables.<Table> form is caught the same way', audit(w).some((b) => b.includes('Widget.note') && b.includes('not @indexed')))
  writeFileSync(join(w, 'resources', 'Widget.js'), "import { Resource } from 'harperdb'\nimport { db } from '../lib/db.js'\nexport class WidgetsApi extends Resource { async get () { for await (const r of db.Widget.search({ conditions: [{ attribute: 'sku', value: 'x' }], sort: { attribute: 'id' } })) return r } }\n")
  check('a search on indexed attributes and the key is NOT flagged', audit(w).length === 0, audit(w).join(' | '))
  writeFileSync(join(w, 'resources', 'Widget.js'), "import { Resource } from 'harperdb'\nimport { db } from '../lib/db.js'\nexport class WidgetsApi extends Resource { async get () { for await (const r of db.Gadget.search({ conditions: [{ attribute: 'sku', value: 'x' }] })) return r } }\n")
  check('a search on a table no schema file declares is caught', audit(w).some((b) => b.includes('Gadget') && b.includes('no schema file')))
  writeFileSync(join(w, 'resources', 'Widget.js'), "export const nothing = 1\n")
  writeFileSync(join(w, 'schema.graphql'), schema + '\ntype SignupToken @table {\n  id: ID @primaryKey\n}\n')
  check('a token table without expiration is caught (rule 10)', audit(w).some((b) => b.includes('SignupToken') && b.includes('expiration')))
  writeFileSync(join(w, 'schema.graphql'), schema + '\ntype SignupToken @table(expiration: 900) {\n  id: ID @primaryKey\n}\n')
  check('a token table WITH expiration is NOT flagged', !audit(w).some((b) => b.includes('SignupToken')), audit(w).join(' | '))
  writeFileSync(join(w, 'schema.graphql'), schema + '\ntype Lesson @table {\n  id: ID @primaryKey\n  module: Module @relationship(to: "moduleId")\n  moduleId: String @indexed\n}\ntype Module @table {\n  id: ID @primaryKey\n}\n')
  check('a non-array @relationship(to:) is caught (rule 7)', audit(w).some((b) => b.includes('Lesson.module') && b.includes('rule 7')))
  writeFileSync(join(w, 'schema.graphql'), schema + '\ntype Chunk @table {\n  id: ID @primaryKey\n  embedding: [Int] @indexed(type: "HNSW", distance: "cosine")\n}\n')
  check('HNSW on a non-[Float] field is caught (rule 9)', audit(w).some((b) => b.includes('Chunk.embedding') && b.includes('rule 9')))
  writeFileSync(join(w, 'schema.graphql'), schema + '\ntype Note @table {\n  body: String\n}\n')
  check('a table with no @primaryKey is caught', audit(w).some((b) => b.includes('Note') && b.includes('@primaryKey')))
  writeFileSync(join(w, 'schema.graphql'), schema)
  discard(w)
}
{
  // A kit's schema file is read beside the app's: its tables count, and declaring one twice is refused.
  const w = fixture(ROOT, PATHS)
  writeFileSync(join(w, 'schema.kit-x.graphql'), WIDGET)
  writeFileSync(join(w, 'resources', 'Widget.js'), "import { Resource } from 'harperdb'\nimport { db } from '../lib/db.js'\nexport class WidgetsApi extends Resource { async get () { for await (const r of db.Widget.search({ conditions: [{ attribute: 'note', value: 'x' }] })) return r } }\n")
  check('a search on a KIT\'s table is judged against the kit\'s schema file (rule 6)', audit(w).some((b) => b.includes('Widget.note') && b.includes('not @indexed')))
  writeFileSync(join(w, 'schema.graphql'), read(join(w, 'schema.graphql')) + WIDGET)
  check('a table declared in schema.graphql AND a kit\'s schema file is refused', audit(w).some((b) => b.includes('declares Widget, which') && b.includes('already declares')))
  discard(w)
}

section('this repository')
const bad = audit(ROOT)
for (const b of bad) check(b, false)
const names = schemaFiles(ROOT).flatMap((f) => Object.keys(parseSchema(read(join(ROOT, f)))))
check(`${schemaFiles(ROOT).join(', ')} (${names.join(', ')}) and resources/ agree with rules 2, 6, 7, 9, 10`, bad.length === 0)
process.exit(done())
