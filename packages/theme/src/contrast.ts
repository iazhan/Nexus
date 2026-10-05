/**
 * 对比度契约：色彩数学 + 分级阈值 + 配对矩阵。
 *
 * 配对按 token 显式登记，不做前缀推断 —— 前缀推断在这套命名上被证伪四次，每次都造出错数字。
 * 加 token 忘了登记会有测试报错，不会静默归类。
 *
 * 几处代码里看不出来的判据：
 *
 * - sRGB 逆变换拐点取 0.04045，不是 WCAG 旧稿的 0.03928。
 * - 半透明的一侧先与承载面合成再测，否则一层浅色底纹会被当成近黑色。
 * - 契约里 `on: []` 表示「纯装饰，豁免」，是显式登记而不是漏写。
 * - `accent-solid` 是按钮底色而非前景，只作承载面；图形前景是 `accent-indicator`。
 * - `status-*-border` 与 `border-*` 的 tier 不同：前者是语义指示器（1.4.11 适用，3:1），
 *   后者是分隔线（纯装饰，豁免）。按 `-border` 后缀归一类是错的口径。
 * - `border-control` 是上面那条的第三个实例：同样是 `border-` 前缀，但它是**控件轮廓**，
 *   按图形级 3:1。判据是「这个 1px 是不是某个可交互元素的完整轮廓」，不是名字。
 * - `bg-quote` 属于通用背景；`OVERLAYS` 单独一组，正文不落在遮罩与选区高亮上。
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

export function parseColour(value: string): Rgba | null {
  const text = value.trim().toLowerCase();

  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    let digits = hex[1] ?? '';
    if (digits.length === 3 || digits.length === 4) {
      digits = [...digits].map((ch) => ch + ch).join('');
    }
    if (digits.length !== 6 && digits.length !== 8) return null;
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
      a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
    };
  }

  const fn = /^rgba?\(([^)]+)\)$/.exec(text);
  if (fn) {
    const parts = (fn[1] ?? '').split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3) return null;
    const [r, g, b, a] = parts;
    if (r === undefined || g === undefined || b === undefined) return null;
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r, g, b, a: a === undefined || Number.isNaN(a) ? 1 : a };
  }

  return null;
}

export function composite(over: Rgba, base: Rgba): Rgba {
  return {
    r: over.r * over.a + base.r * (1 - over.a),
    g: over.g * over.a + base.g * (1 - over.a),
    b: over.b * over.a + base.b * (1 - over.a),
    a: 1,
  };
}

export function relativeLuminance(colour: Rgba): number {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(colour.r) + 0.7152 * linear(colour.g) + 0.0722 * linear(colour.b);
}

export function contrastRatio(fg: Rgba, bg: Rgba, base: Rgba = WHITE): number {
  const surface = bg.a < 1 ? composite(bg, base) : bg;
  const front = fg.a < 1 ? composite(fg, surface) : fg;
  const a = relativeLuminance(front);
  const b = relativeLuminance(surface);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

export type ContrastTier = 'text' | 'graphical' | 'border';

export const TIER_MIN_RATIO: Record<ContrastTier, number> = {
  text: 4.5,
  graphical: 3,
  border: 0,
};

export const GENERAL_SURFACES: readonly string[] = [
  'bg-canvas',
  'bg-surface',
  'bg-surface-hover',
  'bg-surface-active',
  'bg-quote',
];

export const SURFACES: readonly string[] = [
  ...GENERAL_SURFACES,
  'syntax-inline-code-bg',
  'status-warning-bg',
  'status-error-bg',
  'accent-solid',
  'accent-solid-hover',
];

export const OVERLAYS: readonly string[] = ['selection-bg', 'bg-highlight'];

export interface TokenContract {
  readonly tier: ContrastTier;
  readonly on: readonly string[];
}

const SYNTAX_HIGHLIGHTS: readonly string[] = [
  'syntax-heading',
  'syntax-keyword',
  'syntax-control',
  'syntax-module',
  'syntax-string',
  'syntax-comment',
  'syntax-number',
  'syntax-bool',
  'syntax-function',
  'syntax-variable',
  'syntax-property',
  'syntax-type',
  'syntax-operator',
  'syntax-punctuation',
  'syntax-builtin',
  'syntax-url',
];

const STATUS_SCOPES: readonly string[] = ['success', 'warning', 'error'];

const general = [...GENERAL_SURFACES];

export const FOREGROUND_CONTRACT: Record<string, TokenContract> = {
  'text-primary': { tier: 'text', on: [...general] },
  'text-secondary': { tier: 'text', on: [...general] },
  'text-muted': { tier: 'text', on: [...general] },

  // 图形类：focus ring / 指示条 / caret。按文字级 4.5 要求会把两套主题都判成不达标。
  'accent-indicator': { tier: 'graphical', on: [...general] },
  'accent-text': { tier: 'text', on: [...general] },
  // 只落在主色实心底上（主按钮的文字色）。配到通用背景上会造出一个 1.00:1 的假失败。
  'accent-contrast': { tier: 'text', on: ['accent-solid', 'accent-solid-hover'] },

  'syntax-inline-code-text': { tier: 'text', on: ['syntax-inline-code-bg'] },

  // success 没有状态底色 token，所以它只剩通用背景这一组承载面。
  'status-success-text': { tier: 'text', on: [...general] },
  'status-warning-text': { tier: 'text', on: [...general, 'status-warning-bg'] },
  'status-error-text': { tier: 'text', on: [...general, 'status-error-bg'] },

  // 边框类：豁免，但必须显式列出，不能靠「没测到」。
  'border-subtle': { tier: 'border', on: [] },
  'border-default': { tier: 'border', on: [] },
  'border-strong': { tier: 'border', on: [] },

  // 控件边界不是分隔线：它是「识别这个控件所必需的视觉边界」，1.4.11 适用，按图形级 3:1 实测。
  // 按 `-border` 后缀归进上面那一类是错的口径 —— 与 `status-*-border` 同一类错误。
  'border-control': { tier: 'graphical', on: [...general] },
};

for (const name of SYNTAX_HIGHLIGHTS) {
  FOREGROUND_CONTRACT[name] = { tier: 'text', on: [...general] };
}

// 状态边框是语义指示器（1.4.11 的非文本对比度适用），按图形级 3:1 实测 ——
// 与上面三个纯装饰的分隔线不是一类。`derive.ts` 早就按 3:1 修它们，契约表却归进 `border`
// 豁免、从不测量，两处口径不同。
for (const scope of STATUS_SCOPES) {
  FOREGROUND_CONTRACT[`status-${scope}-border`] = { tier: 'graphical', on: [...general] };
}

export interface ContrastFailure {
  token: string;
  ground: string;
  ratio: number;
  threshold: number;
}

export interface ContrastReport {
  measured: number;
  failures: ContrastFailure[];
}

export function measureTheme(tokens: Record<string, string>): ContrastReport {
  const parsed: Record<string, Rgba> = {};
  for (const [name, value] of Object.entries(tokens)) {
    const colour = parseColour(value);
    if (colour) parsed[name] = colour;
  }
  const base = parsed['bg-canvas'] ?? WHITE;

  let measured = 0;
  const failures: ContrastFailure[] = [];

  for (const [token, contract] of Object.entries(FOREGROUND_CONTRACT)) {
    const fg = parsed[token];
    if (!fg || contract.tier === 'border') continue;
    const threshold = TIER_MIN_RATIO[contract.tier];

    for (const ground of contract.on) {
      const bg = parsed[ground];
      if (!bg) continue;
      const ratio = contrastRatio(fg, bg, base);
      measured += 1;
      if (ratio < threshold) failures.push({ token, ground, ratio, threshold });
    }
  }

  failures.sort((a, b) => a.ratio - b.ratio);
  return { measured, failures };
}
