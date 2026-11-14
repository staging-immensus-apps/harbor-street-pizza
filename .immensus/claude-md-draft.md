# CLAUDE.md — Pizza Shop Online Ordering

## 1. Product

A phone-first ordering site for one pizza shop. Customers browse the menu, build a basket, choose
pickup or delivery, give a name and phone number (and an address for delivery), and check out —
as a guest, or signed in to a customer account that keeps their order history. The shop owner signs
in with a link emailed to their invited address and gets three screens: a live order queue, a menu
editor and shop settings.

Decided with the owner before the build, and load-bearing:

- **Guest checkout is untouched.** Nobody has to make an account to order. A visitor who is not
  signed in gets exactly the checkout they get today, and the order they place carries no account.
- **Customer accounts, email and password.** Anyone may create one (`accessModel.signUp: "open"`).
  A customer account is role `member`; it changes nothing about who may manage the shop, which is
  still role exactly `admin` and still only the owner's invited address. A forgotten password is
  recovered by an emailed link that signs them in, after which they set a new one.
- **An account lasts until its customer deletes it.** There is no expiry and no inactivity sweep.
  Deleting an account removes the `User` row and clears `customerUserId` on that customer's orders,
  which stay in the shop's records as ordinary orders.
- **A menu item may have one photo.** JPEG or PNG, at most 5 MB as stored, shown on the public menu
  beside the item. The owner may replace or remove it; an item without one looks as it does today.
- **Fixed menu.** No sizes, crusts or toppings. **ASAP only**, no scheduling. **Menu prices are
  final**, no tax line. **Delivery by postcode list**, **one flat delivery fee** the owner sets.
- **Payment through the owner's own Stripe account.** Until that key is in place, checkout places
  the order with `paymentStatus: 'pay_at_store'`. Both paths must keep working.
- **Twelve-month retention on an order's personal details**, unchanged, and it applies the same way
  to a guest order and to a signed-in customer's order. It never touches the account itself.

Form factor: phone. One thing per screen, big tap targets, no side-by-side panes. Look: `studio`.

### This pass

Three things, and nothing else: customer accounts with email-and-password sign-in; a signed-in
customer's order linked to their account and listed on a page of their own; and a photo per menu
item, uploaded in the editor and shown on the public menu.

Out of scope, and not to be "fixed on the way past": saved cards, loyalty or rewards; editing or
cancelling a placed order from the account; attaching a customer's earlier guest orders to a new
account; more than one photo per item or any cropping tool; and any change to who may sign in as
the shop owner. The two open frontend reports from the last pass — new orders needing a reload on
`/manage/orders`, and the 'Estimated ready' wording on the confirmation page — are also still open
and still out of scope here.

## 8. Data model

Five tables in `schema.graphql`. `User`, `MagicLink`, `EmailLog` and `EmailSuppression` come from
the sign-in kit and `StripeEvent` from the payments kit, each in its own `schema.*.graphql` — never
redeclare one, and never `@relationship` across files. **This pass is additive only**: two new
nullable fields and one new table. Nothing is renamed, retyped or dropped.

### The rule that still governs every write: never write a timestamp Harper owns

A field declared `@createdTime` or `@updatedTime` is assigned by Harper in epoch milliseconds. No
record this app writes may carry a key for one — not a fresh value, and not the value just read off
the stored row. Harper refuses such a write with a bare `400` and no JSON body, which is the whole
of the defect that made every menu save and every order-status tap answer "Bad Request". **The trap
is the spread, not the literal**: `{ ...existing, status }` names `updatedAt` because the stored row
has one. Every writer passes its record through `withoutManaged(record, table)` from
`lib/managed-fields.js`, and `managed-fields-probe` holds `MANAGED_FIELDS` equal to the
`@createdTime`/`@updatedTime` fields the SDL declares. The fields are `MenuItem.createdAt`,
`MenuItem.updatedAt`, `Order.updatedAt` and `StoreSetting.updatedAt`.

The new work obeys it in two places that are easy to get wrong: stamping `MenuItem.photoUpdatedAt`
after an upload restates a stored MenuItem row, and clearing `Order.customerUserId` during account
deletion restates a stored Order row. Both go through `withoutManaged()`. **`MenuItemPhoto` carries
no managed field at all** — `uploadedAt` is a plain string the app writes — so replacing a photo
cannot reintroduce the fault on a new table.

The tables:

- **`MenuItem`** — one row per menu item. `priceCents` is whole cents; no floats in money.
  `category`, `available` and `sortOrder` are indexed because the menu is read as `available == true`
  sorted by `category` then `sortOrder`. **New: `photoUpdatedAt`**, a plain ISO string the app
  writes, null when the item has no photo. It is not indexed because nothing filters or sorts by it:
  it is read off rows the menu already has, and it doubles as the `?v=` cache-buster on the photo
  URL so a replaced photo is not served from a stale cache.
