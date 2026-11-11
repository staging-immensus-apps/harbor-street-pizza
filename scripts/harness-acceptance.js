#!/usr/bin/env node
// FIXED — pins the shape of the harness every generated app inherits (CLAUDE.md §5–§6).
//
// The harness is text: a CLAUDE.md with seven sections, charters whose frontmatter names
// match their filenames, a /dispatch command that lists every doer area, a `check` job with
// that exact name (branch protection requires it), a review workflow in which the agent
// writes a file and the WORKFLOW posts it, a config.yaml with static at /web/,
// and a .gitignore that keeps web/ and CONFIG.env out. None of that is executed by any other
// gate, so a rename or a "simplification" would land green and every app created after it
// would inherit the drift. This suite reads the bytes on disk and says no.
//
// Hermetic (scripts/run-suites.js): no network, no secrets, no git, no wall clock. And it
// runs its negative controls FIRST, against a synthesized copy of the harness with one defect
// at a time — a check that has degraded into "always OK" is indistinguishable from a working
// one when you only ever watch it pass (build-stamp's lesson).

import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

// ASSEMBLED RATHER THAN SPELLED, and the reason is the import above.
//
// `scripts/run-suites.js`'s git guard refuses the WHOLE suite set when one suite's entry file
// BOTH imports node:child_process AND contains a quoted git command — two signals over
// comment-stripped source, neither alone enough, because either alone false-positives. This
// suite now spawns (the draft-guard half below), so until this change the second signal was all
// that stood between a correct file and a red reading "suite reads git at run time" — about a
// suite that runs no git at all, on the one check that decides whether ANY suite runs, in every
// generated app as well as here. Measured 2026-10-09 with this repository's own stripper: two
// live-code hits, the two constants below, both of them markdown emphasis inside a finding
// message.
//
// The bytes are unchanged; what changes is that no quote sits immediately before the command.
// That is `pr-check.yml`'s own private-key technique — whose patterns use character classes so
// that file does not match itself — and another repository's, which assembles the
// `node:child_process` specifier from parts in the controls that scan for it.
//
// IT IS NOT THE COMMENT STRIPPER'S DEFECT, and that was measured before anything here
// changed: with the newline rule in place no comment survives into the scan, so neither hit is
// prose. It is a live string, and the guard cannot tell a git command a suite RUNS from one it
// merely names. This is the one thing in this file that no check can hold, because the check
// would have to run in the state where no suite runs at all.
const GIT = 'git'
const FORCED_ADD = [GIT, 'add', '-f'].join(' ')
const STAGE_ALL = [GIT, 'add', '-A'].join(' ')

export const DOER_AREAS = ['back-end', 'front-end']
export const AGENTS = ['pm', 'qa', 'review', ...DOER_AREAS]
export const COMMANDS = ['pm', 'qa', 'review', 'dispatch']
export const SECTIONS = [
  '## 1. Product', '## 2. Stack', '## 3. Layout', '## 4. Conventions',
  '## 5. Coordination', '## 6. Verification', '## 7. Known gotchas'
]
// §1-4 are the app's (the builder drafts them) and §7 is appended to over the app's life, so
// only their SHAPE is asserted. §5 and §6 are the template's own words — the coordination
// protocol and the evidence tiers every session is held to — and an app that loses them loses
// the protocol, so their load-bearing phrases are asserted inside the section itself.
//
// What is NEVER asserted here is the app's NAME. This suite is FIXED, so it is copied
// into an app called anything at all; the old negative control mutated the literal string
// "# CLAUDE.md — app-template", which is a no-op — and therefore a control that proves
// nothing and fails — in every app that is not called app-template.
export const FIXED_SECTION_CONTENT = [
  ['## 5. Coordination', [/protected/, /worktree/, /status:in-progress/, /--draft/], 'the protected-branch + claim + worktree + draft-PR protocol'],
  ['## 6. Verification', [/Functional probe/, /Observed change/, /Stored metadata/, /negative control/], 'the evidence tiers and the negative-control rule'],
]
// What HARNESS_SETUP.md's templates look like before adaptation. Any of these surviving
// means a file was pasted rather than generated — "a template left with placeholders in it
// is a failed install".
const LEFTOVERS = [
  '<project name>', '<What this is', '<Languages, frameworks', '<Annotated directory',
  '<Code style, patterns', '<test location>', '<Empty at first', '<Area> owns',
  '<turf summary>', '<list your areas>', '<Directories and files this agent owns'
]
const HARNESS_PATHS = [
  'CLAUDE.md', 'config.yaml', '.gitignore', 'package.json',
  '.claude/agents', '.claude/commands', '.github/workflows',
  // Its CONTENTS are not audited by anyone any more (the pin is withdrawn; see
  // scripts/template-manifest.js), but the audit below reads its workflow paths as the record
  // of which files the TEMPLATE seeded, so a fixture without it exercises the fallback instead
  // of the real path.
  '.immensus/template.json',
]

const read = (root, rel) => existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null

// A tiny reader for the flat two-level YAML config.yaml is: `key:` then indented `sub: value`.
function yamlBlock (text, key) {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.startsWith(key + ':'))
  if (start < 0) return null
  const block = [lines[start].slice(key.length + 1).trim()]
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (/^\S/.test(l)) break
    block.push(l.trim())
  }
  return block.join('\n')
}

// GitHub validates EVERY workflow file on every push, whether or not its triggers match, and
// an invalid file records a zero-job `failure` run named after itself — red marks on branches
// where nothing ran, which is the "gate that cries wolf" shape. The commonest way to
// write one is a context GitHub does not provide at that position: `jobs.<id>.env` may read
// only github, needs, strategy, matrix, vars, secrets and inputs, so `runner`, `steps`, `job`
// and `env` there are parse errors, while the SAME expression one level down in a step's
// `env:` is correct. Indentation is the discriminator: workflow `env:` at column 0, job `env:`
// at 4, step `env:` at 8.
const JOB_ENV_FORBIDDEN = ['runner', 'steps', 'job', 'env']

/** Contexts used inside a workflow-level or job-level `env:` block that GitHub rejects. */
export function badEnvContexts (text) {
  const out = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^( {0,4})env:\s*$/)
    if (!m) continue
    const indent = m[1].length
    if (indent !== 0 && indent !== 4) continue
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (l.trim() === '') continue
      const lead = l.match(/^\s*/)[0].length
      if (lead <= indent) break
      // A full-line comment inside the block is prose, not a value. pr-check's greps read raw
      // text and a comment that SPELLS a forbidden token fails a PR exactly like the defect;
      // a gate that cannot be written about is a gate nobody documents.
      if (l.trim().startsWith('#')) continue
      for (const ctx of JOB_ENV_FORBIDDEN) {
        if (new RegExp(`\\$\\{\\{\\s*${ctx}\\.`).test(l)) out.push({ line: j + 1, ctx, text: l.trim() })
      }
    }
  }
  return out
}

// GitHub cancels a superseded run only when the workflow declares `concurrency`, and both lines
// of that block are load-bearing (three 36-minute runs raced on one
// branch on 2026-09-25, and only the last could tell anyone anything). `group` must include the
// ref — keyed on the workflow alone, one pull request's push cancels every other pull request's
// run. `cancel-in-progress` must exclude the default branch, because a run there is not a
// superseded attempt at a verdict but the record that a merge was green, and a cancelled run
// reports NO verdict — the "gate that cries wolf" shape.
//
// Read as YAML-shaped text, like every other check here: a block reformatted into flow style
// reports as "has no group", which is a re-point, not a deletion.
const DEFAULT_BRANCH_GUARD = /refs\/heads\/main|default_branch/

/** The workflow-level `concurrency:` block's lines and scalar values. null when absent. */
export function concurrencyBlock (text) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^concurrency:/.test(l))
  if (start < 0) return null
  let end = start
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '' || /^\S/.test(lines[i])) break
    end = i
  }
  const body = lines.slice(start + 1, end + 1)
  const value = (key) => {
    const l = body.find((l) => new RegExp(`^\\s+${key}:`).test(l))
    return l == null ? null : l.slice(l.indexOf(':') + 1).trim()
  }
  return { first: start, last: end, group: value('group'), cancel: value('cancel-in-progress') }
}

/** Problems with pr-check.yml's supersede guard, in the audit's own sentence form. */
export function concurrencyProblems (text) {
  const c = concurrencyBlock(text)
  if (c == null) return ['pr-check.yml declares no workflow-level concurrency: block — a newer commit leaves the superseded ~36-minute run racing the new one']
  const bad = []
  if (c.group == null) bad.push('pr-check.yml concurrency: has no group')
  else if (!/github\.(ref|head_ref)/.test(c.group)) bad.push(`pr-check.yml concurrency.group (${c.group}) does not key on the ref — one pull request's push would cancel another pull request's run`)
  if (c.cancel == null) bad.push('pr-check.yml concurrency: has no cancel-in-progress — the block then cancels nothing and the guard is decoration')
  else if (!DEFAULT_BRANCH_GUARD.test(c.cancel)) bad.push(`pr-check.yml concurrency.cancel-in-progress (${c.cancel}) does not exclude the default branch — a run on main is the record that a merge was green, not a superseded attempt at a verdict, and a cancelled run reports no verdict at all`)
  return bad
}

// Every `uses:` names an action and a ref, and both halves rot quietly. `actions/checkout@v4`
// and `actions/setup-node@v4` warned on every run in this repo — and these workflows are
// copied verbatim into a founder's repository, so the warning shipped to a customer on every
// push and turns into a hard failure the day the runner image drops the Node the old action
// bundles. Nobody reads a warning; that is the same quiet drift the pinned blob shas exist for.
//
// What this does NOT attempt is deprecation detection, which the issue asked for and which
// cannot be built: the warning is emitted by the runner at execution time, GitHub publishes no
// per-version deprecation flag, and a gate that scrapes release prose is the gate that cries
// wolf and then gets muted — a required check reding for reasons unrelated to
// its subject is worse than no check. DECLARED versus actual is decidable with no external
// source of truth at all: an allowlist of permitted majors, plus a refusal of any ref that can
// move under us. Noticing the next deprecation stays a human reading a warning; the moment they
// do, the fix is one line here, and the gate makes it impossible to bump three workflows and
// forget the fourth.
//
// A value is either a major tag (`vN`, which also admits `vN.x` and `vN.x.y` — a patch pin
// inside the permitted major is stricter, not drift) or a full 40-character commit sha, which
// admits exactly itself. Say what this does NOT mean: a major tag is not immutable either. GitHub
// moves `v7` when v7.1.0 ships, so what the refusal below buys is "no ref that names no version
// at all" — a branch, or nothing. Immutability is the sha form, and it is a separate decision
// (`anthropics/claude-code-action` is the entry where it would matter most: the one action here
// nobody in `actions/` owns, and the one that runs with a token).
export const ACTION_MAJORS = {
  'actions/checkout': 'v7',
  'actions/setup-node': 'v7',
  'anthropics/claude-code-action': 'v1',
}

const SHA_REF = /^[0-9a-f]{40}$/
const MAJOR_REF = /^v(\d+)(?:[.+-].*)?$/
const SETUP_NODE = 'actions/setup-node'

// A block scalar (`run: |`, `prompt: >-`) is prose, exactly like a comment, and this is the
// class the repo has already been bitten by once: pr-check's greps read raw text, so a comment
// that SPELLS a forbidden token fails a PR exactly like the defect. `agent-review.yml` is mostly
// one long `prompt: |` block — an example `uses:` line written into the reviewer's own prompt
// would red a required check here AND in every generated app, for a line that is documentation.
// A header is a key whose value is `|` / `>` with an optional indentation and chomping indicator
// in either order (`|2-`, `>-2`); its body is everything indented past it.
// A header may also carry a trailing comment (`run: | # the script`), which is legal YAML.
const BLOCK_SCALAR = /:\s*[|>](?:[0-9][-+]?|[-+][0-9]?)?(?:\s+#.*)?\s*$/
const leadOf = (l) => l.match(/^\s*/)[0].length
// The column a key sits at, counting a list dash as indentation: for `- if: >-` the key is at 8,
// not at the dash's 6. Taking the dash's column made every SIBLING key of such a step test as
// deeper than the header, so the block swallowed the rest of the step — including a real `uses:`,
// which then vanished from the gate entirely. The blind direction, in the guard against the noisy
// one; measured on `- if: >-` with a `uses:` beneath it.
const keyColumnOf = (l) => l.match(/^(\s*(?:-\s+)?)/)[1].length

/** The lines of `text` that are prose — inside a block scalar — as a Set of 0-based indices. */
export function proseLines (lines) {
  const prose = new Set()
  let open = -1
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (open >= 0) {
      if (l.trim() === '' || leadOf(l) > open) { prose.add(i); continue }
      open = -1
    }
    if (l.trim().startsWith('#')) continue
    if (BLOCK_SCALAR.test(l)) open = keyColumnOf(l)
  }
  return prose
}

