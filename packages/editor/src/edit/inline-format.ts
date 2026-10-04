import type { MarkdownEditTransaction, MarkdownSelection } from '../types.js';
import {
  findAtomicRanges,
  findFormattingSpans,
  inlineCodeFenceFor,
  readInlineCodeFence,
  type AtomicNodeRange
} from './source-scan.js';

/**
 * 行内标记的**切换 / 清除**事务。
 *
 * ## 四类标记 + 清除
 *
 * `strong` / `emphasis` / `strike` 三种走 `findFormattingSpans`（AST 里就是格式化节点，
 * 分隔符有 `**` / `__` / `*` / `_` / `~~` / `~` 几种写法，要按原文判）；
 * `inline-code` 走**原子范围** —— 它在 AST 里是 `inline-code` 节点、内容不参与行内解析，
 * 围栏长度还可能因为内容含反引号而加长。
 * `clear` 不是一种标记，是「把选区碰到的所有标记的分隔符删掉」。
 *
 * ## 原子守卫：三种标记一条，`inline-code` 一条，`clear` 不要
 *
 * - **三种行内标记**沿用既有判据：选区的**起点或终点落在**原子节点内就拒绝
 *   （`from >= r.from && from < r.to` 或 `to > r.from && to <= r.to`）。
 * - **`inline-code`** 用「**边界严格落在**原子节点内才拒绝」，且**拆围栏要排在守卫之前**。
 *   两种选区都算「与这段行内代码重合、该拆」：整段（含围栏）与**围栏内的内容** ——
 *   后者正是「包完再按一次」的形状，不认它等于「包上去就再也解不开」。
 *   把守卫提到前面，`from <= r.from && to >= r.to` 在**相等**时也成立，
 *   这两条路径就永远走不到。
 * - **`clear`** 不设原子守卫。它只登记「分隔符」区间，从不切原子节点，自身就是安全的；
 *   加上守卫反而挡掉正常操作（选区落在 `` `x` `` 里、落在 `[**a**](url)` 的文字里，
 *   都该清掉那对分隔符）。代码块 / 公式里本来没有标记可清，自然落到 `null`。
 *
 * ## `clear` 的「碰到」是**相交**，不是「包含」
 *
 * 选中 `**world**` 里的 `world` 按清除，用户的预期是「这四个字别加粗了」，
 * 而不是「你选的不是整个标记，我什么也不做」。所以判据是标记的**内容区间**与选区相交，
 * 就把它两侧的分隔符都删掉 —— 结果与 `strong` 的切换一致（都是 `world`）。
 *
 * ## 为什么 `clear` 对没有标记的选区返回 `null`
 *
 * 空事务会进 undo 栈：用户连按几次「清除格式」，撤销要按同样多次才回到原处。
 * 判据见规划 §4 P0-7 ③。
 */
export type InlineFormatKind = 'strong' | 'emphasis' | 'strike' | 'inline-code' | 'clear';

interface RemovedRange {
  from: number;
  to: number;
}

/** 删掉若干区间之后，原位置 `pos` 落在新文档的哪里。 */
function shiftPosition(pos: number, removed: readonly RemovedRange[]): number {
  let delta = 0;
  for (const range of removed) {
    delta += Math.min(Math.max(pos, range.from), range.to) - range.from;
  }
  return pos - delta;
}

/** 选区边界是否**严格**落在原子节点内部（＝会把它切一半）。 */
function cutsAtomicNode(from: number, to: number, range: AtomicNodeRange): boolean {
  return (from > range.from && from < range.to) || (to > range.from && to < range.to);
}

/**
 * 与选区**重合**的行内代码节点。两种重合都认：
 *
 * - 选区 == 整段（含围栏）—— 用户框住了 `` `x` ``；
 * - 选区 == 围栏内的内容 —— **包完之后再按一次**就是这个形状，
 *   不认它等于「包上去就再也解不开」。
 *
 * 多一个字少一个字都不算：那属于「切进原子节点」，走拒绝分支。
 */
function matchingInlineCode(
  source: string,
  from: number,
  to: number,
  atomicRanges: readonly AtomicNodeRange[]
): { from: number; to: number; contentFrom: number; contentTo: number } | null {
  for (const range of atomicRanges) {
    if (range.type !== 'inline-code') continue;
    const fence = readInlineCodeFence(source, range.from, range.to);
    const isWhole = from === range.from && to === range.to;
    const isContent = from === fence.contentFrom && to === fence.contentTo;
    if (isWhole || isContent) {
      return { from: range.from, to: range.to, contentFrom: fence.contentFrom, contentTo: fence.contentTo };
    }
  }
  return null;
}

