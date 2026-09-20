import { EditorSelection, type EditorState } from '@codemirror/state';
import { EditorView, keymap, type KeyBinding } from '@codemirror/view';
import {
  createParagraphOrHeadingSplitTransaction,
  createBlockMergeTransaction,
  createListIndentTransaction,
  createListOutdentTransaction,
  createInlineFormatTransaction,
  createSelectBlockAtPositionTransaction,
  createReorderBlockAtPositionTransaction
} from './edit-transactions.js';
import type { MarkdownSelection } from './types.js';

function selectionFromState(state: EditorState): MarkdownSelection {
  return {
    anchor: state.selection.main.anchor,
    head: state.selection.main.head
  };
}

function toEditorSelection(selection: MarkdownSelection): EditorSelection {
  return EditorSelection.single(selection.anchor, selection.head);
}

function isEditable(view: EditorView): boolean {
  return !view.state.readOnly;
}

/**
 * Visual Mode 专属回车分块处理：
 * 拆分段落/标题、拆分列表项或空列表退出、空引用退出。
 */
export function handleVisualEnter(view: EditorView): boolean {
  if (!isEditable(view)) return false;
  const source = view.state.doc.toString();
  const selection = selectionFromState(view.state);
  const tx = createParagraphOrHeadingSplitTransaction(source, selection);
  if (!tx) return false;

  view.dispatch({
    changes: tx.changes,
    selection: tx.selection ? toEditorSelection(tx.selection) : undefined,
    userEvent: tx.userEvent ?? 'input.enter'
  });
  return true;
}

/**
 * Visual Mode 专属退格块合并处理：
 * 段落首退格合并至前一块、列表项首退格解包前缀、引用首退格解包前缀。
 */
export function handleVisualBackspace(view: EditorView): boolean {
  if (!isEditable(view)) return false;
  const source = view.state.doc.toString();
  const selection = selectionFromState(view.state);
  const tx = createBlockMergeTransaction(source, selection);
  if (!tx) return false;

  view.dispatch({
    changes: tx.changes,
    selection: tx.selection ? toEditorSelection(tx.selection) : undefined,
    userEvent: tx.userEvent ?? 'delete.backward'
  });
  return true;
}

/**
 * Visual Mode 列表缩进处理（Tab 键）：
 * 缩进当前列表项及其所有子树，并精准映射选区。
 */
export function handleVisualTab(view: EditorView): boolean {
  if (!isEditable(view)) return false;
  const source = view.state.doc.toString();
  const selection = selectionFromState(view.state);
  const tx = createListIndentTransaction(source, selection);
  if (!tx) return false;

  view.dispatch({
    changes: tx.changes,
    selection: tx.selection ? toEditorSelection(tx.selection) : undefined,
    userEvent: tx.userEvent ?? 'list.indent'
  });
  return true;
}

/**
 * Visual Mode 列表反缩进处理（Shift-Tab 键）：
 * 提升当前列表项及其所有子树层级，并精准映射选区。
 */
export function handleVisualShiftTab(view: EditorView): boolean {
  if (!isEditable(view)) return false;
  const source = view.state.doc.toString();
  const selection = selectionFromState(view.state);
  const tx = createListOutdentTransaction(source, selection);
  if (!tx) return false;

  view.dispatch({
    changes: tx.changes,
    selection: tx.selection ? toEditorSelection(tx.selection) : undefined,
    userEvent: tx.userEvent ?? 'list.outdent'
  });
  return true;
}

/**
 * Visual Mode 粗体格式化处理（Mod-B 键）：
 * 切换选区的加粗样式，支持解包现有 ** 与 __ 分隔符。
 */
export function handleVisualModB(view: EditorView): boolean {
  if (!isEditable(view)) return false;
  const source = view.state.doc.toString();
  const selection = selectionFromState(view.state);
  const tx = createInlineFormatTransaction(source, selection, 'strong');
  if (!tx) return false;

  view.dispatch({
    changes: tx.changes,
    selection: tx.selection ? toEditorSelection(tx.selection) : undefined,
    userEvent: tx.userEvent ?? 'format.bold'
  });
  return true;
}

/**
 * Visual Mode 斜体格式化处理（Mod-I 键）：
 * 切换选区的斜体样式，高保真解包现有 * 与 _ 分隔符。
 */
