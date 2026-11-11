// SIGN-IN KIT (the baseline a generated app adapts) — the per-request caller context every generated resource opens with.
// requireAuth() verifies the cookie; this re-reads the
// row so a deactivated user with an unexpired cookie, or a role changed since sign-in, takes
// effect on the next request rather than at cookie expiry — the same reason requireAdmin in
// lib/auth.js re-reads. One keyed get per request.

import { requireAuth, findUserById, authFailResponse, sessionMatchesRow, ROLE_ADMIN, ROLE_MEMBER } from './auth.js'

/**
 * The identity half is sessionMatchesRow() in lib/auth.js — the SAME function requireAdmin
 * calls, not a second copy. A token stays valid while the row underneath it is
 * reassigned, and `first-admin` is the one User row whose id is not derived from its email, so
 * it is the one row a stranger's session can survive on. Without this check that session reads
 * as `isAdmin: true` here, and canSee() lets an admin across owners — so it reached every owner-scoped
 * resource. The refusal is the same generic one a deactivated row gets, by
 * design (rule 25). No extra read: the row is already in hand.
 */
export async function loadCaller (resource) {
  const session = requireAuth(resource)
  const row = await findUserById(session.userId)
  if (!row || row.deactivatedAt || !sessionMatchesRow(session, row)) throw authFailResponse('Authentication required')
  const role = row.role ?? ROLE_MEMBER
  return { userId: row.id, email: row.email, name: row.name ?? null, role, isAdmin: role === ROLE_ADMIN, row }
}

/**
 * Rule 19's read side in one expression: a row is visible to its owner and to an admin, and
 * to nobody else. A missing row is not visible, so a caller can pass a `get()` result
 * straight in. Every owner-scoped resource decides reads AND writes with this.
 */
export function canSee (caller, row, ownerField = 'ownerUserId') {
  return Boolean(row) && Boolean(caller) && (caller.isAdmin === true || row[ownerField] === caller.userId)
}
