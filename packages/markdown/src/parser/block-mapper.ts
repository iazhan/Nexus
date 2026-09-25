/**
 * 块级映射器。
 *
 * `mapBlockTokens` / `mapListToken` / `mapBlockquoteChildren` 三者**互相递归**
 * （引用块内部还要按块级规则映射，列表项里也可能嵌引用块），构成一个强连通分量，
 * 因此必须留在同一个模块里 —— 拆开会在 ESM 顶层形成循环依赖。
 */
import type { Token, Tokens } from 'marked';
import type {
  MarkdownBlockNode,
  MarkdownDiagnostic,
  MarkdownInlineNode,
  MarkdownListItem,
  SourceRange
} from '../types.js';
import { mapInlineTokens, parseSpecialInlineSyntax } from './inline.js';
import { findListItemsRanges } from './list-ranges.js';
import { buildBlockquoteLineMap, remapNodeToSource } from './blockquote.js';
import { mergeBlankSeparatedMathFences } from './math-fences.js';
import { getRowCellRanges, resolveTableBounds, splitTrailingTableLines } from './table-geometry.js';
import {
  getHeadingLineEnd,
  getItemContentStart,
  matchTokenEndInSource,
  trimTrailingBlankLines
} from './source-offsets.js';

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
              type: 'horizontal-rule',
              range: { from: blockStart, to: blockEnd },
              raw
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
export function mapBlockTokens(
  tokens: Token[],
  source: string,
  diagnostics: MarkdownDiagnostic[],
  baseOffset = 0
): MarkdownBlockNode[] {
  const result: MarkdownBlockNode[] = [];
  let cur = baseOffset;

  tokens = splitTrailingTableLines(tokens);
  tokens = mergeBlankSeparatedMathFences(tokens);

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
        // marked 会把表格后的非空行并入表格；这里按「数据行必须含 `|`」收紧边界。
        const bounds = resolveTableBounds(source, tokenStart, tokenEnd);
        const tableEnd = trimTrailingBlankLines(source, tokenStart, bounds.end);
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

        const rows: MarkdownInlineNode[][][] = tableToken.rows
          .slice(0, bounds.dataRowCount)
          .map((row) => {
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
              const cellTo = cellLoc
                ? cellLoc.to
                : matchTokenEndInSource(source, cellFrom, cell.text);
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
          type: 'horizontal-rule',
          range,
          raw
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

