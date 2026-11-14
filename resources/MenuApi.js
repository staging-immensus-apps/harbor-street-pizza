// The public menu: anyone, signed in or not, may read it (CLAUDE.md §9 — accessModel
// callerAuth: "none"). Returns only rows with available: true — an unavailable item is simply
// not on the menu, never a hidden field on it — sorted and grouped by lib/menu.js, the same
// module MenuAdminApi uses, so the public order and the owner's editor order cannot drift apart.
//
// `acceptingOrders` and `storeName` ride along from lib/shop.js's loadStoreSettings(): the menu
// page shows the paused message in the same screen that shows the menu, and a phone-first build
// is one round trip rather than two.
//
// NO AUTH ANYWHERE IN THIS FILE — not loadCaller, not requireAuth. The deploy's smoke table sends
// GET /MenuApi with no cookie and no query and the build stops unless it answers 200, so an empty
// table is `{ categories: [], items: [], acceptingOrders, storeName }` with status 200, never 404
// and never thrown.
//
// Each item carries a photo URL and NEVER photo bytes: `publicMenuItem` (lib/menu.js) composes
// `photoUrl` from the row's id and `photoUpdatedAt`, null when the item has none. A listing with
// images inlined would be megabytes on a phone; the bytes live behind `MenuPhotoApi` instead.
//
// A STAMP IS A CLAIM, NOT A PHOTO. `photoUpdatedAt` and the `MenuItemPhoto` row are written by two
// different callers and can drift apart — QA found two items advertising a `photoUrl` that 404'd,
// because the stamp existed with no row behind it. So an item claiming a photo is checked here,
// by a cheap metadata-only keyed read (`photoIsServable`, lib/photos.js — no bytes touched), before
// the URL is published; an item with no stamp is never looked up at all.

import { Resource } from 'harperdb'
import { db } from '../lib/db.js'
import { json, segmentsOf } from '../lib/http.js'
import { sortMenu, publicMenuItem, groupByCategory } from '../lib/menu.js'
import { loadStoreSettings, publicStoreInfo } from '../lib/shop.js'
import { photoIsServable } from '../lib/photos.js'

export class MenuApi extends Resource {
  static loadAsInstance = false

  async get (target) {
    target.checkPermission = false
    const [sub] = segmentsOf(target)
    if (sub) return json({ error: 'not found' }, 404)

    const rows = []
    for await (const row of db.MenuItem.search({ conditions: [{ attribute: 'available', value: true }] })) rows.push(row)
    const items = []
    for (const row of sortMenu(rows)) {
      if (!row.photoUpdatedAt) {
        items.push(publicMenuItem(row))
        continue
      }
      const photoRow = await db.MenuItemPhoto.get(row.id)
      const hasPhoto = photoIsServable(photoRow)
      if (!hasPhoto) {
        globalThis.logger?.warn(`[MenuApi] item ${row.id} claims a photo (photoUpdatedAt set) with no servable MenuItemPhoto row behind it`)
      }
      items.push(publicMenuItem(row, { hasPhoto }))
    }
    const categories = groupByCategory(items)

    const settings = await loadStoreSettings()
    const info = publicStoreInfo(settings)

    return json({
      categories,
      items,
      acceptingOrders: info.acceptingOrders,
      storeName: info.storeName,
    })
  }
}
