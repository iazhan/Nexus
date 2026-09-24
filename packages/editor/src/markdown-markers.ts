import { StateField, RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import { parseMarkdown, type MarkdownNode } from '@nexus/markdown';
import type { MarkdownMarker } from './types.js';

/**
 * Checks if a line starts with a fenced code block opening or closing.
 * CommonMark allows 0-3 leading spaces, followed by 3+ backticks or tildes.
 */
function parseFenceAtLine(
  content: string,
  lineStart: number
): { isFence: boolean; fenceChar: string; fenceLen: number; lineEnd: number } | null {
  const len = content.length;
  let pos = lineStart;

  // 0-3 spaces allowed before fence
  let spaces = 0;
  while (pos < len && content[pos] === ' ' && spaces < 3) {
    spaces++;
    pos++;
  }

  if (pos >= len) return null;

  const fenceChar = content[pos];
  if (fenceChar !== '`' && fenceChar !== '~') return null;

  let fenceLen = 0;
  while (pos < len && content[pos] === fenceChar) {
    fenceLen++;
    pos++;
  }

  if (fenceLen < 3) return null;

  // Find line end
  let lineEnd = pos;
  while (lineEnd < len && content[lineEnd] !== '\n') {
    lineEnd++;
  }
  // Include \n in line if present
  if (lineEnd < len && content[lineEnd] === '\n') {
    lineEnd++;
  }

  return { isFence: true, fenceChar, fenceLen, lineEnd };
}

/**
 * Checks if a line is a closing fence for an open code block.
 */
function isClosingFence(
  content: string,
  lineStart: number,
  expectedChar: string,
  minLen: number
): { isMatch: boolean; lineEnd: number } {
  const len = content.length;
  let pos = lineStart;

  let spaces = 0;
  while (pos < len && content[pos] === ' ' && spaces < 3) {
    spaces++;
    pos++;
  }

  let count = 0;
  while (pos < len && content[pos] === expectedChar) {
    count++;
    pos++;
  }

  let lineEnd = pos;
  while (lineEnd < len && content[lineEnd] !== '\n') {
    lineEnd++;
  }
  if (lineEnd < len && content[lineEnd] === '\n') {
    lineEnd++;
  }

  if (count < minLen) {
    return { isMatch: false, lineEnd };
  }

  // After closing fence characters, only trailing spaces are permitted
  for (let p = pos; p < lineEnd; p++) {
    const ch = content[p];
    if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n') {
      return { isMatch: false, lineEnd };
    }
  }

  return { isMatch: true, lineEnd };
}

/**
 * Pure function to scan and locate markdown markers in document text:
 * - inline-math: $...$
 * - block-math: $$...$$
 * - wikilink: [[...]]
 * - code-fence: ```...``` or ~~~...~~~
 */
