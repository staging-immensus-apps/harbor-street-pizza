import { useEffect, useMemo, useState } from 'react'
import { Shell } from '@/components/shell'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert } from '@/components/ui/alert'
import { Dialog } from '@/components/ui/dialog'
import { listMenuItemsAdmin, createMenuItem, updateMenuItem, deleteMenuItem } from '@/api/menu-admin'
import { money, errorText } from '@/lib/format'
import type { MenuItemAdmin, MenuItemWrite } from '@/api/types'

type FormState = {
  name: string
  description: string
  price: string // pounds, as typed
  category: string
  sortOrder: string
}

const BLANK_FORM: FormState = { name: '', description: '', price: '', category: '', sortOrder: '0' }

function formFromItem (item: MenuItemAdmin): FormState {
  return {
    name: item.name,
    description: item.description ?? '',
    price: (item.priceCents / 100).toFixed(2),
    category: item.category ?? '',
    sortOrder: String(item.sortOrder ?? 0),
  }
}

/** Parses a pounds-string into whole cents, or null when it isn't a usable non-negative number —
 * the server's own 400 is the safety net, this is the primary UX (per the build task). */
function centsFrom (price: string): number | null {
  const pounds = Number(price)
  if (!Number.isFinite(pounds) || pounds < 0) return null
  return Math.round(pounds * 100)
}

/**
 * The owner's menu editor (CLAUDE.md §10 `/manage/menu`). Add, edit, hide and remove items; a change
 * shows on the customer menu (MenuApi) on its next read. `admin: true` in src/routes.ts already gates
 * this page via the sign-in kit's Guard — it never checks role itself.
 */
