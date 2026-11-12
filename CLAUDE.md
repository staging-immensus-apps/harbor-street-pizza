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

## 2. Stack

Node 24, ESM (`"type": "module"`), no semicolons, single quotes, 2-space indent. A Harper
5.2 application deployed as-is: `harper deploy . restart=rolling replicated=true` from
the repo root, one `config.yaml` that is identical in dev and on the cluster. Frontend:
React + Vite + shadcn in `src/`, built by `vite build` into `web/` with `base: '/web/'`,
served by Harper's `static` plugin at `/web/`; `resources/Pages.js` registers one `server.http`
listener (`lib/pages.js`) that serves `web/index.html` for `/` and every route in `routes/spa.js`, and
`GET /build`. **There is no `fastifyRoutes`**: Harper serves one component's per process, and an
update runs a preview copy of this app beside the published one (rule 30). Harper's `dataLoader` loads
`data/production/*.yaml` at start (rule 31). Runtime deps live in
`dependencies`, build tools in `devDependencies`: Fabric installs with `--omit=dev`.

- `npm run dev` — `harper dev .` serves the API on 9926; `npm run dev:web` runs `vite` on
  5173, serving `src/` with HMR and proxying every path whose first segment is capitalised — a
  Harper resource is a class name — and `/build` to it (`vite.config.ts`, SEEDED; no resource is
  named there, so a kit needs no edit).
