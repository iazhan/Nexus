import {
  parseMarkdown,
  getRowCellRanges,
  getUnescapedPipes,
  escapeTableCellPipes,
  type MarkdownBlockNode,
  type MarkdownInlineNode,
  type SourceRange
} from '@nexus/markdown';
import type { MarkdownChange, MarkdownEditTransaction } from './types.js';
import { applyChangesToSource } from './document-session.js';
import { walkBlockNodes } from './ast-walker.js';

/**
 * 表格上下文，包含表格范围、源码、对齐方式以及表头与数据行节点。
 */
export interface TableContext {
  tableRange: SourceRange;
  raw: string;
  source: string;
  headers: MarkdownInlineNode[][];
  rows: MarkdownInlineNode[][][];
  align: ('left' | 'center' | 'right' | null)[];
}

/**
 * 表格单元格上下文，精准定位单元格在源码中的区间与行列位置。
 */
export interface TableCellContext {
  tableRange: SourceRange;
  cellRange: SourceRange;
  slotRange: SourceRange;
  rowIndex: number; // -1 表示表头行，0..N 表示数据行
  colIndex: number;
  cellRaw: string;
  tableContext: TableContext;
}

/**
 * 表格编辑操作类型与参数。
 */
export interface TableEditValue {
  kind: 'edit-cell' | 'add-row' | 'delete-row' | 'add-col' | 'delete-col' | 'set-align' | 'resize' | 'delete';
  rowIndex?: number;
  colIndex?: number;
  value?: string;
  align?: 'left' | 'center' | 'right' | null;
  targetRows?: number;
  targetCols?: number;
}

export type TableEditTransaction = MarkdownEditTransaction;

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

function getCellVal(nodes?: MarkdownInlineNode[]): string {
  if (!nodes) return '';
  return nodes
    .map((n) => ('value' in n && typeof (n as { value?: unknown }).value === 'string' ? (n as { value: string }).value : n.raw))
    .join('')
    .replace(/\\\|/g, '|');
}

function getRawTableLineCells(lineText: string): { prefix: string; cells: string[] } {
  const prefix = lineText.match(/^([ \t]*(?:>[ \t]*)*)/)?.[0] ?? '';
  const cleanText = lineText.slice(prefix.length);
  const ranges = getRowCellRanges(cleanText, 0);
  return {
    prefix,
    cells: ranges.map((range) => cleanText.slice(range.slotStart, range.slotEnd))
  };
}

export type TableVerificationCriteria =
  | { op: 'cell-edit'; rowIndex: number; colIndex: number; expectedValue: string; originalContext?: TableContext }
  | { op: 'add-row'; expectedRowCount: number; originalContext?: TableContext }
  | { op: 'delete-row'; expectedRowCount: number; originalContext?: TableContext }
  | { op: 'add-column'; expectedColCount: number; targetColIndex?: number; originalContext?: TableContext }
  | { op: 'delete-column'; expectedColCount: number; targetColIndex?: number; originalContext?: TableContext }
  | { op: 'set-align'; colIndex: number; expectedAlign: 'left' | 'center' | 'right' | null; originalContext?: TableContext }
  | { op: 'resize'; expectedRowCount: number; expectedColCount: number; originalContext?: TableContext };

/**
 * 校验候选 Markdown 文本重新解析后是否依然在对应位置形成合法表格，并按操作精确验证语义：
 * - cell edit：目标 cell 解码值准确，非目标 cell 严格保真；
 * - add/delete row：row count 精确 ±1，未删除行保真；
 * - add/delete column：header 和所有 row 列数符合预期，严格校验 delimiter row，短行与超长行单元格严格保留；
 * - set align：目标 alignment 精确匹配。
 */
