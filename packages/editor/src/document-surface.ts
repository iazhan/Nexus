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
import {
  getSourceEditorExtensions,
  editorLocaleCompartment,
  editorLocaleFacet
} from './source-editor.js';
import {
  visualProjectionExtensions,
  documentDirectoryField,
  workspaceAssetsField,
  EMPTY_WORKSPACE_ASSETS,
  type WorkspaceAssetEntry
} from './visual-projection.js';
import { sourceImageProjectionExtensions } from './source-image-projection.js';
import { visualCommandsExtension } from './visual-commands.js';
import { createVisualDragExtension } from './drag-handle.js';
import {
  createInlineEditExtension,
  type ImageSourceResolver,
  type WorkspaceImageProvider
} from './inline-edit.js';
import {
  createLinkNavigationExtension,
  type LinkNavigator
} from './link-navigation.js';
import { tagHighlightExtension } from './tag-highlight.js';
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
  documentDirectory?: string | null;
  imageSourceResolver?: ImageSourceResolver;
  /** 工作区图片列表。缺省表示宿主不提供选取入口，图片仍可就地改地址。 */
  workspaceImages?: WorkspaceImageProvider;
  /**
   * 工作区资源清单，供 `![[…]]` 的回退解析判断「候选路径存在吗」。
   *
   * 缺省表示宿主没递 —— 嵌入解析退化成「相对当前文档目录」单档，与没有这个能力时一致，
   * 不会更差。索引刷新后由 `setWorkspaceAssets` 重新注入。
   */
  workspaceAssets?: readonly WorkspaceAssetEntry[];
  /** Ctrl/Cmd+左键点击普通链接时的导航策略，由宿主提供；缺省表示不导航。 */
  linkNavigator?: LinkNavigator;
  /**
   * 粘贴图片时的落盘钩子，由宿主提供；缺省表示不处理图片粘贴。
   *
   * 与 `linkNavigator` 同类：**策略在宿主，编辑器只递事件**。编辑器不知道文件写到哪，
   * 也不该知道。
   */
  onPasteFiles?: (files: readonly File[]) => Promise<string | null>;
  extensionHost?: import('./extensions.js').ExtensionHost;
  onSelectionChange?: (selection: MarkdownSelection) => void;
  theme?: 'light' | 'dark';
  locale?: string;
  /** 行号槽。缺省视为开。 */
  lineNumbers?: boolean;
  /**
   * 拼写检查。缺省视为**关** —— 与 CodeMirror 自己的默认一致。
   *
   * 打字机模式与 vim **不在这里**：它们由 `setEditorTypewriter` / `applyEditorVim` 在视图建好
   * 之后装上。前者的 `ViewPlugin` 拿不到构造期的 view，后者的扩展是异步加载的，都不可能在
   * 建 state 的那一刻就位。
   */
  spellCheck?: boolean;
  /**
   * `/` 面板里的命令级动作，由宿主从命令注册表投影。缺省表示面板只剩内容级模板。
   *
   * 只在建 state 时读一次：注册表在 App 启动时填好，之后不再变。将来若它变成动态的，
   * 这里要改成 Compartment —— 而不是让调用方重建视图。
   */
  slashCommands?: import('./completions.js').SlashCommandHost;
}

/**
 * 跨 surface 传递的滚动锚点，由 `EditorView.scrollSnapshot()` 生成。
 *
 * 刻意做成不透明类型：内部的 `ScrollTarget` 不在 `@codemirror/view` 的公开导出里，
 * 所以用返回类型反推，宿主只负责搬运、不需要也不应该解构它。
 *
 * 它记录的是**位置语义**——「视口顶边落在哪个 block 的哪个亚行偏移」——而不是像素值。
 * 这是跨 surface 搬运滚动位置的唯一正确做法：视觉投影把表格 / 代码块 / mermaid 渲染成
 * 块级 widget，同一份 source 在两个 surface 里的像素高度不同，直接搬 `scrollTop` 会落错位置。
 * 恢复时 `scrollTop = lineBlockAt(range.head).top - yMargin`，是在**新 view 的高度表里**重算的。
 */
export type EditorScrollAnchor = ReturnType<EditorView['scrollSnapshot']>;

export interface CreateSessionEditorViewOptions extends CreateSessionEditorStateOptions {
  parent: HTMLElement;
  /**
   * 初始滚动位置，通常来自上一个 view 的 `captureScroll()`。
   * 交给 `EditorViewConfig.scrollTo`，在第一次 measure 时应用。
   */
  scrollTo?: EditorScrollAnchor;
}

