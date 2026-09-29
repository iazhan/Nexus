/**
 * 明暗模式三件套：浅色 / 跟随系统 / 深色。
 *
 * **这三个是一组，不能拆开放** —— 单独一个太阳或月亮说明不了「它在一根三位置的轴上」。
 * 两个调用方都要整组语义：标题栏的切换键（只画「切过去会到哪儿」那一个）与设置页的模式卡片
 * （三个都画，标出选中那个）。
 *
 * 别的内联图标（代码尖括号、预览眼睛、对勾）留在各自的调用方里：它们只有一处用，搬进来会让
 * 「谁在用」查不出来。这条边界是刻意的 —— 这个模块是「模式轴图标集」，不是「图标大全」。
 *
 * 统一规格：14×14、`viewBox="0 0 24 24"`、`stroke="currentColor"`、线宽 2、`fill="none"`。
 * **颜色一律走 `currentColor`** —— 图标自己持有颜色就等于多出一套色板，主题一换就会露出破绽。
 */

/** 浅色模式：太阳。 */
export const LightIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="5" />
    <line x1="12" y1="1" x2="12" y2="3" />
    <line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" />
    <line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </svg>
);

/** 跟随系统：显示器。系统偏好是操作系统那边的事，所以画的是那台机器而不是半个太阳。 */
export const AutoIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </svg>
);

/** 深色模式：月亮。 */
export const DarkIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);
