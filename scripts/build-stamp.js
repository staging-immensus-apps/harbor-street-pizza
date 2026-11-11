#!/usr/bin/env node
/**
 * FIXED — taken from a real app's scripts/build-stamp.js;
 * the only template edits are the default origin (PUBLIC_APP_URL, no hard-coded host), the
 * `static` family path (/web/), and the removal of the --prod alias.
 *
 * Whose build is this environment serving — on EVERY node, to a NEW connection?
 *
 * Started as the staging-ownership check: `deploy-staging.yml` serializes deploys but
 * nothing held the instance during the verification window, so a sibling's deploy replaced
 * your code while you were still probing it, and the dangerous half was a probe that PASSED
 * against someone else's build. It became the deploy gate's reader of `GET /build` after
 * that, which is why the second question now matters as much as the first.
 *
 * WHAT AN ENVIRONMENT ACTUALLY IS (measured 2026-09-11, tier 1):
 *
 *   - PROD is two Harper Fabric nodes (`p0q-us-east5-a-1`, `2jh-us-west1-a-1`) behind a
 *     geo-DNS pool, ONE http thread each. Any single resolver reaches one node, so sampling
 *     the public origin N times can describe one node N times.
 *   - STAGING is two nodes (`f0z-us-central1-a-1`, `bpd-us-west2-a-1`), TWO http threads
 *     each. Its `processStartedAt` alternating on one hostname is the threads; the second
 *     node is only visible through the deploy CLI's `replicated:` list and cluster_status.
 *
 * `harper deploy … replicated=true restart=rolling` returns once the nodes ACCEPT the
 * restart, before any of them has finished it, and the order the nodes
 * roll in changes between deploys. The old gate went green before the second node rolled
 * on prod and on staging.
 *
 * So "landed" is defined per node, and this file is where that definition lives:
 *
 *   every node discovered from Harper's own cluster_status serves THIS run's sha, run id and
 *   run attempt to a NEW connection, from a process that started after that node's
 *   pre-deploy baseline — and, when the deploy CLI printed one, Harper's restart job says
 *   COMPLETE (it ends only after every peer's own restart job has completed; three prod
 *   deploys measured it finishing ~5s after the last node's new process started).
 *
 * NEW connections, not merely new requests: Harper v5 starts new threads before the old ones
 * stop, and an old thread keeps serving the connections it already holds. A keep-alive
 * sampler can therefore stay pinned to old code after the roll (a false red that flaps), or
 * to a new thread while fresh connections still reach old code (a false green). Every
 * request here opens its own socket and sends `Connection: close` — see freshRequest().
 *
 * Modes:
 *
 *   node scripts/build-stamp.js                                   # staging, public origin
 *   node scripts/build-stamp.js --expect HEAD [--watch 600]       # ...is it MY commit?
 *
 *   node scripts/build-stamp.js --discover --ops-env .env --out nodes.json
 *   node scripts/build-stamp.js --capture-baseline --nodes nodes.json --out baseline.json
 *   node scripts/build-stamp.js --fleet --nodes nodes.json --expect HEAD \
 *        [--baseline baseline.json] [--expect-run <id> --expect-attempt <n>] \
 *        [--job <restartJobId> --ops-env .env] [--deployed-to a,b] [--quiet]
 *
 * `--discover` and `--job` read CLI_TARGET / _USERNAME / _PASSWORD from the given env file
 * (the same file the Harper CLI deploys with) and talk to Harper's Ops API READ-ONLY:
 * `cluster_status` and `get_job`, nothing else. The credentials are only ever sent to the
 * Ops target itself or to a node name under the cluster's own domain.
 *
 * Exit codes are the point — this is used in `&&` chains, poll loops, and by agents:
 *   0  OK        the stamp matches (fleet: every node, and the restart job if given)
 *   3  MISMATCH  a node is serving a different build or a different deploy of this commit
 *   4  UNUSABLE  unreachable, unstamped, split, partial quorum, not warm, or not rolled
 *   5  USAGE     bad arguments or an unreadable nodes/baseline/env file — the gate cannot run
 *   6  PENDING   every node agrees but Harper's restart job has not completed (or is not found)
 *   7  FATAL     the restart job FAILED, or the deploy reached a node discovery did not find
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

// The default origin is the app itself: every generated app has one public URL, written to
// CONFIG.env as PUBLIC_APP_URL. Pass --url to sample anything else.
const DEFAULT_ORIGIN = (process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '')

export const EXIT = { OK: 0, MISMATCH: 3, UNUSABLE: 4, USAGE: 5, PENDING: 6, FATAL: 7 }

// Enough to see both threads of a two-thread node with high probability, cheap enough to run
// per node per poll: each sample is its own TLS handshake now.
export const SAMPLES = 6

// The three component families the smoke suite depends on. Checked on every node, because a
// node whose Fastify is up while its static handler is still cold 404s the smoke suite for
// whichever user the edge routes there (staging, 2026-08-13).
const FAMILIES = [['rest', '/AuthApi/me'], ['fastify', '/'], ['static', '/web/index.html']]

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * PURE comparison of one public-origin read — no network, no git. The single-origin mode
 * still uses it; the fleet mode below applies the same rules per node.
 */
export function compare(stamp, expectedSha) {
  if (!stamp || typeof stamp !== 'object') {
    return { code: EXIT.UNUSABLE, reason: 'no stamp in response' }
  }
  if (!stamp.sha) {
    return { code: EXIT.UNUSABLE, reason: 'environment is UNSTAMPED — it is running code from before the stamp existed, so it cannot tell you whose build it is' }
  }
  // A split fleet is untrustworthy no matter which side your sha is on: some fraction of
  // requests — including your browser's — lands on the worker running the other build.
  if (stamp.workerShas && stamp.workerShas.length > 1) {
    const seen = stamp.workerShas.map(s => (s ? s.slice(0, 7) : '<unstamped>')).join(', ')
    return { code: EXIT.UNUSABLE, reason: `SPLIT FLEET — workers disagree (${seen}). The roll is half-done or a takeover is landing; nothing you probe now is attributable. Re-check in a few seconds.` }
  }
  // Fail CLOSED on a sample that never answered: mid-restart workers refuse connections, and
  // trusting whichever subset replied would report "this is your build" from the one worker
  // still on your old code, moments before the fleet converges on someone else's.
  if (stamp.unanswered > 0) {
    return { code: EXIT.UNUSABLE, reason: `${stamp.unanswered} of ${stamp.unanswered + (stamp.workers ?? 0)} samples never answered — workers are restarting, or a takeover is in progress. The ones that did reply are not a quorum. Re-check in a few seconds.` }
  }
  if (!expectedSha) return { code: EXIT.OK, reason: 'no --expect given; reporting only' }
  const n = Math.min(stamp.sha.length, expectedSha.length)
  if (n < 7) return { code: EXIT.USAGE, reason: `--expect needs at least 7 hex chars, got "${expectedSha}"` }
  const same = stamp.sha.slice(0, n).toLowerCase() === expectedSha.slice(0, n).toLowerCase()
  return same
    ? { code: EXIT.OK, reason: 'serving your commit' }
    : { code: EXIT.MISMATCH, reason: `serving ${stamp.ref ?? 'unknown ref'} @ ${stamp.sha.slice(0, 7)}, you expected ${expectedSha.slice(0, 7)}` }
}

