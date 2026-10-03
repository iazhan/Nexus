/**
 * 工作区侧栏的图标。
 *
 * 规格照 `section-icons.tsx`：`viewBox="0 0 24 24"`、`stroke="currentColor"`、`fill="none"`。
 * 线宽分两档 —— 工具栏按钮是 14px、树行是 13px，都比设置页那套 16px 小，所以按 24 视箱
 * 等比缩放后要更粗一点才不发虚（同 `section-icons.tsx` 头注释里那条推导）。
 *
 * **颜色一律走 `currentColor`**：由调用方按「默认 / 悬停 / 选中 / 禁用」给色，
 * 图标自己持色就得多写几条覆盖规则，还会漏掉禁用那一态。
 *
 * ## 文件行为什么按类型分成五枚（2026-10-03 改）
 *
 * 原来只有两枚：笔记一枚，其余附件**共用**一枚相框。结果是图片和 PDF 长得一模一样，
 * 而这两类恰恰是树上最需要分开的 —— 一个是素材，一个是成品。
 *
 * **区分靠外形轮廓，不靠内部细节。** 树行图标是 13px，24 视箱缩下去之后 1 个单位只剩
 * 0.54px：靠「纸里画两条横线还是三条」这种差别根本分不出来，会糊成一团。所以外形先拉开
 * —— 竖长的纸（Markdown / PDF / DOCX / 通用文件）与横宽的相框（图片）—— 同外形的三枚
 * 再各带**一个**形状不同的记号：下箭头 / 两条横线 / 方框。
 *
 * 下箭头取的是 Markdown 记号 `M↓` 里可线稿化的那一半 —— 用户在其他编辑器里已经认过它，
 * 不必再学一个新符号。
 */

import type { DocumentType } from '@nexus/core';
import type { ReactNode } from 'react';

