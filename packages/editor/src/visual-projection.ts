import {
  StateField,
  RangeSetBuilder,
  StateEffect,
  EditorSelection,
  type Extension
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view';
import {
  parseMarkdown,
  getRowCellRanges,
  type MarkdownBlockNode,
  type MarkdownInlineNode,
  type MarkdownListItem,
  type SourceRange
} from '@nexus/markdown';
import { findMarkdownMarkers } from './markdown-markers.js';
import {
  LinkWidget,
  ImageWidget,
  InlineMathWidget,
  InlineCodeWidget,
  WikiLinkWidget,
  getInlineNodePlainText
} from './inline-edit.js';
import { isEditorComposing, setComposingEffect } from './ime-composition.js';
import {
  findTableAtPosition,
  createTableAddRowTransaction,
  createTableAddColumnTransaction,
  createTableDeleteRowTransaction,
  createTableDeleteColumnTransaction,
  createTableSetAlignTransaction,
  createTableCellEditTransaction,
  splitTableLines,
  type TableCellContext
} from './table-edit.js';
import {
  parseCodeBlockContext,
  createCodeBlockValueTransaction,
  createCodeBlockLanguageTransaction
} from './code-block-edit.js';
import {
  parseBlockMathContext,
  createBlockMathEditTransaction
} from './special-block-edit.js';
import { walkBlockNodes } from './ast-walker.js';

/** 注册到单个 EditorView 的可关闭子编辑器。 */
interface ActiveSubEditor {
  close: () => void;
}

const activeSubEditors = new WeakMap<EditorView, Set<ActiveSubEditor>>();

function registerActiveSubEditor(view: EditorView, editor: ActiveSubEditor): () => void {
  let set = activeSubEditors.get(view);
  if (!set) {
    set = new Set();
    activeSubEditors.set(view, set);
  }
  set.add(editor);
  return () => {
    set?.delete(editor);
  };
}

/** 子编辑器的监听信号与幂等关闭入口。 */
interface SubEditorController {
  signal: AbortSignal;
  isActive: () => boolean;
  close: () => void;
}

/** 统一管理子编辑器事件、注册和幂等关闭。 */
function createSubEditorController(
  view: EditorView,
  onClose: () => void
): SubEditorController {
  const abortController = new AbortController();
  let active = true;
  let unregister = () => {};

  const close = () => {
    if (!active) return;
    active = false;
    abortController.abort();
    unregister();
    onClose();
  };

  unregister = registerActiveSubEditor(view, { close });
  return {
    signal: abortController.signal,
    isActive: () => active,
    close
  };
}

function closeAllActiveSubEditors(view: EditorView): void {
  const set = activeSubEditors.get(view);
  if (set) {
    for (const editor of Array.from(set)) {
      editor.close();
    }
    set.clear();
  }
}

class SubEditorLifecyclePlugin {
  public disposed = false;
  public generation = 0;

  constructor(readonly view: EditorView) {}

  update(update: ViewUpdate) {
    if (update.startState.readOnly !== update.state.readOnly) {
      const isRo = update.state.readOnly;
      // 工具栏由 tableWidgetSyncPlugin 依据只读状态和有效目标统一刷新。
      if (isRo) {
        this.generation++;
        closeAllActiveSubEditors(update.view);
      }
    }

    if (update.docChanged) {
      const isInternalSubEditorCommit = update.transactions.some(
        (tr) =>
          tr.isUserEvent('table.cell-edit') ||
          tr.isUserEvent('code-block.value-edit') ||
          tr.isUserEvent('code-block.language-edit') ||
          tr.isUserEvent('block-math.edit') ||
          tr.isUserEvent(RAW_BLOCK_EDIT_USER_EVENT)
      );
      if (!isInternalSubEditorCommit) {
        this.generation++;
        closeAllActiveSubEditors(update.view);
      }
    }
  }

  destroy() {
    this.disposed = true;
    this.generation++;
    closeAllActiveSubEditors(this.view);
  }
}

const subEditorLifecyclePlugin = ViewPlugin.fromClass(SubEditorLifecyclePlugin);

const RAW_BLOCK_EDIT_USER_EVENT = 'raw-block.edit';

export const setVisualFocusEffect = StateEffect.define<boolean>();

export const visualFocusField = StateField.define<boolean>({
  create() {
    return false;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setVisualFocusEffect)) {
        return effect.value;
      }
    }
    return value;
  }
});

export const visualFocusPlugin = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      view.dom.addEventListener('focus', this.onFocus, true);
      view.dom.addEventListener('blur', this.onBlur, true);
      view.dom.addEventListener('focusin', this.onFocus);
      view.dom.addEventListener('focusout', this.onBlur);
      const origFocus = view.focus.bind(view);
      view.focus = () => {
        origFocus();
        if (!view.state.field(visualFocusField, false)) {
          view.dispatch({ effects: setVisualFocusEffect.of(true) });
        }
      };
    }
    onFocus = () => {
      if (!this.view.state.field(visualFocusField, false)) {
        this.view.dispatch({ effects: setVisualFocusEffect.of(true) });
      }
    };
    onBlur = (event: FocusEvent) => {
      if (event.relatedTarget && this.view.dom.contains(event.relatedTarget as Node)) {
        return;
      }
      if (this.view.state.field(visualFocusField, false)) {
        this.view.dispatch({ effects: setVisualFocusEffect.of(false) });
      }
    };
    destroy() {
      this.view.dom.removeEventListener('focus', this.onFocus, true);
      this.view.dom.removeEventListener('blur', this.onBlur, true);
      this.view.dom.removeEventListener('focusin', this.onFocus);
      this.view.dom.removeEventListener('focusout', this.onBlur);
    }
  }
);

export const setDocumentDirectoryEffect = StateEffect.define<string | null>();

export const documentDirectoryField = StateField.define<string | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDocumentDirectoryEffect)) {
        return effect.value;
      }
    }
    return value;
  }
});

export function setDocumentDirectory(view: EditorView, directory: string | null): void {
  view.dispatch({ effects: setDocumentDirectoryEffect.of(directory) });
}

export interface TableTarget {
  tableFrom: number;
  activeRow: number | null; // null: unselected; -1: header; 0..n: data row
  activeCol: number | null; // null: unselected; 0..m: column
}

export const setTableTargetEffect = StateEffect.define<TableTarget | null>();

