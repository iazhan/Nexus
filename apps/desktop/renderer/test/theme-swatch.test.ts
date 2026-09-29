// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { BUILT_IN_SCHEMES, SYSTEM_DEFAULTS, SYSTEM_THEME } from '@nexus/theme';
import { swatchFor } from '../src/settings/theme-swatch.js';

/**
 * 主题卡片的取色。
 *
 * 这一层的价值在于**「只读种子、不读 token」这条约束能被证伪** —— 卡片要在任何主题生效之前
 * 就画得出来：五套主题同时显示，而 `--nexus-*` 只有当前那套在 DOM 里。所以判据全部对着
 * 种子表，不碰 DOM，也不需要先切主题。
 *
 * 注意 `renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

const schemeOf = (id: string) => {
  const entry = BUILT_IN_SCHEMES.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`出厂表里没有 ${id}`);
  return entry.scheme;
};

/** 与实现同源的四段：背景 / 分隔线 / 正文 / 主色。 */
const barOf = (id: string): string[] => {
  const { palette } = schemeOf(id);
  return [palette.base00, palette.base02, palette.base05, palette.base0D];
};

describe('主题卡片的取色', () => {
  it('内置主题：圆点是 base0D，配色条是背景 / 分隔线 / 正文 / 主色四段', () => {
    const swatch = swatchFor('dracula');

    expect(swatch?.dot).toEqual([schemeOf('dracula').palette.base0D]);
    expect(swatch?.strip).toEqual(barOf('dracula'));
  });

  /**
   * **这条是本模块存在的理由。** 条要画在「当前主题的卡片底色」上，若只取背景三级
   * （`base00/01/02`），亮色卡片上的亮色主题、暗色卡片上的暗色主题会整条消失 ——
   * 实测截图确认过。含 `base05`（正文）之后，每套主题的四段自带明暗跨度。
   */
  it('每套主题的四段都自带明暗跨度，落在任何底色上都看得见', () => {
    const luminance = (hex: string): number => {
      const value = Number.parseInt(hex.slice(1), 16);
      const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };

    for (const entry of BUILT_IN_SCHEMES) {
      const strip = swatchFor(entry.id)?.strip ?? [];
      const spread = Math.max(...strip.map(luminance)) - Math.min(...strip.map(luminance));
      // 0–255 的亮度轴上至少差 100（约等于白底黑字的四成）才认得出是一组色阶。
      expect(spread, entry.id).toBeGreaterThan(100);
    }
  });

  it('每一套出厂主题都画得出来', () => {
    for (const entry of BUILT_IN_SCHEMES) {
      const swatch = swatchFor(entry.id);
      expect(swatch, entry.id).not.toBeNull();
      expect(swatch?.strip, entry.id).toHaveLength(4);
    }
  });

  /**
   * 「跟随系统」没有单一主色，所以圆点画成两半、配色条拼成八段。
   * 顺序必须**先亮后暗** —— 反了画出来的就是「暗接亮」，与卡片想表达的意思相反。
   */
  it('跟随系统：圆点两半（亮 / 暗各一），配色条先亮后暗共 8 段', () => {
    const swatch = swatchFor(SYSTEM_THEME);

    expect(swatch?.dot).toEqual([
      schemeOf(SYSTEM_DEFAULTS.light).palette.base0D,
      schemeOf(SYSTEM_DEFAULTS.dark).palette.base0D
    ]);
    expect(swatch?.strip).toEqual([
      ...barOf(SYSTEM_DEFAULTS.light),
      ...barOf(SYSTEM_DEFAULTS.dark)
    ]);
  });

  it('用户主题用调用方传进来的种子；不传就画不出来（宁可退化成纯文字）', () => {
    const scheme = schemeOf('nord');

    expect(swatchFor('user:abc', scheme)?.dot).toEqual([scheme.palette.base0D]);
    expect(swatchFor('user:abc', scheme)?.strip).toEqual(barOf('nord'));
    expect(swatchFor('user:abc')).toBeNull();
  });

  it('认不出的 id 返回 null —— 不画一个猜出来的色块', () => {
    expect(swatchFor('no-such-theme')).toBeNull();
  });
});
