// GENERATED — the owner's shop settings screen (one entry in api-plan.json). Admin-only, both
// methods: `requireAdmin` throws the 403 Response lib/http.js's `runAuthed` serves as-is (rule
// 20, never 401). The row is a SINGLETON keyed by the constant lib/shop.js exports (STORE_ID),
// never by anything in the body, so there can only ever be one StoreSetting row no matter what
// id a caller's PUT body carries.
//
//   GET /StoreSettingsApi        current settings (or built-in defaults, unsaved) + the date
//                                 customer details were last cleared (read-only, from LoopRun)
//   PUT /StoreSettingsApi        validate the whole body and save it; first save CREATES the row
//
// lib/shop.js's validator carries every rule the plan asks for (fee, estimates, postcode
// normalization, delivery-needs-postcodes, not-both-off); this resource does not re-check any
// of it and does not touch LoopRun, which the scheduled retention sweep owns alone.

import { Resource } from 'harperdb'
import { db } from '../lib/db.js'
import { requireAdmin } from '../lib/auth.js'
import { json, segmentsOf, runAuthed } from '../lib/http.js'
import { STORE_ID, loadStoreSettings, validateStoreSettings } from '../lib/shop.js'
import { lastDetailsClearedAt } from '../lib/retention.js'

export class StoreSettingsApi extends Resource {
  static loadAsInstance = false

  async get (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      const [sub] = segmentsOf(target)
      if (sub) return json({ error: 'not found' }, 404)
      const settings = await loadStoreSettings()
      const clearedAt = await lastDetailsClearedAt()
      return json({ settings, lastDetailsClearedAt: clearedAt })
    })
  }

  async put (target, data) {
    target.checkPermission = false
    return runAuthed(async () => {
      await requireAdmin(this)
      const [sub] = segmentsOf(target)
      if (sub) return json({ error: 'not found' }, 404)
      const body = data && typeof data === 'object' ? data : {}
      const fields = validateStoreSettings(body)
      if (fields.error) return json({ error: fields.error }, 400)
      // The id is always the constant — never from the body — so a forged id cannot create a
      // second row, and this PUT always lands on the one settings row this app has.
      await db.StoreSetting.put({ id: STORE_ID, ...fields.value })
      const settings = await loadStoreSettings()
      const clearedAt = await lastDetailsClearedAt()
      return json({ settings, lastDetailsClearedAt: clearedAt })
    })
  }
}
