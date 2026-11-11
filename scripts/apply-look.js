#!/usr/bin/env node
// SEEDED — how one of the five ready-made looks reaches an app. `src/index.css` is GENERATED and
// deliberately not among the paths the template seeds (`scripts/template-manifest.js`), because
// restyling an app IS the seam; `tailwind.config.js` is seeded, because the theme CONTRACT is not a
// per-app choice. Neither of those is a prohibition any more — an app may change anything the
// template gave it. `looks/*.css` are the design's bytes verbatim rather
// than something a stage paraphrased, and `look-acceptance` measures that applying one writes
// `src/index.css` and nothing else.
//
// THE FIVE ARE A STARTING CHOICE, NOT A LIMIT. So this script is NOT the only writer of `src/index.css`: an app may set its
// own fonts and colours there instead — the nineteen colour tokens in both themes, `--radius`, the
// font on `body`, with `.dark` kept outside `@layer base` — and says so with `CUSTOM_LOOK_LINE`
// below, which is how `look-acceptance` tells a custom look from a baseline that drifted. Applying
// one of the five over a custom look replaces it, which is what applying a look means.
//
// A look is a TOKEN SET and nothing else: nineteen colours in both themes, one --radius,
// one font. It is not a component, because `src/components/ui/` is four components and the
// Frontend stage's stop condition is "a component outside the kit"; and it is not a layout,
// because form factor ("mostly phone" vs "mostly computer") lives in
// `src/components/shell.tsx`, which is GENERATED for exactly that reason. The two axes are
// separate seams and must stay separate: a look expressed as layout cannot be swapped, and
// a form factor expressed as colours cannot be chosen.
//
// There is NO default look. The builder recommends one per app with a reason,
// like any question card, so `src/index.css` as the template ships it is the un-looked
// baseline and not a sixth option. The same token VALUES are pinned at `looks/baseline.css`
// (BASELINE below), because a reference this script OVERWRITES is not a reference.
//
//   node scripts/apply-look.js --list
//   node scripts/apply-look.js <id>           writes src/index.css
//   node scripts/apply-look.js <id> --print   writes nothing, prints what it would write
//   node scripts/apply-look.js <id> --force   writes even when CSS would be lost (see below)
//
// Re-applying is safe and is the expected case (a founder changes their mind): the write is
// idempotent, and anything below APP_STYLES_MARKER in the existing file is preserved. Gate:
// look-acceptance.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * This repository's root, derived from this file's own location rather than imported from
 * `probe/harness.js`.
 *
 * Applying a look is how a look reaches an app at all (rule 29) and the builder's Frontend stage
 * runs this script, so this file is PRODUCT code — and product code may not depend on the test
 * harness. The harness is ours and is not seeded into a user's
 * repository, so an import of `probe/` from here is an import that
 * resolves in this checkout and in nothing the platform generates: applying a look would have
 * thrown `ERR_MODULE_NOT_FOUND` in every app, for a line that only ever supplied one path.
 * The value is unchanged — `join(…, '..', '..')` from `scripts/probe/` is `join(…, '..')` from
 * `scripts/`. Not exported: nothing outside this file wants it, and `look-acceptance` takes its own
 * `ROOT` from the harness. Gate: `deps-acceptance`'s harness-boundary section.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const LOOKS_DIR = 'looks'
export const MANIFEST = 'looks/looks.json'
export const TARGET = 'src/index.css'

/**
 * The un-looked baseline, pinned where this script does not write.
 *
 * `TARGET` is GENERATED and this script overwrites it, so it cannot also be the reference an
 * un-looked app is measured against: the moment a look is applied, anything that read TARGET
 * as "the baseline" is reading the look. That is what turned `look-acceptance` red on every
 * looked app, and it is this project's defining defect class — the gate's fixture was the file
 * under test. `looks/baseline.css` is a SEEDED peer of the `src/index.css` the template ships,
 * and the property that matters is the one this script enforces by construction: nothing here
 * writes it, so applying a look cannot destroy the reference it is measured against. (It used
 * to be said that `template-drift-acceptance` refused an edit to it; that gate is withdrawn
 * and it was never the thing that made this safe.) It is NOT a
 * sixth look: it is in neither `looks.json`'s `order` nor its `looks`, so `lookIds()` cannot
 * return it and `lookById('baseline')` throws.
 */
export const BASELINE = 'looks/baseline.css'

export function baselineCss (root = ROOT) {
  return readFileSync(join(root, BASELINE), 'utf8')
}

/** Everything below this line is the app's own CSS and survives a re-apply. */
export const APP_STYLES_MARKER = '/* ---- app styles below; apply-look.js owns everything above ---- */'

