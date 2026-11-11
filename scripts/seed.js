#!/usr/bin/env node
// The accounts half of this app's seed. The ROWS are Harper's job — `data/*.yaml` is loaded by the
// dataLoader into the preview copy, one file per table (rule 31) — and accounts are deliberately not
// in those files: a `User` row is derived from its address (`userIdFor`) and must never be loaded
// into a published app, so it is created here, by hand, against a database that is already running.
//
//   node scripts/seed.js --dry-run     say what would be written, touch nothing, import no runtime
//   node scripts/seed.js               create the accounts that are missing
//
// IDEMPOTENT. Every account is keyed by `userIdFor(email)`, so a second run finds the row and leaves
// it exactly as it is — it never resets a role, a name or a login timestamp that the live app has
// since written. An account that exists is reported as `kept`, not as `created`.
//
// `--dry-run` imports NOTHING from lib/, which is the point of it: it runs under plain node outside
// a Harper worker, where `harperdb` does not resolve, so the seed plan can be read in CI and in the
// build's own checks without a database anywhere.

import { readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The accounts the seed plan asks for. The owner is an ADMIN because this app's only signed-in
 * person is the shop owner; the two members exist so an app with sign-in has a non-admin to prove
 * an admin-only resource against.
 *
 * No passwords and no magic links are minted here: sign-in is by emailed link
 * (`npm run mint-signin-link` is the template's path to one), and a seeded credential would be a
 * credential in the repository.
 */
export const SEED_ACCOUNTS = [
  { email: 'owner@example.com', name: 'Shop owner', role: 'admin' },
  { email: 'member-one@example.com', name: 'Member One', role: 'member' },
  { email: 'member-two@example.com', name: 'Member Two', role: 'member' },
]

/** The table files the dataLoader will load, for the report — never read or parsed here. */
function dataFiles () {
  const out = []
  for (const dir of ['data', join('data', 'production')]) {
    const full = join(ROOT, dir)
    if (!existsSync(full)) continue
    for (const f of readdirSync(full)) if (f.endsWith('.yaml')) out.push(join(dir, f))
  }
  return out.sort()
}

async function main () {
  const dryRun = process.argv.includes('--dry-run')

  console.log(`seed: ${SEED_ACCOUNTS.length} account(s); ${dataFiles().length} data file(s) loaded by Harper itself:`)
  for (const f of dataFiles()) console.log(`  - ${f}`)

  if (dryRun) {
    for (const a of SEED_ACCOUNTS) console.log(`  would ensure ${a.role} ${a.email}`)
    console.log('seed: --dry-run, nothing written')
    return 0
  }

  // Imported here and not at the top: these reach `harperdb` through lib/db.js, which resolves
  // inside a Harper worker and nowhere else.
  const { db } = await import('../lib/db.js')
  const { newUser, userIdFor } = await import('../lib/identity.js')

  let created = 0
  let kept = 0
  for (const account of SEED_ACCOUNTS) {
    const id = userIdFor(account.email)
    const existing = await db.User.get(id)
    if (existing) {
      kept++
      console.log(`  kept    ${account.email} (${existing.role ?? 'member'})`)
      continue
    }
    await db.User.put({ ...newUser(account), createdAt: new Date().toISOString() })
    created++
    console.log(`  created ${account.email} (${account.role})`)
  }
  console.log(`seed: ${created} created, ${kept} already there`)
  return 0
}

main().then((code) => { process.exitCode = code }, (err) => {
  console.error('seed failed:', err?.stack ?? err)
  process.exitCode = 1
})
