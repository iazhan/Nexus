import {
  maskCodeRegions,
  resolveWikiLink,
  rewriteAttachmentReferencesForMany,
  rewriteWikiLinkTarget,
  type IndexedDocument
} from '@nexus/core';

/** 一篇 Markdown 回写后的结果。 */
export interface SourceRewrite {
  /** 改写后的全文。没有要改的地方时与入参**同一个字符串**。 */
  text: string;
  /** 改了几处（wikilink + 附件引用） */
  count: number;
  /**
   * 认出来指向被改名对象、却**写不出来**的引用原文（名字里有 `]` `|` 之类）。
   *
   * 返回给上层如实报出。不报的话用户只会看到「链接自己断了」，而他刚被告知过会一起改。
   */
  unresolved: string[];
}

/**
 * `[[目标]]` 或 `[[目标|别名]]`。与 `indexer.ts` 的 `WIKILINK_PATTERN`、
 * `references.ts` 的写法同形 —— 三处必须一致，否则「能跳转的」与「能改的」不是同一批。
 *
 * `d` 标志（`hasIndices`）是回写必需的：要知道**分组 1 在源码里的位置**才能只换目标
 * 那一小段。
 */
const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/gd;

/** 一次「从哪搬到哪」。两端都是**工作区相对路径**。 */
export interface RewritePair {
  from: string;
  to: string;
}

/**
 * 把一篇 Markdown 里所有指向 `from` 的引用改成指向 `to`。
 *
 * ## 判定用「能不能跳转」的同一套判据
 *
 * wikilink 用 `resolveWikiLink()`（**不是** `findBacklinks()`）：后者是前者的近似，
 * `links` 表的归一化只去 `.md`，所以 `[[dma.markdown]]` 能跳转、却查不到反向链接。
 * 回写必须与「能跳转」完全一致 —— 不一致的后果是「链接还是通的，但正文被改了」，
 * 或者反过来「正文改了，链接却还是断的」。
 *
 * 附件引用用 `rewriteAttachmentReferences()`，它内部用 `resolveWorkspacePath()`，
 * 与索引期「这篇引用了哪些附件」是同一个函数。
 *
 * ## 为什么不引 `@nexus/markdown` 的 parser
 *
 * 索引器当初就没引（`extractWikiLinkTargets` 用的是正则，见那里的注释），理由在这里
 * 更硬：**主进程的包里不该多一个 `marked`**。改名是低频动作，为它把整个 parser
 * （parser + serializer + render-model + security）拖进主进程的启动路径不划算。
 *
 * 代价是代码区要自己认。见 `maskCodeRegions()`（住在 `@nexus/core` —— 渲染进程的
 * 「缓冲区重基准」也要它，所以它不该待在主进程里）—— 这比「连代码块一起改」重要得多：
 * 文档里到处是 `` `[[dma]]` `` 这样的例子，改它们就是把用户写的文档改成错的。
 *
 * ## 两遍而不是一遍
 *
 * 先改 wikilink、再在**结果**上扫附件引用。两遍互相看不见对方的编辑（`![[a]]` 不匹配
 * 附件正则、`[[a]](b)` 也不是合法 wikilink），所以顺序无关；分两遍是因为两套写法的
 * 定位方式完全不同（正则分组下标 vs 另一条正则的分组下标），硬合成一遍只会更难读。
 *
 * @param sourceRelativePath 这篇文档自己的**工作区相对路径**（附件相对引用的基准）
 */
export function rewriteReferencesInSource(
  source: string,
  sourceRelativePath: string,
  from: string,
  to: string,
  documents: readonly IndexedDocument[]
): SourceRewrite {
  return rewriteReferencesInSourceForMany(source, sourceRelativePath, [{ from, to }], documents);
}

/**
 * 一次改**多组** `from → to`。
 *
 * 为什么需要它：搬一个**目录**时，指向它里面每一个文件的引用都要跟着改 —— 逐个调用
 * 单组版本是 O(目录内文件数 × 全部文档数) 次全文正则扫描，几百个文件的库上就是几万次。
 * 这里把那一组 pair 收成一个 `Map`，**全文只扫两遍**。
 *
 * 单组版本是它的单元素调用，所以「一次改一个」与「一次改一批」共用同一份实现。
 */
export function rewriteReferencesInSourceForMany(
  source: string,
  sourceRelativePath: string,
  pairs: readonly RewritePair[],
  documents: readonly IndexedDocument[]
): SourceRewrite {
  if (pairs.length === 0) return { text: source, count: 0, unresolved: [] };

  // 键一律小写：Windows 上 `Notes/` 与 `notes/` 是同一层，而 `resolveWikiLink()` /
  // `resolveWorkspacePath()` 都保留写法的原始大小写。与两个变换函数内部的比较同一口径。
  const byFrom = new Map<string, RewritePair>();
  for (const pair of pairs) byFrom.set(pair.from.toLowerCase(), pair);

  const unresolved: string[] = [];

  const wiki = rewriteWikiLinks(source, byFrom, documents, unresolved);
  const attachments = rewriteAttachmentReferencesForMany(wiki.text, sourceRelativePath, pairs);
  unresolved.push(...attachments.skipped);

  return {
    text: attachments.text,
    count: wiki.count + attachments.count,
    unresolved
  };
}

/** 改 wikilink，返回新正文与改动处数。`unresolved` 是出参 —— 调用方要把它汇总报出去。 */
function rewriteWikiLinks(
  source: string,
  byFrom: ReadonlyMap<string, RewritePair>,
  documents: readonly IndexedDocument[],
  unresolved: string[]
): { text: string; count: number } {
  const edits: { start: number; end: number; replacement: string }[] = [];

  // 在**掩掉代码区**的副本上扫，但取值与替换都回到原文 —— 掩码长度与原文一一对应。
  for (const match of maskCodeRegions(source).matchAll(WIKILINK_PATTERN)) {
    const written = match[1];
    const span = match.indices?.[1];
    if (written === undefined || span === undefined) continue;

    // 掩码把代码区换成了填充字符，所以能匹配上的 `[[…]]` 整段都在正文里。
    const target = source.slice(span[0], span[1]);

    const resolution = resolveWikiLink(target, documents);
    if (resolution.status !== 'resolved') continue;
    const relativePath = resolution.document?.relativePath;
    if (relativePath === undefined) continue;

    const pair = byFrom.get(relativePath.toLowerCase());
    if (!pair) continue;

    const replacement = rewriteWikiLinkTarget(target, pair.from, pair.to);
    if (replacement === null) {
      unresolved.push(target);
      continue;
    }
    if (replacement === target) continue;

    // 只替换目标本身，不碰用户写的首尾空白（`[[ dma ]]` 改成 `[[ dma2 ]]`）
    const lead = target.length - target.trimStart().length;
    const trimmed = target.trim().length;
    edits.push({ start: span[0] + lead, end: span[0] + lead + trimmed, replacement });
  }

  if (edits.length === 0) return { text: source, count: 0 };

  // 从后往前替换：前面的编辑不会让后面记录的偏移失效。
  edits.sort((a, b) => a.start - b.start);
  let text = source;
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index]!;
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  }

  return { text, count: edits.length };
}
