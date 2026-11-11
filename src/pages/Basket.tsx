import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '@/components/shell'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import { getStoreInfo } from '@/api/store-info'
import { quoteCart } from '@/api/checkout'
import { useBasket, setBasketQuantity, removeFromBasket, basketCount, basketTotalCents } from '@/lib/basket'
import { money, errorText } from '@/lib/format'
import type { StoreInfo } from '@/api/types'

/**
 * Basket (CLAUDE.md §10 `/basket`): review quantities, remove a line, see the running total. Public —
 * no sign-in, guest checkout only. The basket itself lives in localStorage (src/lib/basket.ts); this
 * page re-quotes it against the server on every change so the total shown is the server's authoritative
 * price (and so an item that went off the menu is caught before checkout).
 */
export default function Basket () {
  const lines = useBasket()
  const [store, setStore] = useState<StoreInfo | null>(null)
  const [quoteTotal, setQuoteTotal] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getStoreInfo()
      .then((r) => { if (!cancelled) setStore(r?.store ?? null) })
      .catch(() => { /* store info is advisory here; checkout re-checks regardless */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (lines.length === 0) {
      setQuoteTotal(null)
      setError(null)
      return
    }
    let cancelled = false
    quoteCart({
      lines: lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity })),
      fulfilment: 'pickup',
    })
      .then((q) => {
        if (cancelled) return
        setQuoteTotal(q?.itemsTotalCents ?? null)
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setQuoteTotal(null)
        setError(errorText(err, 'Could not price the basket'))
      })
    return () => { cancelled = true }
  }, [lines])

  const accepting = store?.acceptingOrders ?? true
  const count = basketCount(lines)
  const localTotal = basketTotalCents(lines)
  const total = quoteTotal ?? localTotal

  return (
    <Shell title="Your basket">
      {lines.length === 0 ? (
        <div className="space-y-4">
          <p className="text-muted-foreground">Your basket is empty.</p>
          <Button asChild>
            <Link to="/">Back to the menu</Link>
          </Button>
        </div>
      ) : (
        <div className="space-y-6 pb-24">
          {!loading && !accepting && (
            <Alert variant="destructive">
              {store?.pausedMessage || 'Online ordering is paused right now — check back soon.'}
            </Alert>
          )}

          {error && <Alert variant="destructive">{error}</Alert>}

          <div className="space-y-3">
            {lines.map((line) => (
              <Card key={line.menuItemId}>
                <CardContent className="flex items-center gap-4 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{line.name}</div>
                    <div className="mt-1 text-sm text-muted-foreground">{money(line.priceCents)} each</div>
                    <div className="mt-1 text-sm font-medium">{money(line.priceCents * line.quantity)}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={`Remove one ${line.name}`}
                      onClick={() => setBasketQuantity(line.menuItemId, line.quantity - 1)}
                    >
                      −
                    </Button>
                    <span className="w-5 text-center tabular-nums">{line.quantity}</span>
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={`Add one more ${line.name}`}
                      onClick={() => setBasketQuantity(line.menuItemId, line.quantity + 1)}
                    >
                      +
                    </Button>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    aria-label={`Remove ${line.name} from basket`}
                    onClick={() => removeFromBasket(line.menuItemId)}
                  >
                    Remove
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardContent className="flex items-center justify-between p-4">
              <span className="text-muted-foreground">{count} {count === 1 ? 'item' : 'items'}</span>
              <span className="text-lg font-semibold">{money(total)}</span>
            </CardContent>
          </Card>

          <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background p-4">
            <div className="container">
              {accepting && !error ? (
                <Button asChild size="lg" className="w-full">
                  <Link to="/checkout">Checkout · {money(total)}</Link>
                </Button>
              ) : (
                <Button size="lg" className="w-full" disabled>
                  {accepting ? 'Fix the basket to continue' : 'Ordering is paused'}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </Shell>
  )
}
