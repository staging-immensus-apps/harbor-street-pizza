import { appName, Shell } from '@/components/shell'

/**
 * The template's one page: a plain landing the builder replaces with the app's own first screen. It
 * fetches nothing and knows nothing about accounts — a kit the platform copies in brings its own pages.
 * The wording is placeholder wording.
 */
export default function Home () {
  return (
    <Shell>
      <div className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center text-center">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">{appName()}</h1>
        <p className="mt-4 text-lg text-muted-foreground">This app is being built.</p>
      </div>
    </Shell>
  )
}
