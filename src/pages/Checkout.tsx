import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Shell } from '@/components/shell'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert } from '@/components/ui/alert'
import { go } from '@/api/client'
import { getStoreInfo } from '@/api/store-info'
import { quoteCart, placeOrder } from '@/api/checkout'
import { useBasket, clearBasket } from '@/lib/basket'
import { money, errorText, minutesEstimate } from '@/lib/format'
import type { StoreInfo, Fulfilment, QuoteResponse } from '@/api/types'

/**
 * Checkout (CLAUDE.md §10 `/checkout`): pickup or delivery, the details that choice needs, the
 * live-priced total, then place the order. Public — guest checkout only, no accounts (§1). The
 * cart is never trusted on the server (CheckoutApi re-prices from MenuItem every time), so this
 * page re-quotes on every change purely to show the customer the number before they commit.
 */
export default function Checkout () {
  const lines = useBasket()
  const navigate = useNavigate()

  const [store, setStore] = useState<StoreInfo | null>(null)
  const [fulfilment, setFulfilment] = useState<Fulfilment>('pickup')
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [deliveryPostcode, setDeliveryPostcode] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')

  const [quote, setQuote] = useState<QuoteResponse | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    getStoreInfo()
      .then((r) => {
        if (cancelled) return
        const s = r?.store ?? null
        setStore(s)
        // If the fulfilment this page defaulted to turns out to be off, switch to the one that isn't.
        if (s && !s.pickupEnabled && s.deliveryEnabled) setFulfilment('delivery')
      })
      .catch(() => { /* checkout still re-checks server-side; this is advisory */ })
    return () => { cancelled = true }
  }, [])

  const cartLines = useMemo(
    () => lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity })),
    [lines],
  )

  useEffect(() => {
    if (cartLines.length === 0) return
    let cancelled = false
    quoteCart({
      lines: cartLines,
      fulfilment,
      deliveryPostcode: fulfilment === 'delivery' ? deliveryPostcode : undefined,
    })
      .then((q) => {
        if (cancelled) return
        setQuote(q)
        setQuoteError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setQuote(null)
        setQuoteError(errorText(err, 'Could not price the order'))
      })
    return () => { cancelled = true }
  }, [cartLines, fulfilment, deliveryPostcode])

  if (lines.length === 0) {
    return (
      <Shell title="Checkout">
        <div className="space-y-4">
          <p className="text-muted-foreground">Your basket is empty, so there is nothing to check out.</p>
          <Button asChild>
            <Link to="/">Back to the menu</Link>
          </Button>
        </div>
      </Shell>
    )
  }

  const pickupEnabled = store?.pickupEnabled ?? true
  const deliveryEnabled = store?.deliveryEnabled ?? true
  const notCovered = fulfilment === 'delivery' && deliveryPostcode.trim() !== '' && quote?.postcodeCovered === false
  const canSubmit =
    customerName.trim() !== '' &&
    customerPhone.trim() !== '' &&
    (fulfilment === 'pickup' || (deliveryAddress.trim() !== '' && deliveryPostcode.trim() !== '' && quote?.postcodeCovered)) &&
    !!quote &&
    quote.acceptingOrders &&
    !submitting

  async function handleSubmit () {
    setSubmitError(null)
    setSubmitting(true)
    try {
      const res = await placeOrder({
        lines: cartLines,
        fulfilment,
        deliveryPostcode: fulfilment === 'delivery' ? deliveryPostcode : undefined,
        customerName,
        customerPhone,
        deliveryAddress: fulfilment === 'delivery' ? deliveryAddress : undefined,
      })
      clearBasket()
      if (res.paymentUrl) {
        // Through go() like every other hard navigation (rule 30). Stripe's Checkout URL is
        // absolute and go() returns an off-origin URL untouched, so this costs the payment path
        // nothing — and on the day this value is ever site-relative, the preview copy keeps the
        // person in the preview instead of handing them to the published app.
        location.href = go(res.paymentUrl)
      } else {
        navigate(`/order/${res.order.code}`)
      }
    } catch (err) {
      setSubmitError(errorText(err, 'Could not place the order'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Shell title="Checkout">
      <div className="space-y-6 pb-24">
        {quote && !quote.acceptingOrders && (
          <Alert variant="destructive">
            {quote.pausedMessage || 'Online ordering is paused right now — check back soon.'}
          </Alert>
        )}

        <Card>
          <CardContent className="space-y-3 p-4">
            <Label>Pickup or delivery</Label>
            <div className="grid grid-cols-2 gap-3">
              <Button
                type="button"
                variant={fulfilment === 'pickup' ? 'default' : 'outline'}
                disabled={!pickupEnabled}
                onClick={() => setFulfilment('pickup')}
              >
                Pickup
              </Button>
              <Button
                type="button"
                variant={fulfilment === 'delivery' ? 'default' : 'outline'}
                disabled={!deliveryEnabled}
                onClick={() => setFulfilment('delivery')}
              >
                Delivery
              </Button>
            </div>
            {!pickupEnabled && <p className="text-xs text-muted-foreground">Pickup is not available right now.</p>}
            {!deliveryEnabled && <p className="text-xs text-muted-foreground">Delivery is not available right now.</p>}
          </CardContent>
        </Card>

        {fulfilment === 'delivery' && (
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="space-y-1">
                <Label htmlFor="deliveryAddress">Delivery address</Label>
                <Input
                  id="deliveryAddress"
                  value={deliveryAddress}
                  onChange={(e) => setDeliveryAddress(e.target.value)}
                  placeholder="Street and house number"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="deliveryPostcode">Postcode</Label>
                <Input
                  id="deliveryPostcode"
                  value={deliveryPostcode}
                  onChange={(e) => setDeliveryPostcode(e.target.value)}
                  placeholder="e.g. SW1A 1AA"
                />
              </div>
              {notCovered && (
                <Alert variant="destructive" className="space-y-2">
                  <p>We don't deliver to that postcode.</p>
                  <Button type="button" size="sm" variant="outline" onClick={() => setFulfilment('pickup')}>
                    Switch to pickup instead
                  </Button>
                </Alert>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="space-y-1">
              <Label htmlFor="customerName">Name</Label>
              <Input
                id="customerName"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Your name"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="customerPhone">Phone</Label>
              <Input
                id="customerPhone"
                type="tel"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                placeholder="Your phone number"
              />
            </div>
          </CardContent>
        </Card>

        {quoteError && <Alert variant="destructive">{quoteError}</Alert>}
        {submitError && <Alert variant="destructive">{submitError}</Alert>}

        {quote && (
          <Card>
            <CardContent className="space-y-2 p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Items</span>
                <span>{money(quote.itemsTotalCents)}</span>
              </div>
              {fulfilment === 'delivery' && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Delivery fee</span>
                  <span>{money(quote.deliveryFeeCents)}</span>
                </div>
              )}
              <div className="flex items-center justify-between font-semibold">
                <span>Total</span>
                <span>{money(quote.totalCents)}</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Ready estimate: {minutesEstimate(quote.estimateMinutes)}
              </p>
            </CardContent>
          </Card>
        )}

        <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background p-4">
          <div className="container">
            <Button size="lg" className="w-full" disabled={!canSubmit} onClick={handleSubmit}>
              {submitting ? 'Placing order…' : quote ? `Place order · ${money(quote.totalCents)}` : 'Place order'}
            </Button>
          </div>
        </div>
      </div>
    </Shell>
  )
}
