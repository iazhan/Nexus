import { describe, it, expect } from 'vitest';
import { nexusDark, nexusLight } from '../src/index.js';
import { GENERAL_SURFACES, contrastRatio, measureTheme, parseColour } from '../src/contrast.js';
import { seedsToTokens } from '../src/derive.js';
import { rgbToOklch } from '../src/oklch.js';
import { nexusDarkSeeds, nexusLightSeeds, type NexusThemeScheme } from '../src/seeds.js';

const DERIVED: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['light', seedsToTokens(nexusLightSeeds)],
  ['dark', seedsToTokens(nexusDarkSeeds)],
];

const luminanceGap = (a: string, b: string): number => {
  const pa = parseColour(a);
  const pb = parseColour(b);
  if (!pa || !pb) throw new Error(`无法解析：${a} / ${b}`);
  return Math.abs(rgbToOklch(pa).l - rgbToOklch(pb).l);
};

/** 第三方 base16 方案，用来验证「换主题只改 16 个值」不是只对反推的种子成立。 */
const DRACULA: NexusThemeScheme = {
  name: 'Dracula',
  variant: 'dark',
  palette: {
    base00: '#282936', base01: '#3a3c4e', base02: '#4d4f68', base03: '#626483',
    base04: '#62d6e8', base05: '#e9e9f4', base06: '#f1f2f8', base07: '#f7f7fb',
    base08: '#ea51b2', base09: '#b45bcf', base0A: '#00f769', base0B: '#ebff87',
    base0C: '#a1efe4', base0D: '#62d6e8', base0E: '#b45bcf', base0F: '#00f769',
  },
};

/** 低对比暖底 —— 触发配额分配的守卫（带里放不下三个层级）。 */
const SOLARIZED_LIGHT: NexusThemeScheme = {
  name: 'Solarized Light',
  variant: 'light',
  palette: {
    base00: '#fdf6e3', base01: '#eee8d5', base02: '#93a1a1', base03: '#839496',
    base04: '#657b83', base05: '#586e75', base06: '#073642', base07: '#002b36',
    base08: '#dc322f', base09: '#cb4b16', base0A: '#b58900', base0B: '#859900',
    base0C: '#2aa198', base0D: '#268bd2', base0E: '#6c71c4', base0F: '#d33682',
  },
};

describe('派生输出与手写 token 同构', () => {
  it('token 集合完全一致（不多不少）', () => {
    for (const [name, tokens] of DERIVED) {
      const hand = name === 'light' ? nexusLight.tokens : nexusDark.tokens;
      expect(Object.keys(tokens).sort(), `${name} 的 token 集合变了`).toEqual(Object.keys(hand).sort());
    }
  });

  it('两套主题的 token 名一致', () => {
    expect(Object.keys(DERIVED[0]![1]).sort()).toEqual(Object.keys(DERIVED[1]![1]).sort());
  });

  it('没有派生漏掉的 token（每个都拿到了值）', () => {
    for (const [name, tokens] of DERIVED) {
      const missing = Object.entries(tokens).filter(([, value]) => !value).map(([key]) => key);
      expect(missing, `${name} 有空值`).toEqual([]);
    }
  });
});

describe('派生输出的对比度不变量', () => {
  it('两套主题在契约矩阵下零不达标', () => {
    for (const [name, tokens] of DERIVED) {
      const report = measureTheme(tokens);
      expect(report.measured, `${name} 的测量对数变了`).toBe(125);
      expect(
        report.failures.map((f) => `${f.token}@${f.ground} ${f.ratio.toFixed(2)}`),
        `${name} 有派生后仍不达标的配对`,
      ).toEqual([]);
    }
  });

  it('三级中性文字互不相等，且在 binding 背景上都能区分', () => {
    for (const [name, tokens] of DERIVED) {
      const tiers = ['text-primary', 'text-secondary', 'text-muted'] as const;
      const values = tiers.map((t) => tokens[t]!);
      expect(new Set(values).size, `${name} 的三级文字有塌缩`).toBe(3);

      const binding = tokens['bg-surface-active']!;
      const levels = values.map((v) => luminanceGap(v, binding));
      // 相邻层级的明度间距 ≥ 0.05 —— 低于这个量级在视觉上分不出来。
      expect(levels[0]! - levels[1]!, `${name} primary/secondary 分不开`).toBeGreaterThan(0.05);
      expect(levels[1]! - levels[2]!, `${name} secondary/muted 分不开`).toBeGreaterThan(0.05);
    }
  });

  it('按钮文字在 accent-primary 与 accent-hover 上都达标', () => {
    for (const [name, tokens] of DERIVED) {
      const text = parseColour(tokens['accent-contrast']!)!;
      for (const ground of ['accent-primary', 'accent-hover']) {
        const ratio = contrastRatio(text, parseColour(tokens[ground]!)!);
        expect(ratio, `${name} 的 ${ground} 上按钮文字只有 ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('accent-primary 作为图形在通用背景上达 3:1', () => {
    for (const [name, tokens] of DERIVED) {
      const accent = parseColour(tokens['accent-primary']!)!;
      for (const surface of GENERAL_SURFACES) {
        const ratio = contrastRatio(accent, parseColour(tokens[surface]!)!);
        expect(ratio, `${name} 的 accent-primary 在 ${surface} 上只有 ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('派生规则对第三方种子成立', () => {
  it('Dracula 全套零不达标（含 base0D 是浅青这种极端情况）', () => {
    const tokens = seedsToTokens(DRACULA);
    expect(measureTheme(tokens).failures).toEqual([]);
  });

  it('中性层级不继承 base03/base04 的色相（Dracula 的 base04 是青的）', () => {
    const tokens = seedsToTokens(DRACULA);
    // 中性文字跟随 base05 的色相（此处是极淡的紫白，彩度 ≈ 0.01），不该是 base04 的青色。
    for (const token of ['text-secondary', 'text-muted']) {
      const chroma = rgbToOklch(parseColour(tokens[token]!)!).c;
      expect(chroma, `${token} 带上了 base04 的色相`).toBeLessThan(0.03);
    }
  });

  it('守卫不成立时不抛错，输出仍全部达标（Solarized Light 的带太窄）', () => {
    const tokens = seedsToTokens(SOLARIZED_LIGHT);
    expect(Object.keys(tokens)).toHaveLength(42);
    expect(measureTheme(tokens).failures).toEqual([]);
  });
});
