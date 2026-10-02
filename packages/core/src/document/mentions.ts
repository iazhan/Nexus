import { skippedSpans, type Span } from './tags.js';

/**
 * **未链接提及**：正文里提到了某篇文档的名字，却没有写成链接。
 *
 * ## 为什么值得找
 *
 * 「提到但没链接」是知识库最常漏的一类关系：用户在正文里写了「见 dma 那篇」，
 * 心里已经建立了关联，但图谱上那条边不存在 —— 于是他查反向链接时找不到这一处，
 * 而他还以为自己写过。
 *
 * ## 候选写法必须与**解析口径**一致
 *
 * 传进来的 `candidates` 是「这篇文档能被 `[[…]]` 指到的写法」，与 `resolveWikiLink`
 * 用的是同一份（`IndexStore.backlinkTargetsOf`）。
 *
 * **刻意不含「首个 H1」**：Markra 把 H1 也当候选，是因为 Obsidian 的 wikilink 认标题；
 * 而 Nexus 的解析只认文件名与相对路径。把 H1 算进来的话，建议的链接**点开是 not-found** ——
 * 建议一条建不起来的链接比不建更糟。
 *
 * ## 排除的不是「链接目标已存在」，而是「这一处已经写在链接里」
 *
 * `[[dma]]` 里的 `dma` 不该被建议 —— 它已经是链接了。同一篇里另有一处光秃秃的 `dma`
 * 仍然要建议。所以判据是**位置**，不是目标。
 *
 * 排除范围与标签扫描共用 `skippedSpans()`（围栏代码块、缩进代码块、行内代码、
 * frontmatter），另加链接本身（`[[…]]`、`[文字](目标)`、`![…](…)`）。
 * 不共用的话，「哪些位置不是正文」会有两份判据，漂了之后同一个词在标签面板里不算、
 * 在这里算。
 */
export interface MentionRange {
  /** 命中的原文，**保留源码里的大小写**（用户看到的是自己写的那个词）。 */
  text: string;
  from: number;
  to: number;
  /** 命中处所在行的片段，供面板显示。过长时围绕命中处截断。 */
  excerpt: string;
}

/**
 * 链接的区间。只在「这一处已经链接了」的判断上用，**不参与解析**。
 *
 * 所以刻意写得简单：漏掉一种写法只会多出一条建议（用户看得出那条已经链接了），
 * 而写复杂了同样只是多一条噪音。真正不能错的是 `skippedSpans()` 那一份。
 */
const LINK_PATTERN = /\[\[[^\]]*\]\]|!?\[[^\]]*\]\([^)]*\)/g;

/**
 * 短于这个长度的候选一律忽略。
 *
 * 一个叫 `a.md` 的文档，候选就是 `a` —— 它会在正文里命中几百次，
 * 把整个建议列表冲掉。宁可不提示，也不要提示一堆噪音。
 */
const MIN_CANDIDATE_LENGTH = 2;

const EXCERPT_RADIUS = 40;
const EXCERPT_MAX_LENGTH = 120;

export function findUnlinkedMentions(
  source: string,
  candidates: readonly string[]
): MentionRange[] {
  const usable = [
    ...new Set(candidates.map((candidate) => candidate.trim()).filter((c) => c.length >= MIN_CANDIDATE_LENGTH))
    // 长的排前面：`notes/dma` 必须先于 `dma` 尝试，否则后者会先吃掉前者的尾巴
  ].sort((a, b) => b.length - a.length);

  if (usable.length === 0 || source.length === 0) return [];

  const skipped: Span[] = [...skippedSpans(source)];
  for (const match of source.matchAll(LINK_PATTERN)) {
    const from = match.index ?? 0;
    skipped.push({ from, to: from + match[0].length });
  }

  const pattern = new RegExp(usable.map(escapeRegExp).join('|'), 'gi');
  const mentions: MentionRange[] = [];

  for (const match of source.matchAll(pattern)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;

    if (skipped.some((span) => span.from < to && from < span.to)) continue;
    if (!hasWordBoundaries(source, from, to, match[0])) continue;

    mentions.push({ text: match[0], from, to, excerpt: excerptAt(source, from, to) });
  }

  return mentions;
}

/**
 * 命中处两侧不能紧挨着**词字符**。
 *
 * 少了这条，`dma` 会在 `dmax` 里命中、`notes/dma` 会在 `notes/dma2` 里命中 ——
 * 用户看到的是「建议我链接一个我根本没提到的文档」。
 *
 * 不用 `\b`：候选里可以有 `/`、`.`、`-`，而 `\b` 只认 `\w` 的边界，
 * 在 `notes/dma` 这种候选上给出的边界位置是错的。手工判两个字符更直白。
 */
function hasWordBoundaries(source: string, from: number, to: number, text: string): boolean {
  const isWordChar = (value: string | undefined) => value !== undefined && /[\w]/.test(value);
  if (isWordChar(text[0]) && isWordChar(source[from - 1])) return false;
  if (isWordChar(text[text.length - 1]) && isWordChar(source[to])) return false;
  return true;
}

/** 命中处所在行的片段。过长时围绕命中处取一段窗口，两端加省略号。 */
function excerptAt(source: string, from: number, to: number): string {
  const lineStart = source.lastIndexOf('\n', from - 1) + 1;
  const rawEnd = source.indexOf('\n', to);
  const lineEnd = rawEnd < 0 ? source.length : rawEnd;
  // CRLF 文件的 `\r` 要剥掉，否则摘录末尾会带一个不可见字符
  const line = source.slice(lineStart, lineEnd).replace(/\r$/, '');

  if (line.length <= EXCERPT_MAX_LENGTH) return line.trim();

  const localFrom = from - lineStart;
  const start = Math.max(0, localFrom - EXCERPT_RADIUS);
  const end = Math.min(line.length, start + EXCERPT_MAX_LENGTH);
  return `${start > 0 ? '…' : ''}${line.slice(start, end).trim()}${end < line.length ? '…' : ''}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
