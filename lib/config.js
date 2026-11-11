// FIXED. The one place this app's configuration
// is read. Every key here is written at deploy time by the builder worker (or, on Builder, by
// deploy-shared.yml's "Write CONFIG.env from secrets" step — the two lists there and the getters
// here name the same keys). resources/ and lib/ never touch process.env directly, and neither does
// routes/: a route module reads its configuration here too, which is safe because this file imports
// nothing but `node:fs`.
//
// ── EVERY VALUE COMES FROM THIS COPY'S OWN `CONFIG.env`, AND NEVER FROM `process.env` WHILE THAT FILE
// ── EXISTS.
//
// THE PROBLEM. An update to a published app is looked at on the app's own cluster before it goes live. So
// two copies of this app run in ONE Harper process at once: the published copy at the app's own
// address, reading `data`, and the preview copy under `/preview`, reading `stage`. They share one
// `process.env`, and Harper's `loadEnv` fills it from every component's `CONFIG.env`
// FIRST-WRITER-WINS. Measured on a real `harper@5.3.1`: across eight restarts
// the preview read production rows four times and the published app read the dummy rows the other
// four, and on a two-node Fabric cluster a copy reading `process.env.BUILD_SHA` reported
// ANOTHER component's build. So no value either copy depends on may come from `process.env`.
//
// → each copy parses its OWN `CONFIG.env`, located relative to this module, so it is always the file
// that deploy shipped beside this code. That reading was measured to work in every module-loader mode
// Harper has, where Harper's own `config` export — the other reading measured — works only in
// the default one. (Not spelled as an import here: pr-check's rule-5 scan reads comments too, and
// `routes/` reaches this file.)
//
// → `process.env` is read ONLY when this copy has no `CONFIG.env` at all, which is an app deployed
// as-is onto some other Harper with its configuration in the host's environment, or a local
// `harper dev .` with none (the repository must run on any Harper). The
// platform writes `CONFIG.env` into every deploy, so on the platform this branch is never taken.
//
// → A `CONFIG.env` that EXISTS BUT CANNOT BE READ IS A THROW, never a fall back. Falling back is the
// one wrong answer: the preview copy would then read the published copy's values from `process.env`
// — including that it is NOT the preview and which database to read — and serve production rows at
// a public path. A preview that answers 500 is the cheap failure.
//
// THE GRAMMAR IS `dotenv`'s, transcribed. Harper's `loadEnv` parses with `dotenv.parse()`
// (`harper@5.3.1 utility/envFile.ts`, `dotenv@16.6.1`), so a copy reading its own file has to read
// exactly what `loadEnv` would have put into `process.env` — a second grammar would make a value
// mean one thing to this app and another to Harper.
//
// One thing `loadEnv` does that this does not, named rather than discovered: Harper decrypts an
// `enc:v1:` value on its way into `process.env` (`resources/secretDecryptor.ts`). The platform never
// writes one — `CONFIG.env` is rendered in plaintext from the sealed `app_env` envelope — so an app
// whose own owner encrypts values in a `CONFIG.env` of their own reads ciphertext here.
//
// ── ONE EXCEPTION: PER-APP VALUES, the five names in `PER_APP_VALUES` — the four secrets in
// ── `PER_APP_SECRETS` and the owner's address.
//
// THE PROBLEM. The control plane asks the user for their keys AFTER the app is built — the Resend key
// for the app's mail and, when the plan calls an AI service, that vendor's key — and delivers each into
// the app cluster's own Harper secret store with `processEnv: true`, then restarts each node.
// The Resend key arrives with its sender address,
// `EMAIL_FROM`, beside it. None of the four is ever written into `CONFIG.env`, because a key asked for
// after the build has to reach an app nobody is about to redeploy. Under the rule above, the keys the
// user had just given us were never read: every sign-in link was skipped, and a generated app's AI calls
// fell back to stock replies.
//
// WHY THIS IS SAFE. That hazard is a value that DIFFERS between the two copies reaching
// the other copy through the one shared `process.env`. These do not differ: the secret store holds one
// row per name per cluster, both copies are meant to use the same key, and none of the four says which
// copy this is or which database it reads. Nor can a `CONFIG.env` shadow them in `process.env`: Harper
// materializes `processEnv` secrets before any component loads, and `loadEnv` skips a key that is
// already set (harper@5.3.1 and @5.3.2, identical: `components/componentLoader.ts`,
// `resources/loadEnv.ts`). Measured on a live two-node cluster.
//
// → THIS COPY'S OWN FILE STILL WINS WHEN IT CARRIES A VALUE, so a hand-written `CONFIG.env` means what it
//   says. A name that is absent or blank there is read from `process.env` (`secretSource`).
// → THE LIST STAYS HERE AND THE READERS DO NOT. The mail pair and the owner's address
//   are read by the sign-in kit (`kits/sign-in/lib/sign-in-config.js` in this repository, `lib/sign-in-config.js`
//   in an app the platform copied it into), through `secretSource`. The LIST is this file's because it is a
//   property of the platform's delivery channel, not of sign-in: it is the whole set of names allowed to
//   cross between the two copies, and a kit that could add to it would be a kit that could open that hole.
// → THE MAIL KEY AND ITS SENDER ARE READ FROM ONE PLACE, CHOSEN BY THE KEY. The control plane mints a
//   Resend key scoped to one sending domain and delivers the address on that domain beside it, so a key
//   from one source with a sender from the other is a pair Resend refuses.
// → NOTHING ELSE IS READ THIS WAY. Every other key, `RESEND_WEBHOOK_SECRET` and the Stripe keys
//   included, is this copy's own file or nothing: none of them is delivered by the secret store, and
//   the ones that matter most (`IMMENSUS_DATABASE`, `IMMENSUS_PREVIEW`, `BUILD_*`) differ per copy by
//   design. Adding a name to `PER_APP_VALUES` is adding a value both copies may share; say why here.
//
// → THE FIFTH NAME IS `OWNER_EMAIL`, THE APP OWNER'S ADDRESS, AND IT IS NOT A SECRET.
//   The owner's email becomes the app's first administrator
//   (lib/auth.js `ownerSetting`), and the control plane delivers it. It is read
//   this way for two reasons. It is the same for both copies: one app has one owner, and it says
//   nothing about which copy this is or which database it reads, so that hazard does not apply.
//   And the control plane had not chosen how to deliver it when this landed — the `app_env` pairs, which
//   reach each copy's `CONFIG.env`, or the secret store, which reaches `process.env` — and this reading
//   is right for either. One consequence is worth knowing: if one copy's file carries it and the other's
//   does not, the second reads whatever `loadEnv` put into `process.env`, which is the first copy's
//   value — the same owner, so that is the correct answer rather than a leak.