function createInlineCodeTransaction(
  source: string,
  from: number,
  to: number,
  isReversed: boolean,
  atomicRanges: readonly AtomicNodeRange[]
): MarkdownEditTransaction | null {
  const makeSelection = (start: number, end: number) => ({
    anchor: isReversed ? end : start,
    head: isReversed ? start : end
  });

  // 1. 选区与某段行内代码重合 → 连填充空格一起拆掉围栏。**必须排在守卫之前**：
  //    「选区 == 内容」会命中下面的 `cutsAtomicNode`，排后面就永远走不到。
  const existing = matchingInlineCode(source, from, to, atomicRanges);
  if (existing) {
    const removed: RemovedRange[] = [
      { from: existing.from, to: existing.contentFrom },
      { from: existing.contentTo, to: existing.to }
    ];
    return {
      changes: [
        { from: existing.from, to: existing.contentFrom, insert: '' },
        { from: existing.contentTo, to: existing.to, insert: '' }
      ],
      selection: makeSelection(shiftPosition(from, removed), shiftPosition(to, removed)),
      userEvent: 'format.inlineCode'
    };
  }

  // 2. 边界切进原子节点（切一半）→ 拒绝。
  for (const range of atomicRanges) {
    if (cutsAtomicNode(from, to, range)) return null;
  }

  // 3. 选区**包住**了别的原子节点（链接 / 公式 / 代码块 / 另一段行内代码）→ 拒绝：
  //    包成行内代码会让那些语法退化成字面文本，那是另一件事。
  for (const range of atomicRanges) {
    if (from <= range.from && to >= range.to) return null;
  }

  const content = source.slice(from, to);
  const fence = inlineCodeFenceFor(content);
  // 内容以反引号开头或结尾时要拿空格把围栏与内容隔开，否则解析器会把两段围栏连起来读。
  const padded = content.startsWith('`') || content.endsWith('`');
  const pad = padded ? ' ' : '';
  const open = fence + pad;
  const close = pad + fence;

  return {
    changes: [
      { from, to: from, insert: open },
      { from: to, to, insert: close }
    ],
    selection: makeSelection(from + open.length, from + open.length + content.length),
    userEvent: 'format.inlineCode'
  };
}

function createClearFormattingTransaction(
  source: string,
  from: number,
  to: number,
  isReversed: boolean,
  atomicRanges: readonly AtomicNodeRange[]
): MarkdownEditTransaction | null {
  const removals: RemovedRange[] = [];

  // 三种标记：分隔符来自 AST（`**` / `__` / `*` / `_` / `~~` / `~` 都认），
  // 判据取标记的**内容区间**与选区相交 —— 见文件头的「碰到是相交」。
  for (const span of findFormattingSpans(source)) {
    const contentFrom = span.from + span.open.length;
    const contentTo = span.to - span.close.length;
    if (contentTo <= from || contentFrom >= to) continue;
    removals.push({ from: span.from, to: contentFrom });
    removals.push({ from: contentTo, to: span.to });
  }

  // 行内代码：连同填充空格一起去掉，留下的正文与原来逐字相同。
  for (const range of atomicRanges) {
    if (range.type !== 'inline-code') continue;
    const fence = readInlineCodeFence(source, range.from, range.to);
    if (fence.contentTo <= from || fence.contentFrom >= to) continue;
    removals.push({ from: range.from, to: fence.contentFrom });
    removals.push({ from: fence.contentTo, to: range.to });
  }

  // 这里**没有**原子守卫，是有意的：上面两轮只登记「分隔符」区间，从不切原子节点，
  // 所以它自己是安全的。加上「选区切进原子节点就拒绝」反而会挡掉正常操作 ——
  // 选区落在 `` `x` `` 里、落在 `[**a**](url)` 的链接文字里，都是该清掉那对分隔符的。
  // 而在代码块 / 公式里本来就没有标记可清，两轮都登记不到东西，自然落到下面的 `null`。

  if (removals.length === 0) return null;

  // 按位置去重：两处标记共用一个边界时（`***x***` 的 `**` 与相邻的 `*`）同一段会被
  // 登记两次，重复的删除区间会让后面的偏移算两遍。
  const unique = new Map<string, RemovedRange>();
  for (const range of removals) {
    if (range.from === range.to) continue;
    unique.set(`${range.from}:${range.to}`, range);
  }
  const ordered = [...unique.values()].sort((a, b) => a.from - b.from);

  const nextFrom = shiftPosition(from, ordered);
  const nextTo = shiftPosition(to, ordered);

  return {
    changes: ordered.map((range) => ({ from: range.from, to: range.to, insert: '' })),
    selection: { anchor: isReversed ? nextTo : nextFrom, head: isReversed ? nextFrom : nextTo },
    userEvent: 'format.clear'
  };
}

/**
 * 切换 / 清除行内标记。返回 `null` 表示「这个选区上什么也不该发生」——
 * 空选区、原子节点、或（清除时）本来就没有标记。
 */
