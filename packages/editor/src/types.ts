export type EditorSaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'error' | 'readonly' | 'external-changed' | 'deleted';

/** 编辑器 surface 的承载类型；两者都以 Markdown source 为文档内容。 */
export type EditorSurfaceKind = 'source' | 'visual';

/** 以 Markdown source UTF-16 code unit offset 表示的单一选区。 */
export interface MarkdownSelection {
  anchor: number;
  head: number;
}

/** 面向编辑器 session 的 source 变更。多个变更共享一个 undo step。 */
export interface MarkdownChange {
  from: number;
  to: number;
  insert: string;
}

/** 所有 Source/Visual 编辑入口统一提交的 source transaction。 */
export interface MarkdownEditTransaction {
  changes: MarkdownChange[];
  selection?: MarkdownSelection;
  beforeSelection?: MarkdownSelection;
  originSurfaceId?: string;
  userEvent?: string;
  annotations?: string[];
  addToHistory?: boolean;
}

/** session 对外发布的不可变文档快照。 */
export interface MarkdownDocumentSnapshot {
  source: string;
  revision: number;
  selection: MarkdownSelection;
}

/** session 订阅者接收的提交事件。 */
export type MarkdownSessionListener = (
  snapshot: MarkdownDocumentSnapshot,
  transaction?: MarkdownEditTransaction
) => void;

export interface EditorSelectionInfo {
  line: number;
  column: number;
  selectedTextLength: number;
}

export type MarkdownMarkerType =
  | 'inline-math'
  | 'block-math'
  | 'wikilink'
  | 'code-fence';

export interface MarkdownMarker {
  type: MarkdownMarkerType;
  from: number;
  to: number;
  text?: string;
  language?: string;
}

export interface SourceEditorConfig {
  doc?: string;
  readOnly?: boolean;
  includeHistory?: boolean;
  keybindings?: import('@codemirror/view').KeyBinding[];
  extensionHost?: import('./extensions.js').ExtensionHost;
  theme?: 'light' | 'dark';
  /** 行号槽。缺省视为开 —— 与这个设置项出现之前的行为一致。 */
  lineNumbers?: boolean;
  /** 拼写检查。缺省视为关 —— 与 CodeMirror 自己的默认一致。 */
  spellCheck?: boolean;
  onChange?: (value: string) => void;
  onSelectionChange?: (selection: EditorSelectionInfo) => void;
}

export interface CreateSourceEditorOptions extends SourceEditorConfig {
  parent: HTMLElement;
}