export function findMarkdownMarkers(content: string): MarkdownMarker[] {
  const markers: MarkdownMarker[] = [];
  if (!content) return markers;

  const totalLen = content.length;
  let i = 0;

  while (i < totalLen) {
    const isLineStart = i === 0 || content[i - 1] === '\n';

    // 1. Check for fenced code block at line beginning
    if (isLineStart) {
      const fenceOpening = parseFenceAtLine(content, i);
      if (fenceOpening) {
        const fenceStart = i;
        let curLineStart = fenceOpening.lineEnd;
        let fenceEnd = totalLen;

        while (curLineStart < totalLen) {
          const closing = isClosingFence(
            content,
            curLineStart,
            fenceOpening.fenceChar,
            fenceOpening.fenceLen
          );
          if (closing.isMatch) {
            fenceEnd = closing.lineEnd;
            break;
          }
          curLineStart = closing.lineEnd;
        }

        markers.push({
          type: 'code-fence',
          from: fenceStart,
          to: fenceEnd,
          text: content.slice(fenceStart, fenceEnd)
        });

        i = fenceEnd;
        continue;
      }
    }

    // 2. Escape character \
    if (content[i] === '\\') {
      i += 2;
      continue;
    }

    // 3. Inline code span: `code`
    if (content[i] === '`') {
      let tickCount = 0;
      while (i + tickCount < totalLen && content[i + tickCount] === '`') {
        tickCount++;
      }
      const closeIdx = content.indexOf('`'.repeat(tickCount), i + tickCount);
      if (closeIdx !== -1) {
        // Skip over the entire inline code span
        i = closeIdx + tickCount;
        continue;
      } else {
        // Unclosed backtick, advance past ticks
        i += tickCount;
        continue;
      }
    }

    // 4. Block math: $$...$$
    if (content.startsWith('$$', i)) {
      const startPos = i;
      let searchPos = i + 2;
      let closePos = -1;

      while (searchPos < totalLen) {
        const nextDollarDollar = content.indexOf('$$', searchPos);
        if (nextDollarDollar === -1) break;

        // Check if escaped
        let bsCount = 0;
        let back = nextDollarDollar - 1;
        while (back >= startPos + 2 && content[back] === '\\') {
          bsCount++;
          back--;
        }

        if (bsCount % 2 === 0) {
          closePos = nextDollarDollar;
          break;
        }
        searchPos = nextDollarDollar + 2;
      }

      if (closePos !== -1 && closePos > startPos) {
        const endPos = closePos + 2;
        markers.push({
          type: 'block-math',
          from: startPos,
          to: endPos,
          text: content.slice(startPos, endPos)
        });
        i = endPos;
        continue;
      } else {
        // Unclosed $$ - do not emit incomplete marker, continue safely
        i += 2;
        continue;
      }
    }

    // 5. Inline math: $...$
    if (content[i] === '$') {
      const startPos = i;
      const nextChar = content[i + 1];

      // Next character cannot be whitespace, $, or EOF
      if (
        nextChar !== undefined &&
        nextChar !== ' ' &&
        nextChar !== '\t' &&
        nextChar !== '\r' &&
        nextChar !== '\n' &&
        nextChar !== '$'
      ) {
        let scanPos = i + 1;
        let foundClose = -1;

        while (scanPos < totalLen) {
          // Cannot span multiple paragraphs
          if (content[scanPos] === '\n' && scanPos + 1 < totalLen && content[scanPos + 1] === '\n') {
            break;
          }

          if (content[scanPos] === '\\') {
            scanPos += 2;
            continue;
          }

          if (content[scanPos] === '$') {
            const prevChar = content[scanPos - 1];
            const afterChar = content[scanPos + 1];

            // Closing $ cannot be preceded by whitespace or \
            const isPrevWhitespace =
              prevChar === ' ' ||
              prevChar === '\t' ||
              prevChar === '\r' ||
              prevChar === '\n';

            // Avoid matching currency like $10 and $20
            const isNextDigit = afterChar !== undefined && afterChar >= '0' && afterChar <= '9';

            if (!isPrevWhitespace && !isNextDigit) {
              foundClose = scanPos;
              break;
            }
          }
          scanPos++;
        }

        if (foundClose !== -1) {
          const endPos = foundClose + 1;
          markers.push({
            type: 'inline-math',
            from: startPos,
            to: endPos,
            text: content.slice(startPos, endPos)
          });
          i = endPos;
          continue;
        }
      }

      i++;
      continue;
    }

    // 6. Wikilink: [[...]]
    if (content.startsWith('[[', i)) {
      const startPos = i;
      const scanStart = i + 2;
      let closePos = -1;
      let scan = scanStart;

      while (scan < totalLen) {
        const ch = content[scan];
        // Wikilinks cannot cross newlines or contain another [[
        if (ch === '\n' || content.startsWith('[[', scan)) {
          break;
        }

        if (content.startsWith(']]', scan)) {
          const inner = content.slice(scanStart, scan);
          if (inner.length > 0 && !inner.includes('[') && !inner.includes(']')) {
            closePos = scan;
          }
          break;
        }
        scan++;
      }

      if (closePos !== -1) {
        const endPos = closePos + 2;
        markers.push({
          type: 'wikilink',
          from: startPos,
          to: endPos,
          text: content.slice(startPos, endPos)
        });
        i = endPos;
        continue;
      } else {
        // Unclosed [[ - advance safely
        i += 2;
        continue;
      }
    }

    i++;
  }

  if (markers.length === 0) return markers;

  const { root } = parseMarkdown(content);
  const opaqueRanges = collectOpaqueRanges(root);
  if (opaqueRanges.length === 0) return markers;

  return markers.filter((marker) => {
    return !opaqueRanges.some((op) => {
      if (marker.type === 'code-fence') {
        return op.type === 'raw' && marker.from >= op.from && marker.to <= op.to;
      }
      return marker.from >= op.from && marker.to <= op.to;
    });
  });
}

