/**
 * 块级编辑事务的公共入口（门面）。
 *
 * 实现按职责拆在 `./edit/` 下，依赖方向单向：
 *
 * ```text
 * source-scan / lookup   （无内部依赖，只依赖 @nexus/markdown 与 types）
 *   → block-split-merge / list-edit / inline-format / block-select / block-reorder
 * ```
 *
 * 五个事务模块之间**互不依赖**，都是叶子。本文件只做 re-export，逐名列出，
 * 保证 `@nexus/editor` 的公共 API 与拆分前完全一致。
 * `getLineAt`、`isBlockNode`、`LineInfo` 是模块内部辅助，刻意不导出。
 */

export { detectEol, findAtomicRanges, findFormattingSpans } from './edit/source-scan.js';
export type { AtomicNodeRange, FormattingSpan } from './edit/source-scan.js';

export {
  parseLines,
  findContainingBlockIndex,
  isFenceClosed,
  findContainingBlock,
  getContentEnd,
  findDeepestBlockAtPos,
  getQuotePrefixLength,
  findListItemAtPos
} from './edit/lookup.js';
export type { BlockContext, ListItemContext } from './edit/lookup.js';

export {
  createParagraphOrHeadingSplitTransaction,
  createBlockMergeTransaction
} from './edit/block-split-merge.js';

export {
  createListIndentTransaction,
  createListOutdentTransaction,
  createTaskCheckboxToggleTransaction
} from './edit/list-edit.js';

export { createInlineFormatTransaction } from './edit/inline-format.js';

export {
  createSelectBlockAtPositionTransaction,
  createSelectBlockAtIndexTransaction,
  createSelectBlockTransaction
} from './edit/block-select.js';

export {
  reorderSiblingBlocks,
  createReorderBlockAtPositionTransaction,
  createReorderBlockTransaction,
  createReorderBlockToPositionTransaction
} from './edit/block-reorder.js';
