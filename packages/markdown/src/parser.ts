import { marked, type Token, type Tokens } from 'marked';
import { sanitizeUrl } from './security.js';
import type {
  MarkdownBlockNode,
  MarkdownDiagnostic,
  MarkdownInlineNode,
  MarkdownListItem,
  MarkdownParseResult,
  SourceRange
} from './types.js';

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
function getHeadingLineEnd(source: string, from: number, tokenEnd: number): number {
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
function trimTrailingBlankLines(source: string, from: number, tokenEnd: number): number {
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
function getItemContentStart(itemRaw: string): number {
  const match = itemRaw.match(/^\s*(?:[*+-]|\d+[.)])\s*(?:\[[ xX]\]\s*)?/);
  return match ? match[0].length : 0;
}

/**
 * Parses inline text to identify math ($...$, $$...$$) and wikilinks ([[...]])
 * while preserving all other text verbatim with exact source ranges.
 */
export function parseSpecialInlineSyntax(
  rawText: string,
  baseOffset = 0,
  source?: string
): MarkdownInlineNode[] {
  const nodes: MarkdownInlineNode[] = [];
  if (!rawText) return nodes;

  const fullSource = source ?? rawText;
  const len = rawText.length;
  let i = 0;
  let textBufferStart = 0;

  const flushText = (endIdx: number) => {
    if (endIdx > textBufferStart) {
      const from = baseOffset + textBufferStart;
      const to = baseOffset + endIdx;
      const raw = fullSource.slice(from, to);
      nodes.push({
        type: 'text',
        value: rawText.slice(textBufferStart, endIdx),
        range: { from, to },
        raw
      });
      textBufferStart = endIdx;
    }
  };

  while (i < len) {
    // 1. Escaped characters: e.g. \$ or \[\[
    if (rawText[i] === '\\' && i + 1 < len) {
      i += 2;
      continue;
    }

    // 2. Block math within text: $$...$$
    if (rawText.startsWith('$$', i)) {
      const closeIdx = rawText.indexOf('$$', i + 2);
      if (closeIdx !== -1) {
        flushText(i);
        const from = baseOffset + i;
        const to = baseOffset + closeIdx + 2;
        const formula = rawText.slice(i + 2, closeIdx);
        const raw = fullSource.slice(from, to);
        nodes.push({
          type: 'inline-math',
          formula,
          range: { from, to },
          raw
        });
        i = closeIdx + 2;
        textBufferStart = i;
        continue;
      }
    }

    // 3. Inline math: $...$
    if (rawText[i] === '$') {
      const nextChar = rawText[i + 1];
      const isValidStart =
        nextChar !== undefined &&
        nextChar !== ' ' &&
        nextChar !== '\t' &&
        nextChar !== '\r' &&
        nextChar !== '\n' &&
        nextChar !== '$';

      if (isValidStart) {
        let scan = i + 1;
        let foundClose = -1;

        while (scan < len) {
          if (
            (rawText[scan] === '\n' && scan + 1 < len && rawText[scan + 1] === '\n') ||
            (rawText[scan] === '\r' && scan + 3 < len && rawText.slice(scan, scan + 4) === '\r\n\r\n')
          ) {
            break; // Do not span multiple paragraphs
          }
          if (rawText[scan] === '\\') {
            scan += 2;
            continue;
          }
          if (rawText[scan] === '$') {
            const prevChar = rawText[scan - 1];
            const afterChar = rawText[scan + 1];
            const isPrevWhitespace =
              prevChar === ' ' ||
              prevChar === '\t' ||
              prevChar === '\r' ||
              prevChar === '\n';
            const isNextDigit =
              afterChar !== undefined && afterChar >= '0' && afterChar <= '9';

            if (!isPrevWhitespace && !isNextDigit) {
              foundClose = scan;
              break;
            }
          }
          scan++;
        }

        if (foundClose !== -1) {
          flushText(i);
          const from = baseOffset + i;
          const to = baseOffset + foundClose + 1;
          const formula = rawText.slice(i + 1, foundClose);
          const raw = fullSource.slice(from, to);
          nodes.push({
            type: 'inline-math',
            formula,
            range: { from, to },
            raw
          });
          i = foundClose + 1;
          textBufferStart = i;
          continue;
        }
      }
    }

    // 4. Wikilink: [[target]] or [[target|alias]]
    if (rawText.startsWith('[[', i)) {
      const closeIdx = rawText.indexOf(']]', i + 2);
      if (closeIdx !== -1) {
        const inner = rawText.slice(i + 2, closeIdx);
        // Wikilink cannot span newlines or contain brackets
        if (!inner.includes('\n') && !inner.includes('\r') && !inner.includes('[') && !inner.includes(']')) {
          flushText(i);
          const pipeIdx = inner.indexOf('|');
          let target = inner;
          let alias: string | undefined = undefined;
          if (pipeIdx !== -1) {
            target = inner.slice(0, pipeIdx).trim();
            alias = inner.slice(pipeIdx + 1).trim();
          } else {
            target = target.trim();
          }

          const from = baseOffset + i;
          const to = baseOffset + closeIdx + 2;
          const raw = fullSource.slice(from, to);
          nodes.push({
            type: 'wikilink',
            target,
            alias,
            range: { from, to },
            raw
          });
          i = closeIdx + 2;
          textBufferStart = i;
          continue;
        }
      }
    }

    i++;
  }

  flushText(len);
  return nodes;
}

/**
 * Maps marked inline tokens into project AST inline nodes with exact source ranges.
 */
function mapInlineTokens(
  tokens: Token[],
  baseOffset: number,
  source: string,
  diagnostics: MarkdownDiagnostic[]
): MarkdownInlineNode[] {
  const result: MarkdownInlineNode[] = [];
  let cur = baseOffset;

  for (const token of tokens) {
    const end = matchTokenEndInSource(source, cur, token.raw);
    const range: SourceRange = { from: cur, to: end };
    const raw = source.slice(cur, end);

    switch (token.type) {
      case 'text': {
        const textToken = token as Tokens.Text;
        if (textToken.tokens && textToken.tokens.length > 0) {
          result.push(...mapInlineTokens(textToken.tokens, cur, source, diagnostics));
        } else {
          result.push(...parseSpecialInlineSyntax(raw, cur, source));
        }
        break;
      }
      case 'strong': {
        const strongToken = token as Tokens.Strong;
        // Delimiters (usually ** or __ of length 2)
        const delimMatch = raw.match(/^(\*\*|__)/);
        const delimLen = delimMatch && delimMatch[1] ? delimMatch[1].length : 2;
        const innerFrom = cur + delimLen;
        const innerEnd = Math.max(innerFrom, end - delimLen);

        let children: MarkdownInlineNode[];
        if (strongToken.tokens && strongToken.tokens.length > 0) {
          children = mapInlineTokens(strongToken.tokens, innerFrom, source, diagnostics);
        } else {
          children = parseSpecialInlineSyntax(source.slice(innerFrom, innerEnd), innerFrom, source);
        }

        result.push({
          type: 'bold',
          children,
          range,
          raw
        });
        break;
      }
      case 'em': {
        const emToken = token as Tokens.Em;
        // Delimiters (usually * or _ of length 1)
        const delimMatch = raw.match(/^(\*|_)/);
        const delimLen = delimMatch && delimMatch[1] ? delimMatch[1].length : 1;
        const innerFrom = cur + delimLen;
        const innerEnd = Math.max(innerFrom, end - delimLen);

        let children: MarkdownInlineNode[];
        if (emToken.tokens && emToken.tokens.length > 0) {
          children = mapInlineTokens(emToken.tokens, innerFrom, source, diagnostics);
        } else {
          children = parseSpecialInlineSyntax(source.slice(innerFrom, innerEnd), innerFrom, source);
        }

        result.push({
          type: 'italic',
          children,
          range,
          raw
        });
        break;
      }
      case 'codespan': {
        const codeToken = token as Tokens.Codespan;
        result.push({
          type: 'inline-code',
          value: codeToken.text,
          range,
          raw
        });
        break;
      }
      case 'link': {
        const linkToken = token as Tokens.Link;
        const sanitizeResult = sanitizeUrl(linkToken.href);
        if (sanitizeResult.isBlocked) {
          diagnostics.push({
            severity: 'warning',
            message: sanitizeResult.reason ?? 'Blocked potentially unsafe link protocol'
          });
        }

        // Link label starts at cur + 1 (after '[')
        const innerFrom = cur + 1;
        const closeBracketIdx = raw.indexOf(']');
        const innerEnd = closeBracketIdx !== -1 ? cur + closeBracketIdx : end;

        let children: MarkdownInlineNode[];
        if (linkToken.tokens && linkToken.tokens.length > 0) {
          children = mapInlineTokens(linkToken.tokens, innerFrom, source, diagnostics);
        } else {
          children = parseSpecialInlineSyntax(source.slice(innerFrom, innerEnd), innerFrom, source);
        }

        result.push({
          type: 'link',
          href: linkToken.href,
          title: linkToken.title || undefined,
          safeHref: sanitizeResult.safeUrl,
          isBlocked: sanitizeResult.isBlocked,
          children,
          range,
          raw
        });
        break;
      }
      case 'image': {
        const imgToken = token as Tokens.Image;
        const sanitizeResult = sanitizeUrl(imgToken.href);
        if (sanitizeResult.isBlocked) {
          diagnostics.push({
            severity: 'warning',
            message: sanitizeResult.reason ?? 'Blocked potentially unsafe image source'
          });
        }
        result.push({
          type: 'image',
          src: imgToken.href,
          alt: imgToken.text,
          title: imgToken.title || undefined,
          safeSrc: sanitizeResult.safeUrl,
          isBlocked: sanitizeResult.isBlocked,
          range,
          raw
        });
        break;
      }
      case 'html': {
        const htmlToken = token as Tokens.HTML;
        result.push({
          type: 'raw',
          value: htmlToken.text,
          range,
          raw,
          opaque: true
        });
        break;
      }
      case 'escape': {
        const escToken = token as Tokens.Escape;
        result.push({
          type: 'text',
          value: escToken.text,
          range,
          raw,
          escaped: true
        });
        break;
      }
      default: {
        if ('text' in token && typeof (token as { text?: unknown }).text === 'string') {
          result.push(...parseSpecialInlineSyntax(raw, cur, source));
        } else {
          result.push({
            type: 'raw',
            value: raw,
            range,
            raw,
            opaque: true
          });
        }
      }
    }

    cur = end;
  }

  return result;
}

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

/**
 * Maps a marked list token into a project MarkdownBlockNode with exact ranges.
 * Handles recursive nested lists with correct indentation and parent-child containment.
 */
function mapListToken(
  listToken: Tokens.List,
  source: string,
  listStart: number,
  listEnd: number,
  diagnostics: MarkdownDiagnostic[]
): MarkdownBlockNode {
  const itemRanges = findListItemsRanges(
    source,
    listStart,
    listEnd,
    listToken.items.length,
    listToken.ordered
  );
  const items: MarkdownListItem[] = [];

  for (let i = 0; i < listToken.items.length; i++) {
    const item = listToken.items[i]!;
    const itemRange = itemRanges[i] ?? { from: listStart, to: listEnd };
    const itemRaw = source.slice(itemRange.from, itemRange.to);
    const contentStartOffset = itemRange.from + getItemContentStart(itemRaw);

    const itemChildren: (MarkdownInlineNode | MarkdownBlockNode)[] = [];

    if (item.tokens && item.tokens.length > 0) {
      let childCur = contentStartOffset;
      for (const subToken of item.tokens) {
        if (subToken.type === 'space') {
          while (childCur < itemRange.to) {
            if (source[childCur] === '\r' && source[childCur + 1] === '\n') {
              childCur += 2;
            } else if (source[childCur] === '\n') {
              childCur += 1;
            } else if (source[childCur] === ' ' || source[childCur] === '\t') {
              let scan = childCur;
              while (scan < itemRange.to && (source[scan] === ' ' || source[scan] === '\t')) {
                scan++;
              }
              if (
                scan < itemRange.to &&
                (source[scan] === '\n' ||
                  (source[scan] === '\r' && source[scan + 1] === '\n'))
              ) {
                childCur = source[scan] === '\r' ? scan + 2 : scan + 1;
              } else {
                break;
              }
            } else {
              break;
            }
          }
          continue;
        }

        if (subToken.type === 'text') {
          const txt = subToken as Tokens.Text;
          const textEnd = matchTokenEndInSource(source, childCur, txt.raw);
          const tFrom = childCur;
          if (txt.tokens && txt.tokens.length > 0) {
            itemChildren.push(...mapInlineTokens(txt.tokens, tFrom, source, diagnostics));
          } else {
            itemChildren.push(...parseSpecialInlineSyntax(source.slice(tFrom, textEnd), tFrom, source));
          }
          childCur = textEnd;
        } else if (subToken.type === 'list') {
          let nestedStart = childCur;
          if (childCur > 0 && source[childCur - 1] !== '\n') {
            const nextNl = source.indexOf('\n', childCur);
            if (nextNl !== -1 && nextNl < itemRange.to) {
              nestedStart = nextNl + 1;
            }
          }
          const nestedList = mapListToken(
            subToken as Tokens.List,
            source,
            nestedStart,
            itemRange.to,
            diagnostics
          );
          itemChildren.push(nestedList);
          childCur = nestedList.range.to;
        } else if (
          subToken.type === 'blockquote' ||
          subToken.type === 'code' ||
          subToken.type === 'html' ||
          subToken.type === 'hr' ||
          subToken.type === 'heading' ||
          subToken.type === 'table' ||
          subToken.type === 'paragraph' ||
          (subToken as { block?: boolean }).block === true
        ) {
          let blockStart = childCur;
          if (childCur > 0 && source[childCur - 1] !== '\n') {
            const lastNl = source.lastIndexOf('\n', childCur - 1);
            const lineStart = lastNl === -1 ? itemRange.from : lastNl + 1;
            const beforeCur = source.slice(lineStart, childCur);
            const itemRawSoFar = source.slice(itemRange.from, childCur);
            const markerMatch = itemRawSoFar.match(/^[ \t]*(?:[*+-]|\d+[.)])[ \t]*/);
            const markerLen = markerMatch ? markerMatch[0].length : 0;
            const hasTextBefore = beforeCur.trim().length > 0 && childCur > itemRange.from + markerLen;
            if (hasTextBefore) {
              const nextNl = source.indexOf('\n', childCur);
              if (nextNl !== -1 && nextNl < itemRange.to) {
                blockStart = nextNl + 1;
              }
            }
          }
          // Advance past any blank lines before the block within itemRange
          while (blockStart < itemRange.to) {
            if (source[blockStart] === '\r' && source[blockStart + 1] === '\n') {
              blockStart += 2;
            } else if (source[blockStart] === '\n') {
              blockStart += 1;
            } else {
              break;
            }
          }

          const subLines = subToken.raw.split(/\r?\n/);
          if (subLines.length > 0 && subLines[subLines.length - 1] === '') {
            subLines.pop();
          }
          const lineCount = subLines.length;
          let blockEnd = blockStart;
          for (let l = 0; l < lineCount; l++) {
            const nextNl = source.indexOf('\n', blockEnd);
            if (nextNl === -1 || nextNl >= itemRange.to) {
              blockEnd = itemRange.to;
              break;
            }
            blockEnd = nextNl + 1;
          }

          const raw = source.slice(blockStart, blockEnd);

          if (subToken.type === 'code') {
            const codeToken = subToken as Tokens.Code;
            itemChildren.push({
              type: 'code-block',
              language: codeToken.lang || undefined,
              value: codeToken.text,
              range: { from: blockStart, to: blockEnd },
              raw
            });
          } else if (subToken.type === 'blockquote') {
            const bqToken = subToken as Tokens.Blockquote;
            const bqChildren = bqToken.tokens
              ? mapBlockquoteChildren(bqToken.tokens, source, blockStart, blockEnd, diagnostics)
              : [];
            itemChildren.push({
              type: 'blockquote',
              children: bqChildren,
              range: { from: blockStart, to: blockEnd },
              raw
            });
          } else if (subToken.type === 'heading') {
            const hToken = subToken as Tokens.Heading;
            const hChildren = hToken.tokens
              ? mapInlineTokens(hToken.tokens, blockStart, source, diagnostics)
              : parseSpecialInlineSyntax(hToken.text, blockStart, source);
            itemChildren.push({
              type: 'heading',
              depth: hToken.depth as 1 | 2 | 3 | 4 | 5 | 6,
              children: hChildren,
              range: { from: blockStart, to: blockEnd },
              raw
            });
          } else if (subToken.type === 'html') {
            const htmlToken = subToken as Tokens.HTML;
            itemChildren.push({
              type: 'raw',
              value: htmlToken.text ?? raw.trim(),
              range: { from: blockStart, to: blockEnd },
              raw,
              opaque: true,
              block: true
            });
          } else if (subToken.type === 'hr') {
            itemChildren.push({
              type: 'raw',
              value: raw.trim(),
              range: { from: blockStart, to: blockEnd },
              raw,
              opaque: true,
              block: true
            });
          } else {
            itemChildren.push({
              type: 'raw',
              value: 'text' in subToken && typeof (subToken as { text?: unknown }).text === 'string'
                ? (subToken as { text: string }).text
                : raw,
              range: { from: blockStart, to: blockEnd },
              raw,
              opaque: true,
              block: true
            });
          }
          childCur = blockEnd;
        } else if ('tokens' in subToken && Array.isArray((subToken as { tokens?: Token[] }).tokens)) {
          itemChildren.push(
            ...mapInlineTokens((subToken as { tokens: Token[] }).tokens, childCur, source, diagnostics)
          );
          childCur = matchTokenEndInSource(source, childCur, subToken.raw);
        } else if ('text' in subToken && typeof (subToken as { text?: unknown }).text === 'string') {
          const subEnd = matchTokenEndInSource(source, childCur, subToken.raw);
          itemChildren.push(
            ...parseSpecialInlineSyntax(source.slice(childCur, subEnd), childCur, source)
          );
          childCur = subEnd;
        }
      }
    } else {
      itemChildren.push(
        ...parseSpecialInlineSyntax(source.slice(contentStartOffset, itemRange.to), contentStartOffset, source)
      );
    }

    items.push({
      type: 'list-item',
      task: item.task,
      checked: item.checked,
      children: itemChildren,
      range: itemRange,
      raw: itemRaw
    });
  }

  const firstItem = items[0];
  const lastItem = items[items.length - 1];
  const listFrom = firstItem ? firstItem.range.from : listStart;
  const listTo = lastItem ? lastItem.range.to : listEnd;

  return {
    type: 'list',
    ordered: listToken.ordered,
    start: typeof listToken.start === 'number' ? listToken.start : undefined,
    items,
    range: { from: listFrom, to: listTo },
    raw: source.slice(listFrom, listTo)
  };
}

