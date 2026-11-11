// Owner-only menu editor. One Resource per entity; the class is MenuAdminApi and the table is
// MenuItem (rule 2). Every item including hidden ones, for the owner to edit.
//
//   GET    /MenuAdminApi/            every item, sortMenu + adminMenuItem
//   GET    /MenuAdminApi/:id         one item, or 404
//   POST   /MenuAdminApi/            { name, description?, priceCents, category?, available?, sortOrder? } → 201 { item }
//   POST   /MenuAdminApi/update      { id, ...partial fields } → { item } — THE update route.
//   POST   /MenuAdminApi/delete      { id } → { ok: true } — THE delete route.
//
// The id travels in the body and the path names an action. UNRESOLVED: this shape was adopted on
// the theory that Harper refuses a write whose path names a record, and THAT THEORY IS WRONG — QA
// on this build found `POST /MenuAdminApi/update` and `POST /MenuAdminApi/delete`, which carry no
// record segment, answering 400 exactly as `PATCH /MenuAdminApi/:id` did, including on a save that
// changed no values. An earlier round had already discarded "the verb is the variable" (PATCH→PUT
// changed nothing). So the cause of the 400 is NOT KNOWN; see CLAUDE.md §7 "OPEN QUESTION" for the
// evidence that is missing. The action routes are kept because they are no worse than what they
// replaced and the page already calls them — not because they are known to be right.
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

/** The create body, unchanged from before the action-route split. */
async function createItem (body) {
  const fields = validateMenuItem(body, { partial: false })
  if (fields.error) return json({ error: fields.error }, 400)
  const now = new Date().toISOString()
  const row = { id: crypto.randomUUID(), ...fields.value, createdAt: now, updatedAt: now }
  await db.MenuItem.put(row)
  return json({ item: adminMenuItem(row) }, 201)
}

/**
 * The partial-update body shared by the `update` action route and the put()/patch() aliases:
 * same validation, same merge, same response however the id arrived. Semantics stay PARTIAL —
 * the editor dialog sends only the changed fields. `id` and `createdAt` are restated from the
 * stored row rather than trusted from the body, even though validateMenuItem() already drops
 * unknown keys, so a forged id or createdAt in the body changes neither.
 */
async function updateItem (id, body) {
  if (!id) return json({ error: 'not found' }, 404)
  const existing = await db.MenuItem.get(id)
  if (!existing) return json({ error: 'not found' }, 404)
  const fields = validateMenuItem(body, { partial: true })
  if (fields.error) return json({ error: fields.error }, 400)
  const row = { ...existing, ...fields.value, id: existing.id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() }
  await db.MenuItem.put(row)
  return json({ item: adminMenuItem(row) })
}

/** Shared by the `delete` action route and the DELETE verb alias. */
async function deleteItem (id) {
  if (!id) return json({ error: 'not found' }, 404)
  const existing = await db.MenuItem.get(id)
  if (!existing) return json({ error: 'not found' }, 404)
  await db.MenuItem.delete(id)
  return json({ ok: true })
}
