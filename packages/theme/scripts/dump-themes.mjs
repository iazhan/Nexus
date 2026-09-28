#!/usr/bin/env node
// 把内置主题 dump 成 `{ light: { <token>: <colour> }, dark: { … } }` —— design-token-audit skill 的
// contrast-pairs.mjs / contrast-target.mjs 的输入格式。
//
//   node packages/theme/scripts/dump-themes.mjs [--out <file>]
//
// **读 `dist/`，不读源码。** 原实现从 `index.ts` 正则抽手写字面量；接线派生后源码里只剩
// `seedsToTokens(...)` 调用，正则抽不到东西，而且**会静默 dump 出空对象**（下面两条一致性
// 校验都会通过）。改成读构建产物后唯一的代价是「产物可能过期」，所以先比 mtime：`src/**` 里
// 有比 `dist/index.js` 新的文件就拒绝运行 —— 对着过期数字做决策正是本脚本要防的事。
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

const { nexusDark, nexusLight } = await import(pathToFileURL(DIST).href);
const themes = { light: nexusLight.tokens, dark: nexusDark.tokens };

const lightCount = Object.keys(themes.light).length;
const darkCount = Object.keys(themes.dark).length;
if (lightCount !== darkCount) {
  console.error(`亮暗 token 数不一致：light ${lightCount} / dark ${darkCount} —— 先修源码再 dump`);
  process.exit(1);
}
const onlyLight = Object.keys(themes.light).filter((k) => !(k in themes.dark));
const onlyDark = Object.keys(themes.dark).filter((k) => !(k in themes.light));
if (onlyLight.length || onlyDark.length) {
  console.error(`亮暗 token 名不一致：仅 light ${onlyLight} / 仅 dark ${onlyDark}`);
  process.exit(1);
}

const json = JSON.stringify(themes, null, 2);
const out = arg('out');
if (out) {
  writeFileSync(out, json + '\n');
  console.error(`${DIST} → ${out}（${lightCount} 个 token × 2 套）`);
} else {
  process.stdout.write(json + '\n');
}
