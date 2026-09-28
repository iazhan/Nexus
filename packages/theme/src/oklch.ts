/**
 * OKLCH 颜色空间转换与操作：沿色相移动明度（`withLightness`）与两色按比例混合（`mix`）。
 *
 * 用 OKLCH 而不是 HSL —— HSL 的 L 与感知亮度不成比例，在暗色主题里调它得不到预期效果。
 * 系数取 Björn Ottosson 的 OKLab。
 *
 * 两处容易写反：`mix(a, b, t)` 的 `t` 朝 `b` 走；`shiftLightness` 的 `delta` 是相对偏移而非
 * 目标明度。`mustParse` 抛错而不返回 `null`，种子写错值要在派生开始前就炸。
 */

import { parseColour, type Rgba } from './contrast.js';

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

export function rgbToOklch({ r, g, b }: Rgba): Oklch {
  const linear = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const R = linear(r);
  const G = linear(g);
  const B = linear(b);

  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  const c = Math.hypot(A, Bb);
  let h = (Math.atan2(Bb, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function oklchToRgb({ l, c, h }: Oklch): Rgba {
  const rad = (h * Math.PI) / 180;
  const A = c * Math.cos(rad);
  const Bb = c * Math.sin(rad);

  const l_ = l + 0.3963377774 * A + 0.2158037573 * Bb;
  const m_ = l - 0.1055613458 * A - 0.0638541728 * Bb;
  const s_ = l - 0.0894841775 * A - 1.291485548 * Bb;

  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;

  const R = 4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S;
  const G = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S;
  const B = -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S;

  const gamma = (v: number): number => {
    const lin = clamp01(v);
    const s = lin <= 0.0031308 ? 12.92 * lin : 1.055 * lin ** (1 / 2.4) - 0.055;
    return Math.round(clamp01(s) * 255);
  };

  return { r: gamma(R), g: gamma(G), b: gamma(B), a: 1 };
}

export function withLightness(colour: Rgba, l: number): Rgba {
  const base = rgbToOklch(colour);
  return oklchToRgb({ l: clamp01(l), c: base.c, h: base.h });
}

export function shiftLightness(colour: Rgba, delta: number): Rgba {
  return withLightness(colour, rgbToOklch(colour).l + delta);
}

export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  const k = clamp01(t);
  return {
    r: Math.round(a.r + (b.r - a.r) * k),
    g: Math.round(a.g + (b.g - a.g) * k),
    b: Math.round(a.b + (b.b - a.b) * k),
    a: a.a + (b.a - a.a) * k,
  };
}

export function toHex({ r, g, b }: Rgba): string {
  const part = (v: number): string => Math.round(clamp01(v / 255) * 255).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function mustParse(value: string, what: string): Rgba {
  const colour = parseColour(value);
  if (!colour) throw new Error(`${what}: 无法解析颜色 "${value}"`);
  return colour;
}
