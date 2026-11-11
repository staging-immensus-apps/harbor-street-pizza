#!/usr/bin/env node
// FIXED — rule 15: scripts/deploy.js refuses a missing or stale
// web/index.html and refuses a CLI_TARGET on localhost. Drives the pure verdicts, then the
// script itself with --dry-run in a synthesized repo (it never runs the Harper CLI).
//
// AND the CLI agreement: the package the hand-deploy workflow installs must declare the
// binary scripts/deploy.js spawns. That is the one thing neither file can see about itself —
// the workflow installed `harperdb@^5.2`, a range that does not resolve at all, and the
// obvious repoint to `harper` leaves behind a spawn of a binary the new package does not
// provide. The subject is the deploy path's own internal agreement, which is this suite's,
// rather than workflow shape, which is harness-acceptance's.
//
// Hermetic: file mtimes are set explicitly, no network, no git, no wall clock.

import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { ROOT, checker, stripComments, stripHashComments } from './probe/harness.js'

const { judgeBuild, judgeTarget, parseEnvFile, newestMtime, LOOPBACK, CLI_BIN } = await import(pathToFileURL(join(ROOT, 'scripts', 'deploy.js')).href)
const { check, section, done } = checker('deploy-gate-acceptance')

section('the build verdict')
check('a missing web/index.html is refused', judgeBuild({ indexMtime: null, newestSource: 100 }).ok === false)
check('an index older than the newest source file is refused (stale build)', judgeBuild({ indexMtime: 100, newestSource: 200 }).ok === false)
check('an index newer than every source file passes', judgeBuild({ indexMtime: 300, newestSource: 200 }).ok === true)
check('an index with no source files at all passes', judgeBuild({ indexMtime: 300, newestSource: null }).ok === true)

section('the target verdict')
for (const bad of ['', undefined, 'localhost', 'http://localhost:9925', 'https://127.0.0.1:9925', '127.0.0.1', 'http://0.0.0.0:9925', 'http://[::1]:9925']) {
  check(`CLI_TARGET=${JSON.stringify(bad ?? '(unset)')} is refused`, judgeTarget(bad).ok === false)
}
for (const good of ['https://app.acme.harperfabric.com:9925', 'https://node-1.cluster.example', 'cluster.example:9925']) {
  check(`CLI_TARGET=${good} is allowed`, judgeTarget(good).ok === true)
}
check('the loopback pattern does not match a host that merely contains "localhost"', !LOOPBACK.test('notlocalhost.example') && !LOOPBACK.test('localhost.example'))

section('.env parsing')
const env = parseEnvFile('# comment\nCLI_TARGET=https://a.b.c:9925/\nexport CLI_TARGET_USERNAME="u"\nCLI_TARGET_PASSWORD=p=w#1 \n')
check('KEY=value, export KEY, quoted values and = inside values parse', env.CLI_TARGET === 'https://a.b.c:9925/' && env.CLI_TARGET_USERNAME === 'u' && env.CLI_TARGET_PASSWORD === 'p=w#1')

// ---------------------------------------------------------------------------------------
// The CLI package and the binary it provides.
//
// WHAT THIS CANNOT DO, stated rather than implied: it cannot ask the registry whether a range
// resolves. A hermetic suite has no network, so the published facts are TRANSCRIBED below with
// the date and the versions they were read at — the discipline any claim about a dependency
// requires, and the reason the defect this check exists for survived at
// all: the old install line carried neither.
//
// Measured 2026-10-14 from each package's own published `package.json` (`npm view <pkg> bin`):
//   harperdb — last release 4.7.41, bin { harper, harperdb }. `^5.2` answers E404.
//   harper   — the 5.x line (5.3.2 latest), bin { harper }. NO `harperdb` alias.
// Both names are kept, because judging the RELATION between a package and a binary is what
// makes this a check rather than a refusal of one string: the must-not-fire control below
// installs the 4.x line and spawns `harperdb`, a pairing that genuinely works.
const CLI_PACKAGES = {
  harperdb: { bins: ['harper', 'harperdb'], majors: [1, 2, 3, 4] },
  harper: { bins: ['harper'], majors: [5] },
}

