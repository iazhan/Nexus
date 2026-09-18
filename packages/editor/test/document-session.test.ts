import { EditorState, Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  MarkdownDocumentSession,
  type MarkdownSurfaceRegistration,
  type MarkdownDocumentSnapshot,
  type MarkdownEditTransaction
} from '../src/index.js';

function createHeadlessSurface(
  id: string,
  source: string,
  kind: 'source' | 'visual'
): MarkdownSurfaceRegistration {
  const doc = source.includes('\r\n') ? Text.of(source.split('\n')) : source;
  let state = EditorState.create({ doc });
  return {
    id,
    kind,
    view: {
      get state() {
        return state;
      },
      dispatch(spec) {
        state = state.update(spec).state;
      }
    }
  };
}

describe('MarkdownDocumentSession', () => {
  it('keeps canonical source, revision, and source selection behind one interface', () => {
    const session = new MarkdownDocumentSession('Hello');

    expect(session.getSnapshot()).toEqual({
      source: 'Hello',
      revision: 0,
      selection: { anchor: 0, head: 0 }
    });

    session.dispatch({
      changes: [{ from: 5, to: 5, insert: ' world' }],
      selection: { anchor: 11, head: 11 },
      userEvent: 'input.type'
    });

    expect(session.getSnapshot()).toEqual({
      source: 'Hello world',
      revision: 1,
      selection: { anchor: 11, head: 11 }
    });
  });

  it('maps the current selection when a transaction does not provide one', () => {
    const session = new MarkdownDocumentSession('abcdef');
    session.setSelection({ anchor: 3, head: 3 });

    session.dispatch({
      changes: [{ from: 0, to: 0, insert: 'x' }],
      userEvent: 'input.type'
    });

    expect(session.getSnapshot().selection).toEqual({ anchor: 4, head: 4 });
  });

  it('notifies subscribers with the committed snapshot and transaction', () => {
    const events: Array<{
      snapshot: MarkdownDocumentSnapshot;
      transaction?: MarkdownEditTransaction;
    }> = [];
    const session = new MarkdownDocumentSession('before');
    const unsubscribe = session.subscribe((snapshot, transaction) => {
      events.push({ snapshot, transaction });
    });

    session.dispatch({
      changes: [{ from: 0, to: 6, insert: 'after' }],
      userEvent: 'input.replace'
    });
    unsubscribe();
    session.dispatch({ changes: [{ from: 0, to: 5, insert: 'final' }] });

    expect(events).toHaveLength(1);
    expect(events[0]?.snapshot.source).toBe('after');
    expect(events[0]?.transaction?.userEvent).toBe('input.replace');
  });

  it('coordinates undo and redo without creating a second source of truth', () => {
    const session = new MarkdownDocumentSession('one');

    session.dispatch({ changes: [{ from: 3, to: 3, insert: ' two' }] });
    session.dispatch({ changes: [{ from: 7, to: 7, insert: ' three' }] });

    expect(session.canUndo).toBe(true);
    expect(session.undo()).toBe(true);
    expect(session.getSnapshot().source).toBe('one two');
    expect(session.redo()).toBe(true);
    expect(session.getSnapshot().source).toBe('one two three');
  });

  it('clears stale user history when an external source replacement is applied', () => {
    const session = new MarkdownDocumentSession('old');
    session.dispatch({ changes: [{ from: 3, to: 3, insert: ' edit' }] });

    session.replaceSource('reloaded');

    expect(session.getSnapshot().source).toBe('reloaded');
    expect(session.canUndo).toBe(false);
    expect(session.canRedo).toBe(false);
    expect(session.undo()).toBe(false);
    expect(session.getSnapshot().source).toBe('reloaded');
  });

  it('rejects overlapping or out-of-bounds source changes before mutating state', () => {
    const session = new MarkdownDocumentSession('abcdef');

    expect(() =>
      session.dispatch({
        changes: [
          { from: 0, to: 3, insert: 'x' },
          { from: 2, to: 4, insert: 'y' }
        ]
      })
    ).toThrow(/overlap/i);

    expect(() =>
      session.dispatch({ changes: [{ from: 0, to: 99, insert: '' }] })
    ).toThrow(/range/i);

    expect(session.getSnapshot().source).toBe('abcdef');
    expect(session.getSnapshot().revision).toBe(0);
  });

  it('synchronizes registered Source and Visual surfaces through mapped changes', () => {
    const sourceSurface = createHeadlessSurface('source', 'one\ntwo', 'source');
    const visualSurface = createHeadlessSurface('visual', 'one\ntwo', 'visual');
    const session = new MarkdownDocumentSession('one\ntwo');

    session.registerSurface(sourceSurface);
    session.registerSurface(visualSurface);
    sourceSurface.view.dispatch({
      changes: { from: 3, to: 3, insert: ' updated' },
      selection: { anchor: 11, head: 11 }
    });
    session.dispatch(
      {
        changes: [{ from: 3, to: 3, insert: ' updated' }],
        selection: { anchor: 11, head: 11 },
        userEvent: 'input.type'
      },
      'source'
    );

    expect(sourceSurface.view.state.doc.toString()).toBe('one updated\ntwo');
    expect(visualSurface.view.state.doc.toString()).toBe('one updated\ntwo');
    expect(visualSurface.view.state.selection.main.head).toBe(11);
    expect(session.getSnapshot().selection).toEqual({ anchor: 11, head: 11 });
  });

  it('keeps surface selections aligned after an external source replacement', () => {
    const sourceSurface = createHeadlessSurface('source', 'alpha', 'source');
    const visualSurface = createHeadlessSurface('visual', 'alpha', 'visual');
    const session = new MarkdownDocumentSession('alpha');
    session.registerSurface(sourceSurface);
    session.registerSurface(visualSurface);
    session.setSelection({ anchor: 5, head: 5 });

    session.replaceSource('alpha\nbeta', { selection: { anchor: 10, head: 10 } });

    expect(sourceSurface.view.state.doc.toString()).toBe('alpha\nbeta');
    expect(visualSurface.view.state.doc.toString()).toBe('alpha\nbeta');
    expect(sourceSurface.view.state.selection.main.head).toBe(10);
    expect(visualSurface.view.state.selection.main.head).toBe(10);
  });

  it('handles surface divergence (longer and shorter, before/inside/after change, CRLF, CJK, Emoji) without clobbering origin or normal surfaces', () => {
    const initialSource = 'Header 🌲\r\n中文字符 🚀\r\nTail Section 🏁';
    const initialSelection = { anchor: 8, head: 8 };
    const session = new MarkdownDocumentSession(initialSource, initialSelection);

    // 1. Origin surface (dispatches edits)
    const originSurface = createHeadlessSurface('origin', initialSource, 'source');
    // 2. Normal surface (in sync with canonical)
    const normalSurface = createHeadlessSurface('normal', initialSource, 'visual');
    // 3. Divergent surface A: LONGER than canonical, divergence before and inside change range
    const divergentLonger = createHeadlessSurface(
      'divergent-longer',
      'Header 🌲 [DivergentLongerPrefix]\r\n中文字符 🚀\r\nTail Section 🏁',
      'visual'
    );
    // 4. Divergent surface B: SHORTER than canonical, divergence after change range
    const divergentShorter = createHeadlessSurface(
      'divergent-shorter',
      'Header 🌲\r\n中',
      'visual'
    );

    session.registerSurface(originSurface);
    session.registerSurface(normalSurface);
    session.registerSurface(divergentLonger);
    session.registerSurface(divergentShorter);

    const initialRev = session.getSnapshot().revision;

    // Origin surface performs an edit at the middle (modifying CJK and Emoji text)
    const targetText = '中文字符 🚀';
    const from = initialSource.indexOf(targetText);
    const to = from + targetText.length;
    const replacement = '更新内容 🎉';
    const expectedSource = initialSource.slice(0, from) + replacement + initialSource.slice(to);

    // 1. Origin surface dispatches change locally first (updating its local EditorState.doc)
    originSurface.view.dispatch({
      changes: [{ from, to, insert: replacement }],
      selection: { anchor: from + replacement.length, head: from + replacement.length }
    });
    expect(originSurface.view.state.doc.toString()).toBe(expectedSource);

    // 2. Dispatch to session from origin surface
    const snapshot = session.dispatch(
      {
        changes: [{ from, to, insert: replacement }],
        selection: { anchor: from + replacement.length, head: from + replacement.length },
        userEvent: 'input.type'
      },
      'origin'
    );

    expect(snapshot.source).toBe(expectedSource);
    expect(snapshot.revision).toBe(initialRev + 1);

    // 3. Origin surface is NOT clobbered or re-dispatched with redundant full doc replacement
    expect(originSurface.view.state.doc.toString()).toBe(expectedSource);

    // 4. Normal surface received mapped change and equals canonical source
    expect(normalSurface.view.state.doc.toString()).toBe(expectedSource);
    expect(normalSurface.view.state.selection.main.head).toBe(snapshot.selection.head);

    // 5. Divergent longer surface (divergence before & inside change) received full resync and equals canonical source
    expect(divergentLonger.view.state.doc.toString()).toBe(expectedSource);
    expect(divergentLonger.view.state.selection.main.head).toBe(snapshot.selection.head);

    // 6. Divergent shorter surface (divergence after change) received full resync and equals canonical source
    expect(divergentShorter.view.state.doc.toString()).toBe(expectedSource);
    expect(divergentShorter.view.state.selection.main.head).toBe(snapshot.selection.head);

    // 7. Revision and Undo/Redo count
    expect(session.canUndo).toBe(true);
    expect(session.canRedo).toBe(false);

    // Exactly 1 undo step restores all surfaces (including origin) to initial canonical source
    session.undo();
    expect(session.getSnapshot().source).toBe(initialSource);
    expect(originSurface.view.state.doc.toString()).toBe(initialSource);
    expect(normalSurface.view.state.doc.toString()).toBe(initialSource);
    expect(divergentLonger.view.state.doc.toString()).toBe(initialSource);
    expect(divergentShorter.view.state.doc.toString()).toBe(initialSource);
    expect(session.canUndo).toBe(false);
    expect(session.canRedo).toBe(true);

    // Redo restores to expected source
    session.redo();
    expect(session.getSnapshot().source).toBe(expectedSource);
    expect(originSurface.view.state.doc.toString()).toBe(expectedSource);
    expect(normalSurface.view.state.doc.toString()).toBe(expectedSource);
    expect(divergentLonger.view.state.doc.toString()).toBe(expectedSource);
    expect(divergentShorter.view.state.doc.toString()).toBe(expectedSource);
  });
});
