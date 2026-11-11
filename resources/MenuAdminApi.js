// Owner-only menu editor. One Resource per entity; the class is MenuAdminApi and the table is
// MenuItem (rule 2). Every item including hidden ones, for the owner to edit.
//
//   GET    /MenuAdminApi/            every item, sortMenu + adminMenuItem
//   GET    /MenuAdminApi/:id         one item, or 404
//   POST   /MenuAdminApi/            { name, description?, priceCents, category?, available?, sortOrder? } → 201 { item }
//   POST   /MenuAdminApi/update      { id, ...partial fields } → { item } — THE update route.
//   POST   /MenuAdminApi/delete      { id } → { ok: true } — THE delete route.
//
// The id travels in the body and the path names an action — RESOLVED, and it was never the route
// shape. `MenuItem.createdAt` and `MenuItem.updatedAt` are `@createdTime` / `@updatedTime`
// (schema.graphql), so Harper assigns both; a record handed to `put()` that NAMES either one is
// refused with a bare `400 Bad Request` and no JSON body, which is the unexplained "Bad Request"
// banner the owner saw on every menu save. `createItem()` used to write `createdAt`/`updatedAt`
// literals, and `updateItem()` used to spread the stored row — which names `updatedAt` just as
// surely as a literal does, because the stored row has one. Neither call site names either field
// now (`lib/managed-fields.js`'s `withoutManaged`), and both re-read the row after the write so the
// page is shown the timestamps Harper actually assigned. The action routes are kept exactly as they
// were: the page already calls them, and the record-in-the-path theory this comment used to carry
// was already falsified before the real cause was found.
//
// `PUT /MenuAdminApi/:id`, `PATCH /MenuAdminApi/:id` and `DELETE /MenuAdminApi/:id` are KEPT
// working exactly as before, as aliases for anything that still reaches them — sharing the same
// merge and delete logic as the action routes below rather than duplicating it.
//
// Every method is admin-only (rule: an app with no customer accounts, only the owner signs in).
// requireAdmin() re-reads the User row on every call, so a demoted or deactivated admin is refused
// on their very next request even with an unexpired cookie. Auth failures are the thrown 403
// Response from lib/auth.js, served by runAuthed() (rule 20).
//
// This resource never reads or writes Order: a deleted or changed menu item must not alter an order
// already placed, because Order.items is a snapshot taken at checkout time (CLAUDE.md §8).

import crypto from 'node:crypto'
import { Resource } from 'harperdb'
import { db } from '../lib/db.js'
import { requireAdmin } from '../lib/auth.js'
import { json, segmentsOf } from '../lib/http.js'
import { runAuthed } from '../lib/sign-in-support.js'
import { sortMenu, adminMenuItem, validateMenuItem } from '../lib/menu.js'
import { withoutManaged } from '../lib/managed-fields.js'

export class MenuAdminApi extends Resource {
  static loadAsInstance = false

  async get (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      const [id, sub] = segmentsOf(target)
      if (!id) {
        const rows = []
        for await (const row of db.MenuItem.search({ conditions: [] })) rows.push(row)
        return json({ items: sortMenu(rows).map(adminMenuItem) })
      }
      if (sub) return json({ error: 'not found' }, 404)
      const row = await db.MenuItem.get(id)
      if (!row) return json({ error: 'not found' }, 404)
      return json({ item: adminMenuItem(row) })
    })
  }

  async post (target, data) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      const [action, extra] = segmentsOf(target)
      const body = data && typeof data === 'object' ? data : {}
      if (!action) return createItem(body)
      if (extra) return json({ error: 'not found' }, 404)
      if (action === 'update') return updateItem(String(body.id ?? '').trim(), body)
      if (action === 'delete') return deleteItem(String(body.id ?? '').trim())
      return json({ error: 'not found' }, 404)
    })
  }

  async put (target, data) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      const [id, sub] = segmentsOf(target)
      if (!id || sub) return json({ error: 'not found' }, 404)
      const body = data && typeof data === 'object' ? data : {}
      return updateItem(id, body)
    })
  }

  async patch (target, data) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      const [id, sub] = segmentsOf(target)
      if (!id || sub) return json({ error: 'not found' }, 404)
      const body = data && typeof data === 'object' ? data : {}
      return updateItem(id, body)
    })
  }

  async delete (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      const [id, sub] = segmentsOf(target)
      if (!id || sub) return json({ error: 'not found' }, 404)
      return deleteItem(id)
    })
  }
}

/**
 * The create body. The record put carries NO `createdAt` and NO `updatedAt` at all — Harper
 * assigns both (`@createdTime` / `@updatedTime`), and naming either is the 400 this resource used
 * to produce. The row is re-read after the put so the response carries the timestamps Harper
 * actually assigned, falling back to the written record only if that re-read somehow comes back
 * null.
 */
async function createItem (body) {
  const fields = validateMenuItem(body, { partial: false })
  if (fields.error) return json({ error: fields.error }, 400)
  const id = crypto.randomUUID()
  const row = { id, ...fields.value }
  await db.MenuItem.put(row)
  const stored = (await db.MenuItem.get(id)) ?? row
  return json({ item: adminMenuItem(stored) }, 201)
}

/**
 * The partial-update body shared by the `update` action route and the put()/patch() aliases:
 * same validation, same merge, same response however the id arrived. Semantics stay PARTIAL —
 * the editor dialog sends only the changed fields. `id` is restated from the stored row rather
 * than trusted from the body, even though validateMenuItem() already drops unknown keys, so a
 * forged id in the body changes nothing. The stored row is spread through `withoutManaged()`
 * rather than as-is: spreading the row directly would name `updatedAt` just as surely as a
 * literal does, because the stored row already carries one, and that was the second of the two
 * call sites producing the 400. The row is re-read after the put for the same reason as create().
 */
async function updateItem (id, body) {
  if (!id) return json({ error: 'not found' }, 404)
  const existing = await db.MenuItem.get(id)
  if (!existing) return json({ error: 'not found' }, 404)
  const fields = validateMenuItem(body, { partial: true })
  if (fields.error) return json({ error: fields.error }, 400)
  const row = { ...withoutManaged(existing, 'MenuItem'), ...fields.value, id: existing.id }
  await db.MenuItem.put(row)
  const stored = (await db.MenuItem.get(id)) ?? row
  return json({ item: adminMenuItem(stored) })
}

/** Shared by the `delete` action route and the DELETE verb alias. */
async function deleteItem (id) {
  if (!id) return json({ error: 'not found' }, 404)
  const existing = await db.MenuItem.get(id)
  if (!existing) return json({ error: 'not found' }, 404)
  await db.MenuItem.delete(id)
  return json({ ok: true })
}
