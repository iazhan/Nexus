#!/usr/bin/env node
// 主题系统的 token 门禁 —— 三条规则，只在「改坏了东西」时失败：
//
//   1. 每个自定义属性引用都有定义（任意前缀：运行时 var 的拼写错误与 token 拼错是同一类 bug）
//   2. 每个定义出的 `--nexus-*` token 都被引用，或标了 `@reserved`
//   3. 定义文件之外没有颜色字面量，除非标了 `@constant`
//
// 定义从哪来：颜色字面量看 `seeds.ts` + `presets.ts`（16 色种子），token 名看 `derive.ts`（派生函数）。
// 接线派生之前 token 名是 `index.ts` 里的字面量，现在是 `seedsToTokens()` 的输出。
//
// 用法：node packages/theme/scripts/audit-tokens.mjs [--root <dir>] [--quiet]
//
// 规则 1 必须先过才能剥掉消费侧的兜底色 —— 兜底还在时，断掉的引用只退化成近似色而不是可见的
// 失败，反过来做会留下一个「看着像主题系统坏了」的中间态。
//
// 豁免是行级的、必须显式（`@reserved` 有意但暂无调用点；`@constant` 有意与主题无关，如阴影、
// 平台红）—— 「没被测到」绝不能看起来像「通过了」。
//
// 规则 3 读代码不读散文：解释 `rgb()` 语法或举例颜色的注释是文档，不是硬编码颜色 —— 否则写
// 一句关于颜色语法的注释就会让门禁失败，而人们会选择不再写注释。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const ROOT = arg('root', '.');
const QUIET = argv.includes('--quiet');

// 色值定义文件：色值在这里按定义就是字面量，规则 3 不扫它们。
// `seeds.ts` 是 Nexus 自己那两族的 16 色种子；`presets.ts` 是从 tinted-theming 逐字抄下来的
// 一百多套方案（生成物，105 × 16 = 1680 个 hex）。两处都**只进不出** —— 派生的 42 个 token
// 一个都不在这里出现，所以「别处出现色值」这条规则没有被削弱。
const DEFS_FILES = new Set([
  'packages/theme/src/seeds.ts',
  'packages/theme/src/presets.ts'
]);
const DEFS_LABEL = [...DEFS_FILES].join(', ');
// token 名的定义处。`index.ts` 接线派生后只剩 `seedsToTokens(...)` 调用，43 个字面量全在
// `derive.ts`：显式赋值目标 `tokens['x'] =` 与规则表键 `'x': { slot:`。新加 token 按这两种
// 形状写就能被认出来 —— 否则规则 1 会把全部 `var(--nexus-*)` 报成未定义。
const TOKEN_NAME_FILES = new Set(['packages/theme/src/derive.ts']);
const TOKEN_ASSIGN_RE = /tokens\['([a-z0-9-]+)'\]/g;
const RULE_KEY_RE = /^\s*'([a-z0-9-]+)'\s*:\s*\{\s*slot:/;
const THEME_PREFIX = '--nexus-';
// `public/` 与 dist / out 同类：里面是构建期复制或生成的东西（pdfjs 的 185 个二进制、
// 由 `builtInThemes()` 生成的 theme.css），改不了也不该改，扫进来只会让规则 3 恒红。
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'public', '.git', '.workbuddy-ai', '.serena', 'coverage']);
const SCAN_EXT = /\.(ts|tsx|css)$/;

// test/ 与 fixtures/ 排除：它们本来就断言颜色，算进来只会让规则 3 变成会被静音的噪声。
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

// ---- 提取 ----------------------------------------------------------------
// 终结符是必需的，否则含 `var(--nexus-*)` 的文档注释会产出名为 `--nexus-` 的幽灵 token；
// token 不以 `-` 结尾，这同时排掉了 `---`。
const VAR_REF_RE = /var\(\s*(--[a-z0-9]+(?:-[a-z0-9]+)*)\s*[,)]/g;
// 带引号的自定义属性：JS 通过 helper 读它们，字符串里的 token 只有这种形式才看得见。三条守卫：
//   * 后面跟 `+` 的是拼接片段（`'--nexus-' + key`），跳过
//   * Chromium 命令行开关（`'--user-data-dir'`）与自定义属性同形，所以只有带主题前缀、
//     或落在 CSS-var helper 行上的才算引用
//   * 对象键与 `setProperty` 参数是写入，不是引用
const QUOTED_RE = /(['"])(--[a-z0-9]+(?:-[a-z0-9]+)*)\1/g;
const VAR_HELPER_RE = /getPropertyValue|setProperty|getComputedStyle|readColor|readVar|cssVar/;
const DEF_RE = /^\s*(--[a-z0-9]+(?:-[a-z0-9]+)*)\s*:/;
const TOKEN_KEY_RE = /^\s*'([a-z0-9-]+)'\s*:\s*'([^']+)'/;
const COLOUR_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\([^)]*\)/g;

