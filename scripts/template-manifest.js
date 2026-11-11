#!/usr/bin/env node
// SEEDED — the template's own manifest tool, and the record of where an app came from.
//
// WHAT THIS FILE IS NOT ANY MORE, because it used to be a gate and the gate is withdrawn.
// The template is a jumping-off
// point and not a continuing constraint: once an app begins to build it is its own
// independent thing and should be fully modifiable. Its reason is commercial — enterprise
// customers expect to own their code. So `.immensus/template.json` records what the template
// SEEDED and nothing enforces that the bytes still match. `scripts/template-drift-acceptance.js`
// was that enforcement and it is gone: it was registered under a name `scripts/run-suites.js`
// discovers, so it ran under the builder's Tier A `suites` check in EVERY generated app, and a
// stage's now-permitted edit to a seeded file would have red the build with no way to clear it
// (`.immensus/template.json` is outside the builder's writable set and no stage has `Bash`, so
// nothing in an app can re-pin). One incident makes this concrete: a
// wrong suite in a FIXED file parked a founder on an otherwise green app, and "keep trying"
// could never work because every later pass hit the same pinned file.
//
// WHAT STILL HAS A JOB, and the split is the whole design of this file:
//
//   IN THE TEMPLATE REPO the manifest must match the tree in the PR that changes it, or it
//   rots and every app seeded afterwards carries a lie about its own origin. `--check` is that
//   gate and `.github/workflows/pr-check.yml` runs it under `if: github.repository == …`, so it
//   is scoped by REPOSITORY rather than by a flag in the tree an app could flip. **AND THAT SCOPING
//   WAS HELD HONEST BY NOTHING FOR A WEEK** — the `if:` named this repository by its former name
//   after the rename, so the step was `skipped` on every pull request while every gate stayed
//   green. `--provenance` is what now holds the record against `github.repository` (the
//   section above `ownerOf()` is the whole account).
//
//   IN A GENERATED APP nothing here runs as a check. The file is not named by the suite
//   convention (`-acceptance` / `-probe` / `check-`), so `run-suites.js` cannot discover it and
//   Tier A never executes it. `--diff` is a READER — "what has this app changed since it was
//   seeded?" — and it exits 0 whatever it finds, on purpose: a difference is
//   the app exercising a permission, not a defect. Wiring `--diff` into anything that reads an
//   exit status would reinstate the pin under another name.
//
// The writer and the checker are the same code path (`--check` serialises exactly what `--write`
// would write and compares), so there is no second list of seeded paths to drift against — the
// failure mode `run-suites.js`'s own header is about.
//
//   node scripts/template-manifest.js              rewrite .immensus/template.json
//   node scripts/template-manifest.js --check      exit 1 if the manifest is stale (TEMPLATE REPO)
//   node scripts/template-manifest.js --diff       report what differs from the seed; always exit 0
//   node scripts/template-manifest.js --self-test  prove --check and --diff can still say no
//   node scripts/template-manifest.js --provenance does the recorded template name THIS repository?

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, dirname, basename, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, realpathSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const MANIFEST_PATH = '.immensus/template.json'

export function blobSha (bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
}

const list = (root, dir, re) => existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter((f) => re.test(f)).sort().map((f) => `${dir}/${f}`) : []

// WHAT IS NOT SEEDED. The authority is the platform's own path rule, which is what actually
// withholds these paths from an app's root commit — read on 2026-10-08, which is a claim
// about another repository and so carries its date.
//
// A RULE and not a list of ten: an exact list would let a probe stub added tomorrow back into the
// seed, silently. It cannot widen past `scripts/probe/`, and a GENERATED probe lives at
// `scripts/<name>-probe.js`, outside it.
//
// **ITS ONLY CONSUMER IS `--self-test` BELOW, AND THESE PATHS ARE WRITTEN TWICE IN THIS REPOSITORY
// ON PURPOSE.** `scripts/deps-acceptance.js` keeps its own `HARNESS_DIR` and `HARNESS_RUNNER`
// — older than these and used by `harnessImports` — and deliberately does NOT import from here,
// because that file is SEEDED and this one is a file an app may rewrite or delete: a
// seeded suite importing it would fail at LOAD in such an app and take its other checks with it.
// So the duplication is the cheaper of two costs, and it is the one that cannot red somebody else's
// app. An earlier draft of this comment claimed `deps-acceptance` imported these and that there was
// "no second copy to drift against"; both stopped being true in the round that removed the import,
// and a comment claiming more than the code does is the shape this file is full of.
// NOT exported, which is the comment above made true in code rather than merely asserted: an export
// is an invitation to the import that paragraph forbids, and `--self-test` is in this file.
const RUNNER_PATH = 'scripts/run-suites.js'
const PROBE_DIR = 'scripts/probe/'
const harnessAmong = (paths) => (paths ?? []).filter((p) => p === RUNNER_PATH || String(p).startsWith(PROBE_DIR))

/**
 * What the template SEEDS: the files it ships verbatim, as opposed to the ones the builder
 * generates per app. This list is a description, not a permission — an
 * app may change any of it. It is still worth having written down in one place: it is what
 * goes in the manifest, and it is the set a suite copies when it needs a faithful template
 * tree to work on (`scripts/look-acceptance.js`).
 */
