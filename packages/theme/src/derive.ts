/**
 * `seedsToTokens()` —— 16 色种子 → 43 个语义 token 的纯计算。另外两个出口：`applyOverrides()`
 * 是它之后的可选一层，`seedsToTokensWithReport()` 多带一份「哪些 token 被对比度修正动过」。
 *
 * 六段顺序有依赖，不能重排：背景梯度 → 边框 → 中性文字 → accent → 语法与状态 → 半透明。
 * 中性三级走配额分配（相对 `binding`：离正文色最近的通用背景），而非逐 token 最小修正 ——
 * 最小修正会让相邻层级收敛到同一个灰阶。有色相的 token 走「槽位色 + 明度偏移 + 最小修正」。
 *
 * 三处代码里看不出来的判据：
 *
 * - accent 拆成两个 token：`accent-indicator`（图形，通用背景上 3:1）与 `accent-solid`（按钮底，
 *   压到承白字）。合成一个时这两条约束在暗色主题里数学互斥，只能二选一。
 * - `accent-contrast` 恒为白：`darkenForText()` 已保证白字达标，再留一条取黑字的分支是死代码。
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

/** 该 variant 的缺省系数。编辑器要拿它当滑块的初值与「重置」目标，所以不能只留在内部。 */
export function defaultTuning(variant: 'light' | 'dark'): Required<Tuning> {
  return { ...DEFAULT_TUNING[variant] };
}

const WHITE_TEXT: Rgba = { r: 255, g: 255, b: 255, a: 1 };

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

/**
 * 把背景压暗，直到它上面的 `text` 达标 —— 「承白字」的专用辅助。
 *
 * 只朝暗走：背景越暗白字对比度越高，压到纯黑必然成立，所以没有失败分支，也不需要方向参数。
 * 按钮底要深是硬需求，不能像前景那样按 variant 翻转方向。
 */
function darkenForText(background: Rgba, text: Rgba, target: number): Rgba {
  if (contrastRatio(text, background) >= target) return background;
  const start = rgbToOklch(background).l;
  let current = background;
  for (let i = 1; i <= 400; i += 1) {
    const l = start - 0.002 * i;
    if (l <= 0) break;
    current = withLightness(background, l);
    if (contrastRatio(text, current) >= target) break;
  }
  return current;
}

const rgbaString = ({ r, g, b, a }: Rgba): string =>
  a >= 1 ? toHex({ r, g, b, a }) : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;

interface Rule {
  slot: Base16Slot;
  dl?: number;
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
    'status-success-border': { slot: 'base0C' },
    'status-warning-text': { slot: 'base0A' },
    'status-warning-border': { slot: 'base0A' },
    'status-error-text': { slot: 'base08' },
    'status-error-border': { slot: 'base08' },
  },
};

const STATUS_BG_TOWARD_CANVAS = 0.85;
const STATUS_BG_SLOT: Record<string, Base16Slot> = {
  'status-warning-bg': 'base0A',
  'status-error-bg': 'base08',
};

export interface Correction {
  token: string;
  /** 修正前 / 修正后在该承载面上的**实际**对比度。 */
  from: number;
  to: number;
  /** 该 token 的目标比值。 */
  target: number;
}

export interface DeriveReport {
  tokens: Record<string, string>;
  /** 被对比度修正改过值的 token。顺序即修正发生的顺序。 */
  corrections: readonly Correction[];
}

export function seedsToTokens(scheme: NexusThemeScheme): Record<string, string> {
  return seedsToTokensWithReport(scheme).tokens;
}

/**
 * 与 `seedsToTokens()` 同一条管线，另外把「哪些 token 被对比度修正动过」带出来。
 *
 * 编辑器要把隐含的修正说给用户听（「已从 3.1:1 修正到 4.5:1」），否则用户看不出自己的种子
 * 被改过；而只提示不修正会让人存下一个不可读的主题。**判据是「`atRatio()` 的返回值与入参
 * 是不是同一个对象」** —— 未修正时它原样返回 `fg`，修正时 `withLightness()` 必然造新对象。
 */
