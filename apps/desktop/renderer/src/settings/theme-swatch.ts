/**
 * 预设卡片上的「主色圆点 + 配色条」。
 *
 * 取色**只读种子，不读 43 个 token**：列表里几十套主题同时显示，而只有当前那套的 token 在 DOM 里
 * （`--nexus-*` 是单值变量，画不出别的主题）。种子则每套都有，16 个槽位也不受当前主题影响。
 *
 * ## 配色条为什么不是「背景三级」
 *
 * 卡片底色就是**当前主题**的背景，而条要画的是**别的主题**的颜色 —— 两边同明暗时条会消失：
 * 亮色卡片上的浅色主题条几乎看不见，暗色卡片上的深色主题条同理。实测截图确认过，不是推测。
 *
 * 所以条取的是**跨明暗的四个代表色**：背景 → 分隔线 → 正文 → 主色。任何一套主题的这四个值
 * 自带明暗跨度，落在任何底色上都看得见；顺带把「这套主题的底色多深、正文多亮、主色是什么」
 * 一次说完。圆点单独再点一次主色是有意的 —— 它是这套主题的签名，条是它的取值范围。
 *
 * ## 为什么输入是「若干套种子」而不是「一个 id」
 *
 * 自动模式下这套主题**没有单一配色**：系统亮时用浅色版、暗时用深色版。调用方把两边都传进来，
 * 圆点画成两半、条画成八段 —— 与单变体（用户主题、上游只有一版的预设）走同一条路，
 * 区别只是数组长度。
 */

import {
  BUILT_IN_SCHEMES,
  isUserThemeId,
  presetVariantsOf,
  type NexusThemeScheme,
  type ThemeMode,
} from '@nexus/theme';

export interface ThemeSwatch {
  /** 主色圆点。**两个值画成左右两半** —— 自动模式没有单一主色，它是亮暗两套。 */
  dot: readonly string[];
  /** 配色条，等宽分段。自动模式是亮暗两组拼起来，共 8 段。 */
  strip: readonly string[];
}

/** 出厂方案按 id 查种子。用户主题不在表里，由调用方自己给。 */
const BUILT_IN_BY_ID: ReadonlyMap<string, NexusThemeScheme> = new Map(
  BUILT_IN_SCHEMES.map((entry): [string, NexusThemeScheme] => [entry.id, entry.scheme])
);

export function builtInScheme(id: string | undefined): NexusThemeScheme | undefined {
  return id ? BUILT_IN_BY_ID.get(id) : undefined;
}

/**
 * 四段：背景 / 分隔线 / 正文 / 主色。
 *
 * 不取 `base00-02` 那种纯背景梯度 —— 见文件头的说明，那种画法在同明暗的卡片上会消失。
 */
function bar(scheme: NexusThemeScheme): string[] {
  const { palette } = scheme;
  return [palette.base00, palette.base02, palette.base05, palette.base0D];
}

/** 一套都没有时返回 `null`，卡片退化成纯文字，而不是画一个猜出来的色块。 */
export function swatchForSchemes(
  schemes: readonly (NexusThemeScheme | null | undefined)[]
): ThemeSwatch | null {
  const known = schemes.filter((scheme): scheme is NexusThemeScheme => Boolean(scheme));
  if (known.length === 0) return null;
  return {
    dot: known.map((scheme) => scheme.palette.base0D),
    strip: known.flatMap(bar),
  };
}

/**
 * 一个预设当前该显示哪几套种子：自动模式且明暗两边都有就是两套，否则就是当前模式那一套。
 *
 * 模式在新预设上没有对应变体时（单变体预设）退回它有的那一边 —— 与 `resolveThemeId` 同一条
 * 规则，否则卡片画的是 A、点下去生效的是 B。
 */
export function schemesForPreset(
  presetId: string,
  mode: ThemeMode,
  userScheme: NexusThemeScheme | null = null
): NexusThemeScheme[] {
  if (isUserThemeId(presetId)) return userScheme ? [userScheme] : [];

  const variants = presetVariantsOf(presetId);
  if (!variants) return [];

  if (mode === 'auto') {
    return [variants.light, variants.dark]
      .map(builtInScheme)
      .filter((scheme): scheme is NexusThemeScheme => Boolean(scheme));
  }

  const one =
    builtInScheme(variants[mode]) ?? builtInScheme(variants.light) ?? builtInScheme(variants.dark);
  return one ? [one] : [];
}
