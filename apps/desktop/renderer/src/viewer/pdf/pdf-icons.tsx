/**
 * PDF 阅读器工具栏的图标集。
 *
 * 规格与 `viewer-icons.tsx` **共用一份**（`VIEWER_ICON_PROPS`）—— 由那里统一定，
 * 这里不再抄一遍。缩放那一对（`zoomIn` / `zoomOut`）的图形也直接导入图片查看器
 * 在用的那两个：同样的 `<path>` 写两份迟早漂成两种，而漂移在 14px 下看得见。
 *
 * ## 为什么工具栏从文字换成图标（2026-10-14）
 *
 * 原来九个按钮全是汉字（「导航」「上一页」「下一页」「适合宽度」「连续」……），
 * 一条工具栏被文字撑得很长，而它们做的都是**公认的手势**（翻页、缩放、切布局），
 * 图标比文字更快认。代价是**可访问名没了** —— 可见文字本身就是可访问名，图标不是
 * （这里全部 `aria-hidden`），所以每一枚按钮都必须自带 `aria-label`。
 * 这条不能忘：漏了的话按钮在无障碍树里就是一个没有名字的「按钮」。
 *
 * ## 颜色一律 `currentColor`
 *
 * 由调用方按「默认 / 悬停 / 选中 / 禁用」给色。图标自己持色就得多写几条覆盖规则，
 * 还会漏掉禁用那一态（同 `workspace-icons.tsx` 那条注释）。
 */

import type { ReactNode } from 'react';
import { VIEWER_ICON_PROPS, VIEWER_ICON_SHAPES } from '../viewer-icons.js';

const ICON_PROPS = VIEWER_ICON_PROPS;

/** 工具栏图标名。 */
export type PdfIconName =
  | 'navigation'
  | 'previousPage'
  | 'nextPage'
  | 'zoomIn'
  | 'zoomOut'
  | 'fitWidth'
  | 'layoutContinuous'
  | 'layoutSingle'
  | 'selectText'
  | 'hand';

export const PDF_ICON_SHAPES: Record<PdfIconName, ReactNode> = {
  /** 导航：一块面板 + 左侧一列，读作「侧栏」。 */
  navigation: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  /** 翻页用上下箭头：文档是**竖着**读的，左右箭头会被读成「上一个/下一个文件」。 */
  previousPage: <path d="M6 15l6-6 6 6" />,
  nextPage: <path d="M6 9l6 6 6-6" />,
  zoomIn: VIEWER_ICON_SHAPES.zoomIn,
  zoomOut: VIEWER_ICON_SHAPES.zoomOut,
  /** 适合宽度：一页纸 + 里面的水平双向箭头。 */
  fitWidth: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 12h10M9 10l-2 2 2 2M15 10l2 2-2 2" />
    </>
  ),
  /** 连续滚动：两张上下叠着的纸。 */
  layoutContinuous: (
    <>
      <rect x="5" y="3" width="14" height="7" rx="1" />
      <rect x="5" y="14" width="14" height="7" rx="1" />
    </>
  ),
  /** 单页：一张纸。 */
  layoutSingle: <rect x="6" y="3" width="12" height="18" rx="1" />,
  /** 选择文本：I 形文本光标。 */
  selectText: <path d="M9 4h6M9 20h6M12 4v16" />,
  /**
   * 拖动：张开的手。
   *
   * 手掌与四指是**同一条闭合轮廓**，不是「一个方块 + 四根分离的短线」—— 后者在 14px 下
   * 糊成一团，读出来像个梳子（同 `rail-icons.tsx` 里齿轮那条推导）。
   */
  hand: (
    <>
      <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
      <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </>
  )
};

/** 按 14px 的规格包一层 `<svg>`。 */
export function pdfIcon(name: PdfIconName): ReactNode {
  return <svg {...ICON_PROPS}>{PDF_ICON_SHAPES[name]}</svg>;
}
