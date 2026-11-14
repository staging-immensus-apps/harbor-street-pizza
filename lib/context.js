// THE CALLER WHO MAY NOT BE THERE.
//
// `loadCaller()` (lib/session.js) is the right thing for every resource that requires a session: it
// throws the 403 `Response` when there is none. This app has one resource that must work BOTH ways —
// `CheckoutApi`, where guest checkout is the product (CLAUDE.md §1) and a signed-in customer's order
// is stamped with their id so it reaches their account. A `try`/`catch` around `loadCaller()` would
// do it, and would also swallow a real refusal, so the optional case is written once here instead.
//
// IT APPLIES EVERY CHECK `loadCaller()` APPLIES and simply answers `null` where that one throws: the
// row is re-read (so a deactivated customer is nobody), and `sessionMatchesRow()` is the same verdict
// `requireAdmin` and `loadCaller` use, so a validly signed cookie naming a row that is now somebody
// else's is nobody here either. Anything less would make "signed in" mean something weaker on the one
// route that writes an owner field.

import { getSessionUser, findUserById, sessionMatchesRow, ROLE_ADMIN, ROLE_MEMBER } from './auth.js'

/**
 * The caller, or `null` when this request carries no usable session. Never throws, so a guest is a
 * `null` rather than an error path.
 */
export async function optionalCaller (resource) {
  let session = null
  try {
    session = getSessionUser(resource)
  } catch {
    return null
  }
  if (!session) return null
  const row = await findUserById(session.userId)
  if (!row || row.deactivatedAt || !sessionMatchesRow(session, row)) return null
  const role = row.role ?? ROLE_MEMBER
  return { userId: row.id, email: row.email, name: row.name ?? null, role, isAdmin: role === ROLE_ADMIN, row }
}
