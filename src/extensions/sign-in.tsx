// The sign-in kit's place in the app: the session around every page, the guard on `admin: true` routes,
// and the header's sections and sign-in state. The core finds this file by its directory
// (src/discovery.ts) and knows nothing about accounts itself, so nothing here
// edits a core file — which is the only way the platform can copy a kit in, because it never overwrites
// one.
//
// Loaded once, at module load, with the rest of the app: no fetch here and nothing awaited at module
// scope (rule 14). The session is loaded in the provider's effect.

import { useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { api, go, onApiRefusal } from '@/api/client'
import type { Me } from '@/api/sign-in'
import type { AppRoute } from '@/routes'
import { Button } from '@/components/ui/button'
import { Session, useMe } from '@/components/sign-in'

// A resource that needs a session answers 403 `auth_required` (rule 20); one that needs a paid plan
// answers `membership_required`. Both send the person to this kit's pages (src/api/client.ts).
onApiRefusal('auth_required', '/login')
onApiRefusal('membership_required', '/account?renew=1')

/** Loads the session once and holds the app on a loading line until it has. */
export function Provider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  useEffect(() => {
    let alive = true
    api.get<Me>('AuthApi/me')
      .then((m) => { if (alive) setMe(m && typeof m === 'object' && 'authenticated' in m ? m : { authenticated: false }) })
      .catch(() => { if (alive) setMe({ authenticated: false }) })
    return () => { alive = false }
  }, [])
  if (me === null) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>
  return <Session.Provider value={me}>{children}</Session.Provider>
}

/** Every page receives the session as `me`. */
export function usePageProps() {
  return { me: useMe() }
}

/** An `admin: true` route renders only for an administrator; a visitor is sent to sign in, a member home. */
export function Guard({ route, children }: { route: AppRoute; children: ReactNode }) {
  const me = useMe()
  if (!route.admin || (me.authenticated && me.user.role === 'admin')) return <>{children}</>
  return <Navigate to={me.authenticated ? '/' : `/login?next=${encodeURIComponent(route.path.replace(/\/\*$/, ''))}`} replace />
}

/** The administrator's section, after the app's name. */
export function NavItems() {
  const me = useMe()
  if (!me.authenticated || me.user.role !== 'admin') return null
  return <Link to="/admin" className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">Admin</Link>
}

/** Who is signed in, and the way out or in. */
export function HeaderEnd() {
  const me = useMe()
  async function signOut() {
    await api.post('AuthApi/logout')
    location.replace(go('/'))
  }
  if (!me.authenticated) return <Button asChild size="sm"><Link to="/login">Sign in</Link></Button>
  return (
    <>
      <Link to="/account" className="max-w-32 truncate text-muted-foreground transition-colors hover:text-foreground sm:max-w-56">{me.user.name || me.user.email}</Link>
      <Button variant="ghost" size="sm" onClick={signOut}>Sign out</Button>
    </>
  )
}
