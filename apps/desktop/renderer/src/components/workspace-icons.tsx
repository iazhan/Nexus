/**
 * 工作区侧栏的图标。
 *
 * 规格照 `section-icons.tsx`：`viewBox="0 0 24 24"`、`stroke="currentColor"`、`fill="none"`。
 * 线宽分两档 —— 工具栏按钮是 14px、树行是 13px，都比设置页那套 16px 小，所以按 24 视箱
 * 等比缩放后要更粗一点才不发虚（同 `section-icons.tsx` 头注释里那条推导）。
 *
 * **颜色一律走 `currentColor`**：由调用方按「默认 / 悬停 / 选中 / 禁用」给色，
 * 图标自己持色就得多写几条覆盖规则，还会漏掉禁用那一态。
 */

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

/** Markdown 笔记：一页纸。 */
export const NoteRowIcon = (
  <svg {...ROW_PROPS}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5" />
  </svg>
);

/**
 * 附件。
 *
 * 三种附件类型**共用一枚图标**是刻意的：侧栏很窄，一列 13px 的图标里再区分
 * 「图片 / PDF / DOCX」只会变成三个几乎一样的方框，谁也认不出。要区分就靠扩展名
 * 本身 —— 它就在名字里，而且比图标准确。等真的需要在树上按类型筛，再谈专用图标。
 */
export const AttachmentRowIcon = (
  <svg {...ROW_PROPS}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.6" />
    <path d="M4 17l4.5-4.5L13 17l3-3 4 4" />
  </svg>
);

export const RetryIcon = (
  <svg {...TOOLBAR_PROPS} width={13} height={13}>
    <path d="M20 12a8 8 0 1 1-2.3-5.6" />
    <path d="M20 4v4h-4" />
  </svg>
);
