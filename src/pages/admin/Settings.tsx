import { useEffect, useState } from 'react'
import { Shell } from '@/components/shell'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert } from '@/components/ui/alert'
import { getStoreSettings, saveStoreSettings } from '@/api/store-settings'
import { shortDate, errorText } from '@/lib/format'
import type { StoreSettings, StoreSettingsWrite } from '@/api/types'

type FormState = {
  storeName: string
  acceptingOrders: boolean
  pausedMessage: string
  pickupEnabled: boolean
  deliveryEnabled: boolean
  deliveryFee: string // pounds, as typed
  deliveryPostcodes: string // comma/newline separated, as typed
  pickupEstimateMinutes: string
  deliveryEstimateMinutes: string
}

function formFromSettings (s: StoreSettings): FormState {
  return {
    storeName: s.storeName ?? '',
    acceptingOrders: s.acceptingOrders,
    pausedMessage: s.pausedMessage ?? '',
    pickupEnabled: s.pickupEnabled,
    deliveryEnabled: s.deliveryEnabled,
    deliveryFee: (s.deliveryFeeCents / 100).toFixed(2),
    deliveryPostcodes: (s.deliveryPostcodes ?? []).join(', '),
    pickupEstimateMinutes: String(s.pickupEstimateMinutes ?? ''),
    deliveryEstimateMinutes: String(s.deliveryEstimateMinutes ?? ''),
  }
}

/** Parses a pounds-string into whole non-negative cents, or null when unusable (server's 400 is the
 * safety net; this is the primary UX, same pattern as the menu editor's price field). */
function centsFrom (value: string): number | null {
  const pounds = Number(value)
  if (!Number.isFinite(pounds) || pounds < 0) return null
  return Math.round(pounds * 100)
}

function minutesFrom (value: string): number | null {
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 180) return null
  return n
}