export function verifyCandidateTable(
  candidateSource: string,
  expectedFrom: number,
  criteria?: TableVerificationCriteria
): boolean {
  const { root } = parseMarkdown(candidateSource);
  let found = false;
  walkBlockNodes(root.children, (child) => {
    if (child.type === 'table' && child.range.from === expectedFrom) {
      // 1. 严格校验 delimiter row 依然合法有效且与表头列数一致
      if (child.align.length !== child.headers.length) {
        return false;
      }
      const lines = splitTableLines(child.raw, child.range.from);
      if (lines.length < 2) return false;
      const delimLine = lines[1]!.text;
      const prefixMatch = delimLine.match(/^([ \t]*(?:>[ \t]*)*)/);
      const prefixLen = prefixMatch ? prefixMatch[0]!.length : 0;
      const cleanDelim = delimLine.slice(prefixLen);
      const delimCells = getRowCellRanges(cleanDelim, 0).map((r) => cleanDelim.slice(r.from, r.to).trim());
      if (delimCells.length !== child.headers.length) return false;
      for (const dc of delimCells) {
        if (!/^:?-+:?$/.test(dc)) return false;
      }

      if (criteria) {
        const decode = (s: string) => s.replace(/\\\|/g, '|').trim();
        switch (criteria.op) {
          case 'cell-edit': {
            if (criteria.rowIndex === -1) {
              const cell = child.headers[criteria.colIndex];
              if (!cell) return false;
              if (decode(getCellVal(cell)) !== decode(criteria.expectedValue)) return false;
            } else {
              const row = child.rows[criteria.rowIndex];
              if (!row) return false;
              const cell = row[criteria.colIndex];
              if (!cell) return false;
              if (decode(getCellVal(cell)) !== decode(criteria.expectedValue)) return false;
            }

            if (criteria.originalContext) {
              const orig = criteria.originalContext;
              if (criteria.rowIndex === -1) {
                for (let c = 0; c < orig.headers.length; c++) {
                  if (c !== criteria.colIndex) {
                    if (decode(getCellVal(child.headers[c])) !== decode(getCellVal(orig.headers[c]))) return false;
                  }
                }
              } else {
                for (let c = 0; c < orig.headers.length; c++) {
                  if (decode(getCellVal(child.headers[c])) !== decode(getCellVal(orig.headers[c]))) return false;
                }
                for (let r = 0; r < orig.rows.length; r++) {
                  const origRow = orig.rows[r] ?? [];
                  const newRow = child.rows[r] ?? [];
                  if (r !== criteria.rowIndex) {
                    if (origRow.length !== newRow.length) return false;
                    for (let c = 0; c < origRow.length; c++) {
                      if (decode(getCellVal(newRow[c])) !== decode(getCellVal(origRow[c]))) return false;
                    }
                  } else {
                    if (origRow.length !== newRow.length) return false;
                    for (let c = 0; c < origRow.length; c++) {
                      if (c !== criteria.colIndex) {
                        if (decode(getCellVal(newRow[c])) !== decode(getCellVal(origRow[c]))) return false;
                      }
                    }
                  }
                }
              }
            }
            break;
          }
          case 'add-row':
          case 'delete-row': {
            if (child.rows.length !== criteria.expectedRowCount) return false;
            break;
          }
          case 'add-column': {
            if (child.headers.length !== criteria.expectedColCount) return false;
            if (child.align.length !== criteria.expectedColCount) return false;
            if (criteria.originalContext) {
              const originalLines = splitTableLines(
                criteria.originalContext.raw,
                criteria.originalContext.tableRange.from
              );
              const candidateLines = splitTableLines(child.raw, child.range.from);
              const targetCol = criteria.targetColIndex ?? criteria.originalContext.headers.length;
              if (candidateLines.length !== originalLines.length) return false;

              for (let i = 0; i < originalLines.length; i++) {
                const original = getRawTableLineCells(originalLines[i]!.text);
                const candidate = getRawTableLineCells(candidateLines[i]!.text);
                if (original.prefix !== candidate.prefix) return false;
                if (candidate.cells.length !== original.cells.length + 1) return false;

                for (let c = 0; c < original.cells.length; c++) {
                  const candidateIndex = c < targetCol ? c : c + 1;
                  if (candidate.cells[candidateIndex] !== original.cells[c]) return false;
                }
              }
            }
            break;
          }
          case 'delete-column': {
            if (child.headers.length !== criteria.expectedColCount) return false;
            if (child.align.length !== criteria.expectedColCount) return false;

            if (criteria.originalContext) {
              const orig = criteria.originalContext;
              const targetCol = criteria.targetColIndex ?? orig.headers.length - 1;

              // Check header non-target cells
              for (let c = 0; c < child.headers.length; c++) {
                const origC = c >= targetCol ? c + 1 : c;
                if (decode(getCellVal(child.headers[c])) !== decode(getCellVal(orig.headers[origC]))) return false;
              }

              // Check raw line cells to strictly preserve short rows and extra-long rows
              const origLines = splitTableLines(orig.raw, orig.tableRange.from);
              const newLines = splitTableLines(child.raw, child.range.from);
              if (newLines.length !== origLines.length) return false;

              for (let i = 2; i < origLines.length; i++) {
                const origLineText = origLines[i]!.text;
                const newLineText = newLines[i]!.text;

                const origPref = origLineText.match(/^([ \t]*(?:>[ \t]*)*)/)?.[0] ?? '';
                const newPref = newLineText.match(/^([ \t]*(?:>[ \t]*)*)/)?.[0] ?? '';
                const cleanOrig = origLineText.slice(origPref.length);
                const cleanNew = newLineText.slice(newPref.length);

                const origCellRanges = getRowCellRanges(cleanOrig, 0);
                const newCellRanges = getRowCellRanges(cleanNew, 0);

                const origCells = origCellRanges.map((r) => decode(cleanOrig.slice(r.from, r.to)));
                const newCells = newCellRanges.map((r) => decode(cleanNew.slice(r.from, r.to)));

                if (origCells.length <= targetCol) {
                  // Short row: target column was beyond row's cell count, all cells must be preserved
                  if (newCells.length !== origCells.length) return false;
                  for (let c = 0; c < origCells.length; c++) {
                    if (newCells[c] !== origCells[c]) return false;
                  }
                } else {
                  // Row had target column (normal or extra-long):
                  if (origCells.length === 1 && newCells.length === 1 && newCells[0] === '') {
                    // Valid empty row in single-column table
                  } else {
                    if (newCells.length !== origCells.length - 1) return false;
                    for (let c = 0; c < newCells.length; c++) {
                      const origC = c >= targetCol ? c + 1 : c;
                      if (newCells[c] !== origCells[origC]) return false;
                    }
                  }
                }
              }
            }
            break;
          }
          case 'set-align': {
            if (child.align[criteria.colIndex] !== criteria.expectedAlign) return false;
            break;
          }
          case 'resize': {
            if (child.rows.length !== criteria.expectedRowCount) return false;
            if (child.headers.length !== criteria.expectedColCount) return false;
            if (child.align.length !== criteria.expectedColCount) return false;
            if (criteria.originalContext) {
              const orig = criteria.originalContext;
              const minCols = Math.min(orig.headers.length, criteria.expectedColCount);
              for (let c = 0; c < minCols; c++) {
                if (decode(getCellVal(child.headers[c])) !== decode(getCellVal(orig.headers[c]))) return false;
              }
              const minRows = Math.min(orig.rows.length, criteria.expectedRowCount);
              for (let r = 0; r < minRows; r++) {
                const origRow = orig.rows[r] ?? [];
                const childRow = child.rows[r] ?? [];
                for (let c = 0; c < minCols; c++) {
                  if (c < origRow.length && c < childRow.length) {
                    if (decode(getCellVal(childRow[c])) !== decode(getCellVal(origRow[c]))) return false;
                  }
                }
              }
            }
            break;
          }
        }
      }
      found = true;
      return true;
    }
    return false;
  });
  return found;
}

