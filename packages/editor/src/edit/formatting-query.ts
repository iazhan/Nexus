import type { Text } from '@codemirror/state';
import type { MarkdownSelection } from '../types.js';
import { findAtomicRanges, findFormattingSpans, readInlineCodeFence, type AtomicNodeRange } from './source-scan.js';

/** 可切换的行内标记。链接 / 图片 / 公式是**原子节点**，不在这一列（见 `findAtomicRanges`）。 */
export type InlineFormat = 'strong' | 'emphasis' | 'strike' | 'inline-code';

/** 行内标记区间。与 `FormattingSpan` 同形，多出 `inline-code` 一档。 */
export interface InlineMarkerSpan {
  from: number;
  to: number;
  open: string;
  close: string;
  type: InlineFormat;
}

export interface SelectionFormattingState {
  /**
   * 选区落在原子节点里（代码块 / 行内代码 / 公式 / 链接 / 图片 / 转义）。
   * 判据与 `createInlineFormatTransaction` 的守卫**同一个表达式** —— 分开写的话
   * 按钮亮着而事务返回 `null`，表现成「点了没反应」。
   */
  atomic: boolean;
  /** 选区当前所处的行内标记。空数组 = 纯文本。 */
  active: readonly InlineFormat[];
}

export const EMPTY_FORMATTING_STATE: SelectionFormattingState = { atomic: false, active: [] };

/**
 * 扫描结果。抽成可注入的依赖**不是为了解耦**，是因为「同一份文档版本里扫描最多跑一次」
 * 是这条链上唯一的性能契约（全篇解析是 O(n)），而它只能靠数调用次数来验。
 */
export interface FormattingScan {
  atomic: AtomicNodeRange[];
  markers: InlineMarkerSpan[];
}

export type FormattingScanner = (source: string) => FormattingScan;

/**
 * `inline-code` 的分隔符要从**原文**数反引号，不能从 `node.raw` 之外的字段猜 ——
 * `` ``a`b`` `` 这种内容含反引号时围栏会加长，按单个反引号删就会删错。
 * 走 `readInlineCodeFence` 而不是自己写正则：围栏两侧的**填充空格**也算在 `open`/`close`
 * 里，否则 `` ` a ` `` 的内容起点会被算到空格上。
 */
function inlineCodeMarkers(source: string, atomic: readonly AtomicNodeRange[]): InlineMarkerSpan[] {
  const markers: InlineMarkerSpan[] = [];
  for (const range of atomic) {
    if (range.type !== 'inline-code') continue;
    const fence = readInlineCodeFence(source, range.from, range.to);
    markers.push({
      from: range.from,
      to: range.to,
      open: fence.open,
      close: fence.close,
      type: 'inline-code'
    });
  }
  return markers;
}

export function scanFormatting(source: string): FormattingScan {
  const atomic = findAtomicRanges(source);
  return {
    atomic,
    // `findFormattingSpans` **只**返回 strong / emphasis / strike，且 `block-split-merge.ts`
    // 拿它决定「回车要不要续标记」—— 往它里面塞 inline-code 会让在 `` `x` `` 里按回车
    // 变成 `` `\n` ``。所以那一档在这里单独取。
    markers: [...findFormattingSpans(source), ...inlineCodeMarkers(source, atomic)]
  };
}

/** 与 `createInlineFormatTransaction` 的原子守卫逐字相同。 */
function hitsAtomic(selection: { from: number; to: number }, range: AtomicNodeRange): boolean {
  return (
    (selection.from >= range.from && selection.from < range.to) ||
    (selection.to > range.from && selection.to <= range.to)
  );
}

/** 选区落在标记的**内容**里（不含分隔符本身）。 */
function insideMarker(selection: { from: number; to: number }, span: InlineMarkerSpan): boolean {
  const start = span.from + span.open.length;
  const end = span.to - span.close.length;
  if (end < start) return false;
  if (selection.from === selection.to) return selection.from >= start && selection.from <= end;
  return selection.from >= start && selection.to <= end;
}

/**
 * 选区格式查询。**按文档版本缓存扫描结果** —— 连续移动光标（选区变化、文档没变）时
 * 只解析一次；缓存键取 `Text` 的**对象标识**而不是字符串内容，因为
 * `state.doc` 在只有选区变化时是同一个实例，而按内容比是 O(n)。
 *
 * 不要用 `session.getSnapshot().source` 当输入：CRLF 文档里它带 `\r`，而视图的
 * `doc.toString()` 是 LF 的 —— 偏移量对不上，标记位置会整片偏。
 */
export function createFormattingAnalyzer(
  scanner: FormattingScanner = scanFormatting
): (doc: Text, selection: MarkdownSelection) => SelectionFormattingState {
  let cachedDoc: Text | null = null;
  let cached: FormattingScan = { atomic: [], markers: [] };

  return (doc, selection) => {
    if (doc !== cachedDoc) {
      cachedDoc = doc;
      cached = scanner(doc.toString());
    }

    const from = Math.min(selection.anchor, selection.head);
    const to = Math.max(selection.anchor, selection.head);
    const bounds = { from, to };

    const active: InlineFormat[] = [];
    for (const marker of cached.markers) {
      if (insideMarker(bounds, marker) && !active.includes(marker.type)) {
        active.push(marker.type);
      }
    }

    return {
      atomic: cached.atomic.some((range) => hitsAtomic(bounds, range)),
      active
    };
  };
}