function shaMatches(sha, expected) {
  const n = Math.min(sha.length, expected.length)
  return n >= 7 && sha.slice(0, n).toLowerCase() === expected.slice(0, n).toLowerCase()
}

const short = s => (s ? String(s).slice(0, 7) : '<unstamped>')
const clock = iso => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t).toISOString().slice(11, 23) : String(iso)
}

/**
 * PURE: one node's verdict from one poll's fresh-connection samples.
 *
 * `obs`      { name, stamps: [/build bodies], unanswered, error, families: { rest, fastify, static } }
 * `expected` { sha, runId, runAttempt }
 * `baseline` { maxProcessStartedAt } | null — null is a MISSING baseline, never a pass
 */
/**
 * WHICH PROCESS answered, from `/build`'s host + pid + start time.
 *
 * Returns null when the stamp predates the field — which is not a loophole, because the only
 * stamps required to carry it are the ones claiming to BE this deploy (see judgeNode). A
 * pre-deploy baseline reads the old build by definition, so demanding it everywhere would
 * make the deploy that introduces the field fail its own gate.
 */
export function processIdentity(s) {
  if (!s || typeof s !== 'object') return null
  const host = typeof s.host === 'string' ? s.host.trim() : ''
  const pid = s.pid === 0 || s.pid ? String(s.pid).trim() : ''
  if (!host || !pid) return null
  return `${host}|${pid}|${s.processStartedAt ?? ''}`
}

export function judgeNode(obs, expected, baseline) {
  const name = obs?.name ?? '<unnamed node>'
  const stamps = Array.isArray(obs?.stamps) ? obs.stamps : []
  const unanswered = obs?.unanswered ?? 0
  const total = stamps.length + unanswered
  if (!stamps.length) {
    return { code: EXIT.UNUSABLE, reason: `${name}: UNREACHABLE — none of ${total || SAMPLES} fresh-connection samples answered${obs?.error ? ` (${obs.error})` : ''}. A node the gate cannot read never counts as converged.` }
  }
  if (unanswered > 0) {
    return { code: EXIT.UNUSABLE, reason: `${name}: ${unanswered} of ${total} samples never answered — threads are restarting; the ones that replied are not a quorum` }
  }
  if (stamps.some(s => !s || typeof s !== 'object' || !s.sha)) {
    return { code: EXIT.UNUSABLE, reason: `${name}: UNSTAMPED — a process with no BUILD_* keys answered, so it cannot say whose build it is` }
  }
  const identity = s => `${s.sha}|${s.runId ?? ''}|${s.runAttempt ?? ''}`
  const identities = [...new Set(stamps.map(identity))]
  if (identities.length > 1) {
    const seen = identities.map(i => { const [sha, run, att] = i.split('|'); return `${short(sha)} run ${run || '?'}#${att || '?'}` }).join(', ')
    return { code: EXIT.UNUSABLE, reason: `${name}: SPLIT — threads on this node disagree (${seen}); the roll is half-done here` }
  }
  const s = stamps[0]
  if (!shaMatches(s.sha, expected.sha)) {
    return { code: EXIT.MISMATCH, reason: `${name}: serving ${s.ref ?? 'unknown ref'} @ ${short(s.sha)} (run ${s.runId ?? '?'}), not ${short(expected.sha)}` }
  }
  // Same sha is not the same deploy: a re-run, or a second merge of an identical tree, puts
  // our sha on the box before this run's processes exist. Run id + attempt are unique per
  // deploy attempt.
  if (expected.runId && String(s.runId) !== String(expected.runId)) {
    return { code: EXIT.MISMATCH, reason: `${name}: serving this commit from a DIFFERENT deploy (run ${s.runId ?? '?'} attempt ${s.runAttempt ?? '?'}) — this run's processes have not started here yet` }
  }
  if (expected.runAttempt && String(s.runAttempt) !== String(expected.runAttempt)) {
    return { code: EXIT.MISMATCH, reason: `${name}: serving run ${s.runId} attempt ${s.runAttempt ?? '?'}, not attempt ${expected.runAttempt} — this attempt's processes have not started here yet` }
  }
  // Everything below here has agreed this node is serving this run's build — so these stamps
  // came from code that carries the identity field, and one that does not has been rewritten
  // in flight (a cache, a proxy, a shim). Scoping the requirement to matching stamps is what
  // lets it be HARD from the first deploy instead of a soft note waiting on a flag day.
  if (stamps.some(x => !processIdentity(x))) {
    return { code: EXIT.UNUSABLE, reason: `${name}: claims this deploy but reports no process identity (host/pid) — /build in this build always carries one, so something between here and the app is rewriting the response` }
  }
  const base = baseline?.maxProcessStartedAt ? Date.parse(baseline.maxProcessStartedAt) : NaN
  if (Number.isFinite(base)) {
    const stale = stamps.filter(x => !(Date.parse(x.processStartedAt) > base))
    if (stale.length) {
      return { code: EXIT.UNUSABLE, reason: `${name}: ${stale.length} sample(s) carry this deploy's identity from a process that started at or before the pre-deploy baseline ${clock(baseline.maxProcessStartedAt)} — that is not a roll` }
    }
  }
  const families = obs.families ? Object.entries(obs.families).filter(([, status]) => status !== 200) : []
  if (families.length) {
    return { code: EXIT.UNUSABLE, reason: `${name}: ours, but not warm — ${families.map(([k, v]) => `${k} ${v || 'no answer'}`).join(', ')}` }
  }
  const starts = [...new Set(stamps.map(x => x.processStartedAt))].sort()
  let note = ''
  if (!Number.isFinite(base)) {
    note = expected.runId
      ? ' — NO pre-deploy baseline for this node; the roll proof here is the run id + attempt alone, which are unique to this deploy'
      : ' — NO pre-deploy baseline and no --expect-run, so a re-deploy of this commit is indistinguishable from the one already there'
  }
  return { code: EXIT.OK, reason: `${name}: ${stamps.length}/${total} ours from ${starts.length} process(es) started ${starts.map(clock).join(', ')}${note}` }
}

/**
 * PURE: Harper's restart job, as read from every discovered node.
 *
 * The job record lives ONLY on the node that handled the deploy (measured: `get_job` returns
 * [] on the peer), so a lookup is a question to every node. Its `result.replicated` carries
 * each peer's own completed job. An id the CLI printed but no node knows is PENDING, never
 * skipped: the likeliest reason is that the handling node is one the gate is not watching.
 */
