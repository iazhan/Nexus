/**
 * 外观分组里「主题数据 → 该画哪几套种子」这一件事：**模式卡片与预设卡片共用**。
 *
 * 取色**只读种子，不读 44 个 token**：列表里几十套主题同时显示，而只有当前那套的 token 在 DOM 里
 * （`--nexus-*` 是单值变量，画不出别的主题）。种子则每套都有，16 个槽位也不受当前主题影响。
 * 真正的绘制在 `ThemeThumbnail.tsx`，这里只回答「画哪几套」。
 *
 * ## 为什么输入是「若干套种子」而不是「一个 id」
 *
 * 自动模式下这套预设**没有单一配色**：系统亮时用浅色版、暗时用深色版。调用方把两边都传进来，
 * 于是画成两扇并排的小窗 —— 与单变体（用户主题、上游只有一版的预设）走同一条路，
 * 区别只是数组长度。
 *
 * ## 顺序：一律先暗后亮
 *
 * 两扇并排时深色在左。**两处缩略图用同一个顺序** —— 同一套预设的「自动」在模式那一排与在预设
 * 网格里各画一次，顺序相反会看起来像画错了。深色在左也是照参考截图定的。
 */

import {
  BUILT_IN_SCHEMES,
  presetVariantsOf,
  type NexusThemeScheme,
  type ThemeMode,
  type UserTheme
} from '@nexus/theme';

/** 出厂方案按 id 查种子。用户主题不在表里，由调用方把整份 `UserTheme` 传进来。 */
const BUILT_IN_BY_ID: ReadonlyMap<string, NexusThemeScheme> = new Map(
  BUILT_IN_SCHEMES.map((entry): [string, NexusThemeScheme] => [entry.id, entry.scheme])
);

export function builtInScheme(id: string | undefined): NexusThemeScheme | undefined {
  return id ? BUILT_IN_BY_ID.get(id) : undefined;
}

/** 内置预设的变体表存的是**方案 id**，要过一层查表才拿得到种子。 */
function builtInVariantsOf(presetId: string): UserTheme['variants'] | undefined {
  const ids = presetVariantsOf(presetId);
  if (!ids) return undefined;
  const light = builtInScheme(ids.light);
  const dark = builtInScheme(ids.dark);
  if (!light && !dark) return undefined;
  return { ...(light ? { light } : {}), ...(dark ? { dark } : {}) };
}

/**
 * 一个预设当前该显示哪几套种子：自动模式且明暗两边都有就是两套（先暗后亮），否则就是当前模式
 * 那一套。一套都没有时返回空数组 —— 调用方据此不画缩略图，而不是画一个猜出来的色块。
 *
 * 模式在新预设上没有对应变体时（单变体预设、单边用户主题）退回它有的那一边 —— 与
 * `resolveThemeId` 同一条规则，否则卡片画的是 A、点下去生效的是 B。
 *
 * `userTheme` 只在该预设是用户主题时传：用户主题的两版存在 `ThemeManager` 里（不在静态表里），
 * 拿不到就只能画空。
 */
export function schemesForPreset(
  presetId: string,
  mode: ThemeMode,
  userTheme: UserTheme | null = null
): NexusThemeScheme[] {
  const variants = userTheme ? userTheme.variants : builtInVariantsOf(presetId);
  if (!variants) return [];

  if (mode === 'auto') {
    return [variants.dark, variants.light].filter(
      (scheme): scheme is NexusThemeScheme => Boolean(scheme)
    );
  }

  const one = variants[mode] ?? variants.light ?? variants.dark;
  return one ? [one] : [];
}
