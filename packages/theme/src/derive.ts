/**
 * `seedsToTokens()` —— 16 色种子 → 42 个语义 token 的纯计算。
 *
 * 六段顺序有依赖，不能重排：背景梯度 → 边框 → 中性文字 → accent → 语法与状态 → 半透明。
 * 中性三级走配额分配（相对 `binding`：离正文色最近的通用背景），而非逐 token 最小修正 ——
 * 最小修正会让相邻层级收敛到同一个灰阶。有色相的 token 走「槽位色 + 明度偏移 + 最小修正」。
 *
 * 三处代码里看不出来的判据：
 *
 * - `accent-primary` 兼按钮底与图形，取图形优先 —— 压暗到能承白字会让 focus ring 掉到 1.78:1。
 * - 按钮文字取黑取白不用亮度阈值，判据是「白字达标就用白字」；0.179 会误判主色蓝。
 * - `mix(a, b, t)` 的 `t` 朝 `b` 走，写反会得到深蓝。
 *
 * 其余不变量（三级可分、按钮文字 4.5、accent 图形 3:1、中性不继承 base04 色相）都有测试守着。
 */

import {
  composite,
  contrastRatio,
  GENERAL_SURFACES,
  TIER_MIN_RATIO,
  type Rgba,
} from './contrast.js';
import { mix, mustParse, oklchToRgb, rgbToOklch, shiftLightness, toHex, withLightness } from './oklch.js';
import { type Base16Slot, type NexusThemeScheme, type Tuning } from './seeds.js';

type Variant = 'light' | 'dark';
type Direction = 'darker' | 'lighter';

const DEFAULT_TUNING: Record<Variant, Required<Tuning>> = {
  light: { surfaceHover: 0.06, surfaceActive: 0.1, quote: 0.14, borderSubtle: 0.5, borderStrong: 0.45 },
  dark: { surfaceHover: 0.03, surfaceActive: 0.11, quote: 0.16, borderSubtle: 0.43, borderStrong: 0.17 },
};

const directionFor = (variant: Variant): Direction => (variant === 'light' ? 'darker' : 'lighter');

const WHITE_TEXT: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK_TEXT: Rgba = { r: 0, g: 0, b: 0, a: 1 };

const TEXT_MIN = TIER_MIN_RATIO.text;
const GRAPHICAL_MIN = TIER_MIN_RATIO.graphical;

function atRatio(fg: Rgba, bg: Rgba, target: number, dir: Direction): Rgba {
  if (contrastRatio(fg, bg) >= target) return fg;
  const start = rgbToOklch(fg).l;
  const step = dir === 'lighter' ? 0.002 : -0.002;
  let current = fg;
  for (let i = 1; i <= 400; i += 1) {
    const l = start + step * i;
    if (l <= 0 || l >= 1) break;
    current = withLightness(fg, l);
    if (contrastRatio(current, bg) >= target) break;
  }
  return current;
}

const rgbaString = ({ r, g, b, a }: Rgba): string =>
  a >= 1 ? toHex({ r, g, b, a }) : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;

interface Rule {
  slot: Base16Slot;
  dl?: number;
  alpha?: number;
}

const RULES: Record<Variant, Record<string, Rule>> = {
  light: {
    'syntax-heading': { slot: 'base07' },
    'syntax-keyword': { slot: 'base0D', dl: -0.115 },
    'syntax-control': { slot: 'base0E' },
    'syntax-module': { slot: 'base0E' },
    'syntax-string': { slot: 'base08' },
    'syntax-comment': { slot: 'base0B' },
    'syntax-number': { slot: 'base0B', dl: 0.028 },
    'syntax-bool': { slot: 'base0D', dl: -0.115 },
    'syntax-function': { slot: 'base0F' },
    'syntax-variable': { slot: 'base0D', dl: -0.281 },
    'syntax-property': { slot: 'base0D', dl: -0.281 },
    'syntax-type': { slot: 'base0C' },
    'syntax-operator': { slot: 'base07' },
    'syntax-punctuation': { slot: 'base05' },
    'syntax-builtin': { slot: 'base0D', dl: -0.281 },
    'syntax-url': { slot: 'base0D' },
    'syntax-inline-code-text': { slot: 'base05', dl: -0.043 },
    'status-success-text': { slot: 'base0B', dl: -0.088 },
    'status-success-border': { slot: 'base0B', dl: 0.253 },
    'status-warning-text': { slot: 'base09' },
    'status-warning-border': { slot: 'base0A' },
    'status-error-text': { slot: 'base08', dl: -0.015 },
    'status-error-border': { slot: 'base08', dl: 0.252 },
  },
  dark: {
    'syntax-heading': { slot: 'base07' },
    'syntax-keyword': { slot: 'base0D', dl: -0.047 },
    'syntax-control': { slot: 'base0E' },
    'syntax-module': { slot: 'base0E' },
    'syntax-string': { slot: 'base09' },
    'syntax-comment': { slot: 'base0B' },
    'syntax-number': { slot: 'base0B', dl: 0.191 },
    'syntax-bool': { slot: 'base0D', dl: -0.047 },
    'syntax-function': { slot: 'base0F' },
    'syntax-variable': { slot: 'base0D', dl: 0.145 },
    'syntax-property': { slot: 'base0D', dl: 0.145 },
    'syntax-type': { slot: 'base0C' },
    'syntax-operator': { slot: 'base05', dl: 0.025 },
    'syntax-punctuation': { slot: 'base05', dl: 0.025 },
    'syntax-builtin': { slot: 'base0C' },
    'syntax-url': { slot: 'base0D' },
    'syntax-inline-code-text': { slot: 'base05', dl: 0.073 },
    'status-success-text': { slot: 'base0C', dl: 0.013 },
    'status-success-border': { slot: 'base0C', alpha: 0.4 },
    'status-warning-text': { slot: 'base0A' },
    'status-warning-border': { slot: 'base0A', alpha: 0.4 },
    'status-error-text': { slot: 'base08' },
    'status-error-border': { slot: 'base08', alpha: 0.4 },
  },
};

