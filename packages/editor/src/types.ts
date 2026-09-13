export type EditorSaveState = 'dirty' | 'saving' | 'saved' | 'error';

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
}

export interface SourceEditorConfig {
  doc?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onSelectionChange?: (selection: EditorSelectionInfo) => void;
}

export interface CreateSourceEditorOptions extends SourceEditorConfig {
  parent: HTMLElement;
}
