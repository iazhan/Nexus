#!/usr/bin/env node
// 把主题源码里的 token 值换算成 OKLCH，按色相分组统计。
//
//   node packages/theme/scripts/probe-palette.mjs [--defs <file>] [--min-chroma 0.04]
//
// 回答的问题是「这套配色实际用掉几个色相」。base16 只提供 7 个色相槽位（base08–base0E），
// 用掉的色相多于 7 个时，必然有 token 要被折到邻近槽位上。
//
// 用 OKLCH 而不是 HSL：HSL 的 L 与感知亮度不成比例，暗色主题里两个「同色相」的颜色
// 在 HSL 下会被判成不同色相。
//
// 抽值的正则与另一支 dump 脚本同源，改一处要改两处。

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };

const DEFS = arg('defs', 'packages/theme/src/index.ts');
const MIN_CHROMA = Number(arg('min-chroma', '0.04'));
const src = readFileSync(DEFS, 'utf8');

function blockOf(name) {
  const start = src.indexOf(`export const ${name}`);
  if (start === -1) throw new Error(`${DEFS}: 找不到 export const ${name}`);
  const end = src.indexOf('\n};', start);
  if (end === -1) throw new Error(`${DEFS}: ${name} 的对象字面量没有闭合`);
  return src.slice(start, end);
}

function tokensOf(name) {
  const tokens = {};
  for (const m of blockOf(name).matchAll(/^[ \t]*'([a-z0-9-]+)'[ \t]*:[ \t]*'([^']+)'[ \t]*,?[ \t]*$/gm)) {
    tokens[m[1]] = m[2];
  }
  return tokens;
}

// ---- 取色 ----------------------------------------------------------------
function parse(c) {
  const s = String(c).trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('');
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length < 3) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}

// sRGB → OKLab（Björn Ottosson），再取 L / C / H。
function oklch({ r, g, b }) {
  const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, Bb);
  let H = (Math.atan2(Bb, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H };
}

// 色相命名区间，仅用于输出可读性；判据是 OKLCH 的 H。
const HUE_NAMES = [
  [15, '红'], [45, '橙'], [75, '黄'], [105, '黄绿'], [150, '绿'],
  [195, '青'], [255, '蓝'], [300, '紫'], [330, '品红'], [361, '红'],
];
const hueName = (h) => HUE_NAMES.find(([max]) => h < max)[1];

const themes = { light: tokensOf('nexusLight'), dark: tokensOf('nexusDark') };

for (const [themeName, tokens] of Object.entries(themes)) {
  const rows = Object.entries(tokens)
    .map(([name, value]) => {
      const c = parse(value);
      if (!c || c.a < 1) return { name, value, alpha: c ? c.a : null, ...(c ? oklch(c) : { L: NaN, C: NaN, H: NaN }) };
      return { name, value, alpha: 1, ...oklch(c) };
    });

  console.log(`\n=== ${themeName} — ${rows.length} 个 token ===`);
  console.log(`  ${'token'.padEnd(26)} ${'value'.padEnd(24)} ${'L'.padStart(6)} ${'C'.padStart(6)} ${'H'.padStart(7)}  hue`);
  for (const r of rows) {
    const hue = Number.isNaN(r.H) ? '' : r.C >= MIN_CHROMA ? hueName(r.H) : '中性';
    const mark = r.alpha !== null && r.alpha < 1 ? ` a=${r.alpha}` : '';
    console.log(
      `  ${r.name.padEnd(26)} ${String(r.value + mark).padEnd(24)} ` +
      `${r.L.toFixed(3).padStart(6)} ${r.C.toFixed(3).padStart(6)} ${(Number.isNaN(r.H) ? '-' : r.H.toFixed(1)).padStart(7)}  ${hue}`,
    );
  }

  // 有色相的 token 按 20° 一桶聚类，看实际用掉几个色相。
  const buckets = new Map();
  for (const r of rows) {
    if (Number.isNaN(r.H) || r.C < MIN_CHROMA) continue;
    const bucket = Math.floor(r.H / 20) * 20;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(r);
  }
  const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  console.log(`\n  色相簇（C >= ${MIN_CHROMA}，20° 一桶）：${sorted.length} 个`);
  for (const [bucket, list] of sorted) {
    const values = [...new Set(list.map((r) => r.value))];
    console.log(`    H ${String(bucket).padStart(3)}–${bucket + 19}  ${hueName(bucket + 10).padEnd(3)}  ` +
      `${String(list.length).padStart(2)} token / ${String(values.length).padStart(2)} 值  ${values.join(' ')}`);
  }
}
console.log('');
