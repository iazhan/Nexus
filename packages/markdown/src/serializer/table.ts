/**
 * 表格序列化：从 AST 重建表格、只替换脏单元格、整表强制重建。
 */
import { getRowCellRanges } from '../parser.js';
import type { MarkdownBlockNode, MarkdownInlineNode } from '../types.js';
import { isCellDirty } from './dirty.js';
import { serializeInlines } from './inline.js';
import { escapeTableCellPipes, splitLinesWithBreaks } from './text-utils.js';

function reconstructTableFromAST(
  block: Extract<MarkdownBlockNode, { type: 'table' }>,
  source?: string,
  force = false
): string {
  const headerLine =
    '| ' +
    block.headers
      .map((h) => escapeTableCellPipes(serializeInlines(h, source, force)))
      .join(' | ') +
    ' |';
  const alignLine =
    '| ' +
    block.align
      .map((a) => {
        if (a === 'center') return ':---:';
        if (a === 'right') return '---:';
        if (a === 'left') return ':---';
        return '---';
      })
      .join(' | ') +
    ' |';
  const rowLines = block.rows.map(
    (r) =>
      '| ' +
      r
        .map((c) => escapeTableCellPipes(serializeInlines(c, source, force)))
        .join(' | ') +
      ' |'
  );
  return [headerLine, alignLine, ...rowLines].join('\n');
}

function replaceDirtyCellsInLine(
  lineText: string,
  ranges: { slotStart: number; slotEnd: number; from: number; to: number }[],
  cells: MarkdownInlineNode[][],
  source?: string,
  force = false
): string {
  interface Replacement {
    start: number;
    end: number;
    text: string;
  }
  const replacements: Replacement[] = [];

  for (let c = 0; c < cells.length; c++) {
    const cell = cells[c];
    if (cell && isCellDirty(cell, source)) {
      const cellRange = ranges[c];
      if (cellRange) {
        const forceCell =
          force ||
          (cell as { dirty?: boolean; modified?: boolean }).dirty === true ||
          (cell as { dirty?: boolean; modified?: boolean }).modified === true;
        const serialized = escapeTableCellPipes(serializeInlines(cell, source, forceCell));
        replacements.push({
          start: cellRange.from,
          end: cellRange.to,
          text: serialized
        });
      }
    }
  }

  replacements.sort((a, b) => b.start - a.start);
  let updated = lineText;
  for (const rep of replacements) {
    updated = updated.slice(0, rep.start) + rep.text + updated.slice(rep.end);
  }
  return updated;
}

export function serializeTable(
  block: Extract<MarkdownBlockNode, { type: 'table' }>,
  source?: string,
  force = false
): string {
  const rawText =
    typeof block.raw === 'string' && block.raw.length > 0
      ? block.raw
      : source && block.range
        ? source.slice(block.range.from, block.range.to)
        : '';

  if (force || rawText.length === 0) {
    return reconstructTableFromAST(block, source, force);
  }

  const lines = splitLinesWithBreaks(rawText);
  const expectedDataRows = block.rows.length;

  if (lines.length < 2 + expectedDataRows) {
    return reconstructTableFromAST(block, source, force);
  }

  const headerRanges = getRowCellRanges(lines[0]!.text);
  if (headerRanges.length !== block.headers.length) {
    return reconstructTableFromAST(block, source, force);
  }

  for (let r = 0; r < expectedDataRows; r++) {
    const rowRanges = getRowCellRanges(lines[2 + r]!.text);
    if (rowRanges.length !== block.rows[r]!.length) {
      return reconstructTableFromAST(block, source, force);
    }
  }

  let headerLineText = lines[0]!.text;
  if (block.headers.some((cell) => isCellDirty(cell, source))) {
    headerLineText = replaceDirtyCellsInLine(headerLineText, headerRanges, block.headers, source, force);
  }

  const separatorLineText = lines[1]!.text;

  const rowLinesText: string[] = [];
  for (let r = 0; r < expectedDataRows; r++) {
    let rowLineText = lines[2 + r]!.text;
    const rowCells = block.rows[r]!;
    if (rowCells.some((cell) => isCellDirty(cell, source))) {
      const rowRanges = getRowCellRanges(rowLineText);
      rowLineText = replaceDirtyCellsInLine(rowLineText, rowRanges, rowCells, source, force);
    }
    rowLinesText.push(rowLineText);
  }

  let result = '';
  result += headerLineText + lines[0]!.break;
  result += separatorLineText + lines[1]!.break;
  for (let r = 0; r < expectedDataRows; r++) {
    result += rowLinesText[r] + lines[2 + r]!.break;
  }
  for (let idx = 2 + expectedDataRows; idx < lines.length; idx++) {
    result += lines[idx]!.text + lines[idx]!.break;
  }

  return result;
}

