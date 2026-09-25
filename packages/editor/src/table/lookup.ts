import {
  getRowCellRanges,
  getUnescapedPipes,
  parseMarkdown,
  type MarkdownBlockNode,
  type MarkdownInlineNode
} from '@nexus/markdown';
import { walkBlockNodes } from '../ast-walker.js';
import type { TableCellContext, TableContext } from './types.js';

/**
 * 解析表格 AST 节点为 TableContext。
 */
export function parseTableContext(
  source: string,
  tableNode: Extract<MarkdownBlockNode, { type: 'table' }>
): TableContext {
  return {
    tableRange: { from: tableNode.range.from, to: tableNode.range.to },
    raw: tableNode.raw,
    source,
    headers: tableNode.headers,
    rows: tableNode.rows,
    align: tableNode.align
  };
}

/**
 * 解析行中的管道定界符与有效边界。
 */
export function parseRowPipes(lineText: string): {
  pipes: number[];
  hasLeadingPipe: boolean;
  hasTrailingPipe: boolean;
} {
  const pipes = getUnescapedPipes(lineText);
  const hasLeadingPipe =
    pipes.length > 0 && /^[ \t]*(?:>[ \t]*)*$/.test(lineText.slice(0, pipes[0]!));
  const hasTrailingPipe =
    pipes.length > 0 && /^[ \t]*$/.test(lineText.slice(pipes[pipes.length - 1]! + 1));
  return { pipes, hasLeadingPipe, hasTrailingPipe };
}

/**
 * 根据源码位置查找对应的 TableContext。
 * 严格使用 [from, to) 半开区间，表格末尾换行符与区间外部返回 null。
 */
export function findTableAtPosition(source: string, pos: number): TableContext | null {
  const { root } = parseMarkdown(source);
  let found: TableContext | null = null;
  walkBlockNodes(root.children, (child) => {
    if (child.type === 'table') {
      const rawTrimmed = child.raw.replace(/\r?\n$/, '');
      const contentEnd = child.range.from + rawTrimmed.length;
      if (pos >= child.range.from && pos < contentEnd) {
        found = parseTableContext(source, child);
        return true;
      }
    }
    return false;
  });
  return found;
}

/**
 * 将表格切分为行信息，包含每行的起始偏移与行文本。
 */
export function splitTableLines(
  raw: string,
  baseOffset: number
): { text: string; from: number; to: number; newline: string }[] {
  const lines: { text: string; from: number; to: number; newline: string }[] = [];
  let currentOffset = baseOffset;
  const regex = /\r?\n/g;
  let match: RegExpExecArray | null;
  let lastIdx = 0;

  while ((match = regex.exec(raw)) !== null) {
    const lineText = raw.slice(lastIdx, match.index);
    const nl = match[0];
    lines.push({
      text: lineText,
      from: currentOffset,
      to: currentOffset + lineText.length,
      newline: nl
    });
    currentOffset += lineText.length + nl.length;
    lastIdx = regex.lastIndex;
  }

  if (lastIdx < raw.length) {
    const lineText = raw.slice(lastIdx);
    lines.push({
      text: lineText,
      from: currentOffset,
      to: currentOffset + lineText.length,
      newline: ''
    });
  }

  return lines;
}

/**
 * 根据源码位置查找对应的 TableCellContext。
 * 严格遵循 [slotFrom, slotTo) 半开区间，处于定界竖线 '|' 或换行位置返回 null。
 */
export function findTableCellAtPosition(
  tableContext: TableContext,
  pos: number
): TableCellContext | null {
  const lines = splitTableLines(tableContext.raw, tableContext.tableRange.from);
  if (lines.length < 2) return null;

  function getRangesForLine(lineText: string, lineFrom: number): {
    from: number;
    to: number;
    slotStart: number;
    slotEnd: number;
  }[] {
    const match = lineText.match(/^([ \t]*(?:>[ \t]*)*)/);
    const prefixLen = match ? match[0]!.length : 0;
    const cleanText = lineText.slice(prefixLen);
    const ranges = getRowCellRanges(cleanText, lineFrom + prefixLen);
    return ranges.map((r) => ({
      from: r.from,
      to: r.to,
      slotStart: r.slotStart + prefixLen,
      slotEnd: r.slotEnd + prefixLen
    }));
  }

  // 1. 检查表头行（行 0）
  const headerLine = lines[0]!;
  if (pos >= headerLine.from && pos < headerLine.to) {
    const ranges = getRangesForLine(headerLine.text, headerLine.from);
    for (let c = 0; c < ranges.length; c++) {
      const r = ranges[c]!;
      const slotFrom = headerLine.from + r.slotStart;
      const slotTo = headerLine.from + r.slotEnd;
      if (pos >= slotFrom && pos < slotTo) {
        return {
          tableRange: tableContext.tableRange,
          cellRange: { from: r.from, to: r.to },
          slotRange: { from: slotFrom, to: slotTo },
          rowIndex: -1,
          colIndex: c,
          cellRaw: headerLine.text.slice(r.slotStart, r.slotEnd),
          tableContext
        };
      }
    }
  }

  // 行 1 为分隔线，跳过

  // 2. 检查数据行（行 2 及之后）
  for (let lineIdx = 2; lineIdx < lines.length; lineIdx++) {
    const rowLine = lines[lineIdx]!;
    if (pos >= rowLine.from && pos < rowLine.to) {
      const ranges = getRangesForLine(rowLine.text, rowLine.from);
      for (let c = 0; c < ranges.length; c++) {
        const r = ranges[c]!;
        const slotFrom = rowLine.from + r.slotStart;
        const slotTo = rowLine.from + r.slotEnd;
        if (pos >= slotFrom && pos < slotTo) {
          return {
            tableRange: tableContext.tableRange,
            cellRange: { from: r.from, to: r.to },
            slotRange: { from: slotFrom, to: slotTo },
            rowIndex: lineIdx - 2,
            colIndex: c,
            cellRaw: rowLine.text.slice(r.slotStart, r.slotEnd),
            tableContext
          };
        }
      }
    }
  }

  return null;
}

export function getCellVal(nodes?: MarkdownInlineNode[]): string {
  if (!nodes) return '';
  return nodes
    .map((n) =>
      typeof n.raw === 'string'
        ? n.raw
        : 'value' in n && typeof (n as { value?: unknown }).value === 'string'
          ? (n as { value: string }).value
          : ''
    )
    .join('')
    .replace(/\\\|/g, '|');
}

export function getRawTableLineCells(lineText: string): { prefix: string; cells: string[] } {
  const prefix = lineText.match(/^([ \t]*(?:>[ \t]*)*)/)?.[0] ?? '';
  const cleanText = lineText.slice(prefix.length);
  const ranges = getRowCellRanges(cleanText, 0);
  return {
    prefix,
    cells: ranges.map((range) => cleanText.slice(range.slotStart, range.slotEnd))
  };
}

