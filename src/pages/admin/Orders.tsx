import { useEffect, useState } from 'react'
import { Shell } from '@/components/shell'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'
import { Dialog } from '@/components/ui/dialog'
import { listOrders, setOrderStatus, ordersStreamUrl } from '@/api/order-admin'
import { money, lineTotal, shortDate, errorText } from '@/lib/format'
import type { AdminOrder, OrderStatus } from '@/api/types'

const STATUS_LABEL: Record<string, string> = {
  awaiting_payment: 'Awaiting payment',
  received: 'Received',
  preparing: 'Preparing',
  ready: 'Ready',
  collected: 'Collected',
  cancelled: 'Cancelled',
}

const NEXT_LABEL: Partial<Record<OrderStatus, string>> = {
  preparing: 'Mark preparing',
  ready: 'Mark ready',
  collected: 'Mark collected',
}

/** Merge one order into the queue: drop it once it has left the active queue (collected/cancelled),
 * update it in place if already shown, or prepend it when it is new — keeping newest-first, the
 * order the server already answers in. */
function mergeOrder (list: AdminOrder[], order: AdminOrder): AdminOrder[] {
  if (order.queue !== 'active') return list.filter((o) => o.id !== order.id)
  const idx = list.findIndex((o) => o.id === order.id)
  if (idx === -1) return [order, ...list]
  const next = list.slice()
  next[idx] = order
  return next
}

/**
 * The owner's live order queue (CLAUDE.md §10 `/manage/orders`). An SSE stream (OrderAdminApi with
 * Accept: text/event-stream) is an accelerator only — any message just triggers a re-read of the
 * list, never a parse of its own payload — and an unconditional 15-second poll is the floor the
 * `view-new-orders` story depends on, running from mount whether or not the stream stays open or
 * exists at all (`EventSource` is absent under the page-boot probe's jsdom). `admin: true` in
 * src/routes.ts already gates this page; it never checks role itself.
 */
export default function Orders () {
  const [orders, setOrders] = useState<AdminOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [cancelTarget, setCancelTarget] = useState<AdminOrder | null>(null)

  useEffect(() => {
    let cancelled = false
    listOrders('active')
      .then((r) => { if (!cancelled) setOrders(r?.orders ?? []) })
      .catch((err) => { if (!cancelled) setError(errorText(err, 'Could not load the queue')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let es: EventSource | null = null
    let pollId: ReturnType<typeof setInterval> | null = null
    let stopped = false
    let refreshing = false

    // The stream is an ACCELERATOR, never a data source: Harper's subscription envelope is not an
    // adminOrderView (no id, no queue), so a message only ever tells us to re-read the authoritative
    // list — never parsed itself. The 15s poll is the floor the story depends on and runs
    // unconditionally from mount, whether or not the stream stays open: a stream that merely delivers
    // payloads we cannot use (no onerror ever fires) must not leave the queue un-refreshed forever.
    function refresh () {
      if (stopped || refreshing) return
      refreshing = true
      listOrders('active')
        .then((r) => { if (!stopped) setOrders(r?.orders ?? []) })
        .catch(() => { /* a dropped refresh just waits for the next tick or message */ })
        .finally(() => { refreshing = false })
    }

    pollId = setInterval(refresh, 15000)

    if (typeof EventSource !== 'undefined') {
      es = new EventSource(ordersStreamUrl('active'), { withCredentials: true })
      es.onmessage = () => { refresh() }
      es.onerror = () => {
        es?.close()
        es = null
      }
    }

    return () => {
      stopped = true
      es?.close()
      if (pollId) clearInterval(pollId)
    }
  }, [])

  async function advance (order: AdminOrder) {
    if (!order.nextStatus) return
    setActionError(null)
    setBusyId(order.id)
    try {
      const r = await setOrderStatus(order.id, order.nextStatus)
      setOrders((prev) => mergeOrder(prev, r.order))
    } catch (err) {
      setActionError(errorText(err, 'Could not update that order'))
    } finally {
      setBusyId(null)
    }
  }

  async function confirmCancel () {
    const order = cancelTarget
    if (!order) return
    setCancelTarget(null)
    setActionError(null)
    setBusyId(order.id)
    try {
      const r = await setOrderStatus(order.id, 'cancelled')
      setOrders((prev) => mergeOrder(prev, r.order))
    } catch (err) {
      setActionError(errorText(err, 'Could not cancel that order'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Shell title="Orders" description="The live queue — new orders arrive on their own.">
      {error && <Alert variant="destructive">{error}</Alert>}
      {actionError && <Alert variant="destructive">{actionError}</Alert>}

      {loading && <p className="text-muted-foreground">Loading…</p>}
      {!loading && orders.length === 0 && !error && (
        <p className="text-muted-foreground">Nothing in the queue right now.</p>
      )}

      <div className="space-y-4">
        {orders.map((order) => (
          <Card key={order.id}>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium">#{order.code.slice(0, 8)}</div>
                  <div className="text-xs text-muted-foreground">{shortDate(order.placedAt)}</div>
                </div>
                <Badge variant="outline">{STATUS_LABEL[order.status ?? ''] ?? order.status ?? '—'}</Badge>
              </div>

              <ul className="space-y-0.5 text-sm">
                {order.items.map((line, i) => (
                  <li key={i} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">{line.name} × {line.quantity}</span>
                    <span className="shrink-0 text-muted-foreground">{money(lineTotal(line))}</span>
                  </li>
                ))}
              </ul>

              <div className="space-y-0.5 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {order.fulfilment === 'delivery' ? 'Delivery' : 'Pickup'}
                  </span>
                  <span className="font-medium">{money(order.totalCents)}</span>
                </div>
                {order.fulfilment === 'delivery' && order.deliveryAddress && (
                  <div className="break-words text-muted-foreground">{order.deliveryAddress}</div>
                )}
                <div className="text-muted-foreground">
                  {order.customerName} · {order.customerPhone}
                </div>
                <div className="text-muted-foreground">
                  Payment: {order.paymentStatus === 'paid' ? 'Paid' : order.paymentStatus === 'pay_at_store' ? 'Pay at store' : 'Unpaid'}
                </div>
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                {order.nextStatus && (
                  <Button
                    className="flex-1"
                    disabled={busyId === order.id}
                    onClick={() => advance(order)}
                  >
                    {NEXT_LABEL[order.nextStatus] ?? `Mark ${order.nextStatus}`}
                  </Button>
                )}
                <Button
                  variant="destructive"
                  disabled={busyId === order.id}
                  onClick={() => setCancelTarget(order)}
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog
        open={!!cancelTarget}
        onClose={() => setCancelTarget(null)}
        title="Cancel this order?"
        description={cancelTarget ? `Order #${cancelTarget.code.slice(0, 8)} will be marked cancelled. This can't be undone.` : undefined}
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setCancelTarget(null)}>Keep order</Button>
          <Button variant="destructive" onClick={confirmCancel}>Cancel order</Button>
        </div>
      </Dialog>
    </Shell>
  )
}
