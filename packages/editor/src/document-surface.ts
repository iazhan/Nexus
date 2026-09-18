import {
  EditorSelection,
  EditorState,
  Prec,
  Text,
  Transaction,
  type ChangeSet,
  type Extension,
} from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, type KeyBinding } from '@codemirror/view';
import {
  MarkdownDocumentSession,
  createMarkdownChangeSet,
  mapMarkdownSelection,
  sessionSyncAnnotation,
  sessionDocSyncAnnotation,
  sessionSelectionSyncAnnotation
} from './document-session.js';
import { getSourceEditorExtensions } from './source-editor.js';
import { visualProjectionExtensions } from './visual-projection.js';
import { visualCommandsExtension } from './visual-commands.js';
import { createVisualDragExtension } from './drag-handle.js';
import { createInlineEditExtension, type ImageSourceResolver } from './inline-edit.js';
import {
  createImeCompositionExtension,
  isEditorComposing,
  setComposingEffect
} from './ime-composition.js';
import { createClipboardExtension } from './clipboard.js';
import { editorKeybindings, visualEditorKeybindings } from './keymaps.js';
import type { EditorSurfaceKind, MarkdownChange, MarkdownSelection } from './types.js';

export interface CreateSessionEditorStateOptions {
  session: MarkdownDocumentSession;
  surfaceId: string;
  surfaceKind: EditorSurfaceKind;
  readOnly?: boolean;
  imageSourceResolver?: ImageSourceResolver;
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

function changesFromChangeSet(changeSet: ChangeSet, isCRLF = false): MarkdownChange[] {
  const changes: MarkdownChange[] = [];
  changeSet.iterChanges((from, to, _fromB, _toB, insert) => {
    const text = isCRLF ? insert.sliceString(0, insert.length, '\r\n') : insert.toString();
    changes.push({ from, to, insert: text });
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

function computeTextDiff(
  oldText: string,
  newText: string
): { from: number; to: number; insert: string } | null {
  if (oldText === newText) return null;
  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldText.length - prefix &&
    suffix < newText.length - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    from: prefix,
    to: oldText.length - suffix,
    insert: newText.slice(prefix, newText.length - suffix)
  };
}

interface SurfaceCompositionState {
  isComposing: boolean;
  aborted: boolean;
  startedRevision: number;
  startedSource: string;
  startedSelection: MarkdownSelection;
  pendingCommit: boolean;
  queuedSelection: MarkdownSelection | null;
  isDestroyed: boolean;
}

function createSessionSurfaceExtensions(options: CreateSessionEditorStateOptions): Extension[] {
  const { session, surfaceId, onSelectionChange } = options;

  const compState: SurfaceCompositionState = {
    isComposing: false,
    aborted: false,
    startedRevision: session.getSnapshot().revision,
    startedSource: session.getSnapshot().source,
    startedSelection: session.getSnapshot().selection,
    pendingCommit: false,
    queuedSelection: null,
    isDestroyed: false
  };

  return [
    Prec.highest(keymap.of(createSessionHistoryKeymap(session))),
    ViewPlugin.define(() => ({
      destroy() {
        compState.isDestroyed = true;
        compState.aborted = true;
        compState.isComposing = false;
        compState.pendingCommit = false;
        compState.queuedSelection = null;
      }
    })),
    EditorState.transactionFilter.of((tr) => {
      // 1. Dynamic readOnly transition: abort composition & restore canonical state
      const becomingReadOnly = !tr.startState.readOnly && tr.state.readOnly;
      if (becomingReadOnly) {
        const isComposing = isEditorComposing(tr.startState);
        const snapshot = session.getSnapshot();
        const sessionSource = snapshot.source;
        const isDocDirty = tr.startState.doc.toString() !== sessionSource;
        if (isComposing || isDocDirty) {
          compState.aborted = true;
          compState.isComposing = false;
          compState.pendingCommit = false;
          compState.queuedSelection = null;
          const isCRLF = sessionSource.includes('\r\n');
          const docInsert = isCRLF ? Text.of(sessionSource.split('\n')) : sessionSource;
          return {
            changes: { from: 0, to: tr.startState.doc.length, insert: docInsert },
            selection: toEditorSelection(snapshot.selection),
            effects: [...tr.effects, setComposingEffect.of(false)],
            annotations: sessionSyncAnnotation.of(snapshot.revision)
          };
        }
      }

      // 2. Selection-only sync from another surface during active composition:
      // completely ignore or queue external selection so local composition cursor and replacement range are untouched
      const isComposing = isEditorComposing(tr.startState);
      if (isComposing) {
        const isSelectionOnlySync =
          !tr.docChanged &&
          (tr.annotation(sessionSelectionSyncAnnotation) !== undefined ||
            (tr.annotation(sessionSyncAnnotation) !== undefined &&
              tr.annotation(sessionDocSyncAnnotation) === undefined));
        if (isSelectionOnlySync) {
          const main = tr.selection?.main;
          if (main) {
            compState.queuedSelection = { anchor: main.anchor, head: main.head };
          }
          return [];
        }
      }

      return tr;
    }),
    EditorView.updateListener.of((update) => {
      const isDocSessionSync =
        update.docChanged &&
        update.transactions.some(
          (transaction) =>
            transaction.annotation(sessionDocSyncAnnotation) !== undefined ||
            (transaction.annotation(sessionSyncAnnotation) !== undefined &&
              transaction.annotation(sessionSelectionSyncAnnotation) === undefined)
        );
      const selection = selectionFromState(update.state);
      onSelectionChange?.(selection);

      if (isDocSessionSync) {
        if (compState.isComposing || compState.pendingCommit) {
          compState.aborted = true;
          compState.isComposing = false;
          compState.pendingCommit = false;
          compState.queuedSelection = null;
        }
        return;
      }

      const composingNow = isEditorComposing(update.view);
      const justStartedComposing = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setComposingEffect) && e.value)
      );
      const justFinishedComposing = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setComposingEffect) && !e.value)
      );

