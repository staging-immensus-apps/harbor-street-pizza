// SIGN-IN KIT (the baseline a generated app adapts) — the member's own account.
//
//   GET /AccountApi/          { user }
//   PUT /AccountApi/profile   { name } → { ok, user }
//
// Everything here is the caller's own User row: no id is accepted from the request, so there
// is nothing to scope and nothing to leak. The profile write restates every field that is
// not `name` from the stored row, so the body cannot reach role, passwordHash or the counters.

import { Resource } from 'harperdb'
import { db } from '../lib/db.js'
import { loadCaller } from '../lib/session.js'
import { sanitizeUser } from '../lib/auth.js'
import { json, segmentsOf } from '../lib/http.js'
import { runAuthed } from '../lib/sign-in-support.js'

const NAME_MAX = 120

export class AccountApi extends Resource {
  static loadAsInstance = false

  async get (target) {
    target.checkPermission = false
    return runAuthed(async () => {
      const caller = await loadCaller(this)
      const [sub] = segmentsOf(target)
      if (sub) return json({ error: 'not found' }, 404)
      return json({ user: sanitizeUser(caller.row) })
    })
  }

  async put (target, data) {
    target.checkPermission = false
    return runAuthed(async () => {
      const caller = await loadCaller(this)
      const [sub, more] = segmentsOf(target)
      if (sub !== 'profile' || more) return json({ error: 'not found' }, 404)
      const body = data && typeof data === 'object' ? data : {}
      // Blank is absent (rule 11): clearing the name stores null, and the UI falls back to the email.
      const name = String(body.name ?? '').trim()
      if (name.length > NAME_MAX) return json({ error: `name must be at most ${NAME_MAX} characters` }, 400)
      const row = { ...caller.row, name: name || null, updatedAt: new Date().toISOString() }
      await db.User.put(row)
      return json({ ok: true, user: sanitizeUser(row) })
    })
  }
}
