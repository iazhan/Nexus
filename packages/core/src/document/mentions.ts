import { skippedSpans, type Span } from './tags.js';
import { graphemeBoundaryAtOrAfter, graphemeBoundaryAtOrBefore } from './grapheme.js';

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
  // 分词一次、整篇共用（见 `createWordBoundaryLookup`）
  const isWordBoundary = createWordBoundaryLookup(source);

  for (const match of source.matchAll(pattern)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;

    if (skipped.some((span) => span.from < to && from < span.to)) continue;
    if (!hasWordBoundaries(source, from, to, isWordBoundary)) continue;

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
 *
 * ## 中文为什么另走一条路
 *
 * `\w` 只认 ASCII，所以汉字一律被判成「非词字符」，判据直接返回「通过」——
 * 于是中文候选的边界判据**整个失效**（判据 §11.2.4）。中文、日文、泰文这些语言
 * 词与词之间不写空格，只能靠分词器：外侧字符是词字符、且任一侧是这类文字时，
 * 改问「这个下标是不是词边界」。
 *
 * ## 这一条能做到什么、做不到什么（2026-10-15 实测，别当成回归）
 *
 * 按 `Intl.Segmenter` 的 `word` 粒度，被去掉的是**落在一个更长词内部**的命中，
 * 例如 `记笔记`（ICU 切成 `记笔记` 一整段）里候选「笔记」不再命中 —— 那正是
 * 「记笔记」这类动宾短语，用户并不是在指那篇文档。
 *
 * 但 `笔记本` **仍然会命中**：ICU 的词典把它切成 `笔记|本`，`笔记` 本身就是一个
 * 完整的词。这不是本判据能分辨的（要分辨得另有一份「更长词」的词典），
 * 刻意留成已知残留并有用例钉住，免得以后被当成 bug 反复修。
 */
function hasWordBoundaries(
  source: string,
  from: number,
  to: number,
  isWordBoundary: (index: number) => boolean
): boolean {
  return (
    isMatchBoundary(charBefore(source, from), charAt(source, from), from, isWordBoundary) &&
    isMatchBoundary(charAt(source, to), charBefore(source, to), to, isWordBoundary)
  );
}

/**
 * 「可能是词的一部分」。**比 `\w` 宽**：`\w` 只认 ASCII，汉字会被判成非词字符 ——
 * 那样外侧的汉字根本进不了「要不要问分词器」这一步，判据会在第一行就返回「通过」。
 *
 * 下划线必须带上：`\w` 有它，少了这一条 `dma_ctrl` 里的 `dma` 会被判成命中。
 */
const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u;

/** 拉丁那一路沿用原来的 `\w` 判据（ASCII 字母 / 数字 / 下划线）。 */
const ASCII_WORD_CHAR = /[\w]/;

/**
 * 不写空格分词的语言：词与词的边界在正文字符里看不出来，只能靠分词器。
 * 用 `scx=`（script extensions）而不是 `sc=`：日文的假名、注音符号等都归在 Han 的扩展集里。
 */
const UNSPACED_SCRIPT_CHAR =
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]/u;

/**
 * 词粒度分词器，**模块加载时取一次**。没有就退到「一律算边界」。
 *
 * 退化的方向是刻意选的：退到「通过」＝宁可多提示一条，也不漏掉一条。
 * 反过来（退到「拒绝」）会让中文工作区在这个环境里**一条建议都没有**，
 * 而用户看到的是「这个功能坏了」，不是「环境不支持」。
 */
const WORD_SEGMENTER: Intl.Segmenter | null = (() => {
  const Ctor = (globalThis as { Intl?: { Segmenter?: typeof Intl.Segmenter } }).Intl?.Segmenter;
  return Ctor === undefined ? null : new Ctor('und', { granularity: 'word' });
})();

/**
 * 「这个下标是不是词边界」的查询器，**按源文本建一次**。
 *
 * 每个命中都要问两次，而分词是整段文本一遍的事 —— 放进循环里就是 O(命中数 × 文本长度)。
 * 边界集合懒建：一整篇文档里可能一条无空格文字的命中都没有（纯英文工作区），
 * 那就不该付这次分词的钱。
 */