export default function MenuEditor () {
  const [items, setItems] = useState<MenuItemAdmin[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [addOpen, setAddOpen] = useState(false)
  const [editItem, setEditItem] = useState<MenuItemAdmin | null>(null)
  const [deleteItem, setDeleteItem] = useState<MenuItemAdmin | null>(null)

  const [form, setForm] = useState<FormState>(BLANK_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [toggleBusyId, setToggleBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listMenuItemsAdmin()
      .then((r) => { if (!cancelled) setItems(r?.items ?? []) })
      .catch((err) => { if (!cancelled) setLoadError(errorText(err, 'Could not load the menu')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // The server already sorted category-then-sortOrder, so grouping just walks the list and breaks on
  // a change of category rather than re-sorting it.
  const grouped = useMemo(() => {
    const groups: { category: string; items: MenuItemAdmin[] }[] = []
    for (const item of items) {
      const cat = item.category || 'Uncategorised'
      const last = groups[groups.length - 1]
      if (last && last.category === cat) last.items.push(item)
      else groups.push({ category: cat, items: [item] })
    }
    return groups
  }, [items])

  function openAdd () {
    setForm(BLANK_FORM)
    setFormError(null)
    setAddOpen(true)
  }

  function openEdit (item: MenuItemAdmin) {
    setForm(formFromItem(item))
    setFormError(null)
    setEditItem(item)
  }

  function closeDialogs () {
    setAddOpen(false)
    setEditItem(null)
    setFormError(null)
  }

  function buildBody (): MenuItemWrite | null {
    const name = form.name.trim()
    if (!name) { setFormError('Give the item a name.'); return null }
    const priceCents = centsFrom(form.price)
    if (priceCents === null) { setFormError('Enter a price of 0 or more.'); return null }
    const sortOrder = Number(form.sortOrder)
    return {
      name,
      description: form.description.trim() || undefined,
      priceCents,
      category: form.category.trim() || undefined,
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
    }
  }

  async function submitAdd () {
    const body = buildBody()
    if (!body) return
    setSubmitting(true)
    setFormError(null)
    try {
      const r = await createMenuItem({ ...body, available: true })
      setItems((prev) => [...prev, r.item])
      closeDialogs()
    } catch (err) {
      setFormError(errorText(err, 'Could not add that item'))
    } finally {
      setSubmitting(false)
    }
  }

  async function submitEdit () {
    if (!editItem) return
    const body = buildBody()
    if (!body) return
    setSubmitting(true)
    setFormError(null)
    try {
      const r = await updateMenuItem(editItem.id, body)
      setItems((prev) => prev.map((it) => (it.id === r.item.id ? r.item : it)))
      closeDialogs()
    } catch (err) {
      setFormError(errorText(err, 'Could not save that item'))
    } finally {
      setSubmitting(false)
    }
  }

  // One tap, straight from the list — no separate save step for the field the plan calls out
  // ("hide something that has sold out").
  async function toggleAvailable (item: MenuItemAdmin) {
    setActionError(null)
    setToggleBusyId(item.id)
    try {
      const r = await updateMenuItem(item.id, { available: !item.available })
      setItems((prev) => prev.map((it) => (it.id === r.item.id ? r.item : it)))
    } catch (err) {
      setActionError(errorText(err, 'Could not change that item'))
    } finally {
      setToggleBusyId(null)
    }
  }

  async function confirmDelete () {
    const item = deleteItem
    if (!item) return
    setDeleteItem(null)
    setActionError(null)
    try {
      await deleteMenuItem(item.id)
      setItems((prev) => prev.filter((it) => it.id !== item.id))
    } catch (err) {
      setActionError(errorText(err, 'Could not remove that item'))
    }
  }

  const livePriceCents = centsFrom(form.price)

  return (
    <Shell
      title="Menu editor"
      description="Add, edit, hide and remove items. A change shows on the customer menu right away."
      actions={<Button onClick={openAdd}>Add item</Button>}
    >
      {loadError && <Alert variant="destructive">{loadError}</Alert>}
      {actionError && <Alert variant="destructive">{actionError}</Alert>}

      {loading && <p className="text-muted-foreground">Loading…</p>}
      {!loading && items.length === 0 && !loadError && (
        <p className="text-muted-foreground">Nothing on the menu yet — add your first item.</p>
      )}

      <div className="space-y-6">
        {grouped.map((group) => (
          <div key={group.category} className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{group.category}</h2>
            <div className="space-y-3">
              {group.items.map((item) => (
                <Card key={item.id}>
                  <CardContent className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium">{item.name}</div>
                        {item.description && <div className="break-words text-sm text-muted-foreground">{item.description}</div>}
                      </div>
                      <div className="shrink-0 font-medium">{money(item.priceCents)}</div>
                    </div>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        variant={item.available ? 'default' : 'outline'}
                        size="sm"
                        disabled={toggleBusyId === item.id}
                        onClick={() => toggleAvailable(item)}
                      >
                        {item.available ? 'Available' : 'Hidden'}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => openEdit(item)}>Edit</Button>
                      <Button variant="destructive" size="sm" onClick={() => setDeleteItem(item)}>Delete</Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        ))}
      </div>

      <Dialog
        open={addOpen}
        onClose={closeDialogs}
        title="Add an item"
        description="Name, price and category — description and order are optional."
      >
        <div className="space-y-3">
          {formError && <Alert variant="destructive">{formError}</Alert>}
          <div className="space-y-1">
            <Label htmlFor="add-name">Name</Label>
            <Input id="add-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="add-description">Description</Label>
            <Input id="add-description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="add-price">Price</Label>
            <Input
              id="add-price"
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">{livePriceCents === null ? 'Enter a price' : money(livePriceCents)}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="add-category">Category</Label>
            <Input id="add-category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="add-sort">Order</Label>
            <Input
              id="add-sort"
              type="number"
              step="1"
              value={form.sortOrder}
              onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={closeDialogs} disabled={submitting}>Cancel</Button>
            <Button onClick={submitAdd} disabled={submitting}>Add item</Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={!!editItem}
        onClose={closeDialogs}
        title="Edit item"
        description={editItem ? editItem.name : undefined}
      >
        <div className="space-y-3">
          {formError && <Alert variant="destructive">{formError}</Alert>}
          <div className="space-y-1">
            <Label htmlFor="edit-name">Name</Label>
            <Input id="edit-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-description">Description</Label>
            <Input id="edit-description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-price">Price</Label>
            <Input
              id="edit-price"
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">{livePriceCents === null ? 'Enter a price' : money(livePriceCents)}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-category">Category</Label>
            <Input id="edit-category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-sort">Order</Label>
            <Input
              id="edit-sort"
              type="number"
              step="1"
              value={form.sortOrder}
              onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={closeDialogs} disabled={submitting}>Cancel</Button>
            <Button onClick={submitEdit} disabled={submitting}>Save</Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={!!deleteItem}
        onClose={() => setDeleteItem(null)}
        title="Remove this item?"
        description={deleteItem ? `"${deleteItem.name}" will be removed from the menu. Orders already placed keep their own copy.` : undefined}
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDeleteItem(null)}>Keep item</Button>
          <Button variant="destructive" onClick={confirmDelete}>Remove item</Button>
        </div>
      </Dialog>
    </Shell>
  )
}
