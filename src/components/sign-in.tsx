import { createContext, useContext, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Me } from '@/api/sign-in'
import { appName } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * The session, as the sign-in kit's provider loaded it (src/extensions/sign-in.tsx). `null` until it has
 * loaded, and outside the provider altogether — a page booted on its own reads that as signed out.
 */
export const Session = createContext<Me | null>(null)

/** The current session; signed out until the provider says otherwise. */
export function useMe(): Me {
  return useContext(Session) ?? { authenticated: false }
}

/** The frame around every screen a person sees on the way in: no navigation, one centred column. */
export function AuthFrame({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Link to="/" className="text-sm font-semibold tracking-tight text-muted-foreground">{appName()}</Link>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-2 text-muted-foreground">{description}</p>}
        </div>
        {children}
      </div>
    </div>
  )
}

/** The prompt a member-only page shows a visitor instead of its content. */
export function SignInPrompt({ next }: { next: string }) {
  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>Sign in to see this page</CardTitle>
        <CardDescription>It is only available to people with an account.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild><Link to={`/login?next=${encodeURIComponent(next)}`}>Sign in</Link></Button>
      </CardContent>
    </Card>
  )
}