export const tableTargetField = StateField.define<TableTarget | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setTableTargetEffect)) {
        return effect.value;
      }
    }
    if (!value) return null;
    if (tr.docChanged) {
      const oldSource = tr.startState.doc.toString();
      const oldTable = findTableAtPosition(oldSource, value.tableFrom);
      if (!oldTable) {
        return null;
      }

      // 起点前插入内容时跟随原表格；整块替换后不凭相同文字继承身份。
      const newFrom = tr.changes.mapPos(value.tableFrom, 1);
      const newSource = tr.newDoc.toString();
      const newTable = findTableAtPosition(newSource, newFrom);
      if (!newTable || newTable.tableRange.from !== newFrom) {
        return null;
      }

      let activeRow: number | null = null;
      let activeCol: number | null = null;

      // 只通过仍然存活的表头槽位映射列，删除的槽位不能转移到同名列。
      if (
        value.activeCol !== null &&
        value.activeCol >= 0 &&
        value.activeCol < oldTable.headers.length
      ) {
        const oldLines = splitTableLines(oldTable.raw, oldTable.tableRange.from);
        if (oldLines.length >= 1) {
          const oldHeaderLine = oldLines[0]!;
          const oldPrefixMatch = oldHeaderLine.text.match(/^([ \t]*(?:>[ \t]*)*)/);
          const oldPrefixLen = oldPrefixMatch ? oldPrefixMatch[0]!.length : 0;
          const oldCleanText = oldHeaderLine.text.slice(oldPrefixLen);
          const oldCellRanges = getRowCellRanges(oldCleanText, oldHeaderLine.from + oldPrefixLen);

          if (value.activeCol < oldCellRanges.length) {
            const oldCell = oldCellRanges[value.activeCol]!;
            const oldSlotFrom = oldHeaderLine.from + oldPrefixLen + oldCell.slotStart;
            const oldSlotTo = oldHeaderLine.from + oldPrefixLen + oldCell.slotEnd;
            const mappedSlotFrom = tr.changes.mapPos(oldSlotFrom, 1);
            const mappedSlotTo = tr.changes.mapPos(oldSlotTo, -1);

            if (mappedSlotFrom < mappedSlotTo) {
              const newLines = splitTableLines(newTable.raw, newTable.tableRange.from);
              if (newLines.length >= 1) {
                const newHeaderLine = newLines[0]!;
                const newPrefixMatch = newHeaderLine.text.match(/^([ \t]*(?:>[ \t]*)*)/);
                const newPrefixLen = newPrefixMatch ? newPrefixMatch[0]!.length : 0;
                const newCleanText = newHeaderLine.text.slice(newPrefixLen);
                const newCellRanges = getRowCellRanges(newCleanText, newHeaderLine.from + newPrefixLen);

                for (let c = 0; c < newCellRanges.length; c++) {
                  const nCell = newCellRanges[c]!;
                  const nSlotFrom = newHeaderLine.from + newPrefixLen + nCell.slotStart;
                  const nSlotTo = newHeaderLine.from + newPrefixLen + nCell.slotEnd;
                  if (mappedSlotFrom >= nSlotFrom && mappedSlotTo <= nSlotTo) {
                    activeCol = c;
                    break;
                  } else if (mappedSlotFrom >= nSlotFrom && mappedSlotFrom < nSlotTo) {
                    activeCol = c;
                    break;
                  }
                }
              }
            }
          }
        }
      }

      // 行身份来自原始行范围；重复行正文不能作为身份依据。
      if (value.activeRow !== null) {
        if (value.activeRow === -1) {
          activeRow = -1;
        } else if (value.activeRow >= 0 && value.activeRow < oldTable.rows.length) {
          const oldLines = splitTableLines(oldTable.raw, oldTable.tableRange.from);
          const oldTargetLineIdx = 2 + value.activeRow;
          if (oldTargetLineIdx < oldLines.length) {
            const oldRowLine = oldLines[oldTargetLineIdx]!;
            const mappedLineFrom = tr.changes.mapPos(oldRowLine.from, 1);
            const mappedLineTo = tr.changes.mapPos(oldRowLine.to, -1);

            if (mappedLineFrom < mappedLineTo) {
              const newLines = splitTableLines(newTable.raw, newTable.tableRange.from);
              for (let r = 0; r < newTable.rows.length; r++) {
                const newLineIdx = 2 + r;
                if (newLineIdx < newLines.length) {
                  const newRowLine = newLines[newLineIdx]!;
                  if (
                    mappedLineFrom >= newRowLine.from &&
                    mappedLineTo <= newRowLine.to + newRowLine.newline.length
                  ) {
                    activeRow = r;
                    break;
                  } else if (mappedLineFrom >= newRowLine.from && mappedLineFrom < newRowLine.to) {
                    activeRow = r;
                    break;
                  }
                }
              }
            }
          }
        }
      }

      if (activeCol === null && activeRow === null) {
        return null;
      }

      return {
        tableFrom: newTable.tableRange.from,
        activeRow,
        activeCol
      };
    }
    return value;
  }
});

export function resolveDocumentAssetUrl(
  src: string,
  documentDirectory: string | null | undefined
): string | null {
  if (!src || typeof src !== 'string') return null;
  let trimmed = src.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return null;
  }

  if (!documentDirectory) {
    return null;
  }

  try {
    const hashIndex = trimmed.indexOf('#');
    const queryIndex = trimmed.indexOf('?');
    let pathPart = trimmed;
    let suffix = '';

    const firstSep =
      hashIndex === -1 ? queryIndex : queryIndex === -1 ? hashIndex : Math.min(hashIndex, queryIndex);
    if (firstSep !== -1) {
      pathPart = trimmed.slice(0, firstSep);
      suffix = trimmed.slice(firstSep);
    }

    try {
      pathPart = decodeURI(pathPart);
    } catch {
      // ignore malformed URI
    }

    const normBase = documentDirectory.replace(/\\/g, '/');
    const normRel = pathPart.replace(/\\/g, '/');

    const isWindowsAbsolute = /^[a-zA-Z]:/.test(normBase);
    const isPosixAbsolute = normBase.startsWith('/');

    if (!isWindowsAbsolute && !isPosixAbsolute) {
      return null;
    }

    const baseSegments = normBase.split('/').filter(Boolean);
    const relSegments = normRel.split('/').filter(Boolean);

    let resolvedSegments: string[];
    if (normRel.startsWith('/')) {
      if (isWindowsAbsolute) {
        resolvedSegments = [baseSegments[0]!, ...relSegments];
      } else {
        resolvedSegments = [...relSegments];
      }
    } else {
      resolvedSegments = [...baseSegments];
      for (const seg of relSegments) {
        if (seg === '.') {
          continue;
        } else if (seg === '..') {
          if (isWindowsAbsolute && resolvedSegments.length <= 1) {
            continue;
          }
          if (resolvedSegments.length > 0) {
            resolvedSegments.pop();
          }
        } else {
          resolvedSegments.push(seg);
        }
      }
    }

    if (isWindowsAbsolute) {
      const drive = resolvedSegments[0]!;
      const rest = resolvedSegments.slice(1).map(encodeURIComponent).join('/');
      return `file:///${drive}/${rest}${suffix}`;
    } else {
      const rest = resolvedSegments.map(encodeURIComponent).join('/');
      return `file:///${rest}${suffix}`;
    }
  } catch {
    return null;
  }
}

export class DelimiterWidget extends WidgetType {
  public constructor(
    public readonly delimiter: string,
    public readonly revealed: boolean = false
  ) {
    super();
  }

  public toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = this.revealed ? 'cm-visual-delimiter-revealed' : 'cm-visual-hidden-delimiter';
    element.setAttribute('aria-hidden', 'true');
    element.dataset.delimiter = this.delimiter;
    if (this.revealed) {
      element.textContent = this.delimiter;
    }
    return element;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof DelimiterWidget &&
      other.delimiter === this.delimiter &&
      other.revealed === this.revealed
    );
  }

  public ignoreEvent(): boolean {
    return true;
  }
}

export { DelimiterWidget as HiddenDelimiterWidget };

