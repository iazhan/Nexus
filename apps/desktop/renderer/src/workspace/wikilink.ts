import { wikilinkCandidates, type IndexedDocument } from '@nexus/core';

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
 * 1. `relativePath` 全等（带或不带扩展名）
 * 2. 文件名全等（跨目录）
 *
 * 每一步都按 `wikilinkCandidates()` 给出的候选顺序试：`name` 原样 → `name.md`
 * → `name.markdown` → 其余白名单扩展名。**顺序即优先级，由 core 统一给出** ——
 * 反向链接侧（`index-store.ts` 的 `backlinkTargetsOf`）用的是同一套口径。两处若
 * 不一致，会出现「能跳转但查不到反向链接」这种极难察觉的偏差：两边单独看都对。
 *
 * Phase 3 / P3-04 起候选里多了附件扩展名，于是 `[[stm32]]` 也能指向 `stm32.pdf`。
 * 但**同名共存时 `[[stm32]]` 归 `.md`**（`.md` 排在候选前面），附件引用要写全名
 * `[[stm32.pdf]]` 才精确 —— 这条优先级是契约，不是实现细节。
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
  const candidates = wikilinkCandidates(target);
  if (candidates.length === 0) return { status: 'not-found', candidates: [] };

  // 先相对路径、再文件名 —— 两个阶段各自按候选顺序扫，先命中的候选优先。
  // 顺序不能在阶段之间打乱：`a/stm32.md` 与 `b/stm32.md` 同时存在时，
  // 路径阶段本来就匹配不到，得留给名字阶段去报 ambiguous。
  const byPath = matchInOrder(candidates, documents, (doc) => doc.relativePath.toLowerCase());
  if (byPath.length === 1) return { status: 'resolved', document: byPath[0]!, candidates: [] };
  if (byPath.length > 1) return { status: 'ambiguous', candidates: byPath };

  const byName = matchInOrder(candidates, documents, (doc) => doc.name.toLowerCase());
  if (byName.length === 1) return { status: 'resolved', document: byName[0]!, candidates: [] };
  if (byName.length > 1) return { status: 'ambiguous', candidates: byName };

  return { status: 'not-found', candidates: [] };
}

/**
 * 按候选顺序找第一个有命中的候选，返回该候选的全部命中。
 *
 * 返回「第一个有命中的候选」而不是「所有候选的并集」，是因为候选顺序承载了
 * 优先级：`stm32.md` 与 `stm32.pdf` 同时存在时，`[[stm32]]` 必须归前者。
 * 若把并集返回，这里会报 ambiguous，而正确的行为是明确指向 Markdown。
 */
function matchInOrder(
  candidates: readonly string[],
  documents: readonly IndexedDocument[],
  keyOf: (doc: IndexedDocument) => string
): IndexedDocument[] {
  for (const candidate of candidates) {
    const hits = documents.filter((doc) => keyOf(doc) === candidate);
    if (hits.length > 0) return hits;
  }
  return [];
}
