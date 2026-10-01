import type { EditorState } from '@codemirror/state';
import type { EditorSelectionInfo } from './types.js';

/**
 * Computes 1-indexed line and column numbers and total selected character count
 * based on the primary selection head.
 */
export function getSelectionInfo(state: EditorState): EditorSelectionInfo {
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);

  return {
    line: line.number,
    column: main.head - line.from + 1,
    selectedTextLength: Math.abs(main.to - main.from),
    head: main.head
  };
}
