// GENERATED — a signed-in customer's own past orders (rule 19; the owner field is
// Order.customerUserId, String @indexed in schema.graphql). This is the app's ONE owner-scoped
// resource: MenuApi, StoreInfoApi, MenuPhotoApi and OrderConfirmationApi are public, CheckoutApi
// stamps the owner at write time but never reads it back, and OrderAdminApi is the admin's own
// view across every customer.
//
//   GET /CustomerOrderApi    the caller's own orders, newest first by placedAt
//                            → { orders: [...], limit, truncated }
//
// NO ?owner= AND NO SUB-PATH, NOT EVEN FOR AN ADMIN. The owner's view across every customer is
// OrderAdminApi, a different resource with a different (admin) shape; a second cross-owner
// reader here would put rule 19 in two places. An admin calling THIS resource gets their own
// customer orders, exactly like anybody else — there is no isAdmin branch anywhere below.
//
// A GUEST ORDER BELONGS TO NOBODY'S ACCOUNT. customerUserId is null on a guest order (or the
// attribute is absent entirely on an older row), and the search below is an EQUALITY condition
// on caller.userId — never null, never blank, because loadCaller() throws rather than hand back
// an identity-less caller. list() still refuses explicitly rather than trust that invariant:
// running the search with a null/blank value would match exactly the guest rows this resource
// must never surface. A guest order is reached only by its own code, through
// OrderConfirmationApi.
//
// THIS RESOURCE WRITES NOTHING, EVER. A customer cannot edit or cancel a placed order — every
// non-GET answers 404, behind the SAME auth check GET uses, so an anonymous caller still gets
// 403 auth_required rather than a 404 that would leak "this route exists" to a stranger.
//
// scripts/CustomerOrderApi-probe.js proves A never sees B's orders or a guest order (null or
// absent customerUserId) by list or by guessing a sub-path, that ?owner= and a request body are
// both ignored, that an admin calling this sees only their own orders, and that anonymous, a
// deactivated row and a session whose row was reassigned all get 403 with no WWW-Authenticate.

import { Resource } from 'harperdb'
import { db } from '../lib/db.js'
import { loadCaller } from '../lib/session.js'
import { json, segmentsOf } from '../lib/http.js'
import { runAuthed } from '../lib/sign-in-support.js'
import { publicOrderView } from '../lib/orders.js'

// A customer with more orders than this sees only the newest LIST_LIMIT, and the response says so.
export const LIST_LIMIT = 200

export class CustomerOrderApi extends Resource {
  static loadAsInstance = false

  async get (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      const caller = await loadCaller(this)
      const [sub] = segmentsOf(target)
      // Nothing is served by id here (see the header); any sub-path is simply not a route.
      if (sub) return json({ error: 'not found' }, 404)
      return this.list(caller)
    })
  }

  async post (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      await loadCaller(this)
      return json({ error: 'not found' }, 404)
    })
  }

  async put (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      await loadCaller(this)
      return json({ error: 'not found' }, 404)
    })
  }

  async patch (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      await loadCaller(this)
      return json({ error: 'not found' }, 404)
    })
  }

  async delete (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      await loadCaller(this)
      return json({ error: 'not found' }, 404)
    })
  }

  async list (caller) {
    // Refuse outright rather than trust the invariant: an equality condition run with a
    // null/undefined/blank value would match a guest order's customerUserId (null, or the
    // key absent) exactly as it would match a real owner. loadCaller() never hands back a
    // caller with no userId, but the guard costs nothing and this is the one place in the
    // app where getting it wrong is the worst bug this codebase can have (rule 19).
    if (!caller || typeof caller.userId !== 'string' || !caller.userId) {
      globalThis.logger?.warn('[CustomerOrderApi] loadCaller returned no usable userId; refusing to list rather than risk matching a guest order')
      return json({ orders: [], limit: LIST_LIMIT, truncated: false })
    }
    const conditions = [{ attribute: 'customerUserId', value: caller.userId }]
    const rows = []
    for await (const row of db.Order.search({ conditions, limit: LIST_LIMIT })) rows.push(row)
    rows.sort((a, b) => String(b.placedAt ?? '').localeCompare(String(a.placedAt ?? '')))
    const orders = rows.map(publicOrderView)
    return json({ orders, limit: LIST_LIMIT, truncated: orders.length >= LIST_LIMIT })
  }
}
