/**
 * 从 tinted-theming 的 base16 方案文件生成 `src/presets.ts`。
 *
 * 为什么是生成物而不是手抄：一百多套 × 16 色 = 一千多个色值，手抄必错，而「逐字取自上游」正是
 * 用户要这些主题的理由 —— 手调过的预设既不是上游的、也不是我们的。
 *
 * 四条判据：
 *
 * 1. **族按 `variant` 字段配对，不按 `-light` / `-dark` 后缀。** 暗版不带后缀的方案是存在的
 *    （`nord`、`dracula`），按后缀配对会把它们漏掉 —— 实测少算 21 个族。
 * 2. **只用过了对比度门禁的族。** 门禁函数从 `dist/index.js` 取，它算的是「一套种子派生出什么」，
 *    与出厂表里有哪几套无关，所以「先 build 再生成」不构成循环依赖。
 * 3. **`dracula` 是单变体特例。** 上游只有暗版，而它是既有出厂主题 —— 正交模型要求成对，
 *    但丢掉它等于把老用户的选择抹掉。所以单变体预设是合法形状。
 * 4. **方案名与作者逐字取自上游，预设名用族名的 Title Case。** 上游的 `name` 大小写不统一
 *    （`Gruvbox dark` 对 `Gruvbox Light`），拿它当族名会得到两套命名风格；族名从 id 派生才稳定。
 *
 * 用法：`node packages/theme/scripts/import-schemes.mjs <base16 目录> [--out <文件>]`
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const DIST = join(PKG, 'dist', 'index.js');
const DEFAULT_OUT = join(PKG, 'src', 'presets.ts');

/** 单变体也必须保留的族 —— 理由见文件头第 3 条。 */
const ALWAYS_KEEP = ['dracula'];

const SLOTS = [
  'base00', 'base01', 'base02', 'base03', 'base04', 'base05', 'base06', 'base07',
  'base08', 'base09', 'base0A', 'base0B', 'base0C', 'base0D', 'base0E', 'base0F',
];

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const outFlag = args.indexOf('--out');
const OUT = outFlag === -1 ? DEFAULT_OUT : resolve(args[outFlag + 1]);

if (!dir) {
  console.error('用法: node import-schemes.mjs <tinted-theming 的 base16 目录> [--out <文件>]');
  process.exit(1);
}

const { seedsToTokens, measureTheme } = await import(pathToFileURL(DIST).href);

const unquote = (raw) => raw.trim().replace(/^"(.*)"$/, '$1');

function parseScheme(file) {
  const text = readFileSync(join(dir, file), 'utf8');
  const field = (key) => {
    const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return match ? unquote(match[1]) : null;
  };
  const palette = {};
  for (const slot of SLOTS) {
    const match = text.match(new RegExp(`^\\s+${slot}:\\s*"?(#[0-9a-fA-F]{6})"?`, 'm'));
    if (!match) throw new Error(`${file}: 缺槽位 ${slot}`);
    palette[slot] = match[1].toLowerCase();
  }
  return {
    id: file.replace(/\.yaml$/, ''),
    name: field('name'),
    author: field('author'),
    variant: field('variant'),
    palette,
  };
}

const all = readdirSync(dir).filter((f) => f.endsWith('.yaml')).map(parseScheme);

const failuresOf = (scheme) => measureTheme(seedsToTokens(scheme)).failures.length;

// 族名：去掉结尾的 -light / -dark。同族同 variant 撞车时优先「id 就是族名」的那套。
const families = new Map();
for (const scheme of all) {
  const key = scheme.id.replace(/-(light|dark)$/, '');
  const bucket = families.get(key) ?? {};
  const existing = bucket[scheme.variant];
  if (!existing || scheme.id === key || (existing.id !== key && scheme.id.length < existing.id.length)) {
    bucket[scheme.variant] = scheme;
  }
  families.set(key, bucket);
}

const titleCase = (key) =>
  key.split('-').map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part)).join(' ');

/** 生成物与代码库同为单引号（仓库没有格式化器，这里是唯一能保证风格一致的地方）。 */
const q = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const presets = [];
const skipped = [];