export function SEEDED_PATHS (root) {
  return [
    'config.yaml',
    'index.html', 'vite.config.ts', 'tsconfig.json', 'tailwind.config.js', 'postcss.config.js',
    'lib/config.js', 'lib/db.js', 'lib/copy.js', 'lib/pages.js', 'lib/http.js',
    'resources/Pages.js', 'resources/Scheduler.js',
    'routes/build.js', 'routes/apex.js',
    'scripts/deploy.js', 'scripts/build-stamp.js', 'scripts/template-manifest.js',
    'scripts/harness-acceptance.js', 'scripts/page-boot-acceptance.js', 'scripts/page-boot-kind-acceptance.js', 'scripts/db-module-acceptance.js',
    'scripts/db-acceptance.js', 'scripts/http-acceptance.js', 'scripts/preview-acceptance.js', 'scripts/deps-acceptance.js', 'scripts/spa-routes-acceptance.js', 'scripts/schema-lint-acceptance.js',
    'scripts/builtins-acceptance.js', 'scripts/immensus-auth-acceptance.js', 'scripts/deploy-gate-acceptance.js',
    'scripts/scheduler-probe.js', 'scripts/suite-verdicts-acceptance.js',
    // NOT here, deliberately: anything under `kits/`. A kit is copied into an app by the platform when
    // its plan needs it, never seeded — the platform withholds
    // `kits/` from every root commit — so it is not provenance of the seed.
    // `--self-test` holds that line.
    'src/discovery.ts',
    'scripts/apply-look.js', 'scripts/look-acceptance.js',
    // The look library is the PLATFORM's design work rather than any one app's: a stage picks
    // one and `scripts/apply-look.js` writes it into `src/index.css` — which is deliberately
    // NOT in this list, because restyling an app IS the seam. The five are a starting choice and
    // not a limit: an app with fonts and colours of its own sets them in `src/index.css`
    // under `CUSTOM_LOOK_LINE`. What it should not do is edit a file here, because `looks/<id>.css`
    // is what that id MEANS — an edited `harbor.css` would be a look still called Harbor that no
    // longer is, in one app, invisibly. That is a reason to say so in the charters
    // (`.claude/agents/front-end.md`), not a reason to red a build: nothing here refuses it.
    ...list(root, 'looks', /\.(css|json)$/),
    ...list(root, '.github/workflows', /\.yml$/),
    ...list(root, '.claude/agents', /\.md$/),
    ...list(root, '.claude/commands', /\.md$/),
  ]
}

export function buildManifest (root, paths = SEEDED_PATHS(root)) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const files = {}
  for (const rel of paths) {
    const p = join(root, rel)
    if (!existsSync(p)) throw new Error(`seeded path is missing: ${rel}`)
    files[rel] = blobSha(readFileSync(p))
  }
  // THE ONE RECORD OF WHICH REPOSITORY THE TEMPLATE IS, and a literal on purpose.
  //
  // It is not derived from the environment, which is the first thing that suggests itself:
  // `--check` compares `serialise(buildManifest(ROOT))` against the file on disk, so a value
  // that came from `GITHUB_REPOSITORY` would make `--check` compare different things in CI and
  // on a laptop — a gate whose verdict depends on where it runs. So the record stays a record,
  // and `--provenance` below is what holds it against the repository the job is running in.
  return { template: 'ImmensusApp/web-app-template', version: pkg.version, files }
}

export function serialise (manifest) {
  return JSON.stringify(manifest, null, 2) + '\n'
}

/**
 * Which seeded files differ from what the manifest recorded, as human sentences. A REPORT: the
 * caller decides what, if anything, it means. In the template repo a non-empty answer means the
 * manifest wants rewriting; in a generated app it means the app has changed its own code, which
 * is permitted by design.
 */
export function differences (root, paths = SEEDED_PATHS(root)) {
  const out = []
  const mp = join(root, MANIFEST_PATH)
  if (!existsSync(mp)) return [`${MANIFEST_PATH} is missing, so there is no record of what this app was seeded from`]
  let manifest
  try { manifest = JSON.parse(readFileSync(mp, 'utf8')) } catch { return [`${MANIFEST_PATH} does not parse`] }
  const files = manifest.files ?? {}
  for (const rel of paths) {
    if (!(rel in files)) out.push(`${rel} is seeded by the template but not recorded in ${MANIFEST_PATH}`)
  }
  for (const [rel, sha] of Object.entries(files)) {
    const p = join(root, rel)
    if (!existsSync(p)) { out.push(`${rel} was seeded and is now absent`); continue }
    const actual = blobSha(readFileSync(p))
    if (actual !== sha) out.push(`${rel} differs from the seed (${actual.slice(0, 7)} ≠ ${String(sha).slice(0, 7)})`)
  }
  return out
}

