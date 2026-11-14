// The public reader of one menu item's photo. Read by primary key only — no listing, no search,
// no sub-path past the id — and NO AUTH ANYWHERE IN THIS FILE: it is as public as MenuApi, because
// a customer's browser fetches it straight out of an <img> tag with no cookie to send.
//
// lib/photos.js owns what an acceptable stored photo is and how its bytes come back; this file
// never re-decides either question. A row whose contentType is not one lib/photos.js names, or
// whose bytes are missing or do not match their own signature, is served as 404 rather than
// whatever is actually in the column — a stored type is the only thing between this route and
// serving text/html out of a database cell.
//
// GET /MenuPhotoApi/:menuItemId  → the stored bytes with the stored content type, or 404
//
// class name MenuPhotoApi ≠ table name MenuItemPhoto (rule 2).

import { Resource } from 'harperdb'
import { db } from '../lib/db.js'
import { json, segmentsOf } from '../lib/http.js'
import { photoBytes, signatureMatches, PHOTO_CONTENT_TYPES } from '../lib/photos.js'

export class MenuPhotoApi extends Resource {
  static loadAsInstance = false

  async get (target) {
    target.checkPermission = false
    const [id, sub] = segmentsOf(target)
    if (!id || sub) return json({ error: 'not found' }, 404)
    const row = await db.MenuItemPhoto.get(id)
    if (!row) return json({ error: 'not found' }, 404)
    if (!PHOTO_CONTENT_TYPES.includes(row.contentType)) {
      globalThis.logger?.warn(`[MenuPhotoApi] stored photo for ${id} has an unsupported content type and was refused`)
      return json({ error: 'not found' }, 404)
    }
    const buffer = await photoBytes(row)
    if (!buffer || !signatureMatches(buffer, row.contentType)) {
      globalThis.logger?.warn(`[MenuPhotoApi] stored photo for ${id} is missing or does not match its declared signature`)
      return json({ error: 'not found' }, 404)
    }
    // Deliberately NOT no-store — the one route in this app that is cacheable on purpose.
    // lib/photos.js photoUrlFor() composes this URL with ?v=<photoUpdatedAt>, so replacing a
    // photo changes the URL and a cached copy can never be served as the stale one.
    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': row.contentType,
        'Content-Length': String(buffer.length),
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  }

  async post (target, data) {
    target.checkPermission = false
    return json({ error: 'not found' }, 404)
  }

  async put (target, data) {
    target.checkPermission = false
    return json({ error: 'not found' }, 404)
  }

  async delete (target) {
    target.checkPermission = false
    return json({ error: 'not found' }, 404)
  }
}
