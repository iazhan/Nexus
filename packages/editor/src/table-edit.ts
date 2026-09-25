/**
 * 表格编辑能力的公共入口（门面）。
 *
 * 实现已按职责分层拆到 `table/` 下，本文件只做逐名 re-export，保持原导入路径不变：
 *
 * ```text
 * table/types.ts        类型契约（TableContext / TableCellContext / TableEditValue / TableEditTransaction / TableVerificationCriteria）
 * table/lookup.ts       表格与单元格的源码定位（parseTableContext / findTableAtPosition / splitTableLines / findTableCellAtPosition）+ 单元格文本提取
 * table/verify.ts       候选文本重解析后的语义校验（verifyCandidateTable）
 * table/transactions.ts 8 个表格编辑事务
 * ```
 *
 * 依赖方向单向：`types` ← `lookup` ← `verify` ← `transactions`。
 *
 * 刻意不用 `export *`：那会把模块内部的 `getCellVal` / `getRawTableLineCells`
 * 一并提升为公共 API。
 */

export {
  findTableCellAtPosition,
  findTableAtPosition,
  parseRowPipes,
  parseTableContext,
  splitTableLines
} from './table/lookup.js';

export { verifyCandidateTable } from './table/verify.js';
export type { TableVerificationCriteria } from './table/verify.js';

export {
  createTableAddColumnTransaction,
  createTableAddRowTransaction,
  createTableCellEditTransaction,
  createTableDeleteColumnTransaction,
  createTableDeleteRowTransaction,
  createTableDeleteTransaction,
  createTableResizeTransaction,
  createTableSetAlignTransaction
} from './table/transactions.js';

export type {
  TableCellContext,
  TableContext,
  TableEditTransaction,
  TableEditValue
} from './table/types.js';
