// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  MarkdownDocumentSession,
  createSessionEditorView,
  setEditorReadOnly
} from '../src/index.js';

describe('P1-04E Table Visual Projection & DOM Integration', () => {
  const tableSource = [
    '# Table Document',
    '',
    '| Col A | Col B |',
    '| :--- | ---: |',
    '| Val 1 | Val 2 |',
    '',
    'After table.'
  ].join('\n');

  it('renders visual table widget inside CodeMirror Visual Surface', () => {
    const session = new MarkdownDocumentSession(tableSource);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-table-1',
      surfaceKind: 'visual',
      parent
    });

    const tableElement = handle.view.dom.querySelector('.cm-visual-table');
    expect(tableElement).not.toBeNull();
    const cells = handle.view.dom.querySelectorAll('.cm-visual-table td, .cm-visual-table th');
    expect(cells.length).toBeGreaterThanOrEqual(4);

    handle.destroy();
    parent.remove();
  });

  it('renders Add Row and Add Column controls in visual table widget and dispatches session updates', () => {
    const session = new MarkdownDocumentSession(tableSource);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-table-2',
      surfaceKind: 'visual',
      parent
    });

    const addRowBtn = handle.view.dom.querySelector('.cm-table-btn-add-row') as HTMLButtonElement;
    const addColBtn = handle.view.dom.querySelector('.cm-table-btn-add-col') as HTMLButtonElement;
    expect(addRowBtn).not.toBeNull();
    expect(addColBtn).not.toBeNull();

    const initialRev = session.getSnapshot().revision;
    addRowBtn.click();
    expect(session.getSnapshot().revision).toBe(initialRev + 1);
    expect(session.getSnapshot().source).toContain('|   |   |');

    addColBtn.click();
    expect(session.getSnapshot().revision).toBe(initialRev + 2);

    handle.destroy();
    parent.remove();
  });

  it('enters cell editing on click and commits update on Enter key', () => {
    const session = new MarkdownDocumentSession(tableSource);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-table-3',
      surfaceKind: 'visual',
      parent
    });

    const firstDataCell = handle.view.dom.querySelector('.cm-visual-table td[data-row="0"][data-col="0"]') as HTMLElement;
    expect(firstDataCell).not.toBeNull();

    // Click cell to enter edit mode
    firstDataCell.click();

    const cellInput = firstDataCell.querySelector('.cm-table-cell-editor') as HTMLInputElement;
    expect(cellInput).not.toBeNull();
    expect(cellInput.value).toBe('Val 1');

    // Change value and press Enter
    cellInput.value = 'Updated Value';
    cellInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(session.getSnapshot().source).toContain('Updated Value');

    handle.destroy();
    parent.remove();
  });

  it('respects readOnly mode: cell click does not open editor and buttons do not mutate session', () => {
    const session = new MarkdownDocumentSession(tableSource);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-table-ro',
      surfaceKind: 'visual',
      readOnly: true,
      parent
    });

    const firstDataCell = handle.view.dom.querySelector('.cm-visual-table td[data-row="0"][data-col="0"]') as HTMLElement;
    firstDataCell.click();

    const cellInput = firstDataCell.querySelector('.cm-table-cell-editor');
    expect(cellInput).toBeNull();

    const addRowBtn = handle.view.dom.querySelector('.cm-table-btn-add-row') as HTMLButtonElement;
    const initialRev = session.getSnapshot().revision;
    addRowBtn.click();
    expect(session.getSnapshot().revision).toBe(initialRev);

    handle.destroy();
    parent.remove();
  });

  it('supports dual-surface synchronization and session undo/redo', () => {
    const session = new MarkdownDocumentSession(tableSource);
    const parent1 = document.createElement('div');
    const parent2 = document.createElement('div');
    document.body.appendChild(parent1);
    document.body.appendChild(parent2);

    const handleSource = createSessionEditorView({
      session,
      surfaceId: 'source-surface-1',
      surfaceKind: 'source',
      parent: parent1
    });

    const handleVisual = createSessionEditorView({
      session,
      surfaceId: 'visual-surface-1',
      surfaceKind: 'visual',
      parent: parent2
    });

    // Add row via visual button
    const addRowBtn = handleVisual.view.dom.querySelector('.cm-table-btn-add-row') as HTMLButtonElement;
    addRowBtn.click();

    // Verify source surface received the update
    expect(handleSource.view.state.doc.toString()).toBe(session.getSnapshot().source);
    expect(handleSource.view.state.doc.toString()).toContain('|   |   |');

    // Session undo
    session.undo();
    expect(handleSource.view.state.doc.toString()).toBe(tableSource);
    expect(handleVisual.view.state.doc.toString()).toBe(tableSource);

    // Session redo
    session.redo();
    expect(handleSource.view.state.doc.toString()).toContain('|   |   |');

    handleSource.destroy();
    handleVisual.destroy();
    parent1.remove();
    parent2.remove();
  });

  it('dynamically closes active .cm-table-cell-editor when readOnly is toggled and rejects stale blur/Enter', () => {
    const session = new MarkdownDocumentSession(tableSource);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-table-ro-dyn',
      surfaceKind: 'visual',
      parent
    });

    const firstDataCell = handle.view.dom.querySelector('.cm-visual-table td[data-row="0"][data-col="0"]') as HTMLElement;
    expect(firstDataCell).not.toBeNull();

    // 1. Open cell editor
    firstDataCell.click();
    const cellInput = firstDataCell.querySelector('.cm-table-cell-editor') as HTMLInputElement;
    expect(cellInput).not.toBeNull();
    cellInput.value = 'StaleValue';

    const initialRev = session.getSnapshot().revision;

    // 2. Dynamically toggle readOnly = true
    setEditorReadOnly(handle.view, true);

    // Active cell editor must be closed
    expect(firstDataCell.querySelector('.cm-table-cell-editor')).toBeNull();

    // 3. Stale Enter or blur event on detached input must NOT commit
    cellInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    cellInput.dispatchEvent(new FocusEvent('blur'));
    expect(session.getSnapshot().revision).toBe(initialRev);
    expect(session.getSnapshot().source).not.toContain('StaleValue');

    // 4. Toggle back to editable: can reopen and commit normally
    setEditorReadOnly(handle.view, false);
    const cellAfter = handle.view.dom.querySelector('.cm-visual-table td[data-row="0"][data-col="0"]') as HTMLElement;
    cellAfter.click();
    const newCellInput = cellAfter.querySelector('.cm-table-cell-editor') as HTMLInputElement;
    expect(newCellInput).not.toBeNull();
    newCellInput.value = 'ValidResume';
    newCellInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(session.getSnapshot().revision).toBe(initialRev + 1);
    expect(session.getSnapshot().source).toContain('ValidResume');

    handle.destroy();
    parent.remove();
  });

  it('cleans up pending microtasks and prevents Tab navigation from touching DOM after Surface destroy', async () => {
    const session = new MarkdownDocumentSession(tableSource);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-table-destroy-tab',
      surfaceKind: 'visual',
      parent
    });

    const firstCell = handle.view.dom.querySelector('.cm-visual-table td[data-row="0"][data-col="0"]') as HTMLElement;
    firstCell.click();
    const input = firstCell.querySelector('.cm-table-cell-editor') as HTMLInputElement;
    expect(input).not.toBeNull();

    // Press Tab, which queues a microtask for next cell focus
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

    // Destroy surface immediately before microtask executes
    handle.destroy();
    parent.remove();

    // Wait for microtask to drain
    await new Promise((resolve) => queueMicrotask(resolve));

    // No exception thrown, and document body does not contain open editor
    expect(document.body.querySelector('.cm-table-cell-editor')).toBeNull();
  });
});
