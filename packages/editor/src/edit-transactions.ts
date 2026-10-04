/**
 * 块级编辑事务的公共入口（门面）。
 *
 * 实现按职责拆在 `./edit/` 下，依赖方向单向：
 *
 * ```text
 * source-scan / lookup   （无内部依赖，只依赖 @nexus/markdown 与 types）
 *   → block-split-merge / list-edit / inline-format / insert-text /
 *     block-select / block-reorder / block-format
 * formatting-query       （只依赖 source-scan，是查询不是事务）
 * block-format           （另含两个查询：`readBlockFormatState` / `createBlockFormatAnalyzer`）
 * ```
 *
 * 这些事务模块之间**互不依赖**，都是叶子。本文件只做 re-export，逐名列出，
 * 保证 `@nexus/editor` 的公共 API 与拆分前完全一致。
 * `getLineAt`、`isBlockNode`、`LineInfo` 是模块内部辅助，刻意不导出。
 */

export {
  detectEol,
  findAtomicRanges,
  findFormattingSpans,
  readInlineCodeFence,
  inlineCodeFenceFor
} from './edit/source-scan.js';
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
export type { InlineFormatKind } from './edit/inline-format.js';

export {
  createInsertTextTransaction,
  createInsertDocumentLinkTransaction
} from './edit/insert-text.js';
export type {
  InsertDocumentLinkOptions,
  InsertDocumentLinkResult,
  InsertLinkFailure
} from './edit/insert-text.js';

export {
  createBlockFormatTransaction,
  readBlockFormatState,
  createBlockFormatAnalyzer,
  EMPTY_BLOCK_FORMAT_STATE
} from './edit/block-format.js';
export type { BlockFormatKind, BlockFormatState } from './edit/block-format.js';

export {
  scanFormatting,
  createFormattingAnalyzer,
  EMPTY_FORMATTING_STATE
} from './edit/formatting-query.js';
export type {
  InlineFormat,
  InlineMarkerSpan,
  SelectionFormattingState,
  FormattingScan,
  FormattingScanner
} from './edit/formatting-query.js';

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