/**
 * 创建单元格文本编辑事务。
 * 单元格值包含 raw 换行符（\r 或 \n）时明确拒绝，防止破坏表格行结构。
 */
export function createTableCellEditTransaction(
  source: string,
  context: TableCellContext,
  newValue: string
): TableEditTransaction | null {
  if (newValue.includes('\r') || newValue.includes('\n')) return null;
  if (source !== context.tableContext.source) return null;
  const { from, to } = context.cellRange;
  if (from < context.tableRange.from || to > context.tableRange.to) return null;

  const escaped = escapeTableCellPipes(newValue);
  const candidate = source.slice(0, from) + escaped + source.slice(to);

  if (
    !verifyCandidateTable(candidate, context.tableRange.from, {
      op: 'cell-edit',
      rowIndex: context.rowIndex,
      colIndex: context.colIndex,
      expectedValue: newValue,
      originalContext: context.tableContext
    })
  ) {
    return null;
  }

  return {
    changes: [{ from, to, insert: escaped }],
    userEvent: 'table.cell-edit'
  };
}


/**
 * 创建在指定行位置添加新行的事务。
 */
export function createTableAddRowTransaction(
  source: string,
  context: TableContext,
  atRowIndex?: number
): TableEditTransaction | null {
  if (source !== context.source) return null;
  if (source.slice(context.tableRange.from, context.tableRange.to) !== context.raw) {
    return null;
  }

  const isCRLF = context.raw.includes('\r\n');
  const newline = isCRLF ? '\r\n' : '\n';

  const lines = splitTableLines(context.raw, context.tableRange.from);
  if (lines.length < 2) return null;

  const indentMatch = lines[0]!.text.match(/^([ \t]*(?:>[ \t]*)*)/);
  const linePrefix = indentMatch ? (indentMatch[1] ?? '') : '';

  const colCount = context.headers.length;
  const newRowText = `${linePrefix}| ${Array(colCount).fill(' ').join(' | ')} |`;

  let insertOffset: number;
  let insertContent: string;

  if (atRowIndex === undefined || atRowIndex >= context.rows.length) {
    const lastLine = lines[lines.length - 1]!;
    if (lastLine.newline.length > 0) {
      insertOffset = lastLine.to + lastLine.newline.length;
      insertContent = `${newRowText}${newline}`;
    } else {
      insertOffset = lastLine.to;
      insertContent = `${newline}${newRowText}`;
    }
  } else {
    const targetLine = lines[2 + Math.max(0, atRowIndex)]!;
    insertOffset = targetLine.from;
    insertContent = `${newRowText}${newline}`;
  }

  const candidate =
    source.slice(0, insertOffset) +
    insertContent +
    source.slice(insertOffset);

  if (
    !verifyCandidateTable(candidate, context.tableRange.from, {
      op: 'add-row',
      expectedRowCount: context.rows.length + 1
    })
  ) {
    return null;
  }

  return {
    changes: [{ from: insertOffset, to: insertOffset, insert: insertContent }],
    userEvent: 'table.add-row'
  };
}