export function createInlineFormatTransaction(
  source: string,
  selection: MarkdownSelection,
  format: InlineFormatKind
): MarkdownEditTransaction | null {
  if (selection.anchor === selection.head) return null;

  const from = Math.min(selection.anchor, selection.head);
  const to = Math.max(selection.anchor, selection.head);
  const isReversed = selection.anchor > selection.head;
  const makeSelection = (start: number, end: number) => ({
    anchor: isReversed ? end : start,
    head: isReversed ? start : end
  });

  const atomicRanges = findAtomicRanges(source);

  if (format === 'clear') {
    return createClearFormattingTransaction(source, from, to, isReversed, atomicRanges);
  }

  if (format === 'inline-code') {
    return createInlineCodeTransaction(source, from, to, isReversed, atomicRanges);
  }

  // Guard: selection inside atomic nodes
  for (const r of atomicRanges) {
    if ((from >= r.from && from < r.to) || (to > r.from && to <= r.to)) {
      return null;
    }
  }

  const formattingSpans = findFormattingSpans(source);

  if (format === 'strong') {
    const matchingSpan = formattingSpans.find(
      (s) =>
        s.type === 'strong' &&
        ((s.from + s.open.length === from && s.to - s.close.length === to) ||
          (s.from === from && s.to === to))
    );

    if (matchingSpan) {
      const isInner =
        matchingSpan.from + matchingSpan.open.length === from &&
        matchingSpan.to - matchingSpan.close.length === to;
      const nextFrom = isInner ? from - matchingSpan.open.length : from;
      const nextTo = isInner
        ? to - matchingSpan.open.length
        : to - matchingSpan.open.length - matchingSpan.close.length;
      return {
        changes: [
          { from: matchingSpan.from, to: matchingSpan.from + matchingSpan.open.length, insert: '' },
          { from: matchingSpan.to - matchingSpan.close.length, to: matchingSpan.to, insert: '' }
        ],
        selection: makeSelection(nextFrom, nextTo),
        userEvent: 'format.bold'
      };
    }

    const marker = '**';
    return {
      changes: [
        { from, to: from, insert: marker },
        { from: to, to, insert: marker }
      ],
      selection: makeSelection(from + marker.length, to + marker.length),
      userEvent: 'format.bold'
    };
  }

  if (format === 'emphasis') {
    const matchingSpan = formattingSpans.find(
      (s) =>
        s.type === 'emphasis' &&
        ((s.from + s.open.length === from && s.to - s.close.length === to) ||
          (s.from === from && s.to === to))
    );

    if (matchingSpan) {
      const isInner =
        matchingSpan.from + matchingSpan.open.length === from &&
        matchingSpan.to - matchingSpan.close.length === to;
      const nextFrom = isInner ? from - matchingSpan.open.length : from;
      const nextTo = isInner
        ? to - matchingSpan.open.length
        : to - matchingSpan.open.length - matchingSpan.close.length;
      return {
        changes: [
          { from: matchingSpan.from, to: matchingSpan.from + matchingSpan.open.length, insert: '' },
          { from: matchingSpan.to - matchingSpan.close.length, to: matchingSpan.to, insert: '' }
        ],
        selection: makeSelection(nextFrom, nextTo),
        userEvent: 'format.italic'
      };
    }

    // If selection is inside a strong formatting span, wrap outside the strong delimiters
    const enclosingStrong = formattingSpans.find(
      (s) =>
        s.type === 'strong' &&
        s.from + s.open.length === from &&
        s.to - s.close.length === to
    );

    const marker = '*';
    if (enclosingStrong) {
      return {
        changes: [
          { from: enclosingStrong.from, to: enclosingStrong.from, insert: marker },
          { from: enclosingStrong.to, to: enclosingStrong.to, insert: marker }
        ],
        selection: makeSelection(from + marker.length, to + marker.length),
        userEvent: 'format.italic'
      };
    }

    return {
      changes: [
        { from, to: from, insert: marker },
        { from: to, to, insert: marker }
      ],
      selection: makeSelection(from + marker.length, to + marker.length),
      userEvent: 'format.italic'
    };
  }

  if (format === 'strike') {
    const matchingSpan = formattingSpans.find(
      (s) =>
        s.type === 'strike' &&
        ((s.from + s.open.length === from && s.to - s.close.length === to) ||
          (s.from === from && s.to === to))
    );

    if (matchingSpan) {
      const isInner =
        matchingSpan.from + matchingSpan.open.length === from &&
        matchingSpan.to - matchingSpan.close.length === to;
      const nextFrom = isInner ? from - matchingSpan.open.length : from;
      const nextTo = isInner
        ? to - matchingSpan.open.length
        : to - matchingSpan.open.length - matchingSpan.close.length;
      return {
        changes: [
          { from: matchingSpan.from, to: matchingSpan.from + matchingSpan.open.length, insert: '' },
          { from: matchingSpan.to - matchingSpan.close.length, to: matchingSpan.to, insert: '' }
        ],
        selection: makeSelection(nextFrom, nextTo),
        userEvent: 'format.strike'
      };
    }

    const marker = '~~';
    return {
      changes: [
        { from, to: from, insert: marker },
        { from: to, to, insert: marker }
      ],
      selection: makeSelection(from + marker.length, to + marker.length),
      userEvent: 'format.strike'
    };
  }

  return null;
}
