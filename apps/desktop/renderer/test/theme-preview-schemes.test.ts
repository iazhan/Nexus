// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { BUILT_IN_PRESETS, type NexusThemeScheme } from '@nexus/theme';
import { builtInScheme, schemesForPreset } from '../src/settings/theme-preview-schemes.js';

/**
 * 外观分组里「预设 → 该画哪几套种子」的取色。**模式卡片与预设卡片的缩略图共用它** ——
 * 前者问「当前预设的那一边」，后者问「这套预设的那一边」，答案都来自这里。
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

/** 明暗两边都有的样本。单变体用 `dracula`（上游只有暗版）。 */
const nordVariants = (): { light: string; dark: string } => {
  const variants = BUILT_IN_PRESETS.find((preset) => preset.id === 'nord')?.variants;
  if (!variants?.light || !variants.dark) throw new Error('nord 应当明暗两边都有');
  return { light: variants.light, dark: variants.dark };
};

describe('预设的缩略图取色', () => {
  /** 单边主题只有一套种子 —— 自动模式也就只画一扇窗。出厂预设恒为两版，所以只能用用户主题造。 */
  it('单边主题只有一套种子，自动模式只画一扇窗', () => {
    const dark = schemeOf('nord');
    expect(schemesForPreset('user:single', 'auto', { id: 'user:single', variants: { dark } })).toEqual([
      dark
    ]);
  });

  /**
   * 「自动」下明暗两边都要画，且**先暗后亮**。顺序是刻意的：模式那一排的「跟随系统」也是两扇、
   * 同样先暗后亮，两处画的是同一件事，顺序相反会看起来像画错了。
   */
  it('自动模式给两套种子，先暗后亮', () => {
    const { light, dark } = nordVariants();

    expect(schemesForPreset('nord', 'auto')).toEqual([schemeOf(dark), schemeOf(light)]);
  });

  it('显式模式只给那一边', () => {
    const { light, dark } = nordVariants();

    expect(schemesForPreset('nord', 'light')).toEqual([schemeOf(light)]);
    expect(schemesForPreset('nord', 'dark')).toEqual([schemeOf(dark)]);
  });

  /**
   * 单边主题停在它没有的那一边时，退回它有的那一边 —— 与 `resolveThemeId` 同一条规则。
   * 不然卡片画的是 A、点下去生效的是 B。
   */
  it('单边主题遇到它没有的模式时退回有的那一边', () => {
    const dark = schemeOf('nord');
    expect(schemesForPreset('user:single', 'light', { id: 'user:single', variants: { dark } })).toEqual([
      dark
    ]);
  });

  it('每一个出厂预设都画得出来', () => {
    for (const preset of BUILT_IN_PRESETS) {
      expect(schemesForPreset(preset.id, 'auto'), preset.id).not.toEqual([]);
    }
  });

  /**
   * 用户主题的两版存在 `ThemeManager` 里（不在静态表里），所以要把**整份** `UserTheme` 传进来。
   * 不传就画不出来 —— 宁可退化成纯文字，也不画一个猜出来的色块。
   */
  it('用户主题用调用方传进来的两版；不传就画不出来', () => {
    const dark = schemeOf('nord');
    const light = schemeOf('nord-light');

    expect(schemesForPreset('user:abc', 'dark', { id: 'user:abc', variants: { dark } })).toEqual([
      dark
    ]);
    expect(
      schemesForPreset('user:abc', 'auto', { id: 'user:abc', variants: { light, dark } })
    ).toEqual([dark, light]);
    expect(schemesForPreset('user:abc', 'auto')).toEqual([]);
  });

  it('单边用户主题遇到它没有的模式时退回有的那一边', () => {
    const dark = schemeOf('nord');
    expect(
      schemesForPreset('user:abc', 'light', { id: 'user:abc', variants: { dark } })
    ).toEqual([dark]);
  });

  it('认不出的预设返回空数组 —— 不画一个猜出来的色块', () => {
    expect(schemesForPreset('no-such-preset', 'auto')).toEqual([]);
  });
});
