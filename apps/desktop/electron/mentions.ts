import { findUnlinkedMentions } from '@nexus/core';
import type { UnlinkedMention } from '@nexus/core';
import type { MentionResult } from '@nexus/core';
import type { FileService } from './file-service.js';
import type { IndexStore } from './index-store.js';

/**
 * 「未链接提及」：工作区里哪些文档在正文提到了目标文档，却没有写成链接。
 *
 * ## 为什么在主进程扫，不进索引
 *
 * 扫描要读**正文**，而索引里只有切分后的 FTS 文本（不是原文，也没有偏移）。
 * 把它塞进索引意味着每存一篇文档都要对全库重扫一遍 —— 那是每次保存都要付的钱，
 * 而这个功能只在**打开某篇文档的反向链接面板**时才需要答案。
 *
 * 代价是每次切换文档都要重读全库的 Markdown。所以有两道闸：跳过过大的文件、
 * 结果数量封顶。它们都不是「优化」，是**保证这个功能不会因为一个巨型文件而卡住界面**。
 *
 * ## 候选写法与解析口径同一份
 *
 * 用 `store.backlinkTargetsOf()` —— 与 `resolveWikiLink` 一致。**刻意不含「首个 H1」**：
 * 那是 Obsidian 的语义（wikilink 认标题），Nexus 的解析只认文件名与相对路径，
 * 把 H1 算进来会建议一条点开是 `not-found` 的链接。
 */
/** 单篇超过这个大小就不扫了。读它一遍的代价已经超过「找出几处提及」的收益。 */
const MAX_SCAN_BYTES = 512 * 1024;

/** 结果上限。到顶之后**如实截断**（调用方据此提示），而不是静默丢掉剩下的。 */
const MAX_MENTIONS = 50;

export interface FindMentionsOptions {
  service: FileService;
  store: IndexStore;
  documentPath: string;
}

export async function findMentionsOfDocument(
  options: FindMentionsOptions
): Promise<MentionResult> {
  const { service, store, documentPath } = options;

  const target = store.getDocumentByPath(documentPath);
  if (target === null || target.type !== 'markdown') return { mentions: [], truncated: false };

  const candidates = store.backlinkTargetsOf(target);
  if (candidates.length === 0) return { mentions: [], truncated: false };

  const mentions: UnlinkedMention[] = [];
  let truncated = false;

  for (const document of store.listDocuments()) {
    if (document.type !== 'markdown' || document.id === target.id) continue;
    if (document.sizeBytes > MAX_SCAN_BYTES) continue;

    let source: string;
    try {
      source = await service.readFile(document.path);
    } catch {
      // 读不动（权限、扫描途中被删）不该让整次查询失败 —— 跳过这一篇
      continue;
    }

    for (const range of findUnlinkedMentions(source, candidates)) {
      if (mentions.length >= MAX_MENTIONS) {
        truncated = true;
        break;
      }
      mentions.push({ document, ...range });
    }
    if (truncated) break;
  }

  // 按相对路径排，结果与 `listDocuments()` 的顺序一致、可断言
  mentions.sort((a, b) => a.document.relativePath.localeCompare(b.document.relativePath));
  return { mentions, truncated };
}