export class HorizontalRuleWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string
  ) {
    super();
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof HorizontalRuleWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw
    );
  }

  public toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-visual-hr-container';
    container.tabIndex = 0;
    container.setAttribute('role', 'separator');

    const hr = document.createElement('hr');
    hr.className = 'cm-visual-horizontal-rule';
    container.appendChild(hr);

    const startEdit = () => {
      if (view.state.readOnly) return;
      if (container.querySelector('.cm-hr-editor')) return;

      const raw = this.raw;
      // 标记内部空格可编辑；外围缩进、行尾空白和换行属于原始布局，单独保留。
      const match = raw.match(/^([ \t]*(?:>[ \t]*)*)([^\r\n]*?)([ \t]*(?:\r?\n)*)$/);
      const prefix = match ? match[1]! : '';
      const marker = match ? match[2]! : raw.trim();
      const suffix = match ? match[3]! : '';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'cm-hr-editor';
      input.value = marker;

      hr.style.display = 'none';
      container.appendChild(input);
      input.focus();
      input.select();

      const controller = createSubEditorController(view, () => {
        input.remove();
        hr.style.display = '';
        container.focus();
      });
      const { signal } = controller;

      let isComposing = false;
      input.addEventListener('compositionstart', () => { isComposing = true; }, { signal });
      input.addEventListener('compositionend', () => { isComposing = false; }, { signal });

      const commit = () => {
        if (!controller.isActive() || view.state.readOnly) {
          controller.close();
          return;
        }
        const newValue = input.value;
        if (newValue === marker) {
          controller.close();
          return;
        }
        const source = view.state.doc.toString();
        const parsed = parseMarkdown(source);
        let targetRange: { from: number; to: number } | null = null;
        walkBlockNodes(parsed.root.children, (child) => {
          if (child.type === 'horizontal-rule' && child.range.from === this.from) {
            targetRange = { from: child.range.from, to: child.range.to };
            return true;
          }
          return false;
        });
        const finalRange = targetRange as { from: number; to: number } | null;
        if (finalRange) {
          const newRaw = prefix + newValue + suffix;
          view.dispatch({
            changes: { from: finalRange.from, to: finalRange.to, insert: newRaw },
            userEvent: 'horizontal-rule.edit'
          });
        }
        controller.close();
      };

      input.addEventListener(
        'keydown',
        (e) => {
          if (!controller.isActive() || isComposing || e.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            controller.close();
          }
        },
        { signal }
      );

      input.addEventListener(
        'blur',
        () => {
          if (controller.isActive() && !isComposing) {
            commit();
          }
        },
        { signal }
      );
    };

    container.addEventListener('click', (e) => {
      e.stopPropagation();
      startEdit();
    });

    container.addEventListener('keydown', (e) => {
      if (e.target !== container) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        startEdit();
      }
    });

    return container;
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

interface ProjectionRange {
  from: number;
  to: number;
  decoration: Decoration;
}

export class TaskCheckboxWidget extends WidgetType {
  public constructor(
    public readonly checked: boolean,
    public readonly from: number,
    public readonly to: number
  ) {
    super();
  }

  public toDOM(view: EditorView): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'cm-visual-task-checkbox';
    input.checked = this.checked;
    input.setAttribute('aria-label', this.checked ? 'Mark task incomplete' : 'Mark task complete');

    if (view.state.readOnly) {
      input.disabled = true;
    }

    input.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    input.addEventListener('change', () => {
      if (view.state.readOnly) return;
      const current = view.state.doc.sliceString(this.from, this.to);
      const isCurrentlyChecked = current.toLowerCase().includes('x');
      view.dispatch({
        changes: {
          from: this.from,
          to: this.to,
          insert: isCurrentlyChecked ? '[ ]' : '[x]'
        },
        userEvent: 'task.toggle'
      });
    });

    return input;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof TaskCheckboxWidget &&
      other.checked === this.checked &&
      other.from === this.from &&
      other.to === this.to
    );
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

