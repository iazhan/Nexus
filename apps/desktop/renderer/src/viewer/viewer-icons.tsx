/**
 * 查看器工具栏的**共享**图标规格与图形。
 *
 * 三个工具栏（编辑器常驻栏 / PDF / 图片）的图标必须是同一套规格：14px、
 * `viewBox="0 0 24 24"`、`fill="none"`、`stroke="currentColor"`、线宽 2。
 * 规格抄自 `components/workspace-icons.tsx` —— 高度一样的按钮并排，图标一大一小
 * 看着就是歪的。
 *
 * ## 为什么单独拆一个文件（2026-10-15）
 *
 * `zoomIn` / `zoomOut` 原先 PDF 与图片**各写了一份同样的 `<path>`**。同样的图形写两遍，
 * 迟早漂成两种（一边改了线宽、一边忘了），而漂移在 14px 下**看得见**。
 * 所以缩放这一对只在这里定义一次，`pdf-icons.tsx` 改为从本文件导入。
 *
 * ## 颜色一律 `currentColor`
 *
 * 由调用方按「默认 / 悬停 / 按下 / 禁用」给色（同 `pdf-icons.tsx` 的理由）：
 * 图标自己持色就得多写几条覆盖规则，还会漏掉禁用那一态。
 */

import type { ReactNode } from 'react';

/** 工具栏图标的规格。三处工具栏共用一份，别处再抄一遍就是漂移的起点。 */
export const VIEWER_ICON_PROPS = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
};

/** 跨查看器共用的图标名。 */
export type ViewerIconName = 'zoomIn' | 'zoomOut' | 'fitWindow' | 'actualSize';

export const VIEWER_ICON_SHAPES: Record<ViewerIconName, ReactNode> = {
  /** 放大：一横一竖。 */
  zoomIn: <path d="M12 5v14M5 12h14" />,
  /** 缩小：只剩一横。 */
  zoomOut: <path d="M5 12h14" />,
  /**
   * 适合窗口：外面的窗口矩形 + 里面的图片矩形。
   *
   * 两个框套起来读作「图在窗里」—— 与 PDF 的「适合宽度」（一页纸 + 水平箭头）
   * 是两件事，那个还有方向性，这个只有包含关系。
   */
  fitWindow: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <rect x="8" y="9" width="8" height="6" rx="1" />
    </>
  ),
  /**
   * 实际大小（100%）：上面的图片矩形 + 下面一条尺寸线。
   *
   * 尺寸线比图**宽**，两端箭头朝外 —— 读作「按真实像素量它」，与「适合窗口」的
   * 包含关系正好对立。箭头不画成朝内：朝内读起来像「把图压进这条线」。
   */
  actualSize: (
    <>
      <rect x="7" y="3" width="10" height="8" rx="1" />
      <path d="M4 15h16" />
      <path d="M7 12l-3 3 3 3" />
      <path d="M17 12l3 3-3 3" />
    </>
  )
};

/** 按 14px 的规格包一层 `<svg>`。 */
export function viewerIcon(name: ViewerIconName): ReactNode {
  return <svg {...VIEWER_ICON_PROPS}>{VIEWER_ICON_SHAPES[name]}</svg>;
}
