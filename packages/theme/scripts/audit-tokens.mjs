#!/usr/bin/env node
// Token governance gate for the Nexus theme system (plan §4.8, M6).
//
//   node packages/theme/scripts/audit-tokens.mjs [--root <dir>] [--quiet]
//
// Three rules, all "fail only when you change something":
//
//   1. every custom-property reference has a definition (any prefix — a typo in a runtime
//      var is the same class of bug as a typo in a token)
//   2. every defined `--nexus-*` token is referenced, or marked `@reserved`
//   3. no colour literal outside the token-definition source, unless marked `@constant`
//
// Rule 1 has to pass BEFORE the Tailwind fallbacks in `theme.ts` are removed. Those fallbacks
// are currently the only backstop: with them gone, a reference to an undefined token loses its
// colour outright instead of falling back to a near-miss. The other order produces a mid-state
// that looks like the theme system is broken.
//
// Exemptions are line-level and must be explicit — "not tested" must never look like "passed":
//
//   `@reserved`  the token is intentional and has no call site yet
//   `@constant`  this colour is deliberately theme-independent (elevation shadow, platform red)
//
// Colour literals in the definition file (`packages/theme/src/index.ts`) are the single legal
// hardcoding site and are not reported.
//
// Rule 3 reads CODE, not prose: a doc comment explaining what `rgb()` accepts, or citing
// `rgba(27,31,35,0.05)` as an example, is documentation — not a hardcoded colour. Without this,
// writing a comment about colour syntax fails the gate, and the fix people reach for is to stop
// documenting. Only whole-line comments and trailing `//` are stripped; `@constant` is read from
// the raw line, since that marker lives inside a comment itself.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const ROOT = arg('root', '.');
const QUIET = argv.includes('--quiet');

const DEFS_FILE = 'packages/theme/src/index.ts';
const THEME_PREFIX = '--nexus-';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', '.git', '.workbuddy-ai', '.serena', 'coverage']);
const SCAN_EXT = /\.(ts|tsx|css)$/;

// test/ and fixtures/ are excluded: they assert on colours on purpose, and counting them turns
// rule 3 into noise that gets muted.
const isSkipped = (rel) => {
  const parts = rel.split('/');
  return parts.some((p) => SKIP_DIRS.has(p)) || parts.includes('test') || parts.includes('fixtures');
};

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full).split(sep).join('/');
    if (isSkipped(rel)) continue;
    if (statSync(full).isDirectory()) walk(full);
    else if (SCAN_EXT.test(entry)) files.push({ rel, full });
  }
})(ROOT);

// ---- extraction -------------------------------------------------------------
// `var(--x)` — the terminator is required, or a doc comment containing `var(--nexus-*)`
// yields a phantom token named `--nexus-`. Tokens never end in `-`, which also rejects `---`.
const VAR_REF_RE = /var\(\s*(--[a-z0-9]+(?:-[a-z0-9]+)*)\s*[,)]/g;
// Quoted custom properties: JS reads them through helpers, and `GraphPanel`'s broken
// `'--nexus-accent'` is only visible in this form. Three guards, each earned:
//   * a quoted token that is a `+` concatenation is a fragment (`'--nexus-' + key`) — skip
//   * Chromium CLI switches (`'--user-data-dir'`) look identical to custom properties, so a
//     quoted token only counts if it carries the theme prefix or sits on a CSS-var helper line
//   * an object key or `setProperty` argument is a WRITE, not a reference
const QUOTED_RE = /(['"])(--[a-z0-9]+(?:-[a-z0-9]+)*)\1/g;
const VAR_HELPER_RE = /getPropertyValue|setProperty|getComputedStyle|readColor|readVar|cssVar/;
const DEF_RE = /^\s*(--[a-z0-9]+(?:-[a-z0-9]+)*)\s*:/;
const TOKEN_KEY_RE = /^\s*'([a-z0-9-]+)'\s*:\s*'([^']+)'/;
const COLOUR_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\([^)]*\)/g;

