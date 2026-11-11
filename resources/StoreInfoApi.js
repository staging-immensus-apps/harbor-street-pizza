// Public, read-only: the shop-level facts a customer needs before ordering. No auth, no session
// read — the deploy's smoke table calls this with no cookie and the build stops unless it answers
// 200, including on the published app's first minute when StoreSetting holds no row at all
// (lib/shop.js loadStoreSettings() never throws and never 404s).
//
//   GET /StoreInfoApi        { store: publicStoreInfo(settings) } — always 200
//
// Nothing beyond publicStoreInfo()'s fixed subset is ever returned: never Order, never User,
// never a column outside that list (CLAUDE.md §9).

import { Resource } from 'harperdb'
import { json, segmentsOf } from '../lib/http.js'
import { loadStoreSettings, publicStoreInfo } from '../lib/shop.js'

export class StoreInfoApi extends Resource {
  static loadAsInstance = false

  async get (target) {
    target.checkPermission = false
    const [sub] = segmentsOf(target)
    if (sub) return json({ error: 'not found' }, 404)
    const settings = await loadStoreSettings()
    return json({ store: publicStoreInfo(settings) })
  }
}