- `npm run build` — `vite build` into `web/`. Must run before any deploy.
- `npm run typecheck` — `tsc --noEmit` over `src/` and `vite.config.ts`.
- `npm run deploy` — `scripts/deploy.js`: refuses a missing/stale `web/`, refuses a localhost
  `CLI_TARGET`, then `harper deploy . restart=rolling replicated=true`. Never run by a session.
  **The BINARY is `harper`** — the 5.x package is `harper` and declares that name alone, where the
  4.x `harperdb` declared both; `CLI_BIN` in that script is the one spelling and
  `deploy-gate-acceptance` holds it against the package `deploy-shared.yml` installs.
  **`'harperdb'` as a MODULE SPECIFIER is a different thing and does not move** — it is what the
  Harper runtime resolves inside a component (rule 5, rule 18, `deps-acceptance`'s `HOST`), and so
  is `engines.harperdb`, which npm never resolves against the registry.
- `npm run template-manifest` — rewrites `.immensus/template.json` after a change to a SEEDED
  file. `-- --check` is the template repo's own gate (pr-check, repository-scoped); `-- --diff`
  reads the provenance back and has no verdict.
- `npm run apply-look -- <id>` — writes one of `looks/*.css` into `src/index.css`;
  `-- --list` names the five. **The five are ready-made starting points, not a limit**: an app may set its own fonts and colours in `src/index.css`'s tokens instead,
  declared with `CUSTOM_LOOK_LINE` (§4 rule 29).
- `npm run suites` — every hermetic suite (`scripts/run-suites.js`, §6).
- `node scripts/run-suites.js --self-test` — proves the runner can still say no.
- CI: `.github/workflows/pr-check.yml` (jobs `check` and `acceptance`, no secrets — and
  **whether `acceptance` runs the suites at all is itself a gated decision**: they are
  skipped while the pull request is a draft, from **one live API read of the pull request as it
  is** rather than from the event payload, written `!= 'true'` so that only a positive live
  `true` skips. *A guard that decides whether to run a required check must fail toward running
  it.* `harness-acceptance`'s `prCheckDraftProblems()` is the gate, and half of it **executes**
  the resolution script against a stubbed `gh` rather than reading it). **In an app the test
  harness is absent (§6), so `check` skips the runner's self-test and `acceptance` type-checks,
  builds, skips the suites and says so.**
  `agent-review.yml` (Claude reviews every non-draft PR; the workflow posts the comment and
  verifies it landed). **`review` is never green when nothing reviewed the diff**: with no token it
  looks for the builder worker's review of this commit and is red if there is none, and on a draft
  the job reads `skipped`. `deploy-shared.yml` / `deploy-prod.yml` / `deploy-staging.yml` ship
  **disabled** (`vars.DEPLOY_WORKFLOWS_ENABLED`): the builder worker runs the same gates and
  `scripts/deploy.js` from the merged commit on every tier; the workflows
  are documentation and the Builder-tier fallback.

## 3. Layout

```
config.yaml                 SEEDED     loadEnv CONFIG.env · rest · graphqlSchema · jsResource · static at /web/ · dataLoader data/production/*.yaml — NO fastifyRoutes (rule 30)
package.json                GENERATED  runtime deps (only what resources/ lib/ routes/ import) vs devDependencies; suite scripts by name
schema.graphql              GENERATED  the app's own tables, written whole by the builder at plan time; the template's only one is LoopRun
                                       (the scheduler's). config.yaml loads EVERY schema*.graphql, so a kit brings its tables in a file of
                                       its own (schema.sign-in.graphql, schema.payments.graphql). NO export directive;
                                       @indexed on anything sorted or filtered; never declare a table a kit already has
CLAUDE.md                   GENERATED  this file: seven sections, fixed shape, then the app's own from §8 up. The builder drafts the title line,
                                       §1 and §8 up, keeps §2–§7 from here, and appends decisions and §7 gotchas after each job
.immensus/template.json     SEEDED     PROVENANCE: template, version, and the blob sha of every SEEDED file as shipped.
lib/                        SEEDED     config.js (every getter reads THIS COPY'S OWN CONFIG.env, process.env only when there is none;
                                       DEFAULT_DATABASE; rule 30 — EXCEPT the five PER_APP_VALUES the secret store may deliver, read
                                       through secretSource; the core reads only the AI key, config.modelApiKey(name); the readers a kit
                                       needs are exported — required optional nonNegNumber flag isBlank secretSource) · db.js (THE table
                                       set, bound to the database IMMENSUS_DATABASE names and resolved LAZILY — the only module in
                                       resources/ lib/ routes/ that may import tables or databases, rule 18) · copy.js (which copy this
                                       is: isPreviewCopy, copyBase, previewPath, publicBaseFor, sharingMounts, refuseOnPreview; imports only config.js,
                                       rule 30) · pages.js (the page listener: routes/spa.js's routes AND every routes/spa.<kit>.json,
                                       and GET /build, at this copy's own address, declining the other copy's) · http.js (json redirect
                                       queryParams runAuthed). NOTHING ABOUT ACCOUNTS OR PAYMENTS: those are kits, below.
                                       GENERATED seams the SEEDED files load lazily when present: lib/loops/index.js.
resources/*.js              SEEDED+GEN Pages (REGISTERS lib/pages.js's listener and exports NO Resource — `server` is a global only in the
                                       modules jsResource loads, so the registration lives here and the rule lives in lib/pages.js) ·
                                       Scheduler (arms the module-scope interval; exports NO Resource either — schedulerStatus() is for a
                                       kit's admin page) (SEEDED); one <Entity>Api.js per entity the app plans (GENERATED)
routes/*.js                 SEEDED+GEN PLAIN MODULES, not Fastify plugins (rule 30): build.js (buildStamp(), from this copy's own
                                       CONFIG.env) · apex.js (apexTarget, 301 apex→www) (SEEDED); spa.js (GENERATED from
                                       src/routes.ts: SPA_ROUTES and nothing else — lib/pages.js serves them; a `/x/*` entry
                                       answers `/x` too, rule 26). Never imports harperdb (rule 5). A kit's page routes are
                                       routes/spa.<kit>.json, which lib/pages.js and src/discovery.ts both read
index.html vite.config.ts   SEEDED     Vite entry; base '/web/', outDir web/, dev proxy to harper dev
tsconfig.json tailwind.config.js postcss.config.js  SEEDED
src/index.css               GENERATED  the restyle seam, and the one src/ file called out separately: the 19 shadcn colour
                                       variables in both themes plus --radius — one of the five looks, written by
                                       scripts/apply-look.js, OR the app's own, declared by CUSTOM_LOOK_LINE. NOT in
                                       SEEDED_PATHS on purpose — tailwind.config.js is, so the theme CONTRACT comes from
                                       the template and the VALUES are the app's. The template ships the un-looked default,
                                       which is not a sixth look (there is no global default; the builder recommends one
                                       per app); looks/baseline.css is its seeded peer and carries the reference assertions
src/**                      GENERATED  React + Vite + shadcn, from the baseline design.
                                       routes.ts (the app's own routes: `/` and nothing else in the template) · App.tsx (the router: the
                                       app's routes and every kit's, each page found by FILE NAME under src/pages/, a kit's provider and
                                       guard around them) · discovery.ts (SEEDED — finds pages, kit routes and kit extensions with
                                       Vite's import.meta.glob) · api/client.ts (typed wrapper; a 403 code redirects only where a
                                       kit registered one, onApiRefusal) · api/types.ts (response shapes, types only; empty in the
                                       template) · pages/Home.tsx · components/shell.tsx (the frame: the app's name and whatever a kit adds
                                       to the header, plus PageHeading) · components/ui/{alert,badge,button,card,dialog,input,label,
                                       select,table}.tsx · lib/{utils,format}.ts
public/                     GENERATED  unhashed files (favicon.svg); lib/pages.js stamps ?v=<processStartedAt> on them
web/                        BUILT      vite build output; gitignored; must exist before deploy
data/*.yaml                 GENERATED  TEST rows (explicit database/table/records form), loaded only in the preview copy; none in the template
data/production/*.yaml      GENERATED  real starting data the plan marks production: true, loaded in every copy (rule 31); none in the template
scripts/run-suites.js       HARNESS    discovers *-acceptance | *-probe | check-* from package.json; --self-test.
                                       NOT SEEDED: it is the instrument, not the app. It stays in
                                       THIS repository because pr-check runs it, and the platform copies it into each
                                       build workspace. No product file may import it
scripts/deploy.js           SEEDED     build-before-deploy + localhost guard, then `harper deploy` (CLI_BIN)
scripts/build-stamp.js      SEEDED     per-node six-sample stamp reader; check-build-stamp runs its --self-test
scripts/template-manifest.js SEEDED    SEEDED_PATHS and .immensus/template.json. Deliberately NOT named by the suite convention,
                                       so run-suites.js cannot discover it and no app ever runs it as a check.
                                       --write (default) · --check (TEMPLATE REPO ONLY, pr-check) · --diff (a report, always 0)
                                       · --self-test
looks/                      SEEDED     the five looks (studio harbor grove bloom paper) — ready-made
                                       starting points, not the only styles an app may have:
                                       looks.json (names, one-line descriptions, fonts, radii, every colour as hsl + hex)
                                       and one .css each — 19 colour variables × two themes, --radius, one font.
                                       PLUS baseline.css: the un-looked baseline, a SEEDED peer of the src/index.css the
                                       template ships, because a reference apply-look.js OVERWRITES is not a reference. NOT a sixth look — it is in neither looks.json's order nor its looks, so
                                       lookIds() cannot return it and apply-look.js refuses it by name
scripts/apply-look.js       SEEDED     writes ONE of the five into src/index.css — NOT the only writer of that file: an app
                                       may set its own tokens and declare them with CUSTOM_LOOK_LINE, which isCustomLook()
                                       reads back. Composes rather than copies: the @import first, @tailwind, the
                                       look's tokens, the template's base rules, .dark hoisted OUT of @layer base (§7),
                                       app CSS preserved
scripts/probe/              HARNESS    harperdb-stub (get put patch delete search create) loader google-auth-stub anthropic-stub svix-sign
                                       frozen-clock shift-clock harness (checker fixture walk stripComments, PLUS the app-kind reader
                                       the web-only suites skip on — APP_KINDS_WITH_PAGES, appHasPages, skipForNoPages: it lives
                                       in the harness because the harness is MOUNTED rather than seeded, so it is the one module an
                                       app cannot edit out from under its own suites — and the mount is PINNED BY COMMIT on
                                       the platform, so a suite reads new harness names through a NAMESPACE
                                       import with a per-name fallback, never a named import, which would be a link error on any
                                       workspace whose pin predates them) resource-call (call/userWithCookie/responseRulesVerdict).
                                       Nine doubles. NOT SEEDED, same as the runner beside them;
                                       a SUITE may import these, and nothing else may (deps-acceptance). ALSO here and NOT
                                       a double, NOT pinned and NOT a suite: secret-store-drive.mjs, the real-cluster
                                       measurement behind lib/config.js's per-app-secrets exception
scripts/*-acceptance.js     SEEDED+GEN harness page-boot page-boot-kind db-module db http preview deps spa-routes schema-lint builtins immensus-auth
                                       deploy-gate look suite-verdicts + scheduler-probe (SEEDED); one per invariant the builder introduces
                                       (GENERATED). A kit's suites arrive with the kit and are registered by its package.json
kits/                       KIT        NOT SEEDED: reviewed
                                       code the platform COPIES into an app when its plan needs it, every
                                       file at the path it occupies in an app, never over a file the app already has. sign-in/ (sign-in
                                       by emailed link, Google and password, the owner as first administrator, members, admin, invites,
                                       mail; lib/auth.js and resources/AuthApi.js are the files the platform calls into) and payments/
                                       (the user's own Stripe account: lib/stripe.js, resources/StripeWebhook.js). Each kit VENDORS the
                                       helpers the other three templates do not export, in lib/sign-in-support.js (twelve) and
                                       lib/payments-support.js (refuseOnPreview) — without them a kit copied into an agent, service
                                       or pipeline app does not start. kits/README.md has
                                       the seventeen core names a kit MAY take and the re-measurement rule. Each carries a
                                       package.json that is MERGED into the app's (dependencies, scripts), not copied.
                                       assemble.mjs builds the core with kits for CI (§6).
.github/workflows/          SEEDED     pr-check.yml · agent-review.yml · deploy-shared.yml · deploy-prod.yml · deploy-staging.yml
.claude/agents/             SEEDED     pm.md qa.md review.md back-end.md front-end.md — the charters every app inherits
.claude/commands/           SEEDED     /pm /qa /review /dispatch
```

CONFIG.env keys the SEEDED code reads (all via `lib/config.js`, from THIS COPY's own file; written at deploy time): `PUBLIC_APP_URL`,
`APP_NAME`, `IMMENSUS_DATABASE` (which database this deploy reads; **unset means `data`**, so the app runs on any Harper with no
Immensus anywhere — rule 18), `IMMENSUS_PREVIEW` (`true` in the preview copy's file and absent from every other — **absent is the
published copy**; a preview copy reading `data` REFUSES, because its path is public — rule 30), `IMMENSUS_URL_PATH` (the path this
copy is mounted at — `preview`, a sharing app's `tracker`, its preview's `tracker/preview`; **absent or blank is the root**, or
`/preview` for a preview copy deployed before the builder wrote it — rule 30), `IMMENSUS_SHARING_MOUNTS` (comma-separated, the
other apps' mounts the app at the root must not answer), `APEX_REDIRECT_TO`, `BUILD_*`.

A KIT READS ITS OWN, through the core's readers and from the same file. The sign-in kit (`lib/sign-in-config.js`):
`SESSION_SECRET`, `SESSION_TTL_HOURS`, `AUTH_OPEN_SIGNUP` (the deploy writes it from the plan's `accessModel.signUp`, and
missing means closed), `MAGIC_LINK_RATE_LIMIT`, `MAGIC_LINK_RATE_WINDOW_MINUTES`,
`GOOGLE_CLIENT_ID`, `RESEND_WEBHOOK_SECRET`. The payments kit (`lib/payments-config.js`): `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET` (**the USER's own**, sealed on the control plane's `app_env` row and never minted by us — a payment runs
through the user's own Stripe account with the platform out of the path; test and live are the user's too,
because Stripe issues those keys separately, so "go live" is swapping the key and there is deliberately no mode variable to disagree
with it). The platform writes these keys into every app's `CONFIG.env` whether or not a kit reads them; in an app with no kit
nothing does. `TURNSTILE_SECRET_KEY` is read by nothing.

FIVE NAMES THE PLATFORM NEVER WRITES INTO `CONFIG.env` ARE READ ANYWAY, because the control plane delivers them after the build into
the app cluster's Harper secret store with `processEnv: true`, or for `OWNER_EMAIL`
by whichever channel it chooses: `RESEND_API_KEY` and `EMAIL_FROM` (the user's own Resend key and the
address on its sending domain, read as ONE pair), `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (the user's AI-service key, by the vendor's
own name, through `config.modelApiKey(name)`, which throws for any other name), and `OWNER_EMAIL` (the app owner's address, not a
secret). This copy's own file still wins when it carries a non-blank value; absent or blank there, `process.env` is read
(`secretSource`). **The LIST, `PER_APP_VALUES`, is the core's** — it is the whole set of names allowed to cross between the two
copies through `process.env`, and `preview-acceptance` pins it — while the readers of the mail pair and the owner's address are the
sign-in kit's (`sign-in-preview-acceptance` drives them). GENERATED code reads one more: `IMMENSUS_TIER` (`trial` | `tinkerer` |
`builder`, via the sign-in kit's `lib/plan.js`; anything else is `trial`).

## 4. Conventions

The generation rules. Each is checkable; the gate is named where one exists.

1. `static loadAsInstance = false` on every `Resource`, and `target.checkPermission = false` — V2 API; without it `target` is not the request target. Gate: pr-check grep, reviewer.
2. Class name ≠ table name (`MembersApi` for `Member`) — `Conflicting paths for X` at startup. Gate: schema-lint.
3. `post(target, data)`: the body is the second argument, never `request.body`. Gate: reviewer.
4. Sub-paths via `segmentsOf(target)`, not `target.pathname` directly: Harper sets no `pathname` for `/XApi?a=1` (#111). Query via `queryParams()` with the `getContext()` fallback — `target.searchParams` is empty on sub-path routes (a suite once passed 57/57 against a fixture richer than Harper). Gate: the stub does not populate `searchParams`; `http-acceptance`; reviewer.
5. `routes/*.js` never imports `harperdb` or anything that does. The platform imports `routes/build.js` STANDING ALONE under plain node to prove a deploy can be confirmed, and a module that reaches `harperdb` does not load there. Gate: pr-check import-graph walk; `builtins-acceptance`.
6. `@indexed` on every attribute you sort or filter by — unindexed search returns empty silently. Gate: schema-lint.
7. `@relationship(to:)` is array-typed; `from:` is singular. Gate: schema-lint.
8. Blobs: `new Blob([buf], {type})`, never `createBlob`; verify-on-write, delete the row on mismatch. Gate: pr-check grep, reviewer. **The template ships no helper for this**, so an app that stores files writes the verify-on-write step itself, to this rule.
9. HNSW only via `[Float] @indexed(type: "HNSW", distance: "cosine")` in the schema; brute force under 5k rows otherwise. Gate: schema-lint.
10. Short-lived tokens live on `@table(expiration: N)` tables keyed by the token hash, never by PII. Gate: schema-lint.
11. `??` only when `null`/`undefined` is what you mean; blanks are absent (`''` from `optional()` once reached users as "Unnamed plant"). Gate: reviewer.
12. Probe static files with GET, not HEAD — Harper's static plugin answers HEAD with 404. Gate: deploy smoke table.
13. Never trust one post-deploy sample: six agreeing samples on two polls, per node. Gate: `build-stamp.js` exit 4.
14. Every page module boots under the page-boot probe — 59 green suites and a blank page in prod (TDZ under top-level `await`). Gate: `page-boot-acceptance`. It asks for at least one page module, because with none it would report green having asserted nothing. **An app with no user interface at all** declares its kind in `IMMENSUS_APP_KIND` and the probe skips with its reason printed; `spa-routes`, `look` and `page-boot-kind`'s driving half honour the same declaration, through the reader in `probe/harness.js`. The kind comes from **outside the tree** — the platform passes the one the user confirmed — because a floor keyed on a file in the tree is a floor the app can edit away. Gate: `page-boot-kind-acceptance`.
15. Never `harper deploy` or `install_node_modules` against localhost — it strips devDeps in place. Gate: `deploy.js` refuses a localhost `CLI_TARGET`.
16. Runtime deps in `dependencies`, build tools in `devDependencies` — `--omit=dev` plus one runtime import of a devDependency link-fails every resource (`ERR_VM_MODULE_LINK_FAILURE`). Gate: `deps-acceptance`.
17. Schedulers live at module scope in `resources/Scheduler.js`, `globalThis`-guarded, first tick delayed 5 min — a Fastify-plugin scheduler never ran once. **The preview copy never arms one and never touches the guard** (rule 30). It serves no endpoint of its own: the sign-in kit's AdminApi answers its status at `GET /AdminApi/scheduler`. Gate: reviewer rejects `setInterval` elsewhere; `preview-acceptance`; `scheduler-probe`.
18. **`db.<Table>` from `lib/db.js`; never `tables` or `databases` anywhere else in `resources/`, `lib/` or `routes/`.** One database per app — and WHICH one is a **deploy-time value**, so a staging build and a published one are the identical tree with a different `IMMENSUS_DATABASE` in `CONFIG.env`. Three things about it are not preferences. A stray `tables.X` reads the **default** database while every line around it reads the configured one, so a staging deploy would write to `stage` and that one resource would read production with nothing red anywhere. An **unset** variable means `data`, because the app must run on any Harper instance with no Immensus anywhere, so that getter is `optional()` and must never become `required()`. And the lookup is **lazy**: resolving at module load captures `undefined` for good when the component is deployed before the database exists, and a new database takes 0.08–0.49 s to reach every worker (measured on a live 5.3.1 cluster), so the window is short and real. Gate: `db-acceptance` for the behaviour, with the module-load shape synthesized and driven FIRST; `db-module-acceptance` for the rule; and the pr-check grep for the **import** only, because this workflow is seeded and `tables` is an ordinary noun in somebody else's app.
19. Every non-admin write sets the owner field from the session; every read filters by it. A missing filter is a cross-owner data leak, the worst bug this codebase can have. Gate: reviewer item 1; the stub's owner probe per entity.
20. Auth failures are a thrown `Response` 403 with `code: 'auth_required'`; never `statusCode: 401` — Harper appends `WWW-Authenticate: Basic` and the browser pops a dialog. Gate: pr-check grep.
21. Never call `fastify.head()`; Fastify adds HEAD to every GET — one hand-registered HEAD disabled every route on the cluster with a cryptic 500. Gate: pr-check grep.
22. `static` is mounted at `urlPath: 'web'`, never `/`; Vite `base` is `/web/` — static at the root swallows requests before the page routes see them. The preview copy's is `preview/web`, built with that base, by the builder at deploy time. Gate: `harness-acceptance` reads the mount back out of `config.yaml`; `spa-routes-acceptance`.
23. Never register anything under `/.well-known/` — Fabric's ACME component answers `/.well-known/acme-challenge/*` on every cluster with a custom hostname. Gate: pr-check grep.
24. Node builtins in `resources/`, `lib/`, `routes/` only through what Harper's ESM linker links; sync spawn (`execFileSync`, `spawnSync`, `execSync`) via `createRequire` or a CommonJS helper — one unlinkable named import takes every route down with `ResourceLoadError`. Gate: pr-check grep.
25. Every credential check sits behind a fixed-window counter on the row it checks (`magicLinkSendTimestamps`, `passwordAttemptTimestamps` in the sign-in kit's `lib/auth.js`); a refusal is the same generic 403 as a miss, never a 401 or a distinct code. Gate: the sign-in kit's `auth-acceptance` (the eleventh attempt with the right password is refused; a self-tested verdict).

26. A wildcard page route answers its BARE path too — `/x/*` serves `/x`, `/x/` and `/x/y/z` —
    because the bare path is the one a person types and the in-app link points at. `lib/pages.js`'s
    matcher has that built in, so `routes/spa.js` lists `/x/*` once; one trailing slash is ignored.
    Gate: `spa-routes-acceptance` drives the REAL listener for every route with and without a
    trailing segment, at both copies' addresses, against its own independent reading of `src/routes.ts`.

27. Never authenticate to an **Immensus** endpoint with `Authorization` — Harper authenticates that
    header at its own REST boundary and answers 401 `{"error":"invalid token"}` before any
    resource runs, even for a route that does not exist, so a bearer scheme against a Harper app
    is unreachable by construction and surfaces as a 401 the app can neither read nor explain.
    Nothing in this tree calls an Immensus endpoint at all. The payments kit's `lib/stripe.js` sends
    `Authorization: Bearer <the user's key>` to `api.stripe.com`, which is correct, because that is not
    a Harper app, so the gate has to tell the two apart. Gate: `immensus-auth-acceptance`.

28. **Never re-export from another module in `resources/`, `lib/` or `routes/`** — import the names
    and export the local bindings. A re-export-from makes its own module request, so beside an
    `import` of the same specifier it is TWO requests for one module, and Harper's ESM linker left
    the importing module UNLINKED: every resource answered 500 `ResourceLoadError … request for
    'node:crypto' can not be resolved on module lib/auth.js that is not linked`, naming an import
    that had been there for weeks. Rule 24's shape one level out — the unlinkable thing is the
    duplicate request, not the builtin. Measured on a live cluster; the single-request form is
    unmeasured and refused anyway, because the two read identically and the remedy is one line.
    Gate: `builtins-acceptance`.

29. **A look is a TOKEN SET; form factor is a LAYOUT. They are two seams and they do not
    substitute for each other.** `looks/` holds five named token
    sets, each 19 colour variables in both themes plus one `--radius` and one font. Which seam
    serves which axis:
    - **The look** — colour, radius, type — is `src/index.css`: either one of the five, written
      by `node scripts/apply-look.js <id>`, or the app's own (below). One file, never a per-page
      concern, never a hard-coded hex in a component (front-end charter 7).
    - **The form factor** — "mostly phone" vs "mostly computer", which sections exist, where
      navigation lives — is `src/components/shell.tsx` and the pages. Both are GENERATED for
      exactly that reason.
    A look may not add a component: `src/components/ui/` is the kit and the Frontend stage's stop
    condition is *"a component outside the kit"*, so a direction needing another is a direction we
    cannot deliver. And a form factor expressed as colours cannot be swapped,
    while a look expressed as layout cannot be chosen. **There is no default look**: the un-looked
    `src/index.css` is the baseline, and the builder recommends one per app with a reason.
    **The baseline is ALSO pinned at `looks/baseline.css`**, which is what the gate
    measures a looked build against, because `src/index.css` cannot be both the seam and the
    reference.
    **The five are a starting choice, not a limit.** **An app may set its own fonts and colours**: change the nineteen
    colour tokens in both themes where `src/index.css` declares them (not a second set below the
    marker), `--radius`, the font on `body`, keep `.dark` outside `@layer base`, and put
    `CUSTOM_LOOK_LINE` (`scripts/apply-look.js`) in place of the comment that names a look:
    `/* Custom look: set for this app, not one of the five in looks/. */` — the reader requires only
    a comment whose first words are `Custom look:`, so a reworded tail still counts.
    So a stylesheet is in ONE OF THREE STATES and says which: the provenance line `apply-look.js`
    writes names a look (`lookedFrom()`), `CUSTOM_LOOK_LINE` declares the app's own
    (`isCustomLook()`), and a file with neither is the un-looked baseline. The declaration is
    required rather than inferred from "the values differ", because a difference is also what drift
    looks like. Applying one of the five over a custom look replaces it. Gate:
    `look-acceptance`.

Also: async iterators for reads (`for await (const row of db.X.search({...}))`); return `new Response(JSON.stringify(...), { status, headers })`; comments explain why, never what the next line does; kebab-case filenames.

30. **AN UPDATE IS LOOKED AT IN A SECOND COPY OF THIS APP, RUNNING BESIDE THE PUBLISHED ONE IN THE SAME
    PROCESS — so each copy reads ONLY its own configuration, serves ONLY its own address, and asks
    nothing of the request.** The **published copy** is this repository
    deployed as it is, at the app's own address, reading `data`. The **preview copy** is the same tree
    deployed by the builder under its own component name with every plugin mounted under `/preview`,
    every table declared in `stage`, its seed pointed at `stage`, its shell built for `/preview/web/`,
    no `loadEnv`, and `IMMENSUS_PREVIEW=true` in its `CONFIG.env` — **all at deploy time, in the
    builder's checkout, never committed here**, so this repository deployed as-is anywhere is still an
    ordinary app at the root on `data`. Measured with no cross-over on one `harper@5.3.1` and on a
    two-node Fabric cluster. These things follow:
    - **Every value comes from the copy's OWN `CONFIG.env`, never `process.env` while that file
      exists** (`lib/config.js`). `loadEnv` fills one `process.env` for every component,
      first-writer-wins; with two copies the preview was measured reading production four restarts in
      eight. A `CONFIG.env` that exists and cannot be read THROWS rather than falling back. **The one
      exception is the four per-app secrets the secret store delivers** (§3's last paragraph):
      they are the same for both copies by construction, and Harper puts them in `process.env` before
      any `loadEnv` runs, so no copy can write them for the other.
    - **Which copy this is comes from that file, and every "am I the preview?" asks `lib/copy.js`**:
      emailed links and server-issued `Location`s carry `/preview` in the preview copy
      (`publicBaseFor`, `previewPath`), `Bootstrap` and the two inbound webhooks refuse there
      (`refuseOnPreview` — keyed on *who calls*, not on danger), the scheduler never arms there, and a
      preview copy pointed at `data` refuses, because its path is public. A session is stamped with its
      database inside the signed payload, so one minted in either copy is refused by the other — one
      origin means one cookie slot, and a cookie name or `Path` cannot be the guard.
    - **Pages and `GET /build` come from `resources/Pages.js`'s `server.http` listener, never
      `fastifyRoutes`** — Harper serves one component's `fastifyRoutes` per process and drops the
      second's with one WARN line. The published copy's listener declines everything under `/preview`,
      even through its own catch-all; the preview copy's answers only there. Gate: `harness-acceptance`
      refuses a `fastifyRoutes` block.
    - **WHERE a copy is mounted is `IMMENSUS_URL_PATH`, and it is a different fact from whether it is the
      preview.** A SHARING APP — an app in another app's cluster —
      is this same tree at `/<slug>`, and its preview copy at `/<slug>/preview`. Everything that
      composes a URL follows `copyBase()` (`previewPath`, `publicBaseFor`, the page listener, and the
      client's `BASE`, which reads the mount out of its own bundle's URL because the builder rebases the
      shell onto `/<mount>/web/`); everything that asks *am I looking at dummy data* keeps asking
      `isPreviewCopy()`, so a sharing app's published copy takes its own webhooks and runs its own
      scheduler, under a guard named for its mount. Every copy declines its own `<mount>/preview`, and the
      app at the root declines each mount in `IMMENSUS_SHARING_MOUNTS`, so no root route — `/:slug`,
      `/*` — can answer a sharing app's path whichever component loads first.
    - **Nothing in the published copy may rewrite or answer a `/preview` request.** Beside a second
      copy, that made the preview address serve the PUBLISHED code.
    Gate: `preview-acceptance`, which builds two copies of this tree in two directories with two
    `CONFIG.env` files, loads both in one process with `process.env` poisoned by the other, and drives
    every listener the published copy registers with a `/preview` request.

31. **`data/*.yaml` is test data and never reaches production; `data/production/*.yaml` is real
    starting data and does.** `config.yaml` loads only the second, and the builder loads both, into
    `stage`, in the preview copy it deploys. Put a fixed list the app cannot work without in
    `data/production/`, and never accounts. Harper writes a file's row again on every start if it is
    missing from the table (`harper@5.3.3`, 2026-11-06), so a row in `data/production/` cannot be deleted
    from the app while its file is there. Gate: `harness-acceptance` reads the glob; the builder's lint
    (`immensus-builder`) refuses accounts in that folder.

## 5. Coordination (multiple parallel sessions)

- The default branch `main` is protected. Every change goes through a PR — no exceptions.
  On Trial and Tinkerer the only session is the builder; the shape below is kept anyway so
  a tier upgrade adds humans without a rewrite.
- Before writing ANY code for an issue, claim it:
    gh issue edit <N> --add-label "status:in-progress,session:<your-name>"
    gh issue comment <N> --body "Picking this up — <your-name>"
- Then isolate: create a worktree, commit an empty start marker, push, open a draft PR:
    git worktree add -b agent/<slug>-<yyyymmdd> ../<repo>-<slug> origin/main
    cd ../<repo>-<slug>
    git commit --allow-empty -m "start: <short desc> (#<N>)"
    git push -u origin agent/<slug>-<yyyymmdd>
    gh pr create --draft --title "..." --body "Fixes #<N>"
- WHY the worktree is not optional: parallel sessions share one filesystem and one
  `.git`. If two sessions work in the primary checkout, a `git checkout` in one silently
  switches the working tree under the other — files vanish mid-edit, changes land on the
  wrong branch, commits get contaminated — and the victim has no way to notice until the
  damage is done. A worktree is a full working directory pinned to your branch with its
  own HEAD, sharing the object store, which removes the entire failure class. Every
  session's first move is its own worktree, even when you believe you are alone.
- `gh issue list --label status:in-progress` is the live board of who is doing what;
  `gh pr list --draft` is the live board of in-flight branches. In the builder, Job rows
  and labels are the same board.
- **You merge your own work. Do not park a finished PR for a human.** Before merging, ALL of these
  must hold:
  - every required check is **green**, and the PR reports **`MERGEABLE`** with
    `mergeStateStatus: CLEAN` — `gh pr checks <N>` and
    `gh pr view <N> --json isDraft,mergeable,mergeStateStatus`;
  - **and `acceptance` ACTUALLY RAN THE SUITES — read the job's steps, not the badge**. A
    green `acceptance` that skipped every suite is a real state, and
    its conclusion genuinely is `success`, so no reading of the colour or of the conclusion can
    tell. The step is named **`Acceptance + probe suites`**:
    `gh api repos/<owner>/<repo>/actions/jobs/<jobId> -q '.steps[] | "\(.conclusion // .status)  \(.name)"'`
    — it must read `success`, never `skipped`. (In an app the runner is not in the repository, so
    this step always reads `skipped` and `acceptance` covers the type-check and build only; the
    suites are the build's.) The jobId is in the check run's `details_url`
    after `/job/`. The draft guard narrows that window and does not close it, and a **cancelled**
    required check reports no verdict at all — both are invisible in a pull request list
    and both are visible here;
  - the PR is **out of draft**;
  - it is **your own** branch. Never merge another session's PR, however finished it looks —
    a session marks ready and then keeps working, and the last review round is where a
    reviewer's findings are sharpest. `gh issue list --label status:in-progress` and
    `gh pr list --draft` are how you tell whose it is;
  - **your own** last review round is answered, not merely opened.
- On merge: `gh pr merge <N> --squash --delete-branch`, remove your labels, close the issue,
  remove the worktree, and delete the local branch. **Leave every checkout on `main`, pulled
  and clean** — `--delete-branch` otherwise strands a checkout on a branch that no longer
  exists. Then redeploy and verify, and **still report what you merged**: the PR number, the
  resulting `main` HEAD, and anything left over. Merging does not replace the report. Labels
  do not clear themselves.
- If blocked: swap `status:in-progress` for `status:blocked` and comment the exact ask —
  name the dashboard, the setting, the decision. Vague "needs input" is banned. In the
  builder this is a Question card.
- Stop and report — never improvise — when an action involves money, credentials, external
  dashboards, irreversible data operations, or a product judgment call. Prepare the work,
  then stop and hand it to the human.
- Commands: `/pm` (triage), `/qa <PR#>|last <N>` (verify), `/review <PR#>` (review),
  `/dispatch <back-end|front-end> <task>` (launch a doer). Headless: `claude -p 'Use the
  Agent tool with subagent_type "<area>" ...'` — there is no `--agent` flag.

## 6. Verification

- Evidence tiers govern every claim that something works:
  1. Functional probe — call the endpoint, run the code, load the page. Proof.
  2. Observed change with a timestamp — proves something occurred, not that it worked.
  3. Stored metadata — a status field, a flag, a log line. A hint, never proof.
  When a claim can be checked by exercising the thing, exercise it. State which tier your
  evidence came from in every report, PR body, and builder stage result.
- Hermetic suites are `scripts/*-acceptance.js`, `*-probe.js`, and `check-*` scripts in
  `package.json`; `scripts/run-suites.js` discovers them by name (no second list), rejects a
  suite that spawns `git`, re-runs every suite at two shifted clock instants and requires
  the same verdict, and treats empty discovery as failure. Rules: no network, no secrets,
  no git state, no wall clock (`freezeClock()` from `scripts/probe/frozen-clock.js`),
  sub-second each, and a negative control in every suite (assert the NO case too).
- `scripts/run-suites.js` and `scripts/probe/` are not in an app's repository: they are copied
  into the build workspace when checks run. A suite may import them and nothing else may, because
  such an import resolves there and fails everywhere else (`deps-acceptance`).
- So an app's CI cannot run its suites: the repository is the customer's, the harness is ours, the
  template is private, and an app's workflows use no secrets. There, `pr-check.yml`'s `check` runs its
  static checks, `acceptance` type-checks and builds and says the suites did NOT run, and the suites
  run in the platform's stages. In the template, a missing harness is red (`harnessAbsenceProblems`
  in `harness-acceptance`). `npm run suites` in an app's own checkout fails for the same reason.
- The suites every app starts with, and what each holds:
  - `harness` — the charters, the workflows, `config.yaml`, `.gitignore`, and this file's seven
    headings with §5's and §6's load-bearing phrases.
  - `page-boot` — every page module and `src/App.tsx` bundle with esbuild and mount under jsdom,
    with `src/api/client.ts` stubbed, with no throw and no console.error (rule 14).
    `page-boot-kind` holds that probe's app-kind gate.
  - `db`, `db-module` — rule 18. `http` — `lib/http.js`, including decoding each path segment.
  - `preview` — rule 30: two copies of this tree in one process, each reading only its own file.
  - `deps` — every runtime import is in `dependencies`, every dependency is imported, and no
    product file imports the harness (rule 16).
  - `spa-routes` — `routes/spa.js` equals `src/routes.ts`, base `/web/`, `/` exists, and the real
    page listener answers every route with and without a trailing segment (rules 22, 26).
  - `schema-lint` — rules 2, 6, 7, 9, 10 and `@primaryKey` over every `schema*.graphql`; a table
    declared in two files is refused.
  - `builtins` — rules 5, 8, 20, 21, 23, 24, 28. `immensus-auth` — rule 27. `look` — rule 29.
  - `deploy-gate` — `scripts/deploy.js`'s verdicts and `--dry-run`. `check-build-stamp` —
    `scripts/build-stamp.js --self-test`.
  - `scheduler-probe` — rule 17: one tick under a frozen clock; a loop's body is never run.
  - `suite-verdicts` — every registered suite can report its own failure (§7).
- `page-boot`, `spa-routes`, `look` and `page-boot-kind`'s child-process half skip on a declared
  headless kind. The kind comes from `IMMENSUS_APP_KIND`, which the platform sets from what the
  user confirmed, and is never inferred from the tree, because a file in the tree can be deleted.
- A kit's suites arrive with the kit and are registered by its `package.json`, which is the list.
- Add one `<invariant>-acceptance.js` per invariant you introduce ("one owner cannot read another
  owner's rows" is one suite per owner-scoped entity). The reviewer rejects a PR that adds a
  resource without a suite naming it. Drive a resource through `scripts/probe/resource-call.js`
  (`call`, `userWithCookie`, `responseRulesVerdict`), so the request shape is written once.
- In the template repository, CI runs the core's suites alone, then assembles the core with each
  kit by `kits/assemble.mjs` and typechecks, builds and runs the full set over each.
- An app's own suites run offline against doubles. A check that needs a browser or a running app
  runs in the platform's stages, not from this repository. Do not add a browser or a hosted runner
  here to close that gap.
- A deploy is green only when every node serves the new sha to a new connection
  (`scripts/build-stamp.js`, six samples, two polls); a log line is never the verdict.

## 7. Known gotchas

Shape: what happened → what it cost → the rule → what enforces it. Add an entry in the same
PR as the gate and the suite that pin it. The builder appends this app's own entries below after
each job. These are the template's, for hazards an app's own code can hit and §4 does not number.

**Build and deploy**

- **Build before deploy, `--omit=dev`**: `web/` is gitignored, so a deploy without `vite build`
  ships no frontend; Fabric installs with `--omit=dev`, so a runtime import of a devDependency
  link-fails every resource → `scripts/deploy.js` refuses a missing or stale `web/index.html`;
  `deps-acceptance`.
- **A green suite set does not prove a module links under Harper**: suites run under Node's module
  loader and Harper's is a different one, so an unlinkable shape (rules 24, 28) passes every suite
  and then answers 500 `ResourceLoadError` on every route, naming the oldest import in the file
  rather than the newest change → the first deploy is the check; read the log there.
- **`pr-check`'s greps read raw text, and most do not skip comments**: a comment that spells a
  forbidden token fails the PR exactly like the defect → describe the token in `routes/`,
  `resources/` and `schema.graphql` comments rather than writing it → `builtins-acceptance`.
- **The harness is not part of the app**: an import of `scripts/run-suites.js` or `scripts/probe/*`
  from a product file resolves in the build workspace and throws `ERR_MODULE_NOT_FOUND` everywhere
  else → only a suite may import them → `deps-acceptance`.
- **A check an app inherits has to be able to pass, and its green has to mean something ran**:
  `check` and `acceptance` looked for the harness in apps that no longer hold it, so they failed on
  every pull request there and nobody read them, and `review` reported success with no token and no
  review → hand-made changes went in under red and green that said nothing → a step that needs the
  harness asks whether it is present, and a review that did not happen is red →
  `harnessAbsenceProblems` and `unreviewedProblems` in `harness-acceptance`.
- **A claim about Harper's behaviour carries the version it was read at and the date**, and a
  version bump is what prompts the re-check. The ones below were read from `harper@5.2.13` and
  `harper@5.3.1` on 2026-10-08.

**Frontend**

- **The page-boot stub answers `{}` to every GET it has no fixture for**, so a page reading
  `r.summary.total` crashes there exactly as it would on a 5xx or a half-deployed API → every page
  guards the shape it was handed (`r?.summary?.total ?? 0`, `Array.isArray(r?.rows)`) and renders
  its empty state → `page-boot-acceptance`.
- **Tailwind 3 deletes `.dark` inside `@layer base`**: it tree-shakes class selectors in that layer
  against the content scan, and no source file names the class `dark`, so the whole dark theme
  vanishes at build time → `.dark` lives outside `@layer base` → `look-acceptance` compiles it.
- **A URL composed in a preview copy has to stay in it** (rule 30): a hard navigation goes through
  `go()` from `src/api/client.ts`, a server `Location` through `previewPath()`, an emailed link
  through `publicBaseFor()`. A link that leaves carries the person to the published copy, where
  their session is refused → `preview-acceptance` scans for the forgotten case.
- **A parent's `space-y-*` overrides a child's `m-auto`**, because `.space-y-6 > * + *` is more
  specific, so a dialog inside one opens against the top of the page → `ui/dialog.tsx` uses
  `!m-auto`. jsdom has no layout, so no suite sees this; check a new overlay in a browser.

**Data and concurrency**

- **`create()`'s 409 is a sequential guard, not an arbiter**: the check is a local read, and under
  contention the write can land with no condition at all, across worker threads as well as nodes.
  So two racing creates can both succeed → uniqueness comes from a key derived from the natural
  identity (an address, normalized), and `created: true` never proves a caller came first.
- **A count is not a key**: "count, then write" lets two callers both pass → count again after the
  write and undo your own write if the rule no longer holds, so every interleaving ends valid.
- **A single-use link must not be a page load**: a mail client that prefetches links redeems it
  before the person does → link to a page with a button that navigates to the redeeming route.

**Outside services**

- **A webhook signature is over bytes, and Harper hands a `Resource` a parsed object**: for
  `application/json` the bytes are consumed before `post` runs, and `JSON.stringify` of the parsed
  value is a different document → capture them with the payments kit's `lib/raw-body.js`; when none
  are available refuse `503 raw_body_unavailable`, never `403`, because the sender did nothing wrong.
- **A 2xx tells the sender to stop retrying**: a webhook whose handler threw answers 500 and records
  nothing, and one with no handler yet answers 503, or the event is lost. Handlers must be idempotent,
  because two deliveries can both pass a read-then-write dedupe.
- **A provider's error message can carry the credential it refused**: Stripe's 401 echoes the first
  eight and last four characters of the key → relay only its fixed-vocabulary fields (`type`, `code`,
  `param`), and drop any that contains the key or its last four → `stripe-acceptance`.

**Writing suites**

- **`done()` only returns the exit code**: a suite ending in a bare `done()` fails its assertions and
  exits 0, and the runner then discards its output → end with `process.exit(done())` →
  `suite-verdicts-acceptance`.
- **A suite does not import another suite**: each ends by exiting, so the import runs it and exits
  with its verdict, and your own assertions never run → shared logic goes in a module that exits
  nothing.
- **A negative control has to be seen red**: a mutation anchored on text somebody may reformat matches
  nothing and proves nothing → derive it from what the suite parsed, or synthesize the defect, and
  assert the mutation changed something. A control whose subject is "X does not throw" catches the
  throw and reports it, or it takes the rest of the suite down with it.
- **Strip comments before asserting over source**: a well-commented file quotes the code it discusses,
  so a raw search hits the prose first and passes or fails for the wrong reason.
- **A suite's reference state may not be a file the product writes, and it may not read `web/`**: CI
  builds before the suites run, so `web/` holds a build nobody made for the fixture → a suite that
  needs compiled output compiles it itself, and one that measures its own operation compares against
  a snapshot it took itself.
- **Where a suite both produces and checks an artefact, compute the expected value independently** from
  the external definition (a signature from the provider's documented scheme), because a signer and
  verifier sharing one function prove only that they agree.
- **A jsdom child never exits on its own**: its timers keep the event loop alive until the kill →
  `process.exit(0)` after the verdict is written.
**This app's own**

- **A record that NAMES a field Harper assigns is refused `400 Bad Request` with no body** — this
  was the long-unexplained "Bad Request" on every menu save and every order-status tap, and it is
  resolved. `MenuItem.createdAt`/`updatedAt` and `Order.updatedAt` carry `@createdTime`/
  `@updatedTime`, so they are Harper's; a `put()` whose record holds one is refused, and the refusal
  carries no JSON `error` key, which is why the page could only show the bare statusText. **The trap
  is the SPREAD, not the literal**: `{ ...existing, status }` names `updatedAt` because the stored
  row has one, so `OrderAdminApi` hit this without the word appearing anywhere in the file. It also
  explains the control — `StoreSettingsApi` builds its record from a constant id plus validated
  fields and answered `200` throughout. *The narrowing that worked was the one QA named*: the two
  failing endpoints restated a stored row, the working one did not. Two earlier theories (the verb,
  then the record in the path) were both about the REQUEST and both false; nothing about the
  request was ever the variable. → cost: two fix loops and a release with no working menu editor →
  rule: every writer of an owner-stamped table passes its record through `withoutManaged(record,
  table)` from `lib/managed-fields.js`, and nothing ever sets one of those fields → enforced by:
  `managedFieldsIn()` asserted over every captured write in `MenuAdminApi-probe` and
  `OrderAdminApi-probe`, each with a negative control — and by `managed-fields-probe`, which parses
  every `schema*.graphql` and requires `MANAGED_FIELDS` to equal the `@createdTime`/`@updatedTime`
  fields it finds, because those two probes read that map and so cannot check it against itself.
  - *Why no suite caught it for two rounds*: `scripts/probe/harperdb-stub.js` accepts any field,
    so the probes drove the same routes in-process and passed. A hermetic probe cannot see a
    refusal the double does not model — so the probes now assert the **shape of the record written**
    rather than only the response, which is the part a double can be trusted on.
  - *Consequence for readers*: `createdAt` and `updatedAt` now come back as epoch-millisecond
    **numbers**, and rows written before the fix may still hold an ISO string, so anything
    rendering them must accept both.
- **A `CONFIG.env` in the working tree reds suites that pass in CI**: `lib/config.js` reads that file
  and ignores `process.env` (rule 30), and CI has no such file → move it aside before believing the red.
- 2026-11-11: **Signed in as admin (owner@example.com via password) on /manage/orders. Placed two new orders from separate anonymous customer sessions while the owner's orders page stayed open with no navigation. The page made polling GET /OrderAdminApi?queue=active requests (200 responses) after each new order was placed, but the new order never appeared in the rendered list across multiple poll cycles over well more than 15 seconds. Reloading /manage/orders immediately showed both new orders at the top of the queue with correct items, pickup/delivery choice and payment status -- so the backend data and first-load rendering are correct, but the 'arrives without reloading' behaviour the story requires does not work.** → cost: one more pass over frontend → rule: frontend must keep "view-new-orders" working → enforced by: story view-new-orders in the next test run <!-- gotcha:qa0-view-new-orders -->
- 2026-11-11: **Signed in as admin (owner@example.com, password). On /manage/menu, clicked Edit on 'Cola' and changed its price from £2.00 to £2.25, then Save. PATCH /MenuAdminApi/menu-cola returned 400 Bad Request and the dialog showed a 'Bad Request' error banner; the list still showed Cola at £2.00 afterward, confirming the edit was not saved.** → cost: one more pass over backend → rule: backend must keep "update-menu" working → enforced by: story update-menu in the next test run <!-- gotcha:qa0-update-menu -->
- 2026-11-11: **Signed in as admin (owner@example.com, password). On /manage/orders, clicking 'Mark preparing' on a Received order (own order #sFUI3AL8, id 05258a5a-c5cc-4e23-9657-d0e1887729ce) returned PATCH /OrderAdminApi/<id> 400 and the page showed a 'Bad Request' error banner; the order stayed 'Received'. Clicking 'Mark ready' on a different order (order-0002, #Vb3Nm6Xs) also returned 400. Reproduced on two different orders, so the status-update action is broken, not an isolated data issue.** → cost: one more pass over backend → rule: backend must keep "update-order-status" working → enforced by: story update-order-status in the next test run <!-- gotcha:qa0-update-order-status -->
- 2026-11-11: **Seeded demo orders (e.g. #Hs7Qk2mV, #Zq8Wd1nY, #Vb3Nm6Xs, #Ck9Tf2Rb) show £0.00 for every individual line item in the owner's order queue (e.g. 'Margherita × 2  £0.00', 'Pepperoni × 3  £0.00') even though the order total is correct. Only orders freshly created during this walk showed correct per-line prices. This is a display bug affecting how snapshot item prices are rendered/read for at least the seeded data on /manage/orders.** → cost: one more pass over frontend → rule: frontend must keep "Seeded demo orders (e.g. #Hs7Qk2mV, #Zq8Wd1nY, #Vb3Nm6Xs, #Ck9Tf2Rb) show £0.00 for every individual line item in the owner's order queue (e.g. 'Margherita × 2  £0.00', 'Pepperoni × 3  £0.00') even though the order total is correct. Only orders freshly created during this walk showed correct per-line prices. This is a display bug affecting how snapshot item prices are rendered/read for at least the seeded data on /manage/orders." working → enforced by: the next test run <!-- gotcha:qa0-Seeded-demo-orders-e-g-Hs7Qk2mV-Zq8Wd1nY -->
- 2026-11-11: **On the order confirmation page (/order/:code), the 'Estimated ready' field shows only a calendar date (e.g. 'Nov 11, 2026') with no time of day, which is uninformative for same-day ASAP orders; the checkout page shows a more useful relative estimate ('around 25 min').** → cost: one more pass over frontend → rule: frontend must keep "On the order confirmation page (/order/:code), the 'Estimated ready' field shows only a calendar date (e.g. 'Nov 11, 2026') with no time of day, which is uninformative for same-day ASAP orders; the checkout page shows a more useful relative estimate ('around 25 min')." working → enforced by: the next test run <!-- gotcha:qa0-On-the-order-confirmation-page-order-cod -->
- 2026-11-11: **Signed in as admin (owner@example.com), opened /manage/menu, clicked Edit on 'Cola', changed price to £2.10 and Save: page showed 'Bad Request' and network showed PATCH /preview/MenuAdminApi/menu-cola 400 — price unchanged in the list. Retried changing only the description with the same result (PATCH 400 again). The owner cannot save any menu item edit. (For contrast, StoreSettingsApi PUT with an edited field succeeded with 200, so this is specific to MenuAdminApi, not a general auth problem.)** → cost: one more pass over backend → rule: backend must keep "update-menu" working → enforced by: story update-menu in the next test run <!-- gotcha:qa1-update-menu -->
- 2026-11-11: **Signed in as admin (owner@example.com), on /manage/orders. Clicking 'Mark preparing' on any Received order returns a 'Bad Request' banner on the page and the underlying call fails: PUT /preview/OrderAdminApi/<id> 400. Reproduced on three different orders (ids c548b224-d5c1-4566-81d7-be61efcc10fd and order-0002) for 'Mark preparing', 'Mark ready' and 'Cancel order' actions — every status-changing PUT to OrderAdminApi returned 400 and no order's status changed on reload. The owner cannot currently advance or cancel any order.** → cost: one more pass over backend → rule: backend must keep "update-order-status" working → enforced by: story update-order-status in the next test run <!-- gotcha:qa1-update-order-status -->
- 2026-11-11: **resources/MenuAdminApi.js: Every PATCH to MenuAdminApi (menu item edits) returns 400 Bad Request regardless of which field changes (price or description), on the live /preview deployment. Blocks the owner from editing any menu item.** → cost: one more pass over backend → rule: backend must keep "resources/MenuAdminApi.js: Every PATCH to MenuAdminApi (menu item edits) returns 400 Bad Request regardless of which field changes (price or description), on the live /preview deployment. Blocks the owner from editing any menu item." working → enforced by: the next test run <!-- gotcha:qa1-resources-MenuAdminApi-js-Every-PATCH-to -->
- 2026-11-11: **resources/OrderAdminApi.js: Every status-changing PUT to OrderAdminApi (Mark preparing, Mark ready, Cancel order) returns 400 Bad Request on the live /preview deployment across multiple distinct orders. Blocks the owner from advancing or cancelling any order.** → cost: one more pass over backend → rule: backend must keep "resources/OrderAdminApi.js: Every status-changing PUT to OrderAdminApi (Mark preparing, Mark ready, Cancel order) returns 400 Bad Request on the live /preview deployment across multiple distinct orders. Blocks the owner from advancing or cancelling any order." working → enforced by: the next test run <!-- gotcha:qa1-resources-OrderAdminApi-js-Every-status- -->

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
it look as though the fault "lives above the resource". The probes therefore assert the **shape of
the record handed to `db.<Table>.put`/`patch`** — that it carries no key named by a `@createdTime` or
`@updatedTime` field — with the negative control being a record that does carry one. Asserting the
stub's 200 proves nothing. The list of those field names is `MANAGED_FIELDS`, and because the write
assertions read it, it cannot also be their reference: `managed-fields-probe` is the one suite that
reads `schema.graphql` itself and requires the map to equal what the SDL declares.

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

## 11. Added by kits

- The sign-in kit: screens /login, /auth/verify, /invite, /account, /admin/*; server resources AccountApi, AdminApi, AuthApi, Bootstrap, InboundEmailApi; tables User, MagicLink, EmailLog, EmailSuppression. These came with the kit, so the plan may not list them. <!-- kit:sign-in -->
- The payments kit: server resources StripeWebhook; tables StripeEvent. These came with the kit, so the plan may not list them. <!-- kit:payments -->

## 12. Decisions

- 2026-11-11: **First, what sort of thing are we building? I think it is "something people open and use" — Customers browse your menu and order pizza on pages they visit, while you manage prices and orders on the same site. Tell me if that is not right; it changes everything that comes after.** → Something people open and use <!-- decision:app_kind -->
- 2026-11-11: **You said delivery should be limited to an area you set. How should the app decide whether an address is inside it?** → A list of postcodes I keep <!-- decision:architect:delivery_area_rule -->
- 2026-11-11: **Should delivery orders cost extra?** → A delivery fee I set <!-- decision:architect:delivery_fee -->
- 2026-11-11: **Each order keeps the customer's name, phone number and, for delivery, their address. How long should the app hold on to that?** → Twelve months, then clear the personal details <!-- decision:architect:keep_orders -->
- 2026-11-11: **Customers order without making an account, but you need a login for the menu and order screens. How would you like to get in?** → A link emailed to me <!-- decision:architect:owner_sign_in -->
- 2026-11-11: **When a customer checks out, should the total be exactly the menu prices added up, or should the app add tax on top?** → Menu prices are the final price <!-- decision:architect:tax_on_prices -->
- 2026-11-11: **Should delivery be limited to a certain area, or can anyone enter a delivery address?** → Limit delivery to an area I set <!-- decision:delivery_area -->
- 2026-11-11: **Where will people mostly use this — on a phone, or at a computer? It changes how much I put on one screen and how people get around your app.** → Mostly on a phone <!-- decision:form_factor -->
- 2026-11-11: **Do customers need to create an account to order, or can they check out as a guest each time?** → Guest checkout, no account needed <!-- decision:guest_checkout -->
- 2026-11-11: **How should your app look? I'd go with Bloom for this — A pizza shop is a cheerful, everyday treat, and a bright, friendly look suits food photos and a quick order flow. Pick another if you would rather, or choose Something else and describe the look you want; it is easy to change later.** → Studio <!-- decision:look_and_feel -->
- 2026-11-11: **Should customers be able to customize pizzas (pick size, crust, toppings), or do you just want a fixed list of ready-made items with set prices?** → Fixed menu items only <!-- decision:menu_customization -->
- 2026-11-11: **Can customers schedule a pickup or delivery for later, or should every order be for as soon as possible?** → As soon as possible only <!-- decision:order_timing -->
- 2026-11-11: **Taking payments needs your Stripe account. I'll build invite codes now and add checkout when you connect Stripe. Is that right?** → Yes, invite codes for now <!-- decision:payments -->
- 2026-11-11: **Will anyone besides you need their own login to see and manage incoming orders, like kitchen staff?** → Just me <!-- decision:staff_access -->

