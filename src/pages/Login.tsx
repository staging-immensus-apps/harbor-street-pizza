import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, isApiError, go } from '@/api/client'
import type { Me, AuthConfig, BootstrapState } from '@/api/sign-in'
import { AuthFrame } from '@/components/sign-in'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { errorText } from '@/lib/format'

// Google Identity Services, loaded only when the app has a client id (AuthApi/config).
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: { client_id: string; callback: (response: { credential: string }) => void }) => void
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void
        }
      }
    }
  }
}
const GSI_SRC = 'https://accounts.google.com/gsi/client'

// What AuthApi/verify's redirect says when a link fails (?error=…), in words.
const LINK_ERRORS: Record<string, string> = {
  'invalid-link': 'That sign-in link is invalid or has already been used. Request a new one below.',
  'user-missing': 'That account no longer exists.',
  deactivated: 'That account has been deactivated.',
}

// Shown instead of the email form when this app cannot send mail, and when a request is refused for
// that reason (AuthApi's `email_not_configured`). PLACEHOLDER wording.
const NO_EMAIL = 'This app cannot send sign-in emails yet. Ask the owner of this app to finish setting up email.'

// SETTING UP THE APP'S FIRST ADMINISTRATOR. The template had no screen for it: on a real
// build the builder had to write one into this page. `GET /Bootstrap/` says whether the
// seat is open and how it is taken, and this card says the same to the person looking. PLACEHOLDER wording.
// In mode 'owner' there is nothing to fill in — the owner takes the seat by signing
// in with the forms below, which is the proof of their address — so the card only explains. In mode
// 'claim' (an app that names no owner) it is the first-come form Bootstrap
// always had. The preview copy refuses `GET /Bootstrap/`, so there the card never draws.
const OWNER_SETUP = 'This app has no administrator yet. Its owner becomes the administrator the first time they sign in here with their own email address.'
const OWNER_SETUP_SIGNED_IN = 'If you are the owner and are signed in already, sign out and sign in again with your email address.'
const OWNER_SETUP_NO_WAY_IN = 'Sign-in email is not set up yet, so the owner cannot sign in until it is.'
const MIN_PASSWORD = 10

