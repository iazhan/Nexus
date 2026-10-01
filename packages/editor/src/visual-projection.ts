/**
 * Visual surface 投影的公共入口（门面）。
 *
 * 实现按四层拆在 `./visual/` 下，依赖方向严格单向：
 *
 * ```text
 * widgets/*  →  state / source-analysis / sub-editor  →  projection  →  projection-field
 * ```
 *
 * 本文件只做 re-export，逐名列出，保证 `@nexus/editor` 的公共 API 与拆分前完全一致
 * （不用 `export *`，否则会把模块内部的辅助函数一起抬成公共 API）。
 *
 * **分层规则（破环的后果不是编译错）**：widget 不得 import `projection.js`，
 * `state.js` / `sub-editor.js` 不得 import 任何 widget。ESM 循环在顶层求值
 * （`class extends WidgetType`、SVG 常量）时会静默拿到 `undefined`，只在运行时炸。
 */

export {
  setVisualFocusEffect,
  visualFocusField,
  visualFocusPlugin,
  setDocumentDirectoryEffect,
  documentDirectoryField,
  setDocumentDirectory,
  setTableTargetEffect,
  tableTargetField,
  DEFAULT_MERMAID_PREVIEW_SETTINGS,
  mermaidPreviewSettingsFacet,
  mermaidPreviewCompartment,
  setMermaidPreviewSettings,
  setMermaidPreviewPinEffect,
  mermaidPreviewPinField,
  setHoveredCodeBlockEffect,
  hoveredCodeBlockField,
  EMPTY_WORKSPACE_ASSETS,
  setWorkspaceAssetsEffect,
  workspaceAssetsField,
  setWorkspaceAssets
} from './visual/state.js';
export type {
  TableTarget,
  MermaidPreviewPin,
  MermaidPreviewSettings,
  WorkspaceAssetEntry
} from './visual/state.js';

export {
  resolveDocumentAssetUrl,
  resolveWikiEmbedAssetUrl
} from './visual/source-analysis.js';

export {
  DelimiterWidget,
  HiddenDelimiterWidget,
  HorizontalRuleWidget,
  TaskCheckboxWidget,
  ListMarkerWidget
} from './visual/widgets/inline.js';

export {
  renderTableCellNodes,
  serializeTableCellDOM,
  populateTableCellDOM
} from './visual/widgets/table.js';

export { TableBlockWidget } from './visual/widgets/table-block.js';

export {
  CodeBlockHeaderWidget,
  CodeBlockExitWidget,
  CodeBlockWidget
} from './visual/widgets/code-block.js';

export { BlockMathPreviewWidget, BlockMathWidget } from './visual/widgets/math.js';

export { RawBlockWidget } from './visual/widgets/raw.js';

export { buildVisualProjection } from './visual/projection.js';

export {
  visualProjectionField,
  tableWidgetSyncPlugin,
  codeBlockHoverPlugin,
  visualProjectionExtensions
} from './visual/projection-field.js';
