import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/** 注册到单个 EditorView 的可关闭子编辑器。 */
interface ActiveSubEditor {
  close: () => void;
}

const activeSubEditors = new WeakMap<EditorView, Set<ActiveSubEditor>>();

function registerActiveSubEditor(view: EditorView, editor: ActiveSubEditor): () => void {
  let set = activeSubEditors.get(view);
  if (!set) {
    set = new Set();
    activeSubEditors.set(view, set);
  }
  set.add(editor);
  return () => {
    set?.delete(editor);
  };
}

/** 子编辑器的监听信号与幂等关闭入口。 */
export interface SubEditorController {
  signal: AbortSignal;
  isActive: () => boolean;
  close: () => void;
}

/** 统一管理子编辑器事件、注册和幂等关闭。 */
export function createSubEditorController(
  view: EditorView,
  onClose: () => void
): SubEditorController {
  const abortController = new AbortController();
  let active = true;
  let unregister = () => {};

  const close = () => {
    if (!active) return;
    active = false;
    abortController.abort();
    unregister();
    onClose();
  };

  unregister = registerActiveSubEditor(view, { close });
  return {
    signal: abortController.signal,
    isActive: () => active,
    close
  };
}

function closeAllActiveSubEditors(view: EditorView): void {
  const set = activeSubEditors.get(view);
  if (set) {
    for (const editor of Array.from(set)) {
      editor.close();
    }
    set.clear();
  }
}

class SubEditorLifecyclePlugin {
  public disposed = false;
  public generation = 0;

  constructor(readonly view: EditorView) {}

  update(update: ViewUpdate) {
    if (update.startState.readOnly !== update.state.readOnly) {
      const isRo = update.state.readOnly;
      // 工具栏由 tableWidgetSyncPlugin 依据只读状态和有效目标统一刷新。
      if (isRo) {
        this.generation++;
        closeAllActiveSubEditors(update.view);
      }
    }

    if (update.docChanged) {
      const isInternalSubEditorCommit = update.transactions.some(
        (tr) =>
          tr.isUserEvent('table.cell-edit') ||
          tr.isUserEvent('code-block.value-edit') ||
          tr.isUserEvent('code-block.language-edit') ||
          tr.isUserEvent(RAW_BLOCK_EDIT_USER_EVENT)
      );
      if (!isInternalSubEditorCommit) {
        this.generation++;
        closeAllActiveSubEditors(update.view);
      }
    }
  }

  destroy() {
    this.disposed = true;
    this.generation++;
    closeAllActiveSubEditors(this.view);
  }
}

export const subEditorLifecyclePlugin = ViewPlugin.fromClass(SubEditorLifecyclePlugin);

export const RAW_BLOCK_EDIT_USER_EVENT = 'raw-block.edit';

