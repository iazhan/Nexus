import { splitWikilinkAnchor, wikilinkCandidates } from './links.js';
import type { IndexedDocument } from '../types/file.js';

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
 * ## 锚点不参与「指向哪一篇」的判断
 *
 * `[[dma#性能]]` 指向的是 `dma.md` 里的一个位置，`#性能` 是位置后缀、不是名字的一部分。
 * 所以先把它切掉再取候选，切法走 `splitWikilinkAnchor()`（`links.ts`）——
 * **索引侧、反向链接侧、这里共用同一份**，各写一遍会让带锚点的引用在某一侧凭空消失。
 *
 * 切完只剩「打开正确的文档」这一半：**还不会滚到那个标题**。滚动落点是编辑器侧的事
 * （`heading-anchor.ts` 的 `revealHeadingAt`），反向链接面板把它接上之前，
 * 带锚点的链接与不带的行为一致 —— 打开到顶部。
 * 不切的话结果更糟：`点了报链接解析失败`。
 *
 * ## 为什么同名要返回 ambiguous 而不是挑一个
 *
 * 随便挑一个的话，链接看起来是通的、其实可能指到了另一篇。用户不会发现，
 * 直到某天发现内容不对。返回候选让 UI 明确问一次，代价小得多。
 *
 * ## 为什么住在 core 而不是 renderer（批二搬过来的）
 *
 * 它本来就是纯函数（只依赖 `wikilinkCandidates()` 与文档列表）。批二起**主进程**
 * 也要用它 —— 重命名时要判断「这条引用是不是指向被改名的那一篇」，而那是回写的
 * 唯一权威判据（不能用 `findBacklinks`，它的归一化只去 `.md`，`[[dma.markdown]]`
 * 能跳转却查不到反向链接）。渲染进程判跳转、主进程判回写，两处各写一份必然漂。
 */
export function resolveWikiLink(
  target: string,
  documents: readonly IndexedDocument[]
): WikiLinkResolution {
  const candidates = wikilinkCandidates(splitWikilinkAnchor(target).path);
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

/**
 * 把一个 wikilink 目标改写成「指向改名后的那一篇」的写法；**认不出来就返回 `null`**。
 *
 * ## 它做什么、不做什么
 *
 * **不做判定** —— 「这条引用到底指向谁」由 `resolveWikiLink()` 说了算，调用方先解析、
 * 确认目标就是被改名的那一篇，再把这个函数当**纯粹的字符串变换**用。分开的理由是
 * 判定要文档列表、变换只要两个路径；混在一起会让这个函数无法单测「写法保留」这一半。
 *
 * **只换路径、原样保留用户写目标的方式**：
 *
 * | 用户写的 | `from` → `to` | 改成 | 保留的是 |
 * | --- | --- | --- | --- |
 * | `dma` | `notes/dma.md` → `notes/dma2.md` | `dma2` | 「只写名字」 |
 * | `notes/dma` | 同上 | `notes/dma2` | 「写工作区相对路径」 |
 * | `dma.md` | 同上 | `dma2.md` | 「显式写扩展名」 |
 * | `notes/dma.md` | 同上 | `notes/dma2.md` | 全路径 |
 * | `dma#性能` | 同上 | `dma2#性能` | 锚点原样 |
 * | `stm32` | `stm32.pdf` → `banner.pdf` | `banner` | 附件也能被 wikilink 引用，短名照旧 |
 *
 * **大小写按磁盘上的真名写**：用户写 `DMA`、磁盘上是 `dma.md` 时改成 `dma2`
 * 而不是 `DMA2` —— 解析本来就不区分大小写，硬去猜用户的排版意图只会引入第二条规则。
 *
 * **四种写法都认不出时返回 `null`**（例如 `../dma` —— wikilink 的路径段是**工作区根
 * 相对**的，不存在 `../` 这种写法，解析阶段本来就匹配不到）。这是防御性分支：
 * 正常路径下判定已经过了，走不到这里。
 *
 * **写不出来也返回 `null`**：新名字里含 `]` `|` 或换行时无法安全表达 —— `]` 会让
 * wikilink 提前结束、`|` 会被当成别名分隔符。宁可让链接断掉（它是**可见**的
 * `not-found`），也不要写出一段语法坏掉的正文。
 */
export function rewriteWikiLinkTarget(
  rawTarget: string,
  from: string,
  to: string
): string | null {
  const hashIndex = rawTarget.indexOf('#');
  const anchor = hashIndex >= 0 ? rawTarget.slice(hashIndex) : '';
  const written = (hashIndex >= 0 ? rawTarget.slice(0, hashIndex) : rawTarget).trim();
  if (written.length === 0) return null;

  const next = matchWrittenStyle(written, normalizeSlashes(from), normalizeSlashes(to));
  if (next === null) return null;
  if (/[[\]|\r\n]/.test(next)) return null;

  return next + anchor;
}

/**
 * 按用户写下的四种形态之一，给出对应的新写法。
 *
 * 顺序不能换：文档在**根目录**时 `from` 与 `from` 的基名相等（`dma.md`），
 * 先判「全路径」才能让 `[[dma.md]]` 得到 `dma2.md` 而不是落到基名分支。
 */
function matchWrittenStyle(written: string, from: string, to: string): string | null {
  const key = written.toLowerCase();
  const fromStem = withoutExtension(from);
  const toStem = withoutExtension(to);
  const fromBase = baseNameOf(from);
  const toBase = baseNameOf(to);

  if (key === from.toLowerCase()) return to;
  if (key === fromStem.toLowerCase()) return toStem;
  if (key === fromBase.toLowerCase()) return toBase;
  if (key === withoutExtension(fromBase).toLowerCase()) return withoutExtension(toBase);
  return null;
}

function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function baseNameOf(filePath: string): string {
  const normalized = normalizeSlashes(filePath);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/** 去掉**基名**里的扩展名。`notes/v1.2.md` → `notes/v1.2`（只切最后一段的点）。 */
function withoutExtension(filePath: string): string {
  const slashIndex = filePath.lastIndexOf('/');
  const dotIndex = filePath.lastIndexOf('.');
  return dotIndex > slashIndex ? filePath.slice(0, dotIndex) : filePath;
}