import { readFileSync } from 'node:fs'

// `dotenv@16.6.1 lib/main.js`'s LINE, verbatim, and its `parse` below line for line.
const LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg

/** `dotenv.parse`, transcribed: the same object Harper's `loadEnv` would have built from `text`. */
export function parseConfigEnv (text) {
  const obj = {}
  const lines = String(text ?? '').replace(/\r\n?/mg, '\n')
  LINE.lastIndex = 0
  let match
  while ((match = LINE.exec(lines)) != null) {
    const key = match[1]
    let value = (match[2] || '').trim()
    const maybeQuote = value[0]
    value = value.replace(/^(['"`])([\s\S]*)\1$/mg, '$2')
    if (maybeQuote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r')
    obj[key] = value
  }
  return obj
}

// This copy's own file: the component root, which is this module's parent directory. Not `cwd` —
// Harper's working directory is its own root and not the component's.
export const OWN_CONFIG_URL = new URL('../CONFIG.env', import.meta.url)

// `undefined` until the first read; `null` when this copy has no `CONFIG.env`; the parsed object
// otherwise. Read ONCE per process: a deploy restarts every worker, so the file a running process
// was started with is the one it keeps reading, and a value cannot change under a request.
let own

/** This copy's own configuration, or `null` when it has no `CONFIG.env`. Throws when the file is there and unreadable. */
export function ownConfig () {
  if (own !== undefined) return own
  let text
  try {
    text = readFileSync(OWN_CONFIG_URL, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return (own = null)
    throw new Error(`${OWN_CONFIG_URL.pathname} exists and could not be read (${err?.code ?? err?.message ?? err}). Refusing to fall back to process.env, which another copy of this app may have written`)
  }
  return (own = parseConfigEnv(text))
}

// FOR SUITES ONLY: forget the cached read so a suite can drive both branches in one process. Nothing
// in a running app calls it.
export function forgetOwnConfig () { own = undefined }

/** A key's raw value: from this copy's own file when it has one, else from `process.env`. */
export function readKey (name) {
  const file = ownConfig()
  return file ? file[name] : process.env[name]
}

const required = (name) => {
  const value = readKey(name)
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

// Blank is ABSENT, not a value. The CONFIG.env writer emits a line for
// EVERY key whether or not the secret is set, so an unset secret arrives as `''`, and a
// `??` fallback would never be reached. `required()` reads it the same way (`if (!value)`).
//
// A getter for which blank is a MEANINGFUL value carries a `''` fallback and is therefore
// unaffected by construction — blank in, blank out.
const isBlank = (v) => v == null || String(v).trim() === ''
const optional = (name, fallback) => {
  const v = readKey(name)
  return isBlank(v) ? fallback : v
}

// THE ONLY NAMES READ FROM `process.env` WHILE THIS COPY HAS A `CONFIG.env` (the header says why).
// The mail pair, key first because the key chooses the source; the two AI vendors' key names, which
// are the vendors' own — one app has one user, who picks one vendor on the build's card;
// and the owner's address, which is not a secret and is the same for both copies.
export const MAIL_PAIR = Object.freeze(['RESEND_API_KEY', 'EMAIL_FROM'])
export const MODEL_KEY_NAMES = Object.freeze(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])
export const PER_APP_SECRETS = Object.freeze([...MAIL_PAIR, ...MODEL_KEY_NAMES])
export const OWNER_KEY = 'OWNER_EMAIL'
export const PER_APP_VALUES = Object.freeze([...PER_APP_SECRETS, OWNER_KEY])

/**
 * Where a per-app value is read from: this copy's own file when it carries a non-blank value under
 * `keyName`, else `process.env`, which is where the secret store delivers it. Exported with the name as
 * an argument so a probe can drive it under scratch names on a real cluster; the app calls it only for
 * `PER_APP_VALUES`.
 */
export function secretSource (keyName) {
  const file = ownConfig()
  return file && !isBlank(file[keyName]) ? file : process.env
}

// A malformed number in CONFIG.env must not silently become 0 on a guardrail that then
// reads as "cap of zero". Fall back to the documented default and say so once.
const nonNegNumber = (name, fallback) => {
  const raw = readKey(name)
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[config] ${name}="${raw}" is not a non-negative number — using default ${fallback}`)
    return fallback
  }
  return n
}

const flag = (name, fallback) => {
  const v = optional(name, '')
  if (v === '') return fallback
  return v === 'true' || v === '1'
}

// Harper's own name for the default database, and the documented one: "The default database is
// named `data`. Most applications will use this default." It lives here rather than in
// lib/db.js, which imports it, so the fallback below and the branch that reads it are ONE
// spelling: two spellings of one constant degrade silently instead of failing.
export const DEFAULT_DATABASE = 'data'

export const config = {
  // The origin every absolute link is built from (magic links, checkout return URLs).
  // Trailing slash stripped so `${publicAppUrl()}/path` never doubles it.
  publicAppUrl: () => optional('PUBLIC_APP_URL', 'http://localhost:9926').replace(/\/+$/, ''),
  appName: () => optional('APP_NAME', 'This app'),

  // Which Harper database this copy reads and writes; lib/db.js binds the app's table set to it and
  // nothing else reads it. The preview copy is handed `stage` and the published copy `data`.
  // UNSET IS THE DEFAULT DATABASE, so an app runs on any Harper
  // instance with no Immensus anywhere — which is why this is
  // `optional()` and must never become `required()`.
  databaseName: () => optional('IMMENSUS_DATABASE', DEFAULT_DATABASE),

  // IS THIS THE PREVIEW COPY? Written as `IMMENSUS_PREVIEW=true` into the preview copy's own
  // `CONFIG.env` by the builder, and into no other. It answers whether this copy is looking at dummy
  // data: the routes it refuses (Bootstrap and the two inbound webhooks), whether its scheduler runs (it
  // does not), and whether it may read `data` (lib/db.js). WHERE the copy is
  // mounted is `urlPath()` below, and the boolean is that answer only for a preview copy deployed
  // before the builder wrote the path.
  //
  // ABSENT IS THE PUBLISHED COPY, so a repository deployed as-is anywhere is an ordinary app at the
  // root. It is read from this copy's own file like everything else here, which is the whole reason
  // it can be trusted: the published copy's `loadEnv` cannot write it into the preview's answer.
  previewCopy: () => flag('IMMENSUS_PREVIEW', false),

  // WHICH PATH THIS COPY IS MOUNTED AT, as path segments with no leading slash: `preview` for the preview
  // copy, `tracker` for a sharing app's published copy at `/tracker` in another app's cluster, and
  // `tracker/preview` for that sharing app's preview copy. The builder writes it
  // into every copy's own `CONFIG.env` beside `IMMENSUS_DATABASE`. ABSENT OR BLANK IS AN APP AT THE ROOT,
  // or a preview copy deployed before the builder wrote the key, and lib/copy.js then answers as it did
  // before the key existed. It is a different fact from `previewCopy()`: a sharing app's published copy
  // has a path and is not a preview, so it takes its own webhooks and runs its own scheduler. lib/copy.js
  // checks the value and composes every path from it; nothing else reads it.
  urlPath: () => optional('IMMENSUS_URL_PATH', ''),

  // THE MOUNTS OF THE OTHER APPS ON THIS CLUSTER, comma-separated in `urlPath`'s own form —
  // `tracker,notes`. The builder writes it on each deploy of the app at the root of a cluster that
  // sharing apps share. The root copy's page listener answers every path one of its
  // routes matches, so without this a `/:slug` or `/*` route would answer `/tracker`, and which app a
  // person saw there would depend on component load order (lib/pages.js). Blank: no other app.
  sharingMounts: () => optional('IMMENSUS_SHARING_MOUNTS', ''),

  // The canonical hostname when a custom domain is attached (routes/apex.js). Blank: no redirect.
  apexRedirectTo: () => optional('APEX_REDIRECT_TO', ''),

  // The build stamp the deployer writes beside every other key (routes/build.js). Blank is ABSENT —
  // `null`, not `''` — because "this process was started without a stamp" is what an unstamped
  // `/build` has to say, and an empty string reads as a value.
  buildStamp: (key) => optional(key, null),

  // THE USER'S OWN AI-SERVICE KEY, READ BY THE VENDOR'S NAME AND NEVER STORED.
  // When a plan calls an AI service the build asks the user which vendor, and after the build the
  // control plane writes their key into the secret store under that vendor's own name — `ANTHROPIC_API_KEY`
  // or `OPENAI_API_KEY` — exactly as it writes the Resend key. Generated code calls
  // `config.modelApiKey('<NAME>')`, the same getter `agent-template` ships, and the builder's Tier A
  // `model_key` check reds a key read through `optional()`, `required()` or `readKey()`, which can never
  // see it. The header's exception: this copy's own file when it carries one, else `process.env`.
  //
  // A GETTER AND NOT A VALUE: the key arrives after the app is running, at a restart, and anything that
  // captured it at start-up would miss it. `undefined` when no key is set, so a caller can say so
  // rather than send an empty credential. ANY OTHER NAME THROWS, naming both, because a misspelled
  // vendor name would otherwise read as "no key saved yet" and the app would fall back in silence.
  modelApiKey: (name) => {
    if (!MODEL_KEY_NAMES.includes(name)) throw new Error(`config.modelApiKey: ${JSON.stringify(name)} is not a key this platform delivers; the names are ${MODEL_KEY_NAMES.join(' and ')}`)
    const v = secretSource(name)[name]
    return isBlank(v) ? undefined : v
  },
}

export { required, optional, nonNegNumber, flag, isBlank }
