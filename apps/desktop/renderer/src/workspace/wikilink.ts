import type { IndexedDocument } from '@nexus/core';

export type WikiLinkStatus = 'resolved' | 'not-found' | 'ambiguous';

export interface WikiLinkResolution {
  status: WikiLinkStatus;
  /** 仅在 `resolved` 时有值 */
  document?: IndexedDocument;
  /** 仅在 `ambiguous` 时给出候选，供 UI 让用户自己选 */
  candidates: IndexedDocument[];
}

/**
 * 把 `[[目标]]` 解析成工作区里的一篇文档。
 *
 * ## 匹配顺序（先精确后宽松）
 *
 * 1. `relativePath` 全等（带或不带 `.md`）
 * 2. 文件名全等（跨目录）
 *
 * 两者都**大小写不敏感** —— Obsidian 的 wikilink 也不区分大小写，
 * 用户在正文里写 `[[DMA]]` 不该因为磁盘上是 `dma.md` 就找不到。
 *
 * ## 为什么同名要返回 ambiguous 而不是挑一个
 *
 * 随便挑一个的话，链接看起来是通的、其实可能指到了另一篇。用户不会发现，
 * 直到某天发现内容不对。返回候选让 UI 明确问一次，代价小得多。
 */
export function resolveWikiLink(
  target: string,
  documents: readonly IndexedDocument[]
): WikiLinkResolution {
  const raw = target.trim();
  if (raw.length === 0) return { status: 'not-found', candidates: [] };

  const needle = raw.toLowerCase();
  const withExtension = needle.endsWith('.md') ? needle : `${needle}.md`;

  // 1. 相对路径全等
  const byPath = documents.filter((doc) => {
    const path = doc.relativePath.toLowerCase();
    return path === needle || path === withExtension;
  });
  if (byPath.length === 1) return { status: 'resolved', document: byPath[0]!, candidates: [] };
  if (byPath.length > 1) return { status: 'ambiguous', candidates: byPath };

  // 2. 文件名全等（跨目录）
  const byName = documents.filter((doc) => {
    const name = doc.name.toLowerCase();
    return name === needle || name === withExtension;
  });
  if (byName.length === 1) return { status: 'resolved', document: byName[0]!, candidates: [] };
  if (byName.length > 1) return { status: 'ambiguous', candidates: byName };

  return { status: 'not-found', candidates: [] };
}
