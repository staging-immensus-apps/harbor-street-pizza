#!/usr/bin/env node
// THE SIGN-IN KIT'S HALF OF THE PREVIEW COPY: two copies of the app
// in ONE process, the published copy reading `data` and the preview copy under `/preview` reading
// `stage`, and a session, a first-admin claim, an emailed link or the mail webhook must not cross from
// one to the other.
//
// Copied into an app with the rest of the sign-in kit when a plan says people sign in.
// These sections were part of the core's `preview-acceptance` while sign-in
// shipped in every app; the core keeps the half that is true of any app (each copy's own CONFIG.env,
// its database, its pages and its scheduler), and this suite builds the two copies the same way:
// two temporary directories, each with its own `CONFIG.env`, loaded in one process with `process.env`
// POISONED by the other copy's values.
//
// Hermetic: the harperdb stub, temp directories, no network, no git, no clock.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHmac } from 'node:crypto'

// Nothing from the developer's shell may decide a verdict here.
for (const k of ['IMMENSUS_DATABASE', 'IMMENSUS_PREVIEW', 'IMMENSUS_STAGE_DATABASE', 'SESSION_SECRET', 'BUILD_SHA', 'PUBLIC_APP_URL', 'RESEND_API_KEY', 'EMAIL_FROM', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OWNER_EMAIL']) delete process.env[k]

const { checker, ROOT, fixture, discard } = await import('./probe/harness.js')
const { databases, makeDatabase, resetDatabases, server } = await import('./probe/harperdb-stub.js')
const { check, section, done } = checker('sign-in-preview-acceptance')

const STAGE = 'stage'
const SECRET = 'suite-only-secret-0123456789-not-a-real-one'
const APP = 'https://x.immensus.app'
const SHELL = '<!doctype html><div id="root"></div>'

// One copy of this tree in its own directory, with the CONFIG.env a deploy would have written beside
// it. `package.json` comes too, because it is what makes a `.js` file in a temp directory an ES module.
const workdirs = []
function makeCopy (env, { configEnv = true } = {}) {
  const w = fixture(ROOT, ['package.json', 'lib', 'resources', 'routes'], 'copy-')
  workdirs.push(w)
  if (configEnv) writeFileSync(join(w, 'CONFIG.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
  mkdirSync(join(w, 'web'), { recursive: true })
  writeFileSync(join(w, 'web', 'index.html'), SHELL)
  return w
}
const load = (w, rel) => import(pathToFileURL(join(w, rel)).href)
const bodyOf = async (res) => { try { return JSON.parse(await res.text()) } catch { return null } }

const PUBLISHED_ENV = { IMMENSUS_DATABASE: 'data', SESSION_SECRET: SECRET, PUBLIC_APP_URL: APP, BUILD_SHA: 'published-sha' }
const PREVIEW_ENV = { IMMENSUS_DATABASE: STAGE, IMMENSUS_PREVIEW: 'true', SESSION_SECRET: SECRET, PUBLIC_APP_URL: APP, BUILD_SHA: 'preview-sha' }
const P = makeCopy(PUBLISHED_ENV)
const Q = makeCopy(PREVIEW_ENV)

// What `loadEnv` would leave in `process.env` if the published copy wrote first. Kept for the whole
// suite, so every section below runs in the poisoned state, not only the first.
const poisonWith = (env) => { for (const k of ['IMMENSUS_DATABASE', 'IMMENSUS_PREVIEW', 'BUILD_SHA']) delete process.env[k]; Object.assign(process.env, env) }
poisonWith({ IMMENSUS_DATABASE: 'data', BUILD_SHA: 'published-sha' })

const pcore = await load(P, 'lib/config.js')
const pc = await load(P, 'lib/sign-in-config.js')
const qc = await load(Q, 'lib/sign-in-config.js')

section('the mail pair and the owner\'s address come from the secret store through process.env, in both copies')
{
  // What Harper's secret store leaves in `process.env` once the control plane has delivered the user's
  // keys with `processEnv: true`. None of them is in either copy's CONFIG.env —
  // the platform never writes them there.
  const STORE = { RESEND_API_KEY: 're_from_the_store', EMAIL_FROM: 'no-reply@mail.x.immensus.app', ANTHROPIC_API_KEY: 'sk-ant-from-the-store' }
  const OTHERS = { RESEND_WEBHOOK_SECRET: 'whsec_from_env', STRIPE_SECRET_KEY: 'sk_test_from_env', GOOGLE_CLIENT_ID: 'from-env.apps.googleusercontent.com' }
  const ALL = [...Object.keys(STORE), ...Object.keys(OTHERS), 'OPENAI_API_KEY', 'OWNER_EMAIL']
  const saved = Object.fromEntries(ALL.map((k) => [k, process.env[k]]))
  Object.assign(process.env, STORE, OTHERS)
  delete process.env.OPENAI_API_KEY
  try {
    check('PRECONDITION: neither copy\'s CONFIG.env carries a mail or model key, and process.env carries the store\'s',
      ['RESEND_API_KEY', 'EMAIL_FROM', 'ANTHROPIC_API_KEY'].every((k) => !(k in pcore.ownConfig()) && process.env[k] === STORE[k]))
    for (const [label, c] of [['the published copy', pc], ['the preview copy', qc]]) {
      check(`${label} reads the mail key and its sender from the store, and counts mail as set up`,
        c.config.email.resendApiKey() === STORE.RESEND_API_KEY && c.config.email.from() === STORE.EMAIL_FROM && c.config.email.configured() === true)
      // THE NARROWNESS CONTROL, and it is what keeps this an exception rather than the old reader back:
      // every other key, per-app or not, is still this copy's own file or nothing.
      check(`${label} still reads NOTHING ELSE from process.env — the mail webhook secret and the Google client id stay file-only`,
        c.config.email.webhookSecret() === '' && c.config.google.clientId() === '')
    }
    // A BLANK line is no line: the platform's CONFIG.env writer emits every key whether or not it is set.
    const B = makeCopy({ ...PUBLISHED_ENV, RESEND_API_KEY: '', EMAIL_FROM: '' })
    const bc = await load(B, 'lib/sign-in-config.js')
    check('a copy whose file carries the keys BLANK still reads the store\'s',
      bc.config.email.resendApiKey() === STORE.RESEND_API_KEY && bc.config.email.from() === STORE.EMAIL_FROM)

    // THE FILE STILL WINS WHEN IT SAYS SOMETHING, so a hand-written CONFIG.env means what it says.
    const F = makeCopy({ ...PUBLISHED_ENV, RESEND_API_KEY: 're_from_the_file', EMAIL_FROM: 'me@example.test' })
    const fc = await load(F, 'lib/sign-in-config.js')
    check('a copy whose file carries a mail key reads the key AND the sender from the file, though process.env holds others',
      fc.config.email.resendApiKey() === 're_from_the_file' && fc.config.email.from() === 'me@example.test')

    // THE PAIR IS READ FROM ONE PLACE. A file key with the store's sender is a key scoped to one domain
    // sending from another, which Resend refuses; so the sender follows the key, to the default here.
    const K = makeCopy({ ...PUBLISHED_ENV, RESEND_API_KEY: 're_from_the_file' })
    const kc = await load(K, 'lib/sign-in-config.js')
    check('a file that carries the mail key and NO sender does not borrow the store\'s sender — the pair comes from one source',
      kc.config.email.resendApiKey() === 're_from_the_file' && kc.config.email.from() !== STORE.EMAIL_FROM && kc.config.email.from() === 'no-reply@mail.immensus.app')
    // …AND THE OTHER HALF: a file that carries only a SENDER does not choose the source, because the key
    // does. Its sender is ignored and the store's pair is read whole.
    const S = makeCopy({ ...PUBLISHED_ENV, EMAIL_FROM: 'me@example.test' })
    const sc = await load(S, 'lib/sign-in-config.js')
    check('a file that carries only a sender and NO key reads the store\'s key AND the store\'s sender — the file\'s sender is not paired with a key it did not supply',
      sc.config.email.resendApiKey() === STORE.RESEND_API_KEY && sc.config.email.from() === STORE.EMAIL_FROM)

    // THE OWNER'S ADDRESS is read the same way, because the control plane had not chosen
    // between the two channels when the template learned to read it: the secret store, which reaches
    // `process.env`, or the `app_env` pairs, which reach each copy's own CONFIG.env. Both must work.
    process.env.OWNER_EMAIL = 'owner@from-the-store.test'
    check('PRECONDITION: the copy\'s CONFIG.env carries no OWNER_EMAIL', !('OWNER_EMAIL' in pcore.ownConfig()))
    check('both copies read the owner\'s address the secret store delivered, through process.env',
      pc.config.ownerEmail() === 'owner@from-the-store.test' && qc.config.ownerEmail() === 'owner@from-the-store.test')
    const O = makeCopy({ ...PUBLISHED_ENV, OWNER_EMAIL: ' owner@from-the-file.test ' })
    const oc = await load(O, 'lib/sign-in-config.js')
    check('a copy whose CONFIG.env carries it (the app_env channel) reads its own file\'s value, trimmed, though process.env holds another', oc.config.ownerEmail() === 'owner@from-the-file.test')
    const OB = makeCopy({ ...PUBLISHED_ENV, OWNER_EMAIL: '' })
    const obc = await load(OB, 'lib/sign-in-config.js')
    check('…a blank OWNER_EMAIL line in a copy\'s file does not shadow the store\'s value', obc.config.ownerEmail() === 'owner@from-the-store.test')
    delete process.env.OWNER_EMAIL
    check('…and with neither, it is null — no owner named, which is first come through Bootstrap', pc.config.ownerEmail() === null && obc.config.ownerEmail() === null)
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
  check('…and with the store empty, both copies say mail is NOT set up — which is what AuthApi/request-link refuses on',
    pc.config.email.configured() === false && qc.config.email.configured() === false)
}

section('⚠ A SESSION MINTED IN ONE COPY IS REFUSED BY THE OTHER, OR THE TWO ARE ONE')
{
  // THE ATTACK, and still the reason the stamp exists. The two
  // copies share ONE origin and the cookie is `__Host-`, so it is `Path=/` and reaches both by
  // construction. The preview's `stage` is not guaranteed to hold a `User` row, so a first-admin claim
  // there could be open to anybody — and a session naming the fixed `first-admin` id, replayed on the
  // published copy, would pass `sessionMatchesRow` on the email alone. The signed `db` stamp is what
  // refuses it, and here the two copies are two real module graphs reading two real CONFIG.env files.
  const pa = await load(P, 'lib/auth.js')
  const qa = await load(Q, 'lib/auth.js')
  const founder = { id: 'first-admin', email: 'founder@example.com', name: 'Founder', role: 'admin' }
  const qToken = qa.createSessionToken(founder)
  check('PRECONDITION: a session minted in the preview verifies in the preview', qa.verifySessionToken(qToken)?.userId === 'first-admin')
  check('…and the PUBLISHED copy refuses it — the whole of the finding', pa.verifySessionToken(qToken) === null)
  const pToken = pa.createSessionToken(founder)
  check('PRECONDITION: a published session verifies in the published copy', pa.verifySessionToken(pToken)?.userId === 'first-admin')
  check('…and the preview copy refuses it, so the boundary holds both ways', qa.verifySessionToken(pToken) === null)
  const [payloadStr, sig] = qToken.split('.')
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payloadStr, 'base64url').toString()), db: 'data' })).toString('base64url')
  check('a client that rewrites the stamp to data breaks the signature and is refused', pa.verifySessionToken(`${forged}.${sig}`) === null)
  // AN UNSTAMPED TOKEN IS THE DEFAULT DATABASE: every token minted before the stamp existed was
  // minted by a copy reading `data`.
  const legacyPayload = Buffer.from(JSON.stringify({ userId: 'first-admin', email: 'founder@example.com', name: null, role: 'admin', exp: Date.now() + 3600_000 })).toString('base64url')
  const legacy = `${legacyPayload}.${createHmac('sha256', SECRET).update(legacyPayload).digest('base64url')}`
  check('a token minted before the stamp existed still works in the published copy', pa.verifySessionToken(legacy)?.userId === 'first-admin')
  check('…and is refused by the preview copy, which is the safe direction', qa.verifySessionToken(legacy) === null)
}