// --- THE RECORD OF THIS TREE'S OWN IDENTITY, AND THE ONE THING THAT CHECKS IT ----------
//
// THE PROBLEM, which shipped and ran green for a week. Two things in this tree name the template:
// `buildManifest`'s `template` field above, and `.github/workflows/pr-check.yml`'s
// `if: github.repository == '…'` on the step that runs `--check`. `scripts/harness-acceptance.js`'s
// `manifestGuardProblems` compares them — TO EACH OTHER. This repository was renamed
// `app-template` → `web-app-template`; both records kept the old name, so they still agreed, the
// gate stayed green, and the `if:` became permanently false. `--check` — the one gate keeping every
// future app's record of its own origin honest — was `skipped` on every pull request.
//
// The gate's own refusal message had predicted it, in these words: "if this repository is ever
// renamed, the `if:` and the manifest's `template` field are both wrong and only one of them reds".
// The author wrote the sentence and the check still could not see it, because neither record was
// compared to anything outside the pair. A shape not seen before: two
// artefacts consistent with each other and both wrong about the world.
//
// THE FIX IS ONE COMPARISON, NOT A THIRD RECORD. `manifestGuardProblems` already holds the `if:`
// to this field, so holding this field to `github.repository` closes the chain:
//
//     pr-check.yml's `if:` literal   ==  the manifest's `template`   (manifestGuardProblems, already)
//     the manifest's `template`      ==  github.repository           (--provenance, here)
//     ∴  the `if:`                   ==  the repository it runs in
//
// Editing any one of the three alone now reds: change the `if:` only and the first comparison
// fails; change the field only and it fails the other way; rename the repository and the second
// fails. There is no longer a state in which both records agree and both are wrong, because one
// end of the pair is held against a fact nothing in this tree can write. Note what did NOT change:
// the `if:` is still a literal compared to `github.repository` and still depends on nothing in the
// tree, which is the property its own comment in `pr-check.yml` is about — an app cannot turn the
// manifest check on by editing a file.
//
// WHY THE OWNER IS THE DISCRIMINATOR, measured rather than assumed. This file is SEEDED, so
// `--provenance` runs in every generated app's CI too and must be inert there: an app's manifest
// records the TEMPLATE, which is not the repository the app lives in, and that is correct rather
// than stale. Templates and apps live in different organisations, and the platform is already
// built on that split — read in the platform's control-plane code on 2026-10-14, so it is a claim about another
// repository and carries its date:
//
//   * the apps organisation defaults to `immensus-apps`
//   * the platform organisation DERIVES from the template repository's owner
//   * all four templates are `ImmensusApp/*` (`web-app-template`,
//     `service-template`, `agent-template`, `pipeline-template`), so this rule serves the other
//     three unchanged on the day they exist, with no second list to keep in step
//   * seeding REFUSES a template whose owner is not the platform organisation
//
// So: the same owner means this tree is a template repository in the platform organisation and its
// manifest must name it. A different owner means a generated app, and nothing is judged.
//
// WHAT THIS DOES NOT BUY, because the next reader will otherwise think the field is pinned:
//
//   * A MISSING OR UNPARSEABLE manifest is inert, not loud. In this repository that would be a
//     defect; in an app it is the app having deleted its own provenance record, which is
//     permitted, and from in here those two states are identical. The template repository is covered
//     from the other side instead: `--check` reds on a manifest that does not match the tree, and
//     `npm run template-manifest` cannot write one that does not parse.
//   * An app that hand-edits its manifest to name a DIFFERENT repository under its own owner reds
//     its own CI. That takes a human editing their own provenance record to name somebody else's
//     app — the builder cannot (`.immensus/template.json` is outside the writable set and no stage
//     has `Bash`) — and the red is in their own Actions run with both names printed.
//   * Deleting the step from `pr-check.yml` is not caught and cannot be, for the reason
//     `manifestGuardProblems` already records: requiring a step to exist would forbid an app from
//     removing a template-only check. Deleting a named step is a visible line in this repository's
//     own diff; a condition quietly going false is not, and that is the one this catches.

/** `owner` out of an `owner/name` pair, case-folded, or null when it is not one. */
export function ownerOf (repo) {
  const m = /^([^\s/]+)\/([^\s/]+)$/.exec(String(repo ?? '').trim())
  return m ? m[1].toLowerCase() : null
}

/** What `.immensus/template.json` records as this tree's origin, or null if it records nothing readable. */
export function recordedTemplate (root) {
  const mp = join(root, MANIFEST_PATH)
  if (!existsSync(mp)) return null
  try {
    const t = JSON.parse(readFileSync(mp, 'utf8')).template
    return typeof t === 'string' && t.trim() !== '' ? t.trim() : null
  } catch { return null }
}

/**
 * Does the recorded template name the repository this job is running in? A PURE verdict, so the
 * controls below can drive all five outcomes with no filesystem and no GitHub.
 *
 * Case-folded and trimmed on both sides. GitHub treats an owner and a name case-insensitively, and
 * a casing difference read as `foreign` would make the check INERT rather than loud — which is the
 * one direction that fails quietly, and quiet failure is the whole subject of this section.
 */
export function provenanceVerdict (recorded, actual) {
  const rec = String(recorded ?? '').trim()
  const act = String(actual ?? '').trim()
  const rOwner = ownerOf(rec)
  const aOwner = ownerOf(act)
  if (aOwner === null) return { kind: 'no-repository', actual: act }
  if (rOwner === null) return { kind: 'unrecorded', actual: act }
  if (rOwner !== aOwner) return { kind: 'foreign', recorded: rec, actual: act }
  if (rec.toLowerCase() !== act.toLowerCase()) return { kind: 'renamed', recorded: rec, actual: act }
  return { kind: 'match', recorded: rec, actual: act }
}

