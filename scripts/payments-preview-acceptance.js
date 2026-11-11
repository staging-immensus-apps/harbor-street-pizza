#!/usr/bin/env node
// THE PAYMENTS KIT'S HALF OF THE PREVIEW COPY: the preview copy of an
// app runs beside the published one, and Stripe's webhook is refused there — its caller is Stripe's
// machine and never the person looking at their own build, so a preview has nothing to receive and a
// public surface to take off the internet (lib/copy.js `refuseOnPreview`).
//
// Copied into an app with the rest of the payments kit when a plan calls api.stripe.com.
// It was one row of the core's `preview-acceptance` while payments shipped in
// every app. Two copies of the tree, each with its own `CONFIG.env`, in one process with `process.env`
// POISONED by the other copy's values.
//
// Hermetic: the harperdb stub, temp directories, no network, no git, no clock.

import { register } from 'node:module'
register('./probe/loader.js', import.meta.url)

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Nothing from the developer's shell may decide a verdict here.
for (const k of ['IMMENSUS_DATABASE', 'IMMENSUS_PREVIEW', 'IMMENSUS_STAGE_DATABASE', 'SESSION_SECRET', 'BUILD_SHA', 'PUBLIC_APP_URL', 'RESEND_API_KEY', 'EMAIL_FROM', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OWNER_EMAIL']) delete process.env[k]

const { checker, ROOT, fixture, discard } = await import('./probe/harness.js')
const { databases, makeDatabase, resetDatabases, server } = await import('./probe/harperdb-stub.js')
const { check, section, done } = checker('payments-preview-acceptance')

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


section('the Stripe webhook is refused by the preview copy — its caller is a machine, not the viewer')
{
  for (const [file, name] of [['resources/StripeWebhook.js', 'StripeWebhook']]) {
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

for (const w of workdirs) discard(w)
process.exit(done())
