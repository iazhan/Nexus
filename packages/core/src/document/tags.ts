/**
 * 文档标签（`#标签`）的扫描与归一化。**索引层与编辑器高亮共用这一份判据。**
 *
 * 判据必须共用：各写一份的话，漂移的症状是「编辑器里明明高亮着、标签面板里却没有」——
 * 不报错、不崩溃，只是让人以为功能坏了。
 *
 * ## 语法
 *
 * `#` 前必须是行首或空白，`#` 后紧跟非空白、非 `#` 的字符。这条约束同时排除了两类
 * 最常见的误判：
 *   - `# 标题` —— `#` 后是空格，ATX 标题不是标签
 *   - `https://x.com/#anchor` —— `#` 前是 `/`，URL 片段不是标签
 *
 * 字符集刻意宽（`[^\s#]+`，任意非空白非 `#`）：中文、emoji、`父/子` 路径式标签都收。
 * 宽了多收一条只是多一个标签，窄了会表现成「我明明写了却搜不到」。
 *
 * 但两条硬约束与 Obsidian 一致：`#` 前必须是行首或空白；标签**至少含一个非数字字符**
 * （`#1984` 不是标签，`#y1984` 是）。后者挡的是「见 issue #123」「第 #3 章」这类
 * **编号引用** —— 它们在技术笔记里很常见，被收成标签就是纯噪音。
 *
 * ## 代码与 frontmatter 不算标签
 *
 * 代码里的 `#` 一律跳过：`#include <stdio.h>` 一行就是一条假标签，而 C/C++ 笔记里这种行
 * 很常见。覆盖三种写法 —— 围栏（含列表项与引用块里的）、缩进代码块、行内代码。
 * frontmatter 块整块跳过：它的 `tags:` 走另一条通道（`extractFrontmatterTags()`），
 * 字段值里的 `#`（`title: "C# 指南"`）也不该变成标签。
 */

/** 一个标签在源码里的位置：`from` 指向 `#`，`to` 指向标签名末尾（不含末尾标点）。 */
export interface TagMatch {
  /** 归一化后的标签名：已去 `#`、已转小写。 */
  readonly tag: string;
  readonly from: number;
  readonly to: number;
}

/** 源码里的一个区间 `[from, to)`。 */
interface Span {
  readonly from: number;
  readonly to: number;
}

/**
 * `#标签`。与 `references.ts` 一样带 `d` 标志 —— 编辑器高亮要**每个标签的位置**，
 * 而分组 1 只给名字，起点得从 `indices` 拿。
 */
const TAG_PATTERN = /(?:^|\s)#([^\s#]+)/gd;

/**
 * 标签的终止标点：遇到就认为标签结束。
 *
 * 正则只能按空白切，所以 `#dma，还有` 会整段被吃进来；这里再截断一次，只取第一个
 * 标点之前的部分。反引号也在内 —— 它是行内代码的边界，不该进标签名。
 */
