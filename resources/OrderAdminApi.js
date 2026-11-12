// The owner's live order queue. Class name OrderAdminApi, table Order (rule 2). This is the
// ONLY resource in the app that serves customer names, phone numbers and delivery addresses
// (CLAUDE.md §9), so every entry point — including the live stream — opens with requireAdmin().
//
//   GET    /OrderAdminApi?queue=active|done|pending_payment   the named queue, newest first, with counts
//   GET    /OrderAdminApi/:id                                  one order in full, or 404
//   POST   /OrderAdminApi/status   { id, status }              advance the status; the queue is derived
//                                                              from it so the two can never disagree.
//                                                              THIS is the route the front end calls.
//   PUT    /OrderAdminApi/:id   { status }                     kept working as an alias for anything that
//   PATCH  /OrderAdminApi/:id   { status }                     still reaches them; same shared merge.
//   connect (SSE)                                             live Order arrivals/changes, admin-only
//
// RESOLVED: every status write used to answer a bare 400 with no JSON body. `Order.updatedAt`
// carries `@updatedTime`, so Harper assigns it and refuses any record that names it —
// `applyStatus()`'s merge was `{ ...existing, status, queue }`, and the SPREAD of the stored row
// names `updatedAt` just as surely as writing it by hand would, because a stored row has one. The
// route shape was never the fault — the action route stays exactly as it is, because the front end
// calls it — and the fix is `lib/managed-fields.js`'s `withoutManaged()` on the spread before the
// write, below.
//
// No DELETE: an order is created by CheckoutApi and never removed.

import { Resource } from 'harperdb'
import { db } from '../lib/db.js'
import { requireAdmin } from '../lib/auth.js'
import { json, segmentsOf, queryParams, runAuthed } from '../lib/http.js'
import { adminOrderView, queueForStatus, QUEUES, QUEUE_ACTIVE, OWNER_SETTABLE_STATUSES } from '../lib/orders.js'
import { withoutManaged } from '../lib/managed-fields.js'

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

  /**
   * The route the front end calls. The id lives in the body, not the path — see the header
   * comment for the measurement that this is required, not a stylistic choice.
   */
  async post (target, data) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      const [sub] = segmentsOf(target)
      if (sub !== 'status') return json({ error: 'not found' }, 404)
      const body = data && typeof data === 'object' ? data : {}
      return applyStatus(String(body.id ?? '').trim(), body)
    })
  }

  // Kept working as aliases for anything that still reaches a record path directly; same
  // shared merge as the action route above.
  async put (target, data) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      const [id, sub] = segmentsOf(target)
      if (!id || sub) return json({ error: 'not found' }, 404)
      const body = data && typeof data === 'object' ? data : {}
      return applyStatus(id, body)
    })
  }

  async patch (target, data) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      const [id, sub] = segmentsOf(target)
      if (!id || sub) return json({ error: 'not found' }, 404)
      const body = data && typeof data === 'object' ? data : {}
      return applyStatus(id, body)
    })
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
 * Advance an order's status, shared by post('status'), put() and patch() — one merge, called
 * once the caller is already proven admin and `id` already pulled from wherever its route
 * carries it (body for the action route, the path segment for the aliases).
 */
async function applyStatus (id, body) {
  if (!id) return json({ error: 'not found' }, 404)
  const existing = await db.Order.get(id)
  if (!existing) return json({ error: 'not found' }, 404)
  const status = body.status
  if (!OWNER_SETTABLE_STATUSES.includes(status)) {
    return json({ error: `status must be one of ${OWNER_SETTABLE_STATUSES.join(', ')}` }, 400)
  }
  // Only status and the queue it implies are ever written: everything else — id, code,
  // items, every total, paymentStatus, paymentRef, the customer's details — is restated
  // from the stored row, so a body carrying those fields changes nothing. withoutManaged()
  // strips updatedAt off the spread first: the stored row HAS one, and the spread would
  // otherwise name it, which is the whole of the 400 this resource used to answer.
  const row = { ...withoutManaged(existing, 'Order'), status, queue: queueForStatus(status) }
  await db.Order.put(row)
  const stored = await db.Order.get(id)
  return json({ order: adminOrderView(stored ?? row) })
}