export function judgeJob(jobId, lookups, nodeNames) {
  if (!jobId) return { code: EXIT.OK, skipped: true, reason: 'no restart job id — not consulted' }
  const holders = (lookups || []).filter(l => Array.isArray(l.records) && l.records.some(r => r?.id === jobId))
  if (!holders.length) {
    const silent = (lookups || []).filter(l => l.error).map(l => l.node)
    return {
      code: EXIT.PENDING,
      reason: silent.length
        ? `restart job ${short(jobId)}: lookup incomplete — ${silent.join(', ')} did not answer get_job`
        : `restart job ${short(jobId)}: not found on any discovered node (${nodeNames.join(', ')}) — the node that handled the deploy may be one the gate is not watching`,
    }
  }
  const holder = holders[0].node
  const rec = holders[0].records.find(r => r.id === jobId)
  const status = String(rec.status ?? '').toUpperCase()
  if (status === 'ERROR' || rec.error) {
    return { code: EXIT.FATAL, reason: `restart job ${short(jobId)} on ${holder}: ${status || 'ERROR'} — ${JSON.stringify(rec.error ?? rec.message ?? 'no message')}` }
  }
  if (status !== 'COMPLETE') {
    return { code: EXIT.PENDING, reason: `restart job ${short(jobId)} on ${holder}: ${status || 'no status'} since ${rec.start_datetime ? clock(new Date(Number(rec.start_datetime)).toISOString()) : '?'}` }
  }
  const replicated = Array.isArray(rec.result?.replicated) ? rec.result.replicated : []
  for (const r of replicated) {
    const node = String(r?.node ?? '').toLowerCase()
    if (node && !nodeNames.includes(node)) {
      return { code: EXIT.FATAL, reason: `restart job ${short(jobId)} restarted ${r.node}, which discovery did not find — a node the gate is not watching can never count as converged` }
    }
    // Deliberately a deny-list on the wording: Harper's success message is prose, and a gate
    // that failed prod deploys the day that prose changed would be crying wolf.
    if (r?.error || /error|fail/i.test(String(r?.message ?? ''))) {
      return { code: EXIT.FATAL, reason: `restart job ${short(jobId)}: peer ${r?.node ?? '?'} reported ${JSON.stringify(r?.error ?? r?.message)}` }
    }
  }
  const covered = new Set([holder, ...replicated.map(r => String(r?.node ?? '').toLowerCase())])
  const outside = nodeNames.filter(n => !covered.has(n))
  const end = rec.end_datetime ? clock(new Date(Number(rec.end_datetime)).toISOString()) : '?'
  return {
    code: EXIT.OK,
    reason: `restart job ${short(jobId)} COMPLETE on ${holder} at ${end}, ${replicated.length} peer job(s) completed${outside.length ? `; ${outside.join(', ')} not part of this job, so /build alone decides there` : ''}`,
  }
}

/**
 * PURE: one poll of the whole fleet. Precedence is deliberate:
 *   FATAL (nothing will change by waiting) > MISMATCH > UNUSABLE > PENDING (job) > OK.
 * A node with no observation at all is judged unreachable, so a sampler that skipped a node
 * cannot make it pass by omission.
 */
/**
 * PURE: do two named nodes share a process? Returns a reason, or null when they are distinct.
 *
 * Silent when a node reports no identity at all — that node is not claiming to be this deploy
 * (judgeNode has already failed it if it were), and an old build cannot answer the question.
 */
export function sharedBackends(nodeNames, observations) {
  const seen = new Map()
  for (const name of nodeNames) {
    const obs = observations.find(o => o?.name === name)
    for (const id of new Set((obs?.stamps ?? []).map(processIdentity).filter(Boolean))) {
      const other = seen.get(id)
      if (other && other !== name) {
        const [host, pid] = id.split('|')
        return `${other} and ${name} are the SAME process (${host} pid ${pid}) — two hostnames, one backend, so neither is evidence about the other. Discovery checked identity on the Ops port; this is port 443.`
      }
      if (!other) seen.set(id, name)
    }
  }
  return null
}

export function judgePoll({ nodeNames, observations = [], expected, baseline = {}, deployedTo = [], jobId = null, lookups = [] }) {
  if (!Array.isArray(nodeNames) || !nodeNames.length) {
    return { code: EXIT.UNUSABLE, lines: ['no nodes to check — an empty fleet never counts as converged'] }
  }
  const missing = deployedTo.map(n => String(n).trim().toLowerCase()).filter(n => n && !nodeNames.includes(n))
  if (missing.length) {
    return { code: EXIT.FATAL, lines: [`the deploy replicated to ${missing.join(', ')}, which discovery did not find (${nodeNames.join(', ')}) — a node the gate is not watching can never count as converged`] }
  }
  const per = nodeNames.map(name => judgeNode(
    observations.find(o => o?.name === name) ?? { name, stamps: [], unanswered: SAMPLES, error: 'not sampled' },
    expected,
    baseline?.[name] ?? null,
  ))
  const job = judgeJob(jobId, lookups, nodeNames)
  const lines = [...per.map(p => p.reason), ...(job.skipped ? [] : [job.reason])]
  // Two node hostnames that reach ONE process are one node wearing two names, and every
  // per-node verdict above would be that single process answering twice.
  // Discovery proves identity on the Ops port (9925); these samples go to 443, so
  // nothing before this compares what actually served the app.
  const shared = sharedBackends(nodeNames, observations)
  if (shared) return { code: EXIT.FATAL, lines: [...lines, shared] }
  if (job.code === EXIT.FATAL) return { code: EXIT.FATAL, lines }
  if (per.some(p => p.code === EXIT.MISMATCH)) return { code: EXIT.MISMATCH, lines }
  if (per.some(p => p.code !== EXIT.OK)) return { code: EXIT.UNUSABLE, lines }
  if (job.code === EXIT.PENDING) return { code: EXIT.PENDING, lines }
  return { code: EXIT.OK, lines }
}

// ---------------------------------------------------------------------------
// discovery (PURE given an injected cluster_status reader)

/**
 * The domain node names must sit under before Ops credentials are sent to them: the CLI
 * target's host minus its first label, and never shorter than three labels. Prod's pool
 * `app.example-co.harperfabric.com` gives `example-co.harperfabric.com`, which both prod
 * nodes and both staging nodes sit under. cluster_status is authenticated and ours, but a
 * gate that forwards a password to whatever hostname a response names is one bug away from
 * exfiltrating it.
 */
export function clusterDomain(targetHost) {
  const host = String(targetHost ?? '').toLowerCase()
  if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return null
  const labels = host.split('.')
  if (labels.length < 4) return null
  return labels.slice(1).join('.')
}

export function nameAllowed(name, domain) {
  const n = String(name ?? '').toLowerCase()
  return !!domain && /^[a-z0-9.-]+$/.test(n) && n.endsWith(`.${domain}`)
}

function hostOf(url) {
  try { return new URL(url).hostname } catch { return null }
}

/**
 * Enumerate every node, from Harper's own view, until the set is closed.
 *
 * Asks the Ops target first, then asks EVERY named node itself, requires it to answer as the
 * name it was listed under, and adds whatever peers it names. So a node is found if any node
 * knows it, a node that cannot be reached fails discovery rather than being dropped, and a
 * hostname that reaches a different node than it claims fails rather than being trusted.
 */
