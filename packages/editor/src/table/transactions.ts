import { escapeTableCellPipes, getRowCellRanges, parseMarkdown } from '@nexus/markdown';
import { applyChangesToSource } from '../document-session.js';
import { walkBlockNodes } from '../ast-walker.js';
import type { MarkdownChange } from '../types.js';
import { getRawTableLineCells, parseRowPipes, splitTableLines } from './lookup.js';
import { verifyCandidateTable } from './verify.js';
import type { TableCellContext, TableContext, TableEditTransaction } from './types.js';

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