for (const [key, bucket] of [...families].sort(([a], [b]) => a.localeCompare(b))) {
  const light = bucket.light ?? null;
  const dark = bucket.dark ?? null;
  const picked = { light, dark };

  if (ALWAYS_KEEP.includes(key)) {
    if (!light && !dark) continue;
    const kept = light && dark ? picked : (light ?? dark);
    if (failuresOf(kept) > 0) throw new Error(`${key}: 被保留却过不了门禁`);
    presets.push({ id: key, name: titleCase(key), variants: picked });
    continue;
  }

  if (!light || !dark) continue;
  const bad = [];
  if (failuresOf(light) > 0) bad.push(`light:${failuresOf(light)}`);
  if (failuresOf(dark) > 0) bad.push(`dark:${failuresOf(dark)}`);
  if (bad.length > 0) {
    skipped.push(`${key} (${bad.join(' ')})`);
    continue;
  }
  presets.push({ id: key, name: titleCase(key), variants: picked });
}

const schemes = presets
  .flatMap((preset) => [preset.variants.light, preset.variants.dark])
  .filter(Boolean)
  .sort((a, b) => a.id.localeCompare(b.id));

const schemeLiteral = (scheme) => {
  const rows = [];
  for (let i = 0; i < SLOTS.length; i += 4) {
    rows.push(
      '        ' +
        SLOTS.slice(i, i + 4)
          .map((slot) => `${slot}: '${scheme.palette[slot]}'`)
          .join(', ')
    );
  }
  return `  {
    id: ${q(scheme.id)},
    scheme: {
      name: ${q(scheme.name)},
      author: ${q(scheme.author)},
      variant: '${scheme.variant}',
      palette: {
${rows.join(',\n')}
      }
    }
  }`;
};

const presetLiteral = (preset) => {
  const variants = ['light', 'dark']
    .filter((v) => preset.variants[v])
    .map((v) => `${v}: ${q(preset.variants[v].id)}`)
    .join(', ');
  return `  { id: ${q(preset.id)}, name: ${q(preset.name)}, variants: { ${variants} } }`;
};

const body = `/**
 * 生成物，不要手改 —— 由 \`packages/theme/scripts/import-schemes.mjs\` 从 tinted-theming 的
 * \`schemes\` 仓库（\`spec-0.11\` 分支）的 \`base16/*.yaml\` 写出。
 *
 * 重新生成：先 build（门禁函数从 \`dist/\` 取），再
 * \`node packages/theme/scripts/import-schemes.mjs <schemes 检出目录>\`。
 *
 * 只收录**明暗两套都过对比度门禁**的族，外加 \`dracula\`（上游只有暗版，但它是既有出厂主题）。
 * 被门禁挡下的族不会出现在这里，改动上游数据后重跑本脚本即可 —— 不要手工往数组里加条目。
 */

import type { NexusThemeScheme } from './seeds.js';

export interface BuiltInPreset {
  id: string;
  name: string;
  /** 至少有一个。单变体预设（上游只有一版）只填其中一边。 */
  variants: { light?: string; dark?: string };
}

/** ${schemes.length} 套方案。id 与 \`NexusThemeScheme\` 成对，\`BUILT_IN_SCHEMES\` 直接消费。 */
export const BASE16_SCHEMES: readonly { id: string; scheme: NexusThemeScheme }[] = [
${schemes.map(schemeLiteral).join(',\n')}
];

/** ${presets.length} 个族。预设轴选它，模式轴再决定取哪一边。 */
export const BASE16_PRESETS: readonly BuiltInPreset[] = [
${presets.map(presetLiteral).join(',\n')}
];
`;

writeFileSync(OUT, body, 'utf8');

console.log(`[import-schemes] ${presets.length} 个族 / ${schemes.length} 套方案 → ${OUT}`);
if (skipped.length > 0) {
  console.log(`[import-schemes] 门禁挡下 ${skipped.length} 个族: ${skipped.join(', ')}`);
}
