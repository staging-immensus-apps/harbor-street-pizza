// The shop-level settings, in one place, because five resources read them and two shapes of
// "what the shop is doing right now" would drift apart within a week.
//
// THE ROW MAY NOT EXIST. `StoreSetting` holds exactly one row, id `store`, and the owner has to save
// the settings screen once for it to appear — so every reader falls back to the built-in defaults
// below and nothing here ever 404s or throws (CLAUDE.md §8). `StoreSettingsApi` is the only writer.
//
// Delivery is OFF by default and the defaults carry no postcodes, because an app that shipped
// "delivery on, no area" would accept an order the shop cannot fulfil on its first minute.

import { db } from './db.js'
import { config } from './config.js'

export const STORE_ID = 'store'

/** What the app does before the owner has ever saved. Changing one of these changes a live app. */
export const STORE_DEFAULTS = {
  acceptingOrders: true,
  pausedMessage: 'We are not taking orders at the moment. Please try again shortly.',
  pickupEnabled: true,
  deliveryEnabled: false,
  deliveryFeeCents: 400,
  deliveryPostcodes: [],
  pickupEstimateMinutes: 25,
  deliveryEstimateMinutes: 45,
}

export const ESTIMATE_MIN = 1
export const ESTIMATE_MAX = 180
export const POSTCODE_MAX = 200
const PAUSED_MESSAGE_MAX = 400
const STORE_NAME_MAX = 120

/**
 * The settings as every reader should see them: the stored row's values where they are present and
 * of the right type, the defaults everywhere else.
 *
 * A column written by an older version of the app, or left null, reads as the default rather than as
 * `null` — rule 11's shape: a blank is absent, and absent means "the shop never chose", which is
 * what a default is for.
 */
export async function loadStoreSettings () {
  const row = (await db.StoreSetting.get(STORE_ID)) ?? null
  const name = typeof row?.storeName === 'string' ? row.storeName.trim() : ''
  return {
    storeName: name || config.appName(),
    acceptingOrders: typeof row?.acceptingOrders === 'boolean' ? row.acceptingOrders : STORE_DEFAULTS.acceptingOrders,
    pausedMessage: blankTo(row?.pausedMessage, STORE_DEFAULTS.pausedMessage),
    pickupEnabled: typeof row?.pickupEnabled === 'boolean' ? row.pickupEnabled : STORE_DEFAULTS.pickupEnabled,
    deliveryEnabled: typeof row?.deliveryEnabled === 'boolean' ? row.deliveryEnabled : STORE_DEFAULTS.deliveryEnabled,
    deliveryFeeCents: wholeCents(row?.deliveryFeeCents, STORE_DEFAULTS.deliveryFeeCents),
    deliveryPostcodes: Array.isArray(row?.deliveryPostcodes) ? row.deliveryPostcodes.map(normalizePostcode).filter(Boolean) : [...STORE_DEFAULTS.deliveryPostcodes],
    pickupEstimateMinutes: estimate(row?.pickupEstimateMinutes, STORE_DEFAULTS.pickupEstimateMinutes),
    deliveryEstimateMinutes: estimate(row?.deliveryEstimateMinutes, STORE_DEFAULTS.deliveryEstimateMinutes),
    saved: Boolean(row),
    updatedAt: row?.updatedAt ?? null,
  }
}

/** What a customer may see: the shop-level facts needed to order, and nothing else. */
export function publicStoreInfo (settings) {
  return {
    storeName: settings.storeName,
    acceptingOrders: settings.acceptingOrders,
    pausedMessage: settings.acceptingOrders ? null : settings.pausedMessage,
    pickupEnabled: settings.pickupEnabled,
    deliveryEnabled: settings.deliveryEnabled,
    deliveryFeeCents: settings.deliveryFeeCents,
    deliveryPostcodes: settings.deliveryPostcodes,
    pickupEstimateMinutes: settings.pickupEstimateMinutes,
    deliveryEstimateMinutes: settings.deliveryEstimateMinutes,
  }
}

/** A postcode as it is stored and compared: upper case, no spaces, nothing else removed. */
export function normalizePostcode (value) {
  return String(value ?? '').toUpperCase().replace(/\s+/g, '').trim()
}

/**
 * The outward part of a UK postcode — `N174AB` → `N17`, `SW1A1AA` → `SW1A`.
 *
 * The inward part is always the last three characters, so this needs no table of districts. It is
 * what makes a short list of postcodes usable: an owner lists the districts they deliver to, not
 * every full postcode in them.
 */