// THE CONTROLS RUN IN THE SAME INVOCATION AS THE ANSWER, and that is deliberate rather than tidy.
// `--check`'s self-test is a separate argv that `pr-check.yml` happens to run in the same step, so
// that discipline lives in the WORKFLOW: a step that dropped one line would answer without it.
// This verdict is the only thing standing between a renamed repository and a silently skipped gate,
// so its controls are not separable from it — there is no `--provenance` that does not first prove
// the verdict can still say no. Both outcomes that must NOT red are driven as hard as the two that
// must: "a negative control nobody has provoked is a sentence", and `foreign` is the common case by
// a very long way, because every generated app takes it.
function provenanceControls () {
  const failures = []
  const check = (label, ok, detail) => {
    console.log(`  ${ok ? '✅' : '❌'} ${label}`)
    if (!ok) { failures.push(label); if (detail) console.log('     ' + detail) }
  }
  const kind = (recorded, actual) => provenanceVerdict(recorded, actual).kind

  // THE REGRESSION CONTROL: the exact state this repository was in from the rename.
  check('the rename this check exists for reds (records app-template, running in web-app-template)',
    kind('ImmensusApp/app-template', 'ImmensusApp/web-app-template') === 'renamed')
  check('a manifest naming the repository it sits in is a match',
    kind('ImmensusApp/web-app-template', 'ImmensusApp/web-app-template') === 'match')
  // Must NOT red: this is every generated app.
  check('a generated app, whose manifest names the template and not itself, is not judged',
    kind('ImmensusApp/web-app-template', 'immensus-apps/some-slug') === 'foreign')
  // Must NOT red, and this is the FORWARD-COMPATIBILITY promise of this check rather than a restatement of
  // the line above. Every app seeded earlier records the template under its FORMER name, and
  // there is no re-seed path anywhere — seeding short-circuits on the pin in the app's
  // own root commit — so every app that exists today will carry `ImmensusApp/app-template` for
  // ever. The owner is what spares them, and that must keep being true: this check is UNGATED, so
  // getting it wrong reds the CI of every app this platform has ever built.
  check("an app seeded before the rename, recording the template's FORMER name, is still not judged",
    kind('ImmensusApp/app-template', 'immensus-apps/some-slug') === 'foreign')
  // Must NOT red: an app may delete or rewrite its own provenance record.
  check('an absent or unreadable provenance record is inert rather than loud',
    kind(null, 'immensus-apps/some-slug') === 'unrecorded' &&
    kind('', 'ImmensusApp/web-app-template') === 'unrecorded' &&
    kind('not-an-owner-slash-name', 'ImmensusApp/web-app-template') === 'unrecorded')
  // MUST red: the authoritative half going missing is the always-OK shape, and it is the one input
  // a workflow can take away, by setting `env: GITHUB_REPOSITORY:` to nothing.
  check('being told nothing about which repository this is refuses rather than passes',
    kind('ImmensusApp/web-app-template', undefined) === 'no-repository' &&
    kind('ImmensusApp/web-app-template', '') === 'no-repository' &&
    kind('ImmensusApp/web-app-template', 'web-app-template') === 'no-repository')
  // A PREFIX IS NOT A NAME. Written because `includes`/`startsWith` is what somebody reaches for,
  // and it would call a different repository a match — in both directions.
  check('a repository whose name merely EXTENDS the recorded one is a rename, not a match',
    kind('ImmensusApp/web-app-template', 'ImmensusApp/web-app-template-2') === 'renamed' &&
    kind('ImmensusApp/web-app-template-2', 'ImmensusApp/web-app-template') === 'renamed')
  // Casing and stray whitespace are neither a rename nor a different owner. Getting this wrong
  // loses the check rather than crying wolf, which is why it is driven.
  check('casing and surrounding whitespace are neither a rename nor a different owner',
    kind('  ImmensusApp/web-app-template  ', 'immensusapp/WEB-APP-TEMPLATE') === 'match')
  // And the owner really is the thing that separates inert from loud, in both directions.
  check('the OWNER decides: another name under the same owner reds, the same name under another owner does not',
    kind('ImmensusApp/pipeline-template', 'ImmensusApp/web-app-template') === 'renamed' &&
    kind('ImmensusApp/web-app-template', 'somebody-else/web-app-template') === 'foreign')
  return failures
}

