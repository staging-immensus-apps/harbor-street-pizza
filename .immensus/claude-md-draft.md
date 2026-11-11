# CLAUDE.md — Pizza Shop Online Ordering

## 1. Product

A phone-first ordering site for one pizza shop. Customers browse the menu, build a basket, choose
pickup or delivery, give a name and phone number (and an address for delivery), and check out as a
guest — there are no customer accounts. The shop owner signs in with a link emailed to them and gets
three screens: a live order queue, a menu editor and shop settings.

Decided with the owner before the build, and load-bearing:

- **Guest checkout.** No customer accounts, no order history, no password. The only person who signs
  in is the owner, by emailed link, and only invited addresses can get an account at all
  (`accessModel.signUp: "invited"`). There are no staff logins in this version.
- **Fixed menu.** No sizes, crusts or toppings to choose. An item is a name, a description, a price
  and a category.
- **ASAP only.** No scheduling an order for later.
- **Menu prices are final.** No tax line anywhere; the total is the lines plus the delivery fee.
- **Delivery by postcode list.** The owner keeps a list of postcodes. A delivery address whose
  postcode is not on the list is refused at checkout with an offer of pickup instead.
- **One flat delivery fee**, set by the owner, added to every delivery order.
- **Payment through the owner's own Stripe account.** Until that key is in place, checkout places the
  order with `paymentStatus: 'pay_at_store'`. Once it is there, checkout creates a Stripe Checkout
  Session and the order only joins the owner's queue when the payments kit's `StripeWebhook`
  confirms payment. Both paths must keep working — never assume the key is present.
- **Twelve-month retention.** Name, phone and delivery address are cleared from an order twelve
  months after it was placed. The order, its lines and its totals are kept for good.

Form factor: phone. One thing per screen, big tap targets, no side-by-side panes. Look: `studio`.

## 8. Data model

Four tables in `schema.graphql`. `User`, `MagicLink`, `EmailLog` and `EmailSuppression` come from the
sign-in kit and `StripeEvent` from the payments kit, each in its own `schema.*.graphql` — never
redeclare one, and never `@relationship` across files.

- **`MenuItem`** — one row per menu item. `priceCents` is a whole-cent `Int`; no floats anywhere in
  money. `category`, `available` and `sortOrder` are indexed because the menu is read as
  `available == true` sorted by `category` then `sortOrder` — a list page sorting on an unindexed
  field with no filter beside it is a 404, not a slow query.
- **`Order`** — one row per order, `@table(audit: true)`. The audit store is not decoration: the
  owner's queue subscribes to this table for live arrivals, and `Table.subscribe()` refuses a table
  without one (it would otherwise perform that schema write itself at the first subscribe).
  - `items` is a `[Any]` **snapshot** — `{menuItemId, name, priceCents, quantity}` per line, copied
    from `MenuItem` at checkout. A later price change or a deleted item must never alter an order
    that has already been placed, so nothing reads prices back through `menuItemId`.
  - `code` is 32 random URL-safe characters and is the only key the confirmation page uses. It is
    indexed; it is never derived from anything guessable.
  - `queue` is `pending_payment` | `active` | `done` and exists so the owner's list is one indexed
    equality plus an indexed sort rather than a scan or a `not_equal`. `status` is
    `awaiting_payment` | `received` | `preparing` | `ready` | `collected` | `cancelled`.
  - `paymentStatus` is `unpaid` | `paid` | `pay_at_store`; `paymentRef` holds the Stripe Checkout
    Session id and is indexed so the webhook finds the order.
  - `personalDetailsClearedAt` is null until the retention sweep clears the row's name, phone,
    address and postcode; indexed, because the sweep filters on it.
- **`StoreSetting`** — exactly one row, id `store`, read by primary key. Every reader falls back to
  built-in defaults when it is absent (pickup on, delivery off, 400-cent fee, no postcodes, 25/45
  minute estimates), so the published app works before the owner has ever saved. `StoreSettingsApi`
  creates it on first save. No field is indexed: there is one row and it is fetched by id.
