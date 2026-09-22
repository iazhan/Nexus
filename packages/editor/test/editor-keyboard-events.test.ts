// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { EditorSelection } from '@codemirror/state';
import {
  MarkdownDocumentSession,
  createSessionEditorView
} from '../src/index.js';

describe('Real CodeMirror KeyboardEvent & DOM Widget Integration', () => {
  it('dispatches Enter keyboard event on contentDOM and intercepts in paragraph, but no-ops in code block', () => {
    const parent = document.createElement('div');
    const source = 'Paragraph text\n\n```ts\nconst x = 1;\n```';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual-events',
      surfaceKind: 'visual'
    });

    // 1. In paragraph: cursor at 'Paragraph| text' (pos 9)
    handle.view.dispatch({ selection: EditorSelection.cursor(9) });
    const enterEvent1 = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true
    });
    handle.view.contentDOM.dispatchEvent(enterEvent1);

    expect(enterEvent1.defaultPrevented).toBe(true);
    expect(session.getSnapshot().source).toBe('Paragraph\ntext\n\n```ts\nconst x = 1;\n```');
    expect(session.getSnapshot().revision).toBe(1);

    // 2. In fenced code block: cursor at 'const x =| 1;'
    const codePos = session.getSnapshot().source.indexOf('const x =');
    handle.view.dispatch({ selection: EditorSelection.cursor(codePos) });
    const enterEvent2 = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true
    });
    handle.view.contentDOM.dispatchEvent(enterEvent2);

    // Must be no-op (defaultPrevented false)
    expect(enterEvent2.defaultPrevented).toBe(false);
    expect(session.getSnapshot().revision).toBe(1); // Revision unchanged

    handle.destroy();
  });

  it('dispatches Backspace keyboard event on contentDOM to merge paragraphs and headings, guarding code blocks', () => {
    const parent = document.createElement('div');
    const source = 'Para 1\n\nPara 2\n\n# Heading\n\nPara 3\n\n```ts\nconst x = 1;\n```\n\nPara 4';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual-events',
      surfaceKind: 'visual'
    });

    // 1. At start of Para 2: should merge into Para 1
    const para2Start = source.indexOf('Para 2');
    handle.view.dispatch({ selection: EditorSelection.cursor(para2Start) });
    const bsEvent1 = new KeyboardEvent('keydown', {
      key: 'Backspace',
      code: 'Backspace',
      bubbles: true,
      cancelable: true
    });
    handle.view.contentDOM.dispatchEvent(bsEvent1);

    expect(bsEvent1.defaultPrevented).toBe(true);
    expect(session.getSnapshot().source.startsWith('Para 1Para 2')).toBe(true);
    expect(session.getSnapshot().revision).toBe(1);

    // 2. At start of Para 3 (preceded by Heading): should merge into Heading
    const para3Start = session.getSnapshot().source.indexOf('Para 3');
    handle.view.dispatch({ selection: EditorSelection.cursor(para3Start) });
    const bsEvent2 = new KeyboardEvent('keydown', {
      key: 'Backspace',
      code: 'Backspace',
      bubbles: true,
      cancelable: true
    });
    handle.view.contentDOM.dispatchEvent(bsEvent2);

    expect(bsEvent2.defaultPrevented).toBe(true);
    expect(session.getSnapshot().source.includes('# HeadingPara 3')).toBe(true);
    expect(session.getSnapshot().revision).toBe(2);

    // 3. At start of Para 4 (preceded by code block): must guard / no-op
    const para4Start = session.getSnapshot().source.indexOf('Para 4');
    handle.view.dispatch({ selection: EditorSelection.cursor(para4Start) });
    const bsEvent3 = new KeyboardEvent('keydown', {
      key: 'Backspace',
      code: 'Backspace',
      bubbles: true,
      cancelable: true
    });
    handle.view.contentDOM.dispatchEvent(bsEvent3);

    expect(bsEvent3.defaultPrevented).toBe(false);
    expect(session.getSnapshot().revision).toBe(2);

    handle.destroy();
  });

  it('dispatches Tab and Shift-Tab keyboard events to indent and outdent list items', () => {
    const parent = document.createElement('div');
    const source = '- Item 1\n- Item 2';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual-events',
      surfaceKind: 'visual'
    });

    // 1. Tab on Item 1 (root first item): no-op
    handle.view.dispatch({ selection: EditorSelection.cursor(4) });
    const tabEvent1 = new KeyboardEvent('keydown', {
      key: 'Tab',
      code: 'Tab',
      bubbles: true,
      cancelable: true
    });
    handle.view.contentDOM.dispatchEvent(tabEvent1);
    expect(tabEvent1.defaultPrevented).toBe(false);

    // 2. Tab on Item 2: indents
    const item2Pos = source.indexOf('- Item 2') + 4;
    handle.view.dispatch({ selection: EditorSelection.cursor(item2Pos) });
    const tabEvent2 = new KeyboardEvent('keydown', {
      key: 'Tab',
      code: 'Tab',
      bubbles: true,
      cancelable: true
    });
    handle.view.contentDOM.dispatchEvent(tabEvent2);

    expect(tabEvent2.defaultPrevented).toBe(true);
    expect(session.getSnapshot().source).toBe('- Item 1\n  - Item 2');
    expect(session.getSnapshot().revision).toBe(1);

    // 3. Shift-Tab on nested Item 2: outdents
    const shiftTabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      code: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    handle.view.contentDOM.dispatchEvent(shiftTabEvent);

    expect(shiftTabEvent.defaultPrevented).toBe(true);
    expect(session.getSnapshot().source).toBe('- Item 1\n- Item 2');
    expect(session.getSnapshot().revision).toBe(2);

    handle.destroy();
  });

  it('dispatches Mod-B and Mod-I keyboard events to format selection and supports undo', () => {
    const parent = document.createElement('div');
    const source = 'Hello formatting target world';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual-events',
      surfaceKind: 'visual'
    });

    // Select 'target' [17, 23)
    const targetStart = source.indexOf('target');
    handle.view.dispatch({ selection: EditorSelection.range(targetStart, targetStart + 6) });

    // Mod-B (Ctrl+b)
    const modBEvent = new KeyboardEvent('keydown', {
      key: 'b',
      code: 'KeyB',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    });
    handle.view.contentDOM.dispatchEvent(modBEvent);

    expect(modBEvent.defaultPrevented).toBe(true);
    expect(session.getSnapshot().source).toBe('Hello formatting **target** world');
    expect(session.getSnapshot().revision).toBe(1);

    // Undo restores plain text
    expect(session.undo()).toBe(true);
    expect(session.getSnapshot().source).toBe(source);

    handle.destroy();
  });

  it('does not dispatch or modify session when view is in readOnly mode', () => {
    const parent = document.createElement('div');
    const source = 'Read only text';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual-events',
      surfaceKind: 'visual',
      readOnly: true
    });

    handle.view.dispatch({ selection: EditorSelection.cursor(5) });
    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true
    });
    handle.view.contentDOM.dispatchEvent(enterEvent);

    expect(enterEvent.defaultPrevented).toBe(false);
    expect(session.getSnapshot().source).toBe(source);
    expect(session.getSnapshot().revision).toBe(0);

    handle.destroy();
  });

  it('queries real DOM TaskCheckboxWidget from mounted view and toggles on click', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const source = '- [ ] Buy milk\n- [x] Drink coffee';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual-dom',
      surfaceKind: 'visual'
    });

    const checkboxes = parent.querySelectorAll<HTMLInputElement>('.cm-visual-task-checkbox');
    expect(checkboxes.length).toBe(2);
    expect(checkboxes[0]?.checked).toBe(false);
    expect(checkboxes[1]?.checked).toBe(true);

    // Simulate clicking first checkbox
    checkboxes[0]!.checked = true;
    checkboxes[0]!.dispatchEvent(new Event('change', { bubbles: true }));

    expect(session.getSnapshot().source).toBe('- [x] Buy milk\n- [x] Drink coffee');
    expect(session.getSnapshot().revision).toBe(1);

    // Single undo restores
    expect(session.undo()).toBe(true);
    expect(session.getSnapshot().source).toBe(source);

    handle.destroy();
    parent.remove();
  });

  it('dispatches Alt-ArrowDown and Alt-ArrowUp keyboard events on contentDOM to reorder blocks', () => {
    const parent = document.createElement('div');
    const source = '# Heading One\n\nParagraph Two\n\n- Item Three';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual-events',
      surfaceKind: 'visual'
    });

    // 1. Cursor inside Heading One (pos 4)
    handle.view.dispatch({ selection: EditorSelection.cursor(4) });

    // Alt-ArrowUp at first block: must be no-op (defaultPrevented false)
    const upEvent1 = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      code: 'ArrowUp',
      altKey: true,
      bubbles: true,
      cancelable: true
    });
    handle.view.contentDOM.dispatchEvent(upEvent1);
    expect(upEvent1.defaultPrevented).toBe(false);
    expect(session.getSnapshot().source).toBe(source);
    expect(session.getSnapshot().revision).toBe(0);

    // Alt-ArrowDown: moves Heading One down below Paragraph Two
    const downEvent1 = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      code: 'ArrowDown',
      altKey: true,
      bubbles: true,
      cancelable: true
    });
    handle.view.contentDOM.dispatchEvent(downEvent1);
    expect(downEvent1.defaultPrevented).toBe(true);
    expect(session.getSnapshot().source).toBe('Paragraph Two\n\n# Heading One\n\n- Item Three');
    expect(session.getSnapshot().revision).toBe(1);

    // Alt-ArrowUp: moves Heading One back up
    const upEvent2 = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      code: 'ArrowUp',
      altKey: true,
      bubbles: true,
      cancelable: true
    });
    handle.view.contentDOM.dispatchEvent(upEvent2);
    expect(upEvent2.defaultPrevented).toBe(true);
    expect(session.getSnapshot().source).toBe(source);
    expect(session.getSnapshot().revision).toBe(2);

    handle.destroy();
  });

  it('dispatches Mod-Shift-Space keyboard event on contentDOM to select full block at cursor', () => {
    const parent = document.createElement('div');
    const source = '# Heading One\n\nParagraph Two';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual-events',
      surfaceKind: 'visual'
    });

    // Cursor inside Paragraph Two (pos 18)
    const paraStart = source.indexOf('Paragraph Two');
    handle.view.dispatch({ selection: EditorSelection.cursor(paraStart + 3) });

    // Mod-Shift-Space (Ctrl+Shift+Space)
    const selectBlockEvent = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    handle.view.contentDOM.dispatchEvent(selectBlockEvent);

    expect(selectBlockEvent.defaultPrevented).toBe(true);
    expect(handle.view.state.selection.main.from).toBe(paraStart);
    expect(handle.view.state.selection.main.to).toBe(paraStart + 'Paragraph Two'.length);

    handle.destroy();
  });

  it('dispatches keyboard events for nested block selection and movement on contentDOM', () => {
    const parent = document.createElement('div');
    const source = '> Block 1\n>\n> Block 2';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual-events',
      surfaceKind: 'visual'
    });

    const b1Start = source.indexOf('Block 1');
    handle.view.dispatch({ selection: EditorSelection.cursor(b1Start + 2) });

    // 1. Mod-Shift-Space selects Block 1 inside blockquote
    const selectEvent = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    handle.view.contentDOM.dispatchEvent(selectEvent);
    expect(selectEvent.defaultPrevented).toBe(true);
    expect(handle.view.state.selection.main.from).toBe(b1Start);
    expect(handle.view.state.selection.main.to).toBe(b1Start + 'Block 1'.length);

    // 2. Alt-ArrowUp on Block 1 (first block in blockquote) is no-op
    const upEvent = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      code: 'ArrowUp',
      altKey: true,
      bubbles: true,
      cancelable: true
    });
    handle.view.contentDOM.dispatchEvent(upEvent);
    expect(upEvent.defaultPrevented).toBe(false);

    // 3. Alt-ArrowDown on Block 1 moves it down within blockquote
    const downEvent = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      code: 'ArrowDown',
      altKey: true,
      bubbles: true,
      cancelable: true
    });
    handle.view.contentDOM.dispatchEvent(downEvent);
    expect(downEvent.defaultPrevented).toBe(true);
    expect(session.getSnapshot().source).toBe('> Block 2\n>\n> Block 1');

    handle.destroy();
  });
});



