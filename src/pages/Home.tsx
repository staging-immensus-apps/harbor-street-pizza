import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '@/components/shell'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import { getMenu } from '@/api/menu'
import { getStoreInfo } from '@/api/store-info'
import { useBasket, addToBasket, setBasketQuantity, basketCount, basketTotalCents } from '@/lib/basket'
import { money, errorText } from '@/lib/format'
import type { MenuCategory, MenuItem, StoreInfo } from '@/api/types'

/**
 * The shop front (CLAUDE.md §10 `/`): the whole menu by category with a running basket. Public —
 * no sign-in, no admin gate. The entry route, so it has to survive the page-boot stub answering
 * `{}` to a GET with no fixture: every field is read with a fallback.
 */
export default function Home () {
  const [categories, setCategories] = useState<MenuCategory[]>([])
  const [store, setStore] = useState<StoreInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const lines = useBasket()

  useEffect(() => {
    let cancelled = false
    Promise.all([getMenu(), getStoreInfo()])
      .then(([menu, info]) => {
        if (cancelled) return
        setCategories(Array.isArray(menu?.categories) ? menu.categories : [])
        setStore(info?.store ?? null)
      })
      .catch((err) => { if (!cancelled) setError(errorText(err, 'Could not load the menu')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const accepting = store?.acceptingOrders ?? true
  const count = basketCount(lines)
  const total = basketTotalCents(lines)

  function quantityFor (item: MenuItem) {
    return lines.find((l) => l.menuItemId === item.id)?.quantity ?? 0
  }

  function increment (item: MenuItem) {
    addToBasket({ id: item.id, name: item.name, priceCents: item.priceCents }, 1)
  }

  function decrement (item: MenuItem) {
    const qty = quantityFor(item)
    if (qty > 0) setBasketQuantity(item.id, qty - 1)
  }

  return (
    <Shell title={store?.storeName || undefined}>
      <div className={count > 0 ? 'pb-20' : undefined}>
        {error && <Alert variant="destructive">{error}</Alert>}

        {!loading && !accepting && (
          <Alert variant="destructive" className="mb-4">
            {store?.pausedMessage || 'Online ordering is paused right now — check back soon.'}
          </Alert>
        )}

        {!loading && categories.length === 0 && !error && (
          <p className="text-muted-foreground">The menu is empty right now.</p>
        )}

        <div className="space-y-8">
          {categories.map((cat) => (
            <section key={cat.category}>
              <h2 className="mb-3 text-lg font-semibold tracking-tight">{cat.category}</h2>
              <div className="space-y-3">
                {(cat.items ?? []).map((item) => {
                  const qty = quantityFor(item)
                  return (
                    <Card key={item.id}>
                      <CardContent className="flex items-center gap-4 p-4">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium">{item.name}</div>
                          {item.description && (
                            <p className="mt-0.5 truncate text-sm text-muted-foreground">{item.description}</p>
                          )}
                          <div className="mt-1 text-sm font-medium">{money(item.priceCents)}</div>
                        </div>
                        {accepting && (
                          qty > 0 ? (
                            <div className="flex shrink-0 items-center gap-2">
                              <Button variant="outline" size="icon" aria-label={`Remove one ${item.name}`} onClick={() => decrement(item)}>−</Button>
                              <span className="w-5 text-center tabular-nums">{qty}</span>
                              <Button variant="outline" size="icon" aria-label={`Add one more ${item.name}`} onClick={() => increment(item)}>+</Button>
                            </div>
                          ) : (
                            <Button size="sm" className="shrink-0" onClick={() => increment(item)}>Add</Button>
                          )
                        )}
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </div>

      {count > 0 && (
        <Link
          to="/basket"
          className="fixed inset-x-0 bottom-0 z-20 border-t bg-primary text-primary-foreground"
        >
          <div className="container flex h-14 items-center justify-between font-medium">
            <span>{count} {count === 1 ? 'item' : 'items'} in basket</span>
            <span>{money(total)} · View basket</span>
          </div>
        </Link>
      )}
    </Shell>
  )
}