function provenance (root) {
  console.log('provenance verdict controls:')
  const failures = provenanceControls()
  console.log('')
  if (failures.length) {
    console.error(`❌ ${failures.length} provenance control(s) failed — the verdict cannot be trusted, so it is not given.`)
    return 1
  }
  const recorded = recordedTemplate(root)
  const v = provenanceVerdict(recorded, process.env.GITHUB_REPOSITORY)
  if (v.kind === 'match') {
    console.log(`✅ ${MANIFEST_PATH} records ${v.recorded}, which is the repository this job is running in.`)
    return 0
  }
  if (v.kind === 'foreign') {
    console.log(`✅ nothing to check: ${MANIFEST_PATH} records ${v.recorded} and this is ${v.actual} — a`)
    console.log('   different owner, so this tree is a generated app recording the template it came from.')
    return 0
  }
  if (v.kind === 'unrecorded') {
    console.log(`✅ nothing to check: ${MANIFEST_PATH} records no readable template, so there is no claim to test.`)
    console.log('   In a generated app that is the app having removed its own provenance record, which is allowed.')
    return 0
  }
  if (v.kind === 'no-repository') {
    console.error('❌ --provenance was not told which repository this is.')
    console.error(`   GITHUB_REPOSITORY is ${JSON.stringify(process.env.GITHUB_REPOSITORY ?? null)}; it has to be an "owner/name" pair.`)
    console.error('   Refusing rather than passing: the authoritative half of this comparison going missing is')
    console.error('   exactly how a check becomes always-OK.')
    return 1
  }
  console.error(`❌ ${MANIFEST_PATH} says this tree is ${v.recorded}, but this job is running in ${v.actual}.`)
  console.error('')
  console.error('   Same owner, different name: this repository was renamed and its own record of what it is')
  console.error('   was not updated with it. Two things in this tree name the template — this field and')
  console.error("   `pr-check.yml`'s `if: github.repository == …` — and they are compared to each other, so")
  console.error('   they agree while both are wrong and `--check` is SKIPPED on every pull request.')
  console.error('')
  console.error("   To fix: set `template:` in scripts/template-manifest.js's buildManifest() and the `if:` in")
  console.error('   .github/workflows/pr-check.yml to the new name, run `npm run template-manifest`, and commit.')
  console.error('   Apps already generated keep the old name, and that is correct — they record where they came')
  console.error('   from, and a renamed repository still resolves under its former name.')
  return 1
}

