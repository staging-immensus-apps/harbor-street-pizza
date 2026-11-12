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

### This pass: the 400 on every admin write

The owner reported that saving a new menu item answers "Bad Request". The same fault breaks editing
an item and all three order-status buttons; the owner was asked and chose to have the menu editor
and the order-status buttons fixed together. The cause was found at plan time by comparing the
writes that fail against the ones that do not, and it is one line of the same mistake in two files —
§8 states it as a rule. Nothing else in the product changes: no new table, no new field, no new
screen, no new route, no change to who may do what.

Three reports are deliberately out of scope and must not be "fixed on the way past": seeded demo
orders showing £0.00 per line, new orders needing a reload to appear on `/manage/orders`, and the
'Estimated ready' wording on the confirmation page.

## 8. Data model

Four tables in `schema.graphql`. `User`, `MagicLink`, `EmailLog` and `EmailSuppression` come from the
sign-in kit and `StripeEvent` from the payments kit, each in its own `schema.*.graphql` — never
redeclare one, and never `@relationship` across files. **No table, field, index or directive changes
in this pass.**

### The rule this pass exists for: never write a timestamp Harper owns

**A field declared `@createdTime` or `@updatedTime` is assigned by Harper, in epoch milliseconds. No
record this app writes may carry a key for one — not a fresh value, and not the value just read off
the stored row.** Harper refuses such a write with a bare `400` carrying no JSON body, which is why
the page showed the bare statusText `"Bad Request"` with no message: the refusal happened above this
app's code, so no handler of ours ever ran and no `error` key was ever produced.

The fields are `MenuItem.createdAt`, `MenuItem.updatedAt`, `Order.updatedAt` and
`StoreSetting.updatedAt`. The evidence that this is the fault, rather than another theory:

- `MenuAdminApi` create wrote `createdAt` and `updatedAt` explicitly → 400.
- `MenuAdminApi` update wrote `updatedAt` explicitly and carried `createdAt` through from the stored
  row → 400, including on a save that changed no values.
- `OrderAdminApi.applyStatus` spread the stored row (`{ ...existing, status, queue }`), and the
  stored row carries `updatedAt` → 400, on seeded and freshly created orders alike.
- `StoreSettingsApi.put` builds its record from a constant id plus validated fields and never names
  `updatedAt` → 200 throughout. This is the control, and it is why the fault looked specific to two
  resources rather than to one shape.
- `CheckoutApi` creates an order from a fresh literal with no `updatedAt` → 200.
- Every write to `User` succeeds, and `User.createdAt`/`User.updatedAt` are plain `String` fields
  with no directive — the same code shape, on a table where those two names are the app's to set.
- `data/*.yaml` carries neither field, so the seeded rows load.

Two corollaries that are easy to get wrong:

- **Reads now return numbers.** Once the app stops writing them, `createdAt` and `updatedAt` come
  back as epoch milliseconds. `adminMenuItem` and `adminOrderView` pass them straight through, so
  anything that renders one must accept a number — and rows written before this fix may still hold
  an ISO string, so both shapes must render. Do not convert them in the resource; format at the
  edge.
- **This also closes a type error.** The code was putting ISO strings into fields declared `Long`.
  The schema is right and the code was wrong, so the schema does not move.

**Why no hermetic suite caught it:** `scripts/probe/harperdb-stub.js` accepts any attribute, so
`MenuAdminApi-probe` and `OrderAdminApi-probe` drive these exact routes and pass. That is what made
it look as though the fault "lives above the resource". A probe added this pass must therefore assert
the **shape of the record handed to `db.<Table>.put`/`patch`** — that it carries no key named by a
`@createdTime` or `@updatedTime` field, read from `schema.graphql` rather than hard-coded — with the
negative control being a record that does carry one. Asserting the stub's 200 proves nothing.

**Evidence standard for this fix (CLAUDE.md §2, §6):** the change is tier-1 only when one raw
response is captured whole from the live preview — status, headers and body bytes — for a menu save
and an order-status save, with the Harper version noted. Two earlier rounds reshaped these routes on
an untested theory; do not reshape them a third time.

The tables themselves:

- **`MenuItem`** — one row per menu item. `priceCents` is a whole-cent `Int`; no floats anywhere in
  money. `category`, `available` and `sortOrder` are indexed because the menu is read as
  `available == true` sorted by `category` then `sortOrder` — a list page sorting on an unindexed
  field with no filter beside it is a 404, not a slow query.