/**
 * 创建删除指定数据行的事务。
 */
export function createTableDeleteRowTransaction(
  source: string,
  context: TableContext,
  rowIndex: number
): TableEditTransaction | null {
  if (source !== context.source) return null;
  if (source.slice(context.tableRange.from, context.tableRange.to) !== context.raw) {
    return null;
  }
  if (rowIndex < 0 || rowIndex >= context.rows.length) {
    return null;
  }

  const lines = splitTableLines(context.raw, context.tableRange.from);
  if (lines.length <= 2) return null; // 仅有表头和分隔行，无数据行可删

  const targetLineIdx = 2 + rowIndex;
  if (targetLineIdx >= lines.length) return null;

  const targetLine = lines[targetLineIdx]!;
  let deleteFrom: number;
  let deleteTo: number;

  if (targetLineIdx === lines.length - 1 && targetLine.newline === '' && targetLineIdx > 0) {
    const prevLine = lines[targetLineIdx - 1]!;
    deleteFrom = prevLine.to;
    deleteTo = targetLine.to;
  } else {
    deleteFrom = targetLine.from;
    deleteTo = targetLine.to + targetLine.newline.length;
  }

  const candidate =
    source.slice(0, deleteFrom) +
    source.slice(deleteTo);

  if (
    !verifyCandidateTable(candidate, context.tableRange.from, {
      op: 'delete-row',
      expectedRowCount: context.rows.length - 1
    })
  ) {
    return null;
  }

  return {
    changes: [{ from: deleteFrom, to: deleteTo, insert: '' }],
    userEvent: 'table.delete-row'
  };
}

/**
 * 创建添加新列的事务。
 * 对每行独立做局部插入，严格保留非目标列空格、转义管道与多层引用前缀。
 */