function postcodesFrom (value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/**
 * The owner's shop settings (CLAUDE.md §10 `/manage/settings`). Pause/resume ordering, pickup and
 * delivery switches, delivery fee, postcode list and time estimates, plus the read-only
 * last-cleared date from the retention sweep. `admin: true` in src/routes.ts already gates this
 * page via the sign-in kit's Guard — it never checks role itself.
 */
export default function Settings () {
  const [form, setForm] = useState<FormState | null>(null)
  const [lastClearedAt, setLastClearedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedJustNow, setSavedJustNow] = useState(false)

  useEffect(() => {
    let cancelled = false
    getStoreSettings()
      .then((r) => {
        if (cancelled) return
        setForm(formFromSettings(r.settings))
        setLastClearedAt(r.lastDetailsClearedAt)
      })
      .catch((err) => { if (!cancelled) setLoadError(errorText(err, 'Could not load settings')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  function update<K extends keyof FormState> (key: K, value: FormState[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev))
    setSavedJustNow(false)
  }

  async function save () {
    if (!form) return
    setSaveError(null)

    const deliveryFeeCents = centsFrom(form.deliveryFee)
    if (deliveryFeeCents === null) { setSaveError('Enter a delivery fee of 0 or more.'); return }
    const pickupEstimateMinutes = minutesFrom(form.pickupEstimateMinutes)
    if (pickupEstimateMinutes === null) { setSaveError('Enter a pickup estimate between 1 and 180 minutes.'); return }
    const deliveryEstimateMinutes = minutesFrom(form.deliveryEstimateMinutes)
    if (deliveryEstimateMinutes === null) { setSaveError('Enter a delivery estimate between 1 and 180 minutes.'); return }
    if (!form.pickupEnabled && !form.deliveryEnabled) { setSaveError('At least one of pickup or delivery must stay on.'); return }
    const deliveryPostcodes = postcodesFrom(form.deliveryPostcodes)
    if (form.deliveryEnabled && deliveryPostcodes.length === 0) { setSaveError('Add at least one postcode before turning delivery on.'); return }

    const body: StoreSettingsWrite = {
      storeName: form.storeName.trim() || undefined,
      acceptingOrders: form.acceptingOrders,
      pausedMessage: form.pausedMessage.trim(),
      pickupEnabled: form.pickupEnabled,
      deliveryEnabled: form.deliveryEnabled,
      deliveryFeeCents,
      deliveryPostcodes,
      pickupEstimateMinutes,
      deliveryEstimateMinutes,
    }

    setSaving(true)
    try {
      const r = await saveStoreSettings(body)
      setForm(formFromSettings(r.settings))
      setLastClearedAt(r.lastDetailsClearedAt)
      setSavedJustNow(true)
    } catch (err) {
      setSaveError(errorText(err, 'Could not save settings — the server rejected one of the values'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Shell title="Shop settings" description="Pause ordering, pickup and delivery, fees, delivery area and time estimates.">
      {loadError && <Alert variant="destructive">{loadError}</Alert>}
      {loading && <p className="text-muted-foreground">Loading…</p>}

      {!loading && form && (
        <div className="space-y-6">
          {saveError && <Alert variant="destructive">{saveError}</Alert>}
          {savedJustNow && <Alert>Saved.</Alert>}

          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <Label>Orders</Label>
                <Button
                  variant={form.acceptingOrders ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => update('acceptingOrders', !form.acceptingOrders)}
                >
                  {form.acceptingOrders ? 'Accepting orders' : 'Paused'}
                </Button>
              </div>
              <div className="space-y-1">
                <Label htmlFor="paused-message">Message shown while paused</Label>
                <Input
                  id="paused-message"
                  value={form.pausedMessage}
                  onChange={(e) => update('pausedMessage', e.target.value)}
                  placeholder="We're closed right now — back soon!"
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <Label>Pickup</Label>
                <Button
                  variant={form.pickupEnabled ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => update('pickupEnabled', !form.pickupEnabled)}
                >
                  {form.pickupEnabled ? 'On' : 'Off'}
                </Button>
              </div>
              <div className="space-y-1">
                <Label htmlFor="pickup-estimate">Pickup time estimate (minutes)</Label>
                <Input
                  id="pickup-estimate"
                  type="number"
                  step="1"
                  min="1"
                  max="180"
                  inputMode="numeric"
                  value={form.pickupEstimateMinutes}
                  onChange={(e) => update('pickupEstimateMinutes', e.target.value)}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <Label>Delivery</Label>
                <Button
                  variant={form.deliveryEnabled ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => update('deliveryEnabled', !form.deliveryEnabled)}
                >
                  {form.deliveryEnabled ? 'On' : 'Off'}
                </Button>
              </div>
              <div className="space-y-1">
                <Label htmlFor="delivery-fee">Delivery fee</Label>
                <Input
                  id="delivery-fee"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  value={form.deliveryFee}
                  onChange={(e) => update('deliveryFee', e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="delivery-postcodes">Postcodes you deliver to</Label>
                <Input
                  id="delivery-postcodes"
                  value={form.deliveryPostcodes}
                  onChange={(e) => update('deliveryPostcodes', e.target.value)}
                  placeholder="SW1A, EC1A, N1"
                />
                <p className="text-xs text-muted-foreground">
                  Separate with commas. Required before delivery can be turned on.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="delivery-estimate">Delivery time estimate (minutes)</Label>
                <Input
                  id="delivery-estimate"
                  type="number"
                  step="1"
                  min="1"
                  max="180"
                  inputMode="numeric"
                  value={form.deliveryEstimateMinutes}
                  onChange={(e) => update('deliveryEstimateMinutes', e.target.value)}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="space-y-1">
                <Label htmlFor="store-name">Shop name</Label>
                <Input
                  id="store-name"
                  value={form.storeName}
                  onChange={(e) => update('storeName', e.target.value)}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                Customer details last cleared: {lastClearedAt ? shortDate(lastClearedAt) : 'not yet'}
              </p>
            </CardContent>
          </Card>

          <Button onClick={save} disabled={saving} className="w-full">
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </Shell>
  )
}
