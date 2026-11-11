import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { EXTENSIONS } from '@/discovery'

/** The app's name. The server writes it into the page's title from this copy's APP_NAME (lib/pages.js). */
export const appName = () => document.title || 'App'

/** A page's heading: what this page is, a line about it, and its main action at the right. */
export function PageHeading ({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  )
}

/**
 * The page frame every page renders inside: a header, then the page.
 *
 * The header holds the app's name, which links home, and whatever a kit adds (src/discovery.ts): the
 * sign-in kit puts its sections after the name and its sign-in or sign-out at the right. With no kit there
 * is nothing about accounts here at all.
 */
export function Shell ({ title, description, actions, children }: { title?: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
        <div className="container flex h-14 items-center gap-4 sm:gap-6">
          <Link to="/" className="min-w-0 truncate text-[15px] font-semibold tracking-tight">{appName()}</Link>
          <nav className="flex flex-1 items-center gap-1">
            {EXTENSIONS.map((e, i) => (e.NavItems ? <e.NavItems key={i} /> : null))}
          </nav>
          <div className="flex shrink-0 items-center gap-3 text-sm">
            {EXTENSIONS.map((e, i) => (e.HeaderEnd ? <e.HeaderEnd key={i} /> : null))}
          </div>
        </div>
      </header>
      <main className="container py-10">
        {title && <PageHeading title={title} description={description} actions={actions} />}
        <div className="space-y-6">{children}</div>
      </main>
    </div>
  )
}
