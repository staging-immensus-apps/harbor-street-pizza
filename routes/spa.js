/**
 * GENERATED from src/routes.ts — the app's page routes, one for one.
 *
 * `lib/pages.js` serves `web/index.html` at every path below, and the single-page app routes from
 * there. `resources/Pages.js` registers it with Harper as one `server.http` listener; this file is
 * only the list. scripts/spa-routes-acceptance.js fails the pull request when it and src/routes.ts
 * disagree.
 *
 * Paths, in the router's own syntax: an exact path, a `:name` segment for one segment, and a
 * trailing `/*` for everything below a prefix — `/x/*` answers `/x` as well as `/x/y`, because the bare
 * path is the one a person types.
 *
 * A KIT'S PAGE ROUTES ARE NOT HERE: a kit the platform copies in brings routes/spa.<kit>.json, which
 * lib/pages.js reads beside this list.
 *
 * A PLAIN LIST AND NOT A FASTIFY PLUGIN. Harper serves only
 * ONE component's `fastifyRoutes` per process and drops the second with one WARN line,
 * and an update to a published app runs two copies of this app in one process — so pages are
 * served by a listener each copy registers for itself, under its own address.
 *
 * Imports nothing (rule 5).
 */
export const SPA_ROUTES = [
  '/',
]