function collectOpaqueRanges(root: MarkdownNode): { from: number; to: number; type: string }[] {
  const ranges: { from: number; to: number; type: string }[] = [];
  function walk(node: MarkdownNode) {
    if (node.type === 'raw' || node.type === 'code-block' || node.type === 'inline-code' || node.opaque === true) {
      ranges.push({ from: node.range.from, to: node.range.to, type: node.type });
      return;
    }
    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children) {
        walk(child as MarkdownNode);
      }
    }
    if (node.type === 'list') {
      for (const item of node.items) {
        walk(item);
      }
    }
    if (node.type === 'table') {
      for (const row of node.headers) {
        for (const cell of row) walk(cell);
      }
      for (const row of node.rows) {
        for (const cellList of row) {
          for (const cell of cellList) walk(cell);
        }
      }
    }
  }
  walk(root);
  return ranges;
}


/**
 * 块级公式底纹的**行装饰**类名。
 *
 * 与 `.cm-marker-block-math`（mark span 版本）共用同一套视觉，但只负责把底色铺满
 * 整行——mark span 覆盖不到没有字符的空行。
 */
export const BLOCK_MATH_BAND_CLASS = 'cm-marker-block-math-band';

/**
 * Builds a CodeMirror DecorationSet from scanned markdown markers.
 */
export function buildMarkerDecorations(content: string): DecorationSet {
  const ranges: Array<{ from: number; to: number; decoration: Decoration }> = [];

  for (const marker of findMarkdownMarkers(content)) {
    ranges.push({
      from: marker.from,
      to: marker.to,
      decoration: Decoration.mark({
        class: `cm-marker cm-marker-${marker.type}`
      })
    });

    // `Decoration.mark` 跨行时只会给**有字符的行**生成 span，而块级公式的底纹
    // （`.cm-marker-block-math` 的背景与左侧竖条）正是画在这个 span 上的。
    // 公式内部的空行一个字符都没有 → 没有 span → 没有底色，整条底纹被切成几段，
    // 视觉上就是"空白行缺失应有的样式"。
    //
    // 这里按行补一层**只画底纹**的行装饰把范围铺满：文字颜色与内边距仍由 mark span
    // 承担，非空行的两层底纹完全重合，视觉不变；空行则由行装饰兜住。
    if (marker.type !== 'block-math') continue;
    if (!content.slice(marker.from, marker.to).includes('\n')) continue;

    let lineStart = content.lastIndexOf('\n', Math.max(0, marker.from - 1)) + 1;
    while (lineStart <= marker.to) {
      ranges.push({
        from: lineStart,
        to: lineStart,
        decoration: Decoration.line({ class: BLOCK_MATH_BAND_CLASS })
      });
      const nextBreak = content.indexOf('\n', lineStart);
      if (nextBreak === -1) break;
      lineStart = nextBreak + 1;
    }
  }

  // RangeSetBuilder 只接受按 (from, startSide) 升序的输入——行装饰的 startSide
  // 是负数（排在 mark 之前），所以必须先排序再添加，不能依赖插入顺序。
  ranges.sort(
    (left, right) =>
      left.from - right.from || left.decoration.startSide - right.decoration.startSide
  );

  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) {
    if (range.from <= range.to) {
      builder.add(range.from, range.to, range.decoration);
    }
  }

  return builder.finish();
}

/**
 * CodeMirror StateField providing marker decorations for inline math, block math,
 * wikilinks, and code fences.
 */
export const markdownMarkersField = StateField.define<DecorationSet>({
  create(state) {
    return buildMarkerDecorations(state.doc.toString());
  },
  update(decorations, tr) {
    if (!tr.docChanged) return decorations;
    return buildMarkerDecorations(tr.state.doc.toString());
  },
  provide: (field) => EditorView.decorations.from(field)
});

/**
 * Helper to check if a document contains any math markers (for P1-06 lazy loading).
 */
export function hasMathMarkers(content: string): boolean {
  const markers = findMarkdownMarkers(content);
  return markers.some((m) => m.type === 'inline-math' || m.type === 'block-math');
}
