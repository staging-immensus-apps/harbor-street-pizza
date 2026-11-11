// SEEDED — the one place this app's table set is bound to a database, and the only module in
// resources/, lib/ or routes/ that may name `tables` or `databases` (rule 18).
//
// THE PROBLEM. A person has to be able to look at a build before it goes live. Harper's
// `tables` global is the DEFAULT database, so code written against it can only ever read one
// dataset — and the flow this app needs is one identical tree that reads either a staging
// database or the real one: the component is deployed pointing at the stage database, and when
// the person hits publish it is redeployed pointing at the prod database.
//
// So the database is a DEPLOY-TIME value, read from this copy's own `CONFIG.env` (lib/config.js):
// the preview copy is handed `stage` and the published copy `data`, and since 2026-10-15 both run at
// once on one cluster (lib/copy.js). The preview copy's tables are
// declared in `stage` by the builder at deploy time — `@table(database: "stage")` in the SHIPPED tree,
// never in this repository, so the rule against re-binding an app's source is
// kept: this repository deployed as-is still reads `data`.
//
// THE DATABASE USED TO BE CHOSEN PER REQUEST, AND IS NOT ANY MORE. A middleware marked every request
// under `/preview` and this file read the mark off Harper's ambient context, so one deploy served both
// addresses. That cannot survive a second copy of the app in the same process — its middleware would
// hijack the preview copy's address — so the copy's own configuration decides,
// once, for the whole process.
//
// UNSET MEANS THE DEFAULT, and that is a rule rather than a convenience: the app has to deploy
// onto any instance of Harper and still run. With nothing set this app reaches for exactly the
// accessor every Harper application has always used, and never touches `databases` at all.
//
// THE LOOKUP IS LAZY, AND THAT IS THE LOAD-BEARING LINE OF THIS FILE. Resolving once at module
// load captures whatever `databases` held when the first resource was linked. A deploy that
// creates the database around the same time as the component would then capture `undefined`
// permanently, and schema propagation does not rescue it: measured on a live 5.3.1 cluster it
// takes 0.08–0.49 s to reach every worker on both nodes, so it is fast but not instant, and the
// window is real. Resolving on each access makes the window harmless, and only a SUCCESSFUL
// resolution is remembered, so a process that starts inside the window heals itself rather than
// staying broken until somebody restarts it.

import { tables, databases } from 'harperdb'
import { config, DEFAULT_DATABASE } from './config.js'

// Remembered only on success (see the header), keyed BY NAME so a changed name is re-resolved
// rather than served from a stale cache.
//
// A MAP RATHER THAN ONE SLOT: a copy reads one name, and the map costs nothing over a slot while
// staying correct if a suite drives two names in one process.
const resolved = new Map()

/**
 * Why the database is not there, in a sentence somebody can act on.
 *
 * TWO SENTENCES, because one of them would be untrue in the other case: nothing declared
 * `IMMENSUS_DATABASE` when the name is the default, and saying otherwise sends a person looking
 * through their own repository for a value that is not written there (a fail-closed
 * default has to say that it defaulted).
 *
 * Exported because the default branch cannot be reached from a suite — `tables` is always
 * present wherever Harper is — and an untestable branch is an untested promise. It is a
 * pure function of a name and reads nothing, so exporting it adds no seam into behaviour.
 */
export function missingDatabaseError (name) {
  return new Error(name === DEFAULT_DATABASE
    ? `the default database "${name}" is not available from this process — lib/db.js needs Harper's own globals, so it cannot be imported from a plain node script`
    : `IMMENSUS_DATABASE="${name}" names no database on this cluster — unset it to use the default "${DEFAULT_DATABASE}"`)
}

