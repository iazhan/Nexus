import { EditorState } from '@codemirror/state';
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
  let state = EditorState.create({ doc: source });
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
});
