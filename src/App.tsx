import type { ReactElement } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { ROUTES as APP_ROUTES, type AppRoute } from '@/routes'
import { EXTENSIONS, KIT_ROUTES, PAGES, type PageProps } from '@/discovery'

// The app's own routes (src/routes.ts) and then every kit's (routes/spa.<kit>.json). A page is found by
// its file name under src/pages/ (src/discovery.ts), so adding one is a module and a route, and this
// file does not change.
const ROUTES: readonly AppRoute[] = [...APP_ROUTES, ...KIT_ROUTES]

// Fixed for the life of the bundle, so every render calls the same hooks in the same order.
const PROP_HOOKS = EXTENSIONS.flatMap((e) => (e.usePageProps ? [e.usePageProps] : []))

function guarded (route: AppRoute, element: ReactElement): ReactElement {
  return EXTENSIONS.reduceRight<ReactElement>((inner, e) => (e.Guard ? <e.Guard route={route}>{inner}</e.Guard> : inner), element)
}

function Pages () {
  const props: PageProps = Object.assign({}, ...PROP_HOOKS.map((use) => use()))
  return (
    <Routes>
      {ROUTES.map((r, i) => {
        const Page = PAGES[r.page]
        if (!Page) return null
        return <Route key={`${r.path}#${i}`} path={r.path} element={guarded(r, <Page {...props} />)} />
      })}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

/**
 * The router. Every route comes from src/routes.ts or a kit's route file (front-end charter 4), and every
 * page from src/pages/. A kit wraps the app in its own provider and may guard a route (the sign-in kit
 * sends a visitor to sign in for an `admin: true` route); with no kit, every route renders as it is.
 * No fetch at module scope and nothing awaited above a value a component reads at import (rule 14,
 * page-boot-acceptance).
 */
export default function App () {
  return EXTENSIONS.reduceRight<ReactElement>((inner, e) => (e.Provider ? <e.Provider>{inner}</e.Provider> : inner), <Pages />)
}