/**
 * Returns all unescaped pipe '|' indices in a table row line.
 */
export function getUnescapedPipes(line: string): number[] {
  const pipes: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|') {
      let backslashes = 0;
      let k = i - 1;
      while (k >= 0 && line[k] === '\\') {
        backslashes++;
        k--;
      }
      if (backslashes % 2 === 0) {
        pipes.push(i);
      }
    }
  }
  return pipes;
}

/**
 * Returns the exact column cell ranges inside a table row line.
 * Correctly handles tables with or without leading/trailing pipes and escaped pipes.
 */
export function getRowCellRanges(
  line: string,
  rowOffset = 0
): { slotStart: number; slotEnd: number; from: number; to: number }[] {
  const pipes = getUnescapedPipes(line);
  const hasLeadingPipe = pipes.length > 0 && line.slice(0, pipes[0]).trim() === '';
  const hasTrailingPipe =
    pipes.length > 0 && line.slice(pipes[pipes.length - 1]! + 1).trim() === '';

  const delimiters: number[] = [];
  if (hasLeadingPipe) {
    delimiters.push(pipes[0]!);
  } else {
    delimiters.push(-1);
  }

  const startIdx = hasLeadingPipe ? 1 : 0;
  const endIdx = hasTrailingPipe ? pipes.length - 1 : pipes.length;
  for (let p = startIdx; p < endIdx; p++) {
    delimiters.push(pipes[p]!);
  }

  if (hasTrailingPipe) {
    delimiters.push(pipes[pipes.length - 1]!);
  } else {
    delimiters.push(line.length);
  }

  const cells: { slotStart: number; slotEnd: number; from: number; to: number }[] = [];
  for (let i = 0; i < delimiters.length - 1; i++) {
    const p1 = delimiters[i]!;
    const p2 = delimiters[i + 1]!;
    const segment = line.slice(p1 + 1, p2);
    const leadMatch = segment.match(/^\s*/);
    const trailMatch = segment.match(/\s*$/);
    const leadLen = leadMatch ? leadMatch[0].length : 0;
    const trailLen = trailMatch ? trailMatch[0].length : 0;
    const cFrom = rowOffset + p1 + 1 + leadLen;
    const cTo = Math.max(cFrom, rowOffset + p2 - trailLen);
    cells.push({
      slotStart: p1 + 1,
      slotEnd: p2,
      from: cFrom,
      to: cTo
    });
  }
  return cells;
}

