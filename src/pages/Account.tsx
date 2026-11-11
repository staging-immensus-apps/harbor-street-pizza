import { useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, go } from '@/api/client'
import type { Me, AccountView, User } from '@/api/sign-in'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Shell } from '@/components/shell'
import { SignInPrompt } from '@/components/sign-in'
import { errorText } from '@/lib/format'

/** /account — profile and sign out. Reads and writes only the caller's own row. */
export default function Account({ me }: { me: Me }) {
  const [params] = useSearchParams()
  const welcome = params.get('welcome') === '1'
  const [view, setView] = useState<AccountView | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!me.authenticated) return
    let alive = true
    api.get<Partial<AccountView>>('AccountApi/')
      .then((r) => {
        if (!alive) return
        if (r && typeof r === 'object' && r.user) { setView(r as AccountView); setName(r.user.name ?? '') }
        else setError('Could not load your account')
      })
      .catch((err) => { if (alive) setError(errorText(err, 'Could not load your account')) })
    return () => { alive = false }
  }, [me.authenticated])

  async function save(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await api.put<{ ok: boolean; user: User }>('AccountApi/profile', { name })
      if (r?.user) setView({ user: r.user })
      setNotice('Saved.')
    } catch (err) {
      setError(errorText(err, 'Could not save'))
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    await api.post('AuthApi/logout')
    location.replace(go('/'))
  }

  if (!me.authenticated) return <Shell title="Your account"><SignInPrompt next="/account" /></Shell>

  return (
    <Shell title="Your account">
      <div className="max-w-md space-y-6">
        {welcome && <Alert>Welcome! Your account is ready. Add your name below if you like.</Alert>}
        {error && <Alert variant="destructive">{error}</Alert>}
        <Card>
          <CardContent className="pt-6">
            <form onSubmit={save} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="account-name">Name</Label>
                <Input id="account-name" value={name} maxLength={120} placeholder="Your name" onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <p className="break-words rounded-md bg-muted px-3 py-2 text-sm">{me.user.email}</p>
              </div>
              <div className="flex items-center gap-3">
                <Button type="submit" disabled={busy || !view}>Save</Button>
                {notice && <span className="text-sm text-muted-foreground">{notice}</span>}
              </div>
            </form>
          </CardContent>
        </Card>
        <Button variant="outline" onClick={signOut}>Sign out</Button>
      </div>
    </Shell>
  )
}