- **`MenuItemPhoto`** — **new**. One row per photographed item, `id` = the `MenuItem` id, so an item
  has at most one photo by construction and replacing one is a `put` on the same key rather than a
  uniqueness check Harper cannot make. `data` is a `Blob`: stored outside the record and streamable,
  which is why the bytes never ride along on a menu listing. Per rule 8 the write is
  `new Blob([buf], { type })`, never `createBlob`, and it is **verify-on-write** — read the stored
  blob's size back and delete the row if it does not match what was written, so a half-written photo
  never leaves a record pointing at nothing. The upload body is base64 in JSON rather than raw bytes:
  Harper hands a `Resource` a parsed body, and the base64 path needs no raw-body capture. Limits
  live in one module with the other menu rules: `image/jpeg` or `image/png` only, 5 MB decoded.
- **`Order`** — one row per order, `@table(audit: true)`; the audit store is what lets the owner's
  queue subscribe. `items` is a `[Any]` snapshot of `{menuItemId, name, priceCents, quantity}` taken
  at checkout, so a later price change never rewrites a placed order and **nothing reads a price back
  through `menuItemId`** — including anything to do with photos. `code` is 32 random URL-safe
  characters and is the only key the confirmation page uses. `queue` is derived from `status`, never
  sent. `paymentStatus`/`paymentRef` as today. **New: `customerUserId`**, the `User` id of the
  signed-in customer who placed it and null for a guest order. Indexed, because the customer's own
  list is that equality plus a sort on the indexed `placedAt` — a list page sorting on an unindexed
  field with no filter beside it is a 404, not a slow query. It is written from the session at
  checkout and never from a request body, and it is the only new way an order can be reached.
- **`StoreSetting`** — exactly one row, id `store`, read by primary key, defaults in code.
- **`LoopRun`** — the template's. The nightly retention sweep writes one row per occurrence with the
  deterministic id `clear-personal-details:YYYY-MM-DD`, claimed before the work is done.

Retention is unchanged and is deliberately not extended to accounts: the sweep clears an order's
name, phone, address and postcode twelve months after `placedAt` and stamps
`personalDetailsClearedAt`, whether or not the order has a `customerUserId`, and it never touches a
`User` row. **An account ends only when its customer deletes it.** A cleared order still appears in
that customer's history with its code, date, items, total and status — the personal fields are what
went, not the order.

## 9. Auth and owner rules

`accessModel`: `signIn: "optional"`, **`signUp: "open"`**, `entry: "/"`, `callerAuth: "none"`. The
shop is open to anyone; signing in as a customer adds an order history; signing in as the owner is
what reaches the management screens.

**`signUp` moves from `invited` to `open` this pass, and that is the only change to the front door.**
It is set by the deploy from this field (`AUTH_OPEN_SIGNUP`) and by nothing else — no sentence in
this file turns it on. Open sign-up creates **`role: 'member'`** rows and nothing more: the owner's
seat is still taken only through `ownerMayJoin`/`Bootstrap` or an admin invite, and every management
route still demands role exactly `admin`, re-read from the `User` row on every call. Opening sign-up
must never be read as opening the owner screens.

**There is one sign-in in this app and it is the kit's.** Do not write a second session cookie, a
second credential store or a parallel auth resource. What this pass needs that the kit does not yet
do is added **inside the kit's own files**, which are this app's files now:

- `resources/AuthApi.js` — **`POST /AuthApi/register`** `{ email, password, name? }`: refuses unless
  `config.auth.openSignup()`, normalizes the address, creates the row through `claimUserForEmail`
  with `role: ROLE_MEMBER` (so the tier's account quota still applies and its refusal is surfaced
  verbatim by the page), stores `passwordHash` with the kit's `hashPassword`, and mints the same
  session cookie the other routes mint. An address that already exists gets one generic refusal that
  does not distinguish "taken" from "wrong password" on a later attempt.
- `resources/AuthApi.js` — **`POST /AuthApi/password`** currently requires `row.role === ROLE_ADMIN`.
  It now admits any row with a `passwordHash` that is not deactivated. Everything else stays exactly
  as it is: the same fixed-window counter on `passwordAttemptTimestamps` before the role is looked
  at, the same PBKDF2 burn for an unknown address, the same single message for every failure
  (rule 25), and the same 403 — never a 401 (rule 20).
- `resources/AccountApi.js` — **`PUT /AccountApi/password`** `{ password }` for the signed-in caller,
  on their own row only, and **`DELETE /AccountApi/`**, which deletes the caller's own `User` row and
  first clears `customerUserId` on every order carrying it (indexed equality, `withoutManaged`), so
  the orders survive as guest orders. Both operate on `loadCaller(this)` and accept no id.

**Forgotten passwords reuse the kit's magic link and add no token table.** The customer asks for a
link with the existing `POST /AuthApi/request-link`; `MagicLink` already expires in 900 seconds and
is keyed by the token hash; redeeming it signs them in exactly as it does for the owner, and they
then set a new password with `PUT /AccountApi/password`. No reset-specific token, no second code
path. Email goes out through the kit's `lib/email.js` to `api.resend.com`; with no mail key the kit
refuses with `email_not_configured` and the page says so plainly.

