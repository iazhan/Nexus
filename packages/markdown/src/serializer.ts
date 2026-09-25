/**
 * Markdown 序列化的公共入口（门面）。
 *
 * 实现已按职责分层拆到 `serializer/` 下，本文件只做逐名 re-export，保持原导入路径不变：
 *
 * ```text
 * serializer/text-utils.ts     纯文本工具（按原换行切分、转义单元格裸 `|`）
 * serializer/dirty.ts          脏标记判定（isCellDirty / isNodeDirty / hasDirtyChildren 互递归，必须同模块）
 * serializer/inline.ts         行内序列化（serializeInlines / serializeInline 互递归）
 * serializer/table.ts          表格序列化（重建 / 只替换脏单元格）
 * serializer/simple-blocks.ts  简单块：标题、段落、块级公式
 * serializer/code-block.ts     代码块
 * serializer/blocks.ts         块级分派（serializeBlock / serializeListItem / serializeBlockquote 互递归，必须同模块）
 * serializer/node.ts           入口 serializeNode / serializeMarkdown
 * ```
 *
 * 依赖方向单向：`text-utils` / `dirty` / `code-block` → `inline` → `table` / `simple-blocks`
 * → `blocks` → `node`。
 *
 * 刻意不用 `export *`：那会把 `hasDirtyChildren` / `splitLinesWithBreaks` /
 * `serializeHeading` 这些内部辅助一并提升为公共 API。
 */

export { isCellDirty, isNodeDirty, markDirty } from './serializer/dirty.js';
export { serializeInline, serializeInlines } from './serializer/inline.js';
export { escapeTableCellPipes } from './serializer/text-utils.js';
export { serializeBlock, serializeListItem } from './serializer/blocks.js';
export { serializeMarkdown, serializeNode } from './serializer/node.js';

export type { MarkdownSerializeOptions } from './serializer/node.js';