/** The nineteen colours every look and the baseline must declare, in both themes. */
export const COLOUR_VARS = [
  'background', 'foreground',
  'card', 'card-foreground',
  'popover', 'popover-foreground',
  'primary', 'primary-foreground',
  'secondary', 'secondary-foreground',
  'muted', 'muted-foreground',
  'accent', 'accent-foreground',
  'destructive', 'destructive-foreground',
  'border', 'input', 'ring',
]

/**
 * The base rules the template owns in every app, look or no look. They are re-emitted
 * rather than carried over from the file being replaced: `@apply border-border` and the
 * body colours are the shadcn contract, not a styling choice, and a look that dropped them
 * would render an unbordered, unpainted app that still compiled.
 */
export const BASE_RULES = `@layer base {
  * { @apply border-border; }
  body { @apply bg-background text-foreground antialiased; }
}`

/** Why `.dark` sits outside `@layer base`. The long version is on hoistDarkBlock(). */
export const DARK_NOTE = `/* Outside @layer base deliberately: Tailwind tree-shakes a class selector inside that layer
   against the content scan, and the class \`dark\` appears in no source file, so a .dark block
   written inside the layer is deleted at build time. Gate: look-acceptance. */`

export function manifest (root = ROOT) {
  return JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'))
}

/** The look ids, in the manifest's order. */
export function lookIds (root = ROOT) {
  return manifest(root).order.slice()
}

export function lookById (root, id) {
  const found = manifest(root).looks.find((l) => l.id === id)
  if (!found) throw new Error(`no look named ${JSON.stringify(id)} — try: ${lookIds(root).join(', ')}`)
  return found
}

export function lookCssPath (root, id) {
  return join(root, LOOKS_DIR, `${id}.css`)
}

/**
 * Split a look's file into its font `@import` lines and the rest. The look files put the
 * `@import` first because CSS requires it before any rule, and the composed file has to
 * keep it there — ahead of `@tailwind base`, which expands into rules.
 */
export function splitLook (css) {
  const imports = []
  const rest = []
  for (const line of css.split('\n')) {
    if (/^\s*@import\b/.test(line)) imports.push(line.trim())
    else rest.push(line)
  }
  return { imports, body: rest.join('\n').trim() }
}

/**
 * Lift the `.dark { … }` rule out of a look's `@layer base` block and return it separately.
 *
 * THIS IS NOT A STYLING CHANGE AND IT IS NOT OPTIONAL. Tailwind 3 tree-shakes class
 * selectors inside `@layer base` against the content scan, and the class `dark` appears
 * nowhere in `src/` or `index.html` — the app is put into dark mode by a script or by the
 * host, not by a className in the source. So a `.dark` block written inside `@layer base`
 * is DELETED at build time: measured on tailwindcss 3.4, `:root` survives and `.dark`
 * does not. The template shipped that shape from the start and the compiled stylesheet has
 * never carried a dark theme; nothing noticed because no gate compiled the CSS (§5's
 * pre-baked-fixture shape, in the one place a token set is most exposed to it).
 *
 * The look files put both blocks in `@layer base`, which is the shadcn convention and is
 * correct in a project whose content mentions the class. Hoisting is a mechanical
 * correction our own pipeline requires, like a CSS property name our generator invents —
 * so it is done here, in one place, rather than by editing the look's bytes. Unlayered rules
 * also beat layered ones in the cascade, which is the precedence `.dark` needs over `:root`
 * anyway. Gate: look-acceptance compiles two looks and reads both themes back.
 */
