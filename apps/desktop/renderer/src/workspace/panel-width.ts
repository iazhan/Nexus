/**
 * 左侧栏宽度的默认值与持久化。
 *
 * 范围是刻意的：窄于 160px 放不下文件名（会出现大量省略号），
 * 宽于 480px 就比编辑区还宽了 —— 侧栏是辅助，不该喧宾夺主。
 */

export const PANEL_DEFAULT_WIDTH = 240;
export const PANEL_MIN_WIDTH = 160;
export const PANEL_MAX_WIDTH = 480;

const STORAGE_KEY = 'nexus-panel-width';

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

/** 读取用户上次设置的宽度；读不到、解析失败或越界都回落到默认值。 */
export function loadPanelWidth(): number {
  if (typeof localStorage === 'undefined') return PANEL_DEFAULT_WIDTH;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return PANEL_DEFAULT_WIDTH;
    return clampPanelWidth(Number(raw));
  } catch {
    return PANEL_DEFAULT_WIDTH;
  }
}

/**
 * 保存宽度。
 *
 * 写不进去就算了（隐私模式、配额满）—— 不该因为持久化失败打断拖拽。
 * 与主题 / 语言偏好一样走 localStorage，属于本机偏好而非文档数据。
 */
export function savePanelWidth(width: number): void {
  if (typeof localStorage === 'undefined') return;

  try {
    localStorage.setItem(STORAGE_KEY, String(clampPanelWidth(width)));
  } catch {
    // 静默失败：持久化不是拖拽的必要条件
  }
}