interface BlockquoteLine {
  sourceLineStart: number;
  prefixLen: number;
  contentStartInSource: number;
  contentEndInSource: number;
  contentLen: number;
  hasBreak: boolean;
  breakLen: number;
  strippedTextStart: number;
  strippedTextEnd: number;
}

function buildBlockquoteLineMap(
  source: string,
  bqStart: number,
  bqEnd: number
): {
  lines: BlockquoteLine[];
  strippedText: string;
  mapTextStartToSource: (offsetInText: number) => number;
  mapTextEndToSource: (offsetInText: number) => number;
} {
  const raw = source.slice(bqStart, bqEnd);
  const lines: BlockquoteLine[] = [];
  let curStripped = 0;
  let strippedText = '';

  let i = 0;
  while (i < raw.length) {
    const lineStartInRaw = i;
    const sourceLineStart = bqStart + lineStartInRaw;

    let lineEndInRaw = i;
    let breakLen = 0;
    while (lineEndInRaw < raw.length) {
      if (raw[lineEndInRaw] === '\r' && raw[lineEndInRaw + 1] === '\n') {
        breakLen = 2;
        break;
      }
      if (raw[lineEndInRaw] === '\n') {
        breakLen = 1;
        break;
      }
      lineEndInRaw++;
    }

    const lineWithBreakLen = (lineEndInRaw - lineStartInRaw) + breakLen;
    const lineContentRaw = raw.slice(lineStartInRaw, lineEndInRaw);

    const prefixMatch = lineContentRaw.match(/^[ \t]*>[ \t]?/);
    const prefixLen = prefixMatch ? prefixMatch[0].length : 0;

    const contentStartInSource = sourceLineStart + prefixLen;
    const contentEndInSource = sourceLineStart + lineContentRaw.length;
    const contentStr = lineContentRaw.slice(prefixLen);
    const contentLen = contentStr.length;

    const hasBreak = breakLen > 0;
    const strippedLineText = hasBreak ? contentStr + '\n' : contentStr;
    const strippedTextStart = curStripped;
    const strippedTextEnd = curStripped + strippedLineText.length;

    lines.push({
      sourceLineStart,
      prefixLen,
      contentStartInSource,
      contentEndInSource,
      contentLen,
      hasBreak,
      breakLen,
      strippedTextStart,
      strippedTextEnd
    });

    strippedText += strippedLineText;
    curStripped = strippedTextEnd;

    i = lineStartInRaw + lineWithBreakLen;
  }

  function mapTextStartToSource(offsetInText: number): number {
    if (lines.length === 0) return bqStart;
    if (offsetInText <= 0) return lines[0]!.contentStartInSource;

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx]!;
      if (offsetInText >= line.strippedTextStart && offsetInText < line.strippedTextEnd) {
        const offsetInLine = offsetInText - line.strippedTextStart;
        if (offsetInLine <= line.contentLen) {
          return line.contentStartInSource + offsetInLine;
        } else {
          return line.contentEndInSource + (line.hasBreak ? line.breakLen : 0);
        }
      }
    }

    const lastLine = lines[lines.length - 1]!;
    return lastLine.contentEndInSource + (lastLine.hasBreak ? lastLine.breakLen : 0);
  }

  function mapTextEndToSource(offsetInText: number): number {
    if (lines.length === 0) return bqStart;
    if (offsetInText <= 0) return lines[0]!.contentStartInSource;

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx]!;
      if (offsetInText === line.strippedTextStart && idx > 0) {
        const prevLine = lines[idx - 1]!;
        return prevLine.contentEndInSource + (prevLine.hasBreak ? prevLine.breakLen : 0);
      }
      if (offsetInText >= line.strippedTextStart && offsetInText <= line.strippedTextEnd) {
        const offsetInLine = offsetInText - line.strippedTextStart;
        if (offsetInLine <= line.contentLen) {
          return line.contentStartInSource + offsetInLine;
        } else {
          return line.contentEndInSource + (line.hasBreak ? line.breakLen : 0);
        }
      }
    }

    const lastLine = lines[lines.length - 1]!;
    return lastLine.contentEndInSource + (lastLine.hasBreak ? lastLine.breakLen : 0);
  }

  return { lines, strippedText, mapTextStartToSource, mapTextEndToSource };
}

