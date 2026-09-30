/**
 * 左侧栏宽度的取值域。
 *
 * 范围是刻意的：窄于 160px 放不下文件名（会出现大量省略号），
 * 宽于 480px 就比编辑区还宽了 —— 侧栏是辅助，不该喧宾夺主。
 *
 * **持久化不在这里** —— 值是 `SettingsStore` 的 `editor.panelWidth`。本文件只留「合法范围」
 * 这一件事：夹取要在**读**（`parse`）、**写**（`serialize`）与**拖拽**三处都生效，写成纯函数
 * 才不会有人漏掉一处。拖拽时若夹取失效，`NaN` 直接进 CSS 会让侧栏宽度变 `NaNpx`（等于 0）。
 */

export const PANEL_DEFAULT_WIDTH = 240;
export const PANEL_MIN_WIDTH = 160;
export const PANEL_MAX_WIDTH = 480;

/** 磁盘键。**冻结** —— 改名等于把用户上次拖出来的宽度丢掉。 */
export const PANEL_WIDTH_STORAGE_KEY = 'nexus-panel-width';

/**
 * 把任意输入夹到合法范围。
 *
 * 非有限数（NaN / Infinity）一律回落到默认值 —— 拖拽过程中算出的值
 * 万一变成 NaN，直接写进 CSS 会让面板宽度变成 `NaNpx`（等于 0），
 * 表现是「拖一下侧栏就消失了」，很难查。
 */
export function clampPanelWidth(value: number): number {
  if (!Number.isFinite(value)) return PANEL_DEFAULT_WIDTH;
  return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(value)));
}