export async function discoverFleet({ targetHost, domain, clusterStatusAt }) {
  const peersOf = s => (Array.isArray(s?.connections) ? s.connections : []).map(c => c?.name || hostOf(c?.url)).filter(Boolean)
  const first = await clusterStatusAt(null)
  const notes = []
  if (!first?.node_name) {
    if (peersOf(first).length) throw new Error(`cluster_status on ${targetHost} names peers (${peersOf(first).join(', ')}) but not the node answering, so that node cannot be addressed`)
    // The single-node path collapses the whole fleet to one hostname, so
    // it requires Harper to SAY replication is off rather than inferring it from an empty body.
    // A renamed field, a permission change, or a truncated response all produce that same empty
    // body — and each would silently restore the bug this gate exists to prevent. Real prod
    // answers `is_enabled: true`, so this costs a correctly-configured cluster nothing.
    if (first?.is_enabled !== false) {
      throw new Error(`cluster_status on ${targetHost} reports no node name and does not state is_enabled:false (got ${JSON.stringify(first?.is_enabled)}) — refusing to assume the Ops target is the whole fleet`)
    }
    notes.push(`::warning::cluster_status on ${targetHost} states is_enabled:false — replication is off, so the Ops target is being treated as the whole fleet. On a replicated environment this is a MISCONFIGURATION, not a shortcut.`)
    return { nodes: [String(targetHost).toLowerCase()], notes }
  }
  const known = new Set()
  const queue = []
  const add = (name, via) => {
    const n = String(name).toLowerCase()
    if (!nameAllowed(n, domain)) throw new Error(`${via} names node "${name}", which is not under this cluster's domain (*.${domain ?? '?'}) — refusing to send Ops credentials to it`)
    if (!known.has(n)) { known.add(n); queue.push(n) }
  }
  add(first.node_name, `the Ops target ${targetHost}`)
  for (const p of peersOf(first)) add(p, `the Ops target ${targetHost}`)
  while (queue.length) {
    const name = queue.shift()
    let s
    try {
      s = await clusterStatusAt(name)
    } catch (err) {
      throw new Error(`node ${name} is in the cluster but its Ops API did not answer (${err.message}) — a node the gate cannot reach can never count as converged`)
    }
    if (String(s?.node_name ?? '').toLowerCase() !== name) {
      throw new Error(`${name}'s Ops API answered as "${s?.node_name ?? 'nothing'}" — that hostname does not reach the node it names`)
    }
    for (const p of peersOf(s)) add(p, `node ${name}`)
  }
  return { nodes: [...known].sort(), notes }
}

export function parseEnvFile(text) {
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// network

/**
 * One request on its OWN socket. `agent: false` gives this request a one-off agent that
 * never pools, and `Connection: close` asks the server to end the socket with the response.
 *
 * This replaced Node's `fetch`, whose default dispatcher keeps connections alive: in a single
 * process (`--watch`, or any loop) a pooled socket stays attached to whichever thread
 * accepted it, and Harper lets an old thread keep serving the connections it already holds.
 * The verdict is about what a NEW connection gets, so that is the only kind this file opens.
 */
export function freshRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch (err) { reject(err); return }
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null
    if (!lib) { reject(new Error(`unsupported protocol ${u.protocol}`)); return }
    const payload = body == null ? null : Buffer.from(body)
    let timer
    const req = lib.request(u, {
      method,
      agent: false,
      headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}), Connection: 'close' },
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }) })
      res.on('error', err => { clearTimeout(timer); reject(err) })
    })
    timer = setTimeout(() => req.destroy(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
    req.on('error', err => { clearTimeout(timer); reject(err) })
    if (payload) req.write(payload)
    req.end()
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchBuild(origin, n) {
  // Cache-bust on top of the endpoint's own no-store: an intermediary we do not control is
  // not worth trusting with the one answer this file exists to get right.
  const res = await freshRequest(`${origin.replace(/\/$/, '')}/build?t=${Date.now()}-${n}`, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  })
  if (res.status !== 200) throw new Error(`GET /build -> HTTP ${res.status}`)
  const body = JSON.parse(res.body)
  if (!body || typeof body !== 'object') throw new Error('GET /build -> not a JSON object')
  return body
}

/**
 * Sample one origin SAMPLES times, CONCURRENTLY (a black-holing origin costs one timeout pair
 * per round, not SAMPLES of them), with one retry per sample: a dropped connection from one
 * restarting thread is not evidence of anything. The samples that still fail are
 * counted, and the verdicts above fail closed on them.
 */
async function sampleBuild(origin) {
  const settled = await Promise.allSettled(Array.from({ length: SAMPLES }, async (_, n) => {
    try {
      return await fetchBuild(origin, n)
    } catch {
      await sleep(500)
      return fetchBuild(origin, `${n}r`)
    }
  }))
  const stamps = settled.filter(r => r.status === 'fulfilled').map(r => r.value)
  const failed = settled.filter(r => r.status === 'rejected')
  return { stamps, unanswered: failed.length, error: failed[0]?.reason?.message ?? null }
}

async function fetchStamp(origin) {
  const { stamps, unanswered, error } = await sampleBuild(origin)
  if (!stamps.length) throw new Error(error ?? 'no sample answered')
  const shas = [...new Set(stamps.map(s => s?.sha ?? null))]
  return { ...stamps[0], workerShas: shas, workers: stamps.length, unanswered }
}

async function sampleNode(node, { families = true } = {}) {
  const [build, fam] = await Promise.all([
    sampleBuild(node.origin),
    families
      ? Promise.all(FAMILIES.map(async ([key, path]) => {
          try { return [key, (await freshRequest(`${node.origin.replace(/\/$/, '')}${path}`)).status] } catch { return [key, 0] }
        }))
      : Promise.resolve(null),
  ])
  return { name: node.name, ...build, families: fam ? Object.fromEntries(fam) : null }
}

function opsContext(file, maps) {
  let env
  try { env = parseEnvFile(readFileSync(file, 'utf8')) } catch (err) { throw usageError(`cannot read --ops-env ${file}: ${err.code ?? err.message}`) }
  for (const k of ['CLI_TARGET', 'CLI_TARGET_USERNAME', 'CLI_TARGET_PASSWORD']) {
    if (!env[k]) throw usageError(`--ops-env ${file} has no ${k}`)
  }
  let target
  try { target = new URL(env.CLI_TARGET) } catch { throw usageError(`CLI_TARGET in ${file} is not a URL`) }
  return {
    target,
    port: target.port || '9925',
    auth: `Basic ${Buffer.from(`${env.CLI_TARGET_USERNAME}:${env.CLI_TARGET_PASSWORD}`).toString('base64')}`,
    maps,
  }
}

// `--map name=url` points a hostname at another base URL, for both its app origin and its
// Ops API. It exists so deploy-gate-acceptance can run this file AS SHIPPED against fake
// nodes on loopback; nothing in the workflow passes it.
function urlsFor(name, ops) {
  const mapped = ops.maps[String(name).toLowerCase()]
  if (mapped) {
    const base = mapped.replace(/\/$/, '')
    return { origin: base, ops: `${base}/` }
  }
  return { origin: `https://${name}`, ops: `https://${name}:${ops.port}/` }
}

async function opsCall(url, auth, payload) {
  const res = await freshRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: auth },
    body: JSON.stringify(payload),
    timeoutMs: 15_000,
  })
  if (res.status !== 200) throw new Error(`${payload.operation} -> HTTP ${res.status}`)
  try { return JSON.parse(res.body) } catch { throw new Error(`${payload.operation} -> non-JSON response`) }
}

async function withRetry(fn, attempts = 2) {
  let last
  for (let i = 0; i < attempts; i++) {
    try { return await fn() } catch (err) { last = err; if (i < attempts - 1) await sleep(2000) }
  }
  throw last
}

async function lookupJob(node, ops, jobId) {
  try {
    // The nodes file is the one source of addresses: discovery wrote this node's Ops URL there.
    const records = await opsCall(node.ops ?? urlsFor(node.name, ops).ops, ops.auth, { operation: 'get_job', id: jobId })
    if (!Array.isArray(records)) return { node: node.name, error: 'get_job did not return a list' }
    return { node: node.name, records }
  } catch (err) {
    return { node: node.name, error: err.message }
  }
}