const TAG_TERMINATOR = /[.,;:!?，。；：！？、()（）[\]【】"'`]/;

/**
 * 至少一个非数字字符。与 Obsidian 同一条：`#1984` 不是标签，`#y1984` 是。
 *
 * 用 `\d` 而不是 `\p{Nd}`：全角数字（`#１２３`）会因此算「含非数字」而通过。那是刻意
 * 不处理的角落 —— 为它加一条 Unicode 属性转义，换来的只是多一种罕见写法被拒。
 */
const NON_DIGIT_PATTERN = /[^\d]/;

/**
 * 是不是一个合法标签名。**正文与 frontmatter 共用这一条** —— 两处口径不一致的话，
 * `#1984` 与 `tags: [1984]` 会在同一份文档里得到相反的答案。
 */
function isValidTag(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && NON_DIGIT_PATTERN.test(value);
}

/** 围栏代码块的开/闭行。缩进不限 —— 列表项里的围栏会带 4 空格以上的缩进。 */
const FENCE_PATTERN = /^\s*(`{3,}|~{3,})(.*)$/;

/** frontmatter 的开标记。只认 YAML 的 `---`：TOML 的 `+++` 里没有 `tags:` 这种写法。 */
const FRONTMATTER_OPEN_PATTERN = /^---[ \t]*\r?\n/;

/** frontmatter 的闭标记，必须是独占一行。 */
const FRONTMATTER_CLOSE_PATTERN = /^(?:---|\.\.\.)[ \t]*\r?$/gm;

/** frontmatter 里承载标签的键。`tag` 单数写法 Obsidian 也认。 */
const FRONTMATTER_TAG_KEY_PATTERN = /^(?:tags|tag)\s*:\s*(.*)$/i;

/** YAML 块式列表项：`  - 值`。 */
const FRONTMATTER_LIST_ITEM_PATTERN = /^[ \t]+-[ \t]*(.*)$/;

/**
 * 扫出源码里所有标签及其位置，按出现顺序。
 *
 * 返回值**不去重** —— 同一个标签出现几次就有几条。索引层要的是集合（`extractTags()`），
 * 编辑器要的是位置（同一标签在文中出现几次就得画几处）。
 */
export function scanTags(source: string): TagMatch[] {
  const skipped = skippedSpans(source);
  const matches: TagMatch[] = [];

  for (const match of source.matchAll(TAG_PATTERN)) {
    const name = match[1];
    const nameSpan = match.indices?.[1];
    if (name === undefined || nameSpan === undefined) continue;

    const candidate = name.split(TAG_TERMINATOR)[0]?.trim();
    if (!isValidTag(candidate)) continue;

    const from = nameSpan[0] - 1;
    const to = from + 1 + candidate.length;
    if (overlapsAny(skipped, from, to)) continue;

    matches.push({ tag: candidate.toLowerCase(), from, to });
  }

  return matches;
}

/** 正文里的标签名，去重（索引层用）。 */
export function extractTags(source: string): string[] {
  return [...new Set(scanTags(source).map((match) => match.tag))];
}

/**
 * frontmatter 里的标签，去重。
 *
 * 三种写法都收：
 *
 * | 写法 | 例 |
 * | --- | --- |
 * | 流式数组 | `tags: [dma, ethercat]` |
 * | 逗号分隔 | `tags: dma, ethercat` |
 * | 块式列表 | `tags:` 换行后 `  - dma` |
 *
 * 值一律走 `normalizeTagValue()`（去前导 `#`、转小写），与正文标签同一口径 ——
 * 否则 `tags: [DMA]` 与正文的 `#dma` 会在标签面板里裂成两项。
 */
export function extractFrontmatterTags(source: string): string[] {
  const span = frontmatterSpan(source);
  if (span === null) return [];

  const lines = source.slice(span.from, span.to).split('\n');
  const tags = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const key = FRONTMATTER_TAG_KEY_PATTERN.exec(stripCr(lines[index]!));
    if (key === null) continue;

    const inlineValue = key[1]!.trim();
    if (inlineValue.length > 0) {
      for (const value of splitInlineValues(inlineValue)) collectTag(tags, value);
      continue;
    }

    // 块式：键后面那几行缩进的 `- 值`。遇到第一个不是列表项的行就停 ——
    // 包括下一个键（`status: learning`），否则会把整份 frontmatter 吃成标签。
    for (let item = index + 1; item < lines.length; item += 1) {
      const line = stripCr(lines[item]!);
      if (line.trim().length === 0) continue;
      const entry = FRONTMATTER_LIST_ITEM_PATTERN.exec(line);
      if (entry === null) break;
      collectTag(tags, entry[1]!.trim());
    }
  }

  return [...tags];
}

/**
 * 文档的全部标签：正文 inline 在前、frontmatter 在后，去重。
 *
 * 索引层用这个而不是分别调两次 —— `UpsertDocumentInput.tags` 是「这篇文档有哪些标签」，
 * 而那个问题只有一个答案。
 */
export function extractDocumentTags(source: string): string[] {
  const tags = new Set<string>(extractTags(source));
  for (const tag of extractFrontmatterTags(source)) tags.add(tag);
  return [...tags];
}

/** 值归一化：去前导 `#`、去首尾空白、转小写。与正文标签的 `candidate.toLowerCase()` 同一口径。 */
function normalizeTagValue(value: string): string {
  return value.trim().replace(/^#/, '').trim().toLowerCase();
}

/** 归一化 → 合法性检查 → 收进集合。两处 frontmatter 写法共用，免得只有一处做了校验。 */
function collectTag(tags: Set<string>, value: string): void {
  const tag = normalizeTagValue(value);
  if (isValidTag(tag)) tags.add(tag);
}

/** 流式写法拆成多个值：`[a, b]` 与 `a, b` 都按逗号切，并去掉每项两端的引号。 */
function splitInlineValues(value: string): string[] {
  const body =
    value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  return body
    .split(',')
    .map((part) => unquote(part.trim()))
    .filter((part) => part.length > 0);
}

function unquote(value: string): string {
  const first = value[0];
  const last = value[value.length - 1];
  if (value.length >= 2 && (first === '"' || first === "'") && last === first) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** 代码块、行内代码与 frontmatter 的区间合集 —— 这些地方出现的 `#` 不是标签。 */
function skippedSpans(source: string): Span[] {
  const spans = codeSpans(source);
  const frontmatter = frontmatterSpan(source);
  if (frontmatter !== null) spans.push(frontmatter);
  return spans;
}

/**
 * 围栏代码块、缩进代码块与行内代码的区间。
 *
 * 逐行推进而不是全文正则：围栏的**闭合条件**依赖开标记（同种字符、不短于开标记），
 * 缩进代码块的**开始条件**依赖前一行（不能打断段落），这两条都不是一个正则能表达的。
 *
 * 每行先剥掉引用块前缀（`>`，可嵌套）再判结构 —— 否则「引用块里贴代码」
 * （`> ```c` 那一整块）会被当成正文。
 *
 * 取舍：**缩进 ≥ 4 空格或 1 个 tab 的行一律当代码**。CommonMark 里要区分「列表项自己的
 * 续段」（缩进 4）与「列表项里的代码块」（缩进 6），那需要列表上下文。代价是列表项
 * 续段里写的标签会漏收，收益是「列表里贴代码」不再冒出假标签 —— 后者在技术笔记里常见得多。
 *
 * 未闭合的围栏一直延伸到文档末尾（正在敲的代码块不该让后面的正文变成标签）；
 * 未闭合的反引号**不是**行内代码（CommonMark 语义），照常扫。
 */
function codeSpans(source: string): Span[] {
  const spans: Span[] = [];
  let offset = 0;
  let fence: { char: string; length: number; from: number } | null = null;
  /** 缩进代码块的起点；不在其中时为 null。 */
  let indentedFrom: number | null = null;
  /** 上一行是否为空行（文档开头视作空行）—— 缩进代码块不能打断段落，靠这一位判。 */
  let afterBlankLine = true;

  const closeIndented = (at: number) => {
    if (indentedFrom === null) return;
    spans.push({ from: indentedFrom, to: at });
    indentedFrom = null;
  };

  for (const rawLine of source.split('\n')) {
    const lineFrom = offset;
    const lineTo = offset + rawLine.length;
    // 行尾的 `\n` 也要计进去，否则下一行的偏移会逐行少 1
    offset = lineTo + 1;

    const line = stripBlockquotePrefix(rawLine);
    const open = FENCE_PATTERN.exec(line);

    if (fence !== null) {
      const closes =
        open !== null &&
        open[1]![0] === fence.char &&
        open[1]!.length >= fence.length &&
        open[2]!.trim().length === 0;
      if (closes) {
        spans.push({ from: fence.from, to: lineTo });
        fence = null;
      }
      afterBlankLine = false;
      continue;
    }

    if (open !== null) {
      closeIndented(lineFrom);
      fence = { char: open[1]![0]!, length: open[1]!.length, from: lineFrom };
      afterBlankLine = false;
      continue;
    }

    if (line.trim().length === 0) {
      // 空行：缩进代码块跨过它继续（CommonMark 里代码块内部的空行不打断它）
      afterBlankLine = true;
      continue;
    }

    // 缩进代码块：**开始**要求前面是空行（否则会把段落的续行当成代码），
    // 但一旦进去了，后续每一行只要缩进够就还在里面 —— 第二行起没有空行可言。
    const indent = leadingIndentWidth(line);
    if (indent >= 4 && (afterBlankLine || indentedFrom !== null)) {
      if (indentedFrom === null) indentedFrom = lineFrom;
      afterBlankLine = false;
      continue;
    }

    closeIndented(lineFrom);
    // 行内代码用**原始行**扫：剥掉引用前缀会打乱后面的列偏移，而 `>` 本来也不影响
    // 反引号的配对。
    collectInlineCodeSpans(rawLine, lineFrom, spans);
    afterBlankLine = false;
  }

  if (fence !== null) spans.push({ from: fence.from, to: source.length });
  closeIndented(source.length);

  return spans;
}

/** 剥掉行首的引用块前缀（`>` + 一个可选空格，可嵌套）。 */
function stripBlockquotePrefix(line: string): string {
  let rest = line;
  for (;;) {
    const match = /^ {0,3}> ?/.exec(rest);
    if (match === null) return rest;
    rest = rest.slice(match[0].length);
  }
}

/** 行首缩进宽度：空格算 1、tab 算 4（与 CommonMark 的 tab stop 一致）。 */
function leadingIndentWidth(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4;
    else break;
  }
  return width;
}

/** 行内代码 `` `x` ``：成对的反引号，**个数必须相同**（`` ``x`` `` 里的单反引号不算边界）。 */
function collectInlineCodeSpans(line: string, lineFrom: number, spans: Span[]): void {
  let open: { from: number; ticks: number } | null = null;

  for (const match of line.matchAll(/`+/g)) {
    const ticks = match[0].length;
    if (open === null) {
      open = { from: lineFrom + match.index, ticks };
      continue;
    }
    if (ticks === open.ticks) {
      spans.push({ from: open.from, to: lineFrom + match.index + ticks });
      open = null;
    }
  }
}

/**
 * frontmatter 块的区间（含首尾标记行）；没有合法 frontmatter 返回 `null`。
 *
 * 判据：**第一行**必须是 `---`。文件中间出现的 `---` 是分隔线（horizontal rule），
 * 不是 frontmatter —— 认错了会把分隔线后面整段正文当成元数据，标签全部消失。
 */
function frontmatterSpan(source: string): Span | null {
  const bom = source.startsWith('\uFEFF') ? 1 : 0;
  const open = FRONTMATTER_OPEN_PATTERN.exec(source.slice(bom));
  if (open === null) return null;

  FRONTMATTER_CLOSE_PATTERN.lastIndex = bom + open[0].length;
  const close = FRONTMATTER_CLOSE_PATTERN.exec(source);
  if (close === null) return null;

  return { from: 0, to: close.index + close[0].length };
}

/** `[from, to)` 是否与任一区间相交。区间都是半开的，首尾相接不算相交。 */
function overlapsAny(spans: readonly Span[], from: number, to: number): boolean {
  return spans.some((span) => span.from < to && from < span.to);
}
