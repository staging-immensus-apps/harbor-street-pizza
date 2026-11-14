import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api, go } from '@/api/client'
import type { Me } from '@/api/sign-in'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Shell } from '@/components/shell'
import { listMyOrders } from '@/api/customer-orders'
import { money, shortDate, lineTotal, errorText } from '@/lib/format'
import type { CustomerOrderRow } from '@/api/types'

/** Plain-language phrase for the raw status enum — the same small mapping OrderConfirmation.tsx
 * keeps for itself; not worth sharing for two short switches. */
function statusPhrase (status: string | null): string {
  switch (status) {
    case 'awaiting_payment': return 'Awaiting payment'
    case 'received': return 'Received'
    case 'preparing': return 'Being prepared'
    case 'ready': return 'Ready'
    case 'collected': return 'Collected'
    case 'cancelled': return 'Cancelled'
    default: return 'Unknown'
  }
}

function statusVariant (status: string | null): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'cancelled') return 'destructive'
  if (status === 'ready' || status === 'collected') return 'default'
  return 'secondary'
}

/**
 * /my-orders (CLAUDE.md §10, api-plan.json CustomerOrderApi): a signed-in customer's own orders,
 * a password form and account deletion. Everything here is the caller's own data — no id ever
 * passed to any endpoint, the session alone decides whose orders, whose password, whose account.
 */
export default function MyOrders ({ me }: { me: Me }) {
  const [orders, setOrders] = useState<CustomerOrderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwNotice, setPwNotice] = useState<string | null>(null)
  const [pwError, setPwError] = useState<string | null>(null)

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    if (!me.authenticated) return
    let alive = true
    listMyOrders()
      .then((r) => { if (alive) setOrders(Array.isArray(r?.orders) ? r.orders : []) })
      .catch((err) => { if (alive) setLoadError(errorText(err, 'Could not load your orders')) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [me.authenticated])

  async function changePassword (e: FormEvent) {
    e.preventDefault()
    setPwBusy(true)
    setPwError(null)
    setPwNotice(null)
    try {
      await api.put('AccountApi/password', { currentPassword, newPassword })
      setPwNotice('Saved.')
      setCurrentPassword('')
      setNewPassword('')
    } catch (err) {
      setPwError(errorText(err, 'Could not change your password'))
    } finally {
      setPwBusy(false)
    }
  }

  async function confirmDeleteAccount () {
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await api.delete('AccountApi')
      location.replace(go('/'))
    } catch (err) {
      setDeleteError(errorText(err, 'Could not delete your account'))
      setDeleteBusy(false)
    }
  }

  if (!me.authenticated) {
    return (
      <Shell title="Your orders">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Sign in to see your orders</CardTitle>
            <CardDescription>Past orders placed while signed in show up here.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link to="/sign-in?next=/my-orders">Sign in</Link>
            </Button>
          </CardContent>
        </Card>
      </Shell>
    )
  }

  return (
    <Shell title="Your orders">
      <div className="max-w-2xl space-y-8">
        <div className="space-y-4">
          {loadError && <Alert variant="destructive">{loadError}</Alert>}
          {loading && <p className="text-muted-foreground">Loading…</p>}
          {!loading && !loadError && orders.length === 0 && (
            <Card>
              <CardContent className="pt-6 text-sm text-muted-foreground">
                You don&apos;t have any orders on this account yet. Orders you placed as a guest,
                before you signed up, won&apos;t appear here.
              </CardContent>
            </Card>
          )}
          {orders.map((order) => {
            const items = Array.isArray(order.items) ? order.items : []
            return (
              <Card key={order.code}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <Link to={`/order/${order.code}`} className="font-medium hover:underline">
                        Order {order.code}
                      </Link>
                      <p className="text-xs text-muted-foreground">{shortDate(order.placedAt)}</p>
                    </div>
                    <Badge variant={statusVariant(order.status)}>{statusPhrase(order.status)}</Badge>
                  </div>
                  <div className="space-y-1">
                    {items.map((line, i) => (
                      <div key={`${line.menuItemId}-${i}`} className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate">{line.quantity} × {line.name}</span>
                        <span className="shrink-0">{money(lineTotal(line))}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between border-t pt-2 font-semibold">
                    <span>Total</span>
                    <span>{money(order.totalCents)}</span>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Set a new password</CardTitle>
            <CardDescription>
              Leave the current password blank if you&apos;ve never set one — for example if you&apos;ve only ever signed in by email link.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={changePassword} className="space-y-4">
              {pwError && <Alert variant="destructive">{pwError}</Alert>}
              <div className="space-y-2">
                <Label htmlFor="my-orders-current-password">Current password (leave blank if you don&apos;t have one yet)</Label>
                <Input
                  id="my-orders-current-password"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="my-orders-new-password">New password</Label>
                <Input
                  id="my-orders-new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div className="flex items-center gap-3">
                <Button type="submit" disabled={pwBusy || !newPassword}>Save password</Button>
                {pwNotice && <span className="text-sm text-muted-foreground">{pwNotice}</span>}
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Delete my account</CardTitle>
            <CardDescription>Your orders stay in the shop&apos;s records with no account attached.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {deleteError && <Alert variant="destructive">{deleteError}</Alert>}
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>Delete my account</Button>
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete your account?"
        description="Your orders stay in the shop's records with no account attached. This can't be undone."
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleteBusy}>Keep my account</Button>
          <Button variant="destructive" onClick={confirmDeleteAccount} disabled={deleteBusy}>Delete my account</Button>
        </div>
      </Dialog>
    </Shell>
  )
}