// ---------------------------------------------------------------------------
// CLI

function usageError(message) {
  const err = new Error(message)
  err.exitCode = EXIT.USAGE
  return err
}

function describe(stamp) {
  const age = stamp.deployedAt ? `${Math.round((Date.now() - Date.parse(stamp.deployedAt)) / 1000)}s ago` : 'unknown time'
  const run = stamp.runId ? `run ${stamp.runId}` : 'no run id'
  return `  env        ${stamp.environment ?? '?'}\n` +
         `  ref        ${stamp.ref ?? '?'}\n` +
         `  sha        ${stamp.sha ?? '<unstamped>'}\n` +
         `  deployed   ${stamp.deployedAt ?? '?'} (${age}, ${run})\n` +
         `  uptime     ${stamp.uptimeSeconds ?? '?'}s\n` +
         `  workers    ${stamp.workers ?? '?'} sampled, ${stamp.workerShas?.length ?? '?'} distinct build(s)`
}

function parseArgs(argv) {
  const out = {
    url: DEFAULT_ORIGIN, expect: null, watch: 0, selfTest: false, quiet: false,
    mode: 'origin', opsEnv: null, out: null, nodes: null, baseline: null,
    expectRun: null, expectAttempt: null, job: null, deployedTo: [], maps: {},
  }
  const value = (i, flag) => {
    const v = argv[i]
    if (v === undefined) throw new Error(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--self-test') out.selfTest = true
    else if (a === '--quiet') out.quiet = true
    else if (a === '--url') out.url = value(++i, a)
    else if (a === '--expect') out.expect = value(++i, a)
    else if (a === '--watch') out.watch = Number(value(++i, a))
    else if (a === '--discover') out.mode = 'discover'
    else if (a === '--capture-baseline') out.mode = 'baseline'
    else if (a === '--fleet') out.mode = 'fleet'
    else if (a === '--ops-env') out.opsEnv = value(++i, a)
    else if (a === '--out') out.out = value(++i, a)
    else if (a === '--nodes') out.nodes = value(++i, a)
    else if (a === '--baseline') out.baseline = value(++i, a)
    else if (a === '--expect-run') out.expectRun = value(++i, a)
    else if (a === '--expect-attempt') out.expectAttempt = value(++i, a)
    else if (a === '--job') out.job = value(++i, a)
    else if (a === '--deployed-to') out.deployedTo = value(++i, a).split(',').map(s => s.trim()).filter(Boolean)
    else if (a === '--map') {
      const m = value(++i, a).match(/^([^=]+)=(https?:\/\/.+)$/)
      if (!m) throw new Error('--map needs name=http(s)://host:port')
      out.maps[m[1].toLowerCase()] = m[2]
    } else throw new Error(`unknown argument: ${a}`)
  }
  return out
}

// `--expect HEAD` is the ergonomic form. execFileSync, not execSync: the latter goes through
// /bin/sh, so `--expect 'HEAD; …'` would run as a shell command rather than fail.
function resolveExpected(expect) {
  if (!expect) return null
  if (!/^HEAD/.test(expect)) return expect
  return execFileSync('git', ['rev-parse', expect], { encoding: 'utf8' }).trim()
}

function loadJson(file, flag) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (err) { throw usageError(`cannot read ${flag} ${file}: ${err.code ?? err.message}`) }
}

