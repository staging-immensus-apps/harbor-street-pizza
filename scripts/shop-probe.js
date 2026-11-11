#!/usr/bin/env node
// The shop-settings rules this app introduced (lib/shop.js), driven rather than read:
//
//   1. THE ROW MAY BE ABSENT, and every reader still answers. The published app has no
//      StoreSetting row until the owner saves once, so the defaults are what a customer is served
//      on the app's first minute.
//   2. A DELIVERY POSTCODE MATCHES BY DISTRICT, NEVER AS A LOOSE PREFIX. `N1` must not pick up
//      `N17 4AB` — that is a different part of town and a delivery nobody can make.
//   3. DELIVERY CANNOT BE TURNED ON WITHOUT AN AREA, because the area is what makes "do you
//      deliver to me?" answerable.
//
// Hermetic: the frozen clock, no network, no git.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { freezeClock } from './probe/frozen-clock.js'
freezeClock()

const { checker } = await import('./probe/harness.js')
const { tables, resetTables } = await import('./probe/harperdb-stub.js')
const {
  STORE_ID, STORE_DEFAULTS, loadStoreSettings, publicStoreInfo,
  normalizePostcode, outwardOf, postcodeAllowed, validateStoreSettings,
} = await import('../lib/shop.js')

const { check, section, done, failures } = checker('shop-probe')

section('negative control: the postcode verdict can say no')
const AREA = { deliveryPostcodes: ['N17', 'N15', 'SW1A1AA'] }
check('a listed district matches a full postcode in it', postcodeAllowed(AREA, 'N17 4AB') === true)
check('a listed full postcode matches itself', postcodeAllowed(AREA, 'sw1a 1aa') === true)
check('an unlisted district does not match (NEG)', postcodeAllowed(AREA, 'E8 3DL') === false)
check('N1 is NOT N17: a district is not a prefix (NEG)', postcodeAllowed({ deliveryPostcodes: ['N1'] }, 'N17 4AB') === false)
check('…and N1 still matches its own postcodes', postcodeAllowed({ deliveryPostcodes: ['N1'] }, 'N1 4AB') === true)
check('an empty area matches nothing (NEG)', postcodeAllowed({ deliveryPostcodes: [] }, 'N17 4AB') === false)
check('a blank postcode matches nothing (NEG)', postcodeAllowed(AREA, '   ') === false)
check('normalizePostcode strips spaces and upper-cases', normalizePostcode(' n17 4ab ') === 'N174AB')
check('outwardOf takes the last three characters off', outwardOf('N17 4AB') === 'N17' && outwardOf('SW1A1AA') === 'SW1A' && outwardOf('N17') === 'N17')
if (failures.length) process.exit(done())

section('an absent row reads as the built-in defaults')
resetTables()
{
  const settings = await loadStoreSettings()
  check('nothing was read into existence', tables.StoreSetting.rows.size === 0)
  check('delivery is OFF and the area is empty', settings.deliveryEnabled === STORE_DEFAULTS.deliveryEnabled && settings.deliveryEnabled === false && settings.deliveryPostcodes.length === 0)
  check('pickup is on, the fee and the estimates are the defaults', settings.pickupEnabled === true && settings.deliveryFeeCents === STORE_DEFAULTS.deliveryFeeCents && settings.pickupEstimateMinutes === STORE_DEFAULTS.pickupEstimateMinutes && settings.deliveryEstimateMinutes === STORE_DEFAULTS.deliveryEstimateMinutes)
  check('…and it says it has never been saved', settings.saved === false)
  const info = publicStoreInfo(settings)
  check('the public view carries no private key', !('saved' in info) && !('updatedAt' in info))
  check('pausedMessage is null while orders are being accepted (rule 11: blank is absent)', info.acceptingOrders === true && info.pausedMessage === null)
}

