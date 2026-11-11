// The owner's live order queue. Class name OrderAdminApi, table Order (rule 2). This is the
// ONLY resource in the app that serves customer names, phone numbers and delivery addresses
// (CLAUDE.md §9), so every entry point — including the live stream — opens with requireAdmin().
//
//   GET   /OrderAdminApi?queue=active|done|pending_payment   the named queue, newest first, with counts
//   GET   /OrderAdminApi/:id                                  one order in full, or 404
//   PUT   /OrderAdminApi/:id   { status }                     advance the status; the queue is derived
//                                                              from it so the two can never disagree.
//                                                              PUT is the route the front end calls: on
//                                                              a real cluster (measured 2026-11-11)
//                                                              Harper's REST layer answered PATCH with a
//                                                              400 before this resource's patch() ever
//                                                              ran — PATCH is not a verb any seeded or
//                                                              reviewed resource in this platform uses,
//                                                              while PUT is the proven update verb
//                                                              (MembersApi, StoreSettingsApi, AdminApi,
//                                                              AccountApi). PATCH is kept as an alias
//                                                              for anything that does reach it.
//   connect (SSE)                                             live Order arrivals/changes, admin-only
//
// No POST, no DELETE: an order is created by CheckoutApi and never removed.

import { Resource } from 'harperdb'
import { db } from '../lib/db.js'
import { requireAdmin } from '../lib/auth.js'
import { json, segmentsOf, queryParams, runAuthed } from '../lib/http.js'
import { adminOrderView, queueForStatus, QUEUES, QUEUE_ACTIVE, OWNER_SETTABLE_STATUSES } from '../lib/orders.js'

export class OrderAdminApi extends Resource {
  static loadAsInstance = false

  async get (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      const [id, sub] = segmentsOf(target)
      if (!id) return this.list(queryParams(target, this))
      if (sub) return json({ error: 'not found' }, 404)
      const row = await db.Order.get(id)
      if (!row) return json({ error: 'not found' }, 404)
      return json({ order: adminOrderView(row) })
    })
  }

  async put (target, data) {
    target.checkPermission = false
    return applyStatus(this, target, data)
  }

  async patch (target, data) {
    target.checkPermission = false
    return applyStatus(this, target, data)
  }

  /**
   * The live queue stream. `connect`/`subscribe` runs the same authorization entry as a REST
   * request (CLAUDE.md §9), so the admin check is written here too, FIRST and unconditionally —
   * an SSE stream that skipped it would publish every customer's phone number to anyone who
   * asked for `Accept: text/event-stream`. requireAdmin() throws its 403 Response before
   * `db.Order.subscribe` is ever reached.
   */
  async connect (incoming) {
    await requireAdmin(this)
    return db.Order.subscribe({ omitCurrent: true })
  }

  async list (params) {
    const requested = params.get('queue')
    const queue = QUEUES.includes(requested) ? requested : QUEUE_ACTIVE
    const rows = []
    for await (const row of db.Order.search({ conditions: [{ attribute: 'queue', value: queue }], limit: 200 })) rows.push(row)
    rows.sort((a, b) => String(b.placedAt ?? '').localeCompare(String(a.placedAt ?? '')))
    const counts = {}
    for (const q of QUEUES) {
      let n = 0
      // eslint-disable-next-line no-unused-vars
      for await (const _row of db.Order.search({ conditions: [{ attribute: 'queue', value: q }], limit: 200 })) n++
      counts[q] = n
    }
    return json({ orders: rows.map(adminOrderView), queue, counts })
  }
}

/**
 * Advance an order's status, shared by put() and patch() (see the header comment for why PUT is
 * the route the front end uses). `self` is the resource instance, for requireAdmin().
 */
async function applyStatus (self, target, data) {
  return runAuthed(async () => {
    await requireAdmin(self)
    const [id, sub] = segmentsOf(target)
    if (!id || sub) return json({ error: 'not found' }, 404)
    const existing = await db.Order.get(id)
    if (!existing) return json({ error: 'not found' }, 404)
    const body = data && typeof data === 'object' ? data : {}
    const status = body.status
    if (!OWNER_SETTABLE_STATUSES.includes(status)) {
      return json({ error: `status must be one of ${OWNER_SETTABLE_STATUSES.join(', ')}` }, 400)
    }
    // Only status and the queue it implies are ever written: everything else — id, code,
    // items, every total, paymentStatus, paymentRef, the customer's details — is restated
    // from the stored row, so a body carrying those fields changes nothing.
    const row = { ...existing, status, queue: queueForStatus(status) }
    await db.Order.put(row)
    return json({ order: adminOrderView(row) })
  })
}
