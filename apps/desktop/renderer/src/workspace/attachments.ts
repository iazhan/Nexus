import type { IndexedDocument } from '@nexus/core';

/** 附件行上要显示的提取提示。 */
export type ExtractionNote = 'empty' | 'failed';

/**
 * 附件行该不该提示「文本提取」的结果 —— **只有两种状态会显示**。
 *
 * `'none'` 不提示：它在索引层同时表示「没有处理器认领这个类型」（图片）与「这一轮
 * 它没被引用」，两者都不该有提示。这正是合并这两个语义的收益 —— 渲染进程**不需要**
 * 知道哪些类型有处理器（否则等于把主进程的注册表复制一份，两份迟早不一致）。
 *
 * `'empty'`（真的没有文本，如扫描版 PDF）与 `'failed'`（本来可能有、读失败了）保留
 * 区别：前者是事实，后者是故障。判据放渲染层，因为「哪些状态值得提示」是界面决策。
 *
 * ## 这个文件原来还有两件事，2026-10-01 都搬走了
 *
 * `splitIndexedDocuments` / `buildAttachmentGroups` 服务于「笔记树 + 附件区」两段布局。
 * 那个布局已经取消 —— 附件与笔记现在是同一棵树里的节点，按目录结构混排，由工具栏的
 * 一个开关过滤（`tree-filter.ts`）。**分类与分组不再存在，所以那两个函数连同它们的
 * 单测一起删掉了**，不是被别处取代。
 *
 * 保留 `extractionNoteOf` 是因为它服务的那个显示还在：附件行仍然要标出
 * 「未提取到文本」与提取失败。
 */
export function extractionNoteOf(document: IndexedDocument): ExtractionNote | null {
  return document.extractionStatus === 'empty' || document.extractionStatus === 'failed'
    ? document.extractionStatus
    : null;
}