export function createTableAddColumnTransaction(
  source: string,
  context: TableContext,
  atColIndex?: number
): TableEditTransaction | null {
  if (source !== context.source) return null;
  if (source.slice(context.tableRange.from, context.tableRange.to) !== context.raw) {
    return null;
  }

  const lines = splitTableLines(context.raw, context.tableRange.from);
  if (lines.length < 2) return null;

  const curColCount = context.headers.length;
  const colIdx =
    atColIndex === undefined || atColIndex >= curColCount ? curColCount : Math.max(0, atColIndex);

  const changes: MarkdownChange[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isDelimRow = i === 1;
    const { pipes, hasLeadingPipe, hasTrailingPipe } = parseRowPipes(line.text);

    if (pipes.length === 0) continue;

    let insertOffset: number;
    let insertText: string;

    if (colIdx === 0) {
      if (hasLeadingPipe) {
        insertOffset = line.from + pipes[0]! + 1;
        insertText = isDelimRow ? ' --- |' : '   |';
      } else {
        const prefixMatch = line.text.match(/^([ \t]*(?:>[ \t]*)*)/);
        const prefixLen = prefixMatch ? prefixMatch[0]!.length : 0;
        insertOffset = line.from + prefixLen;
        insertText = isDelimRow ? '--- | ' : '   | ';
      }
    } else if (colIdx >= curColCount) {
      if (hasTrailingPipe) {
        insertOffset = line.from + pipes[pipes.length - 1]! + 1;
        insertText = isDelimRow ? ' --- |' : '   |';
      } else {
        insertOffset = line.to;
        insertText = isDelimRow ? ' | ---' : ' |   ';
      }
    } else {
      const targetPipeIdx = hasLeadingPipe ? colIdx : colIdx - 1;
      if (targetPipeIdx < pipes.length) {
        insertOffset = line.from + pipes[targetPipeIdx]! + 1;
        insertText = isDelimRow ? ' --- |' : '   |';
      } else {
        insertOffset = line.to;
        insertText = isDelimRow ? ' | ---' : ' |   ';
      }
    }

    changes.push({ from: insertOffset, to: insertOffset, insert: insertText });
  }

  changes.sort((a, b) => a.from - b.from);

  const candidate = applyChangesToSource(source, changes);
  if (
    !verifyCandidateTable(candidate, context.tableRange.from, {
      op: 'add-column',
      expectedColCount: curColCount + 1,
      targetColIndex: colIdx,
      originalContext: context
    })
  ) {
    return null;
  }

  return {
    changes,
    userEvent: 'table.add-column'
  };
}

/**
 * 创建删除指定列的事务。
 * 支持 A | B、| A | B、A | B |、| A | B | 四种 pipe 风格下删除首列、末列和中间列。
 * 覆盖单个内部 pipe、ragged rows、转义 \|、CRLF 和多层引用前缀。
 */
export function createTableDeleteColumnTransaction(
  source: string,
  context: TableContext,
  colIndex: number
): TableEditTransaction | null {
  if (source !== context.source) return null;
  if (source.slice(context.tableRange.from, context.tableRange.to) !== context.raw) {
    return null;
  }
  // 最少保留 1 列
  if (context.headers.length <= 1) return null;
  if (colIndex < 0 || colIndex >= context.headers.length) return null;

  const lines = splitTableLines(context.raw, context.tableRange.from);
  if (lines.length < 2) return null;

  const changes: MarkdownChange[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const prefixMatch = line.text.match(/^([ \t]*(?:>[ \t]*)*)/);
    const prefixLen = prefixMatch ? prefixMatch[0]!.length : 0;
    const cleanText = line.text.slice(prefixLen);
    const { pipes, hasLeadingPipe, hasTrailingPipe } = parseRowPipes(line.text);
    const cellRanges = getRowCellRanges(cleanText, 0);

    // 短行：若本行单元格数量 <= colIndex，则本行不包含要删除的列，保持本行原有内容不变
    if (colIndex >= cellRanges.length) {
      continue;
    }

    let delFrom: number;
    let delTo: number;

    if (hasLeadingPipe) {
      if (colIndex === 0) {
        if (pipes.length > 1) {
          delFrom = line.from + pipes[0]! + 1;
          delTo = line.from + pipes[1]! + 1;
        } else {
          delFrom = line.from + prefixLen;
          delTo = line.to;
        }
      } else {
        const pipeBeforeIdx = colIndex;
        const pipeAfterIdx = colIndex + 1;
        if (pipeBeforeIdx < pipes.length && pipeAfterIdx < pipes.length) {
          delFrom = line.from + pipes[pipeBeforeIdx]!;
          delTo = line.from + pipes[pipeAfterIdx]!;
        } else if (pipeBeforeIdx < pipes.length) {
          delFrom = line.from + pipes[pipeBeforeIdx]!;
          delTo = line.to;
        } else {
          continue;
        }
      }
    } else {
      // !hasLeadingPipe
      if (colIndex === 0) {
        if (pipes.length > 1) {
          delFrom = line.from + prefixLen;
          delTo = line.from + pipes[0]! + 1;
        } else {
          // pipes.length === 1 (whether trailing pipe or internal pipe)
          // 保留唯一的 pipe 作为有效 pipe，防止表格行结构损坏或退化为 Setext heading
          delFrom = line.from + prefixLen;
          delTo = line.from + pipes[0]!;
        }
      } else {
        const pipeBeforeIdx = colIndex - 1;
        const pipeAfterIdx = colIndex;
        if (pipeBeforeIdx >= 0 && pipeBeforeIdx < pipes.length && pipeAfterIdx < pipes.length) {
          delFrom = line.from + pipes[pipeBeforeIdx]!;
          delTo = line.from + pipes[pipeAfterIdx]!;
        } else if (pipeBeforeIdx >= 0 && pipeBeforeIdx < pipes.length) {
          if (pipes.length === 1 && !hasTrailingPipe) {
            delFrom = line.from + pipes[0]! + 1;
            delTo = line.to;
          } else {
            delFrom = line.from + pipes[pipeBeforeIdx]!;
            delTo = line.to;
          }
        } else {
          continue;
        }
      }
    }

    changes.push({ from: delFrom, to: delTo, insert: '' });
  }

  changes.sort((a, b) => a.from - b.from);

  const candidate = applyChangesToSource(source, changes);
  if (
    !verifyCandidateTable(candidate, context.tableRange.from, {
      op: 'delete-column',
      expectedColCount: context.headers.length - 1,
      targetColIndex: colIndex,
      originalContext: context
    })
  ) {
    return null;
  }

  return {
    changes,
    userEvent: 'table.delete-column'
  };
}

