import { EditorSelection, type EditorState } from '@codemirror/state';
import { EditorView, keymap, type KeyBinding } from '@codemirror/view';
import { insertNewlineAndIndent } from '@codemirror/commands';
import {
  createParagraphOrHeadingSplitTransaction,
  createBlockMergeTransaction,
  createListIndentTransaction,
  createListOutdentTransaction,
  createInlineFormatTransaction,
  createSelectBlockAtPositionTransaction,
  createReorderBlockAtPositionTransaction,
  findContainingBlock,
  isFenceClosed
} from './edit-transactions.js';
import { parseMarkdown } from '@nexus/markdown';
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
 * 智能代码块回车跳出 (Smart Code Block Enter)：
 * 1. 如果光标在代码块末尾空行，清除该空行并跳出代码块至下方新段落。
 * 2. 否则在代码块内正常插入换行。
 */
function handleCodeBlockEnter(view: EditorView, selection: MarkdownSelection): boolean {
  if (selection.anchor !== selection.head) return false;
  const source = view.state.doc.toString();
  const pos = selection.head;
  const { root } = parseMarkdown(source);
  const block = findContainingBlock(root, pos, source.length);
  if (!block || block.type !== 'code-block') return false;
  if (!isFenceClosed(block.raw) || block.language === 'mermaid') return false;

  const doc = view.state.doc;
  const currentLine = doc.lineAt(pos);
  const blockEnd = block.range.to;
  const closingLine = doc.lineAt(Math.max(block.range.from, blockEnd - 1));

  // 如果光标位于闭合围栏正前方的空行，触发智能跳出
  if (currentLine.number === closingLine.number - 1 && currentLine.text.trim() === '') {
    const openingLine = doc.lineAt(block.range.from);
    let deleteFrom: number;
    let deleteTo: number;
    if (currentLine.number === openingLine.number + 1) {
      // 紧随首行围栏的唯一空行：删除该空行及其后的换行，保留首行围栏换行
      deleteFrom = currentLine.from;
      deleteTo = Math.min(doc.length, currentLine.to + 1);
    } else {
      // 包含上一行的换行符
      deleteFrom = currentLine.from - 1;
      deleteTo = currentLine.to;
    }

    const afterBlockPos = block.range.to;
    const isAlreadyEmptyAfter = afterBlockPos < doc.length && doc.sliceString(afterBlockPos, afterBlockPos + 1) === '\n';
    const needInsertNl = !isAlreadyEmptyAfter;

    const changes: { from: number; to?: number; insert: string }[] = [
      { from: deleteFrom, to: deleteTo, insert: '' }
    ];
    if (needInsertNl) {
      changes.push({ from: afterBlockPos, insert: '\n' });
    }

    const newCursor = afterBlockPos - (deleteTo - deleteFrom);
    view.dispatch({
      changes,
      selection: EditorSelection.cursor(newCursor),
      userEvent: 'input.enter'
    });
    return true;
  }

  // 正常在代码块内部使用 CodeMirror 原生智能缩进换行
  return insertNewlineAndIndent(view);
}

/**
 * Visual Mode 专属回车分块处理：
 * 拆分段落/标题、拆分列表项或空列表退出、空引用退出、智能代码块退出。
 */
export function handleVisualEnter(view: EditorView): boolean {
  if (!isEditable(view)) return false;
  const source = view.state.doc.toString();
  const selection = selectionFromState(view.state);

  if (handleCodeBlockEnter(view, selection)) {
    return true;
  }

  const tx = createParagraphOrHeadingSplitTransaction(source, selection);
  if (tx) {
    view.dispatch({
      changes: tx.changes,
      selection: tx.selection ? toEditorSelection(tx.selection) : undefined,
      userEvent: tx.userEvent ?? 'input.enter'
    });
    return true;
  }

  return insertPlainNewlineInRawBlock(view, selection);
}

/**
 * 提交表格：补上结尾换行让表格切换成 widget，并把光标放到表格之后。
 * widget 之后之所以能继续输入，取决于 visual-projection 让块级装饰不覆盖行尾换行。
 */
function commitTableAndRestoreCaret(view: EditorView, tableEnd: number, caret: number): void {
  const docLength = view.state.doc.length;
  const atLineEnd = tableEnd < docLength && view.state.doc.sliceString(tableEnd, tableEnd + 1) === '\n';

  if (atLineEnd) {
    view.dispatch({
      selection: EditorSelection.cursor(Math.max(tableEnd + 1, caret)),
      userEvent: 'table.commit'
    });
    return;
  }

  const insertPos = Math.min(tableEnd, docLength);
  view.dispatch({
    changes: { from: insertPos, to: insertPos, insert: '\n' },
    selection: EditorSelection.cursor(insertPos + 1),
    userEvent: 'table.commit'
  });
}

/**
 * 未闭合代码围栏在 Visual 下保持原始文本（见 visual-projection 对 isFenceClosed 的处理），
 * 段落拆分事务会明确返回 null，于是回车被整体吞掉，用户无法书写多行代码块。
 * 这里对「以原始文本呈现的代码块/公式/raw 块」退化为插入一个普通换行。
 */
function insertPlainNewlineInRawBlock(view: EditorView, selection: MarkdownSelection): boolean {
  if (selection.anchor !== selection.head) return false;

  const source = view.state.doc.toString();
  const pos = selection.head;
  const { root } = parseMarkdown(source);
  const block = findContainingBlock(root, pos, source.length);
  if (!block) return false;

  // 表格处于「源码书写态」时（见 visual-projection 对光标在表格内的处理），
  // 回车表示提交：把光标移到表格之后，表格随即切回 widget 预览。
  if (block.type === 'table') {
    commitTableAndRestoreCaret(view, block.range.to, selection.head);
    return true;
  }

  const isRawEditableFence = block.type === 'code-block' && !isFenceClosed(block.raw);
  if (!isRawEditableFence && block.type !== 'raw' && block.type !== 'block-math') {
    return false;
  }

  view.dispatch({
    changes: { from: pos, to: pos, insert: '\n' },
    selection: EditorSelection.single(pos + 1),
    userEvent: 'input.enter'
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
