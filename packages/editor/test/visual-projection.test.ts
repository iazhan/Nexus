// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  MarkdownDocumentSession,
  createSessionEditorState,
  createSessionEditorView,
  setEditorReadOnly,
  visualProjectionField,
  RawBlockWidget
} from '../src/index.js';

describe('Visual surface projection', () => {
  it('keeps Markdown source as the EditorState document', () => {
    const source = '# Title\n\nThis is **important**.';
    const session = new MarkdownDocumentSession(source);
    const state = createSessionEditorState({
      session,
      surfaceId: 'visual-test',
      surfaceKind: 'visual'
    });

    expect(state.doc.toString()).toBe(source);
  });

  it('uses a decoration/widget projection instead of an HTML document', () => {
    const source = '# Title\n\nThis is **important**.';
    const session = new MarkdownDocumentSession(source);
    const state = createSessionEditorState({
      session,
      surfaceId: 'visual-test',
      surfaceKind: 'visual'
    });
    const ranges: Array<{ from: number; to: number; hasWidget: boolean }> = [];

    state.field(visualProjectionField).between(0, state.doc.length, (from, to, value) => {
      ranges.push({
        from,
        to,
        hasWidget: Boolean(value.spec.widget)
      });
    });

    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.some((range) => range.hasWidget)).toBe(true);
    expect(state.doc.toString()).toBe(source);
  });

  it('does not install visual projection decorations on the Source surface', () => {
    const session = new MarkdownDocumentSession('# Title');
    const state = createSessionEditorState({
      session,
      surfaceId: 'source-test',
      surfaceKind: 'source'
    });

    expect(state.field(visualProjectionField, false)).toBeUndefined();
  });

  it('does not generate TaskCheckboxWidget for - [ ] inside fenced code blocks or raw blocks', () => {
    const source = '```ts\n- [ ] code, not task\n```\n\n<div class="test">\n- [ ] html, not task\n</div>\n\n- [ ] Real task';
    const session = new MarkdownDocumentSession(source);
    const state = createSessionEditorState({
      session,
      surfaceId: 'visual-test',
      surfaceKind: 'visual'
    });

    const checkboxWidgets: Array<{ from: number; to: number }> = [];
    state.field(visualProjectionField).between(0, state.doc.length, (from, to, value) => {
      const widget = value.spec.widget;
      if (widget && 'checked' in widget) {
        checkboxWidgets.push({ from, to });
      }
    });

    // Only the real task list item should have a TaskCheckboxWidget!
    expect(checkboxWidgets).toHaveLength(1);
    const realTaskFrom = source.indexOf('- [ ] Real task') + 2;
    expect(checkboxWidgets[0]?.from).toBe(realTaskFrom);
  });

  it('does not hide escaped markdown delimiters like \\*literal\\*', () => {
    const source = '\\*literal\\*\n\n**bold**';
    const session = new MarkdownDocumentSession(source);
    const state = createSessionEditorState({
      session,
      surfaceId: 'visual-test',
      surfaceKind: 'visual'
    });

    const replacedRanges: Array<{ from: number; to: number; text: string }> = [];
    state.field(visualProjectionField).between(0, state.doc.length, (from, to, value) => {
      if (value.spec.widget) {
        replacedRanges.push({ from, to, text: source.slice(from, to) });
      }
    });

    // Must NOT replace the escaped \*
    expect(replacedRanges.some((r) => r.text.includes('\\*'))).toBe(false);
    expect(replacedRanges.some((r) => r.from === 0 || r.from === 1)).toBe(false);

    // Should replace ** for bold
    const boldIndex = source.indexOf('**bold**');
    expect(replacedRanges.some((r) => r.from === boldIndex)).toBe(true);
  });

  it('does not cross-pair adjacent formatting spans like **one** **two**', () => {
    const source = '**one** **two**';
    const session = new MarkdownDocumentSession(source);
    const state = createSessionEditorState({
      session,
      surfaceId: 'visual-test',
      surfaceKind: 'visual'
    });

    const replacedRanges: Array<{ from: number; to: number }> = [];
    state.field(visualProjectionField).between(0, state.doc.length, (from, to, value) => {
      if (value.spec.widget) {
        replacedRanges.push({ from, to });
      }
    });

    // There should be 4 replaced delimiter ranges: [0, 2), [5, 7), [8, 10), [13, 15)
    expect(replacedRanges).toHaveLength(4);
    expect(replacedRanges[0]).toEqual({ from: 0, to: 2 });
    expect(replacedRanges[1]).toEqual({ from: 5, to: 7 });
    expect(replacedRanges[2]).toEqual({ from: 8, to: 10 });
    expect(replacedRanges[3]).toEqual({ from: 13, to: 15 });
  });

  it('dispatches on AST node.type to project nested blocks inside list items', () => {
    const source = '- Parent item\n  > Blockquote inside list item with **bold** text\n  - Nested list item with *italic*';
    const session = new MarkdownDocumentSession(source);
    const state = createSessionEditorState({
      session,
      surfaceId: 'visual-test',
      surfaceKind: 'visual'
    });

    const replacedRanges: Array<{ from: number; to: number }> = [];
    state.field(visualProjectionField).between(0, state.doc.length, (from, to, value) => {
      if (value.spec.widget) {
        replacedRanges.push({ from, to });
      }
    });

    // bold in blockquote inside item and italic in nested item should both have hidden delimiters
    const boldIndex = source.indexOf('**bold**');
    expect(replacedRanges.some((r) => r.from === boldIndex)).toBe(true);
    const italicIndex = source.indexOf('*italic*');
    expect(replacedRanges.some((r) => r.from === italicIndex)).toBe(true);
  });

  it('projects RawBlockWidget for raw blocks nested in blockquotes and list items', () => {
    const source = [
      '> <div class="quote-raw">raw in bq</div>',
      '',
      '- List item',
      '  <span class="item-raw">raw in list</span>'
    ].join('\n');

    const session = new MarkdownDocumentSession(source);
    const state = createSessionEditorState({
      session,
      surfaceId: 'visual-raw-nested',
      surfaceKind: 'visual'
    });

    const rawWidgets: RawBlockWidget[] = [];
    state.field(visualProjectionField).between(0, state.doc.length, (_from, _to, value) => {
      if (value.spec.widget instanceof RawBlockWidget) {
        rawWidgets.push(value.spec.widget);
      }
    });

    // Both raw block in blockquote and raw block in list item must project RawBlockWidget!
    expect(rawWidgets.length).toBeGreaterThanOrEqual(2);
  });

  it('prohibits markers and inline widgets inside nested opaque blocks, avoiding Decoration.replace overlap', () => {
    const source = [
      '> ```ts',
      '> # Heading marker inside code block',
      '> const s = "**not bold** $not-math$ [[not-wiki]]";',
      '> ```',
      '',
      '- ```js',
      '  const x = "*not italic*";',
      '  ```',
      '',
      '> | Col 1 | Col 2 |',
      '> | --- | --- |',
      '> | **not bold** | *not italic* |'
    ].join('\n');

    const session = new MarkdownDocumentSession(source);
    const state = createSessionEditorState({
      session,
      surfaceId: 'visual-opaque-no-markers',
      surfaceKind: 'visual'
    });

    // If decoration overlap occurs, CodeMirror RangeSetBuilder will throw an exception during buildVisualProjection!
    // Verify that NO inline marker decorations (cm-visual-marker) are created within the code blocks or table
    let markerCount = 0;
    state.field(visualProjectionField).between(0, state.doc.length, (_from, _to, value) => {
      const cls = value.spec.class || (value.spec.attributes ? value.spec.attributes.class : '');
      if (typeof cls === 'string' && cls.includes('cm-visual-marker-heading')) {
        markerCount++;
      }
    });

    expect(markerCount).toBe(0);
  });

  it('does not export internal sub-editor lifecycle APIs from index.ts', async () => {
    const EditorModule = await import('../src/index.js');
    expect((EditorModule as Record<string, unknown>).ActiveSubEditor).toBeUndefined();
    expect((EditorModule as Record<string, unknown>).registerActiveSubEditor).toBeUndefined();
    expect((EditorModule as Record<string, unknown>).closeAllActiveSubEditors).toBeUndefined();
    expect((EditorModule as Record<string, unknown>).subEditorLifecyclePlugin).toBeUndefined();
  });

  it('allows table cell Tab navigation even when EditorView is in a detached parent DOM', async () => {
    const source = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const session = new MarkdownDocumentSession(source);
    // Detached parent element: NOT appended to document.body
    const detachedParent = document.createElement('div');

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-detached-tab',
      surfaceKind: 'visual',
      parent: detachedParent
    });

    const cell0 = handle.view.dom.querySelector('.cm-visual-table [data-row="0"][data-col="0"]') as HTMLElement;
    expect(cell0).not.toBeNull();
    cell0.click();

    const input = handle.view.dom.querySelector('.cm-table-cell-editor') as HTMLInputElement;
    expect(input).not.toBeNull();

    // Press Tab to navigate to next cell
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

    await new Promise((r) => queueMicrotask(r));

    // In a detached parent, navigation to next cell must succeed
    const targetInput = handle.view.dom.querySelector('.cm-table-cell-editor') as HTMLInputElement;
    expect(targetInput).not.toBeNull();
    const activeCell = targetInput.closest('[data-col]');
    expect(activeCell?.getAttribute('data-col')).toBe('1');

    handle.destroy();
  });

  it('invalidates queued Tab microtask upon view destruction without clicking DOM or throwing', async () => {
    const source = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const session = new MarkdownDocumentSession(source);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-destroy-tab',
      surfaceKind: 'visual',
      parent
    });

    const cell0 = handle.view.dom.querySelector('.cm-visual-table [data-row="0"][data-col="0"]') as HTMLElement;
    cell0.click();

    const input = handle.view.dom.querySelector('.cm-table-cell-editor') as HTMLInputElement;
    expect(input).not.toBeNull();

    // Trigger Tab
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

    // Destroy immediately before microtask executes
    handle.destroy();
    parent.remove();

    // Wait for microtask to execute
    await new Promise((r) => queueMicrotask(r));

    // No errors thrown, and no magic properties written to view
    expect((handle.view as unknown as Record<string, unknown>).__nexusDestroyed).toBeUndefined();
  });

  it('closes all sub-editor types (.cm-table-cell-editor, .cm-block-math-editor, .cm-raw-block-editor) in detached parent on readOnly, docChanged, and destroy', () => {
    const source = [
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '$$',
      'E = mc^2',
      '$$',
      '',
      '<div class="box">raw</div>'
    ].join('\n');

    // Test 1: readOnly transition closes all sub-editors in detached parent
    {
      const session = new MarkdownDocumentSession(source);
      const detachedParent = document.createElement('div');
      const handle = createSessionEditorView({
        session,
        surfaceId: 'sub-detached-ro',
        surfaceKind: 'visual',
        parent: detachedParent
      });

      // 1. table cell editor
      const cell = handle.view.dom.querySelector('.cm-visual-table [data-row="0"][data-col="0"]') as HTMLElement;
      cell.click();
      expect(handle.view.dom.querySelector('.cm-table-cell-editor')).not.toBeNull();

      // 2. block math editor
      const math = handle.view.dom.querySelector('.cm-visual-block-math') as HTMLElement;
      math.click();
      expect(handle.view.dom.querySelector('.cm-block-math-editor')).not.toBeNull();

      // 3. raw block editor
      const raw = handle.view.dom.querySelector('.cm-visual-raw-block') as HTMLElement;
      raw.click();
      expect(handle.view.dom.querySelector('.cm-raw-block-editor')).not.toBeNull();

      // Dispatch readOnly transition
      setEditorReadOnly(handle.view, true);

      // ALL sub-editor elements must disappear immediately!
      expect(handle.view.dom.querySelector('.cm-table-cell-editor')).toBeNull();
      expect(handle.view.dom.querySelector('.cm-block-math-editor')).toBeNull();
      expect(handle.view.dom.querySelector('.cm-raw-block-editor')).toBeNull();

      handle.destroy();
    }

    // Test 2: docChanged closes all sub-editors in detached parent
    {
      const session = new MarkdownDocumentSession(source);
      const detachedParent = document.createElement('div');
      const handle = createSessionEditorView({
        session,
        surfaceId: 'sub-detached-doc',
        surfaceKind: 'visual',
        parent: detachedParent
      });

      (handle.view.dom.querySelector('.cm-visual-table [data-row="0"][data-col="0"]') as HTMLElement).click();
      (handle.view.dom.querySelector('.cm-visual-block-math') as HTMLElement).click();
      (handle.view.dom.querySelector('.cm-visual-raw-block') as HTMLElement).click();

      expect(handle.view.dom.querySelector('.cm-table-cell-editor')).not.toBeNull();
      expect(handle.view.dom.querySelector('.cm-block-math-editor')).not.toBeNull();
      expect(handle.view.dom.querySelector('.cm-raw-block-editor')).not.toBeNull();

      // Dispatch doc change
      handle.view.dispatch({
        changes: { from: 0, to: handle.view.state.doc.length, insert: '# Replaced' }
      });

      expect(handle.view.dom.querySelector('.cm-table-cell-editor')).toBeNull();
      expect(handle.view.dom.querySelector('.cm-block-math-editor')).toBeNull();
      expect(handle.view.dom.querySelector('.cm-raw-block-editor')).toBeNull();

      handle.destroy();
    }

    // Test 3: destroy closes all sub-editors in detached parent
    {
      const session = new MarkdownDocumentSession(source);
      const detachedParent = document.createElement('div');
      const handle = createSessionEditorView({
        session,
        surfaceId: 'sub-detached-destroy',
        surfaceKind: 'visual',
        parent: detachedParent
      });

      (handle.view.dom.querySelector('.cm-visual-table [data-row="0"][data-col="0"]') as HTMLElement).click();
      (handle.view.dom.querySelector('.cm-visual-block-math') as HTMLElement).click();
      (handle.view.dom.querySelector('.cm-visual-raw-block') as HTMLElement).click();

      expect(handle.view.dom.querySelector('.cm-table-cell-editor')).not.toBeNull();
      expect(handle.view.dom.querySelector('.cm-block-math-editor')).not.toBeNull();
      expect(handle.view.dom.querySelector('.cm-raw-block-editor')).not.toBeNull();

      handle.destroy();

      expect(handle.view.dom.querySelector('.cm-table-cell-editor')).toBeNull();
      expect(handle.view.dom.querySelector('.cm-block-math-editor')).toBeNull();
      expect(handle.view.dom.querySelector('.cm-raw-block-editor')).toBeNull();
    }
  });

  it('invalidates queued Tab microtask on readOnly and docChanged as well as destroy', async () => {
    const source = '| A | B |\n| --- | --- |\n| 1 | 2 |';

    // 1. readOnly invalidates Tab microtask
    {
      const session = new MarkdownDocumentSession(source);
      const parent = document.createElement('div');
      const handle = createSessionEditorView({
        session,
        surfaceId: 'tab-ro-inval',
        surfaceKind: 'visual',
        parent
      });

      const cell0 = handle.view.dom.querySelector('.cm-visual-table [data-row="0"][data-col="0"]') as HTMLElement;
      cell0.click();
      const input = handle.view.dom.querySelector('.cm-table-cell-editor') as HTMLInputElement;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

      // Immediately toggle readOnly
      setEditorReadOnly(handle.view, true);

      await new Promise((r) => queueMicrotask(r));
      // No new cell editor should be opened
      expect(handle.view.dom.querySelector('.cm-table-cell-editor')).toBeNull();

      handle.destroy();
    }

    // 2. docChanged invalidates Tab microtask
    {
      const session = new MarkdownDocumentSession(source);
      const parent = document.createElement('div');
      const handle = createSessionEditorView({
        session,
        surfaceId: 'tab-doc-inval',
        surfaceKind: 'visual',
        parent
      });

      const cell0 = handle.view.dom.querySelector('.cm-visual-table [data-row="0"][data-col="0"]') as HTMLElement;
      cell0.click();
      const input = handle.view.dom.querySelector('.cm-table-cell-editor') as HTMLInputElement;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

      // Immediately change doc
      handle.view.dispatch({
        changes: { from: 0, to: handle.view.state.doc.length, insert: '# New Doc' }
      });

      await new Promise((r) => queueMicrotask(r));
      expect(handle.view.dom.querySelector('.cm-table-cell-editor')).toBeNull();

      handle.destroy();
    }
  });

  it('normal edit followed by Tab navigates to next cell and is NOT invalidated by own commit docChanged', async () => {
    const source = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const session = new MarkdownDocumentSession(source);
    const parent = document.createElement('div');
    const handle = createSessionEditorView({
      session,
      surfaceId: 'tab-edit-success',
      surfaceKind: 'visual',
      parent
    });

    const cell0 = handle.view.dom.querySelector('.cm-visual-table [data-row="0"][data-col="0"]') as HTMLElement;
    cell0.click();
    const input = handle.view.dom.querySelector('.cm-table-cell-editor') as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = '100';

    // Press Tab
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

    // Wait for microtask
    await new Promise((r) => queueMicrotask(r));

    // 1. Value must have been committed to session
    expect(session.getSnapshot().source).toContain('| 100 | 2 |');

    // 2. Next cell [0, 1] MUST be opened for editing!
    const nextInput = handle.view.dom.querySelector('.cm-table-cell-editor') as HTMLInputElement;
    expect(nextInput).not.toBeNull();
    expect(nextInput.value).toBe('2');

    handle.destroy();
  });

  it('closed sub-editor does NOT overwrite re-projected content with stale initialValue on late blur/keydown', async () => {
    const source = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const session = new MarkdownDocumentSession(source);
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const handle = createSessionEditorView({
      session,
      surfaceId: 'stale-initial-value',
      surfaceKind: 'visual',
      parent
    });

    const cell0 = handle.view.dom.querySelector('.cm-visual-table [data-row="0"][data-col="0"]') as HTMLElement;
    cell0.click();
    const input = handle.view.dom.querySelector('.cm-table-cell-editor') as HTMLInputElement;
    expect(input).not.toBeNull();

    // External doc update modifies cell 0 to 'External'
    session.dispatch({
      changes: [{ from: 0, to: source.length, insert: '| A | B |\n| --- | --- |\n| External | 2 |' }],
      userEvent: 'remote.sync'
    });

    await new Promise((r) => setTimeout(r, 10));

    // Sub-editor is now closed
    expect(handle.view.dom.querySelector('.cm-table-cell-editor')).toBeNull();

    // Fire late blur and keydown on detached input
    input.dispatchEvent(new FocusEvent('blur'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    // Cell text in DOM must reflect external update, NOT stale initialValue '1'
    const reprojectedCell0 = handle.view.dom.querySelector('.cm-visual-table [data-row="0"][data-col="0"]') as HTMLElement;
    expect(reprojectedCell0.textContent).toBe('External');
    expect(session.getSnapshot().source).toContain('| External | 2 |');

    handle.destroy();
    parent.remove();
  });
});