/**
 * 创建设置列对齐方式的事务。
 */
export function createTableSetAlignTransaction(
  source: string,
  context: TableContext,
  colIndex: number,
  align: 'left' | 'center' | 'right' | null
): TableEditTransaction | null {
  if (source !== context.source) return null;
  if (source.slice(context.tableRange.from, context.tableRange.to) !== context.raw) {
    return null;
  }
  if (colIndex < 0 || colIndex >= context.headers.length) return null;

  const lines = splitTableLines(context.raw, context.tableRange.from);
  if (lines.length < 2) return null;

  const delimLine = lines[1]!;
  const { pipes, hasLeadingPipe } = parseRowPipes(delimLine.text);

  let targetFrom: number;
  let targetTo: number;

  const leftPipeIdx = hasLeadingPipe ? colIndex : colIndex - 1;
  const rightPipeIdx = hasLeadingPipe ? colIndex + 1 : colIndex;

  if (leftPipeIdx >= 0 && rightPipeIdx < pipes.length) {
    const leftPipe = pipes[leftPipeIdx]!;
    const rightPipe = pipes[rightPipeIdx]!;
    const segment = delimLine.text.slice(leftPipe + 1, rightPipe);
    const leadMatch = segment.match(/^[ \t]*/);
    const trailMatch = segment.match(/[ \t]*$/);
    const leadLen = leadMatch ? leadMatch[0]!.length : 0;
    const trailLen = trailMatch ? trailMatch[0]!.length : 0;
    targetFrom = delimLine.from + leftPipe + 1 + leadLen;
    targetTo = Math.max(targetFrom, delimLine.from + rightPipe - trailLen);
  } else {
    const delimRanges = getRowCellRanges(delimLine.text, delimLine.from);
    if (colIndex >= delimRanges.length) return null;
    const targetCell = delimRanges[colIndex]!;
    targetFrom = targetCell.from;
    targetTo = targetCell.to;
  }

  let marker = '---';
  if (align === 'center') marker = ':---:';
  else if (align === 'right') marker = '---:';
  else if (align === 'left') marker = ':---';

  const candidate =
    source.slice(0, targetFrom) +
    marker +
    source.slice(targetTo);

  if (
    !verifyCandidateTable(candidate, context.tableRange.from, {
      op: 'set-align',
      colIndex,
      expectedAlign: align
    })
  ) {
    return null;
  }

  return {
    changes: [{ from: targetFrom, to: targetTo, insert: marker }],
    userEvent: 'table.set-align'
  };
}

/**
 * 创建删除整张表格的事务。
 * 清除表格的所有源码行（含尾随换行符）。
 */
