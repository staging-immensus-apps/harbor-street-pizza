import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Shell } from '@/components/shell'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert } from '@/components/ui/alert'
import { Dialog } from '@/components/ui/dialog'
import { listMenuItemsAdmin, createMenuItem, updateMenuItem, deleteMenuItem } from '@/api/menu-admin'
import { uploadMenuPhoto, removeMenuPhoto } from '@/api/menu-photo-admin'
import { money, errorText } from '@/lib/format'
import type { MenuItemAdmin, MenuItemWrite } from '@/api/types'

// A chosen-but-not-yet-uploaded photo for whichever dialog (Add or Edit) is open — only one of
// those is ever open at a time (Dialog only mounts its children while `open`), so one slot of
// state serves both and there is never a stale selection to disambiguate.
type PendingPhoto = { file: File; previewUrl: string }

/** Draws a chosen file to a canvas and re-encodes it as JPEG no wider than 1200px (the plan's own
 * steps), so a phone photo arrives small regardless of its source format. */
async function resizeToJpeg (file: File): Promise<{ dataBase64: string; contentType: 'image/jpeg' }> {
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('Could not read that image'))
      img.src = objectUrl
    })
    const scale = Math.min(1, 1200 / image.naturalWidth)
    const width = Math.round(image.naturalWidth * scale)
    const height = Math.round(image.naturalHeight * scale)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not prepare that image')
    ctx.drawImage(image, 0, 0, width, height)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
    return { dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1), contentType: 'image/jpeg' }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

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

  const [pendingPhoto, setPendingPhoto] = useState<PendingPhoto | null>(null)
  const [photoBusy, setPhotoBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  function clearPendingPhoto () {
    setPendingPhoto((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl)
      return null
    })
  }

  function openAdd () {
    setForm(BLANK_FORM)
    setFormError(null)
    clearPendingPhoto()
    setAddOpen(true)
  }

  function openEdit (item: MenuItemAdmin) {
    setForm(formFromItem(item))
    setFormError(null)
    clearPendingPhoto()
    setEditItem(item)
  }

  function closeDialogs () {
    setAddOpen(false)
    setEditItem(null)
    setFormError(null)
    clearPendingPhoto()
  }

  function handlePhotoChosen (e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // lets the same file be chosen again later
    if (!file) return
    setPendingPhoto((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl)
      return { file, previewUrl: URL.createObjectURL(file) }
    })
  }

  // Runs after the item itself is already saved (submitAdd/submitEdit), so a failure here is
  // reported without undoing that save — the plan's own order of operations.
  async function uploadPendingPhotoFor (menuItemId: string, file: File) {
    setActionError(null)
    try {
      const { dataBase64, contentType } = await resizeToJpeg(file)
      await uploadMenuPhoto(menuItemId, { dataBase64, contentType })
      const r = await listMenuItemsAdmin()
      setItems(r?.items ?? [])
    } catch (err) {
      setActionError(errorText(err, 'Could not upload that photo'))
    }
  }

  async function removePhoto (item: MenuItemAdmin) {
    setActionError(null)
    setPhotoBusy(true)
    try {
      await removeMenuPhoto(item.id)
      const r = await listMenuItemsAdmin()
      const freshItems = r?.items ?? []
      setItems(freshItems)
      setEditItem((prev) => (prev && prev.id === item.id ? freshItems.find((it) => it.id === item.id) ?? prev : prev))
      clearPendingPhoto()
    } catch (err) {
      setActionError(errorText(err, 'Could not remove that photo'))
    } finally {
      setPhotoBusy(false)
    }
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
      const photo = pendingPhoto
      closeDialogs()
      if (photo) await uploadPendingPhotoFor(r.item.id, photo.file)
    } catch (err) {
      setFormError(errorText(err, 'Could not add that item'))
    } finally {
      setSubmitting(false)
      clearPendingPhoto()
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
      const photo = pendingPhoto
      closeDialogs()
      if (photo) await uploadPendingPhotoFor(r.item.id, photo.file)
    } catch (err) {
      setFormError(errorText(err, 'Could not save that item'))
    } finally {
      setSubmitting(false)
      clearPendingPhoto()
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

  // Shared by the Add and Edit dialogs: `item` is null in Add (an item never has a photo before it
  // exists), the saved photo when the edited item has one and nothing new has been chosen yet, or a
  // chosen-but-unsaved file's preview — in that priority order.
  function renderPhotoField (item: MenuItemAdmin | null) {
    if (item && item.photoUpdatedAt && !pendingPhoto) {
      return (
        <div className="flex items-center gap-3">
          <img src={item.photoUrl ?? undefined} className="h-24 w-24 rounded-md border object-cover" alt="" />
          <div className="flex flex-col gap-2">
            <Button variant="outline" size="sm" disabled={photoBusy} onClick={() => fileInputRef.current?.click()}>Replace</Button>
            <Button variant="outline" size="sm" disabled={photoBusy} onClick={() => removePhoto(item)}>Remove</Button>
          </div>
        </div>
      )
    }
    if (pendingPhoto) {
      return (
        <div className="flex items-center gap-3">
          <img src={pendingPhoto.previewUrl} className="h-24 w-24 rounded-md border object-cover" alt="" />
          <div className="flex min-w-0 flex-col gap-2">
            <span className="truncate text-sm text-muted-foreground">{pendingPhoto.file.name}</span>
            <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>Choose a different photo</Button>
          </div>
        </div>
      )
    }
    return (
      <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>Choose a photo</Button>
    )
  }

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
          <div className="space-y-1">
            <Label>Photo</Label>
            {renderPhotoField(null)}
            <input ref={fileInputRef} type="file" accept="image/jpeg,image/png" className="hidden" onChange={handlePhotoChosen} />
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
          <div className="space-y-1">
            <Label>Photo</Label>
            {renderPhotoField(editItem)}
            <input ref={fileInputRef} type="file" accept="image/jpeg,image/png" className="hidden" onChange={handlePhotoChosen} />
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