function remapNodeToSource(
  node: MarkdownBlockNode | MarkdownInlineNode | MarkdownListItem,
  source: string,
  mapStart: (offset: number) => number,
  mapEnd: (offset: number) => number
): void {
  node.range.from = mapStart(node.range.from);
  node.range.to = mapEnd(node.range.to);
  node.raw = source.slice(node.range.from, node.range.to);

  if ('value' in node && typeof node.value === 'string') {
    if (node.raw.includes('\r\n') && !node.value.includes('\r\n')) {
      node.value = node.value.replace(/\r?\n/g, '\r\n');
    }
  }
  if ('formula' in node && typeof node.formula === 'string') {
    if (node.raw.includes('\r\n') && !node.formula.includes('\r\n')) {
      node.formula = node.formula.replace(/\r?\n/g, '\r\n');
    }
  }

  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      remapNodeToSource(child as MarkdownBlockNode | MarkdownInlineNode | MarkdownListItem, source, mapStart, mapEnd);
    }
  }

  if ('items' in node && Array.isArray(node.items)) {
    for (const item of node.items) {
      remapNodeToSource(item, source, mapStart, mapEnd);
    }
  }

  if (node.type === 'table') {
    for (const headerRow of node.headers) {
      for (const cell of headerRow) {
        remapNodeToSource(cell, source, mapStart, mapEnd);
      }
    }
    for (const row of node.rows) {
      for (const cell of row) {
        for (const inline of cell) {
          remapNodeToSource(inline, source, mapStart, mapEnd);
        }
      }
    }
  }
}

