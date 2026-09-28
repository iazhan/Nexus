#!/usr/bin/env node
// 把内置主题写成静态 CSS，交给 renderer 的 index.html 用 <link> 引入。
//
//   node packages/theme/scripts/generate-css.mjs [--out <file>]
//
// 默认落到 `apps/desktop/renderer/public/theme.css`（按脚本自身位置算，与 cwd 无关）。
//
// 这里读 `dist/`，与 dump-themes.mjs 的「正则抽源码、不读 dist」相反 —— 理由不同：那边要的是
// **名字**（正则可以给出），这里要的是**值**。而 CSS 本身是构建产物，predev / prebuild 已经保证
// 主题包先建好，dist 过期由顺序保证，不由脚本猜。
//
// 输出不进版本库（见 .gitignore）：可以从源码完整重建，而 84 行声明进 diff 只会淹没真正的改动。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILT_IN_THEMES } from '../dist/index.js';
import { themesToCss } from '../dist/static-css.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };

const DEFAULT_OUT = fileURLToPath(
  new URL('../../../apps/desktop/renderer/public/theme.css', import.meta.url)
);
const out = resolve(arg('out', DEFAULT_OUT));

const css = themesToCss(BUILT_IN_THEMES);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, css, 'utf8');

const declarations = BUILT_IN_THEMES.reduce((n, theme) => n + Object.keys(theme.tokens).length, 0);
console.log(`[theme] ${BUILT_IN_THEMES.length} 套内置主题 / ${declarations} 条声明 → ${out}`);
