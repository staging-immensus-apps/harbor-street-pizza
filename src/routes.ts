// The app's own routes (front-end charter rule 4). The router reads it; the builder regenerates
// routes/spa.js from it; scripts/spa-routes-acceptance.js fails the PR when the two disagree.
//
// `path` is React Router syntax and maps 1:1 onto a page route the server answers: an exact path, a
// `:name` segment for one segment, and a trailing `/*` for everything below a prefix (rule 26 —
// `/x/*` answers `/x` too). `page` is the file name of a module under src/pages/ (src/discovery.ts).
//
// A KIT'S ROUTES ARE NOT HERE. A kit the platform copies in — sign-in, when a plan says people sign in
// — brings its own route file, routes/spa.<kit>.json, which the browser and the server both read
// (src/discovery.ts, lib/pages.js), so this file never has to change for one. `admin` means something
// only when a kit guards it: the sign-in kit sends a visitor to sign in for an `admin: true` route,
// and with no sign-in there is no administrator and no route should carry it.

export type AppRoute = {
  path: string
  page: string
  admin?: boolean
}

export const ROUTES: readonly AppRoute[] = [
  { path: '/', page: 'Home' },
  { path: '/basket', page: 'Basket' },
  { path: '/checkout', page: 'Checkout' },
  { path: '/order/*', page: 'OrderConfirmation' },
  { path: '/manage', page: 'ManageHome', admin: true },
  { path: '/manage/orders', page: 'Orders', admin: true },
  { path: '/manage/menu', page: 'MenuEditor', admin: true },
  { path: '/manage/settings', page: 'Settings', admin: true },
]
