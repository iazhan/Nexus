import type { MarkdownEditTransaction, MarkdownSelection } from '../types.js';
import { findAtomicRanges, findFormattingSpans } from './source-scan.js';

/**
 * Creates a transaction to apply or unwrap inline formatting (Mod-B / Mod-I):
 * - Uses AST formatting spans directly
 * - Unwraps with precise delimiter fidelity (_italic_ deletes _, *italic* deletes *)
 * - Does not corrupt bold ** or __ when toggling italic
 * - Wraps with default format markers (** or *)
 * - Guards against collapsed selections and atomic nodes
 */
export function createInlineFormatTransaction(
  source: string,
  selection: MarkdownSelection,
  format: 'strong' | 'emphasis' | 'strike'
): MarkdownEditTransaction | null {
  if (selection.anchor === selection.head) return null;

  const from = Math.min(selection.anchor, selection.head);
  const to = Math.max(selection.anchor, selection.head);
  const isReversed = selection.anchor > selection.head;
  const makeSelection = (start: number, end: number) => ({
    anchor: isReversed ? end : start,
    head: isReversed ? start : end
  });

  // Guard: selection inside atomic nodes
  const atomicRanges = findAtomicRanges(source);
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

