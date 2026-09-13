import { StateField, RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
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

  return markers;
}

/**
 * Builds a CodeMirror DecorationSet from scanned markdown markers.
 */
export function buildMarkerDecorations(content: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const markers = findMarkdownMarkers(content);

  for (const marker of markers) {
    builder.add(
      marker.from,
      marker.to,
      Decoration.mark({
        class: `cm-marker cm-marker-${marker.type}`
      })
    );
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
