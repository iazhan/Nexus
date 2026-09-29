// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { BUILT_IN_PRESETS, BUILT_IN_SCHEMES, type NexusThemeScheme } from '@nexus/theme';
import { builtInScheme, schemesForPreset, swatchForSchemes } from '../src/settings/theme-swatch.js';

/**
 * 预设卡片的取色。
 *
 * 这一层的价值在于**「只读种子、不读 token」这条约束能被证伪** —— 卡片要在任何主题生效之前
 * 就画得出来：五十多个预设同时显示，而 `--nexus-*` 只有当前那套在 DOM 里。所以判据全部对着
 * 种子表，不碰 DOM，也不需要先切主题。
 *
 * 输入是**若干套种子**而不是一个 id：自动模式下这套预设没有单一配色（系统亮用浅色版、暗用深色版），
 * 单变体预设与用户主题只有一套。区别只是数组长度，画法同一条路。
 *
 * 注意 `renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

const schemeOf = (id: string): NexusThemeScheme => {
  const scheme = builtInScheme(id);
  if (!scheme) throw new Error(`出厂表里没有 ${id}`);
  return scheme;
};

/** 与实现同源的四段：背景 / 分隔线 / 正文 / 主色。 */
const barOf = (id: string): string[] => {
  const { palette } = schemeOf(id);
  return [palette.base00, palette.base02, palette.base05, palette.base0D];
};

describe('预设卡片的取色', () => {
  it('单变体预设：圆点一个主色，配色条是背景 / 分隔线 / 正文 / 主色四段', () => {
    // `dracula` 上游只有暗版 —— 它同时也是「单变体是合法形状」的样本。
    const schemes = schemesForPreset('dracula', 'auto');
    expect(schemes).toHaveLength(1);

    const swatch = swatchForSchemes(schemes);

    expect(swatch?.dot).toEqual([schemeOf('dracula').palette.base0D]);
    expect(swatch?.strip).toEqual(barOf('dracula'));
  });

  /**
   * 「自动」下明暗两边都要画：圆点两半、条八段。顺序必须**先亮后暗** —— 反了画出来的就是
   * 「暗接亮」，与卡片想表达的意思相反。
   */
  it('自动模式：圆点两半（亮 / 暗各一），配色条先亮后暗共 8 段', () => {
    const variants = BUILT_IN_PRESETS.find((preset) => preset.id === 'nord')?.variants;
    if (!variants?.light || !variants.dark) throw new Error('nord 应当明暗两边都有');

    const swatch = swatchForSchemes(schemesForPreset('nord', 'auto'));

    expect(swatch?.dot).toEqual([
      schemeOf(variants.light).palette.base0D,
      schemeOf(variants.dark).palette.base0D
    ]);
    expect(swatch?.strip).toEqual([...barOf(variants.light), ...barOf(variants.dark)]);
  });

  it('显式模式只画那一边', () => {
    const variants = BUILT_IN_PRESETS.find((preset) => preset.id === 'nord')?.variants;
    if (!variants?.light || !variants.dark) throw new Error('nord 应当明暗两边都有');

    expect(swatchForSchemes(schemesForPreset('nord', 'light'))?.strip).toEqual(
      barOf(variants.light)
    );
    expect(swatchForSchemes(schemesForPreset('nord', 'dark'))?.strip).toEqual(
      barOf(variants.dark)
    );
  });

  /**
   * 单变体预设停在它没有的那一边时，退回它有的那一边 —— 与 `resolveThemeId` 同一条规则。
   * 不然卡片画的是 A、点下去生效的是 B。
   */
  it('单变体预设遇到它没有的模式时退回有的那一边', () => {
    expect(schemesForPreset('dracula', 'light')).toHaveLength(1);
    expect(schemesForPreset('dracula', 'light')[0]?.palette.base00).toBe(
      schemeOf('dracula').palette.base00
    );
  });

  /**
   * **这条是本模块存在的理由。** 条要画在「当前主题的卡片底色」上，若只取背景三级
   * （`base00/01/02`），亮色卡片上的亮色主题、暗色卡片上的暗色主题会整条消失 ——
   * 实测截图确认过。含 `base05`（正文）之后，每套主题的四段自带明暗跨度。
   *
   * 遍历**全部出厂方案**（一百多套），所以这条也是「上游配色不能画成一条线」的门禁。
   */
  it('每套方案的配色条都自带明暗跨度，落在任何底色上都看得见', () => {
    const luminance = (hex: string): number => {
      const value = Number.parseInt(hex.slice(1), 16);
      const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };

    for (const entry of BUILT_IN_SCHEMES) {
      const strip = swatchForSchemes([schemeOf(entry.id)])?.strip ?? [];
      const spread = Math.max(...strip.map(luminance)) - Math.min(...strip.map(luminance));
      // 0–255 的亮度轴上至少差 100（约等于白底黑字的四成）才认得出是一组色阶。
      expect(spread, entry.id).toBeGreaterThan(100);
    }
  });

  it('每一个出厂预设都画得出来', () => {
    for (const preset of BUILT_IN_PRESETS) {
      const swatch = swatchForSchemes(schemesForPreset(preset.id, 'auto'));
      expect(swatch, preset.id).not.toBeNull();
    }
  });

  it('用户主题用调用方传进来的种子；不传就画不出来（宁可退化成纯文字）', () => {
    const scheme = schemeOf('nord');

    expect(schemesForPreset('user:abc', 'auto', scheme)).toEqual([scheme]);
    expect(swatchForSchemes(schemesForPreset('user:abc', 'auto', scheme))?.strip).toEqual(
      barOf('nord')
    );
    expect(schemesForPreset('user:abc', 'auto')).toEqual([]);
    expect(swatchForSchemes(schemesForPreset('user:abc', 'auto'))).toBeNull();
  });

  it('认不出的预设返回空数组 —— 不画一个猜出来的色块', () => {
    expect(schemesForPreset('no-such-preset', 'auto')).toEqual([]);
    expect(swatchForSchemes(schemesForPreset('no-such-preset', 'auto'))).toBeNull();
  });
});
