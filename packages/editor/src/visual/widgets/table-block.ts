import { EditorView, WidgetType } from '@codemirror/view';
import { getRowCellRanges, type MarkdownInlineNode } from '@nexus/markdown';
import { translate } from '@nexus/i18n';
import {
  findTableAtPosition,
  createTableAddRowTransaction,
  createTableAddColumnTransaction,
  createTableDeleteRowTransaction,
  createTableDeleteColumnTransaction,
  createTableSetAlignTransaction,
  createTableCellEditTransaction,
  createTableDeleteTransaction,
  createTableResizeTransaction,
  splitTableLines,
  type TableCellContext
} from '../../table-edit.js';
import { createSubEditorController, subEditorLifecyclePlugin } from '../sub-editor.js';
import { setTableTargetEffect, tableTargetField } from '../state.js';
import {
  TABLE_ALIGN_LEFT_ICON_SVG,
  TABLE_ALIGN_CENTER_ICON_SVG,
  TABLE_ALIGN_RIGHT_ICON_SVG,
  TABLE_GRID_ICON_SVG,
  TABLE_TRASH_ICON_SVG,
  populateTableCellDOM,
  serializeTableCellDOM
} from './table.js';

export class TableBlockWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly headers: MarkdownInlineNode[][],
    public readonly rows: MarkdownInlineNode[][][],
    public readonly align: ('left' | 'center' | 'right' | null)[],
    public readonly locale: string = 'zh-CN'
  ) {
    super();
  }

  public get estimatedHeight(): number {
    return Math.max(100, (1 + this.rows.length) * 36 + 50);
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof TableBlockWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.locale === this.locale
    );
  }

  public toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-visual-table-container';
    container.dataset.tableFrom = String(this.from);

    const t = (key: string, vars?: Record<string, string>) => translate(this.locale, key, vars);

    const toolbar = document.createElement('div');
    toolbar.className = 'cm-table-toolbar cm-table-floating-toolbar';

    const addRowBtn = document.createElement('button');
    addRowBtn.type = 'button';
    addRowBtn.className = 'cm-table-btn-add-row';
    addRowBtn.dataset.tableAction = 'add-row';
    addRowBtn.title = t('table.addRow');
    addRowBtn.textContent = t('table.btnRow');

    const addColBtn = document.createElement('button');
    addColBtn.type = 'button';
    addColBtn.className = 'cm-table-btn-add-col';
    addColBtn.dataset.tableAction = 'add-column';
    addColBtn.title = t('table.addColumn');
    addColBtn.textContent = t('table.btnCol');

    const delRowBtn = document.createElement('button');
    delRowBtn.type = 'button';
    delRowBtn.className = 'cm-table-btn-del-row';
    delRowBtn.dataset.tableAction = 'delete-row';
    delRowBtn.title = t('table.deleteRow');
    delRowBtn.textContent = t('table.btnDelRow');

    const delColBtn = document.createElement('button');
    delColBtn.type = 'button';
    delColBtn.className = 'cm-table-btn-del-col';
    delColBtn.dataset.tableAction = 'delete-column';
    delColBtn.title = t('table.deleteColumn');
    delColBtn.textContent = t('table.btnDelCol');

    const alignLeftBtn = document.createElement('button');
    alignLeftBtn.type = 'button';
    alignLeftBtn.className = 'cm-table-btn-align-left';
    alignLeftBtn.dataset.tableAction = 'align-left';
    alignLeftBtn.title = t('table.alignLeft');
    alignLeftBtn.innerHTML = `${TABLE_ALIGN_LEFT_ICON_SVG}<span class="cm-table-btn-text">${t('table.alignLeft')}</span>`;

    const alignCenterBtn = document.createElement('button');
    alignCenterBtn.type = 'button';
    alignCenterBtn.className = 'cm-table-btn-align-center';
    alignCenterBtn.dataset.tableAction = 'align-center';
    alignCenterBtn.title = t('table.alignCenter');
    alignCenterBtn.innerHTML = `${TABLE_ALIGN_CENTER_ICON_SVG}<span class="cm-table-btn-text">${t('table.alignCenter')}</span>`;

    const alignRightBtn = document.createElement('button');
    alignRightBtn.type = 'button';
    alignRightBtn.className = 'cm-table-btn-align-right';
    alignRightBtn.dataset.tableAction = 'align-right';
    alignRightBtn.title = t('table.alignRight');
    alignRightBtn.innerHTML = `${TABLE_ALIGN_RIGHT_ICON_SVG}<span class="cm-table-btn-text">${t('table.alignRight')}</span>`;

    const gridPickerBtn = document.createElement('button');
    gridPickerBtn.type = 'button';
    gridPickerBtn.className = 'cm-table-btn-grid-picker';
    gridPickerBtn.dataset.tableAction = 'grid-picker';
    gridPickerBtn.title = t('table.resizeTable');
    gridPickerBtn.innerHTML = `${TABLE_GRID_ICON_SVG}<span class="cm-table-btn-text">${t('table.btnResize')}</span>`;

    const delTableBtn = document.createElement('button');
    delTableBtn.type = 'button';
    delTableBtn.className = 'cm-table-btn-del-table';
    delTableBtn.dataset.tableAction = 'delete-table';
    delTableBtn.title = t('table.deleteTable');
    delTableBtn.innerHTML = `${TABLE_TRASH_ICON_SVG}<span class="cm-table-btn-text">${t('table.btnDelete')}</span>`;

    // 8x10 Grid Resizer popover
    const gridPopover = document.createElement('div');
    gridPopover.className = 'cm-table-grid-popover';

    const gridMatrix = document.createElement('div');
    gridMatrix.className = 'cm-table-grid-matrix';

    const gridFooter = document.createElement('div');
    gridFooter.className = 'cm-table-grid-footer';

    const MAX_ROWS = 10;
    const MAX_COLS = 8;
    const gridCells: HTMLDivElement[][] = [];

    for (let r = 0; r < MAX_ROWS; r++) {
      gridCells[r] = [];
      for (let c = 0; c < MAX_COLS; c++) {
        const cell = document.createElement('div');
        cell.className = 'cm-table-grid-cell';
        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        gridMatrix.appendChild(cell);
        gridCells[r]![c] = cell;
      }
    }

    const highlightGrid = (rows: number, cols: number) => {
      for (let r = 0; r < MAX_ROWS; r++) {
        for (let c = 0; c < MAX_COLS; c++) {
          gridCells[r]![c]!.classList.toggle('is-highlighted', r < rows && c < cols);
        }
      }
      gridFooter.textContent = t('table.gridFooter', { rows: String(rows), cols: String(cols) });
    };

    gridMatrix.addEventListener('mousemove', (e) => {
      const target = (e.target as HTMLElement).closest('.cm-table-grid-cell') as HTMLElement | null;
      if (!target) return;
      const r = parseInt(target.dataset.row ?? '0', 10);
      const c = parseInt(target.dataset.col ?? '0', 10);
      highlightGrid(r + 1, c + 1);
    });

    gridMatrix.addEventListener('mouseleave', () => {
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const curRows = Math.min(MAX_ROWS, 1 + currentWidget.rows.length);
      const curCols = Math.min(MAX_COLS, currentWidget.headers.length);
      highlightGrid(curRows, curCols);
    });

    gridMatrix.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = (e.target as HTMLElement).closest('.cm-table-grid-cell') as HTMLElement | null;
      if (!target || view.state.readOnly) return;
      const targetRows = parseInt(target.dataset.row ?? '0', 10) + 1;
      const targetCols = parseInt(target.dataset.col ?? '0', 10) + 1;
      gridPopover.classList.remove('is-visible');

      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, currentWidget.from);
      if (tableCtx) {
        const tx = createTableResizeTransaction(source, tableCtx, targetRows, targetCols);
        if (tx) {
          view.dispatch({
            changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
            userEvent: tx.userEvent
          });
        }
      }
    });

    gridPickerBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isVisible = gridPopover.classList.contains('is-visible');
      if (isVisible) {
        gridPopover.classList.remove('is-visible');
      } else {
        const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
        const curRows = Math.min(MAX_ROWS, 1 + currentWidget.rows.length);
        const curCols = Math.min(MAX_COLS, currentWidget.headers.length);
        highlightGrid(curRows, curCols);
        gridPopover.classList.add('is-visible');
      }
    });

    gridPopover.appendChild(gridMatrix);
    gridPopover.appendChild(gridFooter);

    const onDocClick = (e: MouseEvent) => {
      if (!gridPopover.contains(e.target as Node) && !gridPickerBtn.contains(e.target as Node)) {
        gridPopover.classList.remove('is-visible');
      }
    };
    document.addEventListener('click', onDocClick);
    (container as any).__nexusTableDocClickHandler = onDocClick;

    (container as any).__nexusTableWidget = this;
    (container as any).__nexusTableLocale = this.locale;

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
      delTableBtn.disabled = isRo;
      gridPickerBtn.disabled = isRo;

      const currentAlign =
        activeCol !== null && currentWidget.align && activeCol < currentWidget.align.length
          ? currentWidget.align[activeCol]
          : null;
      alignLeftBtn.classList.toggle('is-active', currentAlign === 'left');
      alignCenterBtn.classList.toggle('is-active', currentAlign === 'center');
      alignRightBtn.classList.toggle('is-active', currentAlign === 'right');
    };

    (container as any).__nexusUpdateTableToolbar = updateButtons;

    addRowBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (view.state.readOnly) return;
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const target = view.state.field(tableTargetField, false);
      const activeRow =
        target && target.tableFrom === currentWidget.from ? target.activeRow : null;
      const targetRowIndex =
        activeRow !== null ? (activeRow === -1 ? 0 : activeRow + 1) : undefined;

      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, currentWidget.from);
      if (tableCtx) {
        const tx = createTableAddRowTransaction(source, tableCtx, targetRowIndex);
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
      const target = view.state.field(tableTargetField, false);
      const activeCol =
        target && target.tableFrom === currentWidget.from ? target.activeCol : null;
      const targetColIndex = activeCol !== null ? activeCol + 1 : undefined;

      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, currentWidget.from);
      if (tableCtx) {
        const tx = createTableAddColumnTransaction(source, tableCtx, targetColIndex);
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

    delTableBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (view.state.readOnly) return;
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, currentWidget.from);
      if (tableCtx) {
        const tx = createTableDeleteTransaction(source, tableCtx);
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
    toolbar.appendChild(gridPickerBtn);
    toolbar.appendChild(delTableBtn);
    toolbar.appendChild(gridPopover);
    container.appendChild(toolbar);

    // Floating hover handles for adding rows and columns
    const handleAddRow = document.createElement('div');
    handleAddRow.className = 'cm-table-handle-add-row';
    handleAddRow.title = t('table.addRow');
    handleAddRow.textContent = '+';
    handleAddRow.addEventListener('click', (e) => {
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

    const handleAddCol = document.createElement('div');
    handleAddCol.className = 'cm-table-handle-add-col';
    handleAddCol.title = t('table.addColumn');
    handleAddCol.textContent = '+';
    handleAddCol.addEventListener('click', (e) => {
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

    container.appendChild(handleAddRow);
    container.appendChild(handleAddCol);

    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'cm-visual-table-scroll';
    const table = this.buildTableDOM(view, container);
    scrollWrap.appendChild(table);
    container.appendChild(scrollWrap);

    return container;
  }

  private buildTableDOM(view: EditorView, container: HTMLElement): HTMLTableElement {
    const table = document.createElement('table');
    table.className = 'cm-visual-table';

    const target = view.state.field(tableTargetField, false);
    const activeRow = target && target.tableFrom === this.from ? target.activeRow : null;
    const activeCol = target && target.tableFrom === this.from ? target.activeCol : null;

    const thead = document.createElement('thead');
    const headerTr = document.createElement('tr');
    this.headers.forEach((cell, colIdx) => {
      const th = document.createElement('th');
      th.dataset.row = '-1';
      th.dataset.col = String(colIdx);
      if (activeRow === -1 && activeCol === colIdx) {
        th.classList.add('is-active');
      }
      const align = this.align[colIdx];
      if (align) th.style.textAlign = align;
      populateTableCellDOM(th, cell);

      th.addEventListener('click', (e) => {
        e.stopPropagation();
        table.querySelectorAll('.is-active').forEach((el) => el.classList.remove('is-active'));
        th.classList.add('is-active');
        const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
        view.dispatch({
          effects: setTableTargetEffect.of({ tableFrom: currentWidget.from, activeRow: -1, activeCol: colIdx })
        });
        const updateButtons = (container as any).__nexusUpdateTableToolbar;
        if (typeof updateButtons === 'function') updateButtons();
        if (view.state.readOnly) return;
        this.startCellEdit(view, th, -1, colIdx);
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
        if (activeRow === rowIdx && activeCol === colIdx) {
          td.classList.add('is-active');
        }
        const align = this.align[colIdx];
        if (align) td.style.textAlign = align;
        populateTableCellDOM(td, cell);

        td.addEventListener('click', (e) => {
          e.stopPropagation();
          table.querySelectorAll('.is-active').forEach((el) => el.classList.remove('is-active'));
          td.classList.add('is-active');
          const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
          view.dispatch({
            effects: setTableTargetEffect.of({ tableFrom: currentWidget.from, activeRow: rowIdx, activeCol: colIdx })
          });
          const updateButtons = (container as any).__nexusUpdateTableToolbar;
          if (typeof updateButtons === 'function') updateButtons();
          if (view.state.readOnly) return;
          this.startCellEdit(view, td, rowIdx, colIdx);
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
    colIndex: number
  ): void {
    if (view.state.readOnly || cellEl.querySelector('.cm-table-cell-editor')) return;

    let contentWrap = cellEl.querySelector('.cm-table-cell-content') as HTMLElement | null;
    if (!contentWrap) {
      contentWrap = document.createElement('div');
      contentWrap.className = 'cm-table-cell-content';
      while (cellEl.firstChild) {
        contentWrap.appendChild(cellEl.firstChild);
      }
      cellEl.appendChild(contentWrap);
    }

    contentWrap.classList.add('cm-table-cell-editor');
    contentWrap.contentEditable = 'true';

    // Reveal delimiters in the active cell
    contentWrap.querySelectorAll('.cm-visual-hidden-delimiter').forEach((el) => {
      el.className = 'cm-visual-delimiter-revealed';
    });

    // Remove placeholder span if present
    const placeholder = contentWrap.querySelector('.cm-table-cell-placeholder');
    if (placeholder) {
      placeholder.remove();
      if (!contentWrap.childNodes.length) {
        contentWrap.appendChild(document.createElement('br'));
      }
    }

    // Baseline captured from the rendered DOM rather than from the AST: activating
    // a cell and leaving it without editing must never dispatch a transaction.
    const baselineValue = serializeTableCellDOM(contentWrap);

    // The cell editor is an editable island nested inside CodeMirror's own editable
    // content. Chromium's native SelectAll therefore resolves against the whole
    // editor, so a plain Ctrl/Cmd+A would select the entire document and the next
    // keystroke would replace the file. Scope it to the cell instead.
    const selectAllCellContent = () => {
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(contentWrap!);
      selection.removeAllRanges();
      selection.addRange(range);
    };

    // Property compatibility: .value getter/setter
    Object.defineProperty(contentWrap, 'value', {
      get() {
        return serializeTableCellDOM(contentWrap!);
      },
      set(val: string) {
        contentWrap!.textContent = val;
      },
      configurable: true
    });

    // Selection helper for compatibility
    (contentWrap as any).select = selectAllCellContent;

    contentWrap.focus();

    const controller = createSubEditorController(view, () => {
      if (cellEl.contains(contentWrap)) {
        contentWrap!.contentEditable = 'false';
        contentWrap!.classList.remove('cm-table-cell-editor');
        contentWrap!.querySelectorAll('.cm-visual-delimiter-revealed').forEach((el) => {
          el.className = 'cm-visual-hidden-delimiter';
        });
        if (!contentWrap!.textContent?.trim() && !contentWrap!.querySelector('br')) {
          contentWrap!.textContent = '';
          const placeholder = document.createElement('span');
          placeholder.className = 'cm-table-cell-placeholder';
          const br = document.createElement('br');
          placeholder.appendChild(br);
          contentWrap!.appendChild(placeholder);
        }
      }
    });
    const { signal } = controller;

    let isComposing = false;
    contentWrap.addEventListener(
      'compositionstart',
      () => {
        isComposing = true;
      },
      { signal }
    );
    contentWrap.addEventListener(
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

      const newValue = serializeTableCellDOM(contentWrap!);
      if (newValue === baselineValue) {
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

    const initialContainer = cellEl.closest('.cm-visual-table-container') as HTMLElement | null;
    const currentTableFrom =
      (initialContainer as any)?.__nexusTableWidget?.from ?? this.from;

    const findCurrentTableContainer = (): HTMLElement | null => {
      if (initialContainer && initialContainer.isConnected) return initialContainer;
      return view.dom.querySelector(
        `.cm-visual-table-container[data-table-from="${currentTableFrom}"]`
      );
    };

    contentWrap.addEventListener(
      'keydown',
      (e) => {
        if (!controller.isActive() || isComposing || e.isComposing) return;
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'a') {
          e.preventDefault();
          e.stopPropagation();
          selectAllCellContent();
          return;
        }
        if (e.key === 'Enter' && e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            const br = document.createElement('br');
            range.insertNode(br);
            range.setStartAfter(br);
            range.setEndAfter(br);
            sel.removeAllRanges();
            sel.addRange(range);
          } else {
            contentWrap!.appendChild(document.createElement('br'));
          }
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          commit();
          const targetContainer = findCurrentTableContainer();
          const currentWidget: TableBlockWidget =
            (targetContainer as any)?.__nexusTableWidget || (initialContainer as any)?.__nexusTableWidget || this;
          const nextRow = rowIndex === -1 ? 0 : rowIndex + 1;
          if (nextRow < currentWidget.rows.length) {
            const lifecycle = view.plugin(subEditorLifecyclePlugin);
            const currentGen = lifecycle ? lifecycle.generation : 0;
            queueMicrotask(() => {
              if (!lifecycle || lifecycle.disposed || lifecycle.generation !== currentGen) return;
              const liveContainer = findCurrentTableContainer();
              const targetCell = liveContainer?.querySelector(
                `.cm-visual-table [data-row="${nextRow}"][data-col="${colIndex}"]`
              ) as HTMLElement | null;
              if (targetCell && !view.state.readOnly) {
                targetCell.click();
              }
            });
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          controller.close();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          commit();
          const targetContainer = findCurrentTableContainer();
          const currentWidget: TableBlockWidget =
            (targetContainer as any)?.__nexusTableWidget || (initialContainer as any)?.__nexusTableWidget || this;
          const totalCols = currentWidget.headers.length;
          const totalRows = currentWidget.rows.length;

          if (!e.shiftKey) {
            // Check if last cell in the table
            if (rowIndex === totalRows - 1 && colIndex === totalCols - 1) {
              const source = view.state.doc.toString();
              const tableCtx = findTableAtPosition(source, currentWidget.from);
              if (tableCtx) {
                const tx = createTableAddRowTransaction(source, tableCtx);
                if (tx) {
                  view.dispatch({
                    changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
                    userEvent: tx.userEvent
                  });
                  const newRowIdx = rowIndex + 1;
                  const lifecycle = view.plugin(subEditorLifecyclePlugin);
                  const currentGen = lifecycle ? lifecycle.generation : 0;
                  queueMicrotask(() => {
                    if (!lifecycle || lifecycle.disposed || lifecycle.generation !== currentGen) return;
                    const liveContainer = findCurrentTableContainer();
                    const targetCell = liveContainer?.querySelector(
                      `.cm-visual-table [data-row="${newRowIdx}"][data-col="0"]`
                    ) as HTMLElement | null;
                    if (targetCell && !view.state.readOnly) {
                      targetCell.click();
                    }
                  });
                  return;
                }
              }
            }

            // Normal tab forward
            let nextRow = rowIndex;
            let nextCol = colIndex + 1;
            if (nextCol >= totalCols) {
              nextCol = 0;
              nextRow = rowIndex === -1 ? 0 : rowIndex + 1;
            }
            if (nextRow < totalRows) {
              const lifecycle = view.plugin(subEditorLifecyclePlugin);
              const currentGen = lifecycle ? lifecycle.generation : 0;
              queueMicrotask(() => {
                if (!lifecycle || lifecycle.disposed || lifecycle.generation !== currentGen) return;
                const liveContainer = findCurrentTableContainer();
                const targetCell = liveContainer?.querySelector(
                  `.cm-visual-table [data-row="${nextRow}"][data-col="${nextCol}"]`
                ) as HTMLElement | null;
                if (targetCell && !view.state.readOnly) {
                  targetCell.click();
                }
              });
            }
          } else {
            // Shift + Tab backward
            let prevRow = rowIndex;
            let prevCol = colIndex - 1;
            if (prevCol < 0) {
              prevCol = totalCols - 1;
              prevRow = rowIndex === 0 ? -1 : rowIndex - 1;
            }
            if (prevRow >= -1) {
              const lifecycle = view.plugin(subEditorLifecyclePlugin);
              const currentGen = lifecycle ? lifecycle.generation : 0;
              queueMicrotask(() => {
                if (!lifecycle || lifecycle.disposed || lifecycle.generation !== currentGen) return;
                const liveContainer = findCurrentTableContainer();
                const targetCell = liveContainer?.querySelector(
                  `.cm-visual-table [data-row="${prevRow}"][data-col="${prevCol}"]`
                ) as HTMLElement | null;
                if (targetCell && !view.state.readOnly) {
                  targetCell.click();
                }
              });
            }
          }
        }
      },
      { signal }
    );

    contentWrap.addEventListener(
      'blur',
      () => {
        if (controller.isActive() && !isComposing) {
          commit();
        }
      },
      { signal }
    );
  }

  public ignoreEvent(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    if (!target) return false;
    if (
      target.isContentEditable ||
      target.closest?.('[contenteditable="true"]') ||
      target.closest?.('.cm-table-cell-editor') ||
      target.closest?.('.cm-table-floating-toolbar') ||
      target.closest?.('.cm-table-grid-popover')
    ) {
      return true;
    }
    return false;
  }

  public override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    if (!dom.classList.contains('cm-visual-table-container')) {
      return false;
    }
    (dom as any).__nexusTableWidget = this;
    dom.dataset.tableFrom = String(this.from);

    const scrollWrap = dom.querySelector('.cm-visual-table-scroll') as HTMLElement | null;
    const oldTable = dom.querySelector('.cm-visual-table');
    const newTable = this.buildTableDOM(view, dom);

    if (scrollWrap) {
      if (oldTable && oldTable.parentElement === scrollWrap) {
        scrollWrap.replaceChild(newTable, oldTable);
      } else {
        scrollWrap.appendChild(newTable);
      }
    } else {
      const newScrollWrap = document.createElement('div');
      newScrollWrap.className = 'cm-visual-table-scroll';
      newScrollWrap.appendChild(newTable);
      dom.appendChild(newScrollWrap);
    }

    if ((dom as any).__nexusTableLocale !== this.locale) {
      (dom as any).__nexusTableLocale = this.locale;
      const t = (key: string, vars?: Record<string, string>) => translate(this.locale, key, vars);

      const addRowBtn = dom.querySelector('.cm-table-btn-add-row') as HTMLButtonElement | null;
      if (addRowBtn) {
        addRowBtn.title = t('table.addRow');
        addRowBtn.textContent = t('table.btnRow');
      }
      const addColBtn = dom.querySelector('.cm-table-btn-add-col') as HTMLButtonElement | null;
      if (addColBtn) {
        addColBtn.title = t('table.addColumn');
        addColBtn.textContent = t('table.btnCol');
      }
      const delRowBtn = dom.querySelector('.cm-table-btn-del-row') as HTMLButtonElement | null;
      if (delRowBtn) {
        delRowBtn.title = t('table.deleteRow');
        delRowBtn.textContent = t('table.btnDelRow');
      }
      const delColBtn = dom.querySelector('.cm-table-btn-del-col') as HTMLButtonElement | null;
      if (delColBtn) {
        delColBtn.title = t('table.deleteColumn');
        delColBtn.textContent = t('table.btnDelCol');
      }
      const alignLeftBtn = dom.querySelector('.cm-table-btn-align-left') as HTMLButtonElement | null;
      if (alignLeftBtn) {
        alignLeftBtn.title = t('table.alignLeft');
        const textSpan = alignLeftBtn.querySelector('.cm-table-btn-text');
        if (textSpan) textSpan.textContent = t('table.alignLeft');
      }
      const alignCenterBtn = dom.querySelector('.cm-table-btn-align-center') as HTMLButtonElement | null;
      if (alignCenterBtn) {
        alignCenterBtn.title = t('table.alignCenter');
        const textSpan = alignCenterBtn.querySelector('.cm-table-btn-text');
        if (textSpan) textSpan.textContent = t('table.alignCenter');
      }
      const alignRightBtn = dom.querySelector('.cm-table-btn-align-right') as HTMLButtonElement | null;
      if (alignRightBtn) {
        alignRightBtn.title = t('table.alignRight');
        const textSpan = alignRightBtn.querySelector('.cm-table-btn-text');
        if (textSpan) textSpan.textContent = t('table.alignRight');
      }
      const gridPickerBtn = dom.querySelector('.cm-table-btn-grid-picker') as HTMLButtonElement | null;
      if (gridPickerBtn) {
        gridPickerBtn.title = t('table.resizeTable');
        const textSpan = gridPickerBtn.querySelector('.cm-table-btn-text');
        if (textSpan) textSpan.textContent = t('table.btnResize');
      }
      const delTableBtn = dom.querySelector('.cm-table-btn-del-table') as HTMLButtonElement | null;
      if (delTableBtn) {
        delTableBtn.title = t('table.deleteTable');
        const textSpan = delTableBtn.querySelector('.cm-table-btn-text');
        if (textSpan) textSpan.textContent = t('table.btnDelete');
      }
      const handleAddRow = dom.querySelector('.cm-table-handle-add-row') as HTMLElement | null;
      if (handleAddRow) {
        handleAddRow.title = t('table.addRow');
      }
      const handleAddCol = dom.querySelector('.cm-table-handle-add-col') as HTMLElement | null;
      if (handleAddCol) {
        handleAddCol.title = t('table.addColumn');
      }
    }

    const updateButtons = (dom as any).__nexusUpdateTableToolbar;
    if (typeof updateButtons === 'function') {
      updateButtons();
    }
    view.requestMeasure();
    return true;
  }

  public override destroy(dom: HTMLElement): void {
    const onDocClick = (dom as any).__nexusTableDocClickHandler;
    if (onDocClick) {
      document.removeEventListener('click', onDocClick);
    }
  }
}