// An import must not execute a CLI — `scripts/look-acceptance.js` imports SEEDED_PATHS from here,
// and without this guard reading one export would rewrite the manifest as a side effect.
function invokedDirectly () {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

// --- the ceiling on CLAUDE.md --------------------------------------------------------------
//
// Every model stage of every build receives an app's whole CLAUDE.md in its system prompt, so each
// kilobyte here is paid for on every turn of
// every build of every app seeded afterwards. It reached 306,613 bytes by growing an entry per
// incident; the record of those lives in `kits/TEMPLATE-HISTORY.md` now, and this is what stops
// it growing back. It is part of `--check` and not a suite, because `--check` runs in this repository
// only: an app's own file grows with its own decisions, and that is none of the template's business.
export const CLAUDE_MD_PATH = 'CLAUDE.md'
export const CLAUDE_MD_CEILING_BYTES = 80_000

export function claudeMdProblem (root) {
  const p = join(root, CLAUDE_MD_PATH)
  if (!existsSync(p)) return null // `harness-acceptance` is what requires the file
  const bytes = statSync(p).size
  if (bytes <= CLAUDE_MD_CEILING_BYTES) return null
  return `${CLAUDE_MD_PATH} is ${bytes} bytes, over the ceiling of ${CLAUDE_MD_CEILING_BYTES}. Every build stage pays for this file on every turn, so what only this repository needs belongs in kits/TEMPLATE-HISTORY.md.`
}

// `lib/pages.js` swaps this exact text in `index.html` for the app's name and says nothing when it finds
// none, so every browser tab would read "App". It is here and not in a suite because an app may write its
// own title.
export const TITLE_PLACEHOLDER = '<title>App</title>'
const TITLE_FILES = ['index.html', 'lib/pages.js']

export function titlePlaceholderProblem (root) {
  const missing = TITLE_FILES.filter((f) => !existsSync(join(root, f)) || !readFileSync(join(root, f), 'utf8').includes(TITLE_PLACEHOLDER))
  if (!missing.length) return null
  return `${TITLE_PLACEHOLDER} is missing from ${missing.join(' and ')}, so the page listener cannot put the app's name in the browser tab. Change the two together.`
}

// --- the self-test ------------------------------------------------------------------------
//
// `--check` and `--diff` are both "compare two things and usually agree", which is the shape
// that degrades into always-OK without anyone noticing (an instrument that stops
// discriminating goes GREEN, not red). So both are driven against a SYNTHESIZED root with an
// injected path list — never against this repo, whose own state is what `--check` is for, and
// never against the real seeded list, so this proves the logic rather than the tree.

function synthRoot () {
  const work = mkdtempSync(join(tmpdir(), 'template-manifest-selftest-'))
  mkdirSync(join(work, 'lib'), { recursive: true })
  mkdirSync(join(work, '.immensus'), { recursive: true })
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.9.9' }, null, 2) + '\n')
  writeFileSync(join(work, 'lib', 'one.js'), 'export const one = 1\n')
  writeFileSync(join(work, 'lib', 'two.js'), 'export const two = 2\n')
  return work
}

function selfTest () {
  const failures = []
  const check = (label, ok, detail) => {
    console.log(`  ${ok ? '✅' : '❌'} ${label}`)
    if (!ok) { failures.push(label); if (detail) console.log('     ' + detail) }
  }
  const PATHS = ['lib/one.js', 'lib/two.js']
  const work = synthRoot()
  const mp = join(work, MANIFEST_PATH)
  const pin = () => writeFileSync(mp, serialise(buildManifest(work, PATHS)))

  check("blobSha matches git's blob hash for a known input",
    blobSha('hello\n') === 'ce013625030ba8dba906f756967f9e9ca394464a')

  pin()
  check('a faithful tree reports no differences', differences(work, PATHS).length === 0, differences(work, PATHS).join(' | '))
  check('a faithful tree is not stale', serialise(buildManifest(work, PATHS)) === readFileSync(mp, 'utf8'))

  writeFileSync(join(work, 'lib', 'one.js'), 'export const one = 1\n// changed\n')
  check('an edited seeded file is reported', differences(work, PATHS).some((b) => b.startsWith('lib/one.js differs')), differences(work, PATHS).join(' | '))
  check('an edited seeded file makes the manifest stale', serialise(buildManifest(work, PATHS)) !== readFileSync(mp, 'utf8'))
  pin()
  check('re-writing the manifest clears both', differences(work, PATHS).length === 0 && serialise(buildManifest(work, PATHS)) === readFileSync(mp, 'utf8'))

  rmSync(join(work, 'lib', 'two.js'))
  check('a seeded file that has gone missing is reported', differences(work, PATHS).some((b) => b.startsWith('lib/two.js was seeded and is now absent')))
  let threw = false
  try { buildManifest(work, PATHS) } catch { threw = true }
  check('--write refuses to record a path that is not there', threw)
  writeFileSync(join(work, 'lib', 'two.js'), 'export const two = 2\n')

  // A seeded path the manifest never recorded: in the template repo that is the manifest being
  // behind the tree, which is exactly what --check exists to catch on the PR that adds a file.
  writeFileSync(join(work, 'lib', 'three.js'), 'export const three = 3\n')
  const WIDER = [...PATHS, 'lib/three.js']
  check('a newly seeded file that was never recorded is reported',
    differences(work, WIDER).some((b) => b.includes('lib/three.js is seeded by the template but not recorded')))
  check('and it makes the manifest stale', serialise(buildManifest(work, WIDER)) !== readFileSync(mp, 'utf8'))

  rmSync(mp)
  check('a missing manifest is reported rather than read as clean', differences(work, PATHS).some((b) => b.includes('is missing')))
  writeFileSync(mp, 'not json')
  check('an unparseable manifest is reported rather than read as clean', differences(work, PATHS).some((b) => b.includes('does not parse')))

  // The property that makes this file safe to ship into an app: nothing here is discoverable as
  // a suite. The convention is transcribed from run-suites.js, and the NAME comes from this
  // file's own URL — not from a literal, which would be a tautology that survives a rename.
  // So renaming this file to anything the runner discovers reds
  // here, which is the day the assertion has to notice.
  const SUITE_NAME = /(-acceptance|-probe)$/
  const SUITE_PREFIX = /^check-/
  const base = basename(fileURLToPath(import.meta.url), '.js')
  check(`this tool's own name ("${base}") is not discoverable by the suite convention`,
    !SUITE_NAME.test(base) && !SUITE_PREFIX.test(base))
  // And the control: the same two lines DO discover a name that follows it, so a convention
  // edited into one that matches nothing could not make the assertion above vacuous.
  check('the transcribed convention still recognises a suite name',
    SUITE_NAME.test('look-acceptance') && SUITE_NAME.test('members-probe') && SUITE_PREFIX.test('check-build-stamp'))

  // ---- THE HARNESS IS NOT SEEDED, AND SEEDED_PATHS MUST NOT HARVEST IT FROM THE TREE -----
  //
  // This lives here rather than in a discovered suite on purpose. It is a statement about what the
  // TEMPLATE seeds, which is this repository's business: `pr-check.yml` runs this file's `--self-test`
  // and `--check` under `if: github.repository == 'ImmensusApp/web-app-template'`, and the suite
  // convention cannot discover this file, so Tier A never runs it in a generated app. An earlier
  // draft asserted it in `scripts/deps-acceptance.js` instead, which is SEEDED — so an app that
  // edited its own copy of this file, or deleted its provenance record, would have red its own suite
  // with a message about our harness. That is the app being punished for doing something it is permitted to do.
  //
  // Driven on a synthesized root that DOES carry the harness, which is the only form of this check
  // with a failure mode: `SEEDED_PATHS` must return neither the runner nor anything under
  // `scripts/probe/` even when both are sitting on disk in front of it.
  {
    const w = synthRoot()
    mkdirSync(join(w, 'scripts', 'probe'), { recursive: true })
    mkdirSync(join(w, 'looks'), { recursive: true })
    writeFileSync(join(w, RUNNER_PATH.replace('/', sep)), '#!/usr/bin/env node\n')
    writeFileSync(join(w, 'scripts', 'probe', 'harness.js'), 'export const ROOT = 1\n')
    writeFileSync(join(w, 'scripts', 'probe', 'loader.js'), 'export const x = 1\n')
    writeFileSync(join(w, 'looks', 'studio.css'), ':root{}\n')
    // A kit sitting on disk too: the platform copies a kit in when a plan needs it and
    // the platform never seeds `kits/`, so the manifest must not record one either.
    mkdirSync(join(w, 'kits', 'sign-in', 'lib'), { recursive: true })
    writeFileSync(join(w, 'kits', 'sign-in', 'lib', 'auth.js'), 'export const x = 1\n')
    const paths = SEEDED_PATHS(w)
    check('SEEDED_PATHS returns nothing under kits/ from a tree that HAS a kit on disk',
      !paths.some((x) => x.startsWith('kits/')), paths.filter((x) => x.startsWith('kits/')).join(', '))
    check('SEEDED_PATHS returns no harness path from a tree that HAS the runner and two stubs on disk',
      harnessAmong(paths).length === 0, harnessAmong(paths).join(', '))
    // THE CONTROL, without which the line above passes whenever `list()` is broken: the same root's
    // `looks/` IS harvested, so the globbing half is demonstrably still working.
    check('...CONTROL: the same root\'s looks/studio.css IS harvested, so list() is not simply failing',
      paths.includes('looks/studio.css'), paths.filter((x) => x.startsWith('looks/')).join(', '))
    // And the predicate can say yes, or it is not a predicate.
    check('harnessAmong catches the runner and the probe directory, and spares the near misses',
      harnessAmong([RUNNER_PATH, `${PROBE_DIR}harness.js`]).length === 2 &&
      harnessAmong(['scripts/probe.js', 'scripts/probes/legacy.js', 'scripts/members-probe.js', 'scripts/page-boot-acceptance.js', 'scripts/run-suites.test.js']).length === 0)
    // `--check` is what carries this through to the manifest: it compares the record to
    // `buildManifest(root, SEEDED_PATHS(root))`, so a list with no harness in it IS a manifest with
    // no harness in it. Asserting the manifest separately would be asserting the same fact twice.
    rmSync(w, { recursive: true, force: true })
  }

  // ---- THE CLI'S EXIT CODE ON A RENAME, DRIVEN AS A CHILD PROCESS ----
  //
  // The nine controls inside `--provenance` drive the PURE verdict. They say nothing about what the
  // PROCESS does with it, and `pr-check.yml`'s step is wired `set -e` — so the entire check rested
  // on one `return 1` that nothing asserted.
  //
  // The reviewer read that branch as returning 0. It does not, and that was measured rather than
  // argued: a synthesized root naming `ImmensusApp/old-name` under `GITHUB_REPOSITORY=ImmensusApp/new-name`
  // exits 1. **But the gap it named is real**, which is the half worth keeping: an edit turning that
  // `return 1` into `return 0` would leave every control green while the step reported success on
  // the one state it exists to catch. A wrong sentence about a gate is where the next gap in the
  // gate is — here said by a reviewer rather than by a comment.
  //
  // SPAWNED RATHER THAN CALLED, because the exit code IS the property under test: `provenance()`
  // returning a number proves nothing about `process.exit(cli())`. On a SYNTHESIZED root, so the
  // verdict is decided by the fixture and never by this repository's own state — `--provenance`
  // reads nothing but the manifest, so one copy of this file plus a manifest is a complete root.
  // AND EACH CASE ASSERTS WHY IT EXITED, not just that it did: a control failure also exits 1, so
  // a bare status check would pass for the wrong reason.
  {
    const w = mkdtempSync(join(tmpdir(), 'template-manifest-provenance-'))
    const me = fileURLToPath(import.meta.url)
    const script = join(w, 'scripts', basename(me))
    mkdirSync(join(w, 'scripts'), { recursive: true })
    mkdirSync(join(w, '.immensus'), { recursive: true })
    writeFileSync(script, readFileSync(me))
    const drive = (template, repo) => {
      writeFileSync(join(w, MANIFEST_PATH), JSON.stringify({ template, version: '0.0.0', files: {} }, null, 2) + '\n')
      const env = { ...process.env }
      if (repo === null) delete env.GITHUB_REPOSITORY
      else env.GITHUB_REPOSITORY = repo
      const r = spawnSync(process.execPath, [script, '--provenance'], { env, encoding: 'utf8' })
      return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
    }
    const sane = (r) => !/control\(s\) failed/.test(r.out)

    const renamed = drive('ImmensusApp/old-name', 'ImmensusApp/new-name')
    check('the CLI EXITS 1 on a rename rather than merely printing one',
      renamed.status === 1 && sane(renamed) && /says this tree is ImmensusApp\/old-name/.test(renamed.out),
      `status ${renamed.status}: ${renamed.out.split('\n').filter(Boolean).pop()}`)
    const absent = drive('ImmensusApp/new-name', null)
    check('the CLI EXITS 1 when it is told nothing about which repository this is',
      absent.status === 1 && sane(absent) && /was not told which repository/.test(absent.out),
      `status ${absent.status}`)
    // And the two that must EXIT 0, or this step reds every pull request and every generated app.
    const match = drive('ImmensusApp/new-name', 'ImmensusApp/new-name')
    check('the CLI exits 0 where the manifest names the repository it is running in',
      match.status === 0 && /which is the repository this job is running in/.test(match.out),
      `status ${match.status}: ${match.out}`)
    const app = drive('ImmensusApp/new-name', 'immensus-apps/some-slug')
    check('the CLI exits 0 in a generated app, whose recorded template has another owner',
      app.status === 0 && /a generated app recording the template it came from/.test(app.out),
      `status ${app.status}: ${app.out}`)
    rmSync(w, { recursive: true, force: true })
  }

  // The ceiling, on a synthesized root and at its exact boundary, because a comparison written the
  // wrong way round is silent until the file has already grown past it.
  check('no CLAUDE.md is not this check\'s finding', claudeMdProblem(work) === null)
  writeFileSync(join(work, CLAUDE_MD_PATH), 'x'.repeat(CLAUDE_MD_CEILING_BYTES))
  check('a CLAUDE.md at the ceiling passes', claudeMdProblem(work) === null)
  writeFileSync(join(work, CLAUDE_MD_PATH), 'x'.repeat(CLAUDE_MD_CEILING_BYTES + 1))
  check('one byte over the ceiling is refused, naming where the text belongs',
    /over the ceiling.*kits\/TEMPLATE-HISTORY\.md/.test(claudeMdProblem(work) ?? ''), claudeMdProblem(work))

  check('neither file holding the title placeholder is refused, naming both',
    /index\.html and lib\/pages\.js/.test(titlePlaceholderProblem(work) ?? ''), titlePlaceholderProblem(work))
  writeFileSync(join(work, 'index.html'), `<head>${TITLE_PLACEHOLDER}</head>\n`)
  check('one file without it is refused, naming that file',
    /is missing from lib\/pages\.js,/.test(titlePlaceholderProblem(work) ?? ''), titlePlaceholderProblem(work))
  writeFileSync(join(work, 'lib', 'pages.js'), `export const t = '${TITLE_PLACEHOLDER}'\n`)
  check('both files holding it passes', titlePlaceholderProblem(work) === null, titlePlaceholderProblem(work))

  rmSync(work, { recursive: true, force: true })

  console.log('')
  if (failures.length) {
    console.error(`❌ template-manifest self-test: ${failures.length} assertion(s) failed`)
    return 1
  }
  console.log('✅ template-manifest self-test: --check and --diff both still say no to a changed tree, and SEEDED_PATHS never harvests the harness')
  return 0
}

// --- the CLI -----------------------------------------------------------------------------

function cli () {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  if (process.argv.includes('--self-test')) return selfTest()
  // Before `--diff` and before `buildManifest()` below: `--provenance` is about the manifest's own
  // `template` field and must still answer in a tree that is missing a seeded file, which is the
  // one state `buildManifest()` throws on.
  if (process.argv.includes('--provenance')) return provenance(ROOT)

  if (process.argv.includes('--diff')) {
    // A READER, not a gate. Exits 0 on every outcome, including a missing manifest: the only
    // thing a non-empty answer means is that this app has changed code the template gave it,
    // which is permitted by design.
    const mp = join(ROOT, MANIFEST_PATH)
    if (existsSync(mp)) {
      try {
        const m = JSON.parse(readFileSync(mp, 'utf8'))
        console.log(`seeded from ${m.template ?? '(unrecorded)'} at template version ${m.version ?? '(unrecorded)'}, ${Object.keys(m.files ?? {}).length} files`)
      } catch { console.log(`${MANIFEST_PATH} does not parse`) }
    }
    const diffs = differences(ROOT)
    if (!diffs.length) console.log('every seeded file is byte-identical to the seed')
    else {
      console.log(`${diffs.length} difference(s) from the seed — this app has changed code the template gave it, which is allowed:`)
      for (const d of diffs) console.log('  ' + d)
    }
    console.log('')
    console.log('This is a report. It has no verdict and always exits 0 — do not wire it into a check.')
    return 0
  }

  let text
  try { text = serialise(buildManifest(ROOT)) } catch (e) {
    console.error(`❌ cannot build ${MANIFEST_PATH}: ${e.message}`)
    return 1
  }
  const out = join(ROOT, MANIFEST_PATH)

  if (process.argv.includes('--check')) {
    const current = existsSync(out) ? readFileSync(out, 'utf8') : ''
    if (current !== text) {
      console.error(`❌ ${MANIFEST_PATH} does not match the tree — run \`npm run template-manifest\` and commit it.`)
      for (const d of differences(ROOT)) console.error('   ' + d)
      console.error('')
      console.error('This check belongs to the TEMPLATE repository only: it keeps the record of what the')
      console.error('template ships honest for every app seeded afterwards. It is not a rule about what an')
      console.error('app may change, which is why no suite runs it.')
      return 1
    }
    const problem = claudeMdProblem(ROOT) ?? titlePlaceholderProblem(ROOT)
    if (problem) {
      console.error(`❌ ${problem}`)
      return 1
    }
    console.log(`✅ ${MANIFEST_PATH} matches the tree (${Object.keys(JSON.parse(text).files).length} seeded files)`)
    return 0
  }

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, text)
  console.log(`✅ wrote ${MANIFEST_PATH} (${Object.keys(JSON.parse(text).files).length} seeded files, template ${JSON.parse(text).version})`)
  return 0
}

if (invokedDirectly()) process.exit(cli())
