/**
 * 主题卡片上的「主色圆点 + 配色条」。
 *
 * 取色**只读种子，不读 43 个 token**：列表里五套主题同时显示，而只有当前那套的 token 在 DOM 里
 * （`--nexus-*` 是单值变量，画不出别的主题）。种子则每套都有，16 个槽位也不受当前主题影响。
 *
 * ## 配色条为什么不是「背景三级」
 *
 * 卡片底色就是**当前主题**的背景，而条要画的是**别的主题**的颜色 —— 两边同明暗时条会消失：
 * 亮色卡片上的 Nexus Light 条（白 / 浅灰）几乎看不见，暗色卡片上的 Dracula 条同理。
 * 实测截图确认过，不是推测。
 *
 * 所以条取的是**跨明暗的四个代表色**：背景 → 分隔线 → 正文 → 主色。任何一套主题的这四个值
 * 自带明暗跨度，落在任何底色上都看得见；顺带把「这套主题的底色多深、正文多亮、主色是什么」
 * 一次说完。圆点单独再点一次主色是有意的 —— 它是这套主题的签名，条是它的取值范围。
 */

import {
  BUILT_IN_SCHEMES,
  SYSTEM_DEFAULTS,
  SYSTEM_THEME,
  isUserThemeId,
  type NexusThemeScheme
} from '@nexus/theme';

export interface ThemeSwatch {
  /**
   * 圆点的色。**两个值画成左右两半** —— 「跟随系统」没有单一主色，它是亮暗两套。
   * 用一个值画一个实心圆点。
   */
  dot: readonly string[];
  /** 配色条，等宽分段。「跟随系统」是亮暗两组拼起来，共 8 段。 */
  strip: readonly string[];
}

/** 出厂主题按 id 查种子。用户主题不在表里，由调用方传进来。 */
const BUILT_IN_BY_ID: ReadonlyMap<string, NexusThemeScheme> = new Map(
  BUILT_IN_SCHEMES.map((entry): [string, NexusThemeScheme] => [entry.id, entry.scheme])
);

/**
 * 四段：背景 / 分隔线 / 正文 / 主色。
 *
 * 不取 `base00-02` 那种纯背景梯度 —— 见文件头的说明，那种画法在同明暗的卡片上会消失。
 */
function bar(scheme: NexusThemeScheme): string[] {
  const { palette } = scheme;
  return [palette.base00, palette.base02, palette.base05, palette.base0D];
}

/**
 * 某套主题的圆点与配色条。
 *
 * `activeUserScheme` 只在 `themeId` 是用户主题时需要 —— 用户主题的种子不在出厂表里，
 * 而选项列表里至多出现一个（当前那个），所以调用方传当前的就够。
 * 认不出的 id 返回 `null`：卡片退化成纯文字，不画一个猜出来的色块。
 */
export function swatchFor(
  themeId: string,
  activeUserScheme: NexusThemeScheme | null = null
): ThemeSwatch | null {
  if (themeId === SYSTEM_THEME) {
    const light = BUILT_IN_BY_ID.get(SYSTEM_DEFAULTS.light);
    const dark = BUILT_IN_BY_ID.get(SYSTEM_DEFAULTS.dark);
    if (!light || !dark) return null;
    return {
      dot: [light.palette.base0D, dark.palette.base0D],
      strip: [...bar(light), ...bar(dark)]
    };
  }

  const scheme = isUserThemeId(themeId) ? activeUserScheme : BUILT_IN_BY_ID.get(themeId);
  if (!scheme) return null;
  return { dot: [scheme.palette.base0D], strip: bar(scheme) };
}
