// THE FIELDS HARPER OWNS, and the one way this app keeps them out of a record it writes.
//
// A field carrying `@createdTime` or `@updatedTime` in schema.graphql is ASSIGNED BY HARPER, in
// epoch milliseconds. A record handed to `put()` that NAMES one of them is refused with a bare
// `400 Bad Request` and no JSON body at all — which is the unexplained "Bad Request" banner the
// owner saw on every menu save and every order-status tap (CLAUDE.md §7). The two routes that kept
// working were the two whose record never named one: `CheckoutApi`'s create, which builds a fresh
// `Order` field by field, and `StoreSettingsApi`'s save, which builds its row from a constant id
// plus validated fields.
//
// THE TRAP IS THE SPREAD, NOT THE LITERAL. `{ ...existing, status }` names `updatedAt` just as
// surely as writing `updatedAt: now` does, because the stored row has one — so every writer that
// restates a row it read must come through here first. That is why this is a module and not three
// `delete` lines: the next writer of an `Order` or a `MenuItem` has one obvious thing to call.
//
// Imports nothing, reaches no database: safe anywhere in resources/ and lib/, and drivable by a
// probe on its own.

/**
 * Per table, the attributes schema.graphql marks `@createdTime` / `@updatedTime`. Transcribed from
 * the schema deliberately rather than derived from it — nothing at runtime reads the SDL.
 *
 * SO THE TRANSCRIPTION IS HELD AGAINST THE SDL BY ONE SUITE: `scripts/managed-fields-probe.js`
 * parses every `schema*.graphql` and requires this map to EQUAL the set of `@createdTime` /
 * `@updatedTime` fields it finds — no missing table, no extra one. The resource probes cannot do
 * that job, because they assert through `managedFieldsIn()`, which reads this same map; without the
 * parse the map would only be checked against itself, and adding `@updatedTime` to a new field would
 * leave it stale and bring the `400` back with every probe still green.
 *
 * `User.createdAt` and `User.updatedAt` are NOT here and must not be: the sign-in kit declares them
 * as plain `String` columns in schema.sign-in.graphql, and the kit's own code writes them.
 */
export const MANAGED_FIELDS = {
  MenuItem: ['createdAt', 'updatedAt'],
  Order: ['updatedAt'],
  StoreSetting: ['updatedAt'],
}

/**
 * A shallow copy of `record` with the fields Harper assigns for `table` removed.
 *
 * Removed rather than set to null: a null is still the record naming the attribute, and the refusal
 * is about the attribute being present. An unknown table name removes nothing, so a caller that
 * misspells one gets the old behaviour rather than a silent half-fix — the probes drive that case.
 */
export function withoutManaged (record, table) {
  const out = { ...(record && typeof record === 'object' ? record : {}) }
  for (const field of MANAGED_FIELDS[table] ?? []) delete out[field]
  return out
}

/**
 * The fields of `record` that Harper owns for `table` — empty when the record is safe to write.
 * The verdict a probe asserts over every captured write, so "no write names a managed field" is one
 * function with a negative control rather than an assertion repeated per call site.
 */
export function managedFieldsIn (record, table) {
  const r = record && typeof record === 'object' ? record : {}
  return (MANAGED_FIELDS[table] ?? []).filter((field) => field in r)
}
