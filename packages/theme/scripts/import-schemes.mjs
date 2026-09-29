/**
 * 从 tinted-theming 的 base16 方案文件生成 `src/presets.ts`。
 *
 * 为什么是生成物而不是手抄：二十个族 × 明暗两版 × 16 色 = 六百多个色值，手抄必错，而「逐字取自
 * 上游」正是用户要这些主题的理由 —— 手调过的预设既不是上游的、也不是我们的。
 *
 * 五条判据：
 *
 * 1. **收录哪些族由 `FAMILIES` 白名单决定**，不是「上游有什么就全放进去」。上游 352 个文件、
 *    一百多个族，全放进去等于把主题选择变成浏览；出厂表是产品决策，写在代码里。
 * 2. **明暗两套显式配对**，不靠 `-light` / `-dark` 后缀猜。上游有两处不能靠后缀配对：`one-light`
 *    与 `onedark` 是两个族名却是一套主题的明暗两面；`tomorrow` 只有浅版，暗版叫 `tomorrow-night`。
 *    白名单里省略 `light` / `dark` 时才按惯例找 `<id>` / `<id>-light` / `<id>-dark`。
 * 3. **只用过了对比度门禁的族**，容差见 `GATE_EPSILON`。门禁函数从 `dist/index.js` 取，它算的是
 *    「一套种子派生出什么」，与出厂表里有哪几套无关，所以「先 build 再生成」不构成循环依赖。
 * 4. **方案名与作者逐字取自上游，预设名取自白名单。** 上游的 `name` 大小写不统一
 *    （`Gruvbox dark` 对 `Gruvbox Light`），拿它当族名会得到两套命名风格；白名单里的名字才是
 *    界面上显示的那个（`GitHub` 不是 `Github`，`Harmonic` 不是 `Harmonic16`）。
 * 5. **明暗两套必须齐全。** 单边主题在界面上是条死路（切到另一边时模式控件禁用，退到它有的那
 *    一版），而白名单是**挑**出来的，没有「上游只出一版只能将就」这回事 —— 缺一边就报错，
 *    让写白名单的人去决定配哪一套，而不是静默出一个半套主题。
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

/**
 * 出厂表收录哪些族、叫什么、明暗各取哪一套 —— **这就是产品决策**，见文件头第 1 条。
 *
 * `name` 是界面上显示的名字（白名单说了算，不是上游的 `name`）；`light` / `dark` 省略时按惯例
 * 配对。改这个数组之后重跑本脚本，不要直接改 `src/presets.ts`。
 */
const FAMILIES = [
  { id: 'default', name: 'Default' },
  { id: 'ayu', name: 'Ayu' },
  { id: 'github', name: 'GitHub' },
  // 上游把这两版拆成两个族名（`one-light` / `onedark`），但它们是同一套主题的明暗两面。
  { id: 'one', name: 'OneDark / One Light', light: 'one-light', dark: 'onedark' },
  { id: 'solarized', name: 'Solarized' },
  // 上游的 `tomorrow` 只有浅版，暗版叫 `tomorrow-night`。
  { id: 'tomorrow', name: 'Tomorrow', light: 'tomorrow', dark: 'tomorrow-night' },
  { id: 'gruvbox', name: 'Gruvbox' },
  { id: 'nord', name: 'Nord' },
  { id: 'google', name: 'Google' },
  // 上游族名带版本号（`harmonic16`），界面上叫 Harmonic。
  { id: 'harmonic16', name: 'Harmonic' },

  { id: 'atelier-cave', name: 'Atelier Cave' },
  { id: 'atelier-dune', name: 'Atelier Dune' },
  { id: 'atelier-estuary', name: 'Atelier Estuary' },
  { id: 'atelier-forest', name: 'Atelier Forest' },
  { id: 'atelier-heath', name: 'Atelier Heath' },
  { id: 'atelier-lakeside', name: 'Atelier Lakeside' },
  { id: 'atelier-plateau', name: 'Atelier Plateau' },
  { id: 'atelier-savanna', name: 'Atelier Savanna' },
  { id: 'atelier-seaside', name: 'Atelier Seaside' },
  { id: 'atelier-sulphurpool', name: 'Atelier Sulphurpool' }
];