export function createTableDeleteTransaction(
  source: string,
  context: TableContext
): TableEditTransaction | null {
  if (source !== context.source) return null;
  if (source.slice(context.tableRange.from, context.tableRange.to) !== context.raw) {
    return null;
  }

  const delFrom = context.tableRange.from;
  const delTo = context.tableRange.to;

  const changes: MarkdownChange[] = [{ from: delFrom, to: delTo, insert: '' }];
  const candidate = applyChangesToSource(source, changes);

  // 校验：表格已被完全移除，且剩余文本能被正常解析
  const { root } = parseMarkdown(candidate);
  let tableStillExists = false;
  walkBlockNodes(root.children, (child) => {
    if (child.type === 'table' && child.range.from === delFrom && child.raw === context.raw) {
      tableStillExists = true;
      return true;
    }
    return false;
  });
  if (tableStillExists) return null;

  return {
    changes,
    userEvent: 'table.delete'
  };
}

/**
 * 创建调整表格尺寸（行列数）的事务。
 * targetRows 表示总行数（含表头，即 1 行表头 + (targetRows - 1) 行数据行，最小为 1）。
 * targetCols 表示总列数（最小为 1）。
 * 调整时保留原有重叠区域单元格的文本内容与对齐设置。
 */
export function createTableResizeTransaction(
  source: string,
  context: TableContext,
  targetRows: number,
  targetCols: number
): TableEditTransaction | null {
  if (source !== context.source) return null;
  if (source.slice(context.tableRange.from, context.tableRange.to) !== context.raw) {
    return null;
  }
  if (targetRows < 1 || targetCols < 1) return null;

  const targetDataRows = targetRows - 1;
  const curCols = context.headers.length;
  const curDataRows = context.rows.length;

  if (targetDataRows === curDataRows && targetCols === curCols) {
    return null;
  }

  const lines = splitTableLines(context.raw, context.tableRange.from);
  if (lines.length < 2) return null;

  const prefixMatch = lines[0]!.text.match(/^([ \t]*(?:>[ \t]*)*)/);
  const quotePrefix = prefixMatch ? prefixMatch[0]! : '';

  const origHeaderCells = getRawTableLineCells(lines[0]!.text).cells;

  // 1. 构建新表头行
  const newHeaderCells: string[] = [];
  for (let c = 0; c < targetCols; c++) {
    if (c < origHeaderCells.length) {
      const orig = origHeaderCells[c]!;
      newHeaderCells.push(orig.trim() ? ` ${orig.trim()} ` : '   ');
    } else {
      newHeaderCells.push('   ');
    }
  }
  const newHeaderLine = `${quotePrefix}|${newHeaderCells.join('|')}|`;

  // 2. 构建新分隔行
  const newDelimCells: string[] = [];
  for (let c = 0; c < targetCols; c++) {
    const align = c < context.align.length ? context.align[c] : null;
    if (align === 'center') newDelimCells.push(' :---: ');
    else if (align === 'right') newDelimCells.push(' ---: ');
    else if (align === 'left') newDelimCells.push(' :--- ');
    else newDelimCells.push(' --- ');
  }
  const newDelimLine = `${quotePrefix}|${newDelimCells.join('|')}|`;

  // 3. 构建新数据行
  const newDataLines: string[] = [];
  for (let r = 0; r < targetDataRows; r++) {
    const rowCells: string[] = [];
    if (r < curDataRows && 2 + r < lines.length) {
      const origRowCells = getRawTableLineCells(lines[2 + r]!.text).cells;
      for (let c = 0; c < targetCols; c++) {
        if (c < origRowCells.length) {
          const orig = origRowCells[c]!;
          rowCells.push(orig.trim() ? ` ${orig.trim()} ` : '   ');
        } else {
          rowCells.push('   ');
        }
      }
    } else {
      for (let c = 0; c < targetCols; c++) {
        rowCells.push('   ');
      }
    }
    newDataLines.push(`${quotePrefix}|${rowCells.join('|')}|`);
  }

  const newline = context.raw.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNl = context.raw.endsWith('\n');
  const allLines = [newHeaderLine, newDelimLine, ...newDataLines];
  const newTableRaw = allLines.join(newline) + (hasTrailingNl ? newline : '');

  const changes: MarkdownChange[] = [
    { from: context.tableRange.from, to: context.tableRange.to, insert: newTableRaw }
  ];

  const candidate = applyChangesToSource(source, changes);
  if (
    !verifyCandidateTable(candidate, context.tableRange.from, {
      op: 'resize',
      expectedRowCount: targetDataRows,
      expectedColCount: targetCols,
      originalContext: context
    })
  ) {
    return null;
  }

  return {
    changes,
    userEvent: 'table.resize'
  };
}
