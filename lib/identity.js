// SIGN-IN KIT — the identity derivations, with NO `harperdb` import, so code that runs outside a
// Harper worker can compute them.
//
// WHY THIS FILE EXISTS, and it is the whole reason: a `User` row's id and a
// `MagicLink` row's id are DERIVED, not random — the id IS the claim on the address, and the
// token's hash IS the key (rule 10). Anything that seeds an account or a sign-in link from
// outside the app has to agree with those two derivations exactly. `lib/auth.js` reaches
// `harperdb` at module scope — through `lib/db.js` since the database became a deploy-time
// value, and directly before that — so nothing outside a worker can import it, and a
// seeder was left to re-derive both from reading the source — a copy of a thing that is not
// the thing, which is §5's shape and has cost this project twelve defects. So the pure half
// lives here, `lib/auth.js` re-exports every name below for the resources, and
// `scripts/mint-signin-link.js` imports this file directly. ONE implementation, two callers.
//
// Everything here is pure: no I/O, no clock of its own (`now` is a parameter), no table
// access. Keep it that way — the moment this file touches `harperdb` the seeder breaks and
// the duplication comes back.

import crypto from 'node:crypto'

export const ROLE_ADMIN = 'admin'
export const ROLE_MEMBER = 'member'
// Must agree with `MagicLink @table(expiration: 900)` in schema.graphql; the table is what
// enforces it, this is what the email copy says.
export const MAGIC_LINK_TTL_SECONDS = 900

export function normalizeEmail (value) {
  const s = String(value ?? '').trim().toLowerCase()
  return s && s.includes('@') ? s : null
}

/**
 * The User id for an address: a hash of the normalized email, so the id IS the claim on the
 * address. An email lookup is a search, not a key, and "search, then put a random-id row" is
 * check-then-act: two sign-ups for one address that interleave both find nothing and both
 * write, and from then on findUserByEmail() answers whichever row the search hits first.
 * With the id derived from the address the two writes land on ONE key (a deterministic-key
 * put), and claimUserForEmail() in lib/auth.js turns the race into a 409 the loser re-reads from.
 * Not PII: a 32-hex prefix of a SHA-256, and user ids are not secrets (sessions are signed).
 * An address that does not normalize gets a random id, so nothing collides on "invalid".
 */
export function userIdFor (email) {
  const norm = normalizeEmail(email)
  if (!norm) return crypto.randomUUID()
  return 'u_' + crypto.createHash('sha256').update(norm).digest('hex').slice(0, 32)
}

/** A fresh User row keyed by its address (userIdFor). The caller decides the role; only Bootstrap ever passes 'admin'. */
export function newUser ({ email, name = null, role = ROLE_MEMBER, googleSub = null, passwordHash = null, now = new Date() }) {
  const at = now.toISOString()
  return {
    id: userIdFor(email),
    email: normalizeEmail(email),
    name: name ? String(name).trim() : null,
    role,
    passwordHash,
    googleSub,
    magicLinkSendTimestamps: [],
    passwordAttemptTimestamps: [],
    deactivatedAt: null,
    lastLoginAt: null,
    createdAt: at,
    updatedAt: at,
  }
}

/** SHA-256 hex of a token: what the MagicLink row is keyed by (rule 10 — never PII). */
export function hashToken (token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

export function generateToken () {
  const token = crypto.randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token) }
}

/** Harper's ClientError for a duplicate key carries statusCode 409 and the message; the stub mirrors both. */
export function isAlreadyExists (err) {
  return err?.statusCode === 409 || err?.status === 409 || /already exists/i.test(String(err?.message ?? ''))
}
