import {
  EditorSelection,
  EditorState,
  Prec,
  Transaction,
  type ChangeSet,
  type Extension,
} from '@codemirror/state';
import { EditorView, keymap, type KeyBinding } from '@codemirror/view';
import {
  MarkdownDocumentSession,
  sessionSyncAnnotation
} from './document-session.js';
import { getSourceEditorExtensions } from './source-editor.js';
import { visualProjectionExtensions } from './visual-projection.js';
import type { EditorSurfaceKind, MarkdownChange, MarkdownSelection } from './types.js';

export interface CreateSessionEditorStateOptions {
  session: MarkdownDocumentSession;
  surfaceId: string;
  surfaceKind: EditorSurfaceKind;
  readOnly?: boolean;
  onSelectionChange?: (selection: MarkdownSelection) => void;
}

export interface CreateSessionEditorViewOptions extends CreateSessionEditorStateOptions {
  parent: HTMLElement;
}

export interface SessionEditorViewHandle {
  view: EditorView;
  destroy: () => void;
}

function selectionFromState(state: EditorState): MarkdownSelection {
  return {
    anchor: state.selection.main.anchor,
    head: state.selection.main.head
  };
}

function changesFromChangeSet(changeSet: ChangeSet): MarkdownChange[] {
  const changes: MarkdownChange[] = [];
  changeSet.iterChanges((from, to, _fromB, _toB, insert) => {
    changes.push({ from, to, insert: insert.toString() });
  });
  return changes;
}

function getUserEvent(transactions: readonly Transaction[]): string | undefined {
  for (const transaction of transactions) {
    const userEvent = transaction.annotation(Transaction.userEvent);
    if (userEvent) return userEvent;
  }
  return undefined;
}

function createSessionHistoryKeymap(session: MarkdownDocumentSession): KeyBinding[] {
  return [
    { key: 'Mod-z', run: () => session.undo() },
    { key: 'Mod-y', run: () => session.redo() },
    { key: 'Mod-Shift-z', run: () => session.redo() }
  ];
}

function createSessionSurfaceExtensions(options: CreateSessionEditorStateOptions): Extension[] {
  const { session, surfaceId, onSelectionChange } = options;

  return [
    Prec.highest(keymap.of(createSessionHistoryKeymap(session))),
    EditorView.updateListener.of((update) => {
      const isSessionSync = update.transactions.some(
        (transaction) => transaction.annotation(sessionSyncAnnotation) !== undefined
      );
      const selection = selectionFromState(update.state);
      onSelectionChange?.(selection);

      if (isSessionSync) return;

      if (update.docChanged) {
        session.dispatch(
          {
            changes: changesFromChangeSet(update.changes),
            selection,
            userEvent: getUserEvent(update.transactions)
          },
          surfaceId
        );
        return;
      }

      if (update.selectionSet) {
        session.setSelection(selection, surfaceId);
      }
    })
  ];
}

/** 创建不挂载 DOM 的 session-backed Source/Visual EditorState。 */
export function createSessionEditorState(options: CreateSessionEditorStateOptions): EditorState {
  const sourceExtensions = getSourceEditorExtensions({
    doc: options.session.getSnapshot().source,
    readOnly: options.readOnly,
    includeHistory: false
  });
  const projectionExtensions = options.surfaceKind === 'visual' ? visualProjectionExtensions : [];

  return EditorState.create({
    doc: options.session.getSnapshot().source,
    extensions: [
      ...sourceExtensions,
      ...projectionExtensions,
      ...createSessionSurfaceExtensions(options)
    ]
  });
}

/** 创建并注册一个由 MarkdownDocumentSession 协调的 CodeMirror surface。 */
export function createSessionEditorView(
  options: CreateSessionEditorViewOptions
): SessionEditorViewHandle {
  const view = new EditorView({
    state: createSessionEditorState(options),
    parent: options.parent
  });
  const unregister = options.session.registerSurface({
    id: options.surfaceId,
    kind: options.surfaceKind,
    view
  });

  options.onSelectionChange?.(selectionFromState(view.state));

  return {
    view,
    destroy: () => {
      unregister();
      view.destroy();
    }
  };
}

/** 将 session selection 转成 CodeMirror selection，供 surface bridge 使用。 */
export function toEditorSelection(selection: MarkdownSelection): EditorSelection {
  return EditorSelection.single(selection.anchor, selection.head);
}
