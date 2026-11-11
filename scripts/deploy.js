#!/usr/bin/env node
// FIXED — the build-before-deploy guard, then `harper deploy` (rule 15).
//
//   npm run deploy               guard, then deploy
//   npm run deploy -- --dry-run  guard, print the command, exit 0 without deploying
//
// Two refusals, each a shipped incident:
//   1. web/ is BUILT and gitignored. A deploy without `vite build` ships no frontend, and a
//      deploy with a STALE build ships yesterday's frontend over today's API. Refused when
//      web/index.html is missing or older than the newest file under src/ (or index.html,
//      vite.config.ts, public/).
//   2. `harper deploy` against localhost strips devDependencies in place, after which
//      vite.config.ts fails to import. Refused when CLI_TARGET is unset or
//      resolves to a loopback address.
//
// Credentials come from .env (CLI_TARGET, CLI_TARGET_USERNAME, CLI_TARGET_PASSWORD) the way
// the Harper CLI reads them; this script loads .env into the child's environment without
// a dotenv dependency and never prints a value.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

export const SOURCE_DIRS = ['src', 'public']
export const SOURCE_FILES = ['index.html', 'vite.config.ts', 'tailwind.config.js', 'postcss.config.js']
export const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?)$/i

/** Newest mtime (ms) under a set of paths, or null when none exist. */
export function newestMtime (root, dirs = SOURCE_DIRS, files = SOURCE_FILES) {
  let newest = null
  const consider = (p) => {
    try {
      const st = statSync(p)
      if (st.isDirectory()) { for (const f of readdirSync(p)) consider(join(p, f)); return }
      if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs
    } catch { /* absent is fine */ }
  }
  for (const d of dirs) consider(join(root, d))
  for (const f of files) consider(join(root, f))
  return newest
}

/**
 * PURE verdict on the build: `{ ok, reason }`. `indexMtime` null = missing.
 */
export function judgeBuild ({ indexMtime, newestSource }) {
  if (indexMtime == null) return { ok: false, reason: 'web/index.html is missing — run `npm run build` first' }
  if (newestSource != null && newestSource > indexMtime) return { ok: false, reason: 'web/index.html is older than the newest source file — run `npm run build` again' }
  return { ok: true, reason: 'web/index.html is present and newer than every source file' }
}

/** PURE verdict on the target: `{ ok, reason }`. */
export function judgeTarget (cliTarget) {
  const raw = String(cliTarget ?? '').trim()
  if (!raw) return { ok: false, reason: 'CLI_TARGET is not set — a deploy with no explicit target lands on the local instance (rule 15)' }
  let host
  try { host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname } catch { return { ok: false, reason: `CLI_TARGET "${raw}" is not a URL` } }
  if (LOOPBACK.test(host)) return { ok: false, reason: `CLI_TARGET resolves to ${host} — never deploy against localhost; it strips devDependencies in place (rule 15)` }
  return { ok: true, reason: `target ${host}` }
}

/** Minimal .env reader: KEY=value lines, optional `export`, quotes stripped, no expansion. */
export function parseEnvFile (text) {
  const out = {}
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m || line.trim().startsWith('#')) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

export function loadEnv (root, base = process.env) {
  const file = join(root, '.env')
  if (!existsSync(file)) return { ...base }
  const fromFile = parseEnvFile(readFileSync(file, 'utf8'))
  // A NON-BLANK process environment wins: a CI job that exports CLI_TARGET must not be
  // overridden by a stale .env left in the checkout. Blank is absent (lib/config.js's rule),
  // so an empty exported variable does not erase the file's value either.
  const out = { ...fromFile }
  for (const [k, v] of Object.entries(base)) if (v !== '' || !(k in out)) out[k] = v
  return out
}

// THE one spelling of the binary. A `harperdb` on PATH is a Harper 4.x install: the 5.x
// package is `harper` and declares `harper` alone (`harper@5.3.1`'s `bin`, measured
// 2026-10-14), so spawning the old name after a correct install is ENOENT at the step that
// matters. It is a constant rather than a literal at two call sites because the printed
// command and the spawned process must never be able to disagree.
export const CLI_BIN = 'harper'
// The package that PROVIDES it, which is a separate fact that happens to share the name: the
// 4.x package `harperdb` also provided a `harper` binary. Named here only so the refusal above
// can tell somebody what to install, and deliberately WITHOUT a version range — the range lives
// in one place (`deploy-shared.yml`'s install step, and `engines`), and a second copy of it here
// would be a record nothing compares, which is the defect this whole change is about.
export const CLI_PACKAGE = 'harper'
// The field names survive the rename, read from `harper@5.3.1` rather than assumed:
// `deploy` is aliased to the `deploy_component` operation (`bin/cliOperations.js` OP_ALIASES),
// `restart` takes a boolean or the string 'rolling' (its Joi schema in
// `components/operationsValidation.js`), and `replicated=true` is in the invocation Harper's
// own CLI prints for a configured deploy (`bin/deploySetup.js`). `.` is the one argument that
// does NOT survive: the parser sets `operation` from the first bare word and drops every later
// one, so the project is `process.cwd()` and the `.` is inert here. It is kept because it is
// the form Harper's own CLI tells you to use, and because `harper run .` and `harper dev .`
// DO read it (`bin/harper.js` reads `process.argv[3]` for those two) — one spelling across
// all three beats an argument that is present in two of them.
export const DEPLOY_ARGS = ['deploy', '.', 'restart=rolling', 'replicated=true']

function main () {
  const root = process.cwd()
  const dryRun = process.argv.includes('--dry-run')
  const env = loadEnv(root)

  const indexPath = join(root, 'web', 'index.html')
  const build = judgeBuild({
    indexMtime: existsSync(indexPath) ? statSync(indexPath).mtimeMs : null,
    newestSource: newestMtime(root),
  })
  console.log(`${build.ok ? '✅' : '❌'} build: ${build.reason}`)
  const target = judgeTarget(env.CLI_TARGET)
  console.log(`${target.ok ? '✅' : '❌'} target: ${target.reason}`)
  if (!build.ok || !target.ok) return 1

  console.log(`→ ${CLI_BIN} ${DEPLOY_ARGS.join(' ')}`)
  if (dryRun) { console.log('(dry run — not deploying)'); return 0 }
  const r = spawnSync(CLI_BIN, DEPLOY_ARGS, { cwd: root, stdio: 'inherit', env })
  if (r.error) { console.error(`❌ could not run ${CLI_BIN}: ${r.error.message} — install it with \`npm i -g ${CLI_PACKAGE}\``); return 1 }
  return r.status ?? 1
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname) {
  process.exit(main())
}
