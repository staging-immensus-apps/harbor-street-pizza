import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Shell } from '@/components/shell'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { getOrderByCode } from '@/api/order-confirmation'
import { money, shortDate, readyTime, lineTotal, errorText } from '@/lib/format'
import type { OrderConfirmationView } from '@/api/types'

const POLL_MS = 15000

/** Plain-language phrase for the raw status enum (CLAUDE.md §10 `/order/:code`). */
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

/** Plain-language phrase for the raw paymentStatus enum. */
function paymentPhrase (paymentStatus: string | null): string {
  switch (paymentStatus) {
    case 'paid': return 'Paid'
    case 'pay_at_store': return 'Pay at store'
    case 'unpaid': return 'Unpaid'
    case 'awaiting_payment': return 'Awaiting payment'
    default: return 'Unknown'
  }
}

/** The code from the URL — this route is registered as the wildcard `/order/*` (rule 26), so it is
 * read off the path directly rather than from a react-router param. */
function codeFromPath (pathname: string): string {
  const raw = pathname.replace(/^\/order\/?/, '')
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * Order confirmation (CLAUDE.md §10 `/order/:code`): the one page a guest customer returns to —
 * no account, so the order's own random code is the only key. Polls every 15s so the status
 * updates as the kitchen moves it along, matching the admin queue's SSE-fallback cadence.
 */
export default function OrderConfirmation () {
  const location = useLocation()
  const code = codeFromPath(location.pathname)

  const [order, setOrder] = useState<OrderConfirmationView | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    setOrder(null)
    setNotFound(false)
    setError(null)
    setLoading(true)

    if (!code) {
      setNotFound(true)
      setLoading(false)
      return
    }

    let cancelled = false

    function load () {
      getOrderByCode(code)
        .then((r) => {
          if (cancelled) return
          setOrder(r?.order ?? null)
          setNotFound(false)
          setError(null)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          const apiErr = err as { status?: number }
          if (apiErr?.status === 404) {
            setNotFound(true)
          } else {
            setError(errorText(err, 'Could not load this order'))
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }

    load()
    pollRef.current = setInterval(load, POLL_MS)

    return () => {
      cancelled = true
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [code])

  if (notFound) {
    return (
      <Shell title="Order confirmation">
        <Alert variant="destructive">We can&apos;t find that order. Check the link and try again.</Alert>
        <Button asChild>
          <Link to="/">Back to the menu</Link>
        </Button>
      </Shell>
    )
  }

  if (!order) {
    return (
      <Shell title="Order confirmation">
        {error ? <Alert variant="destructive">{error}</Alert> : (
          <p className="text-muted-foreground">{loading ? 'Loading your order…' : 'Nothing to show.'}</p>
        )}
      </Shell>
    )
  }

  const items = Array.isArray(order.items) ? order.items : []
  const hasPersonalDetails = !order.personalDetailsCleared && (order.customerName || order.deliveryAddress || order.deliveryPostcode)

  return (
    <Shell title="Order confirmation" description={`Order ${order.code}`}>
      <div className="space-y-6">
        {error && <Alert variant="destructive">{error}</Alert>}

        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm text-muted-foreground">Status</p>
                <Badge variant={statusVariant(order.status)}>{statusPhrase(order.status)}</Badge>
              </div>
              <div className="text-right">
                <p className="text-sm text-muted-foreground">Payment</p>
                <Badge variant="outline">{paymentPhrase(order.paymentStatus)}</Badge>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-muted-foreground">Fulfilment</p>
                <p className="font-medium">{order.fulfilment === 'delivery' ? 'Delivery' : 'Pickup'}</p>
              </div>
              {order.readyEstimate && (
                <div>
                  <p className="text-muted-foreground">Estimated ready</p>
                  <p className="font-medium">{readyTime(order.readyEstimate)}</p>
                </div>
              )}
            </div>
            {order.placedAt && (
              <p className="text-xs text-muted-foreground">Placed {shortDate(order.placedAt)}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-4">
            <p className="text-sm font-medium">Items</p>
            <div className="space-y-2">
              {items.length === 0 && <p className="text-sm text-muted-foreground">No items on this order.</p>}
              {items.map((line, i) => (
                <div key={`${line.menuItemId}-${i}`} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">{line.quantity} × {line.name}</span>
                  <span className="shrink-0">{money(lineTotal(line))}</span>
                </div>
              ))}
            </div>
            <div className="space-y-1 border-t pt-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Items</span>
                <span>{money(order.itemsTotalCents)}</span>
              </div>
              {order.fulfilment === 'delivery' && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Delivery fee</span>
                  <span>{money(order.deliveryFeeCents)}</span>
                </div>
              )}
              <div className="flex items-center justify-between font-semibold">
                <span>Total</span>
                <span>{money(order.totalCents)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {hasPersonalDetails && (
          <Card>
            <CardContent className="space-y-2 p-4">
              <p className="text-sm font-medium">Delivery details</p>
              {order.customerName && <p className="text-sm">{order.customerName}</p>}
              {order.deliveryAddress && <p className="text-sm text-muted-foreground">{order.deliveryAddress}</p>}
              {order.deliveryPostcode && <p className="text-sm text-muted-foreground">{order.deliveryPostcode}</p>}
            </CardContent>
          </Card>
        )}

        <Button asChild variant="outline" className="w-full">
          <Link to="/">Back to the menu</Link>
        </Button>
      </div>
    </Shell>
  )
}