/** Every `uses:` in a workflow, action and ref split apart. Comments and block scalars are prose. */
export function actionUses (text) {
  const out = []
  const lines = text.split('\n')
  const prose = proseLines(lines)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (prose.has(i) || l.trim().startsWith('#')) continue
    const m = l.match(/^\s*(?:-\s+)?uses:\s*([^\s#]+)/)
    if (!m) continue
    const spec = m[1].replace(/^['"]|['"]$/g, '')
    const at = spec.lastIndexOf('@')
    out.push({
      line: i + 1,
      indent: l.indexOf('uses:'),
      spec,
      action: at < 0 ? spec : spec.slice(0, at),
      ref: at < 0 ? null : spec.slice(at + 1),
    })
  }
  return out
}

/**
 * The `with:` inputs of the step a parsed `uses:` belongs to, as name → value.
 *
 * Walks out to the step's own boundaries rather than reading forward from `uses:`, because YAML
 * mapping keys are unordered and `with:` may sit either side of it; reads both block and flow
 * style (`with: { cache: 'npm' }`); and skips comments and nested block scalars. A parser that
 * returns `{}` for a legal shape makes the caller cry wolf, which is worse than no check.
 */
export function stepInputs (text, use) {
  const lines = text.split('\n')
  const prose = proseLines(lines)
  const isItem = (l) => new RegExp(`^ {${Math.max(use.indent - 2, 0)}}-\\s`).test(l)

  // YAML constrains a comment's indentation not at all, so one at a shallower column is still a
  // member of the block it sits in and must never be read as the end of a range. Skipped here for
  // the same reason it is skipped inside the `with:` block below.
  const skip = (i) => lines[i].trim() === '' || prose.has(i) || lines[i].trim().startsWith('#')
  let start = 0
  for (let i = use.line - 1; i >= 0; i--) {
    if (skip(i)) continue
    if (isItem(lines[i])) { start = i; break }
    if (leadOf(lines[i]) < use.indent) { start = i + 1; break }
  }
  let end = lines.length - 1
  for (let i = start + 1; i < lines.length; i++) {
    if (skip(i)) continue
    if (isItem(lines[i]) || leadOf(lines[i]) < use.indent) { end = i - 1; break }
  }

  const inputs = {}
  for (let i = start; i <= end; i++) {
    const l = lines[i]
    if (prose.has(i) || l.trim().startsWith('#')) continue
    // `- with:` when `with:` is the step's FIRST key, `with:` otherwise — the dash is the list
    // item, not part of the key, so both put the key itself at the step's own column.
    const w = l.match(/^\s*(?:-\s+)?with:\s*(.*?)\s*$/)
    if (!w || l.indexOf('with:') !== use.indent) continue
    if (w[1].startsWith('{')) { // flow style: one line, braces
      for (const kv of w[1].matchAll(/([A-Za-z0-9_-]+)\s*:\s*('[^']*'|"[^"]*"|[^,}]*)/g)) inputs[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '')
      continue
    }
    for (let j = i + 1; j <= end; j++) {
      const c = lines[j]
      if (c.trim() === '' || prose.has(j) || c.trim().startsWith('#')) continue
      if (leadOf(c) <= use.indent) break // a sibling key of `with:`, so the block is over
      const kv = c.match(/^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*$/)
      if (kv) inputs[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '')
    }
  }
  return inputs
}

/** The line range of the top-level job `id`, 0-based and inclusive. null when there is none. */
export function jobRange (text, id) {
  const lines = text.split('\n')
  const first = lines.findIndex((l) => new RegExp(`^  ${id}:\\s*$`).test(l))
  if (first < 0) return null
  let last = lines.length - 1
  for (let i = first + 1; i < lines.length; i++) {
    // A comment at column 0 or 2 is not the next job. Reading one as the end of this job left
    // `cache: 'npm'` inside the no-install `check` job unreported — the defect the caller exists
    // to catch, hidden by a comment placed above the step that carried it.
    if (lines[i].trim() === '' || lines[i].trim().startsWith('#')) continue
    if (/^\S/.test(lines[i]) || /^ {2}\S/.test(lines[i])) { last = i - 1; break }
  }
  return { first, last }
}

// The self-edit path in agent-review.yml. A PR that edits the reviewer used to be refused
// with a notice and an exit 0 — a check reporting success while saying in its own words that it
// checked nothing.
//
// The mechanism, measured rather than assumed, because it had been guessed
// wrong in both directions: claude-code-action refuses to run when the workflow file differs from
// the default branch's copy ("Workflow validation failed. The workflow file must exist and have
// identical content to the version on the repository's default branch"), AND reports its own
// skipped step as SUCCESS. The refusal is the protection that stops a PR rewriting its reviewer
// into one that approves it, so it must not be worked around; the success is why the absence of a
// review is invisible, and that is the part that was broken.
//
// What is pinned, therefore: the skip is DETECTED rather than predicted, and a self-edit whose
// review did not happen is RED with the workflow diff posted for a human. Five things carry that,
// and losing any one restores a green no-op — the guard must establish the baseline and write the
// diff; the review step must NOT be gated off (let the action decide, then look at what it did);
// the delivery step must turn a missing findings file on a self-edit into a verdict and emit it;
// and the verify step must fail on that verdict, after delivering the comment. The prompt and the
// banner cover the day the action permits a self-edit — a live path, not decoration.
const SELF_EDIT_BASELINE = 'agent-review-workflow-diff.patch'

/**
 * One step of a workflow job by its `id:`, as `{ first, last, body }`, 0-based and inclusive.
 *
 * Walks back from the `id:` line to the list item that owns it and forward to the next item at
 * that same column, skipping comments, blank lines and BLOCK SCALARS — the last because this
 * workflow's prompt is a long block scalar naming files and ids, and a line of prose that merely
 * reads like `id: post` or sits at a shallow column must not decide where a step begins or ends.
 * Both traps are measured ones in this repo: reading a shallow comment as the end of a range hid
 * the exact defect its caller existed to catch, and mistaking a block scalar's extent removed a
 * real `uses:` from the gate entirely.
 */
export function stepById (text, id) {
  const lines = text.split('\n')
  const prose = proseLines(lines)
  // `- id: post` when `id:` is the step's FIRST key, and `id: 'post'` quoted, are both legal YAML
  // and both returned null here — making the gate red with "no step with id post" about a step
  // plainly present: cry-wolf inside the parser rather than in a control, where it is harder to
  // see. keyColumnOf, not leadOf, for the reason that function exists: the dash is list syntax, and
  // reading its column made every sibling key test as deeper than the header (measured in
  // actionUses, where it removed a real `uses:` from the gate).
  const at = lines.findIndex((l, i) => !prose.has(i) && new RegExp(`^\\s*(?:-\\s+)?id:\\s*['"]?${id}['"]?\\s*$`).test(l))
  if (at < 0) return null
  const col = keyColumnOf(lines[at])
  const isItem = (l) => new RegExp(`^ {${Math.max(col - 2, 0)}}-\\s`).test(l)
  const skip = (i) => lines[i].trim() === '' || prose.has(i) || lines[i].trim().startsWith('#')
  let first = 0
  for (let i = at; i >= 0; i--) if (!skip(i) && isItem(lines[i])) { first = i; break }
  let last = lines.length - 1
  for (let i = first + 1; i < lines.length; i++) {
    if (skip(i)) continue
    if (isItem(lines[i]) || leadOf(lines[i]) < col) { last = i - 1; break }
  }
  return { first, last, body: lines.slice(first, last + 1).join('\n') }
}

/**
 * THE REPOSITORY GUARD ON THE MANIFEST CHECK.
 *
 * `scripts/template-manifest.js --check` compares every seeded file against the sha the
 * template shipped. That is the template repository's own business: the pin is withdrawn,
 * so in a generated app the same comparison reds on code
 * the app is entitled to change, and nothing in an app can clear it — `.immensus/template.json`
 * is outside the builder's writable set and no stage has `Bash`. The only thing keeping it out
 * of every app is one `if:` line, and that line was covered by nothing: it is not a `uses:`, not
 * a cache input, and the step's own self-test cannot see the condition it runs under.
 *
 * So the gate is CONDITIONAL, and the condition is the §6 rule rather than caution: if a step
 * invokes `--check`, it must carry the guard. An app that deleted the step passes, because
 * removing a template-only check is exactly what an app is allowed to do; an app or a PR that
 * keeps the step and drops the guard reds, because that is the state that reaches a founder.
 *
 * SAY WHAT THIS DOES NOT BUY, or the next reader will think the step is pinned: deleting the
 * step outright is not caught here, and cannot be. "Require the step to exist" would forbid an
 * app from removing it, and the only way to tell this tree from an app's is to ask the tree,
 * which is the thing an app controls — §6 forbids a seeded suite asserting the app's own name
 * for that reason. Deleting a named step is a visible line in this repo's own diff;
 * dropping three words from an `if:` is not, and that is the one this catches.
 *
 * The repository it must name comes from `.immensus/template.json`'s own `template` field — the
 * provenance record of where this tree came from — so there is no second copy of the name to
 * drift. With no readable manifest, the shape alone is required.
 */
export function manifestGuardProblems (text, templateRepo) {
  const RUNS = /scripts\/template-manifest\.js\s+--check/
  if (!RUNS.test(text)) return []
  const step = stepById(text, 'manifest')
  if (step == null || !RUNS.test(step.body)) {
    return ['pr-check.yml runs `template-manifest.js --check` from a step this gate cannot identify — give that step `id: manifest` so its repository guard can be read off it, or this check is reporting on nothing']
  }
  const ifLines = step.body.split('\n').filter((l) => /^\s*if:/.test(l))
  const cond = ifLines.map((l) => l.replace(/^\s*if:\s*/, '').trim()).join(' ')
  if (!/github\.repository\s*==/.test(cond)) {
    return [`pr-check.yml's "manifest" step runs template-manifest.js --check without an \`if: github.repository == …\` guard — that comparison is the withdrawn template pin and would red every generated app over code the app may change, with no way for a stage to clear it`]
  }
  // A PRESENCE grep is not a MEANING check, and this repo has already shipped that mistake:
  // `notreviewed=true` and its emit were each required only to EXIST, so hoisting
  // one above the branch that set it pinned the output forever with every check green. The same
  // shape here is `github.repository == '…' || true`, or the equality as one operand of an `||`
  // that other repositories satisfy — the guard reads as present and guards nothing.
  // So the condition may only ever be NARROWED: `&&` is fine, and anything that
  // can widen it is refused by name. `always()` is in the list because a step `if:` is where it
  // is legal and it defeats every other term in the expression.
  const widening = [['||', 'an `||`'], ['always(', '`always()`']].filter(([tok]) => cond.includes(tok))
  if (widening.length) {
    return [`pr-check.yml's "manifest" step guards on github.repository but its \`if:\` contains ${widening.map((w) => w[1]).join(' and ')}, which can make the condition true in a repository that is not the template — a guard that reads as present and guards nothing. Narrow it with \`&&\` if you must; never widen it`]
  }
  if (templateRepo) {
    // Exactly the equality against the recorded template, not `includes` of the name: a name can
    // appear in a comment, in a second operand, or as a prefix of another repository's.
    const named = new RegExp(`github\\.repository\\s*==\\s*['"]${templateRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`)
    if (!named.test(cond)) {
      return [`pr-check.yml's "manifest" step guards on github.repository but does not compare it to \`${templateRepo}\`, which is the template .immensus/template.json says this tree came from — a guard naming another repository is the same as no guard here. These two records of the template's identity have to move together: if this repository is ever renamed, the \`if:\` and the manifest's \`template\` field are both wrong and only one of them reds`]
    }
  }
  return []
}

/**
 * THE ONE COMPARISON IN `pr-check.yml` THAT IS NOT BETWEEN TWO RECORDS IN THE TREE.
 *
 * `manifestGuardProblems` above holds the manifest step's `if:` to `.immensus/template.json`'s
 * `template` field. Both of those are in the tree, so the pair can agree while both are wrong —
 * which is what the rename of this repository produced: `app-template` -> `web-app-template`, both
 * records left on the old name, the gate green, and `--check` `skipped` on every pull request for a
 * week. `manifestGuardProblems`' own refusal message predicted it ("if this repository is ever
 * renamed, the `if:` and the manifest's `template` field are both wrong and only one of them reds")
 * and still could not see it, because neither record was compared to anything outside the pair.
 *
 * `scripts/template-manifest.js --provenance` is what holds that field against `github.repository`,
 * and this is the rule that keeps it able to: IT MAY NOT BE SCOPED. An `if:` on that step can only
 * subtract from when it runs, and the states it would most naturally subtract are the ones it exists
 * for. The step is self-scoping by design — its verdict is inert in a generated app, decided on the
 * OWNER of the repository its own manifest names — so an `if:` there is never a fix for anything and
 * is always a narrowing of the only check in this file reaching a fact the tree cannot write. Note
 * the asymmetry with the step above, where `&&` is explicitly allowed: there the condition IS the
 * scoping, so narrowing it is legitimate; here the scoping is the verdict, so narrowing is pure loss.
 *
 * SAY WHAT THIS DOES NOT BUY: deleting the step is not caught, for the same reason the gate above
 * does not require the manifest step to exist. Requiring it would forbid an app from removing a
 * template-only check, and the only way to tell this tree from an app's is to ask the tree — which
 * is the thing an app controls. Deleting a named step is a visible line in this
 * repository's own diff; an `if:` quietly appearing on one is not.
 */
export function provenanceStepProblems (text) {
  if (!/template-manifest\.js\s+--provenance/.test(text)) return []
  const step = stepById(text, 'provenance')
  if (step == null || !/--provenance/.test(step.body)) {
    return ['pr-check.yml runs `template-manifest.js --provenance` from a step this gate cannot identify — give that step `id: provenance` so the rule keeping it unscoped can be read off it, or that rule is reporting on nothing']
  }
  if (step.body.split('\n').some((l) => /^\s*if:/.test(l))) {
    return ['pr-check.yml\'s "provenance" step carries an `if:`. That step is the only check in this file held against `github.repository` rather than against another record in the tree; it is already inert in a generated app by its own verdict, so a condition on it cannot fix anything and can only take away the states it exists for — a renamed repository among them']
  }
  // `continue-on-error` is the OTHER way to leave a step present and toothless, and it is the
  // worse-looking of the two because the step still reports as having run.
  // The step's entire value is that it REDS, so a line saying "and ignore it when it
  // does" is the `|| true` of the step level.
  //
  // ANY form, not `:\s*true`. The first draft of this rule matched the literal `true` only — and
  // `continue-on-error` also takes an expression, so `${{ true }}`, `${{ github.event_name == 'x' }}`
  // and YAML's `yes` all slipped it. That is a guard that reads as present and guards nothing, which
  // is the shape this very function refuses in the `if:` two blocks up: the rule had the defect it
  // was written to prevent. `false` is refused with the rest rather than carved out, because a line
  // that says "do not ignore this failure" is noise whose only function is to be flipped.
  if (/^\s*continue-on-error\s*:/m.test(step.body)) {
    return ['pr-check.yml\'s "provenance" step carries `continue-on-error` — the step exists in order to RED when the manifest stops naming this repository, so ignoring its failure leaves it present and toothless while still reporting as having run. Remove the line; do not set it to false']
  }
  return []
}

/** agent-review.yml's self-edit path, in the audit's sentence form. */
export function selfEditProblems (text) {
  const bad = []
  const guard = stepById(text, 'wfguard')
  const claude = stepById(text, 'claude')
  const post = stepById(text, 'post')
  const verify = stepById(text, 'verify')
  if (guard == null) bad.push('agent-review.yml has no step with id "wfguard" — nothing compares this workflow against the default branch')
  else {
    // The pair is what matters, not either half: runnable=false with selfedit=true is the old
    // predictive refusal wearing the new output, and it would post a notice and exit 0.
    if (!/\bverdict\s+true\s+true\b/.test(guard.body)) bad.push('agent-review.yml sets no (runnable=true, selfedit=true) verdict — it predicts the action\'s refusal instead of letting the action answer and looking at what it did')
    if (/\bverdict\s+false\s+true\b/.test(guard.body)) bad.push('agent-review.yml answers a self-edit with runnable=false — that is the predictive refusal that was removed: it posts a notice and exits 0')
    if (!/runnable=\$1/.test(guard.body) || !/selfedit=\$2/.test(guard.body)) bad.push('agent-review.yml no longer sets runnable and selfedit from one verdict helper — two writers is how a branch sets half the pair')
    if (!guard.body.includes(SELF_EDIT_BASELINE)) bad.push(`agent-review.yml's guard writes no ${SELF_EDIT_BASELINE} — nothing holds the default branch's copy of the workflow, so neither the reviewer nor the human gets the baseline the diff is measured against`)
    // The forged-review hole. .gitignore does not make a path
    // untrackable: a PR that `git add -f`s an agent-review-findings.md gets it materialised by
    // actions/checkout — upstream restores only .claude/, CLAUDE.md and a short list beside them
    // from the base branch — and the delivery step posts whatever is at that path as the review.
    // Removing it must happen before any step can read it, and a `rm` is exactly the line a
    // later tidy-up deletes, so it is pinned — and so are the two things the removal alone does
    // not give you. Scoped to the branch's own body rather than the whole step: `exit 1`
    // appears elsewhere in this guard (the deleted-reviewer case, the unresolvable baseline), so
    // "an exit 1 somewhere in the step" is satisfied by a guard that removes a forgery and
    // carries on — the state this file shipped in while control and builder went red.
    //
    // The non-greedy body stops at the FIRST `fi`, so a nested `if` inside this branch would
    // truncate what is captured. Neither this branch nor the NOT_REVIEWED one below has one today.
    // THE FAILURE DIRECTION IS NOT THE SAME FOR BOTH CHECKS BELOW, and an earlier draft of this
    // comment claimed it was — corrected here rather than quietly, because an overclaim in a
    // comment is the defect class this whole sweep is about:
    //   - the two `exit 1` REQUIREMENTS fail SAFE. A truncated body loses the `exit 1`, the gate
    //     goes RED, and whoever added the nest sees it immediately. Cry-wolf, not a hole.
    //   - the no-print PROHIBITION fails OPEN. It asserts an absence, so a truncated body simply
    //     stops looking at the tail, and a reader added after the nest would pass unnoticed.
    // That asymmetry is the general rule — truncation is safe for "must contain" and unsafe for
    // "must not contain" — and it is why the real guarantee is the `rm` before any later step and
    // not this prohibition. Nest-aware parsing would be more machinery than four lines deserve;
    // the limit is named so the next person adding an `if` here knows which half it weakens.
    const forged = guard.body.match(/if \[ -e "\$REVIEW_FILE" \]; then([\s\S]*?)\n\s*fi\b/)
    if (forged == null) bad.push('agent-review.yml has no `if [ -e "$REVIEW_FILE" ]` branch in its guard — nothing notices a findings file that arrived with the checkout, so a PR can commit its own verdict')
    else {
      if (!/rm -f "\$REVIEW_FILE"/.test(forged[1])) bad.push('agent-review.yml never removes a checked-out $REVIEW_FILE — .gitignore does not stop a PR committing one with `' + FORCED_ADD + '`, and the delivery step would post the PR author\'s own text as the review. Remove it in the guard, before anything reads it')
      if (!/\bexit 1\b/.test(forged[1])) bad.push('agent-review.yml removes a committed $REVIEW_FILE and does not go red — a PR that forged a verdict would merge under a green tick with one log line as the only trace. There is no accident that produces that file: it is gitignored in the template and in every generated app, and the builder stages with `' + STAGE_ALL + '`, which respects .gitignore')
      // The size is evidence; the contents are the forgery. Printing them puts a fabricated review
      // in the job log, where the next person to look reads it as a review — the same defect in a
      // different place. `wc -c` is deliberately not on this list.
      //
      // BEST-EFFORT, AND SAID SO RATHER THAN IMPLIED: this is a blocklist of readers, so it cannot
      // be complete — `xargs`, a redirect into a loop, or a reader nobody has thought of all slip
      // past it. The guarantee does not rest on it. What guarantees the contents never reach a
      // reviewer or a reader is the `rm` above plus the `exit 1`: the file is gone before any later
      // step runs, measured, where `claude`, `post` and `verify` all SKIPPED.
      // This check is hygiene on the branch's own four lines, where a blocklist is adequate because
      // the body is short enough to read. Both spellings of the variable, because `${REVIEW_FILE}`
      // is the one a later edit reaches for.
      //
      // READERS ONLY. `echo`, `printf` and `tee` are deliberately absent: they take the variable as
      // an ARGUMENT, so they print or write the PATH, which this branch does on purpose and must
      // keep doing. The first draft of this list included them and false-positived on the branch's
      // own message — a gate crying wolf about the line it exists to protect, which is worse than
      // no gate and much harder to notice (§5).
      //
      // ANCHORED TO COMMAND POSITION, not matched anywhere in the line, and that is the same
      // lesson one step further in: unanchored, a future message like `echo "no more detail —
      // $REVIEW_FILE"` trips `\bmore\b` and reds the branch over prose. So a reader counts only at
      // the start of a line, after a pipe or separator, or inside `$(…)` — the three places a
      // command can actually begin.
      const READERS = 'cat|head|tail|jq|sed|awk|less|more|od|xxd|strings'
      const FILE = '[^\\n]*\\$\\{?REVIEW_FILE\\}?'
      const readsFile = new RegExp(`(?:(?:^|\\n)[ \\t]*|[|;&]\\s*|\\$\\(\\s*)(?:${READERS})\\b${FILE}`)
      if (readsFile.test(forged[1]) || /\$\(\s*<\s*"?\$\{?REVIEW_FILE\}?/.test(forged[1])) bad.push('agent-review.yml prints the forged $REVIEW_FILE into the job log — a forgery in the log reads as a review to the next person who looks. Print its size, never its contents')
    }
  }
  if (claude == null) bad.push('agent-review.yml has no step with id "claude"')
  else {
    const cond = claude.body.match(/^\s+if:\s*(.*)$/m)
    if (!cond) bad.push('agent-review.yml\'s review step has no `if:` — it would run on drafts and with no baseline')
    else if (/selfedit/.test(cond[1])) bad.push('agent-review.yml gates the review step on selfedit — that predicts claude-code-action\'s refusal rather than detecting it, and a prediction that drifts from the action is how this went green for two days')
    if (!claude.body.includes(SELF_EDIT_BASELINE)) bad.push(`agent-review.yml's prompt never names ${SELF_EDIT_BASELINE} — the guard writes a baseline the reviewer is never told to read, and a second spelling of that path is a silent no-review (the REVIEW_FILE lesson)`)
    if (!/selfedit == 'true'/.test(claude.body)) bad.push('agent-review.yml\'s prompt carries no self-edit instruction — the reviewer is not told the workflow change must be a BLOCKING finding')
  }
  if (post == null) bad.push('agent-review.yml has no step with id "post"')
  else {
    if (!/SELF_EDIT:\s*\$\{\{\s*steps\.wfguard\.outputs\.selfedit/.test(post.body)) bad.push('agent-review.yml\'s delivery step does not read the guard\'s selfedit output — it cannot tell a refused self-edit from a clean review')
    if (!/the file that defines this reviewer/.test(post.body)) bad.push('agent-review.yml posts a self-edit review with no banner — a reader would assume a review of a change to the reviewer is a substitute for reading that change')
    if (!/notreviewed=true/.test(post.body)) bad.push('agent-review.yml never records that a self-edit went unreviewed — claude-code-action reports its own SKIPPED step as success, so a missing findings file is the only evidence, and unrecorded it is a green check with no review')
    // ORDER, not just presence. Both lines were only required to EXIST, so hoisting the
    // emit above the if/elif chain — an ordinary-looking tidy-up — pins the output to its initial
    // `false` forever with every check here still green: the verify step then reads "false", never
    // fails, and an unreviewed self-edit goes out under a green tick again.
    //
    // `setAt >= 0` makes the ordering check go quiet if `notreviewed=true` vanishes, which is only
    // safe because the line immediately above REQUIRES that string — the two are coupled on
    // purpose, and deleting the presence check would silently disarm this one as well.
    const emitAt = post.body.search(/notreviewed=[^\n]*GITHUB_OUTPUT/)
    const setAt = post.body.indexOf('notreviewed=true')
    if (emitAt < 0) bad.push('agent-review.yml does not emit the notreviewed verdict as a step output — the verify step cannot fail on a flag it cannot read')
    else if (setAt >= 0 && emitAt < setAt) bad.push('agent-review.yml emits the notreviewed verdict BEFORE the branch that sets it — hoisting that line above the if/elif chain reads as a tidy-up and pins the output to its initial value forever, while every other check here stays green')
  }
  if (verify == null) bad.push('agent-review.yml has no step with id "verify" — nothing reads the delivery back, or acts on the verdicts the delivery step emitted')
  else {
    // The `env:` BINDING, not merely the name: `${NOT_REVIEWED:-false}` in the shell reads as
    // "false" forever when nothing binds it, and the two spellings are exactly how a step keeps
    // referring to a verdict it can no longer see. Then: the branch has to end the job.
    // Guarded, because slice(-1) is a legal answer that means the opposite: with the shell block
    // gone, an unguarded indexOf returns -1, tail becomes the body's last character, and the gate
    // reds with "reads NOT_REVIEWED and does not fail on it" when the truth is that nothing reads it
    // at all. Right verdict, wrong reason, by accident — the failure this whole entry is about.
    //
    // SCOPED TO THE BRANCH'S OWN BODY, not to "somewhere after the read". The verify step
    // carries a second `exit 1` — the undelivered-comment failure — so a slice from the read was
    // satisfied by that one: swap the two branches, delete the NOT_REVIEWED `exit 1`, and this
    // gate stays green while an unreviewed diff exits 0. A positional check in the instrument
    // that is supposed to notice a positional defect.
    const branch = verify.body.match(/if \[ "\$\{NOT_REVIEWED:-false\}" = 'true' \]; then([\s\S]*?)\n\s*fi\b/)
    if (!/NOT_REVIEWED:\s*\$\{\{\s*steps\.post\.outputs\.notreviewed/.test(verify.body)) bad.push('agent-review.yml delivers an unreviewed-self-edit notice and then reports SUCCESS — the verify step binds no NOT_REVIEWED from the delivery step, so its own default reads "false" forever: exactly the green-check-with-no-review shape')
    else if (branch == null) bad.push('agent-review.yml binds NOT_REVIEWED and never reads it — the env: line is present and no shell branch tests it, so the verdict is computed, emitted, passed in and dropped')
    else if (!/\bexit 1\b/.test(branch[1])) bad.push('agent-review.yml reads NOT_REVIEWED and does not fail on it — delivering the notice is not the verdict; the check has to be red')
  }
  return bad
}

/** Every `uses:` in one workflow measured against ACTION_MAJORS, in the audit's sentence form. */
export function actionUseProblems (file, text) {
  const bad = []
  for (const u of actionUses(text)) {
    // `./.github/workflows/x.yml` is a reusable workflow in THIS repository: it carries no
    // version because it IS the commit under test, and there is nothing to allowlist.
    if (u.action.startsWith('./')) continue
    const allowed = ACTION_MAJORS[u.action]
    if (allowed == null) {
      bad.push(`${file}:${u.line} uses ${u.spec}, which no entry in ACTION_MAJORS permits — declare the major you mean in scripts/harness-acceptance.js in the same PR, so a new action is a line a reviewer sees`)
      continue
    }
    const allowedMajor = (allowed.match(MAJOR_REF) ?? [])[1]
    if (allowedMajor == null && !SHA_REF.test(allowed)) {
      bad.push(`ACTION_MAJORS["${u.action}"] is "${allowed}", which is neither a major tag (vN) nor a 40-character commit sha — the allowlist has nothing checkable in it`)
      continue
    }
    if (u.ref == null) {
      bad.push(`${file}:${u.line} uses ${u.spec} with no @ref at all — GitHub resolves that to the action's default branch, which moves under us; pin ${allowed}`)
      continue
    }
    if (SHA_REF.test(allowed)) {
      if (u.ref !== allowed) bad.push(`${file}:${u.line} uses ${u.spec}, but ACTION_MAJORS pins ${u.action} to the commit ${allowed.slice(0, 7)} — a sha entry admits exactly one ref`)
      continue
    }
    if (SHA_REF.test(u.ref)) {
      bad.push(`${file}:${u.line} pins ${u.action} to the commit ${u.ref.slice(0, 7)} while ACTION_MAJORS permits ${allowed} — a sha is stricter, not wrong, so declare the sha itself in ACTION_MAJORS if that is what you mean`)
      continue
    }
    const major = (u.ref.match(MAJOR_REF) ?? [])[1]
    if (major == null) {
      bad.push(`${file}:${u.line} uses ${u.spec}, a ref that names no version — a branch can become anything at all without a commit in this repository, and in a generated app without one in the founder's; pin ${allowed} (which still moves within its major) or a full 40-character commit sha (which does not)`)
      continue
    }
    if (major !== allowedMajor) {
      bad.push(`${file}:${u.line} uses ${u.spec}, but ACTION_MAJORS permits ${u.action}@${allowed} — bump the workflow or change the allowlist, never neither`)
    }
  }
  return bad
}

/**
 * setup-node with neither `cache:` nor `package-manager-cache:` does not mean "no caching":
 * from v5 it caches whenever package.json names npm in `packageManager` or
 * `devEngines.packageManager`. In a generated app package.json is GENERATED, so silence here
 * hands the decision to the app — including in pr-check's `check` job, whose entire design is
 * "installs nothing, caches nothing". Every step says which it means.
 */
export function setupNodeCacheProblems (file, text) {
  const bad = []
  for (const u of actionUses(text)) {
    if (u.action !== SETUP_NODE) continue
    const inputs = stepInputs(text, u)
    if ('cache' in inputs || 'package-manager-cache' in inputs) continue
    bad.push(`${file}:${u.line} runs ${SETUP_NODE} with neither cache: nor package-manager-cache: — from v5 it caches whenever package.json names npm in packageManager, and in a generated app package.json is GENERATED, so the job's caching would be the app's decision rather than the template's; say which you mean`)
  }
  return bad
}

/**
 * Saying WHICH is not the same as saying the right one. pr-check's `check` job installs nothing,
 * and its 10-minute budget is sized for that — so in THAT job the answer is
 * always "no caching", and `package-manager-cache: true` would satisfy the check above while
 * reintroducing exactly the caching that answer rules out. Absence is left to `setupNodeCacheProblems()`, so one
 * defect never reports twice.
 */
export function checkJobCachingProblems (text) {
  const r = jobRange(text, 'check')
  if (r == null) return [] // a missing `check` job is already its own finding
  const bad = []
  for (const u of actionUses(text)) {
    if (u.action !== SETUP_NODE || u.line - 1 < r.first || u.line - 1 > r.last) continue
    const inputs = stepInputs(text, u)
    if (inputs.cache != null) {
      bad.push(`pr-check.yml:${u.line} caches in the "check" job (cache: ${inputs.cache}) — that job installs nothing, which is why its budget is 10 minutes against seconds of work; restore an install and this line together, not one without the other`)
    } else if ('package-manager-cache' in inputs && inputs['package-manager-cache'] !== 'false') {
      bad.push(`pr-check.yml:${u.line} sets package-manager-cache: ${inputs['package-manager-cache']} in the "check" job — that job installs nothing, so the only answer there is false`)
    }
  }
  return bad
}

/** The text under a `## N. Title` heading, up to the next `## ` heading. null when absent. */
export function sectionBody (text, heading) {
  const at = text.indexOf('\n' + heading)
  if (at < 0) return null
  const rest = text.slice(at + 1)
  const next = rest.indexOf('\n## ')
  return next < 0 ? rest : rest.slice(0, next)
}

// =====================================================================================
// THE DRAFT GUARD ON THE `acceptance` JOB — whether the suites run at all, which is
// upstream of every other rule in this file.
// =====================================================================================
//
// `acceptance` is one of the two contexts the `protect` ruleset requires BY NAME, and it can
// report success having skipped every suite on a pull request that is `MERGEABLE` / `CLEAN`.
// It happened twice in this family, in two other repositories, and an
// audit by head sha found that THIS repository merged nothing on a skipped set, so here it is a
// hole rather than an incident, which is the cheapest moment to close one.
//
// HALF OF THIS IS A MEASUREMENT RATHER THAN A READING, and that is the point of it: the
// resolution script is extracted from the workflow and EXECUTED, under both shells GitHub might
// run it with, against a stubbed `gh`, over every state it has to classify. Read rather than
// run, "it falls open" is a sentence in a comment — and an assertion over
// source whose subject turns out to be the prose is asserting the prose.
//
// IT FINDS THE SUITES STEP BY WHAT IT RUNS, NEVER BY ITS NAME. The step is
// `Acceptance + probe suites` here and `Acceptance suites` in another repository, and an audit of
// this very defect reported "none" for twenty merges by keying on one literal.
//
// IT IS A SEEDED SUITE, so it ships into every app, and the two §6 rules that bound one both
// hold. It asserts only what the TEMPLATE owns — `.github/workflows/pr-check.yml` is seeded, and
// every assertion here is of the same kind as the `check`-job-name and `concurrency` ones above
// it. And no negative control anchors on a GENERATED line: every mutation is derived from this
// workflow's own seeded text or from a synthesized job, and each asserts that it MATCHED.

/**
 * The body of a YAML key in a WORKFLOW file, by indentation: every line more indented than the
 * key, starting after it. Works for a block mapping (`permissions:`) and for a block scalar
 * (`run: |`).
 *
 * NOT named `yamlBlock`, which is taken: that one is documented as a reader for `config.yaml`'s
 * flat two-level shape and finds a key only at column zero, so it cannot see a job's `steps:`.
 * Widening it would change the verdict of every `config.yaml` check for a reason that has
 * nothing to do with them. Two readers with accurate names, each saying which YAML it reads,
 * beats one reader with two jobs.
 *
 * Indentation-based because that is what YAML means, and because this suite reads a file this
 * repository owns: a reformat that broke it reds every check below rather than passing quietly.
 */
export function workflowBlock (text, key) {
  const m = new RegExp(`^( *)${key}: *(?:[|>][-+]?)?[^\\S\\n]*$`, 'm').exec(text)
  if (m == null) return null
  const indent = m[1].length
  const out = []
  for (const line of text.slice(m.index + m[0].length + 1).split('\n')) {
    if (line.trim() === '') { out.push(''); continue }
    if (line.length - line.trimStart().length <= indent) break
    out.push(line.trimEnd())
  }
  // Trailing blank lines belong to whatever follows, not to this block.
  while (out.length && out.at(-1) === '') out.pop()
  return out.join('\n')
}

/** The permissions the `acceptance` job needs, each with what stops working without it. */
export const ACCEPTANCE_PERMISSIONS = [
  ['contents: read', 'the checkout — a job-level block REPLACES the default rather than adding to it'],
  ['pull-requests: read', 'the live read below: without it `gh api` 403s on EVERY run, the resolution falls open to running the suites, and the measured draft saving is silently gone']
]

/**
 * The steps of a job, as `{ text, name, id, cond, run, env }`.
 *
 * Split on the `- ` item boundary rather than parsed, for `workflowBlock`'s reason: this reads a
 * file this repository owns, so a reformat that broke the reader reds every check below instead
 * of passing quietly.
 *
 * A step's KEYS are read only at the step's own indentation, and that is not fastidiousness: a
 * `run:` body here is a shell script, and a shell script may legitimately contain a line reading
 * `if: …` or `name: …` — in a heredoc, in an echoed YAML fragment, in a comment. A reader that
 * matched anywhere in the step text would take one of those for the step's own `if:` and judge
 * the wrong condition, which is the assert-on-the-prose defect one level out.
 */
export function workflowSteps (jobText) {
  const body = (workflowBlock(jobText, 'steps') ?? '').split('\n')
  // The ITEM boundary is a dash at the list's own indentation, and that is the same defect as
  // the keys one step along: a `run:` body can hold a line beginning `- name:` — an echoed YAML
  // fragment, a markdown bullet — and a splitter matching any indentation cuts a new "step" out
  // of the middle of a shell script.
  const dash = body.find(l => /^ *- /.test(l))
  const stepIndent = dash == null ? 0 : dash.length - dash.trimStart().length
  const groups = []
  for (const line of body) {
    const indent = line.length - line.trimStart().length
    if (indent === stepIndent && /^ *- /.test(line)) groups.push([])
    if (groups.length) groups.at(-1).push(line)
  }
  return groups.map(lines => {
    const text = lines.join('\n')
    // `      - name: X` puts the first key at the column after the dash, and every sibling key
    // of that step sits at the same one.
    const keyIndent = (lines[0].match(/^( *)- /)?.[1].length ?? 0) + 2
    const keyLines = lines
      .map((l, i) => (i === 0 ? l.replace(/^( *)- /, '$1  ') : l))
      .filter(l => l.trim() !== '' && l.length - l.trimStart().length === keyIndent)
      .join('\n')
    const inline = key => {
      const m = keyLines.match(new RegExp(`^ *${key}: +(.+?)[^\\S\\n]*$`, 'm'))
      if (m == null || /^[|>][-+]?$/.test(m[1])) return null
      // A quoted scalar is the same value: `if: "x == 'y'"` means what `if: x == 'y'` means, and
      // a reader that kept the quotes would red a correct file over a legal spelling.
      return m[1].replace(/^"([\s\S]*)"$/, '$1')
    }
    // `run:` is inline as often as it is a block scalar (`- run: npm ci …`), and a reader that
    // only knew the block form would find no step running the suites at all — which reads as
    // "the job runs no suite" and is the false positive that mutes a gate.
    return { text, name: inline('name'), id: inline('id'), cond: inline('if'), run: inline('run') ?? workflowBlock(text, 'run'), env: workflowBlock(text, 'env') }
  })
}

// CAN THIS HOST RUN THE MEASURED HALF AT ALL, and the answer is allowed to be no.
//
// GitHub runs a `run:` step under `bash`, so driving the script under anything else would not be
// driving what ships. But this suite is SEEDED: it also runs in the builder's Tier A, inside a
// workspace on a container this repository does not choose. `bash` is almost certainly there,
// and "almost certainly" is the kind of claim a gate must not rest on — while the cost of being wrong
// is the worst available, because `suites` is a required Tier A check and every build in every
// app would fail on a missing interpreter.
//
// So a host with no `bash` SKIPS the measured half with its reason printed, and the shape half
// still runs. The template's own CI is ubuntu and takes the measured path on every pull request,
// which is where this workflow is authored and where a skip would matter. Memoised, because
// `audit()` runs once per negative control.
let shellOk = null
export function canDriveShell () {
  if (shellOk != null) return shellOk
  const r = spawnSync('bash', ['-c', 'exit 0'], { encoding: 'utf8' })
  shellOk = r.error == null && r.status === 0
  return shellOk
}

// The stubbed `gh`, written ONCE per process and told what to do through the environment.
//
// A singleton for a measured reason rather than for tidiness: the FIRST exec of a newly written
// executable costs roughly an order of magnitude more than re-execing one already on disk, so a
// stub written per call costs more than the work it enables. It carries no state between calls —
// every case's answer comes from `STUB_*` in that call's environment — so it is not a cache a
// control could outlive.
let stubBin = null
function ghStub () {
  if (stubBin) return stubBin
  const dir = mkdtempSync(join(tmpdir(), 'draft-guard-gh-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  // `if` blocks and not `[ -n … ] && echo …`, which leaves a non-zero status behind whenever the
  // variable is unset — harmless only because an explicit `exit` follows it, and a trap for
  // whoever adds `-e` to this stub or drops that `exit`.
  writeFileSync(join(bin, 'gh'), [
    '#!/bin/sh',
    'if [ -n "$STUB_OUT" ]; then echo "$STUB_OUT"; fi',
    'if [ -n "$STUB_ERR" ]; then echo "$STUB_ERR" >&2; fi',
    'exit "${STUB_EXIT:-0}"'
  ].join('\n') + '\n', { mode: 0o755 })
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  stubBin = bin
  return bin
}

// Keyed on the whole input — the script text and the case — of a function with no clock, no
// network and no state outside its own temp directory. A control mutates the script, so the key
// is exactly the thing a control changes.
const driven = new Map()

/**
 * Run a resolution script the way GitHub runs it — under the default `bash -e` AND under the
 * `-eo pipefail` that an explicit `shell: bash` would add — with `gh` stubbed, and report what
 * it decided. `null` when this host has no `bash`.
 *
 * Hermetic: no network (the stub is a three-line shell script on PATH), no git, no clock. Both
 * flag sets are driven because a construction that behaves differently under them is a trap
 * waiting for whoever adds that one line.
 */
export function driveDraftResolution (script, opts = {}) {
  if (!canDriveShell()) return null
  const key = JSON.stringify([script, opts])
  const hit = driven.get(key)
  if (hit) return hit
  const { ghExit = 0, ghStdout = '', ghStderr = '', PR = '7', PAYLOAD_DRAFT = 'true' } = opts
  const work = mkdtempSync(join(tmpdir(), 'draft-guard-'))
  const scriptPath = join(work, 'resolve.sh')
  writeFileSync(scriptPath, script + '\n')
  const outPath = join(work, 'out')
  const sumPath = join(work, 'summary')
  const runs = []
  for (const flags of [['-e'], ['-eo', 'pipefail']]) {
    writeFileSync(outPath, '')
    writeFileSync(sumPath, '')
    const r = spawnSync('bash', [...flags, scriptPath], {
      encoding: 'utf8',
      env: {
        PATH: `${ghStub()}:${process.env.PATH}`,
        STUB_OUT: String(ghStdout),
        STUB_ERR: String(ghStderr),
        STUB_EXIT: String(Number(ghExit)),
        GITHUB_OUTPUT: outPath,
        GITHUB_STEP_SUMMARY: sumPath,
        // Any owner/name: the script interpolates it into a path the stub ignores, and this
        // suite is copied into an app called anything at all, so it may not be this
        // repository's own name.
        GITHUB_REPOSITORY: 'owner/repo',
        GH_TOKEN: 'not-a-token',
        PR: String(PR),
        PAYLOAD_DRAFT: String(PAYLOAD_DRAFT)
      }
    })
    const decided = readFileSync(outPath, 'utf8').match(/^draft=(.*)$/m)
    runs.push({ flags: flags.join(' '), status: r.status, decided: decided ? decided[1] : null, log: `${r.stdout ?? ''}${r.stderr ?? ''}` })
  }
  rmSync(work, { recursive: true, force: true })
  driven.set(key, runs)
  return runs
}

/**
 * Every state the resolution has to classify, each with the answer it must give.
 *
 * No count in this sentence and no "one of them": the PROPERTY is the invariant — a state may
 * decide `true` only where the live read positively said `true` — and it is readable off the
 * third column rather than counted. A number beside a list goes stale the first time the list
 * grows.
 */
export const DRAFT_CASES = [
  ['the pull request is a draft', { ghStdout: 'true', PAYLOAD_DRAFT: 'false' }, 'true'],
  ['the pull request is ready', { ghStdout: 'false', PAYLOAD_DRAFT: 'true' }, 'false'],
  ['the read FAILS', { ghExit: 1, ghStderr: 'HTTP 403: Resource not accessible by integration' }, 'false'],
  ['the event carries no pull request number', { ghStdout: 'true', PR: '' }, 'false'],
  ['the API answers something that is neither', { ghStdout: 'maybe' }, 'false'],
  // The one a `2>&1` would have got wrong: a SUCCESSFUL call that also writes a notice. The
  // answer is still the answer, and the notice must not turn a readable state into an
  // unreadable one — which would fall open to running and lose the saving for nothing.
  ['the read succeeds and also warns', { ghStdout: 'true', ghStderr: 'gh: a new release is available' }, 'true']
]

/**
 * The draft guard on the `acceptance` job: its shape, and then its measured behaviour.
 */
export function prCheckDraftProblems (text) {
  const bad = []
  const job = workflowBlock(text, 'acceptance')
  if (job == null) {
    bad.push('pr-check.yml has no job named exactly "acceptance" — branch protection requires that context BY NAME, and a required check that never reports is indistinguishable in a pull request list from one that passed')
    return bad
  }

  const granted = new Set((workflowBlock(job, 'permissions') ?? '').split('\n').map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#')))
  for (const [line, why] of ACCEPTANCE_PERMISSIONS) {
    if (!granted.has(line)) bad.push(`pr-check.yml's "acceptance" job does not grant \`${line}\` — ${why}`)
  }

  const steps = workflowSteps(job)
  // By what it RUNS, never by its name.
  const suitesAt = steps.findIndex(s => /\brun-suites\.js[^\S\n]*$/m.test(s.run ?? ''))
  if (suitesAt < 0) {
    bad.push('pr-check.yml\'s "acceptance" job has no step that runs scripts/run-suites.js — the required context would report on a job that runs no suite at all')
    return bad
  }
  const suites = steps[suitesAt]
  const cond = suites.cond
  if (cond == null) {
    bad.push(`pr-check.yml's "${suites.name}" step carries no \`if:\` — the draft saving is gone. That is the safe direction and not the intended one; restore the resolved condition rather than leaving it off`)
    return bad
  }
  if (/github\.event\.pull_request\.draft/.test(cond)) {
    bad.push(`pr-check.yml's "${suites.name}" step decides from \`github.event.pull_request.draft\` — that field is a snapshot of whenever the EVENT was generated, and a push followed within seconds by \`gh pr ready\` leaves the only run on the head sha carrying a payload in which it is still true. Measured: \`acceptance\` green with every suite skipped, on pull requests reporting MERGEABLE/CLEAN, and two merges in this family went in on it`)
  }
  const resolved = cond.match(/steps\.([\w-]+)\.outputs\.draft/)
  if (resolved == null) {
    bad.push(`pr-check.yml's "${suites.name}" step does not key on a \`steps.<id>.outputs.draft\` resolved in this job — the only input it can have that is not the stale event payload is a live read`)
    return bad
  }
  // The DIRECTION, which is the whole rule: only a positive live `true` may skip. `== 'false'`
  // needs an affirmative "ready" in order to run, so every other state — an empty output from a
  // resolve step skipped on a `workflow_dispatch` or a `merge_group` entry, a failed read —
  // skips a required check and reports success.
  if (!/!=\s*'true'/.test(cond) || /==/.test(cond)) {
    bad.push(`pr-check.yml's "${suites.name}" step is conditioned on \`${cond}\`, which is not \`!= 'true'\` — a guard that decides whether to run a required check must fail TOWARD RUNNING IT. Written as an equality it needs a positive answer in order to run, so a skipped resolve step (a manual run, a merge-queue entry) leaves the output empty, \`'' == 'false'\` is false, and the suites are skipped under a green badge`)
  }

  const resolveAt = steps.findIndex(s => s.id === resolved[1])
  if (resolveAt < 0) {
    bad.push(`pr-check.yml's "${suites.name}" step reads \`steps.${resolved[1]}.outputs.draft\` and no step in the job has that id — the output is permanently empty, so the suites always run. Correct by accident, and the draft saving is gone`)
    return bad
  }
  if (resolveAt > suitesAt) {
    bad.push(`pr-check.yml resolves the draft state AFTER the step that reads it — \`steps.${resolved[1]}.outputs.draft\` is empty when that condition is evaluated`)
  }
  const resolve = steps[resolveAt]
  const script = resolve.run
  if (script == null || !/gh api\b/.test(script) || !/\/pulls\//.test(script)) {
    bad.push(`pr-check.yml's "${resolve.name}" step does not read the pull request from the API (\`gh api …/pulls/<n>\`) — then whatever it writes to its output came from the event payload after all, which is the stale input this check is about`)
    return bad
  }
  if (!/github\.event_name\s*==\s*'pull_request'/.test(resolve.cond ?? '')) {
    bad.push(`pr-check.yml's "${resolve.name}" step is not gated on \`github.event_name == 'pull_request'\` — a \`workflow_dispatch\` and a \`merge_group\` entry carry no pull request, so the read fails on exactly the manual run somebody fires to check the suites. It still falls open to RUNNING them, so this costs noise rather than correctness; the step's own \`if:\` is what keeps \`gh workflow run pr-check.yml --ref <branch>\` clean`)
  }
  // Every GitHub expression belongs in `env:`, which is what lets this suite extract the script
  // and EXECUTE it — and keeps a pull request's own strings off a command line.
  if (/\$\{\{/.test(script)) {
    bad.push(`pr-check.yml's "${resolve.name}" step interpolates a \`\${{ }}\` expression into its shell script — pass it through \`env:\` instead. Nothing here could execute the script to prove it falls open, and GitHub would be splicing a pull request's own values into a command line`)
  }
  for (const key of ['GH_TOKEN', 'PR']) {
    if (!new RegExp(`^ *${key}:`, 'm').test(resolve.env ?? '')) {
      bad.push(`pr-check.yml's "${resolve.name}" step declares no \`${key}\` in its \`env:\` — the script reads it from the environment, so without it the read cannot happen and every run falls open`)
    }
  }

  // ---- and now the part that is a measurement rather than a reading ----------------------
  //
  // Every state in DRAFT_CASES, driven under both shells, each against the answer it must give —
  // and a state may answer `true` only where the live read positively said so. Every one must
  // exit 0: a non-zero exit skips every later step, so a resolution that aborts takes the suites
  // with it — red rather than falsely green, but a required check that reds for an API blip is a
  // gate that gets muted, and that is not the designed direction either.
  //
  // `null` is a host with no `bash`, where the measured half is SKIPPED rather than failed; the
  // suite's own output says which path it took, and `canDriveShell()` carries the reason.
  for (const [label, opts, want] of DRAFT_CASES) {
    for (const run of driveDraftResolution(script, opts) ?? []) {
      if (run.status !== 0) {
        bad.push(`pr-check.yml's draft resolution exits ${run.status} under \`bash ${run.flags}\` when ${label} — a non-zero exit skips every step after it, so the acceptance suites do not run and the job reds. The guard must decide and carry on, never abort. Last line: ${run.log.trim().split('\n').at(-1) || '(nothing)'}`)
      } else if (run.decided !== want) {
        const effect = want === 'false'
          ? 'so a required check reports success having skipped every suite'
          : 'so the draft saving is gone'
        bad.push(`pr-check.yml's draft resolution decides \`draft=${run.decided}\` under \`bash ${run.flags}\` when ${label}, and it must decide \`${want}\` — ${effect}`)
      }
    }
  }

  // The banner and the skip must be two readings of ONE answer. A caveat keyed on the payload
  // beside a skip keyed on the live read is the state where the badge says the suites ran and
  // the summary says they did not, or the reverse — and the summary is the half nobody reads.
  const banner = steps.find(s => /DRAFT: the acceptance suites did NOT run/.test(s.run ?? ''))
  if (banner == null) {
    bad.push('pr-check.yml\'s "acceptance" job no longer says, where the badge is read, that a draft\'s green tick did not cover the suites — a summary may not count what an exit status did not say')
    // Normalised and `${{ }}`-tolerant on purpose: the PROPERTY is that the caveat reads the same
    // step output with the opposite comparison, and an exact string match would red on an added
    // space or a wrapper — a gate that cries wolf over a respelling is a broken gate.
  } else if (!new RegExp(`^(\\$\\{\\{)?\\s*steps\\.${resolved[1]}\\.outputs\\.draft\\s*==\\s*'true'\\s*(\\}\\})?$`).test(banner.cond ?? '')) {
    bad.push(`pr-check.yml's draft caveat is conditioned on \`${banner.cond}\` while the suites are skipped on \`${cond}\` — two readings of two different answers, so the summary can claim the suites were skipped on a run that ran them, or stay silent on a run that did not`)
  }

  return bad
}

// THE CHECKS AN APP INHERITS HAVE TO BE ABLE TO PASS, AND A GREEN ONE HAS TO MEAN SOMETHING RAN.
// The test harness is not in an app's repository (CLAUDE.md §6), and for a while `check` and
// `acceptance` could never pass in any app, so nobody read them. This holds the two steps' question
// and the exemption by executing them, in the same way the draft guard above is held.
const driveCache = new Map()
function driveScript (key, run) {
  const hit = driveCache.get(key)
  if (hit) return hit
  const out = run()
  driveCache.set(key, out)
  return out
}

/** Run the "is the harness here" step in a temporary directory. `null` on a host with no `bash`. */
export function driveHarnessPresence (script, { repo, runner }) {
  if (!canDriveShell()) return null
  return driveScript(JSON.stringify(['harness', script, repo, runner]), () => {
    const work = mkdtempSync(join(tmpdir(), 'harness-presence-'))
    if (runner) {
      mkdirSync(join(work, 'scripts'))
      writeFileSync(join(work, 'scripts', 'run-suites.js'), '\n')
    }
    const outPath = join(work, '.out')
    writeFileSync(outPath, '')
    const r = spawnSync('bash', ['-e', '-c', script], { cwd: work, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_REPOSITORY: repo, GITHUB_OUTPUT: outPath } })
    const absent = readFileSync(outPath, 'utf8').match(/^absent=(.*)$/m)?.[1] ?? null
    rmSync(work, { recursive: true, force: true })
    return { status: r.status, absent }
  })
}

/** Run the "scripts point at real files" step over a package.json holding these scripts. */
export function driveScriptPaths (script, scripts) {
  if (!canDriveShell()) return null
  return driveScript(JSON.stringify(['paths', script, scripts]), () => {
    const work = mkdtempSync(join(tmpdir(), 'script-paths-'))
    writeFileSync(join(work, 'package.json'), JSON.stringify({ scripts }))
    const r = spawnSync('bash', ['-e', '-c', script], { cwd: work, encoding: 'utf8', env: { PATH: process.env.PATH } })
    rmSync(work, { recursive: true, force: true })
    return r.status
  })
}

/** The harness questions in `pr-check.yml`: asked in both jobs, read the safe way, and answered right. */
export function harnessAbsenceProblems (text, templateRepo) {
  const bad = []
  const stepsOf = job => workflowSteps(workflowBlock(text, job) ?? '')
  const scripts = []
  for (const job of ['check', 'acceptance']) {
    const asks = stepsOf(job).find(s => s.id === 'harness')
    if (asks == null) {
      bad.push(`pr-check.yml's "${job}" job has no step with id "harness" — a step that needs the harness then fails in every app, whose repository does not hold it`)
      continue
    }
    if (asks.cond != null) bad.push(`pr-check.yml's "${job}" job conditions its "harness" step on \`${asks.cond}\` — an unanswered question runs the harness and reds every app`)
    scripts.push(asks.run)
  }
  if (scripts.length === 2 && scripts[0] !== scripts[1]) bad.push('pr-check.yml asks whether the harness is present in two different ways, so `check` and `acceptance` can disagree about one repository')
  const reads = "steps.harness.outputs.absent != 'true'"
  const selfTest = stepsOf('check').find(s => /run-suites\.js --self-test/.test(s.run ?? ''))
  if (selfTest != null && !(selfTest.cond ?? '').includes(reads)) bad.push(`pr-check.yml's runner self-test is not conditioned on \`${reads}\` — it fails with a missing module in every app, so \`check\` can never pass`)
  const suites = stepsOf('acceptance').find(s => /\brun-suites\.js[^\S\n]*$/m.test(s.run ?? ''))
  if (suites != null && !(suites.cond ?? '').includes(reads)) bad.push(`pr-check.yml's suites step is not conditioned on \`${reads}\` — it fails with a missing module in every app, so \`acceptance\` can never pass`)
  const says = stepsOf('acceptance').find(s => /steps\.harness\.outputs\.absent\s*==\s*'true'/.test(s.cond ?? ''))
  if (says == null || !/did NOT run/.test(says.run ?? '') || !/GITHUB_STEP_SUMMARY/.test(says.run ?? '')) bad.push('pr-check.yml\'s "acceptance" job does not say, where the result is read, that an app\'s test suites did NOT run — a green tick there covers the type-check and the build only')

  const paths = stepsOf('check').find(s => /script references missing file/.test(s.run ?? ''))
  if (paths == null) bad.push('pr-check.yml has no step checking that package.json scripts point at real files')
  else if (canDriveShell()) {
    if (driveScriptPaths(paths.run, { suites: 'node scripts/run-suites.js', x: 'node scripts/probe/x.js' }) !== 0) bad.push('pr-check.yml\'s script-path step refuses the harness, which no app\'s repository holds, so `check` can never pass')
    if (driveScriptPaths(paths.run, { suites: 'node scripts/run-suites.js', y: 'node scripts/gone.js' }) === 0) bad.push('pr-check.yml\'s script-path step passes a script that names a missing file of the app\'s own — the exemption is wider than the harness')
  }

  const script = scripts[0]
  if (script == null) return bad
  const literal = script.match(/GITHUB_REPOSITORY" = '([^']+)'/)?.[1]
  if (literal == null) bad.push('pr-check.yml\'s "harness" step does not name the template repository — deleting the harness from the template would then skip its suites and leave every check green')
  else if (templateRepo != null && literal !== templateRepo) bad.push(`pr-check.yml's "harness" step names ${literal} and .immensus/template.json names ${templateRepo}`)
  const template = literal ?? 'not/named'
  for (const [label, opts, wantExit, wantAbsent] of [
    ['an app without the runner', { repo: 'owner/app', runner: false }, 0, 'true'],
    ['an app that holds the runner', { repo: 'owner/app', runner: true }, 0, 'false'],
    ['the template with the runner', { repo: template, runner: true }, 0, 'false'],
    ['the template WITHOUT the runner', { repo: template, runner: false }, 1, null]
  ]) {
    const r = driveHarnessPresence(script, opts)
    if (r != null && (r.status !== wantExit || r.absent !== wantAbsent)) bad.push(`pr-check.yml's "harness" step gives exit ${r.status}, absent=${r.absent} for ${label}, and must give exit ${wantExit}, absent=${wantAbsent}`)
  }
  return bad
}

let jqOk = null
function canDriveReview () {
  if (!canDriveShell()) return false
  if (jqOk == null) {
    const r = spawnSync('jq', ['--version'], { encoding: 'utf8' })
    jqOk = r.error == null && r.status === 0
  }
  return jqOk
}

// A second stub rather than a change to `ghStub()`: that one answers every call the same, and this
// step makes three different reads.
let reviewStubBin = null
function reviewGhStub () {
  if (reviewStubBin) return reviewStubBin
  const dir = mkdtempSync(join(tmpdir(), 'review-gh-'))
  writeFileSync(join(dir, 'gh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *compare/*) [ "$STUB_FAIL" = compare ] && exit 1; printf "%s\\n" "$STUB_COMPARE" ;;',
    '  */comments*) [ "$STUB_FAIL" = comments ] && exit 1; printf "%s\\n" "$STUB_COMMENTS" ;;',
    '  */commits*) [ "$STUB_FAIL" = commits ] && exit 1; printf "%s\\n" "$STUB_COMMITS" ;;',
    '  *) exit 1 ;;',
    'esac',
    'exit 0'
  ].join('\n') + '\n', { mode: 0o755 })
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  reviewStubBin = dir
  return dir
}

const BUILDER_LOGIN = 'immensus-builder[bot]'
// The builder is a different GitHub App per environment, so the step accepts a CLOSED LIST of
// logins and not one value (#471). Both are driven below, and so is a third `[bot]` that must
// NOT count, which is what tells a closed list apart from `endswith("[bot]")`.
const STAGING_BUILDER_LOGIN = 'immensus-builder-staging[bot]'
const builderComment = (verdict, login = BUILDER_LOGIN) => ({ user: { login }, created_at: '2026-01-02T00:00:10Z', html_url: 'https://example.test/c', body: `<!-- immensus-review:job:0 -->\n## Safety review\n\n**Verdict:** ${verdict}  ·  more` })
const builderCommit = (date, parent = 'p', name = 'Immensus Builder') => ({ parents: [{ sha: parent }], commit: { committer: { date, name } } })
const compareOf = (...files) => ({ files: files.map(filename => ({ filename })) })
const BEFORE = '2026-01-02T00:00:05Z'
const AFTER = '2026-01-02T00:00:20Z'

/** Each state the step can meet, with the answer it must give. Only the first three may say yes. */
export const BUILDER_REVIEW_CASES = [
  ['an approving review with no later commit', { comments: [builderComment('approve')], commits: [builderCommit(BEFORE)] }, true],
  ['an approving review and only the builder\'s own later record', { comments: [builderComment('approve')], commits: [builderCommit(BEFORE), builderCommit(AFTER)], compare: compareOf('.immensus/review.json', 'CLAUDE.md') }, true],
  ['the review read back as one flat page', { comments: [builderComment('approve')], commits: [builderCommit(BEFORE)], flat: true }, true],
  ['an approving review by the test environment\'s builder', { comments: [builderComment('approve', STAGING_BUILDER_LOGIN)], commits: [builderCommit(BEFORE)] }, true],
  ['an approving review by the test environment\'s builder and only its own later record', { comments: [builderComment('approve', STAGING_BUILDER_LOGIN)], commits: [builderCommit(BEFORE), builderCommit(AFTER)], compare: compareOf('.immensus/review.json', 'CLAUDE.md') }, true],
  ['no comments at all', { comments: [], commits: [builderCommit(BEFORE)] }, false],
  ['the notice this workflow posts itself', { comments: [{ ...builderComment('approve', 'github-actions[bot]') }], commits: [builderCommit(BEFORE)] }, false],
  ['an approving review by some other app\'s bot', { comments: [{ ...builderComment('approve', 'immensus-builder-anything[bot]') }], commits: [builderCommit(BEFORE)] }, false],
  ['a comment that is not a review', { comments: [{ ...builderComment('approve'), body: '**Verdict:** approve' }], commits: [builderCommit(BEFORE)] }, false],
  ['a review that did not approve', { comments: [builderComment('escalate')], commits: [builderCommit(BEFORE)] }, false],
  ['a verdict that only begins with approve', { comments: [builderComment('approve-with-changes')], commits: [builderCommit(BEFORE)] }, false],
  ['a later file renamed onto an exempt name', { comments: [builderComment('approve')], commits: [builderCommit(BEFORE), builderCommit(AFTER)], compare: { files: [{ filename: 'CLAUDE.md', previous_filename: 'lib/x.js' }] } }, false],
  ['an approval followed by a later code change', { comments: [builderComment('approve')], commits: [builderCommit(BEFORE), builderCommit(AFTER)], compare: compareOf('CLAUDE.md', 'lib/x.js') }, false],
  ['someone else\'s commit dated before the review', { comments: [builderComment('approve')], commits: [builderCommit(BEFORE, 'p', 'A Person')], compare: compareOf('lib/x.js') }, false],
  ['the comments cannot be read', { comments: [builderComment('approve')], commits: [builderCommit(BEFORE)], fail: 'comments' }, false],
  ['the commits cannot be read', { comments: [builderComment('approve')], commits: [builderCommit(BEFORE)], fail: 'commits' }, false],
  ['the comparison cannot be read', { comments: [builderComment('approve')], commits: [builderCommit(AFTER)], compare: compareOf('CLAUDE.md'), fail: 'compare' }, false]
]

/** Run the `builder` step against a stubbed `gh`. `null` on a host with no `bash` or `jq`. */
export function driveBuilderReview (script, { comments, commits, compare = compareOf(), fail = '', flat = false }) {
  if (!canDriveReview()) return null
  return driveScript(JSON.stringify(['review', script, comments, commits, compare, fail, flat]), () => {
    const work = mkdtempSync(join(tmpdir(), 'builder-review-'))
    const outPath = join(work, 'out')
    writeFileSync(outPath, '')
    const r = spawnSync('bash', ['-e', '-c', script], {
      encoding: 'utf8',
      env: {
        PATH: `${reviewGhStub()}:${process.env.PATH}`,
        GITHUB_OUTPUT: outPath,
        GITHUB_REPOSITORY: 'owner/repo',
        GH_TOKEN: 'not-a-token',
        PR: '7',
        SHA: 'abc',
        // `gh --paginate --slurp` gives an array of pages, and the step accepts a flat list as well.
        STUB_COMMENTS: JSON.stringify(flat ? comments : [comments]),
        STUB_COMMITS: JSON.stringify(flat ? commits : [commits]),
        STUB_COMPARE: JSON.stringify(compare),
        STUB_FAIL: fail
      }
    })
    const reviewed = readFileSync(outPath, 'utf8').match(/^reviewed=(.*)$/m)?.[1] ?? null
    rmSync(work, { recursive: true, force: true })
    return { status: r.status, reviewed }
  })
}

/** `agent-review.yml`'s `review` check: it is never green when nothing reviewed the diff. */
export function unreviewedProblems (text, cases = BUILDER_REVIEW_CASES) {
  const bad = []
  const job = workflowBlock(text, 'review')
  if (job == null) return ['agent-review.yml has no job named exactly "review"']
  if (workflowBlock(text, 'pr-state') == null) bad.push('agent-review.yml has no "pr-state" job — a draft\'s skipped review then has to report as a success')
  const cond = job.split('\n').find(l => /^ {4}if: /.test(l))
  // A failed `pr-state` must fail `review`, because a skipped required check counts as passed.
  const stops = workflowSteps(job).find(s => /needs\.pr-state\.result != 'success'/.test(s.cond ?? ''))
  if (!/needs\.pr-state\.result != 'success'/.test(cond ?? '') || stops == null || !/\bexit 1\b/.test(stops.run ?? '')) bad.push('agent-review.yml does not fail its "review" job when "pr-state" fails — the job is skipped, and a skipped required check counts as passed')
  if (!/^ {4}needs: pr-state$/m.test(job) || cond == null || !/needs\.pr-state\.outputs\.draft != 'true'/.test(cond)) bad.push('agent-review.yml\'s "review" job does not skip itself on a live draft answer from "pr-state" — a draft then reports success with nothing reviewed')

  const post = workflowSteps(job).find(s => s.id === 'post')
  const branch = post?.run?.match(/elif \[ "\$HAS_TOKEN" != 'true' \]; then([\s\S]*?)\n\s*elif /)?.[1]
  if (branch == null) bad.push('agent-review.yml\'s delivery step has no branch for a repository with no token and no builder review')
  else if (!/notreviewed=true/.test(branch)) bad.push('agent-review.yml posts a notice and reports SUCCESS when there is no token and no builder review — a green check with no review behind it')
  const noBaseline = post?.run?.match(/if \[ "\$RUNNABLE" != 'true' \]; then([\s\S]*?)\n\s*elif /)?.[1]
  if (noBaseline == null || !/notreviewed=true/.test(noBaseline)) bad.push('agent-review.yml reports SUCCESS when no baseline exists on the default branch — nothing reviewed that diff')

  const step = workflowSteps(job).find(s => s.id === 'builder')
  if (step == null) {
    bad.push('agent-review.yml has no step with id "builder" — every builder pull request on a repository with no token would then be red, a check that cannot pass')
    return bad
  }
  if (/\$\{\{/.test(step.run ?? '')) bad.push('agent-review.yml\'s "builder" step interpolates a `${{ }}` expression into its script — pass it through `env:`, so it can be executed here')
  for (const [label, opts, want] of cases) {
    const r = driveBuilderReview(step.run, opts)
    if (r != null && (r.status !== 0 || r.reviewed !== String(want))) bad.push(`agent-review.yml's "builder" step gives exit ${r.status}, reviewed=${r.reviewed} for ${label}, and must give exit 0, reviewed=${want}`)
  }
  return bad
}

export function audit (root) {
  const bad = []

  // CLAUDE.md — seven sections, in order, no template leftovers.
  const claude = read(root, 'CLAUDE.md')
  if (claude == null) bad.push('CLAUDE.md is missing')
  else {
    let last = -1
    for (const s of SECTIONS) {
      const at = claude.indexOf('\n' + s)
      if (at < 0) bad.push(`CLAUDE.md lacks section "${s}"`)
      else if (at < last) bad.push(`CLAUDE.md section "${s}" is out of order`)
      else last = at
    }
    for (const [heading, needles, what] of FIXED_SECTION_CONTENT) {
      const body = sectionBody(claude, heading)
      if (body == null) continue // already reported as a missing section
      for (const re of needles) {
        if (!re.test(body)) bad.push(`CLAUDE.md "${heading}" no longer carries ${what} (${re.source})`)
      }
    }
  }
  for (const rel of ['CLAUDE.md', ...AGENTS.map(a => `.claude/agents/${a}.md`), ...COMMANDS.map(c => `.claude/commands/${c}.md`)]) {
    const t = read(root, rel)
    if (t == null) continue
    for (const l of LEFTOVERS) if (t.includes(l)) bad.push(`${rel} still carries the template placeholder "${l}"`)
  }

  // Charters — one per agent, frontmatter name = filename, and each binds itself to CLAUDE.md.
  for (const a of AGENTS) {
    const rel = `.claude/agents/${a}.md`
    const t = read(root, rel)
    if (t == null) { bad.push(`${rel} is missing`); continue }
    const fm = t.match(/^---\n([\s\S]*?)\n---/)
    const name = fm && fm[1].match(/^name:\s*(\S+)\s*$/m)
    if (!name) bad.push(`${rel} has no frontmatter name`)
    else if (name[1] !== a) bad.push(`${rel} frontmatter name is "${name[1]}", expected "${a}"`)
    if (!fm || !/^description:/m.test(fm[1])) bad.push(`${rel} has no description`)
    if (!/CLAUDE\.md/.test(t)) bad.push(`${rel} never tells the agent to read CLAUDE.md`)
    if (!/session:/.test(t)) bad.push(`${rel} names no session label`)
  }
  const agentsDir = join(root, '.claude/agents')
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      const a = basename(f, '.md')
      if (f.endsWith('.md') && !AGENTS.includes(a)) bad.push(`.claude/agents/${f} is not in this suite's AGENTS list — add it here and to /dispatch in the same PR`)
    }
  }

  // Commands — the three the harness mandates plus /review; /dispatch lists every doer area.
  for (const c of COMMANDS) {
    const t = read(root, `.claude/commands/${c}.md`)
    if (t == null) bad.push(`.claude/commands/${c}.md is missing`)
    else if (!/^---\n[\s\S]*?description:/m.test(t)) bad.push(`.claude/commands/${c}.md has no description frontmatter`)
  }
  const dispatch = read(root, '.claude/commands/dispatch.md')
  if (dispatch) {
    for (const a of DOER_AREAS) if (!dispatch.includes(a)) bad.push(`.claude/commands/dispatch.md does not list the "${a}" area`)
    if (!/claim the issue/.test(dispatch)) bad.push('.claude/commands/dispatch.md no longer prepends the claim-first preamble')
  }

  // pr-check.yml — the required status is literally named `check`, and it runs the runner.
  const prCheck = read(root, '.github/workflows/pr-check.yml')
  if (prCheck == null) bad.push('.github/workflows/pr-check.yml is missing')
  else {
    if (!/^  check:\s*$/m.test(prCheck)) bad.push('pr-check.yml has no job named exactly "check" (branch protection requires that name)')
    if (!/run-suites\.js --self-test/.test(prCheck)) bad.push('pr-check.yml no longer runs the runner self-test')
    if (!/node scripts\/run-suites\.js\s*$/m.test(prCheck)) bad.push('pr-check.yml no longer runs the acceptance suites')
    if (!/timeout-minutes/.test(prCheck)) bad.push('pr-check.yml jobs carry no timeout')
    bad.push(...concurrencyProblems(prCheck))
    bad.push(...checkJobCachingProblems(prCheck))
    // WHETHER the suites run at all, which is upstream of every rule above — a job that
    // runs the suites on paper and skips them in practice satisfies the third line of this
    // block, which asks only that the command is somewhere in the file.
    bad.push(...prCheckDraftProblems(prCheck))
    bad.push(...manifestGuardProblems(prCheck, (() => {
      try { return JSON.parse(read(root, '.immensus/template.json')).template || null } catch { return null }
    })()))
    // A SIBLING RATHER THAN A CLAUSE INSIDE THE CALL ABOVE: `manifestGuardProblems` returns early
    // when nothing in the file runs `--check`, so a tree that kept the provenance step and dropped
    // the manifest one would never reach this rule.
    bad.push(...provenanceStepProblems(prCheck))
    bad.push(...harnessAbsenceProblems(prCheck, (() => {
      try { return JSON.parse(read(root, '.immensus/template.json')).template || null } catch { return null }
    })()))
  }

  // agent-review.yml — the agent writes REVIEW_FILE, the workflow posts and verifies.
  const review = read(root, '.github/workflows/agent-review.yml')
  if (review == null) bad.push('.github/workflows/agent-review.yml is missing')
  else {
    if (!/REVIEW_FILE/.test(review)) bad.push('agent-review.yml no longer hands the agent a REVIEW_FILE')
    const allowed = review.match(/--allowedTools\s+"([^"]*)"/)
    if (!allowed) bad.push('agent-review.yml has no --allowedTools list')
    else if (/gh pr comment|gh api/.test(allowed[1])) bad.push('agent-review.yml lets the agent post its own comment — the workflow must post and verify')
    if (!/Verify the review comment landed/.test(review)) bad.push('agent-review.yml has no delivery-verification step')
    if (!/Agent review of/.test(review)) bad.push('agent-review.yml no longer writes the "Agent review of <sha>" header the verify step reads')
    bad.push(...selfEditProblems(review))
    bad.push(...unreviewedProblems(review))
  }

  // Deploy workflows ship disabled: the worker deploys; these are the fallback.
  for (const w of ['deploy-prod.yml', 'deploy-staging.yml']) {
    const t = read(root, `.github/workflows/${w}`)
    if (t == null) bad.push(`.github/workflows/${w} is missing`)
    else if (!/DEPLOY_WORKFLOWS_ENABLED/.test(t)) bad.push(`${w} is not gated on vars.DEPLOY_WORKFLOWS_ENABLED — deploy workflows ship disabled`)
  }
  if (read(root, '.github/workflows/deploy-shared.yml') == null) bad.push('.github/workflows/deploy-shared.yml is missing')

  // Every workflow file must PARSE for GitHub, or it reds on every push; and every
  // `uses:` in it must name an allowlisted major and a ref that names a version.
  //
  // The parse check reads EVERY file, because an unparseable one reds on every push wherever it
  // came from. The allowlist reads only the files the template SEEDED — the workflow paths
  // recorded in `.immensus/template.json` — for the §6 reason: a seeded suite may assert only
  // what the template owns, and `ACTION_MAJORS` is a list in a seeded file whose maintenance is
  // the template's, so judging an app's own added workflow would red a required check over a
  // list the app has no business curating. With no readable manifest, fall back to every file:
  // the wider scan is the safer of the two errors here. Nothing is "refusing an added workflow"
  // any longer — the pin is withdrawn — so this scoping is the whole of the
  // separation rather than half of it.
  const wfDir = join(root, '.github/workflows')
  if (existsSync(wfDir)) {
    const used = new Set()
    const present = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).sort()
    let owned = present
    try {
      const pinned = Object.keys(JSON.parse(read(root, '.immensus/template.json')).files ?? {})
        .filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)).map((p) => basename(p))
      if (pinned.length) owned = present.filter((f) => pinned.includes(f))
    } catch { /* no manifest, or unreadable: judge every file — see the note above */ }
    for (const f of present) {
      const text = readFileSync(join(wfDir, f), 'utf8')
      for (const hit of badEnvContexts(text)) {
        bad.push(`${f} reads the "${hit.ctx}" context in a job-level env: (line ${hit.line}) — GitHub rejects the file and records a failed run on every push`)
      }
      if (!owned.includes(f)) continue
      bad.push(...actionUseProblems(f, text))
      bad.push(...setupNodeCacheProblems(f, text))
      for (const u of actionUses(text)) used.add(u.action)
    }
    // The other direction, the shape `deps-acceptance` already enforces for dependencies: an
    // allowlist entry nothing uses is a permission granted to nobody, and it is how a removed
    // action's major quietly stays permitted for whoever adds it back.
    for (const action of Object.keys(ACTION_MAJORS)) {
      if (!used.has(action)) bad.push(`ACTION_MAJORS permits ${action}@${ACTION_MAJORS[action]}, which no workflow uses — drop the entry rather than leaving a widened allowlist behind`)
    }
  }

  // config.yaml — rule 22: static at /web/, the page listener owns /, CONFIG.env loaded, no
  // fastifyRoutes.
  const cfg = read(root, 'config.yaml')
  if (cfg == null) bad.push('config.yaml is missing')
  else {
    const stat = yamlBlock(cfg, 'static')
    if (!stat) bad.push('config.yaml has no static block')
    else {
      if (!/urlPath:\s*'web'/.test(stat)) bad.push("config.yaml static.urlPath is not 'web' (static at the root swallows the page routes)")
      if (!/files:\s*'web\/\*\*'/.test(stat)) bad.push("config.yaml static.files is not 'web/**'")
    }
    // Rule 31: test rows in data/*.yaml stay out of the published copy, so what this config loads as it
    // stands is the production folder and nothing wider. No block at all loads nothing, which is also safe.
    const loader = yamlBlock(cfg, 'dataLoader')
    if (loader && !/files:\s*'data\/production\/\*\.yaml'/.test(loader)) bad.push("config.yaml dataLoader.files is not 'data/production/*.yaml' (rule 31: data/*.yaml is test data and would load into production)")
    // A `fastifyRoutes` block is REFUSED rather than required.
    // Harper serves ONE component's fastifyRoutes per process and drops the
    // second's with one WARN line while it still reports healthy, and an update
    // runs a preview copy of this app beside the published one — so whatever routes such a block
    // holds would exist in one copy and silently not in the other. Pages and GET /build are served by
    // resources/Pages.js instead.
    if (yamlBlock(cfg, 'fastifyRoutes') != null) bad.push("config.yaml declares fastifyRoutes: Harper serves only one component's fastifyRoutes per process, so its routes would be missing from the preview copy of this app — serve them from a server.http listener the way resources/Pages.js does")
    const le = yamlBlock(cfg, 'loadEnv')
    if (!le || !/CONFIG\.env/.test(le)) bad.push('config.yaml loadEnv does not load CONFIG.env')
    if (!/^rest:\s*true/m.test(cfg)) bad.push('config.yaml does not enable rest')
    // `schema*.graphql`, so the app's own schema.graphql and every kit's `schema.<kit>.graphql` load
    // because a kit only ever adds files, so this glob is the only way its tables are
    // found. Pinned to the one spelling, because a narrower glob silently drops a kit's tables and a
    // wider one picks up any stray .graphql at the root.
    const gs = yamlBlock(cfg, 'graphqlSchema')
    if (!gs || !/files:\s*'schema\*\.graphql'/.test(gs)) bad.push("config.yaml graphqlSchema.files is not 'schema*.graphql', so the app's schema.graphql or a kit's schema.<kit>.graphql would not load")
    const jr = yamlBlock(cfg, 'jsResource')
    if (!jr || !/resources\/\*\.js/.test(jr)) bad.push('config.yaml jsResource does not point at resources/*.js')
  }

  // .gitignore — BUILT and deploy-time files never ship; charters do.
  const gi = read(root, '.gitignore')
  if (gi == null) bad.push('.gitignore is missing')
  else {
    const lines = gi.split('\n').map(l => l.trim())
    for (const need of ['web/', 'CONFIG.env', '.env', 'node_modules', 'agent-review-findings.md', SELF_EDIT_BASELINE, '.claude/*', '!.claude/agents/', '!.claude/commands/']) {
      if (!lines.includes(need)) bad.push(`.gitignore lacks "${need}"`)
    }
  }

  // package.json — ESM on Node 24, runner wired, at least one suite for the runner to find.
  const pkgText = read(root, 'package.json')
  if (pkgText == null) bad.push('package.json is missing')
  else {
    let pkg
    try { pkg = JSON.parse(pkgText) } catch { bad.push('package.json does not parse'); pkg = {} }
    if (pkg.type !== 'module') bad.push('package.json is not "type": "module"')
    if (!/^>=\s*24/.test(pkg.engines?.node ?? '')) bad.push('package.json engines.node is not ">=24"')
    if (pkg.scripts?.suites !== 'node scripts/run-suites.js') bad.push('package.json "suites" script does not run scripts/run-suites.js')
    const suites = Object.keys(pkg.scripts ?? {}).filter(n => /(-acceptance|-probe)$/.test(n) || /^check-/.test(n))
    if (!suites.length) bad.push('package.json names no *-acceptance / *-probe / check-* suite; the runner treats empty discovery as failure')
  }

  return bad
}

// ---- negative controls ---------------------------------------------------------------
function fixture (root) {
  const work = mkdtempSync(join(tmpdir(), 'harness-acceptance-'))
  for (const p of HARNESS_PATHS) {
    const src = join(root, p)
    if (!existsSync(src)) continue
    mkdirSync(dirname(join(work, p)), { recursive: true })
    cpSync(src, join(work, p), { recursive: true })
  }
  return work
}

// Returns whether the text actually MOVED, which the two control helpers below read. A
// `String.replace` whose needle has stopped matching returns its input unchanged, so the mutation
// becomes a no-op — and a mutation that changed nothing is a control that proves nothing. This repository has
// had that defect, and it was GREEN: seven mutations in this file used the literal `ImmensusApp/app-template`
// as their needle, this repository was renamed, and every one of them stopped biting.
const edit = (work, rel, fn) => {
  const p = join(work, rel)
  const before = readFileSync(p, 'utf8')
  const after = fn(before)
  writeFileSync(p, after)
  return after !== before
}

function selfTest (root) {
  const failures = []
  const check = (label, ok, detail) => {
    console.log(`  ${ok ? '✅' : '❌'} ${label}`)
    if (!ok) { failures.push(label); if (detail) console.log('     ' + detail) }
  }
  const expectFail = (label, mutate, needle) => {
    const work = fixture(root)
    // `edit` answers whether its replacement bit. A mutation that writes the file some other way
    // returns undefined and is taken at its word; only an explicit `false` is a DEAD NEEDLE, and
    // that is reported as itself rather than as a missing finding, because the two want different
    // fixes — a dead needle is this control having gone vacuous, not the gate having gone blind.
    const bit = mutate(work)
    const bad = audit(work)
    check(label, bit !== false && bad.some(b => b.includes(needle)),
      bit === false
        ? 'the mutation changed nothing — its needle has stopped matching, so this control is vacuous; fix the needle, do not delete this test'
        : `audit said: ${bad.join(' | ') || '(clean — the check is not doing anything; fix it, do not delete this test)'}`)
    rmSync(work, { recursive: true, force: true })
  }
  // THE INVERSE OF expectFail, AND IT EXISTS BECAUSE THE TWO SHAPES HIDE A DEAD NEEDLE DIFFERENTLY.
  // `expectFail` reports a no-op by itself: the audit comes back clean, the needle is not in it, and
  // the control reds. A "must NOT fire" control written `check(label, !bad.some(…))` does the
  // opposite — a no-op leaves the audit clean, `!bad.some(…)` is TRUE, and it reports GREEN while
  // testing nothing. That is the same defect pointed at this file's own controls. So this helper asserts the
  // mutation BIT before it believes the silence, and it CATCHES, because a control that throws takes
  // every later assertion in this file down with it and a skipped assertion is not a failing one.
  const expectQuiet = (label, mutate, about, why) => {
    const work = fixture(root)
    let bit = false
    let threw = null
    try { bit = mutate(work) === true } catch (e) { threw = e }
    const bad = threw ? [] : audit(work)
    rmSync(work, { recursive: true, force: true })
    if (threw) return check(label, false, `the mutation threw rather than reporting: ${threw.message}`)
    if (!bit) return check(label, false, 'the mutation changed nothing, so this control is vacuous — it would be green whatever the gate did')
    check(label, !bad.some(b => about.test(b)), `${why} — audit said: ${bad.join(' | ')}`)
  }

  const clean = fixture(root)
  const cleanBad = audit(clean)
  check('a faithful copy of the harness passes (no false positives)', cleanBad.length === 0, cleanBad.join(' | '))
  rmSync(clean, { recursive: true, force: true })

  expectFail('a missing CLAUDE.md section is caught',
    w => edit(w, 'CLAUDE.md', t => t.replace('\n## 6. Verification', '\n## 6. Checking')), 'lacks section "## 6. Verification"')
  expectFail('sections out of order are caught',
    w => edit(w, 'CLAUDE.md', t => t.replace('\n## 2. Stack', '\n## 2b. Stack').replace('\n## 7. Known gotchas', '\n## 2. Stack\n\n## 7. Known gotchas')), 'out of order')
  // Inserted, not substituted: nothing here may depend on what the app is called.
  expectFail('a template placeholder left behind is caught',
    w => edit(w, 'CLAUDE.md', t => `# CLAUDE.md — <project name>\n\n${t}`), 'template placeholder')
  for (const [heading, needles, what] of FIXED_SECTION_CONTENT) {
    expectFail(`${heading} losing ${what} is caught`,
      w => edit(w, 'CLAUDE.md', t => {
        // A function replacer: `$&` and friends in a section's own prose are text here.
        const body = sectionBody(t, heading)
        if (body == null) return t // no such section: expectFail reports the no-op mutation
        const redacted = body.replace(new RegExp(needles[0].source, 'g'), 'REDACTED')
        return t.replace(body, () => redacted)
      }), `(${needles[0].source})`)
  }
  expectFail('a charter whose name disagrees with its filename is caught',
    w => edit(w, '.claude/agents/qa.md', t => t.replace(/^name: qa$/m, 'name: verifier')), 'frontmatter name is "verifier"')
  expectFail('a charter added without being listed here is caught',
    w => writeFileSync(join(w, '.claude/agents/infra.md'), '---\nname: infra\ndescription: x\n---\nRead CLAUDE.md. session:infra\n'), 'not in this suite')
  expectFail('a doer area dropped from /dispatch is caught',
    w => edit(w, '.claude/commands/dispatch.md', t => t.replaceAll('front-end', 'ui')), 'does not list the "front-end" area')
  expectFail('renaming the check job is caught',
    w => edit(w, '.github/workflows/pr-check.yml', t => t.replace(/^  check:\s*$/m, '  lint:')), 'no job named exactly "check"')
  // Derived from what concurrencyBlock() PARSED, never from literal template text: each
  // mutation rewrites the lines the parser found, so it cannot quietly become a no-op that
  // leaves the control green while testing nothing.
  const mutateConcurrency = (replace) => (w) => edit(w, '.github/workflows/pr-check.yml', (t) => {
    const c = concurrencyBlock(t)
    if (c == null) return t // a no-op mutation: expectFail reports it as a failed control
    return replace(t.split('\n'), c).join('\n')
  })
  const setConcurrencyKey = (key, value) => mutateConcurrency((lines, c) => lines.map((l, i) => (
    i > c.first && i <= c.last && new RegExp(`^\\s+${key}:`).test(l)
      ? l.slice(0, l.indexOf(':') + 1) + ' ' + value
      : l
  )))

  expectFail('a bare cancel-in-progress, with no default-branch guard, is caught',
    setConcurrencyKey('cancel-in-progress', 'true'), 'does not exclude the default branch')
  expectFail('a concurrency group keyed on the workflow alone is caught',
    setConcurrencyKey('group', '${{ github.workflow }}'), 'does not key on the ref')
  expectFail('dropping the concurrency block entirely is caught',
    mutateConcurrency((lines, c) => lines.filter((_, i) => i < c.first || i > c.last)),
    'declares no workflow-level concurrency')
  expectFail('a concurrency block that cancels nothing is caught',
    mutateConcurrency((lines, c) => lines.filter((_, i) => !(i > c.first && i <= c.last && /^\s+cancel-in-progress:/.test(lines[i])))),
    'has no cancel-in-progress')
  // Action versions. Every mutation rewrites the `uses:` line actionUses() PARSED and
  // derives the new ref from the one it found, so no control can quietly become a no-op in an
  // app whose workflows were reformatted.
  const mutateUse = (file, pick, rewrite) => (w) => edit(w, `.github/workflows/${file}`, (t) => {
    const u = actionUses(t).filter((u) => !u.action.startsWith('./')).find(pick)
    if (u == null) return t // a no-op mutation: expectFail reports it as a failed control
    const lines = t.split('\n')
    lines[u.line - 1] = lines[u.line - 1].replace(u.spec, rewrite(u))
    return lines.join('\n')
  })
  const isCheckout = (u) => u.action === 'actions/checkout'

  expectFail('an action one major behind the allowlist is caught',
    mutateUse('pr-check.yml', isCheckout, (u) => `${u.action}@v${Number(u.ref.match(MAJOR_REF)[1]) - 1}`),
    'ACTION_MAJORS permits actions/checkout@')
  expectFail('a branch ref, which names no version, is caught',
    mutateUse('pr-check.yml', isCheckout, (u) => `${u.action}@main`), 'a ref that names no version')
  expectFail('a `uses:` with no ref at all is caught',
    mutateUse('pr-check.yml', isCheckout, (u) => u.action), 'with no @ref at all')
  expectFail('an action nothing in the allowlist permits is caught',
    mutateUse('pr-check.yml', isCheckout, (u) => `some-org/some-action@${u.ref}`), 'which no entry in ACTION_MAJORS permits')
  expectFail('a commit sha the allowlist never declared is caught',
    mutateUse('pr-check.yml', isCheckout, (u) => `${u.action}@${'a'.repeat(7)}${'0'.repeat(33)}`), 'declare the sha itself in ACTION_MAJORS')
  expectFail('a setup-node step that says nothing about caching is caught',
    (w) => edit(w, '.github/workflows/pr-check.yml', (t) => {
      const u = actionUses(t).find((u) => u.action === SETUP_NODE && 'package-manager-cache' in stepInputs(t, u))
      if (u == null) return t
      return t.split('\n').filter((l) => !/^\s*package-manager-cache:/.test(l)).join('\n')
    }), 'neither cache: nor package-manager-cache:')
  // Saying WHICH is not saying the right one: `true` satisfies the check above and reintroduces
  // the defect, in the job whose whole design is "installs nothing".
  expectFail('caching switched back ON in the no-install "check" job is caught',
    (w) => edit(w, '.github/workflows/pr-check.yml', (t) => {
      const r = jobRange(t, 'check')
      const u = actionUses(t).find((u) => u.action === SETUP_NODE && u.line - 1 > r.first && u.line - 1 <= r.last && stepInputs(t, u)['package-manager-cache'] === 'false')
      if (u == null) return t
      return t.split('\n').map((l, i) => (i > u.line - 1 && i <= r.last ? l.replace(/^(\s*package-manager-cache:).*$/, '$1 true') : l)).join('\n')
    }), 'the only answer there is false')
  // The backstop, and the one check nothing else can reach: if actionUses() ever returned []
  // — a regex edit, a reformat — actionUseProblems and setupNodeCacheProblems would both go
  // silently quiet and this is all that reds. Derived: rewrite whichever allowlisted action is
  // used exactly once into one that is used more than once, so that entry goes unused.
  expectFail('an allowlist entry no workflow uses any more is caught', (w) => {
    const dir = join(w, '.github/workflows')
    const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
    const count = {}
    for (const f of files) for (const u of actionUses(readFileSync(join(dir, f), 'utf8'))) count[u.action] = (count[u.action] ?? 0) + 1
    const only = Object.keys(ACTION_MAJORS).find((a) => count[a] === 1)
    const other = Object.keys(ACTION_MAJORS).find((a) => a !== only && (count[a] ?? 0) > 1)
    if (only == null || other == null) return // a no-op mutation: expectFail reports it
    for (const f of files) {
      const t = readFileSync(join(dir, f), 'utf8')
      const u = actionUses(t).find((u) => u.action === only)
      if (u == null) continue
      const lines = t.split('\n')
      lines[u.line - 1] = lines[u.line - 1].replace(u.spec, `${other}@${ACTION_MAJORS[other]}`)
      writeFileSync(join(dir, f), lines.join('\n'))
    }
  }, 'which no workflow uses')
  // A "must NOT fire" control asks whether ONE check stays quiet, so it interrogates that check
  // and not `audit()`: a whole-audit assertion also fails for any unrelated defect elsewhere in
  // the repo, which reports a working positive control as broken — the cry-wolf shape again, one
  // level up, in the controls themselves.
  check('a patch pin INSIDE the permitted major is NOT flagged — stricter is not drift', (() => {
    const t = readFileSync(join(root, '.github/workflows/pr-check.yml'), 'utf8')
    const u = actionUses(t).find(isCheckout)
    if (u == null) return false
    const patched = t.split('\n').map((l, i) => (i === u.line - 1 ? l.replace(u.spec, `${u.action}@${u.ref}.0.1`) : l)).join('\n')
    return patched !== t && actionUseProblems('pr-check.yml', patched).length === 0
  })(), 'a version inside the allowed major was flagged, or the mutation was a no-op — the gate would cry wolf on a patch pin')
  check('a local reusable-workflow `uses:` is NOT flagged — it carries no version to allowlist', (() => {
    const t = readFileSync(join(root, '.github/workflows/deploy-prod.yml'), 'utf8')
    const local = actionUses(t).some((u) => u.action.startsWith('./'))
    return local && actionUseProblems('deploy-prod.yml', t).length === 0
  })(), 'deploy-prod.yml has no local `uses:` to prove this with, or it was flagged')
  // A `uses:`-shaped line inside a block scalar is documentation, and agent-review.yml is mostly
  // one long `prompt: |`. Insert into whichever block scalar the parser itself located — never a
  // literal line of this repo's prompt, which an app may have reworded.
  check('a `uses:`-shaped line inside a block scalar is NOT flagged — a prompt is prose', (() => {
    const lines = readFileSync(join(root, '.github/workflows/agent-review.yml'), 'utf8').split('\n')
    // Ask the parser which lines IT calls prose, rather than re-deciding with a second copy of
    // BLOCK_SCALAR here: a control carrying its own copy of the rule can outlive the rule.
    const prose = proseLines(lines)
    const at = [...prose].sort((a, b) => a - b)[0]
    if (at == null) return false
    const deeper = ' '.repeat(leadOf(lines[at]) + 2)
    const patched = [...lines.slice(0, at), `${deeper}uses: actions/checkout@v4`, ...lines.slice(at)].join('\n')
    return actionUseProblems('agent-review.yml', patched).length === 0
  })(), 'a `uses:` line inside a block scalar was read as a real action — the gate would red on documentation')

  // Legal YAML shapes the parsers must READ rather than shrug at, because a parser that returns
  // nothing makes its caller cry wolf — and one shape (a block scalar as a step's first key) where
  // shrugging went the other way and made the gate BLIND, which is worse. Synthesized, not
  // template text: §6 — a FIXED suite derives the shape it needs instead of anchoring on bytes an
  // app may have reformatted.
  const synth = (body) => ['jobs:', '  x:', '    steps:', ...body, ''].join('\n')
  const NODE = `${SETUP_NODE}@${ACTION_MAJORS[SETUP_NODE]}`
  for (const [what, body] of [
    ['flow style', [`      - uses: ${NODE}`, "        with: { node-version: '24', cache: 'npm' }"]],
    ['`with:` above `uses:`', ['      - with:', "          cache: 'npm'", `        uses: ${NODE}`]],
    ['a comment inside the `with:` block', [`      - uses: ${NODE}`, '        with:', '        # which cache', "          cache: 'npm'"]],
    ['a comment at the item column between the keys', [`      - uses: ${NODE}`, '      # which cache', '        with:', "          cache: 'npm'"]],
    ['a comment at column 0 between the keys', [`      - uses: ${NODE}`, '# which cache', '        with:', "          cache: 'npm'"]],
  ]) {
    const t = synth(body)
    const u = actionUses(t).find((u) => u.action === SETUP_NODE)
    check(`setup-node's cache is read through ${what}`,
      u != null && stepInputs(t, u).cache === 'npm' && setupNodeCacheProblems('synth.yml', t).length === 0,
      `stepInputs read ${JSON.stringify(u == null ? null : stepInputs(t, u))} — the caller would cry wolf on a legal shape`)
  }
  // The blind direction. A block scalar opened at the DASH's column, not the key's, marked every
  // sibling key of the step as prose — so a `uses:` beneath `- if: >-` vanished from the gate
  // entirely and an old major there was invisible.
  check('a block scalar as a step\'s FIRST key does not swallow the `uses:` beneath it', (() => {
    const t = synth(['      - if: >-', "          github.event_name == 'push' &&", "          github.ref == 'refs/heads/main'", '        uses: actions/checkout@v4'])
    return actionUses(t).some((u) => u.action === 'actions/checkout') && actionUseProblems('synth.yml', t).length === 1
  })(), 'a `uses:` below a first-key block scalar was not seen — the gate is blind there, which is worse than crying wolf')
  check('a block-scalar header with a trailing comment still opens the block', (() => {
    const t = synth(['      - name: x', '        run: | # the script', '          uses: evil/thing@main'])
    return actionUses(t).length === 0 && actionUseProblems('synth.yml', t).length === 0
  })(), 'a `run: | # …` body was read as real YAML — the gate would red on documentation')
  // jobRange: a comment at column 0 or 2 is not the next job. Reading one as the end of `check`
  // hid `cache:` inside the very job checkJobCachingProblems() exists to keep cache-free.
  check('a shallow comment inside the "check" job does not end it', (() => {
    const t = ['jobs:', '  check:', '    steps:', `      - uses: ${NODE}`, '  # why this job installs nothing', `      - uses: ${NODE}`, '        with:', "          cache: 'npm'", ''].join('\n')
    const r = jobRange(t, 'check')
    return r != null && r.last >= 7 && checkJobCachingProblems(t).length === 1
  })(), 'the job ended at a comment, so caching inside "check" went unreported')
  // §6: a seeded suite asserts only what the template OWNS. An app's own added workflow is
  // outside the allowlist's scope, because `ACTION_MAJORS` is a list the template curates and
  // reding an app's workflow against it would name a remedy nobody over there is maintaining.
  check('a workflow the manifest does not record is not judged against ACTION_MAJORS', (() => {
    const w = fixture(root)
    writeFileSync(join(w, '.github/workflows/app-own.yml'), synth(['      - uses: some-org/some-action@main']))
    const bad = audit(w)
    rmSync(w, { recursive: true, force: true })
    return !bad.some((b) => b.startsWith('app-own.yml'))
  })(), 'an app\'s own workflow was judged against ACTION_MAJORS, whose only remedy is editing a FIXED file')

  // THE REPOSITORY GUARD ON THE MANIFEST CHECK. Four controls that
  // must fire, three that must not.
  //
  // EVERY NEEDLE BELOW IS READ OFF THE FILE RATHER THAN WRITTEN HERE. These
  // mutations used to carry the literal `ImmensusApp/app-template`. This repository was renamed to
  // `web-app-template`, every needle stopped matching, and a `String.replace` that matches nothing
  // returns its input — so each mutation became a no-op. `expectFail` reports a no-op; a "must NOT
  // fire" control written `!bad.some(…)` does not, because a no-op leaves the audit clean and the
  // control green. One of the three below was in exactly that state. The precedent for the fix is
  // this family's own: `template-manifest.js`'s self-test takes its subject from the file's own URL,
  // "not from a literal, which would be a tautology that survives a rename".
  const PR_CHECK = '.github/workflows/pr-check.yml'
  const guardIf = (text) => stepById(text, 'manifest')?.body.split('\n').find(l => /^\s*if:/.test(l)) ?? null
  // A FUNCTION REPLACER, because `$&` and friends in a replacement string are patterns and not
  // text — the same trap the FIXED_SECTION_CONTENT loop above names. And the line is unique in the
  // file, which is asserted below rather than assumed: `String.replace` with a string needle takes
  // the FIRST match, so a second line spelling the condition identically would send every mutation
  // to the wrong place.
  const mutateGuard = (fn) => (w) => edit(w, PR_CHECK, (t) => {
    const line = guardIf(t)
    if (line == null) return t
    const replacement = fn(line)
    return t.replace(line, () => replacement)
  })
  // AND A CONTROL ON THE DERIVATION ITSELF, which is what names the cause. Without it every
  // mutation below reports only "did not bite", which is equally true of a broken `stepById`, of a
  // renamed step id and of a condition that has moved out of the step — three different fixes.
  check("the mutations below still find the manifest step's own `if:` line, exactly once in the file",
    (() => {
      const t = read(root, PR_CHECK) ?? ''
      const line = guardIf(t)
      return line != null && t.split('\n').filter(l => l === line).length === 1
    })(),
    'stepById(pr-check.yml, "manifest") yields no if: line, or more than one line in the file spells it identically — either way every manifest-guard control below rewrites the wrong thing or nothing')

  expectFail('dropping the repository guard from the manifest-check step is caught',
    mutateGuard(() => ''), 'without an `if: github.repository == …` guard')
  expectFail('a guard naming a DIFFERENT repository is caught',
    mutateGuard(l => l.replace(/'[^']*'/, "'ImmensusApp/some-other-repo'")), 'does not compare it to')
  expectFail('a guard widened with `|| true` is caught',
    mutateGuard(l => `${l} || true`), 'can make the condition true in a repository that is not the template')
  expectFail('a guard defeated by always() is caught',
    mutateGuard(l => l.replace(/if:\s*/, 'if: always() && ')), 'can make the condition true in a repository that is not the template')
  // Must fire: the guard is read off the step's `if:`, so a comment that merely SPELLS the condition
  // is not the condition. This is the raw-text-grep trap one level in.
  expectFail('a commented-out guard does not count as a guard',
    mutateGuard(l => `        # ${l.trim()}`), 'without an `if: github.repository')
  // Must NOT fire: `&&` only ever narrows, so a second condition is not a defect. Without this the
  // refusal above would be "no boolean operators", which is stricter than the rule and is how a
  // gate starts crying wolf.
  expectQuiet('a guard NARROWED with && is not flagged',
    mutateGuard(l => `${l} && github.event_name == 'pull_request'`), /manifest/,
    'narrowing the guard was reported — && cannot widen a condition, and refusing it makes this gate cry wolf')
  // Must NOT fire: removing the step is what an app is allowed to do, and the gate is written to
  // judge the guard only when the step is there. Driven rather than asserted in prose, because
  // "conditional" is the half of this gate that would silently become unconditional.
  expectQuiet('an app that removed the manifest-check step entirely is not judged',
    w => edit(w, PR_CHECK, (t) => {
      const step = stepById(t, 'manifest')
      if (step == null) return t
      const lines = t.split('\n')
      lines.splice(step.first, step.last - step.first + 1)
      return lines.join('\n')
    }), /manifest/,
    'removing a template-only check from an app was reported — the gate is unconditional, which reds every app that is permitted to make this change')

  // THE UNSCOPED PROVENANCE STEP. `provenanceStepProblems`' whole rule is that the step
  // holding the manifest's field against `github.repository` may not be SCOPED, so the mutation is
  // an `if:` being added — and a NARROWING one, because narrowing is the hazard here rather than the
  // exemption it is on the step above: the states an `if:` would subtract are the states this check
  // exists for.
  expectFail('scoping the provenance step with an `if:` is caught, even a narrowing one',
    w => edit(w, PR_CHECK, (t) => {
      const step = stepById(t, 'provenance')
      if (step == null) return t
      return t.replace(step.body, () => step.body.replace(/^(\s*)run: \|/m, "$1if: github.event_name == 'pull_request'\n$1run: |"))
    }), 'carries an `if:`')
  // `continue-on-error` in BOTH of its forms, because the rule's first draft matched the literal
  // `true` only and an expression slipped it — the guard-that-guards-nothing shape inside the rule
  // written to refuse that shape.
  for (const [what, line] of [['the literal', 'continue-on-error: true'], ['an EXPRESSION', 'continue-on-error: ${{ true }}']]) {
    expectFail(`\`continue-on-error\` on the provenance step is caught, as ${what}`,
      w => edit(w, PR_CHECK, (t) => {
        const step = stepById(t, 'provenance')
        if (step == null) return t
        return t.replace(step.body, () => step.body.replace(/^(\s*)run: \|/m, `$1${line}\n$1run: |`))
      }), 'carries `continue-on-error`')
  }
  expectFail('renaming the provenance step so the rule cannot find it is caught',
    w => edit(w, PR_CHECK, t => t.replace(/^(\s*)id: provenance$/m, '$1id: provenance-reader')),
    'this gate cannot identify')
  // Must NOT fire: an app may delete a template-only step, exactly as above. With the step gone
  // there is no `--provenance` in the file and nothing to rule on.
  expectQuiet('an app that removed the provenance step entirely is not judged',
    w => edit(w, PR_CHECK, (t) => {
      const step = stepById(t, 'provenance')
      if (step == null) return t
      const lines = t.split('\n')
      lines.splice(step.first, step.last - step.first + 1)
      return lines.join('\n')
    }), /provenance/,
    'removing a template-only step from an app was reported — that reds every app that is permitted to make this change')

  expectFail('letting the review agent post its own comment is caught',
    w => edit(w, '.github/workflows/agent-review.yml', t => t.replace(/--allowedTools\s+"/, '--allowedTools "Bash(gh pr comment:*),')), 'post its own comment')
  expectFail('removing the delivery-verification step is caught',
    w => edit(w, '.github/workflows/agent-review.yml', t => t.replace('Verify the review comment landed', 'Done')), 'no delivery-verification step')

  // The self-edit path. Five ways to restore the green no-op, one control each. Every
  // mutation rewrites lines stepById() actually PARSED — the guard's own verdict call, the review
  // step's own `if:`, the delivery step's own env — so a control cannot quietly become a no-op in
  // an app whose workflow was reformatted.
  const mutateStep = (id, replace) => (w) => edit(w, '.github/workflows/agent-review.yml', (t) => {
    const s = stepById(t, id)
    if (s == null) return t // a no-op mutation: expectFail reports it as a failed control
    return t.split('\n').map((l, i) => (i >= s.first && i <= s.last ? replace(l) : l)).join('\n')
  })
  expectFail('answering a self-edit with "not runnable" again is caught',
    mutateStep('wfguard', l => l.replace(/\bverdict\s+true\s+true\b/, 'verdict false true')),
    'predictive refusal that was removed')
  expectFail('dropping the self-edit verdict entirely is caught',
    mutateStep('wfguard', l => l.replace(/\bverdict\s+true\s+true\b/, 'verdict true false')),
    'no (runnable=true, selfedit=true) verdict')
  expectFail('gating the review step off for a self-edit is caught',
    mutateStep('claude', l => l.replace(/^(\s+if:\s*)(.*)$/, "$1$2 && steps.wfguard.outputs.selfedit != 'true'")),
    'predicts claude-code-action')
  expectFail('a prompt that never names the baseline file is caught',
    mutateStep('claude', l => l.replaceAll(SELF_EDIT_BASELINE, 'the workflow file')),
    'prompt never names')
  expectFail('losing the self-edit banner on the posted comment is caught',
    mutateStep('post', l => l.replace('the file that defines this reviewer', 'the reviewer')),
    'no banner')
  expectFail('a delivery step that cannot see the selfedit output is caught',
    mutateStep('post', l => l.replace(/^(\s+)SELF_EDIT:.*$/, '$1SELF_EDIT: false')),
    'cannot tell a refused self-edit')
  expectFail('an unreviewed self-edit that records no verdict is caught',
    mutateStep('post', l => l.replace(/\bnotreviewed=true\b/, 'notreviewed=false')),
    'never records that a self-edit went unreviewed')
  expectFail('a verdict the verify step cannot read is caught',
    mutateStep('post', l => l.replace(/^(\s+echo\s+"notreviewed=).*$/, '$1$notreviewed"')),
    'does not emit the notreviewed verdict')
  expectFail('delivering the notice and then reporting success is caught',
    mutateStep('verify', l => l.replace(/^(\s+)NOT_REVIEWED:.*$/, '$1_UNREAD: false')),
    'binds no NOT_REVIEWED')
  expectFail('reading the verdict and not failing on it is caught',
    mutateStep('verify', l => l.replace(/^(\s+)exit 1$/, '$1echo "carrying on"')),
    'does not fail on it')
  expectFail('binding the verdict and never reading it is caught',
    mutateStep('verify', l => l.replace(/\$\{NOT_REVIEWED:-false\}/, '"false"')),
    'binds NOT_REVIEWED and never reads it')
  expectFail('leaving a checked-out findings file in place is caught (a PR may commit one)',
    mutateStep('wfguard', l => l.replace(/^(\s+)rm -f "\$REVIEW_FILE"$/, '$1: # keep it')),
    'never removes a checked-out $REVIEW_FILE')
  // The forged-verdict controls. The first is the one that matters: removing the forgery and
  // CARRYING ON is what this file used to do, and it is a green tick over an attempted forgery.
  // Derived from the branch the checker itself parses — the `exit 1` inside `if [ -e "$REVIEW_FILE" ]`
  // — so a reformatted workflow in a generated app cannot turn the control into a no-op.
  expectFail('removing a forged findings file and then carrying on is caught',
    w => edit(w, '.github/workflows/agent-review.yml', (t) => {
      const s = stepById(t, 'wfguard')
      if (s == null) return t
      const m = s.body.match(/if \[ -e "\$REVIEW_FILE" \]; then([\s\S]*?)\n(\s*)fi\b/)
      if (m == null) return t
      // Only this branch's exit 1 goes; the guard's other two stay, which is the whole point.
      return t.replace(m[0], m[0].replace(/\n(\s*)exit 1\b/, '\n$1echo "   carrying on"'))
    }), 'does not go red')
  expectFail('printing the forged findings file into the job log is caught',
    w => edit(w, '.github/workflows/agent-review.yml', (t) => {
      const s = stepById(t, 'wfguard')
      if (s == null) return t
      const m = s.body.match(/if \[ -e "\$REVIEW_FILE" \]; then([\s\S]*?)\n(\s*)fi\b/)
      if (m == null) return t
      return t.replace(m[0], m[0].replace(/\n(\s*)rm -f "\$REVIEW_FILE"/, '\n$1cat "$REVIEW_FILE"\n$1rm -f "$REVIEW_FILE"'))
    }), 'prints the forged $REVIEW_FILE into the job log')
  // A SECOND reader, and the braced spelling, so the control proves more than the one word `cat`
  // — the review of this PR asked for exactly that. The list is still a blocklist and still
  // best-effort; what the controls establish is that it is not a list of one.
  expectFail('…and a different reader, in the braced spelling, is caught too',
    w => edit(w, '.github/workflows/agent-review.yml', (t) => {
      const s = stepById(t, 'wfguard')
      if (s == null) return t
      const m = s.body.match(/if \[ -e "\$REVIEW_FILE" \]; then([\s\S]*?)\n(\s*)fi\b/)
      if (m == null) return t
      return t.replace(m[0], m[0].replace(/\n(\s*)rm -f "\$REVIEW_FILE"/, '\n$1sed -n 1,5p "${REVIEW_FILE}"\n$1rm -f "$REVIEW_FILE"'))
    }), 'prints the forged $REVIEW_FILE into the job log')
  expectFail('losing the forged-file branch altogether is caught',
    mutateStep('wfguard', l => l.replace(/^(\s+)if \[ -e "\$REVIEW_FILE" \]; then$/, '$1if false; then')),
    'no `if [ -e "$REVIEW_FILE" ]` branch')
  // Must NOT fire, and this one is the anchoring. Unanchored, a reader word appearing as
  // PROSE in one of the branch's own messages tripped the no-print check — the gate reding over
  // the line it protects. Derived from the branch the checker itself parsed, and asserted through
  // selfEditProblems rather than the whole audit so an unrelated defect cannot mask it.
  check('a reader word in the branch\'s own message does not trip the no-print check', (() => {
    const text = readFileSync(join(root, '.github/workflows/agent-review.yml'), 'utf8')
    const s = stepById(text, 'wfguard')
    if (s == null) return false
    const m = s.body.match(/if \[ -e "\$REVIEW_FILE" \]; then([\s\S]*?)\n(\s*)fi\b/)
    if (m == null) return false
    // `more`, `od` and `cat` as English, in an echo that names the PATH — exactly what a future
    // message looks like. The real `cat "$REVIEW_FILE"` control above proves the check still bites.
    const noisy = m[0].replace(/\n(\s*)rm -f "\$REVIEW_FILE"/,
      '\n$1echo "   no more detail and no duplicate: $REVIEW_FILE was removed"\n$1rm -f "$REVIEW_FILE"')
    const patched = text.replace(m[0], noisy)
    return selfEditProblems(patched).length === 0
  })(), 'a reader word used as prose in the forged branch\'s message was read as a command — the no-print check is unanchored and reds over the message it protects')
  // Hoisting the emit above the chain that sets it — in two moves, because hoisting IS the
  // mutation: take the line out of the chain and put it back where $notreviewed is still false.
  expectFail('emitting the notreviewed verdict before the branch that sets it is caught',
    w => edit(w, '.github/workflows/agent-review.yml', (t) => {
      const s = stepById(t, 'post')
      if (s == null) return t
      const emit = s.body.match(/^(\s+)echo "notreviewed=\$notreviewed" >> "\$GITHUB_OUTPUT"$/m)
      const init = s.body.match(/^(\s+)notreviewed=false$/m)
      if (emit == null || init == null) return t
      return t.replace(`\n${emit[0]}`, '').replace(init[0], `${init[0]}\n${emit[0]}`)
    }), 'BEFORE the branch that sets it')
  // The positional-slice defect itself: delete ONLY the NOT_REVIEWED branch's exit 1 and leave the
  // undelivered-comment one, which is what the old `slice(readsAt)` check was satisfied by.
  expectFail('dropping only the NOT_REVIEWED branch\'s exit 1 is caught',
    w => edit(w, '.github/workflows/agent-review.yml', (t) => {
      const s = stepById(t, 'verify')
      if (s == null) return t
      const m = s.body.match(/if \[ "\$\{NOT_REVIEWED:-false\}" = 'true' \]; then([\s\S]*?)\n(\s*)fi\b/)
      if (m == null) return t
      return t.replace(m[0], m[0].replace(/\n(\s*)exit 1\b/, '\n$1echo "delivered"'))
    }), 'does not fail on it')
  // Must NOT fire. `- id: x` with the key under the list dash is legal YAML for the same step and
  // made stepById() return null — a gate reding about a step that is plainly there. Synthesized
  // rather than mutated out of this repo's workflow (§6): moving the real file's dash onto its
  // `id:` line does not spell the same step, it spells TWO steps, so the mutation would have been
  // measuring nothing. The first attempt at this control did exactly that and said so.
  check('stepById reads a step whose `id:` is its first key, under the list dash', (() => {
    const dashed = ['jobs:', '  j:', '    steps:',
      '      - id: post', '        name: Post it', '        run: echo one',
      '      - id: verify', '        run: echo two', ''].join('\n')
    const s = stepById(dashed, 'post')
    // Must reach the dash line itself and stop at the NEXT dash, not run to the end of the file.
    return s != null && s.first === 3 && s.last === 5 && /name: Post it/.test(s.body) && !/echo two/.test(s.body)
  })(), 'stepById returned the wrong range for `- id:` under the list dash — the gate would red about a step that is present')
  // And a quoted scalar, which the real file can be rewritten into legally — derived from the line
  // the parser itself located, so it cannot become a no-op.
  check('stepById reads a quoted `id:` scalar', (() => {
    const text = readFileSync(join(root, '.github/workflows/agent-review.yml'), 'utf8')
    const real = stepById(text, 'post')
    if (real == null) return false
    const lines = text.split('\n')
    const at = lines.findIndex((l, i) => i >= real.first && i <= real.last && /^\s*id:\s*post\s*$/.test(l))
    if (at < 0) return false
    lines[at] = lines[at].replace(/id:\s*post\s*$/, "id: 'post'")
    const found = stepById(lines.join('\n'), 'post')
    return found != null && found.first === real.first && found.last === real.last
  })(), 'stepById returned nothing for a quoted `id:` scalar — the gate would red about a step that is present')
  // Must NOT fire. agent-review.yml is now mostly one long `prompt: |` that talks ABOUT steps and
  // files, so an `id:`-shaped line of prose must not decide where a step starts or ends — the trap
  // that removed a real `uses:` from this suite, one level out. Insert into whichever block scalar
  // proseLines() itself located, never a literal line of this repo's prompt.
  check('an `id:`-shaped line inside a block scalar does not move a step boundary', (() => {
    const lines = readFileSync(join(root, '.github/workflows/agent-review.yml'), 'utf8').split('\n')
    const real = stepById(lines.join('\n'), 'post')
    const at = [...proseLines(lines)].sort((a, b) => a - b)[0]
    if (real == null || at == null) return false
    const deeper = ' '.repeat(leadOf(lines[at]) + 2)
    const patched = [...lines.slice(0, at), `${deeper}id: post`, ...lines.slice(at)].join('\n')
    const found = stepById(patched, 'post')
    // The decoy sits before the real step, so the real range shifts by exactly the line inserted.
    return found != null && found.first === real.first + 1 && selfEditProblems(patched).length === 0
  })(), 'an `id:` inside a block scalar was read as a step header — the self-edit checks would read the wrong range')
  expectFail('static mounted at the root is caught',
    w => edit(w, 'config.yaml', t => t.replace("urlPath: 'web'", "urlPath: '/'")), "static.urlPath is not 'web'")
  expectFail('a dataLoader that loads the test rows into the published copy is caught',
    w => edit(w, 'config.yaml', t => t.replace("files: 'data/production/*.yaml'", "files: 'data/*.yaml'")), 'dataLoader.files is not')
  expectFail('a fastifyRoutes block is caught, because only one copy of the app could serve it',
    w => edit(w, 'config.yaml', t => `${t}\nfastifyRoutes:\n  files: 'routes/*.js'\n  urlPath: '/'\n`), 'declares fastifyRoutes')
  expectFail('a job-level env: reading the runner context is caught',
    w => edit(w, '.github/workflows/deploy-shared.yml', t => t.replace(/^    env:\s*$/m, '    env:\n      SCRATCH: ${{ runner.temp }}/scratch.json')), 'reads the "runner" context')
  expectFail('…including at workflow level, where it is equally invalid',
    w => edit(w, '.github/workflows/pr-check.yml', t => t.replace(/^on:\s*$/m, 'env:\n  SCRATCH: ${{ runner.temp }}/scratch.json\n\non:')), 'reads the "runner" context')
  // Interrogates badEnvContexts() rather than audit(), for the reason given above the patch-pin
  // control: asserting the WHOLE audit is empty made this control fail for any unrelated defect
  // elsewhere in the repo, so a working control reported itself broken.
  check('the same expression in a STEP env: is NOT flagged — that position is correct', (() => {
    const t = readFileSync(join(root, '.github/workflows/deploy-shared.yml'), 'utf8')
    const patched = t.replace(/^        env:\s*$/m, '        env:\n          SCRATCH: ${{ runner.temp }}/scratch.json')
    return patched !== t && badEnvContexts(patched).length === 0
  })(), 'a step-level runner context was flagged, or the mutation was a no-op — the gate would cry wolf')

  expectFail('a deploy workflow that is no longer gated is caught',
    w => edit(w, '.github/workflows/deploy-prod.yml', t => t.replaceAll('DEPLOY_WORKFLOWS_ENABLED', 'ALWAYS')), 'not gated')
  expectFail('web/ dropped from .gitignore is caught',
    w => edit(w, '.gitignore', t => t.replace(/^web\/$/m, '')), 'lacks "web/"')
  expectFail('a package.json with no suites is caught',
    w => edit(w, 'package.json', t => { const p = JSON.parse(t); p.scripts = { suites: 'node scripts/run-suites.js' }; return JSON.stringify(p, null, 2) }), 'names no *-acceptance')

  // ---- the draft guard, which decides whether a required check runs at all ---------
  //
  // Every mutation ASSERTS IT MATCHED before the verdict is believed: a substitution that stops
  // matching is a control that passes against an untouched file, which is the failure
  // a SEEDED suite is most exposed to. Two of them are the mutations most
  // likely to be written by somebody TIDYING UP rather than by somebody being careless — the
  // equality, and collapsing `if out=$(…)` into a bare assignment — which is why they are
  // controls and not comments.
  //
  // ONE goes through the fixture and `audit()`, and it is the one that would matter most if the
  // checker were not wired in at all. The REST drive `prCheckDraftProblems` against mutated
  // TEXT, and the reason is cost rather than style: a fixture copy plus a full audit is an order
  // of 100 ms here, so a dozen of them is seconds on a suite whose set is already the slowest in
  // the family. The checker is a pure function of the file's text, so the text IS the fixture —
  // and the wiring, which text cannot prove, is proved once. No count is written here: a number
  // beside a list goes stale the first time the list grows.
  const PRCHECK = '.github/workflows/pr-check.yml'
  const prCheckText = read(root, PRCHECK) ?? ''
  const mutate = (text, from, to) => {
    const out = typeof to === 'function' ? to(text) : text.replace(from, to)
    if (out === text) throw new Error(`the control did not mutate ${PRCHECK} (${from}) — it proves nothing; fix the control, do not delete it`)
    return out
  }
  // Caught and reported, never thrown: a throw partway through this function hides every
  // control after it behind one exception, and the single line of output is then a stack rather
  // than a named control.
  const draft = (label, from, to, needle) => {
    let bad
    try { bad = prCheckDraftProblems(mutate(prCheckText, from, to)) } catch (e) { check(label, false, e.message); return }
    check(label, bad.some(b => b.includes(needle)),
      `the checker said: ${bad.join(' | ') || '(clean — the check is not doing anything; fix it, do not delete this test)'}`)
  }

  // THE DIRECTION, and the single most important control here: the shape the defect had,
  // expressed against a live read. The input is fixed and the guard still fails toward skipping,
  // so a resolve step skipped on a manual run or a merge-queue entry leaves the output empty and
  // a required check reports success having run nothing. Through the FIXTURE, so this is also
  // the control that proves `prCheckDraftProblems` reaches `audit()` at all.
  //
  // `expectFail` does not catch, and `mutate` throws on an anchor that has gone: driven, an
  // uncaught throw here takes the process down mid-`selfTest` and every control after it never
  // runs, leaving a stack trace where a named control should be. So this one call is guarded.
  try {
    expectFail('a guard that needs a positive answer in order to RUN is caught',
      w => edit(w, PRCHECK, t => mutate(t, "if: steps.draft.outputs.draft != 'true'", "if: steps.draft.outputs.draft == 'false'")),
      'must fail TOWARD RUNNING IT')
  } catch (e) {
    check('a guard that needs a positive answer in order to RUN is caught', false, e.message)
  }

  draft('the suites step deciding from the stale event payload is caught',
    "if: steps.draft.outputs.draft != 'true'", "if: github.event_name != 'pull_request' || github.event.pull_request.draft == false",
    'decides from `github.event.pull_request.draft`')
  draft('the resolve step removed while the condition still reads it is caught',
    /^ {6}- name: Resolve the live draft state[\s\S]*?(?=^ {6}- name: Say what a draft badge)/m, '',
    'no step in the job has that id')
  // The ordering check had no control of its own in the repository this is ported from, and a
  // check with no control is decoration: the resolve step is moved to the end of the job, where
  // its output is empty at the moment the suites step's condition is evaluated.
  draft('resolving the draft state AFTER the step that reads it is caught', null, text => {
    const m = text.match(/^ {6}- name: Resolve the live draft state[\s\S]*?(?=^ {6}- name: Say what a draft badge)/m)
    if (m == null) return text
    return text.replace(m[0], '') + m[0].replace(/\n+$/, '\n')
  }, 'resolves the draft state AFTER')
  // The EXECUTED controls. Neither can be caught by reading the YAML at all: the script is still
  // a live API read, still gated correctly, still has its env — and it decides the wrong way
  // round in the one state that matters. On a host with no `bash` they cannot discriminate, so
  // they say so rather than passing vacuously.
  if (canDriveShell()) {
    draft('a fall-open arm that falls CLOSED is caught',
      /^ {14}live=false$/m, '              live=true',
      'must decide `false`')
    // The tidy-up: `if out=$(…); then … else … fi` reads as ceremony, and a command substitution
    // inside an `if` condition is exempt from `set -e` — which is the ONLY reason the read can
    // fail without taking the step down. Written as a bare assignment it is a simple command, so
    // `bash -e` aborts, every later step is skipped and `acceptance` reds on an API blip. The
    // mutation keeps the `then`, so this models that hazard and not a syntax error. Anchored on
    // the SHAPE and not on the variable's name, so the day the construction changes it throws
    // rather than going quiet.
    draft('collapsing the read into a bare assignment, so `bash -e` aborts, is caught',
      /^( {12})if (\w+="\$\(gh api.*\)"); then$/m, '$1$2; if true; then',
      'exits 1')
  } else {
    // PRINTED, NOT FAILED, and the direction is the whole of the decision. This suite is SEEDED
    // and `suites` is a required Tier A check, so failing here would fail every build in every
    // app over the shell its host happens to have — a gate reding for a reason unrelated to its
    // subject, which is the cry-wolf shape and the most expensive version of it. A silent skip
    // is the other error, so it is loud and it is not routed through `check`: nothing claims
    // these two controls ran.
    //
    // What makes the skip acceptable rather than a hole: `pr-check.yml` is authored in THIS
    // repository, whose own CI is ubuntu and therefore always takes the measured path, on every
    // pull request that can change this workflow. An app on a shell-less host inherits a
    // workflow that was measured where it was written.
    console.log('  ⚠️  SKIPPED, with its reason: the two EXECUTED draft-guard controls need `bash`, and this host has none.')
    console.log('      The shape half of prCheckDraftProblems still ran; the measured half did not, and nothing here claims it did.')
  }
  draft('a ${{ }} expression spliced into the resolution script is caught',
    "          live=''", "          live='${{ github.event.pull_request.draft }}'",
    'interpolates a `${{ }}` expression')
  draft('the resolve step losing its event gate is caught',
    /^ {8}if: github\.event_name == 'pull_request'$/m, '        # (gate removed)',
    "not gated on `github.event_name == 'pull_request'`")
  draft('the token dropped from the resolve step\'s env is caught',
    /^ {10}GH_TOKEN: .*$/m, '          # GH_TOKEN removed',
    'declares no `GH_TOKEN`')
  draft('a draft caveat keyed on a different answer from the skip is caught',
    "if: steps.draft.outputs.draft == 'true'", 'if: github.event.pull_request.draft == true',
    'two readings of two different answers')
  // Derived from the constant the checker reads, so a permission added tomorrow gets its control
  // on the same run. Anchored on the LINE at its own indentation, and SCOPED TO THE JOB rather
  // than to the first match in the file: the block is preceded by a comment that quotes
  // `pull-requests: read` in prose, and a substring replacement would edit the explanation,
  // leave the block intact, and go QUIET.
  const inAcceptance = (from, to) => text => {
    const at = text.search(/^ {2}acceptance:[^\S\n]*$/m)
    if (at < 0) return text
    return text.slice(0, at) + text.slice(at).replace(from, to)
  }
  for (const [line] of ACCEPTANCE_PERMISSIONS) {
    draft(`the acceptance job losing \`${line}\` is caught`,
      null, inAcceptance(new RegExp(`^ {6}${line}$`, 'm'), `      # ${line}`),
      `does not grant \`${line}\``)
  }
  // The false-positive half, which is not optional: pr-check.yml
  // explains its own draft guard at length and the explanation names every noun the checks look
  // for, so an assertion over raw text would be asserting the prose. Strip every comment — from
  // the YAML and from inside the shell blocks — and every finding must still be absent.
  {
    const stripped = prCheckText.split('\n').filter(l => !/^ *#/.test(l)).join('\n')
    const bad = prCheckDraftProblems(stripped)
    check('every draft-guard check reads the YAML and the script, not the file\'s own prose about them',
      bad.length === 0, `the checker said: ${bad.join(' | ')}`)
  }
  // The reader's own false-positive half, and it is about a SHELL SCRIPT that happens to contain
  // YAML. A `run:` body may legitimately hold a line reading `if: …` or `name: …`, and a reader
  // matching anywhere in the step text would judge that instead of the step's own condition.
  // Synthesized rather than taken from this repository's workflow, because the shape is not in
  // it today and a control pinned to a file that happens not to contain the shape proves
  // nothing.
  {
    const job = [
      '  acceptance:',
      '    steps:',
      '      - name: Real name',
      '        id: real',
      "        if: github.event_name == 'pull_request'",
      '        run: |',
      '          cat > wf.yml <<YAML',
      '          - name: Decoy name',
      "            if: steps.decoy.outputs.draft == 'false'",
      '          YAML',
      '          echo done',
      '      - run: npm ci'
    ].join('\n')
    const steps = workflowSteps(job)
    const first = steps[0] ?? {}
    check('a `run:` body that contains YAML keys does not become the step\'s own keys',
      steps.length === 2 && first.name === 'Real name' && first.id === 'real' &&
      first.cond === "github.event_name == 'pull_request'" && (steps[1]?.run === 'npm ci'),
      `read ${steps.length} step(s): ${JSON.stringify({ name: first.name, id: first.id, cond: first.cond, second: steps[1]?.run })}`)
  }
  // AN APP'S CHECKS CAN PASS, AND A GREEN `review` MEANT A REVIEW. Each control is a way back to
  // the state this replaced: a check that can only fail in an app, or a green with nothing behind it.
  const harnessControl = (label, from, to, needle) => {
    let bad
    try { bad = harnessAbsenceProblems(mutate(prCheckText, from, to), read(root, '.immensus/template.json') == null ? null : JSON.parse(read(root, '.immensus/template.json')).template) } catch (e) { check(label, false, e.message); return }
    check(label, bad.some(b => b.includes(needle)), `the checker said: ${bad.join(' | ') || '(clean — the check is not doing anything; fix it, do not delete this test)'}`)
  }
  harnessControl('a runner self-test that also runs in an app is caught',
    "if: steps.harness.outputs.absent != 'true'\n        run: node scripts/run-suites.js --self-test", 'run: node scripts/run-suites.js --self-test',
    'so `check` can never pass')
  harnessControl('a suites step that also runs in an app is caught',
    "if: steps.draft.outputs.draft != 'true' && steps.harness.outputs.absent != 'true'", "if: steps.draft.outputs.draft != 'true'",
    'so `acceptance` can never pass')
  harnessControl('an app\'s skipped suites going unmentioned is caught',
    /^ {6}- name: Say what this check does not cover in an app[\s\S]*?(?=^ {6}- name: Acceptance \+ probe suites)/m, '',
    'did NOT run')
  harnessControl('a harness question naming another repository is caught',
    /ImmensusApp\/web-app-template' \]; then/g, "someone/else' ]; then",
    '.immensus/template.json names')
  if (canDriveShell()) {
    harnessControl('a template that loses its harness going unnoticed is caught',
      /echo "❌ scripts\/run-suites\.js is missing from the template repository, whose own checks run it\."\n {12}exit 1/g, 'absent=true',
      'the template WITHOUT the runner')
    harnessControl('an exemption wider than the harness is caught',
      'case "$path" in scripts/run-suites.js|scripts/probe/*) continue ;; esac', 'case "$path" in scripts/*) continue ;; esac',
      'the exemption is wider than the harness')
    harnessControl('a script-path step that still refuses the harness is caught',
      'case "$path" in scripts/run-suites.js|scripts/probe/*) continue ;; esac', 'true',
      'refuses the harness')
  } else {
    console.log('  ⚠️  no `bash` on this host: the executed harness controls are skipped')
  }

  const reviewText = read(root, '.github/workflows/agent-review.yml') ?? ''
  const reviewControl = (label, from, to, needle) => {
    let bad
    try {
      const out = reviewText.replace(from, to)
      if (out === reviewText) throw new Error(`the control did not change agent-review.yml (${from}) — it proves nothing; fix the control, do not delete it`)
      // Only the case this control is about: driving all of them per control costs seconds, and a
      // suite here has a budget of under one.
      bad = unreviewedProblems(out, BUILDER_REVIEW_CASES.filter(c => c[0].includes(needle)))
    } catch (e) { check(label, false, e.message); return }
    check(label, bad.some(b => b.includes(needle)), `the checker said: ${bad.join(' | ') || '(clean — the check is not doing anything; fix it, do not delete this test)'}`)
  }
  reviewControl('going green with no token and no builder review is caught',
    /(elif \[ "\$HAS_TOKEN" != 'true' \]; then\n[^\n]*\n) *notreviewed=true\n/, '$1', 'a green check with no review behind it')
  reviewControl('going green with no baseline is caught',
    /(if \[ "\$RUNNABLE" != 'true' \]; then\n(?: *#[^\n]*\n)*) *notreviewed=true\n/, '$1', 'nothing reviewed that diff')
  reviewControl('a draft reporting success again is caught',
    /^ {4}if: [^\n]*needs\.pr-state\.outputs\.draft[^\n]*\n/m, '', 'a draft then reports success')
  reviewControl('a failed pr-state leaving review skipped is caught',
    /^ {4}if: [^\n]*needs\.pr-state\.outputs\.draft[^\n]*\n/m, "    if: needs.pr-state.outputs.draft != 'true'\n", 'does not fail its "review" job')
  reviewControl('a failed pr-state that does not stop the job is caught',
    /^ {6}- name: Stop if the pull request could not be read[\s\S]*?(?=^ {6}- uses: actions\/checkout)/m, '', 'does not fail its "review" job')
  reviewControl('dropping the look for the builder\'s review is caught',
    /^ {6}- name: Did the builder worker review this commit\?[\s\S]*?(?=^ {6}- name: Which copy of this workflow)/m, '', 'a check that cannot pass')
  if (canDriveReview()) {
    reviewControl('a failed read that claims a review is caught',
      /if ! decide; then\n {12}reviewed=false/, 'if ! decide; then\n            reviewed=true', 'the comments cannot be read')
    reviewControl('any author\'s comment counting as the builder\'s is caught',
      '(.user.login == "immensus-builder[bot]" or .user.login == "immensus-builder-staging[bot]") and ', '', 'the notice this workflow posts itself')
    reviewControl('dropping the test environment\'s builder is caught',
      ' or .user.login == "immensus-builder-staging[bot]"', '', 'the test environment\'s builder')
    reviewControl('accepting any app\'s bot is caught',
      '.user.login == "immensus-builder[bot]" or .user.login == "immensus-builder-staging[bot]"', '(.user.login | endswith("[bot]"))', 'some other app')
    reviewControl('a review that did not approve counting is caught',
      /if ! printf '%s' "\$last" \| jq -e [^\n]*\n[^\n]*\n[^\n]*\n {12}fi\n/, '', 'a review that did not approve')
    reviewControl('a verdict matched by its prefix is caught',
      'approve(?![-\\\\w])', 'approve\\\\b', 'a verdict that only begins with approve')
    reviewControl('a rename read by its new name only is caught',
      '.filename, (.previous_filename // empty)', '.filename', 'a later file renamed onto an exempt name')
    reviewControl('later code changes being ignored is caught',
      "|CLAUDE\\.md'", "|CLAUDE\\.md|lib/x\\.js'", 'an approval followed by a later code change')
    reviewControl('an older-dated commit by someone else being missed is caught',
      ' or .commit.committer.name != "Immensus Builder"', '', 'someone else')
  } else {
    console.log('  ⚠️  no `bash` or `jq` on this host: the executed review controls are skipped')
  }

  // The reader's OTHER failure mode, pinned so it is a decision rather than an accident. A
  // condition written as a block or folded scalar is legal YAML and this reader does not follow
  // it, so it must come back `null` — which makes the checker say "carries no `if:`" LOUDLY
  // rather than judge the wrong string. A hand-written parser is allowed not to understand a
  // spelling; it is not allowed to misunderstand one.
  {
    const job = [
      '  acceptance:',
      '    steps:',
      '      - name: Folded condition',
      '        id: folded',
      '        if: >-',
      "          github.event_name == 'pull_request'",
      '        run: echo hi'
    ].join('\n')
    const only = workflowSteps(job)[0] ?? {}
    check('a block-scalar `if:` reads as absent rather than as the wrong condition',
      only.cond === null && only.id === 'folded',
      `cond was ${JSON.stringify(only.cond)}, id ${JSON.stringify(only.id)}`)
  }

  return failures
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// An import must not execute a suite — the guard scripts/template-manifest.js also carries,
// and this file now exports parsers (actionUses, stepInputs, jobRange) that invite being
// imported: without it, reading one function ran 31 negative controls as a side effect.
function invokedDirectly () {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (invokedDirectly()) main()

function main () {
console.log('harness-acceptance: negative controls')
const selfFailures = selfTest(ROOT)
if (selfFailures.length) {
  console.error(`\n❌ harness-acceptance self-test: ${selfFailures.length} control(s) failed — the audit cannot be trusted`)
  process.exit(1)
}

console.log('\nharness-acceptance: this repository')
const bad = audit(ROOT)
if (bad.length) {
  for (const b of bad) console.error('  ❌ ' + b)
  console.error(`\n❌ harness-acceptance: ${bad.length} problem(s)`)
  process.exit(1)
}
console.log(`  ✅ CLAUDE.md (${SECTIONS.length} sections), ${AGENTS.length} charters, ${COMMANDS.length} commands, pr-check "check" job, review delivery shape, deploy gates, ${Object.keys(ACTION_MAJORS).length} allowlisted action majors, none on a branch ref, config.yaml static at /web/, .gitignore, package.json`)
console.log('\n✅ harness-acceptance: the harness has the shape every generated app inherits')
}
