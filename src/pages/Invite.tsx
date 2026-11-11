import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, go } from '@/api/client'
import type { Me, AuthConfig } from '@/api/sign-in'
import { AuthFrame } from '@/components/sign-in'
import { Button } from '@/components/ui/button'

/**
 * /invite?token=… — where AdminApi/users/invite's email lands. Accepting is a click for the
 * same reason as /auth/verify: the token is single-use and a prefetch must not redeem it.
 * The invite link is a magic link with purpose 'invite'; AuthApi/verify redeems it and lands
 * on the account page.
 */
export default function Invite({ me }: { me: Me }) {
  const [params] = useSearchParams()
  const token = params.get('token')
  const [config, setConfig] = useState<Partial<AuthConfig> | null>(null)

  useEffect(() => {
    let alive = true
    api.get<Partial<AuthConfig>>('AuthApi/config')
      .then((c) => { if (alive) setConfig(c && typeof c === 'object' ? c : {}) })
      .catch(() => { if (alive) setConfig({}) })
    return () => { alive = false }
  }, [])

  const appName = config?.appName || 'this app'
  const href = token ? go(`/AuthApi/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent('/account?welcome=1')}`) : null

  return (
    <AuthFrame
      title={href ? `You're invited to ${appName}` : 'No invitation link'}
      description={href
        ? (me.authenticated
          ? `You are signed in as ${me.user.email}. Accepting signs you in as the invited account instead.`
          : 'Accept to create your account and sign in. The link works once.')
        : 'This page needs the link from your invitation email.'}
    >
      {href ? (
        <Button asChild className="w-full"><a href={href}>Accept invitation</a></Button>
      ) : (
        <Button asChild variant="outline" className="w-full"><Link to="/login">Sign in</Link></Button>
      )}
    </AuthFrame>
  )
}
