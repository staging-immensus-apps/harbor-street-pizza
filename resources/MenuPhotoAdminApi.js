// The owner's photo upload for one menu item. One Resource per entity; the class is
// MenuPhotoAdminApi and the table is MenuItemPhoto (rule 2).
//
//   POST   /MenuPhotoAdminApi/:menuItemId   { dataBase64, contentType } → 200
//          { ok, photo: { menuItemId, contentType, byteSize, uploadedAt, photoUpdatedAt } }
//   DELETE /MenuPhotoAdminApi/:menuItemId   → 200 { ok }
//
// ADMIN ONLY, exactly as resources/MenuAdminApi.js: requireAdmin() re-reads the User row on
// every call, so a demoted or deactivated admin is refused on their very next request even with
// an unexpired cookie. Auth failures are the thrown 403 Response from lib/auth.js, served by
// runAuthed() (rule 20).
//
// lib/photos.js decides what bytes are acceptable (type, size, signature) and builds the
// MenuItemPhoto record; this resource owns only the ORDER the writes happen in:
//   1. requireAdmin.
//   2. the id must name an existing MenuItem, or a photo would be bytes nothing can serve or
//      delete — 404 before anything is decoded.
//   3. decodePhoto() — refuse 400 on any of its verdicts.
//   4. put the MenuItemPhoto row.
//   5. VERIFY ON WRITE (rule 8): re-read the row and compare it against what was written. A
//      mismatch deletes the row immediately and answers 502 — the sender did nothing wrong, the
//      store did — and the MenuItem is NOT stamped, so a broken upload never becomes "this item
//      has a photo" to a customer.
//   6. only once the photo is confirmed stored, stamp MenuItem.photoUpdatedAt.
//
// Step 6 is the one place this file touches MenuItem, and `MenuItem.createdAt` /
// `MenuItem.updatedAt` are `@createdTime` / `@updatedTime` — Harper assigns both, and a record
// that NAMES either is refused with a bare 400 and no body (CLAUDE.md §8, lib/managed-fields.js).
// The stamp write spreads the STORED item row, which is exactly the shape that trap catches, so
// it goes through withoutManaged() first; nothing here ever reads or writes createdAt/updatedAt.

import { Resource } from 'harperdb'
import { db } from '../lib/db.js'
import { requireAdmin } from '../lib/auth.js'
import { json, segmentsOf } from '../lib/http.js'
import { runAuthed } from '../lib/sign-in-support.js'
import { withoutManaged } from '../lib/managed-fields.js'
import { decodePhoto, photoRecord, verifyStoredPhoto } from '../lib/photos.js'

export class MenuPhotoAdminApi extends Resource {
  static loadAsInstance = false

  // No GET route is planned for this resource — the public read path is MenuPhotoApi. Still
  // admin-gated first, so an unsupported method on this path never tells an unauthenticated
  // caller anything about what exists.
  async get (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      return json({ error: 'not found' }, 404)
    })
  }

  async post (target, data) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      const [id, sub] = segmentsOf(target)
      if (!id || sub) return json({ error: 'not found' }, 404)
      const body = data && typeof data === 'object' ? data : {}
      return uploadPhoto(id, body)
    })
  }

  async put (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      return json({ error: 'not found' }, 404)
    })
  }

  async patch (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      return json({ error: 'not found' }, 404)
    })
  }

  async delete (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      const [id, sub] = segmentsOf(target)
      if (!id || sub) return json({ error: 'not found' }, 404)
      return removePhoto(id)
    })
  }
}

/**
 * The upload, in the order the header lays out. `item` is re-used for the step-6 stamp rather
 * than re-read, because nothing between step 2 and step 6 can have changed it — this resource is
 * the only writer of MenuItem.photoUpdatedAt and holds the admin lock for the whole request.
 */
async function uploadPhoto (id, body) {
  const item = await db.MenuItem.get(id)
  if (!item) return json({ error: 'not found' }, 404)

  const decoded = decodePhoto(body)
  if (decoded.error) return json({ error: decoded.error, code: decoded.code }, 400)

  const record = photoRecord(id, decoded.value)
  await db.MenuItemPhoto.put(record)

  const stored = await db.MenuItemPhoto.get(id)
  if (!(await verifyStoredPhoto(stored, decoded.value))) {
    await db.MenuItemPhoto.delete(id)
    globalThis.logger?.error(`[MenuPhotoAdminApi] photo for menu item ${id} did not verify after write — deleted, not stamped`)
    return json({ error: 'the photo did not store correctly', code: 'photo_not_stored' }, 502)
  }

  await db.MenuItem.put({ ...withoutManaged(item, 'MenuItem'), photoUpdatedAt: record.uploadedAt })
  return json({
    ok: true,
    photo: {
      menuItemId: id,
      contentType: record.contentType,
      byteSize: record.byteSize,
      uploadedAt: record.uploadedAt,
      photoUpdatedAt: record.uploadedAt,
    },
  })
}

/** 404 when there is no photo to remove; otherwise the row goes and the item's stamp clears. */
async function removePhoto (id) {
  const photo = await db.MenuItemPhoto.get(id)
  if (!photo) return json({ error: 'not found' }, 404)
  await db.MenuItemPhoto.delete(id)
  const item = await db.MenuItem.get(id)
  if (item) await db.MenuItem.put({ ...withoutManaged(item, 'MenuItem'), photoUpdatedAt: null })
  return json({ ok: true })
}
