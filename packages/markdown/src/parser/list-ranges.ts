/**
 * 列表项在源码中的范围扫描。
 */
import type { SourceRange } from '../types.js';

/**
 * Accurately finds the SourceRange for every list item in source between listStart and listEnd.
 * Ensures parent-child containment and that item.raw equals source.slice(item.from, item.to).
 */
export function findListItemsRanges(
  source: string,
  listStart: number,
  listEnd: number,
  itemsCount: number,
  ordered: boolean
): SourceRange[] {
  const firstLine = source.slice(listStart, listEnd);
  const match = firstLine.match(/^([ \t>]*)([*+-]|\d+[.)])[ \t]+/);
  if (!match) {
    return [{ from: listStart, to: listEnd }];
  }
  const targetIndent = match[1] ?? '';
  const itemStarts: number[] = [listStart];

  let idx = listStart;
  while (idx < listEnd) {
    if (source[idx] === '\n') {
      const lineStart = idx + 1;
      if (lineStart < listEnd) {
        const remaining = source.slice(lineStart, listEnd);
        const markerRegex = ordered
          ? /^(\d+[.)])[ \t]+/
          : /^([*+-])[ \t]+/;
        if (remaining.startsWith(targetIndent)) {
          const afterIndent = remaining.slice(targetIndent.length);
          if (markerRegex.test(afterIndent)) {
            if (itemStarts.length < itemsCount) {
              itemStarts.push(lineStart);
            }
          }
        }
      }
    }
    idx++;
  }

  const ranges: SourceRange[] = [];
  for (let k = 0; k < itemStarts.length; k++) {
    const from = itemStarts[k]!;
    const to = k + 1 < itemStarts.length ? itemStarts[k + 1]! : listEnd;
    ranges.push({ from, to });
  }
  return ranges;
}

