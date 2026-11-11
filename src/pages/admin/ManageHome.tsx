import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '@/components/shell'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Alert } from '@/components/ui/alert'
import { listOrders } from '@/api/order-admin'
import { errorText } from '@/lib/format'
import type { Queue } from '@/api/types'

/**
 * The owner's hub (CLAUDE.md §10 `/manage`): how many orders are waiting right now, and a link to
 * each of the three management screens. `admin: true` in src/routes.ts already sends a non-admin
 * to sign in (the sign-in kit's Guard) — this page never checks role itself.
 */
export default function ManageHome () {
  const [counts, setCounts] = useState<Record<Queue, number>>({ pending_payment: 0, active: 0, done: 0 })
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    listOrders('active')
      .then((r) => {
        if (cancelled) return
        setCounts(r?.counts ?? { pending_payment: 0, active: 0, done: 0 })
      })
      .catch((err) => { if (!cancelled) setError(errorText(err, 'Could not load your orders')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const active = counts?.active ?? 0
  const pendingPayment = counts?.pending_payment ?? 0

  return (
    <Shell title="Your shop" description="A quick look at what's waiting, and the three screens you manage it from.">
      {error && <Alert variant="destructive">{error}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>
            {loading ? 'Loading…' : `${active} order${active === 1 ? '' : 's'} waiting`}
          </CardTitle>
          <CardDescription>
            {pendingPayment > 0
              ? `${pendingPayment} more ${pendingPayment === 1 ? 'is' : 'are'} awaiting payment and will join the queue once paid.`
              : 'Ready to cook or out for pickup and delivery.'}
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="space-y-3">
        <Link to="/manage/orders" className="block">
          <Card className="transition-colors hover:bg-accent">
            <CardContent className="p-4">
              <div className="font-medium">Orders</div>
              <p className="mt-0.5 text-sm text-muted-foreground">The live queue — new orders, and one tap to move them along.</p>
            </CardContent>
          </Card>
        </Link>

        <Link to="/manage/menu" className="block">
          <Card className="transition-colors hover:bg-accent">
            <CardContent className="p-4">
              <div className="font-medium">Menu editor</div>
              <p className="mt-0.5 text-sm text-muted-foreground">Add, edit, hide and remove items.</p>
            </CardContent>
          </Card>
        </Link>

        <Link to="/manage/settings" className="block">
          <Card className="transition-colors hover:bg-accent">
            <CardContent className="p-4">
              <div className="font-medium">Shop settings</div>
              <p className="mt-0.5 text-sm text-muted-foreground">Pause ordering, pickup and delivery, fees and estimates.</p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </Shell>
  )
}
