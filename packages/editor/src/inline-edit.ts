/**
 * 行内节点（链接 / 图片 / 行内代码 / WikiLink）的就地编辑与 popover 回写的公共入口（门面）。
 *
 * 实现按职责拆在 `./inline/` 下，依赖方向单向：
 *
 * ```text
 * types / text-utils / link-syntax   （无内部依赖）
 *   → node-lookup → transactions → widgets / math-activation → extension
 * ```
 *
 * 本文件只做 re-export，逐名列出，保证 `@nexus/editor` 的公共 API 与拆分前完全一致。
 * 模块内部的辅助（`inlineEditOptionsFacet`、`ActivePopoverState`、`findInlineNodeAtRange`、
 * `verifyCandidateNode`、`parseLocalParenDescriptor`、`LocalParenDescriptor`）刻意不导出。
 */

export type {
  InlineEditNodeType,
  InlineEditContext,
  LinkEditValue,
  ImageEditValue,
  InlineCodeEditValue,
  WikiLinkEditValue,
  ImageEditContext,
  ImageSourceResolver,
  InlineEditExtensionOptions
} from './inline/types.js';

export {
  escapeMarkdownInlineText,
  unescapeMarkdownInlineText,
  extractLinkRawLabel,
  getInlineNodePlainText
} from './inline/text-utils.js';

export {
  requiresAngleBrackets,
  getReferenceKind
} from './inline/link-syntax.js';
export type { ReferenceKind } from './inline/link-syntax.js';

export {
  createLinkEditTransaction,
  createImageEditTransaction,
  createInlineCodeEditTransaction,
  createWikiLinkEditTransaction
} from './inline/transactions.js';

export {
  LinkWidget,
  ImageWidget,
  InlineMathWidget,
  InlineCodeWidget,
  WikiLinkWidget
} from './inline/widgets.js';

export { mathActivationAnchor, activateMathSource } from './inline/math-activation.js';

export { createInlineEditExtension } from './inline/extension.js';