/** The package and range the workflow's global install names, or null when the shape changed. */
export function installedCli (workflowText) {
  // Comments first: that workflow now explains this defect at length and names `harperdb@^5.2`
  // in prose directly above the real install line, so a scan over raw text would read the
  // explanation instead of the step.
  const m = stripHashComments(workflowText).match(/npm\s+i(?:nstall)?\s+-g\s+(@?[\w./-]+?)@([^\s'"]+)/)
  return m ? { pkg: m[1], range: m[2] } : null
}

/** How scripts/deploy.js names the binary, read from its code rather than from its header. */
export function deployBinary (deployText) {
  const code = stripComments(deployText)
  const declared = code.match(/export\s+const\s+CLI_BIN\s*=\s*'([^']+)'/)
  const pkg = code.match(/export\s+const\s+CLI_PACKAGE\s*=\s*'([^']+)'/)
  return {
    declared: declared ? declared[1] : null,
    pkg: pkg ? pkg[1] : null,
    spawnsConstant: /spawnSync\s*\(\s*CLI_BIN\s*,/.test(code),
    spawnLiteral: (code.match(/spawnSync\s*\(\s*'([^']+)'/) ?? [])[1] ?? null,
    printsConstant: /console\.log\s*\(\s*`[^`]*\$\{\s*CLI_BIN\s*\}/.test(code),
    // The refusal tells somebody what to install. It must name the package the workflow really
    // installs, and it must NOT carry a version range: a range here is a second record of the
    // one in the install step, compared by nothing, which is this change's own defect class.
    hintsPackageConstant: /npm i -g \$\{\s*CLI_PACKAGE\s*\}/.test(code),
    hintsRange: /npm i -g [^`'"]*@[\d^~*]/.test(code),
  }
}

/** Findings as strings. An empty array is a clean verdict. */
export function cliProblems (workflowText, deployText) {
  const bad = []
  const install = installedCli(workflowText)
  const bin = deployBinary(deployText)

  // A parse that finds nothing is reported AS ITSELF rather than as a clean verdict — the
  // always-OK shape this repository has shipped before, and the same clause pr-check's
  // two-secret-list guard carries for the same reason.
  if (!install) bad.push("could not find the global CLI install in deploy-shared.yml — the step's shape changed; re-point this check rather than deleting it")
  if (!bin.declared) bad.push('could not read CLI_BIN out of scripts/deploy.js — re-point this check rather than deleting it')
  if (!bin.pkg) bad.push('could not read CLI_PACKAGE out of scripts/deploy.js — re-point this check rather than deleting it')
  if (!install || !bin.declared || !bin.pkg) return bad

  // The refusal's install hint is the one duplicate of the install spec in this tree, so it is
  // held to the workflow rather than left to drift — the class this whole check is about.
  if (bin.pkg !== install.pkg) bad.push(`scripts/deploy.js tells the operator to install "${bin.pkg}" while deploy-shared.yml installs "${install.pkg}"`)
  if (!bin.hintsPackageConstant) bad.push('scripts/deploy.js hard-codes the package in its install hint rather than interpolating CLI_PACKAGE')
  if (bin.hintsRange) bad.push('scripts/deploy.js names a VERSION RANGE in its install hint — the range belongs in the install step and `engines`, and a second copy here is a record nothing compares')

  const known = CLI_PACKAGES[install.pkg]
  if (!known) {
    bad.push(`deploy-shared.yml installs "${install.pkg}", which this check knows nothing about — it covers Harper's own two package names; re-point it rather than deleting it`)
    return bad
  }
  const major = Number((install.range.match(/(\d+)/) ?? [])[1])
  if (!known.majors.includes(major)) {
    bad.push(`deploy-shared.yml installs ${install.pkg}@${install.range}, and ${install.pkg} publishes no ${major}.x — Harper's ${major}.x line is a different package name`)
  }
  if (!known.bins.includes(bin.declared)) {
    bad.push(`scripts/deploy.js spawns "${bin.declared}", which ${install.pkg} does not declare as a binary (it declares ${known.bins.join(', ')}) — the deploy would fail ENOENT after a successful install`)
  }
  // One spelling, two call sites. A literal at either site is how the printed command and the
  // spawned process come to disagree, which is a deploy log naming a command nobody ran.
  if (!bin.spawnsConstant) bad.push(`scripts/deploy.js spawns ${JSON.stringify(bin.spawnLiteral)} as a literal rather than CLI_BIN — one spelling, or the two call sites drift`)
  if (!bin.printsConstant) bad.push('scripts/deploy.js prints the deploy command without interpolating CLI_BIN — the log would name a command it did not run')
  return bad
}

section('the CLI package declares the binary the deploy spawns')
const shippedWorkflow = readFileSync(join(ROOT, '.github', 'workflows', 'deploy-shared.yml'), 'utf8')
const shippedDeploy = readFileSync(join(ROOT, 'scripts', 'deploy.js'), 'utf8')
const shippedInstall = installedCli(shippedWorkflow)

// PRECONDITIONS, asserted before the controls, so no control below can be a no-op mutation
// against a tree that stopped carrying its subject.
check('PRECONDITION: the workflow carries a global CLI install this check can read', shippedInstall !== null, JSON.stringify(shippedInstall))
check('PRECONDITION: the workflow names the OLD package in a comment, so stripping comments is load-bearing rather than lucky',
  /harperdb@/.test(shippedWorkflow) && !/harperdb@/.test(stripHashComments(shippedWorkflow)))
check('PRECONDITION: scripts/deploy.js names the OLD binary in its header, so stripping comments is load-bearing there too',
  /harperdb/.test(shippedDeploy) && !/harperdb/.test(stripComments(shippedDeploy)))

check(`the shipped tree agrees: ${shippedInstall?.pkg}@${shippedInstall?.range} declares "${CLI_BIN}" (must NOT fire)`,
  cliProblems(shippedWorkflow, shippedDeploy).length === 0, cliProblems(shippedWorkflow, shippedDeploy).join(' | '))
check('CLI_BIN is the binary Harper 5.x actually publishes', CLI_BIN === 'harper')

// Every control rewrites what the parsers themselves read, or synthesizes the shape from
// scratch — never a literal of this repository's own bytes, which is a no-op in any app that
// formatted the file differently. Each one asserts its needle bit before its verdict.
//
// "THE NEEDLE BIT" IS NOT "THE BYTES CHANGED", and the first version of these two helpers had
// it as the latter — which failed loudly the first time a mutation asked for the value the tree
// already carries (`harper@^5.2` IS the shipped install). The two properties come apart in both
// directions: a replace that matched nothing also leaves the bytes unchanged, and a replace that
// matched and rewrote a value to itself is a live needle. So each helper asserts BOTH halves
// separately — the pattern matched, and the parser now reads what was asked for.
const INSTALL_RE = /npm\s+i\s+-g\s+@?[\w./-]+?@[^\s'"]+/
const CLI_BIN_RE = /export const CLI_BIN = '[^']+'/
function withInstall (spec) {
  const at = spec.lastIndexOf('@')
  const [pkg, range] = [spec.slice(0, at), spec.slice(at + 1)]
  const matched = INSTALL_RE.test(shippedWorkflow)
  const out = shippedWorkflow.replace(INSTALL_RE, `npm i -g ${spec}`)
  const got = installedCli(out)
  check(`PRECONDITION: the install mutation to ${spec} bit`, matched && got?.pkg === pkg && got?.range === range, JSON.stringify(got))
  return out
}
const CLI_PKG_RE = /export const CLI_PACKAGE = '[^']+'/
function withBin (name, pkg = null) {
  const matched = CLI_BIN_RE.test(shippedDeploy) && (pkg === null || CLI_PKG_RE.test(shippedDeploy))
  let out = shippedDeploy.replace(CLI_BIN_RE, `export const CLI_BIN = '${name}'`)
  // A control that moves the binary to another package's line has to move the PACKAGE with it,
  // or it is asserting a mixed tree rather than the one it names — making a
  // check conditional makes its own controls conditional too, which is how adding the install
  // hint's rule red the 4.x must-not-fire below.
  if (pkg !== null) out = out.replace(CLI_PKG_RE, `export const CLI_PACKAGE = '${pkg}'`)
  const got = deployBinary(out)
  check(`PRECONDITION: the CLI_BIN mutation to ${name}${pkg ? ` (package ${pkg})` : ''} bit`,
    matched && got.declared === name && (pkg === null || got.pkg === pkg), `${got.declared} / ${got.pkg}`)
  return out
}

{
  // The defect as it shipped: a range that does not resolve, with the matching old spawn.
  const f = cliProblems(withInstall('harperdb@^5.2'), withBin('harperdb'))
  check('the shipped defect reds, naming the PACKAGE rather than the binary (NEG)',
    f.some((b) => /harperdb publishes no 5\.x/.test(b)), f.join(' | '))
}
{
  // The obvious fix, which moves the failure instead of fixing it. This is the control the
  // whole check exists for.
  const f = cliProblems(withInstall('harper@^5.2'), withBin('harperdb'))
  check('repointing the INSTALL alone still reds, on the binary harper does not declare (NEG)',
    f.some((b) => /does not declare as a binary/.test(b)), f.join(' | '))
}
{
  // A pairing that genuinely works, so the two rules above are judging the relation rather
  // than refusing the string `harperdb`. The 4.x line declares both names.
  const f = cliProblems(withInstall('harperdb@^4.7'), withBin('harperdb', 'harperdb'))
  check('a CONSISTENTLY 4.x tree — install, binary and hint all naming it — is NOT flagged (must not fire)', f.length === 0, f.join(' | '))
}
{
  const f = cliProblems(withInstall('mysql@^8'), shippedDeploy)
  check('a CLI package this check knows nothing about reds by name and says to re-point it (NEG)',
    f.some((b) => /knows nothing about/.test(b)), f.join(' | '))
}
{
  // The drift CLI_BIN exists to prevent: a literal back at the spawn site.
  const hardcoded = shippedDeploy.replace(/spawnSync\(CLI_BIN,/, "spawnSync('harperdb',")
  check('PRECONDITION: the spawn-literal mutation bit', hardcoded !== shippedDeploy && deployBinary(hardcoded).spawnsConstant === false)
  const f = cliProblems(shippedWorkflow, hardcoded)
  check('a literal at the spawn site reds, and reports the literal it found (NEG)',
    f.some((b) => /as a literal rather than CLI_BIN/.test(b) && /"harperdb"/.test(b)), f.join(' | '))
}
{
  const unprinted = shippedDeploy.replace(/console\.log\(`→ \$\{CLI_BIN\}/, 'console.log(`→ harper')
  check('PRECONDITION: the print mutation bit', unprinted !== shippedDeploy && deployBinary(unprinted).printsConstant === false)
  const f = cliProblems(shippedWorkflow, unprinted)
  check('a hard-coded command in the deploy LOG reds (NEG)', f.some((b) => /without interpolating CLI_BIN/.test(b)), f.join(' | '))
}
{
  // The install hint. Three ways to get it wrong, and the third is the one this change itself
  // committed and its own diff read caught: a version range in the hint is a second copy of the
  // install spec with nothing comparing the two.
  const wrongPkg = shippedDeploy.replace(/export const CLI_PACKAGE = '[^']+'/, "export const CLI_PACKAGE = 'harperdb'")
  check('PRECONDITION: the CLI_PACKAGE mutation bit', deployBinary(wrongPkg).pkg === 'harperdb')
  check('an install hint naming a different package than the workflow installs reds (NEG)',
    cliProblems(shippedWorkflow, wrongPkg).some((b) => /tells the operator to install/.test(b)), cliProblems(shippedWorkflow, wrongPkg).join(' | '))

  const literalHint = shippedDeploy.replace(/npm i -g \$\{CLI_PACKAGE\}/, 'npm i -g harper')
  check('PRECONDITION: the literal-hint mutation bit', deployBinary(literalHint).hintsPackageConstant === false)
  check('a hard-coded package in the install hint reds (NEG)',
    cliProblems(shippedWorkflow, literalHint).some((b) => /hard-codes the package in its install hint/.test(b)), cliProblems(shippedWorkflow, literalHint).join(' | '))

  const rangedHint = shippedDeploy.replace(/npm i -g \$\{CLI_PACKAGE\}/, 'npm i -g harper@^5.2')
  check('PRECONDITION: the ranged-hint mutation bit', deployBinary(rangedHint).hintsRange === true)
  check('a VERSION RANGE in the install hint reds — a second record of the install spec (NEG)',
    cliProblems(shippedWorkflow, rangedHint).some((b) => /names a VERSION RANGE/.test(b)), cliProblems(shippedWorkflow, rangedHint).join(' | '))

  const noPkg = shippedDeploy.replace(/export const CLI_PACKAGE = '[^']+'/, '')
  check('PRECONDITION: the removed-CLI_PACKAGE mutation bit', deployBinary(noPkg).pkg === null)
  check('a deploy script with no CLI_PACKAGE reds as a dead parse (NEG)',
    cliProblems(shippedWorkflow, noPkg).some((b) => /could not read CLI_PACKAGE/.test(b)), cliProblems(shippedWorkflow, noPkg).join(' | '))
}
{
  // A changed step shape must report as a dead parse, never as agreement.
  const blanked = shippedWorkflow.replace(/npm\s+i\s+-g\s+@?[\w./-]+?@[^\s'"]+/, 'true')
  check('PRECONDITION: the removed-install mutation bit', installedCli(blanked) === null)
  const f = cliProblems(blanked, shippedDeploy)
  check('an install step this check can no longer read reds as a DEAD PARSE, not as agreement (NEG)',
    f.some((b) => /could not find the global CLI install/.test(b)), f.join(' | '))
  const noConst = shippedDeploy.replace(/export const CLI_BIN = '[^']+'/, '')
  check('PRECONDITION: the removed-constant mutation bit', deployBinary(noConst).declared === null)
  const g = cliProblems(shippedWorkflow, noConst)
  check('a deploy script with no CLI_BIN reds as a dead parse too (NEG)',
    g.some((b) => /could not read CLI_BIN/.test(b)), g.join(' | '))
}

section('the script itself, --dry-run in a synthesized repo')
function repo ({ indexAge, srcAge, cliTarget }) {
  const w = mkdtempSync(join(tmpdir(), 'deploy-gate-'))
  mkdirSync(join(w, 'src'), { recursive: true })
  mkdirSync(join(w, 'web'), { recursive: true })
  mkdirSync(join(w, 'scripts'), { recursive: true })
  writeFileSync(join(w, 'scripts', 'deploy.js'), `export * from ${JSON.stringify(pathToFileURL(join(ROOT, 'scripts', 'deploy.js')).href)}\n`)
  writeFileSync(join(w, 'src', 'main.tsx'), 'export {}\n')
  if (indexAge != null) writeFileSync(join(w, 'web', 'index.html'), '<html></html>\n')
  // Explicit mtimes so the verdict never depends on how fast this ran.
  const base = 1_800_000_000
  utimesSync(join(w, 'src', 'main.tsx'), base + srcAge, base + srcAge)
  if (indexAge != null) utimesSync(join(w, 'web', 'index.html'), base + indexAge, base + indexAge)
  if (cliTarget != null) writeFileSync(join(w, '.env'), `CLI_TARGET=${cliTarget}\nCLI_TARGET_USERNAME=u\nCLI_TARGET_PASSWORD=p\n`)
  return w
}
function run (w) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'deploy.js'), '--dry-run'], { cwd: w, encoding: 'utf8', env: { ...process.env, CLI_TARGET: '' } })
  rmSync(w, { recursive: true, force: true })
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
{
  const ok = run(repo({ indexAge: 100, srcAge: 50, cliTarget: 'https://app.acme.harperfabric.com:9925' }))
  // Matched against CLI_BIN rather than a literal, so this assertion follows the constant
  // instead of pinning the binary's name a second time.
  check('fresh build + real target → exit 0 and the deploy command is printed', ok.status === 0 && new RegExp(`${CLI_BIN} deploy \\. restart=rolling replicated=true`).test(ok.out) && /dry run/.test(ok.out), ok.out)
  const stale = run(repo({ indexAge: 10, srcAge: 50, cliTarget: 'https://app.acme.harperfabric.com:9925' }))
  check('stale build → exit 1, names the fix (NEG)', stale.status === 1 && /npm run build/.test(stale.out), stale.out)
  const missing = run(repo({ indexAge: null, srcAge: 50, cliTarget: 'https://app.acme.harperfabric.com:9925' }))
  check('missing build → exit 1 (NEG)', missing.status === 1 && /missing/.test(missing.out), missing.out)
  const local = run(repo({ indexAge: 100, srcAge: 50, cliTarget: 'http://localhost:9925' }))
  check('localhost target → exit 1 and never prints the deploy command (NEG)', local.status === 1 && /localhost/.test(local.out) && !new RegExp(`→ ${CLI_BIN}`).test(local.out), local.out)
  const none = run(repo({ indexAge: 100, srcAge: 50, cliTarget: null }))
  check('no CLI_TARGET at all → exit 1 (NEG)', none.status === 1 && /CLI_TARGET is not set/.test(none.out), none.out)
}
check('newestMtime returns null for a root with no sources', newestMtime(mkdtempSync(join(tmpdir(), 'empty-'))) === null)
process.exit(done())
