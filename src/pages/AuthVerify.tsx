import { Link, useSearchParams } from 'react-router-dom'
import { go } from '@/api/client'
import { AuthFrame } from '@/components/sign-in'
import { Button } from '@/components/ui/button'

function safeNext(raw: string | null): string {
  return raw && /^\/(?!\/)[^\s]*$/.test(raw) ? raw : '/'
}

/**
 * /auth/verify?token=…&next=… — where a sign-in link can land before it is redeemed. The
 * token is single-use and AuthApi/verify burns it on presentation, so the redemption is a
 * click, not a page load: a mail client that prefetches links would otherwise sign nobody
 * in and invalidate the link. The click is a full navigation to the resource, which sets the
 * cookie on its 302.
 */
export default function AuthVerify() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const next = safeNext(params.get('next'))
  const href = token ? go(`/AuthApi/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`) : null

  return (
    <AuthFrame
      title={href ? 'Confirm sign-in' : 'No sign-in link'}
      description={href ? 'Press the button to finish signing in. The link works once.' : 'This page needs the link from your email.'}
    >
      {href ? (
        <Button asChild className="w-full"><a href={href}>Continue</a></Button>
      ) : (
        <Button asChild className="w-full"><Link to="/login">Request a new link</Link></Button>
      )}
    </AuthFrame>
  )
}
