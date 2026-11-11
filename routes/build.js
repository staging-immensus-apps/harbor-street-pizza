/**
 * FIXED — the build stamp: which commit is this copy actually serving?
 *
 * Served at `GET /build` by the published copy and at `GET /preview/build` by the preview copy
 * (lib/pages.js). The values come from the BUILD_* keys the deployer writes into THIS COPY'S OWN
 * `CONFIG.env` — the only moment the git sha is knowable, since a deploy ships a directory, not a
 * repo. scripts/build-stamp.js samples it per node on fresh connections and refuses a split or
 * stale fleet; the platform's deploy driver does the same before it calls a deploy done.
 *
 * READ FROM THE COPY'S OWN FILE AND NEVER FROM `process.env` (lib/config.js says why). On a two-node
 * Fabric cluster a copy reading `process.env.BUILD_SHA` reported ANOTHER component's build,
 * which is exactly the wrong answer for the one route a deploy is proven by.
 *
 * Imports only `node:os` and lib/config.js, which imports only `node:fs`, so this module loads under
 * plain node too: the platform's own check imports it standing alone (rule 5).
 *
 * Nothing here is a secret — a sha, a ref, a run id, a hostname, a pid. It is public on purpose: the
 * sessions that need it are curling an unauthenticated origin.
 */

import os from 'node:os'
import { config } from '../lib/config.js'

const startedAt = Date.now()

// Absent (not stale) on any process that started without a deploy writing a stamp — a local
// `harper dev .`. Report null and let the caller decide; guessing is worse.
function stampValue (key) {
  const v = config.buildStamp(key)
  return v && String(v).trim() ? String(v).trim() : null
}

export function buildStamp () {
  const sha = stampValue('BUILD_SHA')
  return {
    environment: stampValue('BUILD_ENV'),
    sha,
    shortSha: sha ? sha.slice(0, 7) : null,
    ref: stampValue('BUILD_REF'),
    runId: stampValue('BUILD_RUN_ID'),
    runAttempt: stampValue('BUILD_RUN_ATTEMPT'),
    deployedAt: stampValue('BUILD_TIME'),
    // Distinguishes "redeployed" from "restarted on the same commit"; lib/pages.js also
    // cache-busts unhashed public files off this value.
    processStartedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    // WHICH PROCESS answered, so a caller can prove two hostnames are two backends. Must
    // come from the running process, not a BUILD_* key: a deploy-time value is identical on
    // every node and could not tell them apart.
    host: os.hostname(),
    pid: process.pid,
  }
}