export interface SessionEditorViewHandle {
  view: EditorView;
  /**
   * 捕获当前滚动位置，供下一个 view 用 `scrollTo` 恢复。
   * **必须在 `destroy()` 之前调用**——销毁之后 viewState 就没了。
   */
  captureScroll: () => EditorScrollAnchor;
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
    keybindings: options.surfaceKind === 'visual' ? visualEditorKeybindings : editorKeybindings,
    extensionHost: options.extensionHost,
    theme: options.theme,
    lineNumbers: options.lineNumbers,
    spellCheck: options.spellCheck,
    slashCommands: options.slashCommands
  });
  const inlineEditOptions = {
    surfaceId: options.surfaceId,
    imageSourceResolver: options.imageSourceResolver,
    workspaceImages: options.workspaceImages
  };

  // Source 模式**也**渲染图片（只渲染图片），所以两个 surface 都要装行内编辑扩展：
  // 点图 → 就地揭示源文本 → 从工作区列表选一张。缺了它，Source 模式里的图片
  // 就只是一张点不动的图，地址没法改。
  const surfaceKindExtensions = options.surfaceKind === 'visual'
    ? [
        Prec.high(visualCommandsExtension),
        createVisualDragExtension(options.session),
        createInlineEditExtension(options.session, inlineEditOptions),
        ...(options.documentDirectory !== undefined
          ? [documentDirectoryField.init(() => options.documentDirectory ?? null)]
          : []),
        ...(options.workspaceAssets !== undefined
          ? [workspaceAssetsField.init(() => options.workspaceAssets ?? EMPTY_WORKSPACE_ASSETS)]
          : []),
        ...(options.linkNavigator ? [createLinkNavigationExtension(options.linkNavigator)] : []),
        ...visualProjectionExtensions,
        // 排在投影之后：标签是 mark 装饰，而投影里有 replace(widget)。同 from 时
        // mark 必须在 replace 之后 —— 顺序反了不是样式问题，是整窗崩。
        tagHighlightExtension
      ]
    : [
        createInlineEditExtension(options.session, inlineEditOptions),
        ...(options.documentDirectory !== undefined
          ? [documentDirectoryField.init(() => options.documentDirectory ?? null)]
          : []),
        ...(options.workspaceAssets !== undefined
          ? [workspaceAssetsField.init(() => options.workspaceAssets ?? EMPTY_WORKSPACE_ASSETS)]
          : []),
        ...(options.linkNavigator ? [createLinkNavigationExtension(options.linkNavigator)] : []),
        ...sourceImageProjectionExtensions,
        tagHighlightExtension
      ];

  return EditorState.create({
    doc,
    // 初始选区直接取自 session：否则新 view 会先落在 0，再由 `registerSurface()`
    // 补一次 dispatch 才回到正确位置。同一 tick 内虽无可见闪烁，但状态序列是错的。
    selection: toEditorSelection(options.session.getSnapshot().selection),
    extensions: [
      createImeCompositionExtension(),
      createClipboardExtension(options.session, {
        surfaceId: options.surfaceId,
        readOnly: options.readOnly,
        onPasteFiles: options.onPasteFiles
      }),
      editorLocaleCompartment.of(editorLocaleFacet.of(options.locale ?? 'zh-CN')),
      ...surfaceKindExtensions,
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
    parent: options.parent,
    // 恢复上一个 view 的滚动位置。必须走 `scrollTo` 而不是建完之后再滚：
    // 它会在第一次 measure 时应用，用户看不到"先跳到 0 再跳回来"。
    //
    // 另一条容易踩的：这里设置的 scrollTarget 之所以不会被随后的选区同步覆盖，
    // 是因为 `Transaction.scrollIntoView` 默认是 `false`（state 包
    // `scrollIntoView: !!spec.scrollIntoView`），而 `registerSurface()` 只发 selection。
    // 谁给那些同步 dispatch 加上 `scrollIntoView: true`，视口顶边就会丢、新 view 会去追光标。
    scrollTo: options.scrollTo
  });
  const unregister = options.session.registerSurface({
    id: options.surfaceId,
    kind: options.surfaceKind,
    view
  });

  options.onSelectionChange?.(selectionFromState(view.state));

  return {
    view,
    captureScroll: () => view.scrollSnapshot(),
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