function loadNodes(file) {
  if (!file) throw usageError('--nodes <file> is required (write one with --discover)')
  const doc = loadJson(file, '--nodes')
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : []
  // An empty or malformed list is the gate being unable to run, not a fleet with nothing to
  // wait for. Zero nodes converge vacuously, which is the one outcome this must never allow.
  if (!nodes.length) throw usageError(`--nodes ${file} lists no nodes — an empty fleet never counts as converged`)
  for (const n of nodes) {
    if (!n?.name || !/^https?:\/\//.test(n?.origin ?? '')) throw usageError(`--nodes ${file} has a malformed entry: ${JSON.stringify(n)}`)
  }
  return nodes.map(n => ({ ...n, name: String(n.name).toLowerCase() }))
}

async function runDiscover(args) {
  if (!args.opsEnv || !args.out) throw usageError('--discover needs --ops-env <file> and --out <file>')
  const ops = opsContext(args.opsEnv, args.maps)
  const targetHost = ops.target.hostname.toLowerCase()
  const targetUrl = ops.maps[targetHost] ? `${ops.maps[targetHost].replace(/\/$/, '')}/` : ops.target.href
  const found = await discoverFleet({
    targetHost,
    domain: clusterDomain(targetHost),
    clusterStatusAt: name => withRetry(() => opsCall(name ? urlsFor(name, ops).ops : targetUrl, ops.auth, { operation: 'cluster_status' })),
  })
  const nodes = found.nodes.map(name => ({ name, ...urlsFor(name, ops) }))
  writeFileSync(args.out, `${JSON.stringify({ discoveredAt: new Date().toISOString(), via: targetHost, notes: found.notes, nodes }, null, 2)}\n`)
  console.log(`discovered ${nodes.length} node(s) from cluster_status via ${targetHost}:`)
  for (const n of nodes) console.log(`  - ${n.name}  (${n.origin})`)
  for (const note of found.notes) console.log(`  note: ${note}`)
  return EXIT.OK
}

async function runCaptureBaseline(args) {
  if (!args.out) throw usageError('--capture-baseline needs --out <file>')
  const nodes = loadNodes(args.nodes)
  const observations = await Promise.all(nodes.map(n => sampleNode(n, { families: false })))
  const doc = { capturedAt: new Date().toISOString(), nodes: {} }
  for (const o of observations) {
    const starts = o.stamps.map(s => s?.processStartedAt).filter(t => Number.isFinite(Date.parse(t))).sort()
    doc.nodes[o.name] = starts.length
      ? { maxProcessStartedAt: starts.at(-1), answered: o.stamps.length, identities: [...new Set(o.stamps.map(s => `${short(s.sha)} run ${s.runId ?? '?'}#${s.runAttempt ?? '?'}`))] }
      : { maxProcessStartedAt: null, answered: o.stamps.length, error: o.error ?? 'no processStartedAt in any sample' }
    const rec = doc.nodes[o.name]
    console.log(rec.maxProcessStartedAt
      ? `  ${o.name}: baseline ${rec.maxProcessStartedAt} from ${rec.answered}/${SAMPLES} samples (${rec.identities.join(', ')})`
      : `  ${o.name}: NO BASELINE — ${rec.error}. This node's roll proof will rest on run id + attempt alone.`)
  }
  writeFileSync(args.out, `${JSON.stringify(doc, null, 2)}\n`)
  return EXIT.OK
}

async function runFleet(args) {
  const nodes = loadNodes(args.nodes)
  const baseline = args.baseline ? (loadJson(args.baseline, '--baseline')?.nodes ?? {}) : {}
  let sha
  try { sha = resolveExpected(args.expect) } catch { throw usageError(`--expect "${args.expect}" is not a revision this repo knows`) }
  if (!sha || sha.length < 7) throw usageError('--fleet needs --expect <sha of at least 7 hex chars>')
  if (args.job && !JOB_ID.test(args.job)) throw usageError(`--job "${args.job}" is not a Harper job id`)
  const ops = args.job ? (args.opsEnv ? opsContext(args.opsEnv, args.maps) : null) : null
  if (args.job && !ops) throw usageError('--job needs --ops-env <file> to read get_job')
  const opsForMaps = { maps: args.maps, port: ops?.port ?? '9925', auth: ops?.auth }
  const mapped = nodes.map(n => (args.maps[n.name] ? { ...n, ...urlsFor(n.name, opsForMaps) } : n))
  const [observations, lookups] = await Promise.all([
    Promise.all(mapped.map(n => sampleNode(n))),
    args.job ? Promise.all(mapped.map(n => lookupJob(n, ops, args.job))) : Promise.resolve([]),
  ])
  const verdict = judgePoll({
    nodeNames: nodes.map(n => n.name),
    observations,
    expected: { sha, runId: args.expectRun, runAttempt: args.expectAttempt },
    baseline,
    deployedTo: args.deployedTo,
    jobId: args.job,
    lookups,
  })
  const label = { 0: 'OK', 3: 'MISMATCH', 4: 'UNUSABLE', 6: 'PENDING', 7: 'FATAL' }[verdict.code] ?? String(verdict.code)
  if (!args.quiet) console.log(`fleet of ${nodes.length} node(s), expecting ${short(sha)}${args.expectRun ? ` run ${args.expectRun}#${args.expectAttempt ?? '?'}` : ''}: ${label}`)
  for (const line of verdict.lines) console.log(`    ${line}`)
  // The wait step requires this line on an exit 0. A checker that exits 0 WITHOUT rendering a
  // verdict is a gate that did not run, and the loop around it cannot otherwise tell the
  // difference — see the entry-point guard at the bottom of this file for how that happened.
  console.log(`fleet verdict: ${label} (${nodes.length} node(s))`)
  return verdict.code
}

async function runOrigin(args) {
  if (!args.url) throw usageError('no origin to sample: set PUBLIC_APP_URL or pass --url <origin>')
  let expected
  try {
    expected = resolveExpected(args.expect)
  } catch {
    console.error(`❌ --expect "${args.expect}" is not a revision this repo knows.`)
    console.error('   Pass a sha, or HEAD (optionally HEAD~1 / HEAD^) from inside a checkout.')
    return EXIT.USAGE
  }
  const deadline = Date.now() + Math.max(0, args.watch) * 1000
  const watching = args.watch > 0
  let first = true
  // While holding a window, an unsettled or unreachable round is normal for the seconds
  // around a roll — it is only a verdict once it PERSISTS. A mismatch is never transient.
  const UNSETTLED_TOLERANCE = 3
  let unsettled = 0
  let lastVerdict = null

  do {
    let stamp = null
    let verdict
    try {
      stamp = await fetchStamp(args.url)
      verdict = compare(stamp, expected)
    } catch (err) {
      verdict = { code: EXIT.UNUSABLE, reason: `${args.url}/build unreachable: ${err.message} — the environment is down, or is running code from before the stamp existed` }
    }

    if (args.quiet) {
      const shas = stamp?.workerShas?.map(s => (s ? s.slice(0, 7) : 'unstamped')).join('/') ?? 'no answer'
      console.log(`  /build: ${stamp?.workers ?? 0}/${SAMPLES} answered, build(s) ${shas}${stamp?.unanswered ? `, ${stamp.unanswered} silent` : ''}`)
    } else if (stamp && (first || verdict.code !== EXIT.OK)) {
      console.log(`${args.url}/build`)
      console.log(describe(stamp))
      first = false
    }

    if (verdict.code === EXIT.MISMATCH) {
      console.error(`\n❌ NOT YOUR BUILD — ${verdict.reason}`)
      console.error('   Any probe you ran against this origin describes someone else\'s code. Redeploy and re-verify.')
      return EXIT.MISMATCH
    }
    if (verdict.code !== EXIT.OK) {
      unsettled++
      if (!watching || unsettled >= UNSETTLED_TOLERANCE) {
        console.error(`\n❌ ${verdict.reason}`)
        if (watching) console.error(`   Unchanged across ${unsettled} rounds — this is not a blip.`)
        return verdict.code
      }
      console.error(`\n⚠️  ${verdict.reason}`)
      console.error(`   Round ${unsettled}/${UNSETTLED_TOLERANCE} — still watching; this is normal for a few seconds around a roll.`)
    } else {
      unsettled = 0
    }

    lastVerdict = verdict
    if (Date.now() < deadline) await sleep(10_000)
  } while (Date.now() < deadline)

  // The tolerance defers a verdict; it does not forgive one.
  if (unsettled > 0) {
    console.error(`\n❌ ${lastVerdict.reason}`)
    console.error(`   The window ended while this was still unresolved (${unsettled} round(s) deep), so it never came back clean.`)
    return lastVerdict.code
  }
  if (!args.quiet) {
    console.log(args.watch
      ? `\n✅ held ${args.watch}s — the origin never changed out from under you`
      : `\n✅ ${expected ? 'this is your build' : 'stamp read'}`)
  }
  return EXIT.OK
}

/**
 * Negative controls, run by pr-check.yml on every PR with
 * node_modules unreachable. A guard is only worth having if it can still say NO, so
 * every YES below has a NO beside it that a degraded verdict would get wrong.
 */
async function selfTest() {
  const mine = 'abc1234def5678901234567890abcdef12345678'
  const theirs = '9999999def5678901234567890abcdef12345678'
  const stamp = { sha: mine, ref: 'agent/mine-20260818' }
  const cases = []
  const add = (name, got, want) => cases.push([name, got, want])

  add('matching full sha', compare(stamp, mine), EXIT.OK)
  add('matching short sha', compare(stamp, mine.slice(0, 7)), EXIT.OK)
  add('case-insensitive match', compare(stamp, mine.toUpperCase()), EXIT.OK)
  add('SIBLING BUILD (the bug)', compare(stamp, theirs), EXIT.MISMATCH)
  add('sibling, short sha', compare(stamp, theirs.slice(0, 7)), EXIT.MISMATCH)
  add('unstamped environment', compare({ sha: null }, mine), EXIT.UNUSABLE)
  add('no response at all', compare(null, mine), EXIT.UNUSABLE)
  add('SPLIT FLEET, mine present', compare({ ...stamp, workerShas: [mine, theirs] }, mine), EXIT.UNUSABLE)
  add('converged fleet', compare({ ...stamp, workerShas: [mine] }, mine), EXIT.OK)
  add('partial quorum agrees', compare({ ...stamp, workerShas: [mine], workers: 1, unanswered: 5 }, mine), EXIT.UNUSABLE)
  add('full quorum agrees', compare({ ...stamp, workerShas: [mine], workers: 6, unanswered: 0 }, mine), EXIT.OK)
  add('prefix too short to trust', compare(stamp, 'abc12'), EXIT.USAGE)
  add('report-only, no --expect', compare(stamp, null), EXIT.OK)

  // --- per node
  const expected = { sha: mine, runId: '500', runAttempt: '1' }
  const BASE = '2026-09-11T15:00:00.000Z'
  // host+pid are part of a real stamp now: a node claiming this
  // deploy must say WHICH PROCESS answered, or two hostnames could be one backend.
  const ours = (t = '2026-09-11T15:01:00.000Z', host = 'box-a', pid = 101) => ({ sha: mine, runId: '500', runAttempt: '1', processStartedAt: t, host, pid })
  const warm = { rest: 200, fastify: 200, static: 200 }
  const node = (name, stamps, extra = {}) => ({ name, stamps, unanswered: 0, families: warm, ...extra })
  const six = s => Array.from({ length: 6 }, () => s)
  const judge = (o, b = { maxProcessStartedAt: BASE }) => judgeNode(o, expected, b)

  add('node: rolled onto this deploy', judge(node('a', six(ours()))), EXIT.OK)
  add('node: TWO threads, both rolled', judge(node('a', [...six(ours('2026-09-11T15:01:00.000Z')).slice(0, 3), ...six(ours('2026-09-11T15:01:06.000Z')).slice(0, 3)])), EXIT.OK)
  add('node: one OLD thread still answers', judge(node('a', [...six(ours()).slice(0, 5), { sha: theirs, runId: '499', runAttempt: '1', processStartedAt: '2026-09-10T00:00:00.000Z' }])), EXIT.UNUSABLE)
  add('node: another build', judge(node('a', six({ ...ours(), sha: theirs, runId: '499' }))), EXIT.MISMATCH)
  add('node: our sha, EARLIER deploy (re-run)', judge(node('a', six({ ...ours('2026-09-10T00:00:00.000Z'), runId: '499' }))), EXIT.MISMATCH)
  add('node: our run, EARLIER attempt', judge(node('a', six({ ...ours('2026-09-10T00:00:00.000Z'), runAttempt: '0' }))), EXIT.MISMATCH)
  add('node: identity from a pre-baseline process', judge(node('a', six(ours('2026-09-11T14:59:00.000Z')))), EXIT.UNUSABLE)
  add('node: EMPTY baseline + ours', judge(node('a', six(ours())), null), EXIT.OK)
  add('node: EMPTY baseline + earlier deploy', judge(node('a', six({ ...ours(), runId: '499' })), null), EXIT.MISMATCH)
  add('node: EMPTY baseline + another build', judge(node('a', six({ ...ours(), sha: theirs })), { maxProcessStartedAt: null }), EXIT.MISMATCH)
  add('node: unreachable', judge(node('a', [], { unanswered: 6, error: 'ECONNREFUSED' })), EXIT.UNUSABLE)
  add('node: partial quorum', judge(node('a', six(ours()).slice(0, 4), { unanswered: 2 })), EXIT.UNUSABLE)
  add('node: unstamped', judge(node('a', six({ sha: null }))), EXIT.UNUSABLE)
  add('node: ours but static cold', judge(node('a', six(ours()), { families: { ...warm, static: 404 } })), EXIT.UNUSABLE)
  // The identity requirement bites only on stamps CLAIMING this deploy, which
  // is what lets it be hard from day one — a pre-deploy baseline reads the old build.
  add('node: ours but NO process identity', judge(node('a', six({ ...ours(), host: undefined, pid: undefined }))), EXIT.UNUSABLE)
  add('node: ours, host but no pid', judge(node('a', six({ ...ours(), pid: undefined }))), EXIT.UNUSABLE)
  add('node: ANOTHER build with no identity is still just a mismatch', judge(node('a', six({ ...ours(), sha: theirs, runId: '499', host: undefined, pid: undefined }))), EXIT.MISMATCH)
  add('node: pid 0 is a pid', judge(node('a', six({ ...ours(), pid: 0 }))), EXIT.OK)

  // --- whole fleet
  const names = ['east.pt.fleet.test', 'west.pt.fleet.test']
  const good = n => node(n, six(ours(undefined, n)))
  const base2 = Object.fromEntries(names.map(n => [n, { maxProcessStartedAt: BASE }]))
  const complete = holder => [
    { node: holder, records: [{ id: '69b89d43-0edf-41f2-b63c-3002d7cd4edc', status: 'COMPLETE', end_datetime: 1789148659395, result: { replicated: [{ node: names.find(n => n !== holder), message: 'Successfully completed job: fe58feb3' }] } }] },
    { node: names.find(n => n !== holder), records: [] },
  ]
  const JOB = '69b89d43-0edf-41f2-b63c-3002d7cd4edc'
  const poll = extra => judgePoll({ nodeNames: names, expected, baseline: base2, observations: names.map(good), ...extra })

  add('fleet: both nodes rolled, no job', poll({}), EXIT.OK)
  add('fleet: both nodes rolled, job COMPLETE', poll({ jobId: JOB, lookups: complete(names[1]) }), EXIT.OK)
  add('fleet: east rolled, WEST STILL OLD', poll({ observations: [good(names[0]), node(names[1], six({ ...ours('2026-09-10T00:00:00.000Z'), sha: theirs, runId: '499' }))] }), EXIT.MISMATCH)
  add('fleet: west UNREACHABLE', poll({ observations: [good(names[0]), node(names[1], [], { unanswered: 6 })] }), EXIT.UNUSABLE)
  add('fleet: west never sampled', poll({ observations: [good(names[0])] }), EXIT.UNUSABLE)
  add('fleet: EMPTY node list', judgePoll({ nodeNames: [], expected }), EXIT.UNUSABLE)
  add('fleet: deploy reached an undiscovered node', poll({ deployedTo: ['north.pt.fleet.test'] }), EXIT.FATAL)
  add('fleet: deploy reached a discovered node', poll({ deployedTo: [names[0].toUpperCase()] }), EXIT.OK)
  add('fleet: nodes agree, job IN_PROGRESS', poll({ jobId: JOB, lookups: [{ node: names[0], records: [{ id: JOB, status: 'IN_PROGRESS', start_datetime: 1 }] }, { node: names[1], records: [] }] }), EXIT.PENDING)
  add('fleet: nodes agree, job NOT FOUND', poll({ jobId: JOB, lookups: names.map(n => ({ node: n, records: [] })) }), EXIT.PENDING)
  add('fleet: nodes agree, job lookup failed', poll({ jobId: JOB, lookups: names.map(n => ({ node: n, error: 'ECONNRESET' })) }), EXIT.PENDING)
  add('fleet: job ERROR', poll({ jobId: JOB, lookups: [{ node: names[0], records: [{ id: JOB, status: 'ERROR', message: 'restart failed' }] }] }), EXIT.FATAL)
  add('fleet: job peer reported a failure', poll({ jobId: JOB, lookups: [{ node: names[0], records: [{ id: JOB, status: 'COMPLETE', result: { replicated: [{ node: names[1], message: 'Error: restart failed' }] } }] }] }), EXIT.FATAL)
  add('fleet: job restarted an undiscovered node', poll({ jobId: JOB, lookups: [{ node: names[0], records: [{ id: JOB, status: 'COMPLETE', result: { replicated: [{ node: 'north.pt.fleet.test', message: 'Successfully completed job: x' }] } }] }] }), EXIT.FATAL)
  add('fleet: job COMPLETE but west still old', poll({ jobId: JOB, lookups: complete(names[0]), observations: [good(names[0]), node(names[1], six({ ...ours(), sha: theirs }))] }), EXIT.MISMATCH)
  // Two hostnames, ONE process. Every per-node verdict above would be that
  // single process answering twice, so a half-rolled fleet would read as converged.
  // FATAL, because waiting cannot make a second node appear.
  add('fleet: both names reach the SAME process', poll({ observations: [good(names[0]), node(names[1], six(ours(undefined, names[0])))] }), EXIT.FATAL)
  add('fleet: same host, DIFFERENT pids is two processes', poll({ observations: [good(names[0]), node(names[1], six({ ...ours(undefined, names[0]), pid: 999 }))] }), EXIT.OK)
  add('fleet: a node with no identity does not accuse its peer', judgePoll({ nodeNames: names, expected, baseline: base2, observations: [good(names[0]), node(names[1], six({ ...ours(), host: undefined, pid: undefined }))] }), EXIT.UNUSABLE)

  // --- discovery
  const domainOk = clusterDomain('app.example-co.harperfabric.com') === 'example-co.harperfabric.com'
  add('domain: prod pool', { code: domainOk ? 0 : 1, reason: clusterDomain('app.example-co.harperfabric.com') }, 0)
  add('domain: IP target has none', { code: clusterDomain('34.162.7.174') === null ? 0 : 1, reason: String(clusterDomain('34.162.7.174')) }, 0)
  add('domain: short host has none', { code: clusterDomain('harperfabric.com') === null ? 0 : 1, reason: String(clusterDomain('harperfabric.com')) }, 0)

  const statusOf = { east: { node_name: 'east.pt.fleet.test', connections: [{ name: 'west.pt.fleet.test' }] }, west: { node_name: 'west.pt.fleet.test', connections: [{ url: 'wss://east.pt.fleet.test:9933' }] } }
  const discover = async (table, pool) => {
    try {
      const r = await discoverFleet({ targetHost: 'ops.pt.fleet.test', domain: 'pt.fleet.test', clusterStatusAt: async name => { if (!name) return pool; const k = name.split('.')[0]; if (!(k in table)) throw new Error('ECONNREFUSED'); return table[k] } })
      return { code: 0, reason: r.nodes.join(',') }
    } catch (err) { return { code: EXIT.UNUSABLE, reason: err.message } }
  }
  const twoNodes = await discover(statusOf, statusOf.east)
  add('discover: two nodes from a pool that answers as east', { ...twoNodes, code: twoNodes.reason === 'east.pt.fleet.test,west.pt.fleet.test' ? 0 : 1 }, 0)
  const peerOnly = await discover({ ...statusOf, east: { node_name: 'east.pt.fleet.test', connections: [{ name: 'west.pt.fleet.test' }] }, west: { node_name: 'west.pt.fleet.test', connections: [{ name: 'north.pt.fleet.test' }] }, north: { node_name: 'north.pt.fleet.test', connections: [] } }, { node_name: 'east.pt.fleet.test', connections: [] })
  add('discover: a node only a PEER knows is still found', { ...peerOnly, code: peerOnly.reason === 'east.pt.fleet.test,north.pt.fleet.test,west.pt.fleet.test' ? 0 : 1 }, 0)
  add('discover: listed peer UNREACHABLE', await discover({ east: statusOf.east }, statusOf.east), EXIT.UNUSABLE)
  add('discover: hostname answers as another node', await discover({ east: statusOf.east, west: { node_name: 'east.pt.fleet.test', connections: [] } }, statusOf.east), EXIT.UNUSABLE)
  add('discover: peer OUTSIDE the cluster domain', await discover({ east: { node_name: 'east.pt.fleet.test', connections: [{ name: 'evil.example.test' }] } }, { node_name: 'east.pt.fleet.test', connections: [{ name: 'evil.example.test' }] }), EXIT.UNUSABLE)
  const single = await discover({}, { is_enabled: false, connections: [] })
  add('discover: no replication -> the target alone', { ...single, code: single.reason === 'ops.pt.fleet.test' ? 0 : 1 }, 0)
  add('discover: peers but no own name', await discover({}, { connections: [{ name: 'west.pt.fleet.test' }] }), EXIT.UNUSABLE)
  // The single-node path collapses the fleet to one hostname, so it may only be
  // taken when Harper SAYS replication is off. Inferring it from an empty body would collapse the fleet again,
  // and a field rename or a permission change produces exactly that empty body. Real prod
  // answers is_enabled:true.
  add('discover: NEG empty body is not proof replication is off', await discover({}, { connections: [] }), EXIT.UNUSABLE)
  add('discover: NEG is_enabled TRUE with no node name', await discover({}, { is_enabled: true, connections: [] }), EXIT.UNUSABLE)
  add('discover: NEG is_enabled missing entirely', await discover({}, {}), EXIT.UNUSABLE)
  const singleWarns = await discoverFleet({ targetHost: 'ops.pt.fleet.test', domain: 'pt.fleet.test', clusterStatusAt: async () => ({ is_enabled: false, connections: [] }) })
  add('discover: the single-node path WARNS rather than passing quietly', { code: singleWarns.notes.some(n => n.startsWith('::warning::')) ? 0 : 1, reason: singleWarns.notes.join(' | ') }, 0)

  const env = parseEnvFile('CLI_TARGET=https://a.b.c.d:9925/\nexport CLI_TARGET_USERNAME="u"\nCLI_TARGET_PASSWORD=p=w#1 \n# comment')
  add('env file parse', { code: env.CLI_TARGET === 'https://a.b.c.d:9925/' && env.CLI_TARGET_USERNAME === 'u' && env.CLI_TARGET_PASSWORD === 'p=w#1' ? 0 : 1, reason: 'CLI_TARGET/_USERNAME/_PASSWORD' }, 0)

  let failed = 0
  for (const [name, got, want] of cases) {
    const ok = got.code === want
    if (!ok) failed++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(44)} exit ${got.code} (want ${want})${ok ? '' : ` — ${got.reason ?? (got.lines || []).join(' | ')}`}`)
  }
  if (failed) {
    console.error(`\n❌ ${failed} self-test case(s) failed — the build-stamp guard is not doing its job.`)
    return 1
  }
  console.log('\n✅ build-stamp guard: matches its own build, REFUSES a sibling\'s, and refuses a fleet with any node unrolled, unreachable, or undiscovered')
  return 0
}

async function main() {
  let args
  try { args = parseArgs(process.argv.slice(2)) } catch (err) {
    console.error(`${err.message}\nSee the header of scripts/build-stamp.js for usage.`)
    process.exit(EXIT.USAGE)
  }
  if (args.selfTest) process.exit(await selfTest())
  try {
    const run = { discover: runDiscover, baseline: runCaptureBaseline, fleet: runFleet, origin: runOrigin }[args.mode]
    process.exit(await run(args))
  } catch (err) {
    console.error(`❌ ${err.message}`)
    process.exit(err.exitCode ?? EXIT.UNUSABLE)
  }
}

// The verdict functions are exported; importing this file must not fire a network call.
//
// REAL paths on both sides. `import.meta.url` is the resolved file, `process.argv[1]` is the
// path as typed — so through a symlinked checkout the old URL comparison was false, main()
// never ran, and the gate EXITED 0 HAVING CHECKED NOTHING. deploy-gate-acceptance found it by
// symlinking scripts/ into its sandbox: every scripted roll "landed" on poll 3, including one
// that must fail on poll 1. CI's checkout is not a symlink, but the day one is, that is the
// 2026-08-11 silent no-op rebuilt inside the check that exists to catch it.
function invokedDirectly() {
  if (!process.argv[1]) return false
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}
if (invokedDirectly()) main()