Every resource sets `static loadAsInstance = false` and `target.checkPermission = false` first: this
app's people are `User` rows, not Harper roles, so the row rule in the resource **is** the access
control. An unauthenticated refusal is a thrown `Response` 403 with `code: 'auth_required'`.

| Resource | Rule |
|---|---|
| `MenuApi` | public, read-only, available items only; returns a photo URL, never photo bytes |
| `StoreInfoApi` | public, read-only, shop-level facts; nothing private |
| `MenuPhotoApi` | public, read-only, one photo by primary key. No listing and nothing but the image: a photo is as public as the menu it is on |
| `CheckoutApi` | public write, guest or signed in. **Never trust the basket**: lines re-read from `MenuItem` and re-priced, fee and postcode rule from `StoreSetting`. The caller may not set totals, `status`, `queue`, `paymentStatus`, `paymentRef`, `code` — **nor `customerUserId`**, which comes from the session or stays null |
| `OrderConfirmationApi` | public, reachable only by the order's own random `code`. One order per request, no listing, unchanged for guests |
| `CustomerOrderApi` | **owner rule on `customerUserId`** — the session's user id and nothing from the query. A guest order (null) is reachable by nobody here, and one customer can never read another's |
| `MenuAdminApi` | admin |
| `MenuPhotoAdminApi` | admin |
| `StoreSettingsApi` | admin (reads `LoopRun` for the last-cleared date; never writes it) |
| `OrderAdminApi` | admin — the only place customer names, phones and addresses are listed |

The webhook is the payments kit's `StripeWebhook` and nothing here re-implements it: signature over
the raw bytes, idempotent on the Stripe event id, refuses in the preview copy. It sets
`paymentStatus`, `status` and `queue` on the order whose `paymentRef` matches, and it must not touch
`customerUserId`.

Each new owner-scoped surface gets its own suite: `CustomerOrderApi-probe` drives one customer's
request and asserts the other customer's order is absent and a guest order is absent, with the
negative control being the filter removed; `MenuPhotoAdminApi-probe` asserts the admin refusal, the
content-type and size refusals, and — because the stub accepts any field — the **shape of the record
handed to `db.MenuItem.put`**, which must name no managed field.

## 10. Pages

Phone-first, `studio` look. Ten app routes. `/order/*` is the only wildcard, so `/order` answers too
(rule 26). The sign-in kit's own routes (`/login`, `/auth/verify`, `/invite`, `/account`, `/admin/*`)
come from `routes/spa.sign-in.json` and must not be repeated in `src/routes.ts`.

| Route | Who | What it does |
|---|---|---|
| `/` | anyone | The menu by category with a running basket; photos beside the items that have one. Entry route |
| `/basket` | anyone | Quantities, removals, running total |
| `/checkout` | anyone | Pickup or delivery, name and phone, address and postcode for delivery. Guest by default; prefilled from the customer's last order when signed in, and still fully editable |
| `/order/:code` | anyone with the link | Confirmation: order number, lines, total, fulfilment, payment state, estimate, status |
| `/sign-in` | a customer | **New.** Create an account or sign in with email and password; 'email me a link' for a forgotten password |
| `/my-orders` | a signed-in customer | **New.** Their own past orders, newest first; set a new password; delete my account |
| `/manage` | owner | Hub: how many orders are waiting, links to the three screens |
| `/manage/orders` | owner | The live queue; one tap advances the status |
| `/manage/menu` | owner | Add, edit, hide and remove items; change prices; **add, replace or remove a photo** |
| `/manage/settings` | owner | Pause ordering, pickup/delivery, fee, postcodes, estimates, last-cleared date |

The owner's `/login` stays the owner's: the header's 'Sign in' sends a customer to `/sign-in`, and
nothing links a customer to the invite flow.

**Photos on the page.** `MenuApi` returns `photoUrl` only for an item whose `photoUpdatedAt` is set,
and the menu renders an `<img>` only when it is there — no placeholder element, no request, no
broken image for an item without one. The image sits in a fixed-size frame with `loading="lazy"` so
the list does not reflow as photos arrive, and an `onError` hides the frame rather than leaving a
broken icon. In the editor the chosen file is drawn to a canvas and re-encoded as JPEG no wider than
1200 px before upload, which is browser code and needs no package; the server's 5 MB and
content-type checks are the guard behind it, not the mechanism.

Every page guards the shape it was handed (`r?.lines ?? []`, `Array.isArray(r?.rows)`) and renders an
empty state: the page-boot probe answers `{}` to any GET it has no fixture for, exactly as a
half-deployed API would. `/my-orders` must boot for a signed-out visitor and show the prompt, and
`createdAt`/`updatedAt` still arrive as epoch-millisecond numbers on rows written since the managed-
fields fix and as ISO strings on older ones, so any formatter accepts both.
