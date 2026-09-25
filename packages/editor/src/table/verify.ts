import { getRowCellRanges, parseMarkdown } from '@nexus/markdown';
import { walkBlockNodes } from '../ast-walker.js';
import { getCellVal, getRawTableLineCells, splitTableLines } from './lookup.js';
import type { TableContext } from './types.js';

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