export function seedsToTokensWithReport(scheme: NexusThemeScheme): DeriveReport {
  const variant = scheme.variant;
  const tuning = { ...DEFAULT_TUNING[variant], ...scheme.tuning };
  const dir = directionFor(variant);

  const raw: Record<string, Rgba> = {};
  for (const [slot, value] of Object.entries(scheme.palette)) {
    raw[slot] = mustParse(value, `${scheme.name} 的 ${slot}`);
  }
  const seed = (slot: Base16Slot): Rgba => raw[slot] as Rgba;
  const tokens: Record<string, Rgba> = {};
  const corrections: Correction[] = [];

  const fixed = (token: string, before: Rgba, after: Rgba, ground: Rgba, target: number): Rgba => {
    if (after !== before) {
      corrections.push({
        token,
        from: contrastRatio(before, ground),
        to: contrastRatio(after, ground),
        target
      });
    }
    return after;
  };

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
  tokens['text-primary'] = fixed('text-primary', seed('base05'), primary, binding, TEXT_MIN);

  const reference = rgbToOklch(primary);
  const neutral = (token: string, colour: Rgba, target: number): Rgba => {
    const corrected = atRatio(colour, binding, target, dir);
    // `oklchToRgb()` 总会造新对象，所以「有没有修正」只能看 `atRatio` 那一步。
    const out = oklchToRgb({ l: rgbToOklch(corrected).l, c: reference.c, h: reference.h });
    if (corrected !== colour) {
      corrections.push({
        token,
        from: contrastRatio(colour, binding),
        to: contrastRatio(out, binding),
        target
      });
    }
    return out;
  };

  if (guardOk) {
    tokens['text-muted'] = neutral('text-muted', seed('base03'), TEXT_MIN * 1.02);
    tokens['text-secondary'] = neutral('text-secondary', seed('base04'), Math.sqrt(TEXT_MIN * primaryRatio));
  } else {
    tokens['text-muted'] = neutral('text-muted', seed('base03'), TEXT_MIN);
    tokens['text-secondary'] = neutral('text-secondary', seed('base04'), TEXT_MIN);
  }

  // ---- 4. accent 家族 ----
  // 图形与实心底必须分开：图形要亮才看得见（3:1），实心底要暗才承得住白字（4.5:1）。
  // 暗色主题的 base0D 是「链接色」（偏亮），两个约束在它身上数学互斥。
  const accentSeed = seed('base0D');
  tokens['accent-indicator'] = fixed(
    'accent-indicator',
    accentSeed,
    atRatio(accentSeed, binding, GRAPHICAL_MIN, dir),
    binding,
    GRAPHICAL_MIN
  );
  const solid = fixed(
    'accent-solid',
    accentSeed,
    darkenForText(accentSeed, WHITE_TEXT, TEXT_MIN),
    WHITE_TEXT,
    TEXT_MIN
  );
  tokens['accent-solid'] = solid;
  tokens['accent-contrast'] = WHITE_TEXT;
  tokens['accent-solid-hover'] = shiftLightness(solid, -0.1);
  tokens['accent-text'] = fixed(
    'accent-text',
    accentSeed,
    atRatio(accentSeed, binding, TEXT_MIN, dir),
    binding,
    TEXT_MIN
  );

  // ---- 5. 语法与状态 ----
  const rules = RULES[variant];
  for (const [token, rule] of Object.entries(rules)) {
    const base = shiftLightness(seed(rule.slot), rule.dl ?? 0);
    // 边框走图形级 3:1（语义指示器），其余走文字级 4.5。
    // 这里没有 alpha 分支：半透明会抵消修正 —— 先修到 3:1 再叠 alpha 等于没修。
    // 暗色的 status-*-border 曾带 alpha 0.4，实测在深底上只剩 1.5:1，1px 细线等于不可见。
    const target = token.endsWith('-border') ? GRAPHICAL_MIN : TEXT_MIN;
    tokens[token] = fixed(token, base, atRatio(base, binding, target, dir), binding, target);
  }
  for (const [token, slot] of Object.entries(STATUS_BG_SLOT)) {
    tokens[token] = mix(seed(slot), canvas, STATUS_BG_TOWARD_CANVAS);
  }

  // ---- 6. 半透明 ----
  tokens['selection-bg'] = { ...seed('base0D'), a: variant === 'light' ? 0.2 : 0.4 };
  tokens['syntax-inline-code-bg'] = { ...seed('base05'), a: variant === 'light' ? 0.05 : 0.15 };

  const out: Record<string, string> = {};
  for (const [token, colour] of Object.entries(tokens)) out[token] = rgbaString(colour);
  return { tokens: out, corrections };
}

/**
 * 覆盖项盖在派生结果上。**不修正、不校验** —— 用户手写的值原样生效，是否达标交给对比度报告去说。
 *
 * 没有覆盖项时返回**原对象**：`definitionOf()` 每次重算都调它，多造一个等值对象会让下游按引用
 * 比 tokens 的判断（以及 devtools 里的对象对比）全部失真。
 */
export function applyOverrides(
  tokens: Record<string, string>,
  overrides?: Readonly<Record<string, string>>
): Record<string, string> {
  if (!overrides) return tokens;
  const keys = Object.keys(overrides);
  if (keys.length === 0) return tokens;
  return { ...tokens, ...overrides };
}