// Whole-line comments and trailing `//` only. `(?<!:)` keeps `https://` intact; a `//` inside a
// string literal would still be cut, but the only cost of that is a missed literal, and no such
// line exists today.
const stripComment = (text) => {
  const head = text.trimStart();
  if (head.startsWith('//') || head.startsWith('/*') || head.startsWith('*')) return '';
  const at = text.search(/(?<!:)\/\//);
  return at === -1 ? text : text.slice(0, at);
};

const refs = new Map();       // token -> [{file, line, form}]
const defined = new Map();    // token -> {file, line, reserved}
const literals = [];

const addRef = (token, file, line, form) => {
  if (!refs.has(token)) refs.set(token, []);
  refs.get(token).push({ file, line, form });
};

for (const { rel, full } of files) {
  const lines = readFileSync(full, 'utf8').split(/\r?\n/);
  const isDefs = rel === DEFS_FILE;

  lines.forEach((text, i) => {
    const line = i + 1;

    for (const m of text.matchAll(VAR_REF_RE)) addRef(m[1], rel, line, 'var()');

    const isWrite = /setProperty/.test(text);
    const hasHelper = VAR_HELPER_RE.test(text);
    for (const m of text.matchAll(QUOTED_RE)) {
      const after = text.slice(m.index + m[0].length).trimStart();
      if (after.startsWith('+')) continue;                      // `'--nexus-' + key` fragment
      const isKey = after.startsWith(':');
      if (isKey || isWrite) {
        if (!defined.has(m[2])) defined.set(m[2], { file: rel, line, reserved: false });
      } else if (m[2].startsWith(THEME_PREFIX) || hasHelper) {
        addRef(m[2], rel, line, 'quoted');
      }
    }

    if (isDefs) {
      const k = text.match(TOKEN_KEY_RE);
      if (k && !defined.has(THEME_PREFIX + k[1])) {
        defined.set(THEME_PREFIX + k[1], { file: rel, line, reserved: /@reserved/.test(text) });
      }
      return;
    }

    const d = text.match(DEF_RE);
    if (d) defined.set(d[1], { file: rel, line, reserved: /@reserved/.test(text) });

    if (/@constant/.test(text)) return;
    const code = stripComment(text);
    if (!code) return;
    const values = [...code.matchAll(COLOUR_RE)].map((m) => m[0]);
    if (values.length) literals.push({ file: rel, line, values, text: text.trim() });
  });
}

// ---- rules ------------------------------------------------------------------
const rule1 = [...refs.entries()]
  .filter(([token]) => !defined.has(token))
  .map(([token, sites]) => ({ token, sites }))
  .sort((a, b) => a.token.localeCompare(b.token));

const rule2 = [...defined.entries()]
  .filter(([token, info]) => token.startsWith(THEME_PREFIX) && !refs.has(token) && !info.reserved)
  .map(([token, info]) => ({ token, info }))
  .sort((a, b) => a.token.localeCompare(b.token));

const rule3 = literals;
const literalCount = rule3.reduce((n, l) => n + l.values.length, 0);

const out = [];
const say = (s = '') => out.push(s);
const short = (p) => p.split('/').slice(-3).join('/');

say(`scan root : ${ROOT}`);
say(`files     : ${files.length}`);
say(`defined   : ${defined.size}   referenced: ${refs.size}`);

say(`\n=== [1] referenced but NOT defined (${rule1.length}) ===`);
for (const { token, sites } of rule1) {
  const forms = [...new Set(sites.map((s) => s.form))].join('+');
  say(`  ${token}  x${sites.length} [${forms}]  ${[...new Set(sites.map((s) => short(s.file)))].join(', ')}`);
}
if (!rule1.length) say('  (none)');

say(`\n=== [2] defined but NEVER referenced (${rule2.length}) ===`);
for (const { token, info } of rule2) say(`  ${token}   ${short(info.file)}:${info.line}`);
if (!rule2.length) say('  (none)');

say(`\n=== [3] colour literals outside ${DEFS_FILE} (${literalCount} on ${rule3.length} lines) ===`);
const byFile = new Map();
for (const l of rule3) {
  if (!byFile.has(l.file)) byFile.set(l.file, []);
  byFile.get(l.file).push(l);
}
for (const [file, items] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
  say(`  ${String(items.length).padStart(4)}  ${file}`);
  if (!QUIET) for (const it of items) say(`          ${it.line}: ${it.text}`);
}
if (!rule3.length) say('  (none)');

const failed = rule1.length + rule2.length + literalCount;
say(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${rule1.length} undefined refs, ${rule2.length} unused tokens, ${literalCount} colour literals`);

console.log(out.join('\n'));
process.exit(failed === 0 ? 0 : 1);
