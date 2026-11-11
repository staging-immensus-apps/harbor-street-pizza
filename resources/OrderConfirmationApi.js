// Public confirmation — the order's own 32-character random `code` IS the customer's capability
// (lib/orders.js header). There are no customer accounts, so there is nothing to scope by owner
// and nothing to list: the only question this resource answers is "what does this exact code
// unlock", and every other shape of request — no code, a second segment, any other verb — gets the
// SAME 404 a wrong code gets, so existence is never distinguishable from a malformed request.
//
//   GET /OrderConfirmationApi/:code   → 200 { order: publicOrderView(row) }, or 404
//
// No auth, no session read, no owner field — this is the one resource in the app that is reached by
// knowing a secret instead of by being someone. Nothing here ever writes.

import { Resource } from 'harperdb'
import { db } from '../lib/db.js'
import { json, segmentsOf, runAuthed } from '../lib/http.js'
import { publicOrderView } from '../lib/orders.js'

const NOT_FOUND = { error: 'not found' }
// Comfortably above the 32-character codes this app issues; a code this long can never match a
// row, and refusing it before the search means a search is never run against a vast input.
const CODE_MAX = 200

export class OrderConfirmationApi extends Resource {
  static loadAsInstance = false

  async get (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      const [code, sub] = segmentsOf(target)
      // No code at all is 404, never a list: there is no reading of this resource that returns
      // more than one order, whatever the request shape asks for.
      if (!code || sub) return json(NOT_FOUND, 404)
      if (code.length > CODE_MAX) return json(NOT_FOUND, 404)
      const row = await findByCode(code)
      if (!row) return json(NOT_FOUND, 404)
      return json({ order: publicOrderView(row) })
    })
  }

  // Every other verb is refused the same way and writes nothing. This path has no PATCH/PUT/DELETE
  // of its own — OrderAdminApi and CheckoutApi own every write to an Order row.
  async post (target) {
    target.checkPermission = false
    return json(NOT_FOUND, 404)
  }

  async put (target) {
    target.checkPermission = false
    return json(NOT_FOUND, 404)
  }

  async patch (target) {
    target.checkPermission = false
    return json(NOT_FOUND, 404)
  }

  async delete (target) {
    target.checkPermission = false
    return json(NOT_FOUND, 404)
  }
}

/** The one indexed equality this resource ever searches on. */
async function findByCode (code) {
  for await (const row of db.Order.search({ conditions: [{ attribute: 'code', value: code }], limit: 1 })) return row
  return null
}
