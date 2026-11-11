// Owner-only menu editor. One Resource per entity; the class is MenuAdminApi and the table is
// MenuItem (rule 2). Every item including hidden ones, for the owner to edit.
//
//   GET    /MenuAdminApi/          every item, sortMenu + adminMenuItem
//   GET    /MenuAdminApi/:id       one item, or 404
//   POST   /MenuAdminApi/         { name, description?, priceCents, category?, available?, sortOrder? } → 201 { item }
//   PUT    /MenuAdminApi/:id      partial update → { item } — the update route. Harper's REST layer
//                                 answered 400 to PATCH before this resource ever ran (measured on
//                                 the cluster, 2026-11-11), so the update is served on PUT, the verb
//                                 the platform's own worked examples use (MembersApi, StoreSettingsApi,
//                                 AdminApi, AccountApi); PATCH is kept working as an alias, same body
//                                 shape, in case a client still sends it.
//   DELETE /MenuAdminApi/:id      → { ok: true }
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
      const [id] = segmentsOf(target)
      if (id) return json({ error: 'not found' }, 404)
      const body = data && typeof data === 'object' ? data : {}
      const fields = validateMenuItem(body, { partial: false })
      if (fields.error) return json({ error: fields.error }, 400)
      const now = new Date().toISOString()
      const row = { id: crypto.randomUUID(), ...fields.value, createdAt: now, updatedAt: now }
      await db.MenuItem.put(row)
      return json({ item: adminMenuItem(row) }, 201)
    })
  }

  async put (target, data) {
    target.checkPermission = false
    return applyUpdate(this, target, data)
  }

  async patch (target, data) {
    target.checkPermission = false
    return applyUpdate(this, target, data)
  }

  async delete (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      const [id, sub] = segmentsOf(target)
      if (!id || sub) return json({ error: 'not found' }, 404)
      const existing = await db.MenuItem.get(id)
      if (!existing) return json({ error: 'not found' }, 404)
      await db.MenuItem.delete(id)
      return json({ ok: true })
    })
  }
}

/**
 * The partial-update body shared by put() and patch() (rule 1 in the task that split this out:
 * same validation, same merge, same response, served on either verb). Semantics stay PARTIAL for
 * both — the editor dialog sends only the changed fields.
 */
async function applyUpdate (self, target, data) {
  return runAuthed(async () => {
    await requireAdmin(self)
    const [id, sub] = segmentsOf(target)
    if (!id || sub) return json({ error: 'not found' }, 404)
    const existing = await db.MenuItem.get(id)
    if (!existing) return json({ error: 'not found' }, 404)
    const body = data && typeof data === 'object' ? data : {}
    const fields = validateMenuItem(body, { partial: true })
    if (fields.error) return json({ error: fields.error }, 400)
    const row = { ...existing, ...fields.value, id: existing.id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() }
    await db.MenuItem.put(row)
    return json({ item: adminMenuItem(row) })
  })
}