      if (justStartedComposing) {
        compState.isComposing = true;
        compState.aborted = false;
        compState.startedRevision = session.getSnapshot().revision;
        compState.startedSource = session.getSnapshot().source;
        compState.startedSelection = selectionFromState(update.startState);
        compState.pendingCommit = false;
        compState.queuedSelection = null;
      }

      if (composingNow) {
        if (update.docChanged) {
          compState.pendingCommit = true;
        }
        return;
      }

      if (justFinishedComposing) {
        compState.isComposing = false;
        if (compState.aborted) {
          compState.pendingCommit = false;
          compState.aborted = false;
          compState.queuedSelection = null;
          return;
        }
        compState.pendingCommit = true;
      }

      if (compState.pendingCommit) {
        if (update.state.readOnly || compState.aborted) {
          compState.pendingCommit = false;
          compState.queuedSelection = null;
          return;
        }
        if (compState.startedRevision !== session.getSnapshot().revision) {
          compState.aborted = true;
          compState.pendingCommit = false;
          compState.queuedSelection = null;
          return;
        }
        const sessionSource = session.getSnapshot().source;
        const currentDoc = update.state.doc.toString();
        if (currentDoc !== sessionSource) {
          const diff = computeTextDiff(sessionSource, currentDoc);
          if (diff) {
            compState.pendingCommit = false;
            const queued = compState.queuedSelection;
            compState.queuedSelection = null;
            const mappedQueued = queued
              ? mapMarkdownSelection(queued, createMarkdownChangeSet(sessionSource, [diff]))
              : undefined;
            session.dispatch(
              {
                changes: [diff],
                selection: mappedQueued ?? selection,
                userEvent: getUserEvent(update.transactions) ?? 'input.type'
              },
              surfaceId
            );
            if (mappedQueued) {
              queueMicrotask(() => {
                if (!compState.isDestroyed) {
                  update.view.dispatch({
                    selection: toEditorSelection(mappedQueued)
                  });
                }
              });
            }
            return;
          }
        } else if (!update.docChanged) {
          compState.pendingCommit = false;
          const queued = compState.queuedSelection;
          compState.queuedSelection = null;
          if (queued) {
            queueMicrotask(() => {
              if (!compState.isDestroyed) {
                update.view.dispatch({
                  selection: toEditorSelection(queued)
                });
              }
            });
          }
        }
      }

      if (update.docChanged) {
        if (update.state.readOnly) return;
        const isCRLF = session.getSnapshot().source.includes('\r\n');
        session.dispatch(
          {
            changes: changesFromChangeSet(update.changes, isCRLF),
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
  const rawSource = options.session.getSnapshot().source;
  const doc = rawSource.includes('\r\n') ? Text.of(rawSource.split('\n')) : rawSource;
  const sourceExtensions = getSourceEditorExtensions({
    doc: rawSource,
    readOnly: options.readOnly,
    includeHistory: false,
    keybindings: options.surfaceKind === 'visual' ? visualEditorKeybindings : editorKeybindings
  });
  const visualExtensions = options.surfaceKind === 'visual'
    ? [
        Prec.high(visualCommandsExtension),
        createVisualDragExtension(options.session),
        createInlineEditExtension(options.session, {
          surfaceId: options.surfaceId,
          imageSourceResolver: options.imageSourceResolver
        }),
        ...visualProjectionExtensions
      ]
    : [];

  return EditorState.create({
    doc,
    extensions: [
      createImeCompositionExtension(),
      createClipboardExtension(options.session, {
        surfaceId: options.surfaceId,
        readOnly: options.readOnly
      }),
      ...visualExtensions,
      ...sourceExtensions,
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