function mapBlockquoteChildren(
  tokens: Token[],
  source: string,
  bqStart: number,
  bqEnd: number,
  diagnostics: MarkdownDiagnostic[]
): MarkdownBlockNode[] {
  const { strippedText, mapTextStartToSource, mapTextEndToSource } = buildBlockquoteLineMap(
    source,
    bqStart,
    bqEnd
  );

  const innerNodes = mapBlockTokens(tokens, strippedText, diagnostics, 0);

  for (const innerNode of innerNodes) {
    remapNodeToSource(innerNode, source, mapTextStartToSource, mapTextEndToSource);
  }

  return innerNodes;
}

/**
 * Maps marked block tokens into project AST block nodes with exact source ranges and raw text.
 */
function mapBlockTokens(
  tokens: Token[],
  source: string,
  diagnostics: MarkdownDiagnostic[],
  baseOffset = 0
): MarkdownBlockNode[] {
  const result: MarkdownBlockNode[] = [];
  let cur = baseOffset;

  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]!;
    if (token.type === 'space') {
      cur = matchTokenEndInSource(source, cur, token.raw);
      continue;
    }

    if (
      token.type === 'list' &&
      t + 1 < tokens.length &&
      tokens[t + 1]!.type === 'space' &&
      !tokens[t + 1]!.raw.startsWith('\n') &&
      !tokens[t + 1]!.raw.startsWith('\r')
    ) {
      const spaceToken = tokens[t + 1]!;
      token.raw += spaceToken.raw;
      const listToken = token as Tokens.List;
      if (listToken.items.length > 0) {
        const lastItem = listToken.items[listToken.items.length - 1]!;
        lastItem.raw += spaceToken.raw;
        lastItem.text += spaceToken.raw;
        if (lastItem.tokens && lastItem.tokens.length > 0) {
          const lastSub = lastItem.tokens[lastItem.tokens.length - 1]!;
          if (lastSub.type === 'text') {
            lastSub.raw += spaceToken.raw;
            lastSub.text += spaceToken.raw;
            if (lastSub.tokens && lastSub.tokens.length > 0) {
              const lastInner = lastSub.tokens[lastSub.tokens.length - 1]!;
              if (lastInner.type === 'text') {
                lastInner.raw += spaceToken.raw.replace(/\r?\n$/, '');
                lastInner.text += spaceToken.raw.replace(/\r?\n$/, '');
              }
            }
          }
        }
      }
      t++;
    }

    const tokenStart = cur;
    const tokenEnd = matchTokenEndInSource(source, tokenStart, token.raw);

    switch (token.type) {
      case 'heading': {
        const headingToken = token as Tokens.Heading;
        const depth = Math.min(Math.max(headingToken.depth, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6;
        const headingEnd = getHeadingLineEnd(source, tokenStart, tokenEnd);
        const range: SourceRange = { from: tokenStart, to: headingEnd };
        const raw = source.slice(tokenStart, headingEnd);

        // Calculate where the heading title text starts (skips leading whitespace and # markers)
        const prefixMatch = raw.match(/^\s*#{1,6}\s*/);
        const contentStart = tokenStart + (prefixMatch ? prefixMatch[0].length : 0);

        let contentEnd = headingEnd;
        while (contentEnd > contentStart && (source[contentEnd - 1] === '\n' || source[contentEnd - 1] === '\r')) {
          contentEnd--;
        }
        const closingMarkerMatch = source.slice(contentStart, contentEnd).match(/\s+#+\s*$/);
        if (closingMarkerMatch) {
          contentEnd -= closingMarkerMatch[0].length;
        }

        const headingContentRaw = source.slice(contentStart, contentEnd);

        const children = headingToken.tokens
          ? mapInlineTokens(headingToken.tokens, contentStart, source, diagnostics)
          : parseSpecialInlineSyntax(headingContentRaw, contentStart, source);

        result.push({
          type: 'heading',
          depth,
          children,
          range,
          raw
        });
        break;
      }
      case 'paragraph': {
        const pToken = token as Tokens.Paragraph;
        const trimmed = pToken.text.trim();
        const pEnd = trimTrailingBlankLines(source, tokenStart, tokenEnd);
        const range: SourceRange = { from: tokenStart, to: pEnd };
        const raw = source.slice(tokenStart, pEnd);

        // Standalone display math: $$...$$
        if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length >= 4) {
          const formula = trimmed.slice(2, -2).trim();
          result.push({
            type: 'block-math',
            formula,
            range,
            raw
          });
          break;
        }

        const children = pToken.tokens
          ? mapInlineTokens(pToken.tokens, tokenStart, source, diagnostics)
          : parseSpecialInlineSyntax(raw, tokenStart, source);

        result.push({
          type: 'paragraph',
          children,
          range,
          raw
        });
        break;
      }
      case 'blockquote': {
        const bqToken = token as Tokens.Blockquote;
        const bqEnd = trimTrailingBlankLines(source, tokenStart, tokenEnd);
        const range: SourceRange = { from: tokenStart, to: bqEnd };
        const raw = source.slice(tokenStart, bqEnd);

        const children = bqToken.tokens
          ? mapBlockquoteChildren(bqToken.tokens, source, tokenStart, bqEnd, diagnostics)
          : [];

        result.push({
          type: 'blockquote',
          children,
          range,
          raw
        });
        break;
      }
      case 'list': {
        const listToken = token as Tokens.List;
        const listNode = mapListToken(listToken, source, tokenStart, tokenEnd, diagnostics);
        result.push(listNode);
        break;
      }
      case 'code': {
        const codeToken = token as Tokens.Code;
        const range: SourceRange = { from: tokenStart, to: tokenEnd };
        const raw = source.slice(tokenStart, tokenEnd);

        result.push({
          type: 'code-block',
          language: codeToken.lang || undefined,
          value: codeToken.text,
          range,
          raw
        });
        break;
      }
      case 'table': {
        const tableToken = token as Tokens.Table;
        const tableEnd = trimTrailingBlankLines(source, tokenStart, tokenEnd);
        const range: SourceRange = { from: tokenStart, to: tableEnd };
        const raw = source.slice(tokenStart, tableEnd);

        // Parse cell boundaries inside table rows
        const lines = raw.split(/\r?\n/);
        let lineOffset = tokenStart;

        // Header cells
        let lineIdx = 0;
        let headerRowCells: { from: number; to: number }[] = [];
        if (lineIdx < lines.length) {
          const headerLineStr = lines[lineIdx];
          if (headerLineStr !== undefined) {
            headerRowCells = getRowCellRanges(headerLineStr, lineOffset);
            lineOffset = matchTokenEndInSource(source, lineOffset, headerLineStr + '\n');
            lineIdx++;
          }
        }

        // Delimiter line
        if (lineIdx < lines.length) {
          const delimLineStr = lines[lineIdx];
          if (delimLineStr !== undefined) {
            lineOffset = matchTokenEndInSource(source, lineOffset, delimLineStr + '\n');
            lineIdx++;
          }
        }

        const headers: MarkdownInlineNode[][] = tableToken.header.map((cell, hIdx) => {
          const cellLoc = headerRowCells[hIdx];
          const cellFrom = cellLoc ? cellLoc.from : tokenStart;
          const cellTo = cellLoc ? cellLoc.to : matchTokenEndInSource(source, cellFrom, cell.text);
          const cellRaw = source.slice(cellFrom, cellTo);
          return cell.tokens
            ? mapInlineTokens(cell.tokens, cellFrom, source, diagnostics)
            : parseSpecialInlineSyntax(cellRaw, cellFrom, source);
        });

        const rows: MarkdownInlineNode[][][] = tableToken.rows.map((row) => {
          let rowCells: { from: number; to: number }[] = [];
          if (lineIdx < lines.length) {
            const rowLineStr = lines[lineIdx];
            if (rowLineStr !== undefined) {
              rowCells = getRowCellRanges(rowLineStr, lineOffset);
              lineOffset = matchTokenEndInSource(source, lineOffset, rowLineStr + '\n');
              lineIdx++;
            }
          }

          return row.map((cell, cIdx) => {
            const cellLoc = rowCells[cIdx];
            const cellFrom = cellLoc ? cellLoc.from : tokenStart;
            const cellTo = cellLoc ? cellLoc.to : matchTokenEndInSource(source, cellFrom, cell.text);
            const cellRaw = source.slice(cellFrom, cellTo);
            return cell.tokens
              ? mapInlineTokens(cell.tokens, cellFrom, source, diagnostics)
              : parseSpecialInlineSyntax(cellRaw, cellFrom, source);
          });
        });

        result.push({
          type: 'table',
          headers,
          rows,
          align: tableToken.align,
          range,
          raw
        });
        break;
      }
      case 'html': {
        const htmlToken = token as Tokens.HTML;
        const range: SourceRange = { from: tokenStart, to: tokenEnd };
        const raw = source.slice(tokenStart, tokenEnd);

        result.push({
          type: 'raw',
          value: htmlToken.text,
          range,
          raw,
          opaque: true,
          block: true
        });
        break;
      }
      case 'hr': {
        const range: SourceRange = { from: tokenStart, to: tokenEnd };
        const raw = source.slice(tokenStart, tokenEnd);

        result.push({
          type: 'raw',
          value: raw.trim(),
          range,
          raw,
          opaque: true,
          block: true
        });
        break;
      }
      default: {
        const range: SourceRange = { from: tokenStart, to: tokenEnd };
        const raw = source.slice(tokenStart, tokenEnd);

        result.push({
          type: 'raw',
          value: 'raw' in token && typeof (token as { raw?: unknown }).raw === 'string'
            ? (token as { raw: string }).raw
            : raw,
          range,
          raw,
          opaque: true,
          block: true
        });
      }
    }

    cur = tokenEnd;
  }

  return result;
}

/**
 * Parses Markdown source text into an AST render model.
 * Always preserves raw source and generates diagnostics safely without throwing.
 */
export function parseMarkdown(source: string): MarkdownParseResult {
  if (!source || source.length === 0) {
    return {
      source,
      root: {
        type: 'root',
        children: [],
        range: { from: 0, to: 0 },
        raw: ''
      },
      diagnostics: []
    };
  }

  if (source.trim().length === 0) {
    return {
      source,
      root: {
        type: 'root',
        children: [],
        range: { from: 0, to: source.length },
        raw: source
      },
      diagnostics: []
    };
  }

  const diagnostics: MarkdownDiagnostic[] = [];

  try {
    const tokens = marked.lexer(source, {
      gfm: true,
      breaks: false
    });

    const rootChildren = mapBlockTokens(tokens, source, diagnostics, 0);

    return {
      source,
      root: {
        type: 'root',
        children: rootChildren,
        range: { from: 0, to: source.length },
        raw: source
      },
      diagnostics
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.push({
      severity: 'error',
      message: `Markdown parsing error: ${message}`
    });

    // Fallback gracefully to raw block
    return {
      source,
      root: {
        type: 'root',
        children: [
          {
            type: 'raw',
            value: source,
            range: { from: 0, to: source.length },
            raw: source,
            opaque: true
          }
        ],
        range: { from: 0, to: source.length },
        raw: source
      },
      diagnostics
    };
  }
}
