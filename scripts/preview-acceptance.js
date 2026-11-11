#!/usr/bin/env node
// SEEDED — the preview copy: two copies of this app in ONE process,
// the published copy at the app's own address reading `data` and the preview copy under `/preview`
// reading `stage`, and neither may read the other's configuration, database or address.
//
// WHAT THIS SUITE IS FOR, and it is one defect rather than a feature inventory. A build or an
// update sits at preview with dummy data in a different database, and publishing it redeploys it to
// the normal address on the prod database. For an
// update that is two copies of the app running at once on the app's one cluster. They share one
// `process.env` (Harper's `loadEnv` fills it first-writer-wins), one resource registry, one middleware
// chain and one `globalThis` per thread — and every one of those was measured colliding
// on a real `harper@5.3.1` until the copy was built not to: the preview reading production half the
// time, the published app reading dummy rows the other half, the published scheduler not arming, and a
// per-request `/preview` middleware in the published copy hijacking the preview's address.
//
// So this suite builds TWO COPIES OF THIS TREE in two temporary directories, each with its own
// `CONFIG.env`, loads both in this one process, and POISONS `process.env` with the other copy's values
// — the state `loadEnv` would leave behind. Every assertion below is about whether each copy still
// answers as itself. The builder's own deploy-time edits (plugin `urlPath`s, the schema's database,
// the seed's database, no `loadEnv`) are its subject and not this file's; what this file owns is that
// the CODE reads its own copy's configuration and nothing else.
//
// WHAT IT CANNOT SEE, SAID RATHER THAN IMPLIED. It drives the stub, so Harper's own chain resolution,
// its module loader and its per-component config are not exercised here. Those were measured on
// real instances (one local `harper@5.3.1`, and a two-node Fabric cluster at 5.3.0); this file pins the
// code's half so a change to it is visible.
//
// Hermetic: the harperdb stub, temp directories, no network, no git, no clock.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Nothing from the developer's shell may decide a verdict here.
for (const k of ['IMMENSUS_DATABASE', 'IMMENSUS_PREVIEW', 'IMMENSUS_URL_PATH', 'IMMENSUS_SHARING_MOUNTS', 'IMMENSUS_STAGE_DATABASE', 'SESSION_SECRET', 'BUILD_SHA', 'PUBLIC_APP_URL', 'RESEND_API_KEY', 'EMAIL_FROM', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OWNER_EMAIL']) delete process.env[k]

const { checker, ROOT, fixture, discard } = await import('./probe/harness.js')
const { databases, makeDatabase, resetDatabases, server } = await import('./probe/harperdb-stub.js')
const { check, section, done } = checker('preview-acceptance')

const STAGE = 'stage'
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

const PUBLISHED_ENV = { IMMENSUS_DATABASE: 'data', PUBLIC_APP_URL: APP, BUILD_SHA: 'published-sha' }
const PREVIEW_ENV = { IMMENSUS_DATABASE: STAGE, IMMENSUS_PREVIEW: 'true', PUBLIC_APP_URL: APP, BUILD_SHA: 'preview-sha' }
const P = makeCopy(PUBLISHED_ENV)
const Q = makeCopy(PREVIEW_ENV)

// A SHARING APP in this cluster at `/tracker`, and its own preview copy: the two
// rows of lib/copy.js's table that exist only since the mount became a key. Neither is a different tree —
// the builder deploys this same template under another component name with `IMMENSUS_URL_PATH` set.
const TRACKER_ENV = { IMMENSUS_DATABASE: 'data', IMMENSUS_URL_PATH: 'tracker', PUBLIC_APP_URL: APP, BUILD_SHA: 'tracker-sha' }
const TRACKER_PREVIEW_ENV = { IMMENSUS_DATABASE: STAGE, IMMENSUS_URL_PATH: 'tracker/preview', IMMENSUS_PREVIEW: 'true', PUBLIC_APP_URL: APP, BUILD_SHA: 'tracker-preview-sha' }
// The app at the root of that cluster, told which mount is the sharing app's.
const OWNER_ENV = { ...PUBLISHED_ENV, IMMENSUS_SHARING_MOUNTS: 'tracker' }
// Every copy on such a cluster, with the path each must serve under — the table in lib/copy.js's header,
// written here by hand rather than computed by the code under test.
const COPIES = [
  { label: 'the app at the root', env: OWNER_ENV, mount: '', base: '', preview: false },
  { label: 'its preview copy, deployed before the builder wrote the path', env: PREVIEW_ENV, mount: 'preview', base: '/preview', preview: true },
  { label: 'its preview copy, with IMMENSUS_URL_PATH=preview', env: { ...PREVIEW_ENV, IMMENSUS_URL_PATH: 'preview' }, mount: 'preview', base: '/preview', preview: true },
  { label: 'a sharing app at /tracker', env: TRACKER_ENV, mount: 'tracker', base: '/tracker', preview: false },
  { label: 'that sharing app\'s preview copy', env: TRACKER_PREVIEW_ENV, mount: 'tracker/preview', base: '/tracker/preview', preview: true },
]

// What `loadEnv` would leave in `process.env` if the published copy wrote first. Kept for the whole
// suite, so every section below runs in the poisoned state, not only the first.
const poisonWith = (env) => { for (const k of ['IMMENSUS_DATABASE', 'IMMENSUS_PREVIEW', 'IMMENSUS_URL_PATH', 'BUILD_SHA']) delete process.env[k]; Object.assign(process.env, env) }
poisonWith({ IMMENSUS_DATABASE: 'data', BUILD_SHA: 'published-sha' })

const pc = await load(P, 'lib/config.js')
const qc = await load(Q, 'lib/config.js')

section('each copy reads its OWN CONFIG.env, whatever another copy put in process.env')
{
  check('PRECONDITION: process.env holds the PUBLISHED copy\'s values, as loadEnv would after the published copy loaded first',
    process.env.IMMENSUS_DATABASE === 'data' && process.env.BUILD_SHA === 'published-sha' && process.env.IMMENSUS_PREVIEW === undefined)
  check('the preview copy knows it is the preview — from its own file, though process.env says otherwise', qc.config.previewCopy() === true)
  check('…reads `stage`, though process.env says `data` (this read production four restarts in eight)', qc.config.databaseName() === STAGE)
  check('…and reports its OWN build sha, though process.env carries the other copy\'s (measured on a live cluster)', qc.config.buildStamp('BUILD_SHA') === 'preview-sha')
  poisonWith({ IMMENSUS_DATABASE: STAGE, IMMENSUS_PREVIEW: 'true', BUILD_SHA: 'preview-sha' })
  check('the other way round: with the PREVIEW copy\'s values in process.env, the published copy is still not the preview', pc.config.previewCopy() === false)
  check('…still reads `data`', pc.config.databaseName() === 'data')
  check('…and still reports its own sha', pc.config.buildStamp('BUILD_SHA') === 'published-sha')
  poisonWith({ IMMENSUS_DATABASE: 'data', BUILD_SHA: 'published-sha' })

  // CONTROL: the branch the rule exists to keep — an app deployed as-is somewhere with its
  // configuration in the host's environment and no CONFIG.env at all.
  const R = makeCopy({}, { configEnv: false })
  const rc = await load(R, 'lib/config.js')
  process.env.IMMENSUS_DATABASE = 'from-the-host'
  check('CONTROL: a copy with NO CONFIG.env reads process.env, so the lines above are the own-file rule and not a reader that ignores the environment',
    rc.config.databaseName() === 'from-the-host' && rc.config.previewCopy() === false)
  process.env.IMMENSUS_DATABASE = 'data'

  // A CONFIG.env that is THERE and cannot be read is a throw, never a fall back — falling back is how
  // the preview would read the published copy's answer to "am I the preview?". A directory in its
  // place is unreadable as a file for every user, root included, which `chmod 000` is not.
  const U = makeCopy({}, { configEnv: false })
  mkdirSync(join(U, 'CONFIG.env'))
  const uc = await load(U, 'lib/config.js')
  let threw = null
  try { uc.config.databaseName() } catch (e) { threw = e }
  check('a CONFIG.env that exists and cannot be read THROWS rather than falling back to process.env',
    threw !== null && /Refusing to fall back to process\.env/.test(threw.message), String(threw && threw.message))

  // The grammar is dotenv's, because that is what Harper's loadEnv parses with. Expected values are
  // written here by hand from dotenv@16.6.1's rules, not computed by the code under test.
  const parsed = qc.parseConfigEnv('A=1\nB="x\\ny"\n# comment\nexport C= spaced  # trailing\nD=\'q\'\nE=\nF=a=b\nG:  h\r\nH="#not a comment"\n')
  check('CONFIG.env is parsed the way Harper\'s loadEnv parses it (dotenv)',
    JSON.stringify(parsed) === JSON.stringify({ A: '1', B: 'x\ny', C: 'spaced', D: 'q', E: '', F: 'a=b', G: 'h', H: '#not a comment' }), JSON.stringify(parsed))
}

section('THE ONE EXCEPTION: per-app values come from the secret store through process.env, in both copies')
{
  // What Harper's secret store leaves in `process.env` once the control plane has delivered the user's
  // keys with `processEnv: true`. None of them is in either copy's CONFIG.env —
  // the platform never writes them there — which is the state a real app was in. The core reads the AI key
  // itself (`config.modelApiKey`); the mail pair and the owner's address are read by the sign-in kit
  // through the same `secretSource`, and its own suite drives those (`sign-in-preview-acceptance`).
  const STORE = { RESEND_API_KEY: 're_from_the_store', EMAIL_FROM: 'no-reply@mail.x.immensus.app', ANTHROPIC_API_KEY: 'sk-ant-from-the-store' }
  const OTHERS = { RESEND_WEBHOOK_SECRET: 'whsec_from_env', STRIPE_SECRET_KEY: 'sk_test_from_env', GOOGLE_CLIENT_ID: 'from-env.apps.googleusercontent.com' }
  const ALL = [...Object.keys(STORE), ...Object.keys(OTHERS), 'OPENAI_API_KEY', 'OWNER_EMAIL']
  const saved = Object.fromEntries(ALL.map((k) => [k, process.env[k]]))
  Object.assign(process.env, STORE, OTHERS)
  delete process.env.OPENAI_API_KEY
  try {
    check('PRECONDITION: neither copy\'s CONFIG.env carries a mail or model key, and process.env carries the store\'s',
      ['RESEND_API_KEY', 'EMAIL_FROM', 'ANTHROPIC_API_KEY'].every((k) => !(k in pc.ownConfig()) && !(k in qc.ownConfig()) && process.env[k] === STORE[k]))
    for (const [label, c] of [['the published copy', pc], ['the preview copy', qc]]) {
      check(`${label} reads the AI-service key the store holds, and undefined for the vendor nobody chose`,
        c.config.modelApiKey('ANTHROPIC_API_KEY') === STORE.ANTHROPIC_API_KEY && c.config.modelApiKey('OPENAI_API_KEY') === undefined)
      check(`${label}'s secretSource hands a listed name the store's value — the channel the sign-in kit reads the mail pair through`,
        c.secretSource('RESEND_API_KEY').RESEND_API_KEY === STORE.RESEND_API_KEY)
      // THE NARROWNESS CONTROL, and it is what keeps this an exception rather than the old reader back:
      // every other key is still this copy's own file or nothing, read through the core's ordinary reader.
      check(`${label} still reads NOTHING ELSE from process.env — the webhook secret, the Stripe key and the Google client id stay file-only`,
        c.optional('RESEND_WEBHOOK_SECRET', '') === '' && c.optional('STRIPE_SECRET_KEY', '') === '' && c.optional('GOOGLE_CLIENT_ID', '') === '')
    }
    check('the allow-list is these five names and no others — four secrets and the owner\'s address — so widening it is a change to this line, with a reason in lib/config.js',
      JSON.stringify(pc.PER_APP_VALUES) === JSON.stringify(['RESEND_API_KEY', 'EMAIL_FROM', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OWNER_EMAIL']) &&
      JSON.stringify(pc.PER_APP_SECRETS) === JSON.stringify(['RESEND_API_KEY', 'EMAIL_FROM', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']))
    let threw = null
    try { pc.config.modelApiKey('GEMINI_API_KEY') } catch (e) { threw = e }
    check('a vendor name the platform does not deliver THROWS, naming the two it does, rather than reading as "no key yet"',
      threw !== null && /ANTHROPIC_API_KEY and OPENAI_API_KEY/.test(threw.message), String(threw && threw.message))

    // A BLANK line is no line: the platform's CONFIG.env writer emits every key whether or not it is set.
    const B = makeCopy({ ...PUBLISHED_ENV, ANTHROPIC_API_KEY: ' ' })
    const bc = await load(B, 'lib/config.js')
    check('a copy whose file carries the key BLANK still reads the store\'s', bc.config.modelApiKey('ANTHROPIC_API_KEY') === STORE.ANTHROPIC_API_KEY)

    // THE FILE STILL WINS WHEN IT SAYS SOMETHING, so a hand-written CONFIG.env means what it says.
    const F = makeCopy({ ...PUBLISHED_ENV, ANTHROPIC_API_KEY: 'sk-ant-from-the-file' })
    const fc = await load(F, 'lib/config.js')
    check('a copy whose file carries the AI-service key reads the file\'s, though process.env holds another', fc.config.modelApiKey('ANTHROPIC_API_KEY') === 'sk-ant-from-the-file')
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
  check('…and with the store empty, both copies read no AI-service key', pc.config.modelApiKey('ANTHROPIC_API_KEY') === undefined && qc.config.modelApiKey('ANTHROPIC_API_KEY') === undefined)
}

section('which database each copy reads — its own, and the preview never production')
resetDatabases()
databases[STAGE] = makeDatabase()
const pdb = await load(P, 'lib/db.js')
const qdb = await load(Q, 'lib/db.js')
{
  await databases.data.Thing.put({ id: 'one', note: 'REAL (data)' })
  await databases[STAGE].Thing.put({ id: 'one', note: 'DUMMY (stage)' })
  check('the published copy reads data', (await pdb.db.Thing.get('one'))?.note === 'REAL (data)')
  check('the preview copy reads stage', (await qdb.db.Thing.get('one'))?.note === 'DUMMY (stage)')
  // Interleaved across awaits: nothing here is per-request any more, so nothing can cross over.
  const [a, b, c] = await Promise.all([
    (async () => { await null; return (await qdb.db.Thing.get('one'))?.note })(),
    (async () => { await null; await null; return (await pdb.db.Thing.get('one'))?.note })(),
    (async () => (await qdb.db.Thing.get('one'))?.note)(),
  ])
  check('interleaved reads from the two copies each get their own database', a === 'DUMMY (stage)' && b === 'REAL (data)' && c === 'DUMMY (stage)', JSON.stringify([a, b, c]))
  await qdb.db.Thing.put({ id: 'two', note: 'written in the preview' })
  check('a write made in the preview lands in stage and NOT in data',
    (await databases[STAGE].Thing.get('two'))?.note === 'written in the preview' && (await databases.data.Thing.get('two')) == null)

  // THE PREVIEW IS PUBLIC, so a preview copy pointed at the default database refuses rather than
  // serving real rows. Both shapes that produce it: no IMMENSUS_DATABASE at all, and `data` named.
  for (const [label, env] of [['with no IMMENSUS_DATABASE', { IMMENSUS_PREVIEW: 'true' }], ['with IMMENSUS_DATABASE=data', { IMMENSUS_PREVIEW: 'true', IMMENSUS_DATABASE: 'data' }]]) {
    const bad = await load(makeCopy(env), 'lib/db.js')
    let threw = null
    try { bad.selectedDatabaseName() } catch (e) { threw = e }
    check(`a preview copy ${label} REFUSES to read the published database — the preview path is public`,
      threw !== null && /PREVIEW copy/.test(threw.message) && threw.message.includes('IMMENSUS_DATABASE'), String(threw && threw.message))
  }
  const plain = await load(makeCopy({ PUBLIC_APP_URL: APP }), 'lib/db.js')
  check('CONTROL: a published copy with no IMMENSUS_DATABASE reads data, so the refusal above is the preview\'s and not a broken default',
    plain.selectedDatabaseName() === 'data')
}

section('links and redirects built in the preview come BACK to the preview')
{
  // The sign-in kit's emailed links and its verify route's redirects are driven by its own suite
  // (`sign-in-preview-acceptance`); what is the core's is the rule they are built with.
  const pcopy = await load(P, 'lib/copy.js')
  const qcopy = await load(Q, 'lib/copy.js')
  check('a public URL built in the published copy is the live address', pcopy.publicBaseFor(APP) === APP)
  check('…and one built in the preview copy points back INTO the preview', qcopy.publicBaseFor(APP) === `${APP}/preview`)
  check('the published copy\'s paths are unchanged', pcopy.previewPath('/login?error=x') === '/login?error=x' && pcopy.copyBase() === '')
  check('the preview copy prefixes a site-relative path', qcopy.previewPath('/login?error=x') === '/preview/login?error=x' && qcopy.copyBase() === '/preview')
  check('…the root too, which is the most common redirect', qcopy.previewPath('/') === '/preview/')
  check('…idempotently, so a caller that prefixes twice cannot produce /preview/preview', qcopy.previewPath(qcopy.previewPath('/login')) === '/preview/login')
  check('…never rewriting an absolute URL or a non-path', qcopy.previewPath('https://elsewhere.example/x') === 'https://elsewhere.example/x' && qcopy.previewPath(undefined) === undefined)

  // THE FORGOTTEN-CASE GATE: every `redirect(` under resources/ passes through previewPath, so one
  // added without it reds here rather than walking a person out of their preview.
  // Over whatever resources/ holds — the core has no redirect at all, and a kit's or the app's own are
  // held to the same rule the day they arrive.
  const resourceFiles = readdirSync(join(ROOT, 'resources')).filter((f) => f.endsWith('.js'))
  const unprefixed = []
  for (const f of resourceFiles) {
    for (const line of readFileSync(join(ROOT, 'resources', f), 'utf8').split('\n')) {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue
      if (!/\bredirect\(/.test(line) || /function redirect/.test(line)) continue
      if (!/redirect\(\s*previewPath\(/.test(line)) unprefixed.push(`${f}: ${line.trim().slice(0, 80)}`)
    }
  }
  check(`every redirect( in resources/ goes through previewPath (${resourceFiles.length} files scanned)`, unprefixed.length === 0, unprefixed.join(' | '))
  const synth = ['return redirect(`${SIGN_IN_PATH}?error=x`)', 'return redirect(previewPath("/ok"))'].filter((line) => !/redirect\(\s*previewPath\(/.test(line))
  check('CONTROL: the same rule flags an unprefixed redirect and not a prefixed one', synth.length === 1 && synth[0].includes('SIGN_IN_PATH'))
}

section('a copy at a sharing app\'s mount: every URL follows IMMENSUS_URL_PATH, and "is this the preview?" stays the flag')
{
  // What a sharing app's `loadEnv` would leave in process.env, so every copy below has to read its own file.
  poisonWith({ IMMENSUS_DATABASE: 'data', IMMENSUS_URL_PATH: 'tracker', BUILD_SHA: 'tracker-sha' })
  const jsonFn = (body, status) => ({ status, body })
  for (const { label, env, base, preview } of COPIES) {
    const c = await load(makeCopy(env), 'lib/copy.js')
    check(`${label}: serves under ${base || 'the root'} and ${preview ? 'IS' : 'is NOT'} the preview`, c.copyBase() === base && c.isPreviewCopy() === preview, JSON.stringify([c.copyBase(), c.isPreviewCopy()]))
    check(`${label}: a redirect stays in this copy, the root included`, c.previewPath('/login?error=x') === `${base}/login?error=x` && c.previewPath('/') === `${base}/`, JSON.stringify([c.previewPath('/login?error=x'), c.previewPath('/')]))
    check(`${label}: …idempotently, and never rewriting an absolute URL`, c.previewPath(c.previewPath('/login')) === `${base}/login` && c.previewPath('https://elsewhere.example/x') === 'https://elsewhere.example/x')
    check(`${label}: an emailed link comes back to this copy`, c.publicBaseFor(APP) === `${APP}${base}` && c.publicBaseFor(`${APP}/`) === (base ? `${APP}${base}` : `${APP}/`), c.publicBaseFor(APP))
    const refused = c.refuseOnPreview(jsonFn, { error: 'e', code: 'c' })
    check(`${label}: a third party's webhook is ${preview ? 'refused, as in every preview' : 'taken — a copy at a path is not a preview'}`, preview ? refused?.status === 403 : refused === null, JSON.stringify(refused))
  }
  // A preview copy with no path in its file is where the old answer comes from; one that NAMES a path
  // must get that path and not `/preview`, or the flag would still be deciding where a copy lives.
  const named = await load(makeCopy({ ...PREVIEW_ENV, IMMENSUS_URL_PATH: 'tracker/preview' }), 'lib/copy.js')
  check('CONTROL: a preview copy whose file names a mount is at that mount, not at /preview, so the flag no longer decides the path', named.copyBase() === '/tracker/preview')
  const slashed = await load(makeCopy({ ...TRACKER_ENV, IMMENSUS_URL_PATH: '/tracker/' }), 'lib/copy.js')
  check('a mount written with its slashes is the same mount (NEG)', slashed.copyBase() === '/tracker')
  const blank = await load(makeCopy({ ...PUBLISHED_ENV, IMMENSUS_URL_PATH: ' ' }), 'lib/copy.js')
  check('a BLANK IMMENSUS_URL_PATH is absent: the copy is at the root, though process.env says tracker', blank.copyBase() === '' && process.env.IMMENSUS_URL_PATH === 'tracker')
  // A mount that is not lower-case segments is refused by name rather than repaired: a repaired mount
  // differs from the address the platform recorded, and `..` would compose links into the app at the root.
  for (const bad of ['Tracker', 'tracker/../admin', '..', 'track er', 'tracker//preview']) {
    const c = await load(makeCopy({ ...TRACKER_ENV, IMMENSUS_URL_PATH: bad }), 'lib/copy.js')
    let threw = null
    try { c.copyBase() } catch (e) { threw = e }
    check(`IMMENSUS_URL_PATH=${JSON.stringify(bad)} THROWS naming the key, rather than serving somewhere it was not sent`, threw !== null && threw.message.includes('IMMENSUS_URL_PATH'), String(threw && threw.message))
  }
  const owner = await load(makeCopy({ ...PUBLISHED_ENV, IMMENSUS_SHARING_MOUNTS: ' tracker, /notes/ ,,' }), 'lib/copy.js')
  check('the root copy reads the other apps\' mounts as absolute paths, blanks and slashes dropped', JSON.stringify(owner.sharingMounts()) === JSON.stringify(['/tracker', '/notes']), JSON.stringify(owner.sharingMounts()))
  const alone = await load(makeCopy(PUBLISHED_ENV), 'lib/copy.js')
  check('…and a copy told of none has none (NEG)', alone.sharingMounts().length === 0)
  poisonWith({ IMMENSUS_DATABASE: 'data', BUILD_SHA: 'published-sha' })
}

section('each copy serves its pages and its stamp at its own address, and declines the other\'s')
{
  // resources/Pages.js uses Harper's `server` global, as every jsResource module may.
  globalThis.server = server
  server.httpListeners.length = 0
  await load(P, 'resources/Pages.js')
  await load(Q, 'resources/Pages.js')
  const [pl, ql] = server.httpListeners
  check('each copy registers exactly one listener', server.httpListeners.length === 2)
  check('both run BEFORE rest, where a page route has to be answered', pl?.options?.before === 'rest' && ql?.options?.before === 'rest')
  check('…neither passes urlPath, which would give it an isolated chain that 404s everything', !('urlPath' in (pl?.options ?? {})) && !('urlPath' in (ql?.options ?? {})))
  check('…and the two are named differently, because they share one chain', pl?.options?.name === 'immensus-pages' && ql?.options?.name === 'immensus-pages/preview', JSON.stringify([pl?.options?.name, ql?.options?.name]))
  const NEXT = Symbol('next')
  const req = (url) => ({ method: 'GET', url, pathname: url.split('?')[0], headers: { get: () => 'x.immensus.app' } })
  const answer = (l, url) => l.listener(req(url), () => NEXT)
  const sha = (r) => (r === NEXT ? null : JSON.parse(r.body).sha)
  check('GET /build answers the published copy\'s own sha, and the preview copy passes it on', sha(answer(pl, '/build')) === 'published-sha' && answer(ql, '/build') === NEXT)
  check('GET /preview/build answers the PREVIEW copy\'s own sha, and the published copy passes it on', sha(answer(ql, '/preview/build')) === 'preview-sha' && answer(pl, '/preview/build') === NEXT)
  check('the shell at / is the published copy\'s alone', answer(pl, '/')?.status === 200 && answer(ql, '/') === NEXT)
  check('the shell at /preview and /preview/ is the preview copy\'s alone',
    answer(ql, '/preview')?.status === 200 && answer(ql, '/preview/')?.status === 200 && answer(pl, '/preview') === NEXT && answer(pl, '/preview/') === NEXT)
}

section('four copies on one cluster, every root route a catch-all: each path is answered by exactly one copy')
{
  // THE CASE THE ROOT'S OWN ROUTES DECIDE: an app at the root whose routes include `/:slug` and `/*`
  // matches `/tracker` and everything under it, and the listeners are tried in component load order. So
  // every copy here carries those routes, and the answer for every path must come from exactly one copy
  // whatever the order. FRESH copies, because a module evaluates once per process.
  const CATCH_ALL = "export const SPA_ROUTES = ['/', '/:slug', '/*']\n"
  const withCatchAll = (env) => { const w = makeCopy(env); writeFileSync(join(w, 'routes', 'spa.js'), CATCH_ALL); return w }
  const four = [['owner', OWNER_ENV], ['preview', PREVIEW_ENV], ['tracker', TRACKER_ENV], ['tracker-preview', TRACKER_PREVIEW_ENV]]
  server.httpListeners.length = 0
  for (const [, env] of four) await load(withCatchAll(env), 'resources/Pages.js')
  const listeners = [...server.httpListeners]
  const names = listeners.map((l) => l?.options?.name)
  check('each of the four copies registers one listener, named from its own mount', JSON.stringify(names) === JSON.stringify(['immensus-pages', 'immensus-pages/preview', 'immensus-pages/tracker', 'immensus-pages/tracker/preview']), JSON.stringify(names))
  const pages = await load(P, 'lib/pages.js')
  check('PRECONDITION: the root\'s routes really do match /tracker and what is under it, so the declines below are not vacuous',
    pages.isPage('/tracker', ['/', '/:slug', '/*']) && pages.isPage('/tracker/preview/x', ['/', '/:slug', '/*']))
  const NEXT = Symbol('next')
  const req = (url) => ({ method: 'GET', url, pathname: url.split('?')[0], headers: { get: () => 'x.immensus.app' } })
  const who = (url) => listeners.filter((l) => l.listener(req(url), () => NEXT) !== NEXT).map((l) => l.options.name)
  const OWNERS = {
    '/': 'immensus-pages', '/account': 'immensus-pages', '/trackers': 'immensus-pages', '/previewish': 'immensus-pages', '/build': 'immensus-pages',
    '/preview': 'immensus-pages/preview', '/preview/account': 'immensus-pages/preview',
    '/tracker': 'immensus-pages/tracker', '/tracker/': 'immensus-pages/tracker', '/tracker/account': 'immensus-pages/tracker', '/tracker/previewish': 'immensus-pages/tracker', '/tracker/build': 'immensus-pages/tracker',
    '/tracker/preview': 'immensus-pages/tracker/preview', '/tracker/preview/account': 'immensus-pages/tracker/preview', '/tracker/preview/build': 'immensus-pages/tracker/preview',
  }
  const wrong = Object.entries(OWNERS).filter(([url, name]) => JSON.stringify(who(url)) !== JSON.stringify([name])).map(([url]) => `${url} → ${JSON.stringify(who(url))}`)
  check(`every one of ${Object.keys(OWNERS).length} paths is answered by its own copy and by no other`, wrong.length === 0, wrong.join(' | '))
  const stampOf = (url) => { const l = listeners.find((x) => x.options.name === OWNERS[url]); return JSON.parse(l.listener(req(url), () => NEXT).body).sha }
  check('…and each /build is the stamp of the copy at that mount', stampOf('/build') === 'published-sha' && stampOf('/tracker/build') === 'tracker-sha' && stampOf('/tracker/preview/build') === 'tracker-preview-sha')

  // CONTROL: the same root copy NOT told of the sharing app answers `/tracker` through its catch-all —
  // the defect IMMENSUS_SHARING_MOUNTS exists for, provoked, so the line above is the key and not the routes.
  server.httpListeners.length = 0
  await load(withCatchAll(PUBLISHED_ENV), 'resources/Pages.js')
  const [untold] = server.httpListeners
  check('CONTROL: a root copy with no IMMENSUS_SHARING_MOUNTS answers /tracker itself, which is the collision the key prevents', untold.listener(req('/tracker/account'), () => NEXT) !== NEXT)
  check('…while still declining /preview, which every copy reserves without being told', untold.listener(req('/preview/account'), () => NEXT) === NEXT)
  // A copy handed its OWN mount in the list still answers: only a mount strictly under its base is declined.
  check('a copy whose list names its own mount still answers there (NEG)', pages.relativeTo('/tracker/x', '/tracker', ['/tracker']) === '/x' && pages.relativeTo('/tracker', '/tracker', ['/tracker']) === '/')
}

section('⚠ THE PUBLISHED COPY LEAVES /preview ALONE — nothing it registers rewrites or answers it')
{
  // A published copy carrying the old per-request middleware rewrote
  // `/preview/Probe` to `/Probe` ahead of REST, so the preview ADDRESS served the PUBLISHED code reading
  // `stage`. So every listener every resource module of the published copy registers is driven with a
  // request under `/preview`, and none may touch its URL or answer it. Driven over whatever the app's
  // resources/ hold, so a listener an app adds later is covered too.
  // A FRESH published copy: a module evaluates once per process, so one this suite already loaded
  // would register nothing the second time and the check below would pass on an empty list.
  const P2 = makeCopy(PUBLISHED_ENV)
  server.httpListeners.length = 0
  const quiet = console.log
  console.log = () => {}
  for (const f of readdirSync(join(P2, 'resources')).filter((x) => x.endsWith('.js'))) await load(P2, `resources/${f}`)
  console.log = quiet
  const listeners = [...server.httpListeners]
  const touched = []
  for (const { listener, options } of listeners) {
    const r = { method: 'GET', url: '/preview/AuthApi/me', pathname: '/preview/AuthApi/me', headers: { get: () => 'x.immensus.app' } }
    let passed = false
    const out = await listener(r, (x) => { passed = x === r; return 'NEXT' })
    if (r.url !== '/preview/AuthApi/me' || out !== 'NEXT' || !passed) touched.push(options?.name ?? '(unnamed)')
  }
  check(`no listener the published copy registers rewrites or answers a /preview request (${listeners.length} listener(s))`,
    listeners.length > 0 && touched.length === 0, touched.join(', '))
  // CONTROL: the old middleware's shape, synthesized, is caught by the same test.
  const legacy = (request, next) => { if (request.url.startsWith('/preview/')) { request.url = request.url.slice('/preview'.length) } return next(request) }
  const r = { method: 'GET', url: '/preview/AuthApi/me', pathname: '/preview/AuthApi/me' }
  legacy(r, () => 'NEXT')
  check('CONTROL: the old per-request middleware\'s rewrite is what that test catches', r.url !== '/preview/AuthApi/me')
}

section('the preview copy runs no scheduled jobs, and does not stop the published copy\'s')
{
  // The preview copy runs no scheduled jobs. And both copies share one
  // `globalThis` per thread, so a preview that set the guard first would stop the PUBLISHED scheduler —
  // measured four restarts in eight. The preview loads FIRST here, which is the order that broke.
  // FRESH copies, for the reason the section above gives: module scope runs once per module.
  const Q3 = makeCopy(PREVIEW_ENV)
  const P3 = makeCopy(PUBLISHED_ENV)
  delete globalThis.__immensusSchedulerStarted
  const qs = await load(Q3, 'resources/Scheduler.js')
  check('the preview copy\'s scheduler does not run', qs.SCHEDULER_RUNS === false)
  check('…and it left the shared guard UNSET', globalThis.__immensusSchedulerStarted === undefined)
  const before = console.log
  console.log = () => {}
  const ps = await load(P3, 'resources/Scheduler.js')
  console.log = before
  check('the published copy\'s scheduler, loaded after it, still arms', ps.SCHEDULER_RUNS === true && globalThis.__immensusSchedulerStarted === true)

  // A SHARING APP'S PUBLISHED COPY IS NOT A PREVIEW, so it runs its loops too — in the same process and
  // the same `globalThis` as the app at the root, which has just armed. Under one shared guard it
  // would find the guard set and never arm. Its preview copy, loaded first, arms nothing and sets nothing.
  const TQ3 = makeCopy(TRACKER_PREVIEW_ENV)
  const T3 = makeCopy(TRACKER_ENV)
  console.log = () => {}
  const tqs = await load(TQ3, 'resources/Scheduler.js')
  const ts = await load(T3, 'resources/Scheduler.js')
  console.log = before
  check('the sharing app\'s preview copy runs no scheduled jobs and sets no guard', tqs.SCHEDULER_RUNS === false && globalThis[tqs.SCHEDULER_GUARD] === undefined)
  check('the sharing app\'s published copy ARMS beside the app at the root, under a guard of its own', ts.SCHEDULER_RUNS === true && ts.SCHEDULER_GUARD !== ps.SCHEDULER_GUARD && globalThis[ts.SCHEDULER_GUARD] === true, JSON.stringify([ts.SCHEDULER_GUARD, ps.SCHEDULER_GUARD]))
  check('…and the app at the root keeps the guard it always had', ps.SCHEDULER_GUARD === '__immensusSchedulerStarted')
}

section('the client asks the copy that served it — its BASE is DRIVEN against every copy\'s server, not grepped')
{
  // The client decides which copy to ask; lib/copy.js decides where each copy serves. The browser cannot
  // tell from a page's own path which leading segments are a mount (`/tracker/settings` is a sharing
  // app's page and also a path a `/:slug/*` route at the root matches), so src/api/client.ts reads the
  // mount out of the URL its own bundle was fetched from — which the builder rebases onto
  // `/<mount>/web/` at deploy time (the platform's `webBase` and
  // `rebaseShell`, read on 2026-10-29; the rule is transcribed below, not imported).
  const webBase = (mount) => `/${mount ? `${mount}/` : ''}web/`
  const client = readFileSync(join(ROOT, 'src/api/client.ts'), 'utf8')
  const code = client.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n')
  const body = client.match(/export function mountBase\(scriptUrl: string\): string \{\n([\s\S]*?)\n\}/)
  check('`mountBase` is still a function of one URL with a plain-JavaScript body, so this suite can drive it', body !== null)
  if (body) {
    const mountBase = new Function('scriptUrl', body[1])
    for (const { label, env, mount } of COPIES) {
      const c = await load(makeCopy(env), 'lib/copy.js')
      const script = `${APP}${webBase(mount)}assets/index-abc123.js`
      check(`${label}: the bundle at ${new URL(script).pathname} asks ${c.copyBase() || 'the root'}, the path that copy's server serves under`, mountBase(script) === c.copyBase(), JSON.stringify([mountBase(script), c.copyBase()]))
    }
    check('vite\'s dev server, a file: URL and a string that is not a URL are all the root', mountBase('http://localhost:5173/src/api/client.ts') === '' && mountBase('file:///app/web/assets/x.js') === '' && mountBase('not a url') === '')
    check('the asset root is the LAST /web/assets/, so a mount whose own segment is web is read whole', mountBase(`${APP}/web/web/assets/i.js`) === '/web')
    check('CONTROL: a script outside an asset directory is the root, so the copy answers above came from the path and not from a constant', mountBase(`${APP}/tracker/elsewhere/i.js`) === '' && mountBase(`${APP}/tracker/web/assets/i.js`) === '/tracker')
  }
  check('BASE is the mount of this module\'s own URL, and no page path decides it', /export const BASE = mountBase\(import\.meta\.url\)/.test(code) && !/location\.pathname/.test(code))
  check('there is exactly one BASE export, used by the request builder and the 403 redirect',
    (client.match(/export const BASE\b/g) ?? []).length === 1 && /fetch\(`\$\{BASE\}\//.test(client) && /location\.replace\(`\$\{BASE\}\$\{path\}`\)/.test(client))

  // react-router matches on the raw pathname, so without a basename a page under /preview finds no
  // route.
  const main = readFileSync(join(ROOT, 'src/main.tsx'), 'utf8')
  check('BrowserRouter is given BASE as its basename, imported from the client', /<BrowserRouter\s+basename=\{BASE\}/.test(main) && /import\s*\{\s*BASE\s*\}\s*from\s*'\.\/api\/client'/.test(main) && !/<BrowserRouter>/.test(main))
}

section('every HARD navigation in the client goes through go()')
{
  // BASE covers `api.*` and the router's basename; neither reaches a `location.replace` or a followed
  // `href`. So the rule is one seam, `go()`, and this is the gate
  // for the case somebody forgets.
  const walk = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])
  const files = walk('src').filter((f) => /\.tsx?$/.test(f) && !f.endsWith('api/client.ts'))
  const isHard = (line) => /location\.(replace|assign)\(|location\.href\s*=/.test(line) || (/\bhref\b/.test(line) && /`\//.test(line))
  const bare = []
  for (const f of files) {
    for (const line of readFileSync(join(ROOT, f), 'utf8').split('\n')) {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*')) continue
      if (isHard(line) && !/\bgo\(/.test(line)) bare.push(`${f}: ${t.slice(0, 70)}`)
    }
  }
  check(`every hard navigation under src/ goes through go() (${files.length} files scanned)`, bare.length === 0, bare.join(' | '))
  check('…and the scan found files to scan, so the line above is not vacuous', files.length > 3)
  const synth = ["location.replace('/')", "location.replace(go('/'))", 'const href = `/AuthApi/verify?x=1`',
    'const href = go(`/x`)', 'const href = token ? (`/AuthApi/verify?x=1`) : null', 'const href = token ? go(`/x`) : null']
    .filter((line) => isHard(line) && !/\bgo\(/.test(line))
  check('CONTROL: the rule flags a bare replace, a bare href AND a parenthesised one, and none of the go() forms', synth.length === 3, synth.join(' | '))

  // go() itself, extracted and driven against each copy's server-side previewPath: the client and the
  // server decide one question from two ends, at every mount.
  const client = readFileSync(join(ROOT, 'src/api/client.ts'), 'utf8')
  const body = client.match(/export function go\(path: string\): string \{\n([\s\S]*?)\n\}/)
  check('go() is still a pure function of a path, so this suite can drive it', body !== null)
  if (body) {
    const mk = (base) => new Function('path', `const BASE = ${JSON.stringify(base)};${body[1]}`)
    const off = mk('')
    check('off the prefix go() is the identity', off('/x') === '/x' && off('/') === '/')
    for (const { label, env, base } of COPIES.filter((x) => x.base)) {
      const c = await load(makeCopy(env), 'lib/copy.js')
      const on = mk(base)
      const shapes = ['/x', '/', '/AuthApi/verify?t=1', `${base}/x`, '/preview/x', '/tracker/x', 'https://e.example/x']
      check(`${label}: go() under ${base} agrees with that copy's previewPath on every shape`, shapes.every((p) => on(p) === c.previewPath(p)), JSON.stringify(shapes.filter((p) => on(p) !== c.previewPath(p))))
    }
  }
}

for (const w of workdirs) discard(w)
process.exit(done())
