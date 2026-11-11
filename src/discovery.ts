// What this app is made of, found by looking rather than by a list somebody has to keep.
//
// THE PROBLEM. The template core is bare bones. When a plan says people sign in, the platform copies the sign-in KIT
// into the app — its pages, its routes and the session handling — and it copies only NEW files: it never
// edits a file the app already has, so a kit that needed `src/App.tsx` or `src/components/shell.tsx`
// changed to be wired in would be a kit nobody could install. So the core finds a kit's pieces by where
// they sit, the same way Harper finds `resources/*.js` and `data/*.yaml`.
//
// Three places, each a directory or a file-name pattern, and nothing else:
//
//   src/pages/**/<Name>.tsx  →  PAGES      a page module, named by its file. A route's `page: 'Name'`
//                                           finds it here. The builder's own checks look a page up the
//                                           same way,
//                                           so a page module is never registered by hand.
//   routes/spa.<kit>.json    →  KIT_ROUTES a kit's page routes, `[{ path, page, admin? }]`. The SERVER reads
//                                           the same file (lib/pages.js), so the browser and the page
//                                           listener cannot disagree about a kit's routes. The app's own
//                                           routes stay in src/routes.ts.
//   src/extensions/<kit>.tsx →  EXTENSIONS what a kit adds around the pages: a provider wrapping the app
//                                           (the session), props every page receives, a guard around each
//                                           routed page, and two places in the header. Every slot is
//                                           optional and `Extension` below names all five.
//
// `import.meta.glob` with `eager: true` is Vite's own discovery and compiles to ordinary static imports,
// so nothing here loads late or fetches anything (rule 14). `scripts/page-boot-acceptance.js` expands
// the same three patterns for esbuild, which has no `import.meta.glob` of its own.
//
// TWO PAGE MODULES WITH ONE NAME is a defect this module refuses to resolve by guessing: the first in
// path order wins and the collision is reported with console.error, which page-boot-acceptance turns
// into a red because it boots src/App.tsx and fails a boot that logs one.

import type { ComponentType, ReactNode } from 'react'
import type { AppRoute } from '@/routes'

/** Props every page receives. The core passes none; an extension may add some (`usePageProps`). */
export type PageProps = Record<string, unknown>

/** What a kit may add, all optional. Read by src/App.tsx and src/components/shell.tsx and nothing else. */
export type Extension = {
  /** Wraps the whole app, outermost first by file name. The sign-in kit loads the session here. */
  Provider?: ComponentType<{ children: ReactNode }>
  /** A hook returning props merged into every page's props. */
  usePageProps?: () => PageProps
  /** Wraps each routed page, so a kit can refuse one (the sign-in kit's `admin: true`). */
  Guard?: ComponentType<{ route: AppRoute; children: ReactNode }>
  /** Rendered in the header after the app's own Home link. */
  NavItems?: ComponentType
  /** Rendered at the right-hand end of the header. */
  HeaderEnd?: ComponentType
}

const byPath = <T,>(found: Record<string, T>) => Object.keys(found).sort().map((k) => [k, found[k]] as const)

const pageModules = import.meta.glob<{ default?: ComponentType<PageProps> }>('./pages/**/*.tsx', { eager: true })
export const PAGES: Record<string, ComponentType<PageProps>> = {}
for (const [path, mod] of byPath(pageModules)) {
  const name = path.split('/').pop()!.replace(/\.tsx$/, '')
  if (!mod?.default) continue
  if (PAGES[name]) { console.error(`[discovery] two page modules are named ${name}; ${path} is ignored. Rename one: a route names its page by file name.`); continue }
  PAGES[name] = mod.default
}

const kitRouteFiles = import.meta.glob<unknown>('../routes/spa.*.json', { eager: true, import: 'default' })
export const KIT_ROUTES: AppRoute[] = byPath(kitRouteFiles).flatMap(([path, list]) => {
  if (!Array.isArray(list)) { console.error(`[discovery] ${path} is not an array of routes; its routes are not served`); return [] }
  // The same predicate lib/pages.js uses (`isKitRoute`), so the browser and the server never disagree
  // about which entries are routes: an absolute path and a non-empty page name.
  return list.filter((r): r is AppRoute => !!r && typeof r === 'object' && typeof (r as AppRoute).path === 'string' && (r as AppRoute).path.startsWith('/') && typeof (r as AppRoute).page === 'string' && (r as AppRoute).page !== '')
})

const extensionModules = import.meta.glob<Extension>('./extensions/*.tsx', { eager: true })
export const EXTENSIONS: Extension[] = byPath(extensionModules).map(([, mod]) => mod)