export function outwardOf (postcode) {
  const key = normalizePostcode(postcode)
  return key.length > 3 ? key.slice(0, -3) : key
}

/**
 * Does the shop deliver to this postcode?
 *
 * A listed entry matches either the whole postcode or its district, and NEVER as a loose prefix:
 * `N1` must not pick up `N17 4AB`, which is a different part of town and a delivery nobody can make.
 */
export function postcodeAllowed (settings, postcode) {
  const key = normalizePostcode(postcode)
  if (!key) return false
  const outward = outwardOf(key)
  return (settings.deliveryPostcodes ?? []).some((entry) => {
    const listed = normalizePostcode(entry)
    return Boolean(listed) && (listed === key || listed === outward)
  })
}

/**
 * Validate a full settings save. `{ error }` or `{ value }` — the value is exactly the columns
 * `StoreSetting` declares, so a body cannot smuggle anything else into the row.
 *
 * Delivery on with no postcodes is refused: the area is what makes "do you deliver to me?"
 * answerable, and without one every delivery checkout would be refused with nothing on the settings
 * screen to explain why.
 */
export function validateStoreSettings (body) {
  const b = body && typeof body === 'object' ? body : {}
  const storeName = String(b.storeName ?? '').trim()
  if (storeName.length > STORE_NAME_MAX) return { error: `storeName must be at most ${STORE_NAME_MAX} characters` }
  const pausedMessage = String(b.pausedMessage ?? '').trim()
  if (pausedMessage.length > PAUSED_MESSAGE_MAX) return { error: `pausedMessage must be at most ${PAUSED_MESSAGE_MAX} characters` }

  const deliveryFeeCents = b.deliveryFeeCents ?? STORE_DEFAULTS.deliveryFeeCents
  if (!Number.isInteger(deliveryFeeCents) || deliveryFeeCents < 0) return { error: 'deliveryFeeCents must be a whole number of cents, 0 or more' }

  const pickupEstimateMinutes = b.pickupEstimateMinutes ?? STORE_DEFAULTS.pickupEstimateMinutes
  const deliveryEstimateMinutes = b.deliveryEstimateMinutes ?? STORE_DEFAULTS.deliveryEstimateMinutes
  for (const [name, v] of [['pickupEstimateMinutes', pickupEstimateMinutes], ['deliveryEstimateMinutes', deliveryEstimateMinutes]]) {
    if (!Number.isInteger(v) || v < ESTIMATE_MIN || v > ESTIMATE_MAX) return { error: `${name} must be a whole number of minutes between ${ESTIMATE_MIN} and ${ESTIMATE_MAX}` }
  }

  const rawCodes = Array.isArray(b.deliveryPostcodes) ? b.deliveryPostcodes : []
  if (rawCodes.length > POSTCODE_MAX) return { error: `at most ${POSTCODE_MAX} delivery postcodes` }
  const seen = new Set()
  const deliveryPostcodes = []
  for (const raw of rawCodes) {
    const code = normalizePostcode(raw)
    if (!code || seen.has(code)) continue
    if (code.length > 10 || !/^[A-Z0-9]+$/.test(code)) return { error: `"${String(raw).slice(0, 20)}" is not a postcode` }
    seen.add(code)
    deliveryPostcodes.push(code)
  }

  const acceptingOrders = b.acceptingOrders !== false
  const pickupEnabled = b.pickupEnabled !== false
  const deliveryEnabled = b.deliveryEnabled === true
  if (deliveryEnabled && deliveryPostcodes.length === 0) return { error: 'add at least one delivery postcode before turning delivery on' }
  if (!pickupEnabled && !deliveryEnabled) return { error: 'at least one of pickup and delivery must be on' }

  return {
    value: {
      storeName: storeName || null,
      acceptingOrders,
      pausedMessage: pausedMessage || null,
      pickupEnabled,
      deliveryEnabled,
      deliveryFeeCents,
      deliveryPostcodes,
      pickupEstimateMinutes,
      deliveryEstimateMinutes,
    },
  }
}

function blankTo (value, fallback) {
  const s = typeof value === 'string' ? value.trim() : ''
  return s || fallback
}

function wholeCents (value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function estimate (value, fallback) {
  return Number.isInteger(value) && value >= ESTIMATE_MIN && value <= ESTIMATE_MAX ? value : fallback
}