- **`Order`** — one row per order, `@table(audit: true)`. The audit store is not decoration: the
  owner's queue subscribes to this table for live arrivals, and `Table.subscribe()` refuses a table
  without one.
  - `items` is a `[Any]` **snapshot** — `{menuItemId, name, priceCents, quantity}` per line, copied
    from `MenuItem` at checkout. A later price change or a deleted item must never alter an order
    that has already been placed, so nothing reads prices back through `menuItemId`.
  - `code` is 32 random URL-safe characters and is the only key the confirmation page uses.
  - `queue` is `pending_payment` | `active` | `done`, so the owner's list is one indexed equality
    plus a sort rather than a scan. `status` is `awaiting_payment` | `received` | `preparing` |
    `ready` | `collected` | `cancelled`, and the queue is always derived from the status so the two
    cannot disagree.
  - `paymentStatus` is `unpaid` | `paid` | `pay_at_store`; `paymentRef` holds the Stripe Checkout
    Session id and is indexed so the webhook finds the order.
  - `personalDetailsClearedAt` is null until the retention sweep clears the row's name, phone,
    address and postcode; indexed, because the sweep filters on it.
- **`StoreSetting`** — exactly one row, id `store`, read by primary key. Every reader falls back to
  built-in defaults when it is absent, so the published app works before the owner has ever saved.
  No field is indexed: there is one row and it is fetched by id.
- **`LoopRun`** — the template's. The nightly retention sweep writes one row per occurrence with the
  deterministic id `clear-personal-details:YYYY-MM-DD`, claimed before the work is done.

The sweep lives behind `resources/Scheduler.js` (rule 17) as a loop in `lib/loops/`: find orders with
`placedAt` less than the cutoff (indexed range) and `personalDetailsClearedAt == null`, clear the
four personal fields, stamp the timestamp. It never arms in the preview copy.

## 9. Auth and owner rules

`accessModel`: `signIn: "optional"`, `signUp: "invited"`, `entry: "/"`, `callerAuth: "none"`. The shop
is open to anyone; signing in is what makes you the owner. The sign-in kit supplies `AuthApi`,
`AdminApi`, `AccountApi`, `Bootstrap` and `InboundEmailApi` — never write a second sign-in, a second
session cookie or a second invite flow beside them. **Nothing in this section changes this pass**, and
that is a constraint on the fix: the 400 is not an access-control problem and no owner rule may be
loosened while chasing it.

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

An admin check is role exactly `admin` on the session's user, re-read from the `User` row on every
call, on every method including the SSE stream: `connect`/`subscribe` runs the same authorization
entry as a REST request, so the rule is written once in the resource and covers the live stream too.

The writes fixed this pass keep every rule they already enforce: `MenuAdminApi` still restates `id`
and `createdAt` from the stored row rather than the body, and `OrderAdminApi` still writes only the
status and the queue derived from it, so a body naming `code`, `items`, a total, `paymentStatus` or a
customer's details changes nothing.

The webhook is the payments kit's `StripeWebhook` and nothing in this app re-implements it: its
signature is checked over the raw bytes, it is idempotent on the Stripe event id, and it refuses in
the preview copy. Its only job here is to set `paymentStatus: 'paid'`, `status: 'received'` and
`queue: 'active'` on the order whose `paymentRef` matches.

## 10. Pages

Phone-first, `studio` look. Eight routes, unchanged; `/order/:code` is the only wildcard, so
`routes/spa.js` carries `/order/*` and `/order` answers too (rule 26).

| Route | Who | What it does |
|---|---|---|
| `/` | anyone | The menu by category with a running basket. Entry route. Shows the paused message instead of the basket when ordering is off |
| `/basket` | anyone | Quantities, removals, running total |
| `/checkout` | anyone | Pickup or delivery; name and phone always, address and postcode for delivery only. Postcode checked against the delivery list before the order can be placed. Places the order, then sends the customer to Stripe when a key is configured |
| `/order/:code` | anyone with the link | Confirmation: order number, lines, total, pickup or delivery, payment state, estimated ready time, and the current status |
| `/manage` | owner | Hub: how many orders are waiting, links to the three screens |
| `/manage/orders` | owner | The live queue. One tap advances the status — **fixed this pass**. New orders arriving without a reload is a known gap and stays out of scope |
| `/manage/menu` | owner | Add, edit, hide and remove items; change prices — **fixed this pass** |
| `/manage/settings` | owner | Pause ordering, pickup/delivery switches, delivery fee, postcode list, time estimates, last-cleared date |

No page's API calls change. The one frontend consequence of the fix is that `createdAt` and
`updatedAt` now arrive as epoch-millisecond numbers, while rows written before the fix may still hold
ISO strings, so any formatter that touches them accepts both and renders nothing rather than
`Invalid Date` for neither.

Every page guards the shape it was handed (`r?.lines ?? []`, `Array.isArray(r?.rows)`) and renders an
empty state: the page-boot probe answers `{}` to any GET it has no fixture for, exactly as a
half-deployed API would.
