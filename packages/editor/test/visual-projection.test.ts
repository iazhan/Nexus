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

  it('closes all sub-editor types (.cm-table-cell-editor, .cm-raw-block-editor) in detached parent on readOnly, docChanged, and destroy', () => {
    // 块级公式已改为「源码 + 实时预览」的就地编辑，不再有 textarea 子编辑器，
    // 所以这里只覆盖仍在用子编辑器的两类：表格单元格与 raw 块。
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

    type Handle = ReturnType<typeof createSessionEditorView>;
    const openSubEditors = (handle: Handle) => {
      (handle.view.dom.querySelector('.cm-visual-table [data-row="0"][data-col="0"]') as HTMLElement).click();
      (handle.view.dom.querySelector('.cm-visual-raw-block') as HTMLElement).click();
    };
    const expectSubEditorsOpen = (handle: Handle) => {
      expect(handle.view.dom.querySelector('.cm-table-cell-editor')).not.toBeNull();
      expect(handle.view.dom.querySelector('.cm-raw-block-editor')).not.toBeNull();
    };
    const expectSubEditorsClosed = (handle: Handle) => {
      expect(handle.view.dom.querySelector('.cm-table-cell-editor')).toBeNull();
      expect(handle.view.dom.querySelector('.cm-raw-block-editor')).toBeNull();
    };
    const mount = (surfaceId: string) =>
      createSessionEditorView({
        session: new MarkdownDocumentSession(source),
        surfaceId,
        surfaceKind: 'visual',
        parent: document.createElement('div')
      });

    // Test 1: readOnly transition closes all sub-editors in detached parent
    {
      const handle = mount('sub-detached-ro');
      openSubEditors(handle);
      expectSubEditorsOpen(handle);

      setEditorReadOnly(handle.view, true);
      expectSubEditorsClosed(handle);

      handle.destroy();
    }

    // Test 2: docChanged closes all sub-editors in detached parent
    {
      const handle = mount('sub-detached-doc');
      openSubEditors(handle);
      expectSubEditorsOpen(handle);

      handle.view.dispatch({
        changes: { from: 0, to: handle.view.state.doc.length, insert: '# Replaced' }
      });
      expectSubEditorsClosed(handle);

      handle.destroy();
    }

    // Test 3: destroy closes all sub-editors in detached parent
    {
      const handle = mount('sub-detached-destroy');
      openSubEditors(handle);
      expectSubEditorsOpen(handle);

      handle.destroy();
      expectSubEditorsClosed(handle);
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

  describe('decoration ordering contract', () => {
    // RangeSetBuilder 只接受按 (from, value.startSide) 升序的输入。
    // 同一 from 上 mark 的 startSide 是 500000000，replace 是 499999999，
    // 所以 mark 必须排在 replace 之后——只按 from/to 排序会漏掉这一层。
    //
    // 回归背景：`[![alt](img)](url)` 的链接文字本身就是一个图片 widget，
    // 链接 mark 与图片 replace 的 from/to 完全相同。投影顺序反了会让
    // buildVisualProjection 抛 "Ranges must be added sorted by `from` position and `startSide`"，
    // 而它在 StateField.create 里被调用 → EditorState 构造失败 → React 没有错误边界
    // 会卸载整棵树 → 打开文件直接白屏（2026-09-23 实际发生过）。
    const orderingCases: Array<[string, string]> = [
      ['链接文字是图片', '[![Nexus 图标](./assets/logo.png)](https://example.com)'],
      ['链接文字是加粗', '[**bold**](https://example.com)'],
      ['链接文字是行内代码', '[`code`](https://example.com)'],
      ['链接文字是纯文本', '[plain](https://example.com)'],
      ['链接文字是删除线', '[~~gone~~](https://example.com)'],
      ['链接文字是行内公式', '[$E=mc^2$](https://example.com)'],
      ['链接图片与普通链接混排', '[![a](./a.png)](https://e.com) 和 [b](https://e.com)'],
      ['引用块内嵌列表与代码块', '> 段落\n>\n> - 项一\n> - 项二\n>\n> ```text\n> 引用里的代码\n> ```'],
      ['引用块内嵌链接图片', '> 见 [![图](./a.png)](https://e.com) 说明'],
      ['三层嵌套引用', '> 一层\n>\n> > 二层\n> >\n> > > 三层'],
      ['四反引号围栏包三反引号', '````text\n```\n````'],
      ['列表项内嵌引用', '- 项\n\n  > 引用一\n  > 引用二']
    ];

    for (const [label, source] of orderingCases) {
      it(`projects ${label} without breaking the RangeSetBuilder order contract`, () => {
        expect(() =>
          createSessionEditorState({
            session: new MarkdownDocumentSession(source),
            surfaceId: `ordering-${label}`,
            surfaceKind: 'visual'
          })
        ).not.toThrow();
      });
    }

    it('renders a linked image as an image widget with both link delimiters hidden', () => {
      const source = '[![Nexus 图标](./assets/logo.png)](https://example.com)';
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const handle = createSessionEditorView({
        parent,
        session: new MarkdownDocumentSession(source),
        surfaceId: 'ordering-linked-image-dom',
        surfaceKind: 'visual'
      });

      expect(handle.view.dom.querySelectorAll('.cm-visual-image').length).toBe(1);
      expect(handle.view.dom.querySelectorAll('.cm-visual-image-widget').length).toBe(1);

      // `[` 与 `](url)` 都被收进隐藏分隔符，正文只剩图片 widget
      const delimiters = Array.from(
        handle.view.dom.querySelectorAll('.cm-visual-hidden-delimiter')
      ).map((element) => (element as HTMLElement).dataset.delimiter);
      expect(delimiters).toEqual(['[', '](https://example.com)']);

      // 源码字节不被改动
      expect(handle.view.state.doc.toString()).toBe(source);

      handle.destroy();
      parent.remove();
    });

    it('keeps the whole decoration set ordered for a document mixing every tricky nesting', () => {
      const source = [
        '# 标题',
        '',
        '[![图标](./a.png)](https://example.com)',
        '',
        '[**粗**](https://e.com) 与 [`码`](https://e.com) 与 [$x$](https://e.com)',
        '',
        '> 引用段落',
        '>',
        '> - 引用里的列表',
        '>',
        '> ```text',
        '> 引用里的代码',
        '> ```',
        '',
        '````text',
        '```',
        '````',
        '',
        '- 列表项',
        '  - 嵌套项 [![n](./n.png)](https://e.com)',
        '',
        '- [ ] 任务项',
        '- [x] 已完成',
        '',
        '| 列 | 说明 |',
        '| --- | --- |',
        '| `code` | [link](https://e.com) |',
        '',
        '$$',
        'E = mc^2',
        '$$'
      ].join('\n');

      const state = createSessionEditorState({
        session: new MarkdownDocumentSession(source),
        surfaceId: 'ordering-kitchen-sink',
        surfaceKind: 'visual'
      });

      // 遍历本身就会在顺序非法时抛错，这里再显式确认装饰集合非空且已建立
      let count = 0;
      state.field(visualProjectionField).between(0, state.doc.length, () => {
        count++;
      });
      expect(count).toBeGreaterThan(50);
      expect(state.doc.toString()).toBe(source);
    });
  });
});
