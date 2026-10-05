/**
 * 首帧主题的载荷：主进程算好「写哪个 `data-theme`」与「要不要注入一段 CSS」，preload 直接落。
 *
 * ## 为什么派生在主进程
 *
 * preload 那条路径在**首帧之前**跑，代价直接落在窗口出现的时间上。`builtInThemes()` 派生
 * 一百多套实测 74ms、产物上百 KB —— 所以 preload 只引预设表、不引派生管线（见
 * `preload/theme-boot.ts` 的注释）。而**用户主题**必须有派生结果才能画：它没有构建期静态 CSS。
 * 于是派生放在主进程（Node 环境，不受首帧约束），preload 只做一次字符串注入。
 *
 * ## 为什么由 preload 把 choice 传进来
 *
 * 「当前选的是哪套主题」存在渲染进程的 localStorage 里，**主进程读不到**。而 preload 读得到
 * （它本来就是靠这个起作用的）。所以方向是 preload → 主进程：`sendSync` 带上 choice 与
 * 「系统偏好是不是深色」，主进程按同一套规则解析。
 *
 * 用 `ThemeManager` 而不是自己写一遍解析：解析规则（`<预设>@<模式>`、用户主题的裸 id、
 * 单边主题退到它有的那一版）只有一份，重写必然与渲染进程漂移 —— 而漂移的症状是
 * **首帧与第二帧不是同一套主题**，只看代码看不出来。
 *
 * ## 内置主题返回空 CSS
 *
 * 它们有构建期生成的静态 CSS（`themesToCss` + `<link>`），`data-theme` 一写就到位。
 * 再注入一份只是多一次 DOM 写入，且两份 CSS 的来源不同会让「哪份生效」多一个变量。
 */

import { ThemeManager, USER_THEME_PREFIX, type SystemThemeSource, type UserTheme } from '@nexus/theme';
import type { ThemeBootPayload } from '../ipc/channels.js';

/**
 * 载荷里**由派生决定**的那一半。目录快照（`themes` / `broken` / `migrated`）由调用方补上 ——
 * 那三个是 IO 的结果，与「怎么解析选择」无关。
 */
export type ThemeBootCss = Pick<ThemeBootPayload, 'themeId' | 'cssText'>;

/** 主进程里没有 `matchMedia`，系统偏好由 preload 读好传进来。 */
function fixedSystem(prefersDark: boolean): SystemThemeSource {
  return { prefersDark: () => prefersDark, subscribe: () => () => {} };
}

/**
 * `choice` 为 `null`（没有存档）时交给 `ThemeManager` 的默认值 —— 与渲染进程构造
 * `themeManager` 时传 `settings.get('appearance.theme')` 是同一条路（缺省即「默认预设 + 自动」）。
 */
export function themeBootPayload(
  choice: string | null,
  prefersDark: boolean,
  userThemes: readonly UserTheme[]
): ThemeBootCss {
  const manager = new ThemeManager(choice ?? undefined, fixedSystem(prefersDark), userThemes);
  const theme = manager.theme;

  if (!theme.id.startsWith(USER_THEME_PREFIX)) return { themeId: theme.id, cssText: '' };
  return { themeId: theme.id, cssText: rootBlock(theme.tokens) };
}

/**
 * 与 `ThemeManager` 的运行时注入**逐字同形**（`packages/theme/src/index.ts` 的 `applyResolved`）：
 * 同一个 `:root` 选择器、同一份声明顺序。
 *
 * 形状不同的话首帧与第二帧会有细微差异 —— 而那种差异只在「首帧注入的样式被运行时注入覆盖」
 * 的瞬间看得见，排查时不会想到是这里。
 */
function rootBlock(tokens: Readonly<Record<string, string>>): string {
  let css = ':root {\n';
  for (const [key, value] of Object.entries(tokens)) css += `  --nexus-${key}: ${value};\n`;
  return `${css}}\n`;
}