export class TableBlockWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly headers: MarkdownInlineNode[][],
    public readonly rows: MarkdownInlineNode[][][],
    public readonly align: ('left' | 'center' | 'right' | null)[]
  ) {
    super();
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof TableBlockWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw
    );
  }

  public toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-visual-table-container';

    const toolbar = document.createElement('div');
    toolbar.className = 'cm-table-toolbar';

    const addRowBtn = document.createElement('button');
    addRowBtn.type = 'button';
    addRowBtn.className = 'cm-table-btn-add-row';
    addRowBtn.textContent = '+ Row';

    const addColBtn = document.createElement('button');
    addColBtn.type = 'button';
    addColBtn.className = 'cm-table-btn-add-col';
    addColBtn.textContent = '+ Col';

    const delRowBtn = document.createElement('button');
    delRowBtn.type = 'button';
    delRowBtn.className = 'cm-table-btn-del-row';
    delRowBtn.dataset.tableAction = 'delete-row';
    delRowBtn.textContent = '- Row';

    const delColBtn = document.createElement('button');
    delColBtn.type = 'button';
    delColBtn.className = 'cm-table-btn-del-col';
    delColBtn.dataset.tableAction = 'delete-column';
    delColBtn.textContent = '- Col';

    const alignLeftBtn = document.createElement('button');
    alignLeftBtn.type = 'button';
    alignLeftBtn.className = 'cm-table-btn-align-left';
    alignLeftBtn.dataset.tableAction = 'align-left';
    alignLeftBtn.textContent = 'Align Left';

    const alignCenterBtn = document.createElement('button');
    alignCenterBtn.type = 'button';
    alignCenterBtn.className = 'cm-table-btn-align-center';
    alignCenterBtn.dataset.tableAction = 'align-center';
    alignCenterBtn.textContent = 'Align Center';

    const alignRightBtn = document.createElement('button');
    alignRightBtn.type = 'button';
    alignRightBtn.className = 'cm-table-btn-align-right';
    alignRightBtn.dataset.tableAction = 'align-right';
    alignRightBtn.textContent = 'Align Right';

    (container as any).__nexusTableWidget = this;

    const updateButtons = () => {
      const isRo = view.state.readOnly;
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const target = view.state.field(tableTargetField, false);
      const activeRow =
        target && target.tableFrom === currentWidget.from ? target.activeRow : null;
      const activeCol =
        target && target.tableFrom === currentWidget.from ? target.activeCol : null;

      addRowBtn.disabled = isRo;
      addColBtn.disabled = isRo;
      delRowBtn.disabled = isRo || activeRow === null || activeRow < 0;
      delColBtn.disabled = isRo || activeCol === null || currentWidget.headers.length <= 1;
      alignLeftBtn.disabled = isRo || activeCol === null;
      alignCenterBtn.disabled = isRo || activeCol === null;
      alignRightBtn.disabled = isRo || activeCol === null;
    };

    (container as any).__nexusUpdateTableToolbar = updateButtons;

    addRowBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (view.state.readOnly) return;
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, currentWidget.from);
      if (tableCtx) {
        const tx = createTableAddRowTransaction(source, tableCtx);
        if (tx) {
          view.dispatch({
            changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
            userEvent: tx.userEvent
          });
        }
      }
    });

    addColBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (view.state.readOnly) return;
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, currentWidget.from);
      if (tableCtx) {
        const tx = createTableAddColumnTransaction(source, tableCtx);
        if (tx) {
          view.dispatch({
            changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
            userEvent: tx.userEvent
          });
        }
      }
    });

    delRowBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const currentTarget = view.state.field(tableTargetField, false);
      const activeRow =
        currentTarget && currentTarget.tableFrom === currentWidget.from ? currentTarget.activeRow : null;
      if (view.state.readOnly || activeRow === null || activeRow < 0) return;
      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, currentWidget.from);
      if (tableCtx && tableCtx.rows.length > 0 && activeRow < tableCtx.rows.length) {
        const tx = createTableDeleteRowTransaction(source, tableCtx, activeRow);
        if (tx) {
          view.dispatch({
            changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
            userEvent: tx.userEvent,
            effects: setTableTargetEffect.of(null)
          });
        }
      }
    });

    delColBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const currentTarget = view.state.field(tableTargetField, false);
      const activeCol =
        currentTarget && currentTarget.tableFrom === currentWidget.from ? currentTarget.activeCol : null;
      if (view.state.readOnly || activeCol === null) return;
      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, currentWidget.from);
      if (tableCtx && tableCtx.headers.length > 1 && activeCol < tableCtx.headers.length) {
        const tx = createTableDeleteColumnTransaction(source, tableCtx, activeCol);
        if (tx) {
          view.dispatch({
            changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
            userEvent: tx.userEvent,
            effects: setTableTargetEffect.of(null)
          });
        }
      }
    });

    const createAlignHandler = (align: 'left' | 'center' | 'right') => (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const currentTarget = view.state.field(tableTargetField, false);
      const activeCol =
        currentTarget && currentTarget.tableFrom === currentWidget.from ? currentTarget.activeCol : null;
      if (view.state.readOnly || activeCol === null) return;
      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, currentWidget.from);
      if (tableCtx && activeCol < tableCtx.headers.length) {
        const tx = createTableSetAlignTransaction(source, tableCtx, activeCol, align);
        if (tx) {
          view.dispatch({
            changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
            userEvent: tx.userEvent
          });
        }
      }
    };

    alignLeftBtn.addEventListener('click', createAlignHandler('left'));
    alignCenterBtn.addEventListener('click', createAlignHandler('center'));
    alignRightBtn.addEventListener('click', createAlignHandler('right'));

    updateButtons();

    toolbar.appendChild(addRowBtn);
    toolbar.appendChild(addColBtn);
    toolbar.appendChild(delRowBtn);
    toolbar.appendChild(delColBtn);
    toolbar.appendChild(alignLeftBtn);
    toolbar.appendChild(alignCenterBtn);
    toolbar.appendChild(alignRightBtn);
    container.appendChild(toolbar);

    const table = this.buildTableDOM(view, container);
    container.appendChild(table);

    return container;
  }

  private buildTableDOM(view: EditorView, container: HTMLElement): HTMLTableElement {
    const table = document.createElement('table');
    table.className = 'cm-visual-table';

    const thead = document.createElement('thead');
    const headerTr = document.createElement('tr');
    this.headers.forEach((cell, colIdx) => {
      const th = document.createElement('th');
      th.dataset.row = '-1';
      th.dataset.col = String(colIdx);
      const align = this.align[colIdx];
      if (align) th.style.textAlign = align;
      const cellText = cell.map((node) => ('value' in node ? node.value : node.raw)).join('') || ' ';
      th.textContent = cellText;

      th.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
        view.dispatch({
          effects: setTableTargetEffect.of({ tableFrom: currentWidget.from, activeRow: -1, activeCol: colIdx })
        });
        const updateButtons = (container as any).__nexusUpdateTableToolbar;
        if (typeof updateButtons === 'function') updateButtons();
        if (view.state.readOnly) return;
        this.startCellEdit(view, th, -1, colIdx, cellText);
      });

      headerTr.appendChild(th);
    });
    thead.appendChild(headerTr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    this.rows.forEach((row, rowIdx) => {
      const tr = document.createElement('tr');
      row.forEach((cell, colIdx) => {
        const td = document.createElement('td');
        td.dataset.row = String(rowIdx);
        td.dataset.col = String(colIdx);
        const align = this.align[colIdx];
        if (align) td.style.textAlign = align;
        const cellText = cell.map((node) => ('value' in node ? node.value : node.raw)).join('') || ' ';
        td.textContent = cellText;

        td.addEventListener('click', (e) => {
          e.stopPropagation();
          const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
          view.dispatch({
            effects: setTableTargetEffect.of({ tableFrom: currentWidget.from, activeRow: rowIdx, activeCol: colIdx })
          });
          const updateButtons = (container as any).__nexusUpdateTableToolbar;
          if (typeof updateButtons === 'function') updateButtons();
          if (view.state.readOnly) return;
          this.startCellEdit(view, td, rowIdx, colIdx, cellText);
        });

        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  private startCellEdit(
    view: EditorView,
    cellEl: HTMLElement,
    rowIndex: number,
    colIndex: number,
    initialValue: string
  ): void {
    if (view.state.readOnly || cellEl.querySelector('.cm-table-cell-editor')) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cm-table-cell-editor';
    input.value = initialValue.trim();

    cellEl.textContent = '';
    cellEl.appendChild(input);
    input.focus();
    input.select();

    const controller = createSubEditorController(view, () => {
      // 取消、只读切换和无变更退出都恢复展示；提交后由新投影显示新正文。
      if (cellEl.contains(input)) cellEl.textContent = initialValue;
    });
    const { signal } = controller;

    let isComposing = false;
    input.addEventListener(
      'compositionstart',
      () => {
        isComposing = true;
      },
      { signal }
    );
    input.addEventListener(
      'compositionend',
      () => {
        isComposing = false;
      },
      { signal }
    );

    const commit = () => {
      if (!controller.isActive() || view.state.readOnly) {
        controller.close();
        return;
      }

      const newValue = input.value;
      if (newValue === initialValue.trim()) {
        controller.close();
        return;
      }
      const source = view.state.doc.toString();
      if (this.to > source.length || source.slice(this.from, this.to) !== this.raw) {
        controller.close();
        return;
      }
      const tableCtx = findTableAtPosition(source, this.from);
      if (tableCtx) {
        const lines = splitTableLines(tableCtx.raw, tableCtx.tableRange.from);
        const targetLineIdx = rowIndex === -1 ? 0 : 2 + rowIndex;
        if (targetLineIdx < lines.length) {
          const line = lines[targetLineIdx]!;
          const match = line.text.match(/^([ \t]*(?:>[ \t]*)*)/);
          const prefixLen = match ? match[0]!.length : 0;
          const cleanText = line.text.slice(prefixLen);
          const ranges = getRowCellRanges(cleanText, line.from + prefixLen);
          if (colIndex < ranges.length) {
            const r = ranges[colIndex]!;
            const cellCtx: TableCellContext = {
              tableRange: tableCtx.tableRange,
              cellRange: { from: r.from, to: r.to },
              slotRange: { from: r.slotStart + prefixLen, to: r.slotEnd + prefixLen },
              rowIndex,
              colIndex,
              cellRaw: cleanText.slice(r.slotStart, r.slotEnd),
              tableContext: tableCtx
            };
            const tx = createTableCellEditTransaction(source, cellCtx, newValue);
            if (tx) {
              controller.close();
              view.dispatch({
                changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
                userEvent: tx.userEvent
              });
              return;
            }
          }
        }
      }
      controller.close();
    };

    input.addEventListener(
      'keydown',
      (e) => {
        if (!controller.isActive() || isComposing || e.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          controller.close();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          commit();
          const nextCol = e.shiftKey ? colIndex - 1 : colIndex + 1;
          const lifecycle = view.plugin(subEditorLifecyclePlugin);
          const currentGen = lifecycle ? lifecycle.generation : 0;
          queueMicrotask(() => {
            if (!lifecycle || lifecycle.disposed || lifecycle.generation !== currentGen) return;
            const targetCell = view.dom.querySelector(
              `.cm-visual-table [data-row="${rowIndex}"][data-col="${nextCol}"]`
            ) as HTMLElement | null;
            if (targetCell && !view.state.readOnly) {
              targetCell.click();
            }
          });
        }
      },
      { signal }
    );

    input.addEventListener(
      'blur',
      () => {
        if (controller.isActive() && !isComposing) {
          commit();
        }
      },
      { signal }
    );
  }

  public ignoreEvent(): boolean {
    return false;
  }

  public override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    if (!dom.classList.contains('cm-visual-table-container')) {
      return false;
    }
    (dom as any).__nexusTableWidget = this;
    const oldTable = dom.querySelector('.cm-visual-table');
    const newTable = this.buildTableDOM(view, dom);
    if (oldTable) {
      dom.replaceChild(newTable, oldTable);
    } else {
      dom.appendChild(newTable);
    }
    const updateButtons = (dom as any).__nexusUpdateTableToolbar;
    if (typeof updateButtons === 'function') {
      updateButtons();
    }
    return true;
  }
}

export class CodeBlockWidget extends WidgetType {
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly language: string | undefined,
    public readonly value: string
  ) {
    super();
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof CodeBlockWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.language === this.language &&
      other.value === this.value
    );
  }

  public toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-visual-code-block';

    const header = document.createElement('div');
    header.className = 'cm-code-header';

    const langBadge = document.createElement('span');
    langBadge.className = 'cm-code-language';
    langBadge.textContent = this.language || 'text';

    langBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      if (view.state.readOnly) return;
      if (header.querySelector('.cm-code-lang-input')) return;

      const langInput = document.createElement('input');
      langInput.type = 'text';
      langInput.className = 'cm-code-lang-input';
      langInput.value = this.language || '';

      langBadge.style.display = 'none';
      header.insertBefore(langInput, langBadge);
      langInput.focus();
      langInput.select();

      const controller = createSubEditorController(view, () => {
        langInput.remove();
        langBadge.style.display = '';
      });
      const { signal } = controller;

      let isComposing = false;
      langInput.addEventListener(
        'compositionstart',
        () => {
          isComposing = true;
        },
        { signal }
      );
      langInput.addEventListener(
        'compositionend',
        () => {
          isComposing = false;
        },
        { signal }
      );

      const commit = () => {
        if (!controller.isActive() || view.state.readOnly) {
          controller.close();
          return;
        }
        const nextLanguage = langInput.value.trim();
        const src = view.state.doc.toString();
        const parsed = parseMarkdown(src);
        let target: Extract<MarkdownBlockNode, { type: 'code-block' }> | null = null;
        walkBlockNodes(parsed.root.children, (child) => {
          if (child.type === 'code-block' && child.range.from === this.from) {
            target = child;
            return true;
          }
          return false;
        });
        if (target) {
          const ctx = parseCodeBlockContext(src, target);
          const tx = createCodeBlockLanguageTransaction(src, ctx, nextLanguage);
          if (tx) {
            controller.close();
            view.dispatch({ changes: tx.changes, userEvent: tx.userEvent });
            return;
          }
        }
        controller.close();
      };

      langInput.addEventListener(
        'keydown',
        (ke) => {
          if (!controller.isActive() || isComposing || ke.isComposing) return;
          if (ke.key === 'Enter') {
            ke.preventDefault();
            ke.stopPropagation();
            commit();
          } else if (ke.key === 'Escape') {
            ke.preventDefault();
            ke.stopPropagation();
            controller.close();
          }
        },
        { signal }
      );

      langInput.addEventListener(
        'blur',
        () => {
          if (controller.isActive() && !isComposing) commit();
        },
        { signal }
      );
    });

    header.appendChild(langBadge);

    const isMermaid = this.language === 'mermaid';
    let toggleBtn: HTMLButtonElement | null = null;

    if (isMermaid) {
      toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'cm-mermaid-toggle';
      toggleBtn.textContent = 'Source';
      header.appendChild(toggleBtn);
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'cm-code-copy-btn';
    copyBtn.textContent = 'Copy';

    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (this.copyTimer) {
        clearTimeout(this.copyTimer);
        this.copyTimer = null;
      }
      if (!navigator.clipboard?.writeText) {
        copyBtn.dataset.copyState = 'error';
        copyBtn.textContent = 'Failed';
        copyBtn.title = 'Copy failed';
        return;
      }
      navigator.clipboard
        .writeText(this.value)
        .then(() => {
          copyBtn.dataset.copyState = 'success';
          copyBtn.textContent = 'Copied!';
          this.copyTimer = setTimeout(() => {
            copyBtn.textContent = 'Copy';
            delete copyBtn.dataset.copyState;
            this.copyTimer = null;
          }, 2000);
        })
        .catch(() => {
          copyBtn.dataset.copyState = 'error';
          copyBtn.textContent = 'Failed';
          copyBtn.title = 'Copy failed';
        });
    });
    header.appendChild(copyBtn);
    container.appendChild(header);

    let previewEl: HTMLElement | null = null;
    if (isMermaid) {
      previewEl = document.createElement('div');
      previewEl.className = 'cm-mermaid-preview';
      const previewPre = document.createElement('pre');
      previewPre.textContent = this.value;
      previewEl.appendChild(previewPre);
      container.appendChild(previewEl);
    }

    const pre = document.createElement('pre');
    pre.className = 'cm-code-body';
    const code = document.createElement('code');
    code.textContent = this.value;
    pre.appendChild(code);
    container.appendChild(pre);

    if (isMermaid && toggleBtn && previewEl) {
      let isShowingPreview = true;
      pre.style.display = 'none';
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        isShowingPreview = !isShowingPreview;
        if (isShowingPreview) {
          previewEl!.style.display = '';
          pre.style.display = 'none';
          toggleBtn!.textContent = 'Source';
        } else {
          previewEl!.style.display = 'none';
          pre.style.display = '';
          toggleBtn!.textContent = 'Preview';
        }
      });
    }

    pre.addEventListener('click', (e) => {
      e.stopPropagation();
      if (view.state.readOnly) return;
      if (container.querySelector('.cm-code-editor')) return;

      const textarea = document.createElement('textarea');
      textarea.className = 'cm-code-editor';
      textarea.value = this.value;

      pre.style.display = 'none';
      container.appendChild(textarea);
      textarea.focus();

      const controller = createSubEditorController(view, () => {
        textarea.remove();
        pre.style.display = '';
      });
      const { signal } = controller;

      let isComposing = false;
      textarea.addEventListener(
        'compositionstart',
        () => {
          isComposing = true;
        },
        { signal }
      );
      textarea.addEventListener(
        'compositionend',
        () => {
          isComposing = false;
        },
        { signal }
      );

      const commit = () => {
        if (!controller.isActive() || view.state.readOnly) {
          controller.close();
          return;
        }
        const src = view.state.doc.toString();
        const parsed = parseMarkdown(src);
        let target: Extract<MarkdownBlockNode, { type: 'code-block' }> | null = null;
        walkBlockNodes(parsed.root.children, (child) => {
          if (child.type === 'code-block' && child.range.from === this.from) {
            target = child;
            return true;
          }
          return false;
        });
        if (target) {
          const ctx = parseCodeBlockContext(src, target);
          const tx = createCodeBlockValueTransaction(src, ctx, textarea.value);
          if (tx) {
            controller.close();
            view.dispatch({ changes: tx.changes, userEvent: tx.userEvent });
            return;
          }
        }
        controller.close();
      };

      textarea.addEventListener(
        'keydown',
        (ke) => {
          if (!controller.isActive() || isComposing || ke.isComposing) return;
          if (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey)) {
            ke.preventDefault();
            ke.stopPropagation();
            commit();
          } else if (ke.key === 'Escape') {
            ke.preventDefault();
            ke.stopPropagation();
            controller.close();
          }
        },
        { signal }
      );

      textarea.addEventListener(
        'blur',
        () => {
          if (controller.isActive() && !isComposing) commit();
        },
        { signal }
      );
    });

    return container;
  }

  public destroy(): void {
    if (this.copyTimer) {
      clearTimeout(this.copyTimer);
      this.copyTimer = null;
    }
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

export class BlockMathWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly formula: string
  ) {
    super();
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof BlockMathWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.formula === this.formula
    );
  }

  public toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-visual-block-math';
    container.textContent = `$$ ${this.formula} $$`;

    container.addEventListener('click', (e) => {
      e.stopPropagation();
      if (view.state.readOnly) return;
      if (container.querySelector('.cm-block-math-editor')) return;

      const textarea = document.createElement('textarea');
      textarea.className = 'cm-block-math-editor';
      textarea.value = this.formula;

      container.textContent = '';
      container.appendChild(textarea);
      textarea.focus();

      const controller = createSubEditorController(view, () => {
        if (container.contains(textarea)) textarea.remove();
        container.textContent = `$$ ${this.formula} $$`;
      });
      const { signal } = controller;

      let isComposing = false;
      textarea.addEventListener(
        'compositionstart',
        () => {
          isComposing = true;
        },
        { signal }
      );
      textarea.addEventListener(
        'compositionend',
        () => {
          isComposing = false;
        },
        { signal }
      );

      const commit = () => {
        if (!controller.isActive() || view.state.readOnly) {
          controller.close();
          return;
        }
        const src = view.state.doc.toString();
        const parsed = parseMarkdown(src);
        let target: Extract<MarkdownBlockNode, { type: 'block-math' }> | null = null;
        walkBlockNodes(parsed.root.children, (child) => {
          if (child.type === 'block-math' && child.range.from === this.from) {
            target = child;
            return true;
          }
          return false;
        });
        if (target) {
          const ctx = parseBlockMathContext(src, target);
          const tx = createBlockMathEditTransaction(src, ctx, textarea.value);
          if (tx) {
            controller.close();
            view.dispatch({ changes: tx.changes, userEvent: tx.userEvent });
            return;
          }
        }
        controller.close();
      };

      textarea.addEventListener(
        'keydown',
        (ke) => {
          if (!controller.isActive() || isComposing || ke.isComposing) return;
          if (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey)) {
            ke.preventDefault();
            ke.stopPropagation();
            commit();
          } else if (ke.key === 'Escape') {
            ke.preventDefault();
            ke.stopPropagation();
            controller.close();
          }
        },
        { signal }
      );

      textarea.addEventListener(
        'blur',
        () => {
          if (controller.isActive() && !isComposing) commit();
        },
        { signal }
      );
    });

    return container;
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

