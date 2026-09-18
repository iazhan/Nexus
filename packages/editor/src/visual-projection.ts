import { StateField, RangeSetBuilder, type Extension } from '@codemirror/state';
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
      if (update.state.readOnly) {
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

class HiddenDelimiterWidget extends WidgetType {
  public constructor(private readonly delimiter: string) {
    super();
  }

  public toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = 'cm-visual-hidden-delimiter';
    element.setAttribute('aria-hidden', 'true');
    element.dataset.delimiter = this.delimiter;
    return element;
  }

  public eq(other: WidgetType): boolean {
    return other instanceof HiddenDelimiterWidget && other.delimiter === this.delimiter;
  }

  public ignoreEvent(): boolean {
    return true;
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
    addRowBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (view.state.readOnly) return;
      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, this.from);
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

    const addColBtn = document.createElement('button');
    addColBtn.type = 'button';
    addColBtn.className = 'cm-table-btn-add-col';
    addColBtn.textContent = '+ Col';
    addColBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (view.state.readOnly) return;
      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, this.from);
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

    if (view.state.readOnly) {
      addRowBtn.disabled = true;
      addColBtn.disabled = true;
    }

    toolbar.appendChild(addRowBtn);
    toolbar.appendChild(addColBtn);
    container.appendChild(toolbar);

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
          if (view.state.readOnly) return;
          this.startCellEdit(view, td, rowIdx, colIdx, cellText);
        });

        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);

    return container;
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

    let restoreCellText = false;
    const controller = createSubEditorController(view, () => {
      if (cellEl.contains(input)) input.remove();
      if (restoreCellText) cellEl.textContent = initialValue;
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
        restoreCellText = true;
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
      restoreCellText = true;
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
          restoreCellText = true;
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
    const isRo = view.state.readOnly;
    const addRowBtn = dom.querySelector('.cm-table-btn-add-row') as HTMLButtonElement | null;
    const addColBtn = dom.querySelector('.cm-table-btn-add-col') as HTMLButtonElement | null;
    if (addRowBtn) addRowBtn.disabled = isRo;
    if (addColBtn) addColBtn.disabled = isRo;
    return false;
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
export function buildVisualProjection(source: string): DecorationSet {
  const ranges: ProjectionRange[] = [];
  const { root } = parseMarkdown(source);

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
      ranges.push({
        from: inlineNode.range.from,
        to: inlineNode.range.from + delim.length,
        decoration: Decoration.replace({ widget: new HiddenDelimiterWidget(delim) })
      });
      ranges.push({
        from: inlineNode.range.to - delim.length,
        to: inlineNode.range.to,
        decoration: Decoration.replace({ widget: new HiddenDelimiterWidget(delim) })
      });
      for (const child of inlineNode.children) {
        walkInline(child);
      }
    } else if (inlineNode.type === 'italic') {
      const delim = inlineNode.raw.startsWith('*') ? '*' : (inlineNode.raw.startsWith('_') ? '_' : '*');
      ranges.push({
        from: inlineNode.range.from,
        to: inlineNode.range.from + delim.length,
        decoration: Decoration.replace({ widget: new HiddenDelimiterWidget(delim) })
      });
      ranges.push({
        from: inlineNode.range.to - delim.length,
        to: inlineNode.range.to,
        decoration: Decoration.replace({ widget: new HiddenDelimiterWidget(delim) })
      });
      for (const child of inlineNode.children) {
        walkInline(child);
      }
    } else if (inlineNode.type === 'link') {
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
    } else if (inlineNode.type === 'image') {
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
            inlineNode.title
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
        ranges.push({
          from,
          to: from + hashLen,
          decoration: Decoration.replace({ widget: new HiddenDelimiterWidget(match[2]) })
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
      for (const child of blockNode.children) {
        walkBlock(child);
      }
    } else if (blockNode.type === 'list') {
      for (const item of blockNode.items) {
        walkListItem(item);
      }
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
    }

    const blockTypes = new Set(['heading', 'paragraph', 'blockquote', 'list', 'code-block', 'block-math', 'table', 'raw']);
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
    builder.add(range.from, range.to, range.decoration);
  }
  return builder.finish();
}

/** Visual surface 的 source-aligned decoration field。 */
export const visualProjectionField = StateField.define<DecorationSet>({
  create(state) {
    return buildVisualProjection(state.doc.toString());
  },
  update(decorations, transaction) {
    if (!transaction.docChanged) {
      if (transaction.effects.some((e) => e.is(setComposingEffect) && !e.value)) {
        return buildVisualProjection(transaction.state.doc.toString());
      }
      if (transaction.startState.readOnly !== transaction.state.readOnly) {
        return buildVisualProjection(transaction.state.doc.toString());
      }
      return decorations;
    }
    if (isEditorComposing(transaction.state)) {
      return decorations.map(transaction.changes);
    }
    return buildVisualProjection(transaction.state.doc.toString());
  },
  provide: (field) => EditorView.decorations.from(field)
});

/** Visual surface 的基础扩展；不创建第二份文档。 */
export const visualProjectionExtensions: Extension[] = [visualProjectionField, subEditorLifecyclePlugin];
