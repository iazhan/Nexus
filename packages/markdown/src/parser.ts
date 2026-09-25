/**
 * Markdown 解析的公共入口（门面）。
 *
 * 实现已按职责分层拆到 `parser/` 下，本文件只做逐名 re-export，保持原导入路径不变：
 *
 * ```text
 * parser/source-offsets.ts   marked token 文本 ↔ 原文偏移映射、列表项范围扫描   （最底层，无本地依赖）
 * parser/list-ranges.ts      列表项范围扫描
 * parser/inline.ts           行内层映射（项目特有行内语法 + marked inline token → AST）
 * parser/table-geometry.ts   表格几何（管道扫描 / 边界判定 / 单元格范围 / 表格 token 裁切）
 * parser/blockquote.ts       引用块的行映射与子节点偏移回填
 * parser/math-fences.ts      块级公式围栏的跨段落合并
 * parser/block-mapper.ts     块级映射器（mapBlockTokens / mapListToken / mapBlockquoteChildren 互递归，必须同模块）
 * parser/parse.ts            解析入口 parseMarkdown
 * ```
 *
 * 依赖方向单向：`source-offsets` / `list-ranges` / `table-geometry` / `blockquote` /
 * `math-fences` → `block-mapper` → `parse`；`inline` 只依赖 `source-offsets`。
 *
 * 刻意不用 `export *`：那会把 `getHeadingLineEnd` / `trimTrailingBlankLines` /
 * `getItemContentStart` / `buildBlockquoteLineMap` 这些内部辅助一并提升为公共 API。
 */

export { matchTokenEndInSource } from './parser/source-offsets.js';
export { findListItemsRanges } from './parser/list-ranges.js';
export { parseSpecialInlineSyntax } from './parser/inline.js';
export {
  getRowCellRanges,
  getUnescapedPipes,
  resolveTableBounds
} from './parser/table-geometry.js';
export { parseMarkdown } from './parser/parse.js';