// 只剥整行注释与行尾 `//`。`(?<!:)` 保住 `https://`；字符串里的 `//` 也会被切，代价只是漏掉
// 一个字面量，而目前没有这种行。
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
  const isDefs = DEFS_FILES.has(rel);
  const isTokenNames = TOKEN_NAME_FILES.has(rel);

  lines.forEach((text, i) => {
    const line = i + 1;

    for (const m of text.matchAll(VAR_REF_RE)) addRef(m[1], rel, line, 'var()');

    const isWrite = /setProperty/.test(text);
    const hasHelper = VAR_HELPER_RE.test(text);
    for (const m of text.matchAll(QUOTED_RE)) {
      const after = text.slice(m.index + m[0].length).trimStart();
      if (after.startsWith('+')) continue;                      // `'--nexus-' + key` 片段
      const isKey = after.startsWith(':');
      if (isKey || isWrite) {
        if (!defined.has(m[2])) defined.set(m[2], { file: rel, line, reserved: false });
      } else if (m[2].startsWith(THEME_PREFIX) || hasHelper) {
        addRef(m[2], rel, line, 'quoted');
      }
    }

    if (isDefs || isTokenNames) {
      const names = [...text.matchAll(TOKEN_ASSIGN_RE)].map((m) => m[1]);
      const ruleKey = isTokenNames ? text.match(RULE_KEY_RE) : null;
      if (ruleKey) names.push(ruleKey[1]);
      const keyLiteral = text.match(TOKEN_KEY_RE);
      if (keyLiteral) names.push(keyLiteral[1]);
      for (const name of names) {
        if (!defined.has(THEME_PREFIX + name)) {
          defined.set(THEME_PREFIX + name, { file: rel, line, reserved: /@reserved/.test(text) });
        }
      }
      if (isDefs) return;
    }

    const d = text.match(DEF_RE);
    if (d) defined.set(d[1], { file: rel, line, reserved: /@reserved/.test(text) });

    if (/@constant/.test(text)) return;
    const code = stripComment(text);
    if (!code) return;
    // 拼出颜色的模板字符串（`rgba(${r}, ${g}, ...)`）不是字面量：正则会在插值里的第一个 `)`
    // 处停住。
    const values = [...code.matchAll(COLOUR_RE)].map((m) => m[0]).filter((v) => !v.includes('${'));
    if (values.length) literals.push({ file: rel, line, values, text: text.trim() });
  });
}

// ---- 规则 ------------------------------------------------------------------
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

say(`扫描根目录 : ${ROOT}`);
say(`文件数     : ${files.length}`);
say(`已定义     : ${defined.size}   被引用: ${refs.size}`);

say(`\n=== [1] 被引用但未定义 (${rule1.length}) ===`);
for (const { token, sites } of rule1) {
  const forms = [...new Set(sites.map((s) => s.form))].join('+');
  say(`  ${token}  x${sites.length} [${forms}]  ${[...new Set(sites.map((s) => short(s.file)))].join(', ')}`);
}
if (!rule1.length) say('  （无）');

say(`\n=== [2] 已定义但从未被引用 (${rule2.length}) ===`);
for (const { token, info } of rule2) say(`  ${token}   ${short(info.file)}:${info.line}`);
if (!rule2.length) say('  （无）');

say(`\n=== [3] ${DEFS_LABEL} 之外的颜色字面量 (${literalCount} 个 / ${rule3.length} 行) ===`);
const byFile = new Map();
for (const l of rule3) {
  if (!byFile.has(l.file)) byFile.set(l.file, []);
  byFile.get(l.file).push(l);
}
for (const [file, items] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
  say(`  ${String(items.length).padStart(4)}  ${file}`);
  if (!QUIET) for (const it of items) say(`          ${it.line}: ${it.text}`);
}
if (!rule3.length) say('  （无）');

const failed = rule1.length + rule2.length + literalCount;
say(`\n${failed === 0 ? 'PASS' : 'FAIL'} —— ${rule1.length} 个未定义引用, ${rule2.length} 个未使用 token, ${literalCount} 个颜色字面量`);

console.log(out.join('\n'));
process.exit(failed === 0 ? 0 : 1);
