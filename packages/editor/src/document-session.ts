import {
  Annotation,
  ChangeSet,
  EditorSelection,
  type EditorState,
  type TransactionSpec
} from '@codemirror/state';
import type {
  EditorSurfaceKind,
  MarkdownChange,
  MarkdownDocumentSnapshot,
  MarkdownEditTransaction,
  MarkdownSelection,
  MarkdownSessionListener
} from './types.js';

interface HistoryEntry {
  beforeSource: string;
  afterSource: string;
  beforeSelection: MarkdownSelection;
  afterSelection: MarkdownSelection;
}

export interface MarkdownSurfaceRegistration {
  id: string;
  kind: EditorSurfaceKind;
  view: MarkdownSurfaceView;
}

/** session 同步所需的最小 surface seam；真实实现由 CodeMirror EditorView 提供。 */
export interface MarkdownSurfaceView {
  readonly state: EditorState;
  dispatch: (spec: TransactionSpec) => void;
}

/** 标记 session 同步事务，防止 surface 更新再次回写 session 形成循环。 */
export const sessionSyncAnnotation = Annotation.define<number>();

function cloneSelection(selection: MarkdownSelection): MarkdownSelection {
  return { anchor: selection.anchor, head: selection.head };
}

function normalizeSelection(selection: MarkdownSelection, sourceLength: number): MarkdownSelection {
  const anchor = Math.max(0, Math.min(selection.anchor, sourceLength));
  const head = Math.max(0, Math.min(selection.head, sourceLength));
  return { anchor, head };
}

function validateChanges(sourceLength: number, changes: MarkdownChange[]): void {
  let previousTo = 0;

  for (const change of changes) {
    if (
      !Number.isInteger(change.from) ||
      !Number.isInteger(change.to) ||
      change.from < 0 ||
      change.to < change.from ||
      change.to > sourceLength
    ) {
      throw new RangeError(`Invalid Markdown change range [${change.from}, ${change.to})`);
    }

    if (change.from < previousTo) {
      throw new RangeError('Markdown changes must be ordered and cannot overlap');
    }

    previousTo = change.to;
  }
}

/** 将变更直接应用到 source 字符串，保证 CRLF 与字符边界精确保真。 */
export function applyChangesToSource(source: string, changes: MarkdownChange[]): string {
  let result = '';
  let lastIndex = 0;
  for (const change of changes) {
    result += source.slice(lastIndex, change.from) + change.insert;
    lastIndex = change.to;
  }
  result += source.slice(lastIndex);
  return result;
}

/** 将外部 Markdown changes 转成 CodeMirror ChangeSet，并完成范围校验。 */
export function createMarkdownChangeSet(source: string, changes: MarkdownChange[]): ChangeSet {
  validateChanges(source.length, changes);
  return ChangeSet.of(changes, source.length);
}

/** 通过 source change 映射一个选区，保持光标与选择范围位于新文档中。 */
export function mapMarkdownSelection(
  selection: MarkdownSelection,
  changes: ChangeSet
): MarkdownSelection {
  return {
    anchor: changes.mapPos(selection.anchor, 1),
    head: changes.mapPos(selection.head, 1)
  };
}

function toEditorSelection(selection: MarkdownSelection): EditorSelection {
  return EditorSelection.single(selection.anchor, selection.head);
}

function getTransactionSourceSelection(transaction: MarkdownEditTransaction): MarkdownSelection | undefined {
  return transaction.selection ? cloneSelection(transaction.selection) : undefined;
}

/**
 * Markdown source 的唯一协调模块。
 *
 * surface 只提交 transaction，不持有独立正文；session 负责 revision、history、selection
 * mapping 以及把 source changes 同步到已注册的 CodeMirror surface。
 */
