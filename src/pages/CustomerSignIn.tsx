import { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, go } from '@/api/client'
import type { Me, AuthConfig } from '@/api/sign-in'
import { AuthFrame } from '@/components/sign-in'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { errorText } from '@/lib/format'

/** Only a site-relative path is a post-sign-in destination — the same rule AuthApi applies. */
function safeNext(raw: string | null): string {
  return raw && /^\/(?!\/)[^\s]*$/.test(raw) ? raw : '/my-orders'
}

type Mode = 'create' | 'signin'

/**
 * The CUSTOMER's own door (CLAUDE.md §10 `/sign-in`), separate from the owner's `/login`: an
 * email-and-password account so a shopper can see their past orders, nothing more. Both pages call
 * the same AuthApi — `register` here always creates a `member`, never an admin, and `password`
 * covers anybody with a password hash, which is why "Admin? Sign in with a password" lives on
 * `/login` and not here. A signed-in visitor sees who they are rather than a redirect, so the page
 * always renders something (rule 14).
 */
export default function CustomerSignIn({ me }: { me: Me }) {
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))

  const [config, setConfig] = useState<Partial<AuthConfig> | null>(null)
  const [mode, setMode] = useState<Mode>('create')

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')

  const [forgotEmail, setForgotEmail] = useState('')
  const [sent, setSent] = useState(false)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.get<Partial<AuthConfig>>('AuthApi/config')
      .then((c) => { if (alive) setConfig(c && typeof c === 'object' ? c : {}) })
      .catch(() => { if (alive) setConfig({}) })
    return () => { alive = false }
  }, [])

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('AuthApi/register', { email, password, name: name.trim() || undefined })
      location.replace(go(next))
    } catch (err) {
      setError(errorText(err, 'Could not create your account'))
    } finally {
      setBusy(false)
    }
  }

  async function handleSignIn(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('AuthApi/password', { email, password })
      location.replace(go(next))
    } catch (err) {
      setError(errorText(err, 'Sign-in failed'))
    } finally {
      setBusy(false)
    }
  }

  async function requestLink() {
    setBusy(true)
    setError(null)
    try {
      await api.post('AuthApi/request-link', { email: forgotEmail, next: '/my-orders' })
      setSent(true)
    } catch (err) {
      setError(errorText(err, 'Could not send the link'))
    } finally {
      setBusy(false)
    }
  }

  const appName = config?.appName || 'this shop'
  const emailSignIn = config?.emailSignIn !== false

  if (me.authenticated) {
    return (
      <AuthFrame title="You are signed in" description={`as ${me.user.email}`}>
        <div className="flex justify-center">
          <Button asChild><Link to={next}>Continue</Link></Button>
        </div>
      </AuthFrame>
    )
  }

  if (sent) {
    return (
      <AuthFrame title="Check your email" description="If that address has an account, a sign-in link is on its way. It works once and expires soon, so use it from the device you opened this page on.">
        {error && <Alert variant="destructive">{error}</Alert>}
        <div className="space-y-3 rounded-xl border bg-card p-5">
          <p className="text-sm text-muted-foreground">Nothing after a few minutes? Check spam, or ask again.</p>
          <Button variant="outline" className="w-full" disabled={busy} onClick={() => requestLink()}>Send another link</Button>
        </div>
        <div className="text-center">
          <Button variant="link" size="sm" className="text-muted-foreground" onClick={() => setSent(false)}>Back to sign in</Button>
        </div>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame title="Sign in" description={`Create an account with ${appName} to see your past orders, or sign in to one you already have.`}>
      {error && <Alert variant="destructive">{error}</Alert>}

      <div className="grid grid-cols-2 gap-3">
        <Button type="button" variant={mode === 'create' ? 'default' : 'outline'} onClick={() => { setMode('create'); setError(null) }}>
          Create an account
        </Button>
        <Button type="button" variant={mode === 'signin' ? 'default' : 'outline'} onClick={() => { setMode('signin'); setError(null) }}>
          Sign in
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{mode === 'create' ? 'Create an account' : 'Sign in'}</CardTitle>
          <CardDescription>
            {mode === 'create' ? 'Email and a password — name is optional.' : 'Your email and password.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={mode === 'create' ? handleCreate : handleSignIn} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="customer-email">Email</Label>
              <Input id="customer-email" type="email" required autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {mode === 'create' && (
              <div className="space-y-2">
                <Label htmlFor="customer-name">Name (optional)</Label>
                <Input id="customer-name" autoComplete="name" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="customer-password">Password</Label>
              <Input
                id="customer-password"
                type="password"
                required
                autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
                placeholder={mode === 'create' ? 'At least 8 characters' : 'Password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {mode === 'create' ? 'Create account' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-2 rounded-xl border bg-card p-5">
        <Label htmlFor="forgot-email">Forgotten your password? Email me a link</Label>
        {emailSignIn ? (
          <div className="flex gap-2">
            <Input id="forgot-email" type="email" placeholder="you@example.com" value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} />
            <Button type="button" variant="outline" disabled={busy || !forgotEmail} onClick={requestLink}>Send link</Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">This app cannot send sign-in emails yet. Ask the shop to finish setting up email.</p>
        )}
      </div>
    </AuthFrame>
  )
}