function createWordBoundaryLookup(source: string): (index: number) => boolean {
  const segmenter = WORD_SEGMENTER;
  if (segmenter === null) return () => true;

  let boundaries: Set<number> | null = null;
  return (index) => {
    if (boundaries === null) {
      boundaries = new Set<number>([source.length]);
      for (const segment of segmenter.segment(source)) boundaries.add(segment.index);
    }
    return boundaries.has(index);
  };
}

/**
 * 一侧的判据。`outside` 是紧挨着命中的那个字符，`inside` 是命中自己的边缘字符。
 *
 * 三条分支的顺序不能换：先排「外侧不是词字符」（标点、空白、行首行尾都算边界），
 * 再排无空格文字，最后才是原来的 `\w` 判据。
 */
function isMatchBoundary(
  outside: string | undefined,
  inside: string | undefined,
  index: number,
  isWordBoundary: (index: number) => boolean
): boolean {
  if (outside === undefined) return true;
  if (!WORD_CHAR.test(outside)) return true;
  if (UNSPACED_SCRIPT_CHAR.test(outside) || (inside !== undefined && UNSPACED_SCRIPT_CHAR.test(inside))) {
    return isWordBoundary(index);
  }
  // 拉丁 / 有空格分词的那一路：与原来的判据逐条一致 —— 外侧与候选自己的边缘字符
  // **都**是 `\w` 才算词内命中。少一个条件都会改变既有行为（`dma` / `notes/dma` 那批用例）。
  return !(ASCII_WORD_CHAR.test(outside) && inside !== undefined && ASCII_WORD_CHAR.test(inside));
}

/**
 * 按下标取一个**码点**（不是码元）。
 *
 * 不能写 `source[index]`：BMP 之外的字符（`𠮷`、emoji）会被取成半个代理项，
 * 而 `𠮷` 恰恰是 `scx=Han` 的汉字 —— 取错一半就等于漏判一个中文边界。
 */
function charAt(text: string, index: number): string | undefined {
  if (index < 0 || index >= text.length) return undefined;
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

/** 按下标取**前一个**码点；下标落在代理对后半时再往前一格。 */
function charBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const lowIndex = index - 1;
  const unit = text.charCodeAt(lowIndex);
  const isTrailSurrogate = unit >= 0xdc00 && unit <= 0xdfff;
  return charAt(text, isTrailSurrogate && lowIndex > 0 ? lowIndex - 1 : lowIndex);
}

/**
 * 命中处所在行的片段。过长时围绕命中处取一段窗口，两端加省略号。
 *
 * 窗口两端都对齐到**字素簇边界**：`EXCERPT_RADIUS` / `EXCERPT_MAX_LENGTH` 数的是码元，
 * 而窗口的起止点是拿命中位置做减法算出来的，正好可能落在一个 emoji 或组合字符的中间 ——
 * 那样摘录里会出现一个 `�`。取整方向刻意相反：开头往后收、结尾往前收，
 * 这样窗口只会**向内**缩小，不会超出 `EXCERPT_MAX_LENGTH`。
 */
function excerptAt(source: string, from: number, to: number): string {
  const lineStart = source.lastIndexOf('\n', from - 1) + 1;
  const rawEnd = source.indexOf('\n', to);
  const lineEnd = rawEnd < 0 ? source.length : rawEnd;
  // CRLF 文件的 `\r` 要剥掉，否则摘录末尾会带一个不可见字符
  const line = source.slice(lineStart, lineEnd).replace(/\r$/, '');

  if (line.length <= EXCERPT_MAX_LENGTH) return line.trim();

  const localFrom = from - lineStart;
  const start = graphemeBoundaryAtOrAfter(line, Math.max(0, localFrom - EXCERPT_RADIUS));
  const end = graphemeBoundaryAtOrBefore(line, Math.min(line.length, start + EXCERPT_MAX_LENGTH));
  return `${start > 0 ? '…' : ''}${line.slice(start, end).trim()}${end < line.length ? '…' : ''}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
