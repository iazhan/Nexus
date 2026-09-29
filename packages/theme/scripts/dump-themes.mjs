#!/usr/bin/env node
// 把内置主题 dump 成 `{ light: { <token>: <colour> }, dark: { … }, <theme id>: { … } }` ——
// design-token-audit skill 的 contrast-pairs.mjs / contrast-target.mjs 的输入格式。
//
//   node packages/theme/scripts/dump-themes.mjs [--out <file>]
//
// **读 `dist/`，不读源码。** 原实现从 `index.ts` 正则抽手写字面量；接线派生后源码里只剩
// `seedsToTokens(...)` 调用，正则抽不到东西，而且**会静默 dump 出空对象**（下面两条一致性
// 校验都会通过）。改成读构建产物后唯一的代价是「产物可能过期」，所以先比 mtime：`src/**` 里
// 有比 `dist/index.js` 新的文件就拒绝运行 —— 对着过期数字做决策正是本脚本要防的事。
//
// 键有两套，**都要留**：
//   * `<theme id>`（`nexus-light` / `dracula` / …）—— 出厂主题表有几套这里就有几套，随
//     `BUILT_IN_SCHEMES` 自动跟随。
//   * `light` / `dark` —— 外部对比度工具按这两个键取配对。删了它们工具会**静默找不到主题**
//     （而不是报错），所以它们是显式的兼容键，固定指向基线那两套。
//
// token 键不带 `--nexus-` 前缀：工具按 `text-*` / `bg-*` / `status-*-bg` 这些裸名做作用域配对。

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PKG, 'src');
const DIST = join(PKG, 'dist', 'index.js');

const newestMtime = (dir) => {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
};

let distStamp;
try {
  distStamp = statSync(DIST).mtimeMs;
} catch {
  console.error(`${DIST} 不存在 —— 先跑 pnpm --filter @nexus/theme build`);
  process.exit(1);
}
if (newestMtime(SRC) > distStamp) {
  console.error('src/ 比 dist/ 新 —— 先跑 pnpm --filter @nexus/theme build 再 dump');
  process.exit(1);
}

const { builtInThemes } = await import(pathToFileURL(DIST).href);

const builtIns = builtInThemes();
const themes = {};
for (const theme of builtIns) themes[theme.id] = theme.tokens;

// 外部对比度工具的兼容键。基线主题不在表里就直接报错 —— 静默少两个键比报错更难查。
for (const [alias, id] of [
  ['light', 'nexus-light'],
  ['dark', 'nexus-dark'],
]) {
  const baseline = themes[id];
  if (!baseline) {
    console.error(`基线主题 ${id} 不在内置主题表里 —— light / dark 兼容键无法生成`);
    process.exit(1);
  }
  themes[alias] = baseline;
}

const names = builtIns.map((theme) => theme.id);
const counts = new Set(names.map((id) => Object.keys(themes[id]).length));
if (counts.size !== 1) {
  console.error(
    `各主题 token 数不一致：${names.map((id) => `${id} ${Object.keys(themes[id]).length}`).join(' / ')} —— 先修源码再 dump`
  );
  process.exit(1);
}

const reference = Object.keys(themes[names[0]]).sort();
for (const id of names.slice(1)) {
  const onlyHere = Object.keys(themes[id]).filter((k) => !reference.includes(k));
  const missing = reference.filter((k) => !(k in themes[id]));
  if (onlyHere.length || missing.length) {
    console.error(`主题 ${id} 的 token 名与 ${names[0]} 不一致：多 ${onlyHere} / 少 ${missing}`);
    process.exit(1);
  }
}

const json = JSON.stringify(themes, null, 2);
const out = arg('out');
const tokenCount = counts.values().next().value;
if (out) {
  writeFileSync(out, json + '\n');
  console.error(
    `${DIST} → ${out}（${tokenCount} 个 token × ${names.length} 套 + light/dark 兼容键）`
  );
} else {
  process.stdout.write(json + '\n');
}
