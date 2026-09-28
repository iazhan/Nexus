#!/usr/bin/env node
// 把主题源码 dump 成 `{ light: { <token>: <colour> }, dark: { … } }` —— contrast-pairs.mjs /
// contrast-target.mjs 的输入格式。
//
//   node packages/theme/scripts/dump-themes.mjs [--out <file>]
//
// 为什么要有这一件：那两个工具读的是 JSON，而手敲 JSON 就是"再造一份真理来源"——
// 值改了 JSON 不会跟着改，然后你会对着过期数字做决策。这里**从源码正则抽**，
// 不读 `dist/`（构建产物可能过期，而且它是 gitignore 的）。
//
// token 键不带 `--nexus-` 前缀：工具按 `text-*` / `bg-*` / `status-*-bg` 这些裸名做作用域配对。

import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };

const DEFS = arg('defs', 'packages/theme/src/index.ts');
const src = readFileSync(DEFS, 'utf8');

/** 取 `export const <name>` 到该对象字面量结尾（顶层 `};`）之间的文本。 */
function blockOf(name) {
  const start = src.indexOf(`export const ${name}`);
  if (start === -1) throw new Error(`${DEFS}: 找不到 export const ${name}`);
  const end = src.indexOf('\n};', start);
  if (end === -1) throw new Error(`${DEFS}: ${name} 的对象字面量没有闭合`);
  return src.slice(start, end);
}

// 行锚定 + 整行匹配：不加 `^` 会把三元表达式里的字符串也当成 token 定义
// （`type === 'dark' ? 'nexus-dark' : 'nexus-light'` 会造出幻影 token）。
function tokensOf(name) {
  const tokens = {};
  for (const m of blockOf(name).matchAll(/^[ \t]*'([a-z0-9-]+)'[ \t]*:[ \t]*'([^']+)'[ \t]*,?[ \t]*$/gm)) {
    tokens[m[1]] = m[2];
  }
  return tokens;
}

const themes = {
  light: tokensOf('nexusLight'),
  dark: tokensOf('nexusDark'),
};

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
  console.error(`${DEFS} → ${out}（${lightCount} 个 token × 2 套）`);
} else {
  process.stdout.write(json + '\n');
}