/**
 * Why the preview copy refuses to read the default database, in a sentence somebody can act on.
 *
 * THE PREVIEW COPY IS PUBLIC, so a
 * preview copy configured to read `data` — a missing `IMMENSUS_DATABASE`, or a hand-written one —
 * would serve real rows to anyone who types `/preview`. The builder never writes that pair; the only
 * ways here are a hand-written `CONFIG.env` or a defect over there, and both are worth a loud failure.
 * A preview that answers 500 is the cheap failure; the other one is not recoverable once it happens.
 *
 * Exported so the branch can be asserted on its own.
 */
export function previewReadsProductionError (name) {
  return new Error(`this is the PREVIEW copy (IMMENSUS_PREVIEW=true) and its database is "${name}", the published app's own — refused, because the preview path is public and would serve real rows. The builder writes IMMENSUS_DATABASE=stage into the preview copy's CONFIG.env; check that file`)
}

/**
 * Which database THIS copy reads: its configured one, refused when it is the preview copy pointed at
 * the default database.
 *
 * A property of the copy and not of the request, so it answers the same from a request, a scheduled
 * loop, a replication apply or an ops-API call. Exported so the branch can be asserted on its own
 * rather than only through a table access.
 */
export function selectedDatabaseName () {
  const name = config.databaseName()
  if (config.previewCopy() && name === DEFAULT_DATABASE) throw previewReadsProductionError(name)
  return name
}

/**
 * The database this process reads and writes, resolved from configuration on every access.
 *
 * Throws if the configured database does not exist here, naming the variable and the value.
 * `databases` is a plain null-prototype object rather than a Proxy (harper@5.3.1
 * resources/databases.ts:402), so an absent name is `undefined` and `databases.stage.User`
 * would otherwise throw `Cannot read properties of undefined (reading 'User')` out of whichever
 * resource happened to touch a table first — a message that names neither the database nor the
 * variable that chose it.
 */
function selected () {
  const name = selectedDatabaseName()
  const cached = resolved.get(name)
  if (cached !== undefined) return cached

  // `databases[DEFAULT_DATABASE]` and `tables` are THE SAME OBJECT on a live 5.3.1 cluster,
  // confirmed by identity on every worker, so this branch changes no behaviour there. It is
  // kept because it is what makes the default path depend on one Harper global instead of two,
  // which is the portability rule in the header rather than a preference.
  const handle = name === DEFAULT_DATABASE ? tables : databases?.[name]

  if (!handle) throw missingDatabaseError(name)

  resolved.set(name, handle)
  return handle
}

/**
 * The app's tables: `db.User`, `db.Order`, and so on, exactly as `tables.X` read before this
 * module existed.
 *
 * A Proxy and not an object of getters, because the table names are the app's own
 * (schema.graphql is GENERATED) and this file is seeded into every app, so it must not carry a
 * list of them. The three traps beside `get` are there so the standard ways of asking an object
 * what it holds answer about the real database instead of answering `[]` about an empty target,
 * which is the silent wrong answer rather than the loud one.
 */
export const db = new Proxy({}, {
  // A symbol is never a table name, and returning `undefined` for one matches what the probe
  // stub's own `tables` proxy does — so the double and the real thing agree, which is the point
  // of having a double at all. It also keeps inspection harmless: `console.log(db)` and
  // `util.inspect(db)` reach for `Symbol.toStringTag` and friends, and a debugging aid that
  // throws is worst exactly when somebody is debugging a database that is not there.
  // A string still resolves, so `db.then` is the table set's answer and not ours.
  get: (_target, table) => (typeof table === 'string' ? selected()[table] : undefined),
  has: (_target, table) => table in selected(),
  ownKeys: () => Reflect.ownKeys(selected()),
  getOwnPropertyDescriptor: (_target, table) => {
    const d = Reflect.getOwnPropertyDescriptor(selected(), table)
    // `configurable: true` is required, not cosmetic: a Proxy may not report a property as
    // non-configurable when its own target has no such property, and the target is `{}`.
    return d === undefined ? undefined : { ...d, configurable: true }
  },
})
