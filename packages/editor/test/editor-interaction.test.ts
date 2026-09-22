// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { EditorSelection } from '@codemirror/state';
import {
  MarkdownDocumentSession,
  createSessionEditorState,
  createSessionEditorView,
  createParagraphOrHeadingSplitTransaction,
  handleVisualEnter,
  handleVisualBackspace,
  handleVisualTab,
  handleVisualShiftTab,
  handleVisualModB,
  handleVisualModI,
  handleVisualSelectBlock,
  handleVisualMoveBlockUp,
  handleVisualMoveBlockDown,
  TaskCheckboxWidget
} from '../src/index.js';

describe('Editor Interaction & Surface Synchronization', () => {
  it('dispatches transactions to session and synchronizes both Source and Visual surfaces', () => {
    const session = new MarkdownDocumentSession('Hello world', { anchor: 5, head: 5 });

    let sourceState = createSessionEditorState({
      session,
      surfaceId: 'source-surface',
      surfaceKind: 'source'
    });

    let visualState = createSessionEditorState({
      session,
      surfaceId: 'visual-surface',
      surfaceKind: 'visual'
    });

    session.registerSurface({
      id: 'source-surface',
      kind: 'source',
      view: {
        get state() {
          return sourceState;
        },
        dispatch(spec) {
          sourceState = sourceState.update(spec).state;
        }
      }
    });

    session.registerSurface({
      id: 'visual-surface',
      kind: 'visual',
      view: {
        get state() {
          return visualState;
        },
        dispatch(spec) {
          visualState = visualState.update(spec).state;
        }
      }
    });

    // An Enter split transaction is dispatched
    const splitTx = createParagraphOrHeadingSplitTransaction(
      session.getSnapshot().source,
      session.getSnapshot().selection
    );
    expect(splitTx).not.toBeNull();

    session.dispatch(splitTx!);

    expect(session.getSnapshot().source).toBe('Hello\nworld');
    expect(sourceState.doc.toString()).toBe('Hello\nworld');
    expect(visualState.doc.toString()).toBe('Hello\nworld');

    // Both surfaces reflect mapped selection
    expect(session.getSnapshot().selection).toEqual({ anchor: 6, head: 6 });
    expect(sourceState.selection.main.head).toBe(6);
    expect(visualState.selection.main.head).toBe(6);

    // Undo synchronizes back to both surfaces
    session.undo();
    expect(session.getSnapshot().source).toBe('Hello world');
    expect(sourceState.doc.toString()).toBe('Hello world');
    expect(visualState.doc.toString()).toBe('Hello world');
  });

  it('switching surface does not lose session history, revision, or selection', () => {
    const session = new MarkdownDocumentSession('Initial text');

    // Edit 1
    session.dispatch({
      changes: [{ from: 12, to: 12, insert: ' edited' }],
      userEvent: 'input.type'
    });
    // Edit 2
    session.dispatch({
      changes: [{ from: 0, to: 0, insert: 'Super ' }],
      userEvent: 'input.type'
    });

    expect(session.getSnapshot().revision).toBe(2);
    expect(session.canUndo).toBe(true);

    // Simulate switching mode: create visual state from existing session
    const visualState = createSessionEditorState({
      session,
      surfaceId: 'new-visual',
      surfaceKind: 'visual'
    });

    expect(visualState.doc.toString()).toBe('Super Initial text edited');
    expect(session.canUndo).toBe(true);
    expect(session.getSnapshot().revision).toBe(2);

    // Undo works seamlessly in session
    session.undo();
    expect(session.getSnapshot().source).toBe('Initial text edited');
  });

  it('runs handleVisualEnter on an EditorView and dispatches exactly one session revision update', () => {
    const parent = document.createElement('div');
    const session = new MarkdownDocumentSession('First paragraph');
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual',
      surfaceKind: 'visual'
    });

    // Place caret at position 5 ('First| paragraph')
    handle.view.dispatch({ selection: EditorSelection.cursor(5) });

    const revBefore = session.getSnapshot().revision;
    const handled = handleVisualEnter(handle.view);

    expect(handled).toBe(true);
    expect(session.getSnapshot().revision).toBe(revBefore + 1);
    expect(session.getSnapshot().source).toBe('First\nparagraph');
    expect(handle.view.state.doc.toString()).toBe('First\nparagraph');

    handle.destroy();
  });

  it('runs handleVisualBackspace on an EditorView to merge paragraphs in a single undoable step', () => {
    const parent = document.createElement('div');
    const session = new MarkdownDocumentSession('Para 1\n\nPara 2');
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual',
      surfaceKind: 'visual'
    });

    // Place caret at start of second paragraph (pos 8)
    handle.view.dispatch({ selection: EditorSelection.cursor(8) });

    const handled = handleVisualBackspace(handle.view);

    expect(handled).toBe(true);
    expect(session.getSnapshot().source).toBe('Para 1Para 2');
    expect(handle.view.state.doc.toString()).toBe('Para 1Para 2');

    // Undo restores the two paragraphs
    expect(session.undo()).toBe(true);
    expect(session.getSnapshot().source).toBe('Para 1\n\nPara 2');
    expect(handle.view.state.doc.toString()).toBe('Para 1\n\nPara 2');

    handle.destroy();
  });

  it('runs handleVisualTab and handleVisualShiftTab to adjust list indentation', () => {
    const parent = document.createElement('div');
    const session = new MarkdownDocumentSession('- Alpha\n- Beta');
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual',
      surfaceKind: 'visual'
    });

    // Caret inside '- Beta' (pos 10)
    handle.view.dispatch({ selection: EditorSelection.cursor(10) });

    expect(handleVisualTab(handle.view)).toBe(true);
    expect(session.getSnapshot().source).toBe('- Alpha\n  - Beta');

    expect(handleVisualShiftTab(handle.view)).toBe(true);
    expect(session.getSnapshot().source).toBe('- Alpha\n- Beta');

    handle.destroy();
  });

  it('runs handleVisualModB and handleVisualModI on selections to format and unwrap', () => {
    const parent = document.createElement('div');
    const session = new MarkdownDocumentSession('Format this target text');
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual',
      surfaceKind: 'visual'
    });

    // Select 'target' [12, 18)
    handle.view.dispatch({ selection: EditorSelection.range(12, 18) });

    expect(handleVisualModB(handle.view)).toBe(true);
    expect(session.getSnapshot().source).toBe('Format this **target** text');

    // Caret mapped inside **target**: [14, 20)
    handle.view.dispatch({ selection: EditorSelection.range(14, 20) });
    expect(handleVisualModB(handle.view)).toBe(true);
    expect(session.getSnapshot().source).toBe('Format this target text');

    // Mod-I on 'target': [12, 18)
    handle.view.dispatch({ selection: EditorSelection.range(12, 18) });
    expect(handleVisualModI(handle.view)).toBe(true);
    expect(session.getSnapshot().source).toBe('Format this *target* text');

    // Mod-I unwrap: [13, 19)
    handle.view.dispatch({ selection: EditorSelection.range(13, 19) });
    expect(handleVisualModI(handle.view)).toBe(true);
    expect(session.getSnapshot().source).toBe('Format this target text');

    handle.destroy();
  });

  it('TaskCheckboxWidget toDOM toggles task state in document without full text search', () => {
    const parent = document.createElement('div');
    const session = new MarkdownDocumentSession('- [ ] Check me');
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual',
      surfaceKind: 'visual'
    });

    const widget = new TaskCheckboxWidget(false, 2, 5);
    const checkboxElement = widget.toDOM(handle.view) as HTMLInputElement;

    expect(checkboxElement.checked).toBe(false);

    // Simulate clicking/checking
    checkboxElement.checked = true;
    checkboxElement.dispatchEvent(new Event('change'));

    expect(session.getSnapshot().source).toBe('- [x] Check me');
    expect(handle.view.state.doc.toString()).toBe('- [x] Check me');

    handle.destroy();
  });

  it('runs handleVisualSelectBlock on EditorView to select full block at cursor', () => {
    const parent = document.createElement('div');
    const session = new MarkdownDocumentSession('# Heading\n\nParagraph text');
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual',
      surfaceKind: 'visual'
    });

    // Place caret inside paragraph (pos 15)
    handle.view.dispatch({ selection: EditorSelection.cursor(15) });

    const handled = handleVisualSelectBlock(handle.view);
    expect(handled).toBe(true);

    const paraStart = session.getSnapshot().source.indexOf('Paragraph text');
    const paraEnd = paraStart + 'Paragraph text'.length;

    expect(handle.view.state.selection.main.from).toBe(paraStart);
    expect(handle.view.state.selection.main.to).toBe(paraEnd);
    expect(session.getSnapshot().selection).toEqual({
      anchor: paraStart,
      head: paraEnd
    });

    handle.destroy();
  });

  it('runs handleVisualMoveBlockDown and handleVisualMoveBlockUp to reorder blocks and synchronize session', () => {
    const parent = document.createElement('div');
    const source = '# First Block\n\nParagraph Two\n\n- List Three';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual',
      surfaceKind: 'visual'
    });

    // Place caret inside first block ('# First Block', pos 3)
    handle.view.dispatch({ selection: EditorSelection.cursor(3) });

    // Moving up at first block is no-op
    expect(handleVisualMoveBlockUp(handle.view)).toBe(false);
    expect(session.getSnapshot().source).toBe(source);

    // Move block down (swapping block 0 and block 1)
    const movedDown = handleVisualMoveBlockDown(handle.view);
    expect(movedDown).toBe(true);
    expect(session.getSnapshot().source).toBe('Paragraph Two\n\n# First Block\n\n- List Three');
    expect(handle.view.state.doc.toString()).toBe('Paragraph Two\n\n# First Block\n\n- List Three');

    // Move block back up (swapping block 1 and block 0)
    const movedUp = handleVisualMoveBlockUp(handle.view);
    expect(movedUp).toBe(true);
    expect(session.getSnapshot().source).toBe(source);
    expect(handle.view.state.doc.toString()).toBe(source);

    // Single undo test: undo restores previous state
    expect(session.undo()).toBe(true);
    expect(session.getSnapshot().source).toBe('Paragraph Two\n\n# First Block\n\n- List Three');

    handle.destroy();
  });

  it('handles nested block selection, reorder, revision counting, undo and redo across surfaces', () => {
    const parent = document.createElement('div');
    const source = '> Block 1\n>\n> Block 2';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual',
      surfaceKind: 'visual'
    });

    // 1. Nested block selection: place caret inside Block 1
    const block1Pos = source.indexOf('Block 1') + 2;
    handle.view.dispatch({ selection: EditorSelection.cursor(block1Pos) });
    expect(handleVisualSelectBlock(handle.view)).toBe(true);

    const sel = handle.view.state.selection.main;
    expect(sel.from).toBe(source.indexOf('Block 1'));
    expect(sel.to).toBe(source.indexOf('Block 1') + 'Block 1'.length);

    // 2. Nested block reorder: move Block 1 DOWN within blockquote
    const revBefore = session.getSnapshot().revision;
    expect(handleVisualMoveBlockDown(handle.view)).toBe(true);
    expect(session.getSnapshot().revision).toBe(revBefore + 1);

    expect(session.getSnapshot().source).toBe('> Block 2\n>\n> Block 1');
    expect(handle.view.state.doc.toString()).toBe('> Block 2\n>\n> Block 1');

    // 3. Single undo restores original source and revision
    expect(session.undo()).toBe(true);
    expect(session.getSnapshot().source).toBe(source);
    expect(handle.view.state.doc.toString()).toBe(source);

    // 4. Redo restores the moved state
    expect(session.redo()).toBe(true);
    expect(session.getSnapshot().source).toBe('> Block 2\n>\n> Block 1');
    expect(handle.view.state.doc.toString()).toBe('> Block 2\n>\n> Block 1');

    handle.destroy();
  });
});


