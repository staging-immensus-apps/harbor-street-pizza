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

import { Resource } from 'harperdb'
import { db } from '../lib/db.js'
import { json, segmentsOf } from '../lib/http.js'
import { sortMenu, publicMenuItem, groupByCategory } from '../lib/menu.js'
import { loadStoreSettings, publicStoreInfo } from '../lib/shop.js'

export class MenuApi extends Resource {
  static loadAsInstance = false

  async get (target) {
    target.checkPermission = false
    const [sub] = segmentsOf(target)
    if (sub) return json({ error: 'not found' }, 404)

    const rows = []
    for await (const row of db.MenuItem.search({ conditions: [{ attribute: 'available', value: true }] })) rows.push(row)
    const items = sortMenu(rows).map(publicMenuItem)
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
