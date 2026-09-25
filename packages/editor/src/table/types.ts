import type { MarkdownInlineNode, SourceRange } from '@nexus/markdown';
import type { MarkdownEditTransaction } from '../types.js';

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