- **`LoopRun`** — the template's. The nightly retention sweep writes one row per occurrence with the
  **deterministic** id `clear-personal-details:YYYY-MM-DD`, claimed before the work is done. Nothing
  on Harper makes a scheduled job exactly-once — every worker of every node ticks the timer and
  leadership is a lease over last-writer-wins — so the deterministic key is what stops a second tick
  doing the work twice. The sweep itself is idempotent anyway: it clears fields that are already
  null-safe and skips rows where `personalDetailsClearedAt` is set.

The sweep lives behind `resources/Scheduler.js` (rule 17) as a loop in `lib/loops/`: find orders with
`placedAt` less than the cutoff (indexed range) and `personalDetailsClearedAt == null` (nulls are
indexed), clear the four personal fields, stamp the timestamp. It never arms in the preview copy.

## 9. Auth and owner rules

`accessModel`: `signIn: "optional"`, `signUp: "invited"`, `entry: "/"`, `callerAuth: "none"`. The shop
is open to anyone; signing in is what makes you the owner. The sign-in kit supplies `AuthApi`,
`AdminApi`, `AccountApi`, `Bootstrap` and `InboundEmailApi` — never write a second sign-in, a second
session cookie or a second invite flow beside them.

Every resource sets `static loadAsInstance = false` and `target.checkPermission = false` first: this
app's people are `User` rows, not Harper roles, so the row rule in the resource IS the access control.
An unauthenticated refusal is a thrown `Response` 403 with `code: 'auth_required'` — never 401.

| Resource | Rule |
|---|---|
| `MenuApi` | public, read-only, available items only |
| `StoreInfoApi` | public, read-only, the shop-level facts a customer needs; nothing private |
| `CheckoutApi` | public write. **Never trust the basket.** Every line is re-read from `MenuItem` and re-priced server-side; the fee and the postcode rule come from `StoreSetting`; the caller may not set totals, `status`, `queue`, `paymentStatus`, `paymentRef` or `code` |
| `OrderConfirmationApi` | public, but reachable only by the order's own random `code`. No listing, no enumeration, one order per request |
| `MenuAdminApi` | admin |
| `StoreSettingsApi` | admin (reads `LoopRun` for the last-cleared date; never writes it) |
| `OrderAdminApi` | admin — the only place customer names, phones and addresses are listed |

An admin check is role exactly `admin` on the session's user, on every method including the SSE
stream: `connect`/`subscribe` runs the same authorization entry as a REST request, so the rule is
written once in the resource and covers the live stream too.

The webhook is the payments kit's `StripeWebhook` and nothing in this app re-implements it: its
signature is checked over the raw bytes, it is idempotent on the Stripe event id, and it refuses in
the preview copy. Its only job here is to set `paymentStatus: 'paid'`, `status: 'received'` and
`queue: 'active'` on the order whose `paymentRef` matches.

## 10. Pages

Phone-first, `studio` look. Eight routes; `/order/:code` is the only wildcard, so `routes/spa.js`
carries `/order/*` and `/order` answers too (rule 26).

| Route | Who | What it does |
|---|---|---|
| `/` | anyone | The menu by category with a running basket. Entry route. Shows the paused message instead of the basket when ordering is off |
| `/basket` | anyone | Quantities, removals, running total |
| `/checkout` | anyone | Pickup or delivery; name and phone always, address and postcode for delivery only. Postcode checked against the delivery list before the order can be placed. Places the order, then sends the customer to Stripe when a key is configured |
| `/order/:code` | anyone with the link | Confirmation: order number, lines, total, pickup or delivery, payment state, estimated ready time, and the current status |
| `/manage` | owner | Hub: how many orders are waiting, links to the three screens |
| `/manage/orders` | owner | The live queue. New orders arrive over the stream with a 15-second poll as the fallback; one tap advances the status |
| `/manage/menu` | owner | Add, edit, hide and remove items; change prices |
| `/manage/settings` | owner | Pause ordering, pickup/delivery switches, delivery fee, postcode list, time estimates, last-cleared date |

Every page guards the shape it was handed (`r?.lines ?? []`, `Array.isArray(r?.rows)`) and renders an
empty state: the page-boot probe answers `{}` to any GET it has no fixture for, exactly as a
half-deployed API would.