export class RawBlockWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string
  ) {
    super();
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof RawBlockWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw
    );
  }

  public toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-visual-raw-block';
    container.textContent = this.raw;

    container.addEventListener('click', (e) => {
      e.stopPropagation();
      if (view.state.readOnly) return;
      if (container.querySelector('.cm-raw-block-editor')) return;

      const trailing = this.raw.match(/(\r?\n)+$/);
      const trailingNl = trailing ? trailing[0]! : '';

      const textarea = document.createElement('textarea');
      textarea.className = 'cm-raw-block-editor';
      textarea.value = this.raw.slice(0, this.raw.length - trailingNl.length);

      container.textContent = '';
      container.appendChild(textarea);
      textarea.focus();

      const controller = createSubEditorController(view, () => {
        if (container.contains(textarea)) textarea.remove();
        container.textContent = this.raw;
      });
      const { signal } = controller;

      let isComposing = false;
      textarea.addEventListener(
        'compositionstart',
        () => {
          isComposing = true;
        },
        { signal }
      );
      textarea.addEventListener(
        'compositionend',
        () => {
          isComposing = false;
        },
        { signal }
      );

      const commit = () => {
        if (!controller.isActive() || view.state.readOnly) {
          controller.close();
          return;
        }
        const newRaw = textarea.value + trailingNl;
        controller.close();
        view.dispatch({
          changes: [{ from: this.from, to: this.to, insert: newRaw }],
          userEvent: RAW_BLOCK_EDIT_USER_EVENT
        });
      };

      textarea.addEventListener(
        'keydown',
        (ke) => {
          if (!controller.isActive() || isComposing || ke.isComposing) return;
          if (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey)) {
            ke.preventDefault();
            ke.stopPropagation();
            commit();
          } else if (ke.key === 'Escape') {
            ke.preventDefault();
            ke.stopPropagation();
            controller.close();
          }
        },
        { signal }
      );

      textarea.addEventListener(
        'blur',
        () => {
          if (controller.isActive() && !isComposing) commit();
        },
        { signal }
      );
    });

    return container;
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 构建最小 Visual surface 投影。
 * source 仍然是 EditorState.doc，视觉层只通过 decoration/widget 隐藏语法定界符。
 */
