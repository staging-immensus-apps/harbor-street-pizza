#!/usr/bin/env node
// The part of this app's seed that a YAML file cannot do. The ROWS are Harper's job — `data/*.yaml`
// is loaded by the dataLoader into the preview copy, one file per table (rule 31) — and three things
// are deliberately not in those files:
//
//   · ACCOUNTS. A `User` row is derived from its address (`userIdFor`) and must never be loaded into
//     a published app, so the three the seed plan names are created here, against a running database.
//   · PHOTO BYTES. A `Blob` seeded from YAML would store the TEXT of the file, so an item's photo
//     would be a few bytes of YAML served as an image. The two demo photos are generated as real
//     PNGs below and written through the same lib/photos.js the upload route uses.
//   · THE LINK FROM TWO SEEDED ORDERS TO THE SEEDED CUSTOMER. That id is a hash of an address
//     (lib/identity.js), and a hand-copied hash in a YAML file is a copy of a derivation: it would
//     keep looking right and stop matching the day the derivation moved.
//
//   node scripts/seed.js --dry-run     say what would be written, touch nothing, import no runtime
//   node scripts/seed.js               write what is missing
//
// IDEMPOTENT, in the strong sense: every step asks what is there before it writes, and a second run
// changes nothing. An account that exists is `kept` and keeps the role, name and login timestamp the
// live app has since written. A photo is rewritten only when its bytes are missing or do not verify.
// An order is linked only when it carries no `customerUserId` AT ALL — a `null` that the app itself
// wrote, when a customer deleted their account, is a decision this script must not undo.
//
// `--dry-run` imports NOTHING from lib/, which is the point of it: it runs under plain node outside a
// Harper worker, where `harperdb` does not resolve, so the seed plan can be read in CI and in the
// build's own checks without a database anywhere.

import { readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The accounts the seed plan asks for: the shop owner, and two customers so that "one customer
 * cannot see another's orders" is a thing QA can actually do.
 *
 * THE OWNER HAS NO PASSWORD and never gets one here. The owner signs in with an emailed link
 * (`npm run mint-signin-link`), and that is also what makes them this app's administrator
 * (lib/auth.js `ownerTakesSeat`) — a seeded administrator credential would be a credential in the
 * repository with admin behind it.
 *
 * THE TWO CUSTOMERS DO have one, because a customer password is now an ordinary part of the product
 * and a preview with no way to sign in as a customer cannot show the past-orders page at all. It is
 * demo data for the preview copy: this script is never run against the published app, the value is
 * overridable with `SEED_CUSTOMER_PASSWORD`, and it grants nothing beyond those two example.com
 * accounts' own orders.
 */
export const SEED_ACCOUNTS = [
  { email: 'owner@example.com', name: 'Shop owner', role: 'admin', password: null },
  { email: 'customer1@example.com', name: 'Casey Customer', role: 'member', password: customerPassword() },
  { email: 'customer2@example.com', name: 'Robin Diner', role: 'member', password: customerPassword() },
]

/** The orders `data/Order.yaml` loads that belong to the first seeded customer's account. */
export const SEED_CUSTOMER_ORDERS = { email: 'customer1@example.com', orderIds: ['order-0001', 'order-0006'] }

/**
 * The demo photos, under the ids of the two `MenuItem` rows `data/MenuItem.yaml` stamps with
 * `photoUpdatedAt`. Solid colours rather than pictures: what has to be true in a preview is that the
 * public menu draws an image from the photo route, and a real JPEG of a pizza would make this file a
 * binary blob in a repository to prove the same thing.
 */
export const SEED_PHOTOS = [
  { menuItemId: 'menu-margherita', rgb: [214, 91, 71] },
  { menuItemId: 'menu-pepperoni', rgb: [168, 62, 52] },
]

const PHOTO_SIZE = 48

function customerPassword () {
  return process.env.SEED_CUSTOMER_PASSWORD || 'pizza-preview-demo'
}

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

// ── a real PNG, made here ─────────────────────────────────────────────────────────────────────────
//
// Eight-bit RGB, no interlacing, one filter byte of 0 per row: the simplest encoding the format has,
// written out rather than taken from a dependency, because a seed script is not worth a runtime
// package and a base64 literal of an image nobody can read is worse than forty lines that say what
// the bytes are.

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32 (buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk (type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length)
  return out
}

/** A `size` × `size` PNG of one colour. */
export function solidPng (size, [r, g, b]) {
  const stride = 1 + size * 3
  const raw = Buffer.alloc(size * stride)
  for (let y = 0; y < size; y++) {
    const row = y * stride
    raw[row] = 0
    for (let x = 0; x < size; x++) {
      raw[row + 1 + x * 3] = r
      raw[row + 2 + x * 3] = g
      raw[row + 3 + x * 3] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

async function main () {
  const dryRun = process.argv.includes('--dry-run')

  console.log(`seed: ${SEED_ACCOUNTS.length} account(s), ${SEED_PHOTOS.length} photo(s), ${SEED_CUSTOMER_ORDERS.orderIds.length} order link(s); ${dataFiles().length} data file(s) loaded by Harper itself:`)
  for (const f of dataFiles()) console.log(`  - ${f}`)

  if (dryRun) {
    for (const a of SEED_ACCOUNTS) console.log(`  would ensure ${a.role} ${a.email}${a.password ? ' (with a password)' : ''}`)
    for (const p of SEED_PHOTOS) console.log(`  would ensure a ${PHOTO_SIZE}x${PHOTO_SIZE} PNG for ${p.menuItemId}`)
    for (const id of SEED_CUSTOMER_ORDERS.orderIds) console.log(`  would link order ${id} to ${SEED_CUSTOMER_ORDERS.email} if it carries no customer`)
    console.log('seed: --dry-run, nothing written')
    return 0
  }

  // Imported here and not at the top: these reach `harperdb` through lib/db.js, which resolves
  // inside a Harper worker and nowhere else.
  const { db } = await import('../lib/db.js')
  const { newUser, userIdFor } = await import('../lib/identity.js')
  const { hashPassword } = await import('../lib/auth.js')
  const { photoRecord, verifyStoredPhoto } = await import('../lib/photos.js')
  const { withoutManaged } = await import('../lib/managed-fields.js')

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
    const row = newUser(account)
    if (account.password) row.passwordHash = hashPassword(account.password)
    await db.User.put({ ...row, createdAt: new Date().toISOString() })
    created++
    console.log(`  created ${account.email} (${account.role})`)
  }
  console.log(`seed: ${created} account(s) created, ${kept} already there`)

  // Photos. Written only for an item that is actually there: the dataLoader owns MenuItem, and a
  // photo under an id with no item would be bytes nothing can ever serve or delete.
  for (const photo of SEED_PHOTOS) {
    const item = await db.MenuItem.get(photo.menuItemId)
    if (!item) {
      console.log(`  skipped photo for ${photo.menuItemId} — no such menu item`)
      continue
    }
    const buffer = solidPng(PHOTO_SIZE, photo.rgb)
    const stored = await db.MenuItemPhoto.get(photo.menuItemId)
    if (stored && await verifyStoredPhoto(stored, { byteSize: buffer.length })) {
      console.log(`  kept    photo for ${photo.menuItemId}`)
      continue
    }
    const record = photoRecord(photo.menuItemId, { buffer, contentType: 'image/png' })
    await db.MenuItemPhoto.put(record)
    // Verify on write (rule 8): bytes that did not survive the round trip are deleted rather than
    // left behind a `photoUpdatedAt` that promises a customer an image.
    if (!await verifyStoredPhoto(await db.MenuItemPhoto.get(photo.menuItemId), record)) {
      await db.MenuItemPhoto.delete(photo.menuItemId)
      console.log(`  FAILED  photo for ${photo.menuItemId} did not read back; the row was deleted`)
      continue
    }
    console.log(`  wrote   photo for ${photo.menuItemId} (${record.byteSize} bytes)`)
  }

  // The two seeded orders that belong to the seeded customer's account.
  const customerId = userIdFor(SEED_CUSTOMER_ORDERS.email)
  for (const orderId of SEED_CUSTOMER_ORDERS.orderIds) {
    const order = await db.Order.get(orderId)
    if (!order) {
      console.log(`  skipped order link ${orderId} — no such order`)
      continue
    }
    if ('customerUserId' in order) {
      console.log(`  kept    order ${orderId} as it is (customer already decided)`)
      continue
    }
    // withoutManaged: this restates a stored row and `Order.updatedAt` is Harper's (CLAUDE.md §8).
    await db.Order.put({ ...withoutManaged(order, 'Order'), customerUserId: customerId })
    console.log(`  linked  order ${orderId} to ${SEED_CUSTOMER_ORDERS.email}`)
  }
  return 0
}

main().then((code) => { process.exitCode = code }, (err) => {
  console.error('seed failed:', err?.stack ?? err)
  process.exitCode = 1
})