section('Bootstrap is refused by the preview copy — a public first-admin claim is not a preview')
{
  const qb = await load(Q, 'resources/Bootstrap.js')
  const pb = await load(P, 'resources/Bootstrap.js')
  const post = await new qb.Bootstrap().post({}, { name: 'A', email: 'founder@example.com', password: 'a-long-enough-password' })
  check('POST is refused 403 by the preview copy', post?.status === 403, JSON.stringify(post?.status))
  check('…with a code a client can branch on', (await bodyOf(post))?.code === 'bootstrap_not_on_preview')
  const get = await new qb.Bootstrap().get({})
  check('…and GET answers the same refusal, so "is bootstrap needed?" is not an oracle on the preview either',
    get?.status === 403 && (await bodyOf(get))?.code === 'bootstrap_not_on_preview')
  let off = null
  try { off = await bodyOf(await new pb.Bootstrap().get({})) } catch (e) { off = { thrown: e.message } }
  check('CONTROL: the published copy is not refused by this rule, so the checks above are a rule and not a broken route',
    off?.code !== 'bootstrap_not_on_preview', JSON.stringify(off))
}

section('the inbound mail webhook is refused by the preview copy — its caller is a machine, not the viewer')
{
  for (const [file, name] of [['resources/InboundEmailApi.js', 'InboundEmailApi']]) {
    const q = await load(Q, file)
    const p = await load(P, file)
    const under = await new q[name]().post({}, {})
    check(`${name} POST is refused 403 by the preview copy`, under?.status === 403, JSON.stringify(under?.status))
    check('…with a code a caller can branch on', (await bodyOf(under))?.code === 'webhook_not_on_preview')
    let off = null
    try { off = await bodyOf(await new p[name]().post({}, {})) } catch (e) { off = { thrown: e.message } }
    check(`CONTROL: the published copy's ${name} is not refused by this rule`, off?.code !== 'webhook_not_on_preview', JSON.stringify(off))
  }
}

