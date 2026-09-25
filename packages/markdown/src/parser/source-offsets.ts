/**
 * 源码偏移与范围扫描：把 marked 归一化后的 token 文本映回原文，并在原文上定位列表项范围。
 * 全部是纯函数，不依赖任何其它 parser 模块（本层最底）。
 */

/**
 * Maps marked's \n-normalized token.raw back to the exact substring in the source text,
 * correctly accounting for Windows CRLF (\r\n) line endings without offset drift.
 */
export function matchTokenEndInSource(
  source: string,
  startOffset: number,
  markedRaw: string
): number {
  let s = startOffset;
  for (let m = 0; m < markedRaw.length; m++) {
    const ch = markedRaw[m];
    if (ch === '\n') {
      if (s < source.length && source[s] === '\r' && source[s + 1] === '\n') {
        s += 2;
      } else if (s < source.length && (source[s] === '\n' || source[s] === '\r')) {
        s += 1;
      } else {
        s += 1;
      }
    } else if (
      ch === '|' &&
      s + 1 < source.length &&
      source[s] === '\\' &&
      source[s + 1] === '|'
    ) {
      s += 2;
    } else {
      if (s < source.length) {
        s += 1;
      }
    }
  }
  return s;
}

/**
 * Returns the line break end index for a heading line, ensuring that trailing
 * blank lines (\r\n\r\n or \n\n) are not swallowed into the heading's range.
 */
export function getHeadingLineEnd(source: string, from: number, tokenEnd: number): number {
  for (let i = from; i < tokenEnd; i++) {
    if (source[i] === '\r' && source[i + 1] === '\n') {
      return i + 2;
    }
    if (source[i] === '\n') {
      return i + 1;
    }
  }
  return tokenEnd;
}

/**
 * Trims trailing blank lines (\r\n\r\n or \n\n) from a block token end.
 */
export function trimTrailingBlankLines(source: string, from: number, tokenEnd: number): number {
  let end = tokenEnd;
  while (end > from) {
    if (end >= from + 2 && source.slice(end - 2, end) === '\r\n') {
      const prev = end - 2;
      if (
        (prev >= from + 2 && source.slice(prev - 2, prev) === '\r\n') ||
        (prev >= from + 1 && source[prev - 1] === '\n')
      ) {
        end -= 2;
        continue;
      }
    } else if (end >= from + 1 && source[end - 1] === '\n') {
      const prev = end - 1;
      if (
        (prev >= from + 1 && source[prev - 1] === '\n') ||
        (prev >= from + 2 && source.slice(prev - 2, prev) === '\r\n')
      ) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return end;
}

/**
 * Determines the character offset where a list item's content begins
 * after its leading whitespace, marker (*, -, +, 1.), and optional task checkbox.
 */
export function getItemContentStart(itemRaw: string): number {
  const match = itemRaw.match(/^\s*(?:[*+-]|\d+[.)])\s*(?:\[[ xX]\]\s*)?/);
  return match ? match[0].length : 0;
}