/**
 * 门禁容差。**只放宽到「修正循环的余量差一点没吃掉」这一种情形。**
 *
 * `text-muted` / `text-secondary` 是对着**一个**底（`binding`）修正的，目标 `4.5 × 1.02`；
 * 而体检要对着 `bg-surface-active` 等**所有**底各测一遍，那一个比 `binding` 更暗，吃掉 2.2% 的
 * 余量。三个上游配色因此停在 4.4888–4.4907 —— 差 0.2%，是余量不够，不是配色不行。
 *
 * 卡在这个量级是刻意的：真不达标的配色差得远（被挡下的族里最低 3.4），不会因为 0.02 混进来。
 * 而且白名单已经限定了考察范围，容差只可能作用在白名单内的族上。**超出容差一律报错**，
 * 不是静默跳过 —— 白名单是挑出来的，挑中的族过不了门禁要让人来决定，不能让脚本替人决定。
 */
const GATE_EPSILON = 0.02;

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
const byId = new Map(all.map((scheme) => [scheme.id, scheme]));

const failuresOf = (scheme) => measureTheme(seedsToTokens(scheme)).failures;

/** 白名单里显式点名的那一套。名字与 `variant` 都要对得上 —— 写错了要当场知道，不是少一套。 */
function named(id, variant) {
  const scheme = byId.get(id);
  if (!scheme) throw new Error(`白名单引用了上游不存在的方案：${id}`);
  if (scheme.variant !== variant) {
    throw new Error(`${id} 的 variant 是 ${scheme.variant}，白名单当它是 ${variant}`);
  }
  return scheme;
}

/**
 * 族 → 明暗两套。显式点名的优先；否则按惯例找 `<id>` / `<id>-light` / `<id>-dark`。
 * 两套都找不齐就报错（文件头第 5 条），不静默出一个半套主题。
 */
function variantsOf(entry) {
  const bucket = { light: null, dark: null };
  if (entry.light || entry.dark) {
    if (entry.light) bucket.light = named(entry.light, 'light');
    if (entry.dark) bucket.dark = named(entry.dark, 'dark');
  } else {
    for (const candidate of [entry.id, `${entry.id}-light`, `${entry.id}-dark`]) {
      const scheme = byId.get(candidate);
      if (scheme) bucket[scheme.variant] = scheme;
    }
  }
  for (const variant of ['light', 'dark']) {
    if (!bucket[variant]) {
      throw new Error(
        `${entry.id}: 上游缺 ${variant} 一版。白名单里的族必须两版齐全 —— 要么显式配对，要么从白名单里拿掉`
      );
    }
  }
  return bucket;
}

/** 生成物与代码库同为单引号（仓库没有格式化器，这里是唯一能保证风格一致的地方）。 */
const q = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const presets = [];
/** 落在容差内、但确实贴线的那几对 —— 打出来是为了「这些主题的体检面板会有一两行不达标」有据可查。 */
const slack = [];

for (const entry of FAMILIES) {
  const variants = variantsOf(entry);

  for (const scheme of [variants.light, variants.dark]) {
    const failures = failuresOf(scheme);
    if (failures.length === 0) continue;
    const gap = Math.max(...failures.map((failure) => failure.threshold - failure.ratio));
    if (gap > GATE_EPSILON) {
      throw new Error(
        `${entry.id}/${scheme.id}: ${failures.length} 对不达标，最差差 ${gap.toFixed(3)}（容差 ${GATE_EPSILON}）`
      );
    }
    slack.push(`${entry.id}/${scheme.id} 差 ${gap.toFixed(3)}`);
  }

  presets.push({ id: entry.id, name: entry.name, variants });
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
 * 收录哪些族由生成器里的 \`FAMILIES\` 白名单决定 —— 改白名单后重跑本脚本，**不要手工改这个文件**。
 * 明暗两套都过对比度门禁（容差见生成器的 \`GATE_EPSILON\`），缺一边或超出容差都会让生成失败。
 */

import type { NexusThemeScheme } from './seeds.js';

export interface BuiltInPreset {
  id: string;
  name: string;
  /**
   * 明暗两套。**出厂表里恒为两版齐全**（白名单要求），可选是因为这个形状要跟用户主题共用
   * —— 用户主题可以只有一边。
   */
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
if (slack.length > 0) {
  console.log(`[import-schemes] ${slack.length} 套贴线但落在容差内: ${slack.join(', ')}`);
}