/**
 * 构建最小 Visual surface 投影。
 * source 仍然是 EditorState.doc，视觉层只通过 decoration/widget 隐藏语法定界符。
 */
export function buildVisualProjection(
  source: string,
  selection: EditorSelection | null = null,
  isFocused: boolean = false,
  documentDirectory: string | null = null
): DecorationSet {
  const ranges: ProjectionRange[] = [];
  const { root } = parseMarkdown(source);

  const selFrom = selection ? Math.min(selection.main.anchor, selection.main.head) : -1;
  const selTo = selection ? Math.max(selection.main.anchor, selection.main.head) : -1;

  function isNodeRevealed(range: SourceRange): boolean {
    if (!isFocused || !selection || selFrom === -1) return false;
    if (selFrom === selTo) {
      return selFrom > range.from && selTo < range.to;
    }
    return selFrom < range.to && selTo > range.from;
  }

  const opaqueBlockRanges: SourceRange[] = [];
  walkBlockNodes(root.children, (block) => {
    if (
      block.type === 'table' ||
      block.type === 'code-block' ||
      block.type === 'block-math' ||
      block.type === 'raw'
    ) {
      opaqueBlockRanges.push(block.range);
    }
  });

  for (const marker of findMarkdownMarkers(source)) {
    if (marker.type === 'inline-math' || marker.type === 'wikilink') continue;
    const insideOpaque = opaqueBlockRanges.some((b) => marker.from >= b.from && marker.to <= b.to);
    if (insideOpaque) continue;
    ranges.push({
      from: marker.from,
      to: marker.to,
      decoration: Decoration.mark({ class: `cm-visual-marker cm-visual-marker-${marker.type}` })
    });
  }

  function walkInline(inlineNode: MarkdownInlineNode): void {
    if (inlineNode.type === 'bold') {
      const delim = inlineNode.raw.startsWith('**') ? '**' : (inlineNode.raw.startsWith('__') ? '__' : '**');
      const isRevealed = isNodeRevealed(inlineNode.range);
      ranges.push({
        from: inlineNode.range.from,
        to: inlineNode.range.from + delim.length,
        decoration: Decoration.replace({ widget: new DelimiterWidget(delim, isRevealed) })
      });
      ranges.push({
        from: inlineNode.range.to - delim.length,
        to: inlineNode.range.to,
        decoration: Decoration.replace({ widget: new DelimiterWidget(delim, isRevealed) })
      });
      for (const child of inlineNode.children) {
        walkInline(child);
      }
    } else if (inlineNode.type === 'italic') {
      const delim = inlineNode.raw.startsWith('*') ? '*' : (inlineNode.raw.startsWith('_') ? '_' : '*');
      const isRevealed = isNodeRevealed(inlineNode.range);
      ranges.push({
        from: inlineNode.range.from,
        to: inlineNode.range.from + delim.length,
        decoration: Decoration.replace({ widget: new DelimiterWidget(delim, isRevealed) })
      });
      ranges.push({
        from: inlineNode.range.to - delim.length,
        to: inlineNode.range.to,
        decoration: Decoration.replace({ widget: new DelimiterWidget(delim, isRevealed) })
      });
      for (const child of inlineNode.children) {
        walkInline(child);
      }
    } else if (inlineNode.type === 'strike') {
      const raw =
        typeof inlineNode.raw === 'string' && inlineNode.raw.length > 0
          ? inlineNode.raw
          : source && inlineNode.range
            ? source.slice(inlineNode.range.from, inlineNode.range.to)
            : '';
      const delim = raw.startsWith('~') && !raw.startsWith('~~') ? '~' : '~~';
      const delimLen = delim.length;
      const isRevealed = isNodeRevealed(inlineNode.range);
      ranges.push({
        from: inlineNode.range.from,
        to: inlineNode.range.from + delimLen,
        decoration: Decoration.replace({ widget: new DelimiterWidget(delim, isRevealed) })
      });
      ranges.push({
        from: inlineNode.range.to - delimLen,
        to: inlineNode.range.to,
        decoration: Decoration.replace({ widget: new DelimiterWidget(delim, isRevealed) })
      });
      if (inlineNode.range.to - delimLen > inlineNode.range.from + delimLen) {
        ranges.push({
          from: inlineNode.range.from + delimLen,
          to: inlineNode.range.to - delimLen,
          decoration: Decoration.mark({ class: 'cm-visual-strike' })
        });
      }
      for (const child of inlineNode.children) {
        walkInline(child);
      }
    } else if (inlineNode.type === 'link') {
      const isRevealed = isNodeRevealed(inlineNode.range);
      if (isRevealed) {
        const rightBracketIdx = inlineNode.raw.indexOf(']');
        if (rightBracketIdx !== -1) {
          const closeFrom = inlineNode.range.from + rightBracketIdx;
          const closeDelim = inlineNode.raw.slice(rightBracketIdx);
          ranges.push({
            from: inlineNode.range.from,
            to: inlineNode.range.from + 1,
            decoration: Decoration.replace({ widget: new DelimiterWidget('[', true) })
          });
          if (closeFrom < inlineNode.range.to) {
            ranges.push({
              from: closeFrom,
              to: inlineNode.range.to,
              decoration: Decoration.replace({ widget: new DelimiterWidget(closeDelim, true) })
            });
          }
          for (const child of inlineNode.children) {
            walkInline(child);
          }
        } else {
          for (const child of inlineNode.children) {
            walkInline(child);
          }
        }
      } else {
        const label = getInlineNodePlainText(inlineNode);
        ranges.push({
          from: inlineNode.range.from,
          to: inlineNode.range.to,
          decoration: Decoration.replace({
            widget: new LinkWidget(
              inlineNode.range.from,
              inlineNode.range.to,
              inlineNode.raw,
              label,
              inlineNode.safeHref,
              Boolean(inlineNode.isBlocked),
              inlineNode.title
            )
          })
        });
      }
    } else if (inlineNode.type === 'image') {
      const displaySrc = inlineNode.isBlocked
        ? null
        : resolveDocumentAssetUrl(inlineNode.src, documentDirectory);
      ranges.push({
        from: inlineNode.range.from,
        to: inlineNode.range.to,
        decoration: Decoration.replace({
          widget: new ImageWidget(
            inlineNode.range.from,
            inlineNode.range.to,
            inlineNode.raw,
            inlineNode.alt,
            inlineNode.safeSrc,
            Boolean(inlineNode.isBlocked),
            inlineNode.title,
            displaySrc
          )
        })
      });
    } else if (inlineNode.type === 'inline-math') {
      ranges.push({
        from: inlineNode.range.from,
        to: inlineNode.range.to,
        decoration: Decoration.replace({
          widget: new InlineMathWidget(
            inlineNode.range.from,
            inlineNode.range.to,
            inlineNode.raw,
            inlineNode.formula
          )
        })
      });
    } else if (inlineNode.type === 'inline-code') {
      ranges.push({
        from: inlineNode.range.from,
        to: inlineNode.range.to,
        decoration: Decoration.replace({
          widget: new InlineCodeWidget(
            inlineNode.range.from,
            inlineNode.range.to,
            inlineNode.raw,
            inlineNode.value
          )
        })
      });
    } else if (inlineNode.type === 'wikilink') {
      ranges.push({
        from: inlineNode.range.from,
        to: inlineNode.range.to,
        decoration: Decoration.replace({
          widget: new WikiLinkWidget(
            inlineNode.range.from,
            inlineNode.range.to,
            inlineNode.raw,
            inlineNode.target,
            inlineNode.alias
          )
        })
      });
    }
  }

  function walkBlock(blockNode: MarkdownBlockNode): void {
    if (blockNode.type === 'heading') {
      const match = blockNode.raw.match(/^([ \t]*)(#{1,6})/);
      if (match && match[2]) {
        const indentLen = (match[1] ?? '').length;
        const hashLen = match[2].length;
        const from = blockNode.range.from + indentLen;
        const isRevealed = isNodeRevealed(blockNode.range);
        ranges.push({
          from,
          to: from + hashLen,
          decoration: Decoration.replace({ widget: new DelimiterWidget(match[2], isRevealed) })
        });
      }
      for (const child of blockNode.children) {
        walkInline(child);
      }
    } else if (blockNode.type === 'paragraph') {
      for (const child of blockNode.children) {
        walkInline(child);
      }
    } else if (blockNode.type === 'blockquote') {
      const isRevealed = isNodeRevealed(blockNode.range);
      let offset = 0;
      while (offset < blockNode.raw.length) {
        const lineStart = offset;
        const nextNl = blockNode.raw.indexOf('\n', lineStart);
        const lineEnd = nextNl === -1 ? blockNode.raw.length : nextNl;
        const lineText = blockNode.raw.slice(lineStart, lineEnd);
        const match = lineText.match(/^([ \t]*)(>)/);
        if (match && match[2]) {
          const from = blockNode.range.from + lineStart + (match[1]?.length ?? 0);
          const to = from + 1;
          ranges.push({
            from,
            to,
            decoration: Decoration.replace({ widget: new DelimiterWidget('>', isRevealed) })
          });
        }
        if (nextNl === -1) break;
        offset = nextNl + 1;
      }
      for (const child of blockNode.children) {
        walkBlock(child);
      }
    } else if (blockNode.type === 'list') {
      for (const item of blockNode.items) {
        walkListItem(item);
      }
    } else if (blockNode.type === 'horizontal-rule') {
      ranges.push({
        from: blockNode.range.from,
        to: blockNode.range.to,
        decoration: Decoration.replace({
          widget: new HorizontalRuleWidget(
            blockNode.range.from,
            blockNode.range.to,
            blockNode.raw
          ),
          block: true
        })
      });
    } else if (blockNode.type === 'table') {
      ranges.push({
        from: blockNode.range.from,
        to: blockNode.range.to,
        decoration: Decoration.replace({
          widget: new TableBlockWidget(
            blockNode.range.from,
            blockNode.range.to,
            blockNode.raw,
            blockNode.headers,
            blockNode.rows,
            blockNode.align
          ),
          block: true
        })
      });
    } else if (blockNode.type === 'code-block') {
      ranges.push({
        from: blockNode.range.from,
        to: blockNode.range.to,
        decoration: Decoration.replace({
          widget: new CodeBlockWidget(
            blockNode.range.from,
            blockNode.range.to,
            blockNode.raw,
            blockNode.language,
            blockNode.value
          ),
          block: true
        })
      });
    } else if (blockNode.type === 'block-math') {
      ranges.push({
        from: blockNode.range.from,
        to: blockNode.range.to,
        decoration: Decoration.replace({
          widget: new BlockMathWidget(
            blockNode.range.from,
            blockNode.range.to,
            blockNode.raw,
            blockNode.formula
          ),
          block: true
        })
      });
    } else if (blockNode.type === 'raw') {
      ranges.push({
        from: blockNode.range.from,
        to: blockNode.range.to,
        decoration: Decoration.replace({
          widget: new RawBlockWidget(
            blockNode.range.from,
            blockNode.range.to,
            blockNode.raw
          ),
          block: true
        })
      });
    }
  }

  function walkListItem(item: MarkdownListItem): void {
    const isRevealed = isNodeRevealed(item.range);
    if (item.task) {
      const firstLine = item.raw.split(/\r?\n/)[0] ?? '';
      const match = firstLine.match(/^([ \t]*>(?:[ \t]*>)*)?([ \t]*(?:[-+*]|\d+[.)])[ \t]+)(\[[ xX]\])/);
      if (match && match[3]) {
        const prefixLen = (match[1] ?? '').length + (match[2] ?? '').length;
        const from = item.range.from + prefixLen;
        const to = from + match[3].length;
        const isChecked = Boolean(item.checked);
        ranges.push({
          from,
          to,
          decoration: Decoration.replace({ widget: new TaskCheckboxWidget(isChecked, from, to) })
        });
      }
    } else {
      const firstLine = item.raw.split(/\r?\n/)[0] ?? '';
      const match = firstLine.match(/^([ \t]*)([-+*]|\d+[.)])/);
      if (match && match[2]) {
        const from = item.range.from + (match[1]?.length ?? 0);
        const to = from + match[2].length;
        ranges.push({
          from,
          to,
          decoration: Decoration.replace({ widget: new DelimiterWidget(match[2], isRevealed) })
        });
      }
    }

    const blockTypes = new Set([
      'heading',
      'paragraph',
      'blockquote',
      'list',
      'code-block',
      'block-math',
      'table',
      'raw',
      'horizontal-rule'
    ]);
    for (const child of item.children) {
      if (blockTypes.has(child.type)) {
        walkBlock(child as MarkdownBlockNode);
      } else if (child.type !== 'raw') {
        walkInline(child as MarkdownInlineNode);
      }
    }
  }

  for (const block of root.children) {
    walkBlock(block);
  }

  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) {
    if (range.from <= range.to) {
      builder.add(range.from, range.to, range.decoration);
    }
  }
  return builder.finish();
}

