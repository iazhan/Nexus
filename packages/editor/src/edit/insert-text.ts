import {
  buildDocumentLink,
  type LinkBuildFailure,
  type LinkFormat,
  type LinkTargetDocument
} from '@nexus/core';
import type { MarkdownEditTransaction, MarkdownSelection } from '../types.js';

/**
 * 「往正文里插一段文本」的原语，以及它上面长出来的「插入文档链接」。
 *
 * ## 为什么需要它
 *
 * 编辑器里此前只有「改写已有结构」的事务（拆块 / 合并 / 缩进 / 加标记），
 * **没有一条「在这里放一段新文本」**。而「插入链接」正是这件事 ——
 * 写出来的是什么字符串是 `@nexus/core` 的 `buildDocumentLink` 管的（它必须与
 * `resolveWikiLink` / `resolveRelativePath` 互为逆运算），这里只管**放到哪**。
 *
 * ## 插入不做原子守卫，这是有意的
 *
 * 行内标记那几条要在 `findAtomicRanges` 上拒绝（切进代码块会切坏结构），插入**不会**：
 * 它只是一次纯文本替换，插在哪儿都不会把谁切成两半。所以这里没有第二份守卫 ——
 * 判据分散在两处迟早漂，而「原子节点里要不要给插」是**调用方**的事
 * （工具栏按 `formatting-query` 的 `atomic` 禁用按钮）。
 *
 * ## 光标落在插入内容之后
 *
 * 接着打字是「在链接后面继续写」，不是「把刚插进去的链接改掉」。所以不给「选中插入内容」。
 */

/** 插入后的光标落点与 userEvent 都在这里定，调用方不必各写一遍。 */
function insertText(
  selection: MarkdownSelection,
  text: string
): MarkdownEditTransaction {
  const from = Math.min(selection.anchor, selection.head);
  const to = Math.max(selection.anchor, selection.head);
  return {
    changes: [{ from, to, insert: text }],
    selection: { anchor: from + text.length, head: from + text.length },
    userEvent: 'input.insertText'
  };
}

/** 在选区处插入一段文本；有非空选区就替换它。空串返回 `null`（不产生空事务）。 */
export function createInsertTextTransaction(
  selection: MarkdownSelection,
  text: string
): MarkdownEditTransaction | null {
  return text.length === 0 ? null : insertText(selection, text);
}

/** 插不进去的原因。`read-only` 不是 `buildDocumentLink` 的失败面，是编辑器自己的。 */
export type InsertLinkFailure = LinkBuildFailure | 'read-only';

export interface InsertDocumentLinkOptions {
  target: LinkTargetDocument;
  format: LinkFormat;
  /** 当前文档的绝对路径。Markdown 档算「相对谁」要用，缺了就只能拒绝。 */
  currentDocumentPath: string | null;
}

export type InsertDocumentLinkResult =
  | { ok: true; transaction: MarkdownEditTransaction }
  | { ok: false; reason: LinkBuildFailure };

/**
 * 把一条指向工作区文档的链接拼好，并做成插到选区处的**一个**事务。
 *
 * ## 选中文字就是链接文字
 *
 * 工具栏上这条动作**只在有选区时出现**，「选中一段文字再点链接」在用户心里就是
 * 「把这段文字变成链接」。不用它当链接文字的话，点一下就把用户写的字吞掉了。
 * 走 `buildDocumentLink` 的 `label` 参数，而不是在这里拼字符串 ——
 * 「写出来必须能读回来」的契约只能有一份。
 *
 * 三种情况**不给**标签、退回「用目标文档的标题」：空选区（从命令面板调起时就是这样）、
 * 跨行选区（换行会把两种语法都弄坏）、去空白后为空。这不是静默失败 ——
 * 写出来的仍然是一条**正确**的链接，只是文字是目标文档的标题。
 *
 * ## 写不出来时**必须**返回原因
 *
 * 目标名或选中文字里有 wikilink 表达不了的字符（`]` `|`）时，`buildDocumentLink`
 * 会拒绝。调用方要把原因翻成给用户看的话 —— 静默什么都不做，用户只会以为按钮是摆设。
 */
export function createInsertDocumentLinkTransaction(
  source: string,
  selection: MarkdownSelection,
  options: InsertDocumentLinkOptions
): InsertDocumentLinkResult {
  const built = buildDocumentLink(
    options.target,
    options.format,
    options.currentDocumentPath,
    linkLabelFrom(source, selection)
  );
  if (!built.ok) return { ok: false, reason: built.reason };

  return { ok: true, transaction: insertText(selection, built.text) };
}

function linkLabelFrom(source: string, selection: MarkdownSelection): string | undefined {
  if (selection.anchor === selection.head) return undefined;
  const raw = source.slice(
    Math.min(selection.anchor, selection.head),
    Math.max(selection.anchor, selection.head)
  );
  if (/[\r\n]/.test(raw)) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