function SetupCard({ setup, signedIn, canSignIn }: { setup: Partial<BootstrapState> | null; signedIn: boolean; canSignIn: boolean }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (setup?.needed !== true) return null

  if (setup.mode === 'owner') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Set up this app</CardTitle>
          <CardDescription>{OWNER_SETUP}</CardDescription>
        </CardHeader>
        {(signedIn || !canSignIn) && (
          <CardContent className="space-y-2 text-sm">
            {signedIn && <p>{OWNER_SETUP_SIGNED_IN}</p>}
            {!canSignIn && <p>{OWNER_SETUP_NO_WAY_IN}</p>}
          </CardContent>
        )}
      </Card>
    )
  }
  if (setup.mode !== 'claim' || signedIn) return null

  async function claim(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('Bootstrap/', { name, email, password })
      location.replace(go('/admin'))
    } catch (err) {
      setError(errorText(err, 'Could not set up the administrator'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set up this app</CardTitle>
        <CardDescription>This app has no accounts yet. The first person to fill this in becomes its administrator and signs in with this password.</CardDescription>
      </CardHeader>
      <CardContent>
        {error && <Alert variant="destructive" className="mb-3">{error}</Alert>}
        <form onSubmit={claim} className="space-y-3">
          <Input required autoComplete="name" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input type="email" required autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input type="password" required minLength={MIN_PASSWORD} autoComplete="new-password" placeholder={`Password, at least ${MIN_PASSWORD} characters`} value={password} onChange={(e) => setPassword(e.target.value)} />
          <Button type="submit" className="w-full" disabled={busy}>Become the administrator</Button>
        </form>
      </CardContent>
    </Card>
  )
}

/** Only a site-relative path is a post-login destination — the same rule AuthApi applies. */
function safeNext(raw: string | null): string {
  return raw && /^\/(?!\/)[^\s]*$/.test(raw) ? raw : '/'
}

/**
 * Sign in by email link (everyone), Google (when configured), or password (admins only —
 * lib/auth.js gives nobody else one). A signed-in visitor sees who they are rather than a
 * redirect, so the page always renders something (rule 14).
 */
export default function Login({ me }: { me: Me }) {
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const linkError = LINK_ERRORS[params.get('error') ?? ''] ?? null

  const [config, setConfig] = useState<Partial<AuthConfig> | null>(null)
  const [setup, setSetup] = useState<Partial<BootstrapState> | null>(null)
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adminOpen, setAdminOpen] = useState(false)
  const [pwEmail, setPwEmail] = useState('')
  const [password, setPassword] = useState('')
  const googleRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let alive = true
    api.get<Partial<AuthConfig>>('AuthApi/config')
      .then((c) => { if (alive) setConfig(c && typeof c === 'object' ? c : {}) })
      .catch(() => { if (alive) setConfig({}) })
    // Whether the administrator's seat is open, and how it is taken (SetupCard). A refusal — the
    // preview copy answers 403 here — is "nothing to set up", never an error on the page.
    api.get<Partial<BootstrapState>>('Bootstrap/')
      .then((b) => { if (alive) setSetup(b && typeof b === 'object' ? b : null) })
      .catch(() => { if (alive) setSetup(null) })
    return () => { alive = false }
  }, [])

  // Render Google's button once the script is present. Nothing runs without a client id.
  useEffect(() => {
    const clientId = config?.googleClientId
    if (!clientId || !googleRef.current) return
    let cancelled = false
    const mount = () => {
      if (cancelled || !window.google || !googleRef.current) return
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async ({ credential }) => {
          try {
            await api.post('AuthApi/google', { credential })
            location.replace(go(next))
          } catch (err) {
            setError(errorText(err, 'Google sign-in failed'))
          }
        },
      })
      window.google.accounts.id.renderButton(googleRef.current, { theme: 'outline', size: 'large', width: 300 })
    }
    if (window.google) mount()
    else {
      let script = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`)
      if (!script) {
        script = document.createElement('script')
        script.src = GSI_SRC
        script.async = true
        document.head.appendChild(script)
      }
      script.addEventListener('load', mount)
    }
    return () => { cancelled = true }
  }, [config?.googleClientId, next])

  async function requestLink(e?: FormEvent) {
    e?.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('AuthApi/request-link', { email })
      setSent(true)
    } catch (err) {
      setError(isApiError(err) && err.code === 'email_not_configured' ? NO_EMAIL : errorText(err, 'Could not send the link'))
    } finally {
      setBusy(false)
    }
  }

  async function signInWithPassword(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('AuthApi/password', { email: pwEmail, password })
      location.replace(go(next))
    } catch (err) {
      setError(isApiError(err) && err.status === 403 ? 'Invalid email or password.' : errorText(err, 'Sign-in failed'))
    } finally {
      setBusy(false)
    }
  }

  const appName = config?.appName || 'this app'
  const ttl = config?.magicLinkTtlMinutes ?? 15
  // Can anybody sign in here other than by an admin's password? The owner's way in is a link or Google.
  const canSignIn = config?.emailSignIn !== false || Boolean(config?.googleClientId)

  if (me.authenticated) {
    return (
      <AuthFrame title="You are signed in" description={`as ${me.user.email}`}>
        <div className="flex justify-center gap-2">
          <Button asChild><Link to={next}>Continue</Link></Button>
          <Button asChild variant="outline"><Link to="/account">Your account</Link></Button>
        </div>
        <SetupCard setup={setup} signedIn canSignIn={canSignIn} />
      </AuthFrame>
    )
  }

  if (sent) {
    return (
      <AuthFrame title="Check your email" description={`If that address has an account, a sign-in link is on its way. It works once and expires in ${ttl} minutes.`}>
        {error && <Alert variant="destructive">{error}</Alert>}
        <div className="space-y-3 rounded-xl border bg-card p-5">
          <p className="text-sm text-muted-foreground">Nothing after a few minutes? Check spam, or ask again.</p>
          <Button variant="outline" className="w-full" disabled={busy} onClick={() => requestLink()}>Send another link</Button>
        </div>
        <div className="text-center">
          <Button variant="link" size="sm" className="text-muted-foreground" onClick={() => setSent(false)}>Use a different email</Button>
        </div>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame
      title="Sign in"
      description={config?.emailSignIn === false ? undefined : config?.openSignup === false ? `Only invited addresses can sign in to ${appName}.` : "We'll email you a link. No password needed."}
    >
      {linkError && <Alert variant="destructive">{linkError}</Alert>}
      {error && <Alert variant="destructive">{error}</Alert>}
      <SetupCard setup={setup} signedIn={false} canSignIn={canSignIn} />
      <div className="space-y-4 rounded-xl border bg-card p-5">
        {config?.emailSignIn === false ? (
          <p className="text-sm">{NO_EMAIL}</p>
        ) : (
          <form onSubmit={requestLink} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="signin-email">Email</Label>
              <Input id="signin-email" type="email" required autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>Email me a link</Button>
          </form>
        )}
        {config?.googleClientId && (
          <>
            <div className="flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>
            <div ref={googleRef} className="flex justify-center" />
          </>
        )}
      </div>
      <div className="text-center">
        {/* The platform's QA finds these by this exact text and these autocomplete values. */}
        <Button variant="link" size="sm" className="text-muted-foreground" onClick={() => setAdminOpen((v) => !v)}>
          {adminOpen ? 'Hide admin sign-in' : 'Admin? Sign in with a password'}
        </Button>
        {adminOpen && (
          <form onSubmit={signInWithPassword} className="mt-2 space-y-3 rounded-xl border bg-card p-5 text-left">
            <Input type="email" required aria-label="Email" autoComplete="username" placeholder="Email" value={pwEmail} onChange={(e) => setPwEmail(e.target.value)} />
            <Input type="password" required aria-label="Password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <Button type="submit" className="w-full" disabled={busy}>Sign in</Button>
          </form>
        )}
      </div>
    </AuthFrame>
  )
}