/** Visual surface 的 source-aligned decoration field。 */
export const visualProjectionField = StateField.define<DecorationSet>({
  create(state) {
    const isFocused = state.field(visualFocusField, false);
    const docDir = state.field(documentDirectoryField, false);
    return buildVisualProjection(state.doc.toString(), state.selection, isFocused, docDir);
  },
  update(decorations, transaction) {
    const isFocused = transaction.state.field(visualFocusField, false);
    const docDir = transaction.state.field(documentDirectoryField, false);

    const prevFocused = transaction.startState.field(visualFocusField, false);
    const prevDocDir = transaction.startState.field(documentDirectoryField, false);
    const focusChanged = isFocused !== prevFocused;
    const docDirChanged = docDir !== prevDocDir;
    const readOnlyChanged = transaction.startState.readOnly !== transaction.state.readOnly;
    const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);

    if (
      transaction.docChanged ||
      focusChanged ||
      docDirChanged ||
      readOnlyChanged ||
      selectionChanged ||
      transaction.effects.some((e) => e.is(setComposingEffect) && !e.value)
    ) {
      if (isEditorComposing(transaction.state)) {
        return decorations.map(transaction.changes);
      }
      return buildVisualProjection(
        transaction.state.doc.toString(),
        transaction.state.selection,
        isFocused,
        docDir
      );
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

export const tableWidgetSyncPlugin = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.state.field(tableTargetField, false) !==
          update.startState.field(tableTargetField, false) ||
        update.state.readOnly !== update.startState.readOnly
      ) {
        const containers = update.view.dom.querySelectorAll<HTMLElement>(
          '.cm-visual-table-container'
        );
        containers.forEach((container) => {
          const updater = (container as any).__nexusUpdateTableToolbar;
          if (typeof updater === 'function') {
            updater();
          }
        });
      }
    }
  }
);

/** Visual surface 的基础扩展；不创建第二份文档。 */
export const visualProjectionExtensions: Extension[] = [
  visualFocusField,
  visualFocusPlugin,
  documentDirectoryField,
  tableTargetField,
  tableWidgetSyncPlugin,
  visualProjectionField,
  subEditorLifecyclePlugin
];