section('a stored row wins, and a bad column falls back rather than reaching a customer')
{
  await tables.StoreSetting.put({ id: STORE_ID, storeName: ' Forno ', acceptingOrders: false, pausedMessage: 'Back at five', deliveryEnabled: true, deliveryPostcodes: [' n17 '], deliveryFeeCents: null, pickupEstimateMinutes: 9999 })
  const settings = await loadStoreSettings()
  check('PRECONDITION: the fixture really did store a null fee and a silly estimate', tables.StoreSetting.rows.get(STORE_ID).deliveryFeeCents === null && tables.StoreSetting.rows.get(STORE_ID).pickupEstimateMinutes === 9999)
  check('a null fee reads as the default, not as null (NEG)', settings.deliveryFeeCents === STORE_DEFAULTS.deliveryFeeCents)
  check('an out-of-range estimate reads as the default (NEG)', settings.pickupEstimateMinutes === STORE_DEFAULTS.pickupEstimateMinutes)
  check('the stored name is trimmed and the stored switches are honoured', settings.storeName === 'Forno' && settings.acceptingOrders === false && settings.deliveryEnabled === true)
  check('a stored postcode is normalized on the way out', settings.deliveryPostcodes[0] === 'N17')
  check('the paused message is served while orders are off', publicStoreInfo(settings).pausedMessage === 'Back at five')
}

section('validateStoreSettings refuses what a shop cannot honour')
{
  const ok = validateStoreSettings({ deliveryEnabled: true, deliveryPostcodes: ['n17', 'N17 ', ' n15'], deliveryFeeCents: 350, pickupEstimateMinutes: 20, deliveryEstimateMinutes: 40 })
  check('a sound save is accepted', !ok.error && ok.value.deliveryFeeCents === 350)
  check('postcodes come back normalized and de-duplicated', JSON.stringify(ok.value.deliveryPostcodes) === JSON.stringify(['N17', 'N15']))
  check('the value carries only the columns StoreSetting declares', Object.keys(ok.value).every((k) => ['storeName', 'acceptingOrders', 'pausedMessage', 'pickupEnabled', 'deliveryEnabled', 'deliveryFeeCents', 'deliveryPostcodes', 'pickupEstimateMinutes', 'deliveryEstimateMinutes'].includes(k)))
  check('an unknown key in the body is dropped (NEG)', !('ownerUserId' in validateStoreSettings({ ownerUserId: 'x', deliveryFeeCents: 0, pickupEstimateMinutes: 20, deliveryEstimateMinutes: 40 }).value))
  check('delivery on with no area is refused (NEG)', Boolean(validateStoreSettings({ deliveryEnabled: true, deliveryPostcodes: [], deliveryFeeCents: 400, pickupEstimateMinutes: 20, deliveryEstimateMinutes: 40 }).error))
  check('both fulfilments off is refused (NEG)', Boolean(validateStoreSettings({ pickupEnabled: false, deliveryEnabled: false, deliveryFeeCents: 400, pickupEstimateMinutes: 20, deliveryEstimateMinutes: 40 }).error))
  check('a fractional fee is refused (NEG)', Boolean(validateStoreSettings({ deliveryFeeCents: 4.5, pickupEstimateMinutes: 20, deliveryEstimateMinutes: 40 }).error))
  check('a negative fee is refused (NEG)', Boolean(validateStoreSettings({ deliveryFeeCents: -1, pickupEstimateMinutes: 20, deliveryEstimateMinutes: 40 }).error))
  check('an estimate of 0 or 181 is refused (NEG)', Boolean(validateStoreSettings({ deliveryFeeCents: 0, pickupEstimateMinutes: 0, deliveryEstimateMinutes: 40 }).error) && Boolean(validateStoreSettings({ deliveryFeeCents: 0, pickupEstimateMinutes: 20, deliveryEstimateMinutes: 181 }).error))
  check('a postcode that is not one is refused (NEG)', Boolean(validateStoreSettings({ deliveryEnabled: true, deliveryPostcodes: ['N17; DROP'], deliveryFeeCents: 0, pickupEstimateMinutes: 20, deliveryEstimateMinutes: 40 }).error))
}

process.exit(done())
