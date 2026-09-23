// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import {
  MarkdownDocumentSession,
  createSessionEditorView,
  isEditorComposing,
  setEditorReadOnly,
  type SessionEditorViewHandle
} from '../src/index.js';

/**
 * P1-04F 兼容性契约测试只验证跨模块行为，不重复覆盖各事务生成器的内部算法。
 * Source 和 Visual 必须通过同一个 session 协调规范源码、选区、revision 与历史记录。
 */
describe('P1-04F Markra behavior compatibility', () => {
  const handles: SessionEditorViewHandle[] = [];
  const parents: HTMLElement[] = [];

  function mount(
    session: MarkdownDocumentSession,
    surfaceId: string,
    surfaceKind: 'source' | 'visual',
    readOnly = false
  ): SessionEditorViewHandle {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    parents.push(parent);

    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId,
      surfaceKind,
      readOnly
    });
    handles.push(handle);
    return handle;
  }

  function destroyMounted(handle: SessionEditorViewHandle): void {
    const index = handles.indexOf(handle);
    if (index >= 0) handles.splice(index, 1);
    handle.destroy();
  }

  afterEach(() => {
    for (const handle of handles.splice(0)) {
      handle.destroy();
    }
    for (const parent of parents.splice(0)) {
      parent.remove();
    }
  });

  it('keeps canonical bytes and history stable across an unedited Source/Visual round trip', () => {
    const source = [
      '# Compatibility 🎉',
      '',
      'See [Doc](https://nexus.dev) and `npm test`.',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '$$',
      'E = mc^2',
      '$$',
      '',
      '<div class="raw"><script>alert(1)</script>safe</div>',
      ''
    ].join('\r\n');
    const session = new MarkdownDocumentSession(source);

    const sourceHandle = mount(session, 'p1-04f-source-roundtrip', 'source');
    const visualHandle = mount(session, 'p1-04f-visual-roundtrip', 'visual');

    expect(sourceHandle.view.state.doc.toString()).toBe(source);
    expect(visualHandle.view.state.doc.toString()).toBe(source);
    const selectedFrom = source.indexOf('Doc');
    sourceHandle.view.dispatch({
      selection: { anchor: selectedFrom, head: selectedFrom + 'Doc'.length }
    });
    expect(visualHandle.view.state.selection.main.anchor).toBe(selectedFrom);
    expect(visualHandle.view.state.selection.main.head).toBe(selectedFrom + 'Doc'.length);
    expect(session.getSnapshot()).toEqual({
      source,
      revision: 0,
      selection: { anchor: selectedFrom, head: selectedFrom + 'Doc'.length }
    });

    // 模拟应用层的 Source -> Visual -> Source surface 重建；重建不能复制正文或清空 history。
    destroyMounted(sourceHandle);
    const remountedSource = mount(session, 'p1-04f-source-roundtrip-remounted', 'source');
    destroyMounted(visualHandle);
    const remountedVisual = mount(session, 'p1-04f-visual-roundtrip-remounted', 'visual');

    expect(remountedSource.view.state.doc.toString()).toBe(source);
    expect(remountedVisual.view.state.doc.toString()).toBe(source);
    expect(remountedSource.view.state.selection.main.anchor).toBe(selectedFrom);
    expect(remountedSource.view.state.selection.main.head).toBe(selectedFrom + 'Doc'.length);
    expect(remountedVisual.view.state.selection.main.anchor).toBe(selectedFrom);
    expect(remountedVisual.view.state.selection.main.head).toBe(selectedFrom + 'Doc'.length);
    expect(session.getSnapshot().revision).toBe(0);
    expect(session.canUndo).toBe(false);
    expect(session.canRedo).toBe(false);
  });

  it('commits in-place Visual link edits to canonical source and synchronizes Source plus undo/redo', () => {
    const original = 'Read [the guide](https://nexus.dev/guide) now.';
    const session = new MarkdownDocumentSession(original);
    const sourceHandle = mount(session, 'p1-04f-link-source', 'source');
    const visualHandle = mount(session, 'p1-04f-link-visual', 'visual');

    // 链接文字是真实文档文本，直接改写即可，不需要 popover 与 Save 按钮
    const linkText = visualHandle.view.dom.querySelector('.cm-visual-link') as HTMLElement;
    expect(linkText.textContent).toBe('the guide');
    expect(linkText.getAttribute('data-safe-href')).toBe('https://nexus.dev/guide');
    expect(visualHandle.view.dom.querySelector('.cm-visual-link-widget')).toBeNull();

    const labelStart = original.indexOf('the guide');
    const destStart = original.indexOf('https://nexus.dev/guide');
    visualHandle.view.dispatch({
      changes: [
        { from: labelStart, to: labelStart + 'the guide'.length, insert: 'the manual' },
        {
          from: destStart,
          to: destStart + 'https://nexus.dev/guide'.length,
          insert: 'https://nexus.dev/guide/v2'
        }
      ]
    });

    const updated = 'Read [the manual](https://nexus.dev/guide/v2) now.';
    expect(visualHandle.view.dom.querySelector('.cm-inline-edit-popover')).toBeNull();
    expect(session.getSnapshot().source).toBe(updated);
    expect(session.getSnapshot().revision).toBe(1);
    expect(sourceHandle.view.state.doc.toString()).toBe(updated);
    expect((visualHandle.view.dom.querySelector('.cm-visual-link') as HTMLElement).getAttribute('data-safe-href'))
      .toBe('https://nexus.dev/guide/v2');

    expect(session.undo()).toBe(true);
    expect(session.getSnapshot().source).toBe(original);
    expect(sourceHandle.view.state.doc.toString()).toBe(original);
    expect((visualHandle.view.dom.querySelector('.cm-visual-link') as HTMLElement).getAttribute('data-safe-href'))
      .toBe('https://nexus.dev/guide');

    expect(session.redo()).toBe(true);
    expect(session.getSnapshot().source).toBe(updated);
    expect(sourceHandle.view.state.doc.toString()).toBe(updated);
  });

  it('commits a Visual code-block edit without projecting Markdown inside the block', () => {
    const original = 'Before\n\n```markdown\n**not bold** and $not math$\n```\n\nAfter';
    const session = new MarkdownDocumentSession(original);
    const sourceHandle = mount(session, 'p1-04f-code-source', 'source');
    const visualHandle = mount(session, 'p1-04f-code-visual', 'visual');

    expect(visualHandle.view.dom.querySelector('.cm-code-header-widget')).not.toBeNull();
    expect(visualHandle.view.dom.querySelectorAll('.cm-visual-inline-math')).toHaveLength(0);
    expect(visualHandle.view.dom.querySelectorAll('.cm-visual-wikilink')).toHaveLength(0);

    const codePos = original.indexOf('**not bold**');
    const oldSnippet = '**not bold** and $not math$';
    visualHandle.view.dispatch({
      changes: {
        from: codePos,
        to: codePos + oldSnippet.length,
        insert: '**still plain code**\n$still plain text$'
      }
    });

    const updated = 'Before\n\n```markdown\n**still plain code**\n$still plain text$\n```\n\nAfter';
    expect(session.getSnapshot().source).toBe(updated);
    expect(sourceHandle.view.state.doc.toString()).toBe(updated);
    expect(visualHandle.view.dom.querySelectorAll('.cm-visual-inline-math')).toHaveLength(0);

    session.undo();
    expect(session.getSnapshot().source).toBe(original);
    expect(sourceHandle.view.state.doc.toString()).toBe(original);
    session.redo();
    expect(session.getSnapshot().source).toBe(updated);
    expect(sourceHandle.view.state.doc.toString()).toBe(updated);
  });

  it('keeps table Visual edits, canonical source, Source surface and history in one transaction loop', () => {
    const original = [
      '| Name | Count |',
      '| --- | ---: |',
      '| alpha | 1 |'
    ].join('\n');
    const session = new MarkdownDocumentSession(original);
    const sourceHandle = mount(session, 'p1-04f-table-source', 'source');
    const visualHandle = mount(session, 'p1-04f-table-visual', 'visual');

    const cell = visualHandle.view.dom.querySelector(
      '.cm-visual-table td[data-row="0"][data-col="0"]'
    ) as HTMLElement;
    cell.click();
    const editor = cell.querySelector('.cm-table-cell-editor') as HTMLInputElement;
    editor.value = 'beta';
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const updated = '| Name | Count |\n| --- | ---: |\n| beta | 1 |';
    expect(session.getSnapshot().source).toBe(updated);
    expect(sourceHandle.view.state.doc.toString()).toBe(updated);
    expect((visualHandle.view.dom.querySelector(
      '.cm-visual-table td[data-row="0"][data-col="0"]'
    ) as HTMLElement).textContent).toContain('beta');

    session.undo();
    expect(session.getSnapshot().source).toBe(original);
    expect(sourceHandle.view.state.doc.toString()).toBe(original);
    session.redo();
    expect(session.getSnapshot().source).toBe(updated);
    expect(sourceHandle.view.state.doc.toString()).toBe(updated);
  });

  it('keeps block math and raw HTML edits source-aligned and never executes raw HTML', () => {
    const original = '$$\nE = mc^2\n$$\n\n<div class="raw"><script>alert(1)</script>safe</div>';
    const session = new MarkdownDocumentSession(original);
    const sourceHandle = mount(session, 'p1-04f-special-source', 'source');
    const visualHandle = mount(session, 'p1-04f-special-visual', 'visual');

    expect(visualHandle.view.dom.querySelector('.cm-visual-block-math')).not.toBeNull();
    expect(visualHandle.view.dom.querySelector('.cm-visual-raw-block')).not.toBeNull();
    expect(visualHandle.view.dom.querySelector('script')).toBeNull();

    (visualHandle.view.dom.querySelector('.cm-visual-block-math') as HTMLElement).click();
    const mathEditor = visualHandle.view.dom.querySelector('.cm-block-math-editor') as HTMLTextAreaElement;
    mathEditor.value = 'E = mc^3';
    mathEditor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true
    }));

    const afterMath = '$$\nE = mc^3\n$$\n\n<div class="raw"><script>alert(1)</script>safe</div>';
    expect(session.getSnapshot().source).toBe(afterMath);
    expect(sourceHandle.view.state.doc.toString()).toBe(afterMath);

    (visualHandle.view.dom.querySelector('.cm-visual-raw-block') as HTMLElement).click();
    const rawEditor = visualHandle.view.dom.querySelector('.cm-raw-block-editor') as HTMLTextAreaElement;
    rawEditor.value = '<div class="raw-v2">safe</div>';
    rawEditor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true
    }));

    const updated = '$$\nE = mc^3\n$$\n\n<div class="raw-v2">safe</div>';
    expect(session.getSnapshot().source).toBe(updated);
    expect(sourceHandle.view.state.doc.toString()).toBe(updated);
    expect(visualHandle.view.dom.querySelector('script')).toBeNull();

    session.undo();
    expect(session.getSnapshot().source).toBe(afterMath);
    session.undo();
    expect(session.getSnapshot().source).toBe(original);
    expect(sourceHandle.view.state.doc.toString()).toBe(original);
    session.redo();
    session.redo();
    expect(session.getSnapshot().source).toBe(updated);
    expect(sourceHandle.view.state.doc.toString()).toBe(updated);
  });

  it('propagates Source edits and selection mapping to Visual without DOM-to-Markdown serialization', () => {
    const original = 'Open [Doc](https://nexus.dev) now.';
    const session = new MarkdownDocumentSession(original);
    const sourceHandle = mount(session, 'p1-04f-source-edit-source', 'source');
    const visualHandle = mount(session, 'p1-04f-source-edit-visual', 'visual');

    const oldDestinationStart = original.indexOf('https://nexus.dev');
    const oldDestinationEnd = oldDestinationStart + 'https://nexus.dev'.length;
    sourceHandle.view.dispatch({
      changes: {
        from: oldDestinationStart,
        to: oldDestinationEnd,
        insert: 'https://nexus.dev/v2'
      },
      selection: { anchor: oldDestinationStart + 'https://nexus.dev/v2'.length }
    });

    const updated = 'Open [Doc](https://nexus.dev/v2) now.';
    expect(session.getSnapshot().source).toBe(updated);
    expect(visualHandle.view.state.doc.toString()).toBe(updated);
    expect((visualHandle.view.dom.querySelector('.cm-visual-link') as HTMLElement).getAttribute('data-safe-href'))
      .toContain('https://nexus.dev/v2');

    sourceHandle.view.dispatch({ selection: { anchor: 4, head: 8 } });
    expect(visualHandle.view.state.selection.main.anchor).toBe(4);
    expect(visualHandle.view.state.selection.main.head).toBe(8);
    expect(session.getSnapshot().revision).toBe(1);
  });

  it('buffers Visual IME changes, then commits exactly once and synchronizes both surfaces', () => {
    const original = 'Prefix Suffix';
    const session = new MarkdownDocumentSession(original);
    const sourceHandle = mount(session, 'p1-04f-ime-source', 'source');
    const visualHandle = mount(session, 'p1-04f-ime-visual', 'visual');
    const initialRevision = session.getSnapshot().revision;

    visualHandle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    expect(isEditorComposing(visualHandle.view)).toBe(true);
    visualHandle.view.dispatch({ changes: { from: 7, to: 7, insert: 'nihao' } });

    expect(session.getSnapshot().source).toBe(original);
    expect(session.getSnapshot().revision).toBe(initialRevision);
    expect(sourceHandle.view.state.doc.toString()).toBe(original);

    visualHandle.view.dispatch({ changes: { from: 7, to: 12, insert: '你好' } });
    visualHandle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '你好' }));

    const updated = 'Prefix 你好Suffix';
    expect(isEditorComposing(visualHandle.view)).toBe(false);
    expect(session.getSnapshot().source).toBe(updated);
    expect(session.getSnapshot().revision).toBe(initialRevision + 1);
    expect(sourceHandle.view.state.doc.toString()).toBe(updated);

    session.undo();
    expect(session.getSnapshot().source).toBe(original);
    expect(sourceHandle.view.state.doc.toString()).toBe(original);
    expect(visualHandle.view.state.doc.toString()).toBe(original);
    session.redo();
    expect(session.getSnapshot().source).toBe(updated);
    expect(sourceHandle.view.state.doc.toString()).toBe(updated);
  });

  it('applies sanitized clipboard text through the session and synchronizes undo/redo', () => {
    const original = 'Prefix Suffix';
    const session = new MarkdownDocumentSession(original);
    const sourceHandle = mount(session, 'p1-04f-paste-source', 'source');
    const visualHandle = mount(session, 'p1-04f-paste-visual', 'visual');

    sourceHandle.view.dispatch({ selection: { anchor: 7, head: 7 } });
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        getData: (type: string) =>
          type === 'text/plain' ? 'Middle ' : '<script>bad()</script>'
      }
    });
    sourceHandle.view.contentDOM.dispatchEvent(pasteEvent);

    const updated = 'Prefix Middle Suffix';
    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(session.getSnapshot().source).toBe(updated);
    expect(visualHandle.view.state.doc.toString()).toBe(updated);
    expect(visualHandle.view.dom.querySelector('script')).toBeNull();

    session.undo();
    expect(session.getSnapshot().source).toBe(original);
    expect(sourceHandle.view.state.doc.toString()).toBe(original);
    expect(visualHandle.view.state.doc.toString()).toBe(original);
    session.redo();
    expect(session.getSnapshot().source).toBe(updated);
  });

  it('closes a stale Visual sub-editor on readOnly and rejects delayed commit', () => {
    const original = '| Col |\n| --- |\n| Cell |';
    const session = new MarkdownDocumentSession(original);
    const visualHandle = mount(session, 'p1-04f-readonly-visual', 'visual');

    (visualHandle.view.dom.querySelector('.cm-visual-table td') as HTMLElement).click();
    const editor = visualHandle.view.dom.querySelector('.cm-table-cell-editor') as HTMLInputElement;
    editor.value = 'NewCell';
    const initialRevision = session.getSnapshot().revision;

    setEditorReadOnly(visualHandle.view, true);
    expect(visualHandle.view.dom.querySelector('.cm-table-cell-editor')).toBeNull();

    editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true
    }));
    expect(session.getSnapshot().revision).toBe(initialRevision);
    expect(session.getSnapshot().source).toBe(original);
  });

  it('isolates Surface lifecycle so destroying one Visual surface keeps another popover alive', () => {
    const source = 'Read [[the guide]] now.';
    const session = new MarkdownDocumentSession(source);
    const firstVisual = mount(session, 'p1-04f-lifecycle-first', 'visual');
    const secondVisual = mount(session, 'p1-04f-lifecycle-second', 'visual');

    (firstVisual.view.dom.querySelector('.cm-visual-wikilink') as HTMLElement).click();
    expect(firstVisual.view.dom.querySelector('.cm-inline-edit-popover')).not.toBeNull();

    destroyMounted(secondVisual);
    expect(firstVisual.view.dom.querySelector('.cm-inline-edit-popover')).not.toBeNull();
    expect(firstVisual.view.state.doc.toString()).toBe(source);
    expect(session.getSnapshot().revision).toBe(0);
  });

  it('strictly guarantees monotonic revision increments on edits and coordinated undo/redo tracking', () => {
    const original = 'Initial document content.';
    const session = new MarkdownDocumentSession(original);
    const sourceHandle = mount(session, 'p1-04f-rev-source', 'source');
    const visualHandle = mount(session, 'p1-04f-rev-visual', 'visual');

    expect(session.getSnapshot().revision).toBe(0);

    // First edit from Source surface
    sourceHandle.view.dispatch({
      changes: { from: 0, to: 7, insert: 'First' }
    });
    expect(session.getSnapshot().revision).toBe(1);
    expect(visualHandle.view.state.doc.toString()).toBe('First document content.');

    // Second edit from Visual surface
    visualHandle.view.dispatch({
      changes: { from: 6, to: 14, insert: 'Markdown' }
    });
    expect(session.getSnapshot().revision).toBe(2);
    expect(sourceHandle.view.state.doc.toString()).toBe('First Markdown content.');

    // Third edit
    session.dispatch({
      changes: [{ from: 15, to: 22, insert: 'article' }]
    });
    expect(session.getSnapshot().revision).toBe(3);
    expect(sourceHandle.view.state.doc.toString()).toBe('First Markdown article.');
    expect(visualHandle.view.state.doc.toString()).toBe('First Markdown article.');

    // Undo steps back through canonical history
    expect(session.undo()).toBe(true);
    expect(session.getSnapshot().revision).toBe(4);
    expect(sourceHandle.view.state.doc.toString()).toBe('First Markdown content.');
    expect(visualHandle.view.state.doc.toString()).toBe('First Markdown content.');

    expect(session.undo()).toBe(true);
    expect(session.getSnapshot().revision).toBe(5);
    expect(sourceHandle.view.state.doc.toString()).toBe('First document content.');

    // Redo steps forward
    expect(session.redo()).toBe(true);
    expect(session.getSnapshot().revision).toBe(6);
    expect(sourceHandle.view.state.doc.toString()).toBe('First Markdown content.');
    expect(visualHandle.view.state.doc.toString()).toBe('First Markdown content.');
  });

  it('preserves raw HTML and unknown syntax verbatim without DOM serialization or script execution', () => {
    const rawUnknown = [
      '# Document with Unknown Syntax',
      '',
      '<custom:component id="comp-1" data-val="123">',
      '  <unknown-child attr="true">',
      '    <script>window.__p1_04f_malicious_exec = true;</script>',
      '    Some raw opaque text here.',
      '  </unknown-child>',
      '</custom:component>',
      '',
      'End paragraph.'
    ].join('\r\n');

    const session = new MarkdownDocumentSession(rawUnknown);
    const sourceHandle = mount(session, 'p1-04f-opaque-source', 'source');
    const visualHandle = mount(session, 'p1-04f-opaque-visual', 'visual');

    // Never executes raw script tags
    expect((window as any).__p1_04f_malicious_exec).toBeUndefined();

    // Visual surface preserves canonical source in view state doc
    expect(visualHandle.view.state.doc.toString()).toBe(rawUnknown);
    expect(sourceHandle.view.state.doc.toString()).toBe(rawUnknown);

    // Edit paragraph at the end from Source
    const endPos = rawUnknown.indexOf('End paragraph.');
    sourceHandle.view.dispatch({
      changes: { from: endPos, to: endPos + 'End'.length, insert: 'Final' }
    });

    const expectedUpdated = rawUnknown.replace('End paragraph.', 'Final paragraph.');
    expect(session.getSnapshot().source).toBe(expectedUpdated);
    expect(visualHandle.view.state.doc.toString()).toBe(expectedUpdated);
    // Byte-for-byte fidelity of raw unknown syntax block
    expect(session.getSnapshot().source).toContain('<custom:component id="comp-1" data-val="123">');
    expect(session.getSnapshot().source).toContain('<script>window.__p1_04f_malicious_exec = true;</script>');
  });

  it('maintains selection mapping across concurrent and interleaved surface transactions', () => {
    const source = 'Paragraph One.\n\nParagraph Two is longer.\n\nParagraph Three.';
    const session = new MarkdownDocumentSession(source);
    const sourceHandle = mount(session, 'p1-04f-sel-source', 'source');
    const visualHandle = mount(session, 'p1-04f-sel-visual', 'visual');

    // Visual surface places cursor at 'Two' (offset 26 to 29)
    const twoStart = source.indexOf('Two');
    visualHandle.view.dispatch({
      selection: { anchor: twoStart, head: twoStart + 3 }
    });
    expect(session.getSnapshot().selection).toEqual({ anchor: twoStart, head: twoStart + 3 });

    // Source surface inserts prefix at start of document: 'Prepend text. ' (length 14)
    const prefix = 'Prepend text. ';
    sourceHandle.view.dispatch({
      changes: { from: 0, to: 0, insert: prefix }
    });

    // Selection in Visual surface is mapped forward by prefix length
    const expectedAnchor = twoStart + prefix.length;
    const expectedHead = twoStart + 3 + prefix.length;
    expect(visualHandle.view.state.selection.main.anchor).toBe(expectedAnchor);
    expect(visualHandle.view.state.selection.main.head).toBe(expectedHead);
    expect(session.getSnapshot().selection).toEqual({ anchor: expectedAnchor, head: expectedHead });
  });
});
