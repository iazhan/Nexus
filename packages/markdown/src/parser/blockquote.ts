/**
 * 引用块的行映射：建立「去掉 `>` 前缀后的文本」与原文之间的双向偏移映射，
 * 并把映射结果套用到映射出来的子节点上。
 */
import type { MarkdownBlockNode, MarkdownInlineNode, MarkdownListItem } from '../types.js';

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

export function buildBlockquoteLineMap(
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

export function remapNodeToSource(
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