export function handleVisualModI(view: EditorView): boolean {
  if (!isEditable(view)) return false;
  const source = view.state.doc.toString();
  const selection = selectionFromState(view.state);
  const tx = createInlineFormatTransaction(source, selection, 'emphasis');
  if (!tx) return false;

  view.dispatch({
    changes: tx.changes,
    selection: tx.selection ? toEditorSelection(tx.selection) : undefined,
    userEvent: tx.userEvent ?? 'format.italic'
  });
  return true;
}

/**
 * Visual Mode 删除线格式化处理（Mod-Shift-x 键）：
 * 切换选区的删除线样式，高保真解包现有 ~~ 分隔符。
 */
export function handleVisualModStrike(view: EditorView): boolean {
  if (!isEditable(view)) return false;
  const source = view.state.doc.toString();
  const selection = selectionFromState(view.state);
  const tx = createInlineFormatTransaction(source, selection, 'strike');
  if (!tx) return false;

  view.dispatch({
    changes: tx.changes,
    selection: tx.selection ? toEditorSelection(tx.selection) : undefined,
    userEvent: tx.userEvent ?? 'format.strike'
  });
  return true;
}

/**
 * Visual Mode 块全选处理（Mod-Shift-Space 键）：
 * 选中当前光标所在或 target 偏移量处的完整最深 AST 块节点，不误选相邻 gap。
 */
export function handleVisualSelectBlock(view: EditorView, target?: number): boolean {
  if (!isEditable(view)) return false;
  const source = view.state.doc.toString();
  const pos = target !== undefined ? target : view.state.selection.main.head;
  const tx = createSelectBlockAtPositionTransaction(source, pos);
  if (!tx || !tx.selection) return false;

  view.dispatch({
    selection: toEditorSelection(tx.selection),
    userEvent: tx.userEvent ?? 'select.block'
  });
  return true;
}

/**
 * Visual Mode 块上移处理（Alt-ArrowUp 键）：
 * 将当前光标所在的最深块在所属父容器内向上移动一个槽位，保留原块切片与 gap 格式。
 */
export function handleVisualMoveBlockUp(view: EditorView): boolean {
  if (!isEditable(view)) return false;
  const source = view.state.doc.toString();
  const sel = view.state.selection.main;
  const pos = sel.from !== sel.to ? sel.from : sel.head;
  const currentSel = selectionFromState(view.state);
  const tx = createReorderBlockAtPositionTransaction(source, pos, 'up', currentSel);
  if (!tx) return false;

  view.dispatch({
    changes: tx.changes,
    selection: tx.selection ? toEditorSelection(tx.selection) : undefined,
    userEvent: tx.userEvent ?? 'block.reorder'
  });
  return true;
}

/**
 * Visual Mode 块下移处理（Alt-ArrowDown 键）：
 * 将当前光标所在的最深块在所属父容器内向下移动一个槽位，保留原块切片与 gap 格式。
 */
export function handleVisualMoveBlockDown(view: EditorView): boolean {
  if (!isEditable(view)) return false;
  const source = view.state.doc.toString();
  const sel = view.state.selection.main;
  const pos = sel.from !== sel.to ? sel.from : sel.head;
  const currentSel = selectionFromState(view.state);
  const tx = createReorderBlockAtPositionTransaction(source, pos, 'down', currentSel);
  if (!tx) return false;

  view.dispatch({
    changes: tx.changes,
    selection: tx.selection ? toEditorSelection(tx.selection) : undefined,
    userEvent: tx.userEvent ?? 'block.reorder'
  });
  return true;
}

export const visualKeybindings: KeyBinding[] = [
  { key: 'Enter', run: handleVisualEnter },
  { key: 'Backspace', run: handleVisualBackspace },
  { key: 'Tab', run: handleVisualTab, shift: handleVisualShiftTab },
  { key: 'Mod-b', run: handleVisualModB },
  { key: 'Mod-i', run: handleVisualModI },
  { key: 'Mod-Shift-x', run: handleVisualModStrike },
  { key: 'Mod-Shift-Space', run: (view) => handleVisualSelectBlock(view) },
  { key: 'Alt-ArrowUp', run: handleVisualMoveBlockUp },
  { key: 'Alt-ArrowDown', run: handleVisualMoveBlockDown }
];

export const visualCommandsExtension = keymap.of(visualKeybindings);