const STATUS_BG_TOWARD_CANVAS = 0.85;
const STATUS_BG_SLOT: Record<string, Base16Slot> = {
  'status-warning-bg': 'base0A',
  'status-error-bg': 'base08',
};

export function seedsToTokens(scheme: NexusThemeScheme): Record<string, string> {
  const variant = scheme.variant;
  const tuning = { ...DEFAULT_TUNING[variant], ...scheme.tuning };
  const dir = directionFor(variant);

  const raw: Record<string, Rgba> = {};
  for (const [slot, value] of Object.entries(scheme.palette)) {
    raw[slot] = mustParse(value, `${scheme.name} 的 ${slot}`);
  }
  const seed = (slot: Base16Slot): Rgba => raw[slot] as Rgba;
  const tokens: Record<string, Rgba> = {};

  // ---- 1. 背景梯度 ----
  const canvas = seed('base00');
  const surface = seed('base01');
  tokens['bg-canvas'] = canvas;
  tokens['bg-surface'] = surface;
  tokens['bg-surface-hover'] = mix(surface, seed('base05'), tuning.surfaceHover);
  tokens['bg-surface-active'] = mix(surface, seed('base05'), tuning.surfaceActive);
  tokens['bg-quote'] = mix(canvas, seed('base0D'), tuning.quote);

  // ---- 2. 边框 ----
  tokens['border-subtle'] = mix(canvas, seed('base02'), tuning.borderSubtle);
  tokens['border-default'] = seed('base02');
  tokens['border-strong'] = mix(seed('base02'), seed('base05'), tuning.borderStrong);

  // ---- 3. 中性文字 ----
  const canvasL = rgbToOklch(canvas).l;
  const primarySeedL = rgbToOklch(seed('base05')).l;
  let binding = canvas;
  let bindingDistance = Math.abs(canvasL - primarySeedL);
  for (const name of GENERAL_SURFACES) {
    const colour = tokens[name];
    if (!colour) continue;
    const resolved = colour.a < 1 ? composite(colour, canvas) : colour;
    const distance = Math.abs(rgbToOklch(resolved).l - primarySeedL);
    if (distance < bindingDistance) {
      bindingDistance = distance;
      binding = resolved;
    }
  }

  const primary = atRatio(seed('base05'), binding, TEXT_MIN, dir);
  const primaryRatio = contrastRatio(primary, binding);
  const guardOk = primaryRatio >= TEXT_MIN * 1.1 ** 2;
  tokens['text-primary'] = primary;

  const reference = rgbToOklch(primary);
  const neutral = (colour: Rgba, target: number): Rgba => {
    const corrected = atRatio(colour, binding, target, dir);
    return oklchToRgb({ l: rgbToOklch(corrected).l, c: reference.c, h: reference.h });
  };

  if (guardOk) {
    tokens['text-muted'] = neutral(seed('base03'), TEXT_MIN * 1.02);
    tokens['text-secondary'] = neutral(seed('base04'), Math.sqrt(TEXT_MIN * primaryRatio));
  } else {
    tokens['text-muted'] = neutral(seed('base03'), TEXT_MIN);
    tokens['text-secondary'] = neutral(seed('base04'), TEXT_MIN);
  }

  // ---- 4. accent 家族 ----
  const accentSeed = seed('base0D');
  const solid = atRatio(accentSeed, binding, GRAPHICAL_MIN, dir);
  const onAccentIsBlack = contrastRatio(WHITE_TEXT, solid) < TEXT_MIN;
  tokens['accent-primary'] = solid;
  tokens['accent-contrast'] = onAccentIsBlack ? BLACK_TEXT : WHITE_TEXT;
  tokens['accent-hover'] = shiftLightness(solid, onAccentIsBlack ? 0.08 : -0.1);
  tokens['accent-text'] = atRatio(accentSeed, binding, TEXT_MIN, dir);

  // ---- 5. 语法与状态 ----
  const rules = RULES[variant];
  for (const [token, rule] of Object.entries(rules)) {
    const base = shiftLightness(seed(rule.slot), rule.dl ?? 0);
    const corrected = token.endsWith('-border')
      ? atRatio(base, binding, GRAPHICAL_MIN, dir)
      : atRatio(base, binding, TEXT_MIN, dir);
    tokens[token] = rule.alpha === undefined ? corrected : { ...corrected, a: rule.alpha };
  }
  for (const [token, slot] of Object.entries(STATUS_BG_SLOT)) {
    tokens[token] = mix(seed(slot), canvas, STATUS_BG_TOWARD_CANVAS);
  }

  // ---- 6. 半透明 ----
  tokens['selection-bg'] = { ...seed('base0D'), a: variant === 'light' ? 0.2 : 0.4 };
  tokens['syntax-inline-code-bg'] = { ...seed('base05'), a: variant === 'light' ? 0.05 : 0.15 };

  const out: Record<string, string> = {};
  for (const [token, colour] of Object.entries(tokens)) out[token] = rgbaString(colour);
  return out;
}
