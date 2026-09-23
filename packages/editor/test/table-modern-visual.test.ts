// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  MarkdownDocumentSession,
  createSessionEditorView,
  findTableAtPosition,
  createTableDeleteTransaction,
  createTableResizeTransaction,
  setEditorLocale
} from '../src/index.js';

describe('Phase 2: Modern Table Visual & Floating Controls', () => {
  const tableSource = [
    '# Table Document',
    '',
    '| Col A | Col B |',
    '| :--- | ---: |',
    '| Val 1 | Val 2 |',
    '',
    'After table.'
  ].join('\n');

  describe('Table Transactions: Delete and Resize', () => {
    it('creates table delete transaction and removes entire table block', () => {
      const session = new MarkdownDocumentSession(tableSource);
      const source = session.getSnapshot().source;
      const tableCtx = findTableAtPosition(source, source.indexOf('| Col A'));
      expect(tableCtx).not.toBeNull();

      const tx = createTableDeleteTransaction(source, tableCtx!);
      expect(tx).not.toBeNull();
      expect(tx?.userEvent).toBe('table.delete');

      const updated =
        source.slice(0, tx!.changes[0]!.from) +
        tx!.changes[0]!.insert +
        source.slice(tx!.changes[0]!.to);

      expect(updated).not.toContain('Col A');
      expect(updated).not.toContain('Val 1');
      expect(updated).toContain('# Table Document');
      expect(updated).toContain('After table.');
    });

    it('creates table resize transaction: expands columns and rows preserving existing content', () => {
      const session = new MarkdownDocumentSession(tableSource);
      const source = session.getSnapshot().source;
      const tableCtx = findTableAtPosition(source, source.indexOf('| Col A'));
      expect(tableCtx).not.toBeNull();

      // Original table has 1 header + 1 data row = 2 total rows, 2 columns.
      // Resize to 4 total rows (1 header + 3 data rows) and 3 columns.
      const tx = createTableResizeTransaction(source, tableCtx!, 4, 3);
      expect(tx).not.toBeNull();
      expect(tx?.userEvent).toBe('table.resize');

      const updated =
        source.slice(0, tx!.changes[0]!.from) +
        tx!.changes[0]!.insert +
        source.slice(tx!.changes[0]!.to);

      // Verify preserved contents and alignments
      expect(updated).toContain('Col A');
      expect(updated).toContain('Col B');
      expect(updated).toContain('Val 1');
      expect(updated).toContain('Val 2');

      // Verify new context
      const newCtx = findTableAtPosition(updated, updated.indexOf('| Col A'));
      expect(newCtx).not.toBeNull();
      expect(newCtx!.headers.length).toBe(3);
      expect(newCtx!.rows.length).toBe(3); // 3 data rows
      expect(newCtx!.align[0]).toBe('left');
      expect(newCtx!.align[1]).toBe('right');
    });

    it('creates table resize transaction: shrinks columns and rows preserving remaining cells', () => {
      const source = [
        '| A | B | C |',
        '| --- | --- | --- |',
        '| 1 | 2 | 3 |',
        '| 4 | 5 | 6 |',
        '| 7 | 8 | 9 |'
      ].join('\n');

      const tableCtx = findTableAtPosition(source, 0);
      expect(tableCtx).not.toBeNull();

      // Original: 4 total rows (1 header + 3 data rows), 3 cols.
      // Shrink to 2 total rows (1 header + 1 data row), 2 cols.
      const tx = createTableResizeTransaction(source, tableCtx!, 2, 2);
      expect(tx).not.toBeNull();

      const updated =
        source.slice(0, tx!.changes[0]!.from) +
        tx!.changes[0]!.insert +
        source.slice(tx!.changes[0]!.to);

      const newCtx = findTableAtPosition(updated, 0);
      expect(newCtx).not.toBeNull();
      expect(newCtx!.headers.length).toBe(2);
      expect(newCtx!.rows.length).toBe(1);
    });

    it('rejects invalid resize dimensions (< 1) or no-op identical dimensions', () => {
      const source = tableSource;
      const tableCtx = findTableAtPosition(source, source.indexOf('| Col A'));
      expect(tableCtx).not.toBeNull();

      // Invalid dimensions
      expect(createTableResizeTransaction(source, tableCtx!, 0, 2)).toBeNull();
      expect(createTableResizeTransaction(source, tableCtx!, 2, 0)).toBeNull();

      // Identical dimensions (2 total rows, 2 cols)
      expect(createTableResizeTransaction(source, tableCtx!, 2, 2)).toBeNull();
    });
  });

  describe('DOM: Visual Elements and Floating Toolbar', () => {
    it('renders modern visual table container with horizontal scroll and floating toolbar', () => {
      const session = new MarkdownDocumentSession(tableSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-modern-1',
        surfaceKind: 'visual',
        parent
      });

      const container = handle.view.dom.querySelector('.cm-visual-table-container');
      expect(container).not.toBeNull();

      const table = container!.querySelector('.cm-visual-table');
      expect(table).not.toBeNull();

      // Floating toolbar & buttons
      const toolbar = container!.querySelector('.cm-table-toolbar.cm-table-floating-toolbar');
      expect(toolbar).not.toBeNull();

      expect(toolbar!.querySelector('.cm-table-btn-add-row')).not.toBeNull();
      expect(toolbar!.querySelector('.cm-table-btn-add-col')).not.toBeNull();
      expect(toolbar!.querySelector('.cm-table-btn-del-row')).not.toBeNull();
      expect(toolbar!.querySelector('.cm-table-btn-del-col')).not.toBeNull();
      expect(toolbar!.querySelector('.cm-table-btn-align-left')).not.toBeNull();
      expect(toolbar!.querySelector('.cm-table-btn-align-center')).not.toBeNull();
      expect(toolbar!.querySelector('.cm-table-btn-align-right')).not.toBeNull();
      expect(toolbar!.querySelector('.cm-table-btn-grid-picker')).not.toBeNull();
      expect(toolbar!.querySelector('.cm-table-btn-del-table')).not.toBeNull();

      // Floating handles
      expect(container!.querySelector('.cm-table-handle-add-row')).not.toBeNull();
      expect(container!.querySelector('.cm-table-handle-add-col')).not.toBeNull();

      handle.destroy();
      parent.remove();
    });

    it('renders empty cell placeholder and activates cell on click', () => {
      const emptyCellSource = [
        '| Header 1 | Header 2 |',
        '| --- | --- |',
        '| Val 1 |  |'
      ].join('\n');

      const session = new MarkdownDocumentSession(emptyCellSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-modern-placeholder',
        surfaceKind: 'visual',
        parent
      });

      const emptyCell = handle.view.dom.querySelector('.cm-visual-table td[data-row="0"][data-col="1"]') as HTMLElement;
      expect(emptyCell).not.toBeNull();
      const placeholder = emptyCell.querySelector('.cm-table-cell-placeholder');
      expect(placeholder).not.toBeNull();

      // Click cell to activate
      emptyCell.click();
      expect(emptyCell.classList.contains('is-active')).toBe(true);

      handle.destroy();
      parent.remove();
    });

    it('floating handles append rows and columns', () => {
      const session = new MarkdownDocumentSession(tableSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-modern-handles',
        surfaceKind: 'visual',
        parent
      });

      const handleAddRow = handle.view.dom.querySelector('.cm-table-handle-add-row') as HTMLElement;
      const handleAddCol = handle.view.dom.querySelector('.cm-table-handle-add-col') as HTMLElement;
      expect(handleAddRow).not.toBeNull();
      expect(handleAddCol).not.toBeNull();

      const initialRev = session.getSnapshot().revision;
      handleAddRow.click();
      expect(session.getSnapshot().revision).toBe(initialRev + 1);

      handleAddCol.click();
      expect(session.getSnapshot().revision).toBe(initialRev + 2);

      handle.destroy();
      parent.remove();
    });

    it('toolbar add-row button inserts new row directly below currently focused row', () => {
      const multiRowSource = [
        '| Col A | Col B |',
        '| --- | --- |',
        '| Row 0 | Val 0 |',
        '| Row 1 | Val 1 |'
      ].join('\n');

      const session = new MarkdownDocumentSession(multiRowSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-toolbar-add-row-focused',
        surfaceKind: 'visual',
        parent
      });

      // 1. Focus Row 0 (activeRow = 0)
      const row0Cell = handle.view.dom.querySelector('.cm-visual-table td[data-row="0"][data-col="0"]') as HTMLElement;
      expect(row0Cell).not.toBeNull();
      row0Cell.click();

      // 2. Click toolbar + row button
      const addRowBtn = handle.view.dom.querySelector('.cm-table-btn-add-row') as HTMLButtonElement;
      expect(addRowBtn).not.toBeNull();
      addRowBtn.click();

      // 3. Verify in document: the new row is inserted between Row 0 and Row 1
      const updatedSource = session.getSnapshot().source;
      const lines = updatedSource.trim().split('\n');
      expect(lines.length).toBe(5); // header + delimiter + row0 + newRow + row1
      expect(lines[2]).toContain('Row 0');
      // Line 3 should be the newly inserted blank row
      expect(lines[3]).toMatch(/\|\s+\|\s+\|/);
      // Line 4 should be Row 1 (pushed down)
      expect(lines[4]).toContain('Row 1');

      handle.destroy();
      parent.remove();
    });

    it('toolbar add-column button inserts new column directly to the right of currently focused column', () => {
      const multiColSource = [
        '| Col A | Col B |',
        '| --- | --- |',
        '| Val 0 | Val 1 |'
      ].join('\n');

      const session = new MarkdownDocumentSession(multiColSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-toolbar-add-col-focused',
        surfaceKind: 'visual',
        parent
      });

      // 1. Focus Col A (activeCol = 0)
      const colACell = handle.view.dom.querySelector('.cm-visual-table th[data-col="0"]') as HTMLElement;
      expect(colACell).not.toBeNull();
      colACell.click();

      // 2. Click toolbar + col button
      const addColBtn = handle.view.dom.querySelector('.cm-table-btn-add-col') as HTMLButtonElement;
      expect(addColBtn).not.toBeNull();
      addColBtn.click();

      // 3. Verify in document: the new column is inserted between Col A and Col B
      const updatedSource = session.getSnapshot().source;
      const lines = updatedSource.trim().split('\n');
      // Header: | Col A |   | Col B |
      expect(lines[0]).toMatch(/\|\s*Col A\s*\|\s+\|\s*Col B\s*\|/);
      // Body: | Val 0 |   | Val 1 |
      expect(lines[2]).toMatch(/\|\s*Val 0\s*\|\s+\|\s*Val 1\s*\|/);

      handle.destroy();
      parent.remove();
    });

    it('toolbar add-row and add-column buttons append at the end when no cell is focused', () => {
      const multiColSource = [
        '| Col A | Col B |',
        '| --- | --- |',
        '| Val 0 | Val 1 |'
      ].join('\n');

      const session = new MarkdownDocumentSession(multiColSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-toolbar-add-unfocused',
        surfaceKind: 'visual',
        parent
      });

      // No cell is clicked. Click toolbar add row button.
      const addRowBtn = handle.view.dom.querySelector('.cm-table-btn-add-row') as HTMLButtonElement;
      expect(addRowBtn).not.toBeNull();
      addRowBtn.click();

      // Row should be appended at the bottom (total rows: 2 data rows)
      let lines = session.getSnapshot().source.trim().split('\n');
      expect(lines.length).toBe(4); // header + delimiter + Val0/1 + blank
      expect(lines[2]).toContain('Val 0');
      expect(lines[3]).toMatch(/\|\s+\|\s+\|/);

      // Click toolbar add column button.
      const addColBtn = handle.view.dom.querySelector('.cm-table-btn-add-col') as HTMLButtonElement;
      expect(addColBtn).not.toBeNull();
      addColBtn.click();

      // Column should be appended at the rightmost end (total cols: 3)
      lines = session.getSnapshot().source.trim().split('\n');
      expect(lines[0]).toMatch(/\|\s*Col A\s*\|\s*Col B\s*\|\s+\|/);

      handle.destroy();
      parent.remove();
    });

    it('toolbar add-row button inserts new row at row index 0 when header cell is focused', () => {
      const multiRowSource = [
        '| Col A | Col B |',
        '| --- | --- |',
        '| Row 0 | Val 0 |',
        '| Row 1 | Val 1 |'
      ].join('\n');

      const session = new MarkdownDocumentSession(multiRowSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-toolbar-add-row-header-focused',
        surfaceKind: 'visual',
        parent
      });

      // 1. Focus Header (activeRow = -1)
      const headerCell = handle.view.dom.querySelector('.cm-visual-table th[data-row="-1"][data-col="0"]') as HTMLElement;
      expect(headerCell).not.toBeNull();
      headerCell.click();

      // 2. Click toolbar + row button
      const addRowBtn = handle.view.dom.querySelector('.cm-table-btn-add-row') as HTMLButtonElement;
      expect(addRowBtn).not.toBeNull();
      addRowBtn.click();

      // 3. Verify in document: the new row is inserted directly below header/delimiter (before original Row 0)
      const updatedSource = session.getSnapshot().source;
      const lines = updatedSource.trim().split('\n');
      expect(lines.length).toBe(5); // header + delimiter + newRow + row0 + row1
      // Line 2 should be the newly inserted blank row
      expect(lines[2]).toMatch(/\|\s+\|\s+\|/);
      // Line 3 should be original Row 0 (pushed down)
      expect(lines[3]).toContain('Row 0');
      expect(lines[4]).toContain('Row 1');

      handle.destroy();
      parent.remove();
    });

    it('delete table button removes table from document', () => {
      const session = new MarkdownDocumentSession(tableSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-modern-del-table',
        surfaceKind: 'visual',
        parent
      });

      const delTableBtn = handle.view.dom.querySelector('.cm-table-btn-del-table') as HTMLButtonElement;
      expect(delTableBtn).not.toBeNull();

      delTableBtn.click();
      expect(session.getSnapshot().source).not.toContain('Col A');
      expect(session.getSnapshot().source).toContain('After table.');

      handle.destroy();
      parent.remove();
    });

    it('grid resizer button toggles popover and resizes table', () => {
      const session = new MarkdownDocumentSession(tableSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-modern-grid-picker',
        surfaceKind: 'visual',
        parent
      });

      const gridPickerBtn = handle.view.dom.querySelector('.cm-table-btn-grid-picker') as HTMLButtonElement;
      const popover = handle.view.dom.querySelector('.cm-table-grid-popover') as HTMLElement;
      expect(gridPickerBtn).not.toBeNull();
      expect(popover).not.toBeNull();
      expect(popover.classList.contains('is-visible')).toBe(false);

      // Open popover
      gridPickerBtn.click();
      expect(popover.classList.contains('is-visible')).toBe(true);

      // Click cell 2x2 (3 rows x 3 cols)
      const targetCell = popover.querySelector('.cm-table-grid-cell[data-row="2"][data-col="2"]') as HTMLElement;
      expect(targetCell).not.toBeNull();
      targetCell.click();

      // Check popover closed and table resized
      expect(popover.classList.contains('is-visible')).toBe(false);
      const updatedSource = session.getSnapshot().source;
      const newCtx = findTableAtPosition(updatedSource, updatedSource.indexOf('| Col A'));
      expect(newCtx).not.toBeNull();
      expect(newCtx!.headers.length).toBe(3);
      expect(newCtx!.rows.length).toBe(2);

      handle.destroy();
      parent.remove();
    });
  });

  describe('Standard Keyboard Navigation Flow', () => {
    it('Tab on the last cell of table automatically adds a row and focuses new cell', async () => {
      const session = new MarkdownDocumentSession(tableSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-modern-keyboard-tab-end',
        surfaceKind: 'visual',
        parent
      });

      // The last cell is row 0, col 1 in tableSource (1 data row: row 0)
      const lastCell = handle.view.dom.querySelector('.cm-visual-table td[data-row="0"][data-col="1"]') as HTMLElement;
      expect(lastCell).not.toBeNull();
      lastCell.click();

      const input = lastCell.querySelector('.cm-table-cell-editor') as HTMLInputElement;
      expect(input).not.toBeNull();

      // Press Tab
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

      // Wait for microtask / row addition
      await new Promise((r) => setTimeout(r, 20));

      // A new row (row 1) should have been added
      expect(session.getSnapshot().source).toContain('|   |   |');

      // The editor should now be focused on row 1, col 0
      const newCellInput = handle.view.dom.querySelector(
        '.cm-visual-table td[data-row="1"][data-col="0"] .cm-table-cell-editor'
      );
      expect(newCellInput).not.toBeNull();

      handle.destroy();
      parent.remove();
    });

    it('Enter commits edit and moves down to the cell in the next row', async () => {
      const source = [
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '| 3 | 4 |'
      ].join('\n');

      const session = new MarkdownDocumentSession(source);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-modern-keyboard-enter',
        surfaceKind: 'visual',
        parent
      });

      // Click cell (0, 0)
      const cell00 = handle.view.dom.querySelector('.cm-visual-table td[data-row="0"][data-col="0"]') as HTMLElement;
      cell00.click();

      const input = cell00.querySelector('.cm-table-cell-editor') as HTMLInputElement;
      expect(input).not.toBeNull();
      input.value = 'Updated 1';

      // Press Enter
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      await new Promise((r) => setTimeout(r, 20));

      expect(session.getSnapshot().source).toContain('Updated 1');

      // Should move down to row 1, col 0
      const nextCellInput = handle.view.dom.querySelector(
        '.cm-visual-table td[data-row="1"][data-col="0"] .cm-table-cell-editor'
      );
      expect(nextCellInput).not.toBeNull();

      handle.destroy();
      parent.remove();
    });

    it('Shift + Tab navigates backward to the previous cell', async () => {
      const session = new MarkdownDocumentSession(tableSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-modern-keyboard-shift-tab',
        surfaceKind: 'visual',
        parent
      });

      // Click cell (0, 1)
      const cell01 = handle.view.dom.querySelector('.cm-visual-table td[data-row="0"][data-col="1"]') as HTMLElement;
      cell01.click();

      const input = cell01.querySelector('.cm-table-cell-editor') as HTMLInputElement;
      expect(input).not.toBeNull();

      // Press Shift + Tab
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));

      await new Promise((r) => setTimeout(r, 20));

      // Should focus previous cell (row 0, col 0)
      const prevCellInput = handle.view.dom.querySelector(
        '.cm-visual-table td[data-row="0"][data-col="0"] .cm-table-cell-editor'
      );
      expect(prevCellInput).not.toBeNull();

      handle.destroy();
      parent.remove();
    });

    it('navigates strictly within the target table when document contains multiple tables', async () => {
      const multiTableSource = [
        '# Multi Table Document',
        '',
        '| T1 Col 1 | T1 Col 2 |',
        '| :--- | :--- |',
        '| T1 Data 1 | T1 Data 2 |',
        '',
        'Some intermediate text paragraph.',
        '',
        '| T2 Col 1 | T2 Col 2 |',
        '| :--- | :--- |',
        '| T2 Data 1 | T2 Data 2 |',
        '',
        'End of doc.'
      ].join('\n');

      const session = new MarkdownDocumentSession(multiTableSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-multi-table-tab',
        surfaceKind: 'visual',
        parent
      });

      const tableContainers = handle.view.dom.querySelectorAll('.cm-visual-table-container');
      expect(tableContainers.length).toBe(2);

      const table1Container = tableContainers[0]!;
      const table2Container = tableContainers[1]!;

      // Click cell (0, 0) of Table 2 ('T2 Data 1')
      const table2Cell00 = table2Container.querySelector(
        '.cm-visual-table td[data-row="0"][data-col="0"]'
      ) as HTMLElement;
      expect(table2Cell00).not.toBeNull();
      table2Cell00.click();

      const input = table2Cell00.querySelector('.cm-table-cell-editor') as HTMLInputElement;
      expect(input).not.toBeNull();
      expect(input.value).toBe('T2 Data 1');

      // Press Tab while in Table 2
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

      await new Promise((r) => setTimeout(r, 30));

      // Table 1 must have NO active cell editor
      const table1Editor = table1Container.querySelector('.cm-table-cell-editor');
      expect(table1Editor).toBeNull();

      // Table 2 must have moved to cell (0, 1) ('T2 Data 2')
      const table2Cell01 = table2Container.querySelector(
        '.cm-visual-table td[data-row="0"][data-col="1"]'
      ) as HTMLElement;
      expect(table2Cell01).not.toBeNull();
      const table2NextInput = table2Cell01.querySelector('.cm-table-cell-editor') as HTMLInputElement;
      expect(table2NextInput).not.toBeNull();
      expect(table2NextInput.value).toBe('T2 Data 2');

      handle.destroy();
      parent.remove();
    });
  });

  describe('DOM Hierarchy & Separation of Table Scroll Wrapper', () => {
    it('wraps table element in .cm-visual-table-scroll while placing toolbar and handles in outer container', () => {
      const session = new MarkdownDocumentSession(tableSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-dom-hierarchy',
        surfaceKind: 'visual',
        parent
      });

      const container = handle.view.dom.querySelector('.cm-visual-table-container') as HTMLElement;
      expect(container).not.toBeNull();

      const scrollWrap = container.querySelector('.cm-visual-table-scroll') as HTMLElement;
      expect(scrollWrap).not.toBeNull();

      // Table must be direct child of scrollWrap, NOT container
      const table = scrollWrap.querySelector('.cm-visual-table') as HTMLElement;
      expect(table).not.toBeNull();
      expect(table.parentElement).toBe(scrollWrap);

      // Toolbar must be direct child of container, outside scrollWrap
      const toolbar = container.querySelector('.cm-table-toolbar') as HTMLElement;
      expect(toolbar).not.toBeNull();
      expect(toolbar.parentElement).toBe(container);

      // Handles must be direct children of container, outside scrollWrap
      const handleAddRow = container.querySelector('.cm-table-handle-add-row') as HTMLElement;
      const handleAddCol = container.querySelector('.cm-table-handle-add-col') as HTMLElement;
      expect(handleAddRow).not.toBeNull();
      expect(handleAddCol).not.toBeNull();
      expect(handleAddRow.parentElement).toBe(container);
      expect(handleAddCol.parentElement).toBe(container);

      handle.destroy();
      parent.remove();
    });
  });

  describe('Table Controls Internationalization (i18n)', () => {
    it('renders localized button labels and tooltips in zh-CN and en-US', async () => {
      const session = new MarkdownDocumentSession(tableSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      // Test zh-CN by default
      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-i18n-test',
        surfaceKind: 'visual',
        locale: 'zh-CN',
        parent
      });

      const container = handle.view.dom.querySelector('.cm-visual-table-container') as HTMLElement;
      const addRowBtn = container.querySelector('.cm-table-btn-add-row') as HTMLButtonElement;
      const addColBtn = container.querySelector('.cm-table-btn-add-col') as HTMLButtonElement;
      const delRowBtn = container.querySelector('.cm-table-btn-del-row') as HTMLButtonElement;
      const delColBtn = container.querySelector('.cm-table-btn-del-col') as HTMLButtonElement;
      const handleAddRow = container.querySelector('.cm-table-handle-add-row') as HTMLElement;
      const handleAddCol = container.querySelector('.cm-table-handle-add-col') as HTMLElement;

      expect(addRowBtn.textContent).toBe('+ 行');
      expect(addRowBtn.title).toBe('添加行');
      expect(addColBtn.textContent).toBe('+ 列');
      expect(addColBtn.title).toBe('添加列');
      expect(delRowBtn.textContent).toBe('- 行');
      expect(delRowBtn.title).toBe('删除行');
      expect(delColBtn.textContent).toBe('- 列');
      expect(delColBtn.title).toBe('删除列');
      expect(handleAddRow.title).toBe('添加行');
      expect(handleAddCol.title).toBe('添加列');

      // Reconfigure locale to en-US dynamically
      setEditorLocale(handle.view, 'en-US');
      await new Promise((r) => setTimeout(r, 20));

      const updatedContainer = handle.view.dom.querySelector('.cm-visual-table-container') as HTMLElement;
      const enAddRowBtn = updatedContainer.querySelector('.cm-table-btn-add-row') as HTMLButtonElement;
      const enAddColBtn = updatedContainer.querySelector('.cm-table-btn-add-col') as HTMLButtonElement;
      const enDelRowBtn = updatedContainer.querySelector('.cm-table-btn-del-row') as HTMLButtonElement;
      const enDelColBtn = updatedContainer.querySelector('.cm-table-btn-del-col') as HTMLButtonElement;
      const enHandleAddRow = updatedContainer.querySelector('.cm-table-handle-add-row') as HTMLElement;
      const enHandleAddCol = updatedContainer.querySelector('.cm-table-handle-add-col') as HTMLElement;

      expect(enAddRowBtn.textContent).toBe('+ Row');
      expect(enAddRowBtn.title).toBe('Add Row');
      expect(enAddColBtn.textContent).toBe('+ Col');
      expect(enAddColBtn.title).toBe('Add Column');
      expect(enDelRowBtn.textContent).toBe('- Row');
      expect(enDelRowBtn.title).toBe('Delete Row');
      expect(enDelColBtn.textContent).toBe('- Col');
      expect(enDelColBtn.title).toBe('Delete Column');
      expect(enHandleAddRow.title).toBe('Add Row');
      expect(enHandleAddCol.title).toBe('Add Column');

      handle.destroy();
      parent.remove();
    });
  });

  describe('Table Post-Widget Line Navigation and Spacing', () => {
    it('accurately resolves lines below table in visual mode', () => {
      const session = new MarkdownDocumentSession(tableSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-line-nav-test',
        surfaceKind: 'visual',
        parent
      });

      const container = handle.view.dom.querySelector('.cm-visual-table-container') as HTMLElement;
      expect(container).not.toBeNull();

      // Find the line element for 'After table.'
      const lines = Array.from(handle.view.dom.querySelectorAll('.cm-line'));
      const afterLine = lines.find((l) => l.textContent?.includes('After table.'));
      expect(afterLine).not.toBeUndefined();

      // Ensure doc line for 'After table.' exists and has valid range
      const afterLinePos = session.getSnapshot().source.indexOf('After table.');
      expect(afterLinePos).toBeGreaterThan(0);
      const cmLine = handle.view.state.doc.lineAt(afterLinePos);
      expect(cmLine.text).toBe('After table.');

      // Dispatch selection directly to after table line
      handle.view.dispatch({
        selection: { anchor: afterLinePos, head: afterLinePos }
      });
      expect(handle.view.state.selection.main.head).toBe(afterLinePos);

      handle.destroy();
      parent.remove();
    });
  });
});