const TOOLBAR_PROPS = {
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

const ROW_PROPS = {
  width: 13,
  height: 13,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
};

/** 新建文件：一页纸 + 右下角的加号。 */
export const NewFileIcon = (
  <svg {...TOOLBAR_PROPS}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6" />
    <path d="M14 3v5h5" />
    <path d="M18 15v6M15 18h6" />
  </svg>
);

/** 新建文件夹：文件夹 + 加号。 */
export const NewFolderIcon = (
  <svg {...TOOLBAR_PROPS}>
    <path d="M3 7a2 2 0 0 1 2-2h3.6l1.8 2H19a2 2 0 0 1 2 2v2" />
    <path d="M3 7v10a2 2 0 0 0 2 2h6" />
    <path d="M18 14v6M15 17h6" />
  </svg>
);

/** 删除：垃圾桶。与「清理未用图片」在 Markra 里共用同一枚，这里也只有这一处用。 */
export const TrashIcon = (
  <svg {...TOOLBAR_PROPS}>
    <path d="M4 7h16" />
    <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

/**
 * 图片开关：**一枚图标画两种状态**。
 *
 * 显示中 → 眼睛带斜杠（「点它会藏起来」），隐藏中 → 眼睛（「点它会露出来」）。
 * 用同一枚图标翻转而不是两枚不同形状：按钮位置固定，形状突变会让人以为按错了地方。
 *
 * 画眼睛而不是画一张图：这个按钮答的是「图片还在不在树里」，而一张缩略图图标
 * 会被读成「插入图片」—— 那是编辑器的动作，不是侧栏的。
 */
export const ImagesVisibleIcon = (
  <svg {...TOOLBAR_PROPS}>
    <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" />
    <circle cx="12" cy="12" r="2.6" />
    <path d="M4 4l16 16" />
  </svg>
);

export const ImagesHiddenIcon = (
  <svg {...TOOLBAR_PROPS}>
    <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);

/** 重新扫描：闭环箭头。 */
export const RefreshIcon = (
  <svg {...TOOLBAR_PROPS}>
    <path d="M20 12a8 8 0 1 1-2.3-5.6" />
    <path d="M20 4v4h-4" />
  </svg>
);

/**
 * 一键展开 / 收起文件树。
 *
 * 两枚用**同一个记号**（树行左边那个折叠箭头）叠两个、方向相反 —— 用户已经在树里
 * 认过这个符号，再画一套新图形只是多一个要学的记号。
 *
 * 展开 = 两个箭头**朝外**（散开），收起 = 两个箭头**朝里**（聚拢）。
 * 这两个词在中文里就带着方向，图形跟着走比另找隐喻好认。
 */
export const ExpandAllIcon = (
  <svg {...TOOLBAR_PROPS}>
    <polyline points="8 9 12 5 16 9" />
    <polyline points="8 15 12 19 16 15" />
  </svg>
);

export const CollapseAllIcon = (
  <svg {...TOOLBAR_PROPS}>
    <polyline points="8 5 12 9 16 5" />
    <polyline points="8 19 12 15 16 19" />
  </svg>
);

/** 目录行左侧的折叠箭头。目录与树共用一枚 —— 两份内联 SVG 迟早会改歪一个。 */
export const ChevronIcon = (
  <svg {...ROW_PROPS} width={10} height={10} strokeWidth={3}>
    <polyline points="9 6 15 12 9 18" />
  </svg>
);

/** 目录。 */
export const FolderRowIcon = (
  <svg {...ROW_PROPS}>
    <path d="M3 7a2 2 0 0 1 2-2h3.6l1.8 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </svg>
);

/**
 * Markdown 笔记：一页纸 + 折角 + 下箭头。
 *
 * **记号为什么是下箭头而不是 M**（试过）：Markdown 的官方记号是 `M↓`，直觉上该画 M，
 * 但 M 要 4 段线，13px 下全挤在 4px 宽里会糊成一团 —— 要 16px 才认得出，而树行就是 13px。
 * 下箭头只有 2 段线，13px 下依然清楚。**13px 的记号最多容纳 2 段线**，这条判据对以后
 * 往纸里加记号同样成立。
 */
export const MarkdownRowIcon = (
  <svg {...ROW_PROPS}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5" />
    <path d="M12 11v6.5" />
    <path d="M9 14l3 3 3-3" />
  </svg>
);

/** 图片：**横宽**的相框 + 太阳 + 山。 */
export const ImageRowIcon = (
  <svg {...ROW_PROPS}>
    <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
    <circle cx="8" cy="9.5" r="1.5" />
    <path d="M4.5 17.5l4-4 3 3 3.5-3.5 4.5 4.5" />
  </svg>
);

/** PDF：一页纸 + 折角 + 两条文本行（排版好的页面）。 */
export const PdfRowIcon = (
  <svg {...ROW_PROPS}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5" />
    <path d="M8.5 12.5h7" />
    <path d="M8.5 16.5h7" />
  </svg>
);

/** DOCX：一页纸 + 折角 + 一个版心框（可编辑的版式，与 PDF 的成品页面区分）。 */
export const DocxRowIcon = (
  <svg {...ROW_PROPS}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5" />
    <rect x="8" y="11.5" width="8" height="7" rx="1.5" />
  </svg>
);

/** 通用文件：一页纸 + 折角。索引里没有它的类型时用它（白名单外的扩展名）。 */
export const FileRowIcon = (
  <svg {...ROW_PROPS}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5" />
  </svg>
);

const ROW_ICONS: Record<DocumentType, ReactNode> = {
  markdown: MarkdownRowIcon,
  image: ImageRowIcon,
  pdf: PdfRowIcon,
  docx: DocxRowIcon
};

/**
 * 文件行该画哪一枚。`null`（索引里没有这个文件）落到通用文件。
 *
 * 收在这里而不是让调用方 `switch`：`DocumentType` 多一种格式时只改这一处，
 * 而 `Record<DocumentType, …>` 的穷尽性会让「加了类型忘了配图标」当场变成类型错误。
 */
export function fileRowIcon(type: DocumentType | null | undefined): ReactNode {
  return type === null || type === undefined ? FileRowIcon : ROW_ICONS[type];
}

export const RetryIcon = (
  <svg {...TOOLBAR_PROPS} width={13} height={13}>
    <path d="M20 12a8 8 0 1 1-2.3-5.6" />
    <path d="M20 4v4h-4" />
  </svg>
);
