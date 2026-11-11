/**
 * GENERATED from src/routes.ts — the app's page routes, one for one.
 *
 * `lib/pages.js` serves `web/index.html` at every path below, and the single-page app routes from
 * there. `resources/Pages.js` registers it with Harper as one `server.http` listener; this file is
 * only the list. scripts/spa-routes-acceptance.js fails the pull request when it and src/routes.ts
 * disagree.
 *
 * `/order/*` is the only wildcard: the confirmation page is `/order/:code`, and a `/x/*` entry
 * answers the bare `/x` as well (rule 26), so it is listed once.
 *
 * A KIT'S PAGE ROUTES ARE NOT HERE: the sign-in kit brings routes/spa.sign-in.json, which
 * lib/pages.js reads beside this list.
 *
 * A PLAIN LIST AND NOT A FASTIFY PLUGIN. Harper serves only ONE component's `fastifyRoutes` per
 * process and drops the second with one WARN line, and an update to a published app runs two copies
 * of this app in one process.
 *
 * Imports nothing (rule 5).
 */
export const SPA_ROUTES = [
  '/',
  '/basket',
  '/checkout',
  '/order/*',
  '/manage',
  '/manage/orders',
  '/manage/menu',
  '/manage/settings',
]
