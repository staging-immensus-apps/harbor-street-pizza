#!/usr/bin/env node
// FIXED — the runtime-safety greps of CLAUDE.md §4 as a suite with negative controls, so
// pr-check's `check` job and this file cannot silently disagree:
//   24  no named sync-spawn import from node:child_process in resources/, lib/, routes/
//   21  no `fastify.head(` in routes/ (raw text, comments included — pr-check greps raw)
//   23  nothing under /.well-known/ in routes/ or resources/ (raw text, `//` lines exempt)
//   20  no `statusCode: 401` assignment
//    8  no `createBlob(`
//    5  routes/*.js never reach harperdb through the relative import graph (the platform imports
//       routes/build.js standing alone, under plain node)
//   28  no re-export-from in resources/, lib/, routes/ — Harper's ESM linker leaves the module
//       UNLINKED when one specifier is requested twice, and every route then 500s
//
// Hermetic: reads bytes on disk, no network, no git, no clock.

import { join, resolve, dirname } from 'node:path'
import { writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { ROOT, checker, fixture, discard, walk, read, stripComments, importSpecifiers } from './probe/harness.js'

const COMPONENT_DIRS = ['resources', 'lib', 'routes']

export function audit (root) {
  const bad = []
  const rel = (f) => f.slice(root.length + 1)
  for (const dir of COMPONENT_DIRS) {
    for (const f of walk(join(root, dir))) {
      const raw = read(f)
      const code = stripComments(raw)
      const spawn = code.match(/import\s*\{[^}]*\b(execFileSync|spawnSync|execSync)\b[^}]*\}\s*from\s*['"](?:node:)?child_process['"]/)
      if (spawn) bad.push(`${rel(f)} imports ${spawn[1]} by name from child_process — Harper's linker cannot link it (rule 24)`)
      const s401 = code.split('\n').filter((l) => /statusCode\s*[:=]\s*401/.test(l) && !l.includes('err?.statusCode === 401'))
      if (s401.length) bad.push(`${rel(f)} assigns statusCode 401 (rule 20)`)
      if (/\bcreateBlob\s*\(/.test(code)) bad.push(`${rel(f)} calls createBlob() (rule 8)`)
      if (dir !== 'lib') {
        const wk = raw.split('\n').filter((l) => /well-known/.test(l) && !/^\s*\/\//.test(l))
        if (wk.length) bad.push(`${rel(f)} references .well-known (rule 23)`)
      }
      if (dir === 'routes' && /fastify\.head\s*\(/.test(raw)) bad.push(`${rel(f)} registers HEAD by hand (rule 21)`)
      // Rule 28, measured on a live cluster. A re-export-from makes its
      // own module request; beside an `import … from` for the same specifier that is TWO
      // requests for one module, and Harper's ESM linker left the importing module unlinked —
      // every resource answered 500 `ResourceLoadError … request for 'node:crypto' can not be
      // resolved on module lib/auth.js that is not linked`, naming an import that had been
      // there for weeks. The local-binding form (import, then a plain export list) is an exact
      // equivalent and links, so the cost of this rule is one line and the cost of breaking it
      // is every route on every node. A re-export with NO sibling import is UNMEASURED here
      // and refused anyway: the two shapes are indistinguishable to a reader, and finding out
      // which one is fatal costs a deploy.
      const imported = new Set(importSpecifiers(code))
      for (const m of code.matchAll(/export\s*(?:\{[^}]*\}|\*(?:\s+as\s+[A-Za-z_$][\w$]*)?)\s*from\s*['"]([^'"]+)['"]/g)) {
        const twice = imported.has(m[1]) ? ' — and the same specifier is imported above, which is the shape measured to break the linker' : ''
        bad.push(`${rel(f)} re-exports from '${m[1]}' (rule 28): import the names and export the local bindings instead${twice}`)
      }
    }
  }
  // Rule 5: walk relative imports from every routes/*.js file.
  const routesDir = join(root, 'routes')
  if (existsSync(routesDir)) {
    const seen = new Set()
    const walkGraph = (file, chain) => {
      if (seen.has(file)) return
      seen.add(file)
      for (const spec of importSpecifiers(read(file))) {
        if (spec === 'harperdb' || spec.startsWith('harperdb/')) { bad.push(`${[...chain, file].map(rel).join(' -> ')} imports ${spec} (rule 5)`); continue }
        if (!spec.startsWith('.')) continue
        const target = resolve(dirname(file), spec)
        for (const cand of [target, `${target}.js`, `${target}.mjs`, join(target, 'index.js')]) {
          if (existsSync(cand) && /\.(m?js)$/.test(cand)) { walkGraph(cand, [...chain, file]); break }
        }
      }
    }
    for (const f of readdirSync(routesDir).filter((f) => /\.(m?js)$/.test(f))) walkGraph(join(routesDir, f), [])
  }
  return bad
}

const { check, section, done } = checker('builtins-acceptance')

section('negative controls')
{
  const w = fixture(ROOT, COMPONENT_DIRS)
  const clean = audit(w)
  check('a faithful copy passes', clean.length === 0, clean.join(' | '))
  writeFileSync(join(w, 'lib', 'spawn.js'), "import { execFileSync } from 'node:child_process'\nexport const v = () => execFileSync('node', ['-v'])\n")
  check('a named execFileSync import is caught (rule 24)', audit(w).some((b) => b.includes('execFileSync')))
  writeFileSync(join(w, 'lib', 'spawn.js'), "import { createRequire } from 'node:module'\nconst { execFileSync } = createRequire(import.meta.url)('node:child_process')\nexport const v = () => execFileSync('node', ['-v'])\n")
  check('sync spawn through createRequire is NOT flagged', audit(w).length === 0, audit(w).join(' | '))
  writeFileSync(join(w, 'lib', 'spawn.js'), "export function f (err) { err.statusCode = 401; return err }\n")
  check('a statusCode 401 assignment is caught (rule 20)', audit(w).some((b) => b.includes('401')))
  writeFileSync(join(w, 'lib', 'spawn.js'), "export function f (err) { return err?.statusCode === 401 }\n")
  check('comparing against 401 is NOT flagged', audit(w).length === 0)
  writeFileSync(join(w, 'lib', 'spawn.js'), "export function f (t, b) { return t.createBlob(b) }\n")
  check('createBlob() is caught (rule 8)', audit(w).some((b) => b.includes('createBlob')))
  writeFileSync(join(w, 'lib', 'spawn.js'), 'export const x = 1\n')
  writeFileSync(join(w, 'routes', 'acme.js'), "export default async function (f) { f.get('/.well-known/acme-challenge/:t', async () => 'x') }\n")
  check('a /.well-known/ route is caught (rule 23)', audit(w).some((b) => b.includes('acme.js') && b.includes('well-known')))
  writeFileSync(join(w, 'routes', 'acme.js'), "export default async function (f) { f.get('/x', async () => 'x'); f.head('/x', async () => 'x') }\n")
  check('a hand-registered HEAD via f.head is not the same token (NEG: only fastify.head is greppable)', !audit(w).some((b) => b.includes('HEAD')))
  writeFileSync(join(w, 'routes', 'acme.js'), "export default async function (fastify) { fastify.get('/x', async () => 'x'); fastify.head('/x', async () => 'x') }\n")
  check('fastify.head() is caught (rule 21)', audit(w).some((b) => b.includes('HEAD by hand')))
  writeFileSync(join(w, 'routes', 'acme.js'), "import { db } from '../lib/db.js'\nexport const x = () => db\n")
  // The chain's LENGTH is not the subject, and pinning it made this control red for a change
  // that left rule 5 enforced exactly as before: `lib/auth.js` reached harperdb directly until
  // the database became a deploy-time value and now reaches it through `lib/db.js`. A
  // control anchored on what one template file happens to import today is brittle in the same way. So
  // the first two hops are pinned — the route, and the file the route itself imported, which is
  // what proves the walk followed the relative graph — and the tail is left free. `lib/db.js` is
  // the import, because it is the one core module whose whole job is reaching Harper; `lib/auth.js`
  // was, until it moved into the sign-in kit and stopped existing in a bare app.
  check('a route reaching harperdb through lib/ is caught (rule 5)', audit(w).some((b) =>
    b.startsWith('routes/acme.js -> lib/db.js') && b.includes('imports harperdb') && b.includes('(rule 5)')))
  // ── THE WALK IS TRANSITIVE, AND THE PURE MODULES A ROUTE MAY IMPORT ARE NOT CAUGHT ─────────────
  //
  // Rule 5 outlived `fastifyRoutes` for a different reason: the
  // platform imports `routes/build.js` STANDING ALONE under plain node to prove a deploy can be
  // confirmed (the platform's stamp check), and a suite imports `lib/pages.js` the same way. Both
  // reach `routes/`, and a route module reaching `harperdb` fails to load there. So a route may import
  // `lib/config.js` and `lib/copy.js`, which import only `node:fs`, and nothing that reaches Harper.
  writeFileSync(join(w, 'lib', 'zz-mid.js'), "import { db } from './db.js'\nexport const viaMid = () => db\n")
  writeFileSync(join(w, 'routes', 'acme.js'), "import { viaMid } from '../lib/zz-mid.js'\nexport const x = viaMid\n")
  check('a route reaching harperdb THROUGH another lib module is caught, so the walk is transitive and not one hop',
    audit(w).some((b) => b.startsWith('routes/acme.js -> lib/zz-mid.js') && b.includes('imports harperdb')))
  rmSync(join(w, 'lib', 'zz-mid.js'))
  writeFileSync(join(w, 'routes', 'acme.js'),
    "import { config } from '../lib/config.js'\nimport { previewPath } from '../lib/copy.js'\nexport const x = () => [config.appName(), previewPath('/')]\n")
  check('NEG: a route importing the PURE lib/config.js and lib/copy.js is NOT caught — they import only node:fs',
    !audit(w).some((b) => b.includes('acme.js')))
  writeFileSync(join(w, 'routes', 'acme.js'), 'export const x = 1\n')
  // Rule 28's five controls, two of which must NOT fire. Each synthesizes the shape rather than
  // editing a template line, so none can become a no-op in an app whose files are nothing like
  // this one.
  const EXPORT_FROM = 'export' + ' { a }' + " from './y.js'" + '\n'
  writeFileSync(join(w, 'lib', 'spawn.js'), EXPORT_FROM)
  check('a bare re-export-from is caught (rule 28)', audit(w).some((b) => b.includes("re-exports from './y.js'")))
  writeFileSync(join(w, 'lib', 'spawn.js'), "import { a } from './y.js'\n" + EXPORT_FROM + 'export const b = a\n')
  check('…and the two-requests-for-one-specifier shape says so by name (NEG)', audit(w).some((b) => b.includes('measured to break the linker')))
  writeFileSync(join(w, 'lib', 'spawn.js'), 'export' + ' * from' + " './y.js'" + '\n')
  check('a star re-export is caught too (rule 28)', audit(w).some((b) => b.includes("re-exports from './y.js'")))
  writeFileSync(join(w, 'lib', 'spawn.js'), "import { a } from './y.js'\n" + 'export' + ' { a }' + '\n')
  check('importing and exporting the LOCAL binding is NOT flagged — it is the remedy', !audit(w).some((b) => b.includes('rule 28')), audit(w).join(' | '))
  writeFileSync(join(w, 'lib', 'spawn.js'), '// ' + EXPORT_FROM)
  check('a re-export-from inside a COMMENT is not flagged (the audit reads stripped code)', !audit(w).some((b) => b.includes('rule 28')))
  // …and the stripper has to still be reading comments as comments AFTER a regex literal that
  // contains a quote. Before the fix `/['"]/` opened a "string" nothing on that line
  // closed, so this very shape reported rule 28 about a line that is commented out. Same defect
  // as the `deps` case in deps-acceptance, different rule, so it is pinned on both sides.
  writeFileSync(join(w, 'lib', 'spawn.js'), "const QUOTED = /['\"]/\nexport const strip = (s) => s.replace(QUOTED, '')\n// " + EXPORT_FROM)
  check('…and a regex literal containing a quote does not resurrect that comment', !audit(w).some((b) => b.includes('rule 28')), audit(w).join(' | '))
  writeFileSync(join(w, 'lib', 'spawn.js'), "const QUOTED = /['\"]/\n" + EXPORT_FROM + 'export const strip = (s) => s.replace(QUOTED, \'\')\n')
  check('…CONTROL: the same file with that re-export LIVE still reds, so the pass above is not the rule going quiet', audit(w).some((b) => b.includes("re-exports from './y.js'")), audit(w).join(' | '))
  writeFileSync(join(w, 'lib', 'spawn.js'), 'export const x = 1\n')
  discard(w)
}

section('this repository')
const bad = audit(ROOT)
for (const b of bad) check(b, false)
check('resources/, lib/ and routes/ respect rules 5, 8, 20, 21, 23, 24, 28', bad.length === 0)
process.exit(done())