export function hoistDarkBlock (body) {
  // Matched at a rule boundary rather than by indexOf: a future look could mention .dark in
  // a comment above the rule, and slicing from there would carry the comment into the
  // hoisted block and leave an unbalanced brace behind.
  const m = /(?:^|[};{/*])\s*(\.dark)\s*\{/m.exec(body)
  if (!m) return { body, dark: '' }
  const at = m.index + m[0].indexOf('.dark')
  const open = m.index + m[0].length - 1
  let depth = 0
  let end = open
  for (; end < body.length; end++) {
    if (body[end] === '{') depth++
    else if (body[end] === '}') { depth--; if (depth === 0) break }
  }
  const dark = body.slice(at, end + 1).split('\n').map((l) => l.replace(/^ {2}/, '')).join('\n')
  const rest = (body.slice(0, at).replace(/[ \t]+$/, '') + body.slice(end + 1)).replace(/\n{3,}/g, '\n\n')
  return { body: rest, dark }
}

/** The app's own CSS from an existing target file: whatever follows the marker. */
export function appStyles (root = ROOT) {
  const p = join(root, TARGET)
  if (!existsSync(p)) return ''
  const text = readFileSync(p, 'utf8')
  const at = text.indexOf(APP_STYLES_MARKER)
  if (at === -1) return ''
  return text.slice(at + APP_STYLES_MARKER.length).trim()
}

/**
 * Remove every `@import` / `@tailwind` statement, TOLERATING SEMICOLONS INSIDE QUOTES.
 *
 * The naive `@(import|tailwind)[^;]*;` ends the statement at the first semicolon anywhere,
 * and every look's font `@import` is a Google Fonts URL whose weight list is semicolon
 * separated (`family=IBM+Plex+Sans:wght@400;500;600;700&display=swap`). So the strip stopped
 * at `wght@400;` and left `500;600;700&display=swap');` in the text, where it joined the
 * prelude of the next rule — and the look's own `@layer base { :root { … } }` stopped
 * matching `OURS` and was reported as CSS this script does not own. A marker-less stylesheet
 * that had taken any look was then REFUSED, naming the look's own token block as what would
 * be lost: the cry-wolf half of this rule firing on bytes `applyLook()` itself wrote.
 *
 * An unterminated quote matches nothing and leaves the at-rule in the text, so a malformed
 * stylesheet is refused rather than silently overwritten. That is the safe direction.
 */
export function stripAtRules (css) {
  return css.replace(/@(?:import|tailwind)\b(?:[^;'"]|'[^']*'|"[^"]*")*;/g, '')
}

/**
 * Anything in a stylesheet that this script does not own: not a comment, not `@import` or
 * `@tailwind`, not an `@layer base` block and not a top-level `:root` or `.dark` rule.
 *
 * Needed because the marker is how app CSS is kept, and a file that has none is not
 * necessarily empty of app CSS. An app generated BEFORE the marker existed, or one whose
 * stage deleted it, would have its hand-written rules overwritten with no warning — a
 * silent loss is the worst outcome a one-file-write tool can have. So the refusal below is
 * keyed on what would actually be lost rather than on the marker's absence: a pre-marker
 * app whose stylesheet is only the old token block loses nothing and must not be nagged,
 * which is the cry-wolf half of the same rule.
 */
export function unmanagedCss (text) {
  const s = stripAtRules(text.replace(/\/\*[\s\S]*?\*\//g, ''))
  const OURS = /^(?:@layer\s+base|:root|\.dark)$/
  let out = ''
  let i = 0
  while (i < s.length) {
    const open = s.indexOf('{', i)
    if (open === -1) { out += s.slice(i); break }
    const prelude = s.slice(i, open).trim()
    let depth = 0
    let end = open
    for (; end < s.length; end++) {
      if (s[end] === '{') depth++
      else if (s[end] === '}') { depth--; if (depth === 0) break }
    }
    if (!OURS.test(prelude)) out += s.slice(i, end + 1)
    i = end + 1
  }
  return out.trim()
}

/**
 * The provenance line every composed stylesheet carries, and the only place its wording
 * lives. `lookedFrom()` reads it back, so a stylesheet can say which look it holds — which is
 * how a FIXED suite states its premise ("the baseline, a look, or the app's own?") instead of
 * assuming one, and how it can assert the right thing in every state rather than skipping.
 *
 * It says how to leave the look as well as how to keep it, because this comment is the sentence
 * whoever edits the file reads first. It once said "do not hand-edit above the marker", which
 * read as a prohibition on the app having fonts and colours of its own — and an edit that obeyed it
 * by writing a second set of tokens BELOW the marker left a file whose top claimed a look the app
 * no longer wore. It names the opening words `isCustomLook()` reads part-way through its own comment,
 * where they do not count, and never at a comment's start, where every looked stylesheet would
 * then read as custom too.
 */
export function provenance (id) {
  return `/* Written by scripts/apply-look.js from ${LOOKS_DIR}/${id}.css. Applying a look rewrites\n` +
    '   everything above the marker; app CSS goes below it. To give this app its own fonts and\n' +
    '   colours instead, change the tokens here in both themes and replace this comment with one\n' +
    '   whose first words are "Custom look:" (CUSTOM_LOOK_LINE in scripts/apply-look.js). */'
}

/** The look id a stylesheet was composed from, or null for the un-looked baseline. */
export function lookedFrom (text) {
  const m = new RegExp(`Written by scripts/apply-look\\.js from ${LOOKS_DIR}/([A-Za-z0-9_-]+)\\.css`).exec(text)
  return m ? m[1] : null
}

/**
 * The line a stylesheet carries when its fonts and colours are the APP'S OWN rather than one of
 * the five in `looks/` (this file's header explains). Copy it
 * verbatim into `src/index.css`, above the tokens, in place of the provenance comment
 * `apply-look.js` wrote — whoever sets the tokens writes it: the builder's Frontend on a first
 * build or an edit, or a person editing their own app.
 *
 * It is a DECLARATION and deliberately not an inference. A stylesheet whose values merely differ
 * from the pinned baseline is still read as the un-looked baseline, and fails, because "differs" is
 * equally true of drift — the thing that check exists to catch — and a condition that relaxes a
 * check must be declared rather than read off the tree. What a custom look is still held to
 * is what it shares with every look: all nineteen colours in both themes, `--radius`, and `.dark`
 * outside `@layer base` (`look-acceptance`).
 *
 * Nothing in this script writes it: applying one of the five replaces everything above the
 * marker, the line included, with that look's own provenance.
 */
export const CUSTOM_LOOK_LINE = '/* Custom look: set for this app, not one of the five in looks/. */'

/**
 * True when a stylesheet declares its tokens as the app's own. Matched on the comment's OPENING
 * words, so prose that mentions the phrase part-way through some other comment — this file's own
 * provenance line does, to say how to declare one — is not read as the declaration. Only the
 * opening is required, so a line whose tail was reworded still counts; it is case-sensitive,
 * because the line is meant to be copied.
 */
export function isCustomLook (text) {
  return /\/\*\s*Custom look:/.test(text)
}

export function composeIndexCss (root, id) {
  // Resolve the id against the manifest FIRST, so an unknown look throws before anything is
  // read or written. A typo must not half-write src/index.css.
  lookById(root, id)
  const { imports, body: raw } = splitLook(readFileSync(lookCssPath(root, id), 'utf8'))
  const { body, dark } = hoistDarkBlock(raw)
  const tail = appStyles(root)
  return [
    ...imports,
    imports.length ? '' : null,
    '@tailwind base;',
    '@tailwind components;',
    '@tailwind utilities;',
    '',
    provenance(id),
    body,
    '',
    BASE_RULES,
    '',
    DARK_NOTE,
    dark,
    '',
    APP_STYLES_MARKER,
    tail ? '' : null,
    tail || null,
    '',
  ].filter((l) => l !== null).join('\n')
}

/**
 * Refuse to write when the target has no marker AND holds CSS this script does not own,
 * naming what would be lost. `force` is the operator's override, never a stage's default.
 */
export function unmanagedRefusal (root) {
  const p = join(root, TARGET)
  if (!existsSync(p)) return null
  const text = readFileSync(p, 'utf8')
  if (text.includes(APP_STYLES_MARKER)) return null
  const orphan = unmanagedCss(text)
  if (!orphan) return null
  return `${TARGET} holds CSS below no marker, and applying a look would overwrite it:\n` +
    orphan.split('\n').slice(0, 6).map((l) => '    ' + l).join('\n') +
    `\n  Move it below the line \`${APP_STYLES_MARKER}\` and re-run, or pass --force to discard it.`
}

export function applyLook (root, id, { force = false } = {}) {
  if (!force) {
    const refusal = unmanagedRefusal(root)
    if (refusal) throw new Error(refusal)
  }
  const css = composeIndexCss(root, id)
  writeFileSync(join(root, TARGET), css)
  return css
}

function cli (argv) {
  const args = argv.filter((a) => !a.startsWith('--'))
  const print = argv.includes('--print')
  const force = argv.includes('--force')
  if (argv.includes('--list') || args.length === 0) {
    for (const l of manifest(ROOT).looks) console.log(`${l.id.padEnd(8)} ${l.name.padEnd(8)} ${l.line}`)
    console.log(`\n${manifest(ROOT).recommendedBy}.`)
    console.log(`These are starting points, not a limit: an app may set its own fonts and colours in ${TARGET}'s tokens,\nin both themes, with this line above them:\n  ${CUSTOM_LOOK_LINE}`)
    return 0
  }
  const id = args[0]
  try {
    if (print) { process.stdout.write(composeIndexCss(ROOT, id)); return 0 }
    applyLook(ROOT, id, { force })
    console.log(`✅ ${TARGET} is now ${lookById(ROOT, id).name}`)
    return 0
  } catch (err) {
    console.error(`❌ ${err.message}`)
    return 1
  }
}

if (process.argv[1] && process.argv[1].endsWith('apply-look.js')) process.exit(cli(process.argv.slice(2)))