export class MarkdownDocumentSession {
  private source: string;
  private revision = 0;
  private selection: MarkdownSelection;
  private readonly listeners = new Set<MarkdownSessionListener>();
  private readonly surfaces = new Map<string, MarkdownSurfaceRegistration>();
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];

  public constructor(source = '', selection: MarkdownSelection = { anchor: 0, head: 0 }) {
    this.source = source;
    this.selection = normalizeSelection(selection, source.length);
  }

  public get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public getSnapshot(): MarkdownDocumentSnapshot {
    return {
      source: this.source,
      revision: this.revision,
      selection: cloneSelection(this.selection)
    };
  }

  public subscribe(listener: MarkdownSessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public setSelection(selection: MarkdownSelection, originSurfaceId?: string): void {
    const nextSelection = normalizeSelection(selection, this.source.length);
    if (
      nextSelection.anchor === this.selection.anchor &&
      nextSelection.head === this.selection.head
    ) {
      return;
    }

    this.selection = nextSelection;
    const annotation = sessionSyncAnnotation.of(this.revision);

    for (const surface of this.surfaces.values()) {
      if (surface.id === originSurfaceId) continue;
      surface.view.dispatch({
        selection: toEditorSelection(nextSelection),
        annotations: annotation
      });
    }
  }

  /** 提交一个 source transaction，并返回提交后的 snapshot。 */
  public dispatch(
    transaction: MarkdownEditTransaction,
    originSurfaceId?: string
  ): MarkdownDocumentSnapshot {
    const effectiveOrigin = originSurfaceId ?? transaction.originSurfaceId;
    const changeSet = createMarkdownChangeSet(this.source, transaction.changes);
    const beforeSource = this.source;
    const beforeSelection = transaction.beforeSelection
      ? cloneSelection(transaction.beforeSelection)
      : cloneSelection(this.selection);
    const nextSource = applyChangesToSource(this.source, transaction.changes);
    const explicitSelection = getTransactionSourceSelection(transaction);
    const nextSelection = normalizeSelection(
      explicitSelection ?? mapMarkdownSelection(this.selection, changeSet),
      nextSource.length
    );
    const sourceChanged = nextSource !== beforeSource;

    if (!sourceChanged && nextSelection.anchor === beforeSelection.anchor && nextSelection.head === beforeSelection.head) {
      return this.getSnapshot();
    }

    if (sourceChanged && transaction.addToHistory !== false) {
      this.undoStack.push({
        beforeSource,
        afterSource: nextSource,
        beforeSelection,
        afterSelection: nextSelection
      });
      this.redoStack.length = 0;
    }

    this.source = nextSource;
    this.selection = nextSelection;
    this.revision += 1;
    const snapshot = this.getSnapshot();

    if (sourceChanged) {
      const annotation = sessionSyncAnnotation.of(this.revision);
      for (const surface of this.surfaces.values()) {
        if (surface.id === effectiveOrigin) continue;
        surface.view.dispatch({
          changes: transaction.changes,
          selection: toEditorSelection(nextSelection),
          annotations: annotation
        });
      }
    } else if (nextSelection.anchor !== beforeSelection.anchor || nextSelection.head !== beforeSelection.head) {
      const annotation = sessionSyncAnnotation.of(this.revision);
      for (const surface of this.surfaces.values()) {
        if (surface.id === effectiveOrigin) continue;
        surface.view.dispatch({
          selection: toEditorSelection(nextSelection),
          annotations: annotation
        });
      }
    }

    this.emit(snapshot, transaction);
    return snapshot;
  }

  /** 外部 reload 默认不进入用户 undo history。 */
  public replaceSource(
    source: string,
    options: {
      selection?: MarkdownSelection;
      addToHistory?: boolean;
    } = {}
  ): MarkdownDocumentSnapshot {
    if (source !== this.source && options.addToHistory !== true) {
      this.undoStack.length = 0;
      this.redoStack.length = 0;
    }

    return this.dispatch(
      {
        changes: [{ from: 0, to: this.source.length, insert: source }],
        selection: options.selection,
        addToHistory: options.addToHistory ?? false,
        userEvent: 'external.reload'
      }
    );
  }

  public undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;

    this.redoStack.push(entry);
    this.restoreHistoryEntry(entry.beforeSource, entry.beforeSelection, 'history.undo');
    return true;
  }

  public redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;

    this.undoStack.push(entry);
    this.restoreHistoryEntry(entry.afterSource, entry.afterSelection, 'history.redo');
    return true;
  }

  public registerSurface(surface: MarkdownSurfaceRegistration): () => void {
    if (this.surfaces.has(surface.id)) {
      throw new Error(`Editor surface "${surface.id}" is already registered`);
    }

    this.surfaces.set(surface.id, surface);
    surface.view.dispatch({
      selection: toEditorSelection(this.selection),
      annotations: sessionSyncAnnotation.of(this.revision)
    });

    return () => {
      this.surfaces.delete(surface.id);
    };
  }

  private restoreHistoryEntry(
    source: string,
    selection: MarkdownSelection,
    userEvent: string
  ): void {
    const previousSource = this.source;
    this.source = source;
    this.selection = normalizeSelection(selection, source.length);
    this.revision += 1;
    const change = [{ from: 0, to: previousSource.length, insert: source }];
    const annotation = sessionSyncAnnotation.of(this.revision);

    for (const surface of this.surfaces.values()) {
      surface.view.dispatch({
        changes: change,
        selection: toEditorSelection(this.selection),
        annotations: annotation
      });
    }

    this.emit(
      this.getSnapshot(),
      {
        changes: change,
        selection: cloneSelection(this.selection),
        userEvent,
        addToHistory: false
      }
    );
  }

  private emit(snapshot: MarkdownDocumentSnapshot, transaction?: MarkdownEditTransaction): void {
    for (const listener of this.listeners) {
      listener(snapshot, transaction);
    }
  }
}