section('links and redirects built in the preview come BACK to the preview')
{
  const pa = await load(P, 'lib/auth.js')
  const qa = await load(Q, 'lib/auth.js')
  check('a magic link from the published copy points at the live address', pa.magicLinkUrl('t0k') === `${APP}/AuthApi/verify?token=t0k`)
  check('…and one from the preview copy points back INTO the preview, where its MagicLink row lives', qa.magicLinkUrl('t0k') === `${APP}/preview/AuthApi/verify?token=t0k`)

  // The real route, driven: a failing verify redirects within the copy that served it.
  resetDatabases()
  databases[STAGE] = makeDatabase()
  const location = async (w) => {
    const api = await load(w, 'resources/AuthApi.js')
    const res = await new api.AuthApi().verify(new URLSearchParams('token=nope'))
    return res?.headers?.get?.('location') ?? null
  }
  const qLoc = await location(Q)
  check('a FAILING verify in the preview copy redirects to the preview\'s sign-in page', qLoc !== null && qLoc.startsWith('/preview/'), String(qLoc))
  const pLoc = await location(P)
  check('CONTROL: the same failure in the published copy redirects to the live sign-in page', pLoc !== null && !pLoc.startsWith('/preview'), String(pLoc))
}

for (const w of workdirs) discard(w)
process.exit(done())
