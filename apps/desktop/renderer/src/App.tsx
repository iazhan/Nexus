import React, {
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore
} from 'react';
import type { FileDocument, Unsubscribe } from '@nexus/core';
import {
  MarkdownDocumentSession,
  openSearchPanel,
  resolveRelativePath,
  revealHeadingAnchor,
  ExtensionHost,
  MATH_EXTENSION_ID,
  MERMAID_EXTENSION_ID,
  isMathMarker,
  isMermaidMarker,
  type EditorView,
  type EditorSurfaceKind,
  type EditorSaveState,
  type EditorSelectionInfo,
  type LinkNavigator
} from '@nexus/editor';
import { EditorSurface } from './editor/SourceEditor.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { MenuBar, type MenuBarMenu } from './MenuBar.js';
import { WindowControls } from './WindowControls.js';
import { formatShortcut, matchesShortcut } from './shortcut.js';
import { mermaidPreviewPreference } from './platform.js';
import { commandRegistry } from './platform.js';
import { useTheme, useLocale } from './hooks.js';
import { CommandPalette } from './CommandPalette.js';
import { WorkspaceStore } from './workspace/store.js';
import { TabBar } from './workspace/TabBar.js';
import { WorkspaceSidebar } from './workspace/WorkspaceSidebar.js';
import { OutlinePanel } from './workspace/OutlinePanel.js';
import { SearchPanel } from './workspace/SearchPanel.js';
import { PluginsPanel } from './workspace/PluginsPanel.js';
import { TagsPanel } from './workspace/TagsPanel.js';
import { QuickOpen } from './workspace/QuickOpen.js';
import { resolveWikiLink } from './workspace/wikilink.js';
import {
  PANEL_DEFAULT_WIDTH,
  clampPanelWidth,
  loadPanelWidth,
  savePanelWidth
} from './workspace/panel-width.js';
import { ActivityBar } from './shell/ActivityBar.js';
import {
  INITIAL_ACTIVITY_STATE,
  toggleActivity,
  type ActivityId
} from './shell/activity-bar-state.js';

export type ShellStatus = 'loading' | 'ready' | 'error';

/** Source surface 图标：代码尖括号。 */
const CodeIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </svg>
);

/** Visual surface 图标：预览小眼睛。 */
const EyeIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

/** 太阳图标：切换到亮色。 */
const SunIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="5" />
    <line x1="12" y1="1" x2="12" y2="3" />
    <line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" />
    <line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </svg>
);

/** 月亮图标：切换到暗色。 */
const MoonIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

/**
 * 保存状态到文案键的唯一映射。
 *
 * `clean` 与 `saved` 的区别只是"有没有脏过"的历史（加载后未偏离 / 偏离过又写回去了），
 * 对用户的意义相同，所以共用一条文案。
 */
const SAVE_STATE_KEY: Record<EditorSaveState, string> = {
  clean: 'save.clean',
  saved: 'save.saved',
  dirty: 'save.dirty',
  saving: 'save.saving',
  error: 'save.error',
  readonly: 'save.readonly',
  'external-changed': 'save.external-changed',
  deleted: 'save.deleted'
};

/** 指示点的色调类名。与文案同源，避免两处判据再次分叉。 */
const SAVE_STATE_TONE: Record<EditorSaveState, string> = {
  clean: 'saved',
  saved: 'saved',
  dirty: 'dirty',
  saving: 'saving',
  error: 'error',
  readonly: 'readonly',
  'external-changed': 'conflict',
  deleted: 'deleted'
};

function getDocumentDirectory(filePath: string | null): string | null {
  if (!filePath) return null;
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastSlash === -1) return null;
  return filePath.slice(0, lastSlash);
}

export const App: React.FC = () => {
  const { theme, setTheme } = useTheme();
  const { locale, setLocale, t } = useLocale();
  const [isCommandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // Mermaid「点击图表显示源码」偏好。菜单的勾选状态必须与实际一致，
  // 所以订阅偏好变化 —— 别的入口改了也能同步过来。
  const [mermaidClickToReveal, setMermaidClickToReveal] = useState(
    mermaidPreviewPreference.get()
  );
  useEffect(() => mermaidPreviewPreference.subscribe(setMermaidClickToReveal), []);

  useEffect(() => {
    document.body.className = `theme-${theme.type}`;
  }, [theme]);

  const [status, setStatus] = useState<ShellStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  /**
   * workspace 模式下打开的工作区根目录。
   *
   * 与 filePath 互斥：lightweight 只填 filePath，workspace 只填 workspaceRoot。
   * 文件树与索引在后续切片接入。
   */
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);

  /**
   * 活动栏（最左图标列）的布局状态。纯会话内状态，不持久化 ——
   * 它是「这次看什么」，不是「文档是什么」，与 WorkspaceStore 各管一摊。
   */
  const [activity, setActivity] = useState(INITIAL_ACTIVITY_STATE);

  /**
   * 文档内容版本号。唯一用途是让插件面板在编辑后重新读一次扩展状态 ——
   * `ExtensionHost` 没有变更通知，借这个信号刷新。
   */
  const [documentRevision, setDocumentRevision] = useState(0);

  /** 快速打开（Ctrl+P）是否可见。 */
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);

  /**
   * 索引跑完后 bump 版本号。
   *
   * 标签这类**由索引驱动**的面板会在启动时随其他面板一起挂载，那时索引还没建好，
   * 查一次只能拿到空结果。所以由真正跑索引的侧栏在完成后明确通知一次。
   */
  const handleIndexed = useCallback(() => {
    setDocumentRevision((previous) => previous + 1);
  }, []);

  const handleActivitySelect = useCallback((id: ActivityId) => {
    setActivity((previous) => toggleActivity(previous, id));
  }, []);

  /**
   * 侧栏宽度。默认 240px，可拖拽调整（范围见 `panel-width.ts`）。
   *
   * 写入 localStorage 的时机是**松开鼠标**，不是拖拽过程中 —— 否则每移动一像素
   * 就落一次盘，拖一下能写几百次。
   */
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth);
  const [isResizing, setIsResizing] = useState(false);

  const handleResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsResizing(true);

      const startX = event.clientX;
      const startWidth = panelWidth;

      const handleMove = (moveEvent: MouseEvent) => {
        setPanelWidth(clampPanelWidth(startWidth + (moveEvent.clientX - startX)));
      };

      const handleUp = () => {
        setIsResizing(false);
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleUp);
      };

      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleUp);
    },
    [panelWidth]
  );

  /** 双击把手恢复默认宽度 —— 拖窄了之后不用靠手感找回来。 */
  const handleResizeReset = useCallback(() => {
    setPanelWidth(PANEL_DEFAULT_WIDTH);
  }, []);

  useEffect(() => {
    if (!isResizing) {
      savePanelWidth(panelWidth);
      return;
    }

    // 拖拽中给 body 加类：光标移出把手后仍是 col-resize，且不会选中沿途的文字
    document.body.classList.add('nexus-resizing');
    return () => {
      document.body.classList.remove('nexus-resizing');
    };
  }, [isResizing, panelWidth]);
  /**
   * Ctrl+左键跳转失败的可见反馈。
   *
   * 没有它，点一个指向不存在文件的链接（`docs/markdown-syntax-reference.md` 里就有两条）
   * 会完全静默——用户分不清是"链接坏了"还是"这个功能没做"。
   */
  const [linkError, setLinkError] = useState<string | null>(null);
  const [surfaceKind, setSurfaceKind] = useState<EditorSurfaceKind>('source');
  const [selection, setSelection] = useState<EditorSelectionInfo>({
    line: 1,
    column: 1,
    selectedTextLength: 0
  });

  const isMountedRef = useRef(true);
  const loadRequestIdRef = useRef(0);
  const initialContentRef = useRef('');
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const unwatchRef = useRef<Unsubscribe | null>(null);

  /**
   * 工作区状态层：打开了哪些文档、哪一个是活动的。
   *
   * 它取代了此前散在这里的 `filePath` / `saveState` / `saveError` / `session` 四个
   * useState。那些是「当前文档」的投影 —— 多标签页之后必须由文档集合派生，
   * 各自再存一份必然会漂移，而漂移的症状是「标题栏显示 A 的路径、保存写的是 B 的内容」。
   */
  const storeRef = useRef<WorkspaceStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new WorkspaceStore();
  }
  const store = storeRef.current;

  // 订阅 store。返回值用来驱动重渲染，文档列表从它取。
  const workspaceSnapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const activeDocument = store.getActive();

  /**
   * 兜底 session：只在 `status === 'ready'` 之前被引用。
   *
   * 刻意不把 store 初始化成「自带一份空白文档」，是为了让它保持「可以为空」这个
   * 干净的语义 —— workspace 模式下它确实就是空的。
   */
  const fallbackSessionRef = useRef<MarkdownDocumentSession | null>(null);
  if (fallbackSessionRef.current === null) {
    fallbackSessionRef.current = new MarkdownDocumentSession();
  }

  const session = activeDocument?.session ?? fallbackSessionRef.current;
  const filePath = activeDocument?.filePath ?? null;
  const saveState = activeDocument?.saveState ?? 'clean';
  const saveError = activeDocument?.saveError ?? null;

  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;

  /**
   * 大纲点击跳转：把光标移到标题所在的源码偏移，并**滚动过去**。
   *
   * 这里必须直接派发到 `EditorView`，不能只改 session：
   * `registerSurface()` 的 session → view 同步只发 selection、不带 `scrollIntoView`
   * （见 `document-surface.ts` 里那段注释），所以只调 `session.dispatch` 的话
   * 光标在 session 里确实移了、视口却纹丝不动 —— 表现就是「点了大纲没反应」。
   *
   * `changes` 为空：跳转不该产生一条可撤销的编辑历史，
   * 否则点几次大纲之后 Ctrl+Z 要按好几次才能撤销真正的编辑。
   */
  const handleOutlineJump = useCallback((offset: number) => {
    const view = (window as unknown as { nexusActiveView?: EditorView }).nexusActiveView;
    if (!view) return;

    view.dispatch({
      changes: [],
      selection: { anchor: offset, head: offset },
      scrollIntoView: true
    });
  }, []);

  // 下面三个 setter 保持与原 useState 完全相同的签名，所以全文件几十处调用点
  // 一行都不用改 —— 只换存储位置，不动调用方式。
  const setFilePath = useCallback(
    (next: string | null) => {
      store.setActiveFilePath(next);
    },
    [store]
  );

  const setSaveError = useCallback(
    (next: string | null) => {
      store.updateActive((document) => {
        document.saveError = next;
      });
    },
    [store]
  );

  const extensionHostRef = useRef<ExtensionHost | null>(null);
  if (extensionHostRef.current === null) {
    const host = new ExtensionHost();
    extensionHostRef.current = host;
    // 按内容懒加载：这里只登记「谁负责哪种 marker」+ 一个动态 import 工厂，
    // 扩展包本体要等文档里第一次出现触发语法才下载。
    //
    // 原先是在挂载时无条件 import 两个包 —— 无论文档有没有公式/图表，
    // katex（481KB + 一整套字体与 CSS）和 mermaid（1.2MB）都会被拉下来，
    // 那不叫懒加载。判定谓词来自 @nexus/editor（extension-triggers.ts），
    // 不在 App 里另写一份，否则就是两套判定。
    host.registerLazy({
      id: MATH_EXTENSION_ID,
      matches: isMathMarker,
      load: () => import('@nexus/math').then(({ MathExtension }) => new MathExtension())
    });
    host.registerLazy({
      id: MERMAID_EXTENSION_ID,
      matches: isMermaidMarker,
      load: () => import('@nexus/mermaid').then(({ MermaidExtension }) => new MermaidExtension())
    });
  }

  // Expose session on window for smoke testing and developer debugging
  if (typeof window !== 'undefined') {
    (window as any).nexusSession = session;
    // Mermaid 显示偏好还没有设置界面，先从这里暴露给 E2E 翻转
    (window as any).nexusMermaidPreview = mermaidPreviewPreference;
    // 扩展懒加载状态：E2E 用它证明「不含触发语法的文档不下载扩展包」
    (window as any).nexusExtensions = extensionHostRef.current;
  }

  // Synchronize dirty state with Electron main process
  const updateSaveState = useCallback(
    (nextState: EditorSaveState) => {
      store.setActiveSaveState(nextState);
      // 保存中、保存失败、冲突状态仍然代表存在未持久化内容，关闭保护不能失效。
      window.nexus?.setDirty?.(
        nextState === 'dirty' ||
        nextState === 'saving' ||
        nextState === 'error' ||
        nextState === 'external-changed'
      );
    },
    [store]
  );

  /**
   * 串行化所有保存请求，避免较早的原子写入在较新的写入之后完成而回退磁盘内容。
   */
  const enqueueSave = useCallback((operation: () => Promise<boolean>): Promise<boolean> => {
    const queued = saveQueueRef.current.then(operation);
    saveQueueRef.current = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }, []);

  const performSaveAs = useCallback(async (currentSource: string): Promise<boolean> => {
    try {
      if (!window.nexus?.saveAs) return false;
      const chosenPath = await window.nexus.saveAs(currentSource);
      if (!chosenPath) return false;
      setFilePath(chosenPath);
      const sourceStillCurrent = session.getSnapshot().source === currentSource;
      if (sourceStillCurrent) {
        initialContentRef.current = currentSource;
        updateSaveState('saved');
      } else {
        updateSaveState('dirty');
      }
      setSaveError(null);
      return sourceStillCurrent;
    } catch (err: unknown) {
      console.error('SaveAs failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg);
      updateSaveState('error');
      return false;
    }
  }, [session, updateSaveState]);

  // Save implementation
  const saveFile = useCallback((_options: { immediate?: boolean } = {}): Promise<boolean> => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    if (saveStateRef.current === 'saved') {
      return Promise.resolve(true);
    }

    return enqueueSave(async () => {
      const currentSource = session.getSnapshot().source;

      // Untitled document or readonly document: prompt saveAs
      if (!filePath || saveStateRef.current === 'readonly') {
        return performSaveAs(currentSource);
      }

      updateSaveState('saving');
      setSaveError(null);

      try {
        if (!window.nexus?.writeFile) {
          throw new Error('writeFile bridge is unavailable');
        }
        await window.nexus.writeFile(filePath, currentSource);

        // 写入期间可能发生新编辑；此时旧快照已落盘，但不能把当前文档标记为已保存。
        const sourceStillCurrent = session.getSnapshot().source === currentSource;
        if (sourceStillCurrent) {
          initialContentRef.current = currentSource;
          updateSaveState('saved');
          setSaveError(null);
          return true;
        }

        updateSaveState('dirty');
        return false;
      } catch (err: unknown) {
        console.error('Save file failed:', err);
        const msg = err instanceof Error ? err.message : String(err);
        setSaveError(msg);
        updateSaveState('error');
        return false;
      }
    });
  }, [enqueueSave, filePath, performSaveAs, session, updateSaveState]);

  const saveAs = useCallback((): Promise<boolean> => {
    return enqueueSave(() => performSaveAs(session.getSnapshot().source));
  }, [enqueueSave, performSaveAs, session]);

  /**
   * 把已打开的文件灌进工作区。系统对话框与链接跳转共用这一段，
   * 避免两条路径在 dirty / readOnly / 错误清理上出现分歧。
   */
  const applyOpenedDocument = useCallback(
    (fileDoc: FileDocument) => {
      // 开成新的标签页。同一路径已经在标签页里时，store 会激活既有那个而不是
      // 新建 —— 否则同一个文件会有两份互不知情的 session，两边都能存盘，
      // 后写的静默覆盖先写的。
      store.openDocument({
        filePath: fileDoc.path,
        content: fileDoc.content,
        readOnly: fileDoc.readOnly
      });
      initialContentRef.current = fileDoc.content;
      window.nexus?.setDirty?.(false);
    },
    [store]
  );

  /**
   * 从工作区侧栏打开一个文件。
   *
   * 与 Ctrl+O 走同一个 `applyOpenedDocument`：同一路径已打开时它会激活既有标签页，
   * 不会开出第二份 session（两份都能存盘 = 后写的静默覆盖先写的）。
   */
  const handleOpenWorkspaceFile = useCallback(
    async (targetPath: string) => {
      try {
        if (!window.nexus?.openFile) return;
        const fileDoc = await window.nexus.openFile(targetPath);
        if (!fileDoc) return;
        applyOpenedDocument(fileDoc);
        setLinkError(null);
      } catch (err: unknown) {
        console.error('Failed to open workspace file:', err);
        setLinkError(
          t('link.error.openFailed', {
            target: targetPath,
            reason: err instanceof Error ? err.message : String(err)
          })
        );
      }
    },
    [applyOpenedDocument, t]
  );

  // Open file via the system dialog
  const handleOpenFile = useCallback(async () => {
    try {
      if (!window.nexus?.openFile) return;
      const fileDoc = await window.nexus.openFile();
      if (!fileDoc) return;
      applyOpenedDocument(fileDoc);
    } catch (err: unknown) {
      console.error('Open file failed:', err);
    }
  }, [applyOpenedDocument]);

  /** 按已知路径打开文档，供链接跳转使用（不弹对话框）。 */
  const openDocumentAt = useCallback(
    async (targetPath: string): Promise<boolean> => {
      if (!window.nexus?.openFile) return false;
      try {
        const fileDoc = await window.nexus.openFile(targetPath);
        if (!fileDoc) return false;
        applyOpenedDocument(fileDoc);
        setLinkError(null);
        return true;
      } catch (err: unknown) {
        console.error('Failed to open linked document:', err);
        // 跳转失败必须可见，否则用户分不清"链接坏了"和"功能没做"。
        setLinkError(t('link.error.openFailed', { target: targetPath, reason: err instanceof Error ? err.message : String(err) }));
        return false;
      }
    },
    [applyOpenedDocument, t]
  );

  // Watch file for external modifications
  useEffect(() => {
    if (unwatchRef.current) {
      unwatchRef.current();
      unwatchRef.current = null;
    }

    if (!filePath || !window.nexus?.watchFile) {
      return;
    }

    try {
      const unsub = window.nexus.watchFile(filePath, async (watchEvent) => {
        if (!isMountedRef.current) return;

        if (watchEvent.type === 'deleted' || watchEvent.type === 'renamed') {
          updateSaveState('deleted');
        } else if (watchEvent.type === 'error') {
          setSaveError(watchEvent.message);
          updateSaveState('error');
        } else if (watchEvent.type === 'changed') {
          // Only auto-reload if document is completely clean and saved
          const isDocClean =
            (saveStateRef.current === 'saved' || saveStateRef.current === 'clean' || saveStateRef.current === 'readonly') &&
            initialContentRef.current === session.getSnapshot().source;

          if (isDocClean && window.nexus?.readFile) {
            try {
              const freshContent = await window.nexus.readFile(filePath);
              // 应用自己的 writeFile 同样会唤醒这个 watcher。内容与当前文档完全一致时
              // 说明没有任何外部修改，必须直接忽略：整篇 replaceSource 会把光标映射到
              // 文档末尾，表现为自动保存后光标跳到文件尾部。
              if (freshContent === session.getSnapshot().source) {
                return;
              }
              initialContentRef.current = freshContent;
              session.replaceSource(freshContent);
              updateSaveState('clean');
            } catch (readErr) {
              console.error('Failed to reload changed file:', readErr);
              setSaveError(String(readErr));
              updateSaveState('error');
            }
          } else if (saveStateRef.current !== 'saved' && saveStateRef.current !== 'clean' && saveStateRef.current !== 'readonly') {
            // 保存中或保存失败也仍有本地未持久化内容，必须进入冲突保护路径。
            updateSaveState('external-changed');
          }
        }
      });
      unwatchRef.current = unsub;
    } catch (err) {
      console.error('Failed to watch file:', err);
    }

    return () => {
      if (unwatchRef.current) {
        unwatchRef.current();
        unwatchRef.current = null;
      }
    };
  }, [filePath, session, updateSaveState]);

  // Document loader
  const loadDocument = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    const isCurrentRequest = () =>
      isMountedRef.current && loadRequestIdRef.current === requestId;

    setStatus('loading');
    setErrorMessage(null);

    try {
      if (!window.nexus || typeof window.nexus.getLaunchContext !== 'function') {
        throw new Error(
          'Nexus bridge is unavailable. Preload script may have failed to initialize.'
        );
      }

      const ctx = await window.nexus.getLaunchContext();
      if (!isCurrentRequest()) return;

      if (!ctx || typeof ctx.mode !== 'string') {
        throw new Error('Invalid launch context received from shell bridge.');
      }

      // Handle unsupported file paths
      if (ctx.unsupportedPath) {
        setStatus('error');
        setErrorMessage(
          t('file.unsupportedDetail', { path: ctx.unsupportedPath })
        );
        return;
      }

      // workspace 模式：目录已在 main 进程确认存在。文件树与索引尚未接入，
      // 所以这里不伪造一个空编辑器，而是如实显示「工作区已打开」。
      if (ctx.mode === 'workspace' && ctx.workspaceRoot) {
        setWorkspaceRoot(ctx.workspaceRoot);
        // workspace 模式下没有可编辑的文档，标签页保持为空
        initialContentRef.current = '';
        setStatus('ready');
        return;
      }

      setWorkspaceRoot(null);

      // If a file path was passed in context, load its content
      if (ctx.filePath) {
        const fileDoc = await window.nexus.openFile(ctx.filePath);
        if (!isCurrentRequest()) return;

        store.openDocument({
          filePath: fileDoc.path,
          content: fileDoc.content,
          readOnly: fileDoc.readOnly
        });
        initialContentRef.current = fileDoc.content;
        window.nexus?.setDirty?.(false);
        setStatus('ready');
      } else {
        // No file provided: open an empty markdown editor
        store.openDocument({ filePath: null, content: '' });
        initialContentRef.current = '';
        window.nexus?.setDirty?.(false);
        setStatus('ready');
      }
    } catch (err) {
      console.error('Failed to load file or initialize editor:', err);
      if (!isCurrentRequest()) return;

      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(message);
      setStatus('error');
    }
  }, [store]);

  useEffect(() => {
    isMountedRef.current = true;
    loadDocument();

    return () => {
      isMountedRef.current = false;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [loadDocument]);

  // Handle content change & auto-save debounce
  const handleContentChange = useCallback((newContent: string) => {
    // 让插件面板刷新扩展状态（编辑可能触发某个扩展开始按需加载）
    setDocumentRevision((previous) => previous + 1);

    if (newContent !== initialContentRef.current) {
      updateSaveState('dirty');

      // Schedule debounce auto-save if file has a target path
      if (filePath) {
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
        }
        debounceTimerRef.current = setTimeout(() => {
          saveFile({ immediate: false });
        }, 800);
      }
    } else {
      updateSaveState('saved');
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    }
  }, [filePath, saveFile, updateSaveState]);

  const handleSelectionChange = useCallback((newSelection: EditorSelectionInfo) => {
    setSelection(newSelection);
  }, []);

  // Window close & unsaved changes coordination
  useEffect(() => {
    if (!window.nexus?.onSaveAndCloseRequested) return;

    const unbind = window.nexus.onSaveAndCloseRequested(async () => {
      const saved = await saveFile({ immediate: true });
      if (saved) {
        window.nexus?.readyToClose?.();
      } else {
        // 保存失败时继续保持主进程 dirty，阻止静默关闭并保留恢复横幅。
        window.nexus?.setDirty?.(true);
      }
    });

    return unbind;
  }, [saveFile]);

  // 新建空文档：开成一个新的未命名标签页。
  // 定义在快捷键 effect 之前，否则 effect 的依赖数组会在渲染期读到未初始化的绑定（TDZ）。
  const handleNewFile = useCallback(() => {
    store.openDocument({ filePath: null, content: '' });
    initialContentRef.current = '';
    window.nexus?.setDirty?.(false);
  }, [store]);

  /**
   * 关掉标签页之后补一个空白文档。
   *
   * 编辑器「没有任何文档可显示」对用户没有意义，而且会让全文件那些 `session.xxx`
   * 落进兜底 session —— 那种状态下编辑的内容哪也去不了。
   */
  const closeDocumentAndEnsureEditor = useCallback(
    (id: string) => {
      store.closeDocument(id);
      if (store.isEmpty) {
        store.openDocument({ filePath: null, content: '' });
        initialContentRef.current = '';
      }
    },
    [store]
  );

  /**
   * 关闭一个标签页。
   *
   * 有未保存内容时先落盘再关：自动保存有 debounce 窗口，用户点关闭时不一定
   * 意识到那个标签页还是脏的，而关掉就等于丢内容。
   */
  const handleCloseTab = useCallback(
    (id: string) => {
      const document = store.getDocuments().find((candidate) => candidate.id === id);
      if (!document) return;

      const isUnsaved =
        document.saveState === 'dirty' ||
        document.saveState === 'saving' ||
        document.saveState === 'error' ||
        document.saveState === 'external-changed';

      if (!isUnsaved) {
        closeDocumentAndEnsureEditor(id);
        return;
      }

      if (!document.filePath) {
        // 未命名且未保存：没有可落盘的地方，必须让用户明确表态
        const name = t('tab.untitled');
        if (!window.confirm(t('tab.discardConfirm', { name }))) return;
        closeDocumentAndEnsureEditor(id);
        return;
      }

      const targetPath = document.filePath;
      const content = document.session.getSnapshot().source;
      // 先取出 bridge：await 之后 TS 不再保留 window.nexus 的类型收窄
      const bridge = window.nexus;
      if (!bridge?.writeFile) return;

      void enqueueSave(async () => {
        try {
          await bridge.writeFile(targetPath, content);
          closeDocumentAndEnsureEditor(id);
          return true;
        } catch (err) {
          // 保存失败就不关：关掉等于把这次编辑丢掉
          store.setSaveState(id, 'error', err instanceof Error ? err.message : String(err));
          return false;
        }
      });
    },
    [store, enqueueSave, closeDocumentAndEnsureEditor, t]
  );

  /**
   * Ctrl/Cmd+左键的链接跳转策略。
   *
   * 编辑器只负责识别（命中哪个链接、href 是什么），"往哪去"在这里定：
   *   1. `#anchor`         → 文档内标题跳转，不离开当前文档
   *   2. http/https/mailto → 交给系统默认浏览器
   *   3. 相对路径           → 按当前文档目录解析，再由编辑器打开
   *
   * 返回 false 表示不处理，事件交回浏览器，保持默认的落光标行为。
   */
  const handleLinkNavigation = useCallback<LinkNavigator>(
    ({ href, kind }) => {
      const target = href.trim();
      if (!target) return false;

      // 0. wikilink：拿目标名去**索引**里解析。编辑器只把名字递过来，
      //    「它对应工作区里哪个文件」是宿主的策略（与编辑器包的分层一致）。
      if (kind === 'wikilink') {
        void (async () => {
          try {
            const documents = (await window.nexus?.listIndexedDocuments?.()) ?? [];
            const resolution = resolveWikiLink(target, documents);

            if (resolution.status === 'resolved' && resolution.document?.path) {
              await handleOpenWorkspaceFile(resolution.document.path);
              setLinkError(null);
              return;
            }

            setLinkError(
              resolution.status === 'ambiguous'
                ? t('link.error.ambiguousWikiLink', {
                    target,
                    count: String(resolution.candidates.length)
                  })
                : t('link.error.unresolvedWikiLink', { target })
            );
          } catch (err) {
            setLinkError(
              t('link.error.openFailed', {
                target,
                reason: err instanceof Error ? err.message : String(err)
              })
            );
          }
        })();
        return true;
      }

      // 1. 文档内锚点：光标落到标题上并滚动过去
      if (target.startsWith('#')) {
        const view = (window as unknown as { nexusActiveView?: EditorView }).nexusActiveView;
        if (!view) return false;
        if (revealHeadingAnchor(view, target)) {
          setLinkError(null);
          return true;
        }
        setLinkError(t('link.error.unresolvedAnchor', { target }));
        return true;
      }

      // 2. 外部协议。这里再判一次白名单，是不把"净化器放行过"当成"一定能开"；
      //    主进程侧还有第三道校验，被拒时它返回 false。
      if (/^(?:https?|mailto):/i.test(target)) {
        const openExternal = window.nexus?.openExternal;
        if (!openExternal) return false;
        void openExternal(target)
          .then((opened) => {
            setLinkError(opened ? null : t('link.error.rejectedExternal', { target }));
          })
          .catch((err: unknown) => {
            console.error('Failed to open external link:', err);
            setLinkError(t('link.error.openExternalFailed', { target }));
          });
        return true;
      }

      // 3. 相对路径：必须相对当前文档目录解析，否则会被当成进程 cwd。
      const directory = getDocumentDirectory(filePath);
      if (!directory) {
        setLinkError(t('link.error.unsavedDocument', { target }));
        return true;
      }
      const resolved = resolveRelativePath(directory, target);
      if (!resolved) {
        setLinkError(t('link.error.unresolvableRelative', { target }));
        return true;
      }

      void openDocumentAt(resolved);
      return true;
    },
    [filePath, openDocumentAt, t]
  );

  // Global keyboard shortcuts and commands
  useEffect(() => {
    const unsubs = [
      commandRegistry.registerCommand({
        id: 'new-file',
        titleKey: 'cmd.newFile',
        shortcut: 'Mod-N',
        execute: () => void handleNewFile()
      }),
      commandRegistry.registerCommand({
        id: 'open-file',
        titleKey: 'cmd.openFile',
        shortcut: 'Mod-O',
        execute: handleOpenFile
      }),
      commandRegistry.registerCommand({
        id: 'save',
        titleKey: 'cmd.save',
        shortcut: 'Mod-S',
        execute: () => saveFile({ immediate: true })
      }),
      commandRegistry.registerCommand({
        id: 'save-as',
        titleKey: 'cmd.saveAs',
        shortcut: 'Mod-Shift-S',
        execute: saveAs
      }),
      commandRegistry.registerCommand({
        id: 'toggle-theme',
        titleKey: 'cmd.toggleTheme',
        execute: () => setTheme(theme.type === 'light' ? 'dark' : 'light')
      }),
      commandRegistry.registerCommand({
        id: 'toggle-locale',
        titleKey: 'cmd.toggleLocale',
        execute: () => setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN')
      }),
      commandRegistry.registerCommand({
        id: 'toggle-surface',
        titleKey: 'cmd.toggleSurface',
        shortcut: 'Mod-M',
        execute: () => setSurfaceKind((prev) => (prev === 'source' ? 'visual' : 'source'))
      }),
      commandRegistry.registerCommand({
        id: 'find',
        titleKey: 'cmd.find',
        shortcut: 'Mod-F',
        execute: () => {
          const activeView = (window as unknown as { nexusActiveView?: EditorView }).nexusActiveView;
          if (activeView) openSearchPanel(activeView);
        }
      }),
      commandRegistry.registerCommand({
        id: 'replace',
        titleKey: 'cmd.replace',
        shortcut: 'Mod-H',
        execute: () => {
          const activeView = (window as unknown as { nexusActiveView?: EditorView }).nexusActiveView;
          if (activeView) openSearchPanel(activeView);
        }
      }),
      commandRegistry.registerCommand({
        id: 'open-in-workspace',
        titleKey: 'cmd.openInWorkspace',
        execute: () => {
          // Placeholder for opening current file in workspace
        }
      })
    ];

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      if (matchesShortcut(e, 'Mod-K')) {
        e.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      // Ctrl+P 快速打开。与 Mod-K 分开：一个是「找文件」，一个是「找命令」，
      // 混成一个入口会让两个都很慢。
      if (matchesShortcut(e, 'Mod-P')) {
        e.preventDefault();
        setQuickOpenOpen(true);
        return;
      }

      if (matchesShortcut(e, 'Mod-W')) {
        e.preventDefault();
        if (window.nexus?.closeWindow) window.nexus.closeWindow();
        return;
      }

      for (const cmd of commandRegistry.getCommands()) {
        if (cmd.shortcut && matchesShortcut(e, cmd.shortcut)) {
          e.preventDefault();
          commandRegistry.executeCommand(cmd.id);
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      unsubs.forEach(u => u());
    };
  }, [handleOpenFile, saveAs, saveFile, theme, setTheme, locale, setLocale]);

  // Conflict resolution actions
  const handleReloadExternal = useCallback(async () => {
    if (!filePath || !window.nexus?.readFile) return;
    try {
      const content = await window.nexus.readFile(filePath);
      initialContentRef.current = content;
      session.replaceSource(content);
      updateSaveState('clean');
    } catch (err) {
      console.error('Failed to reload external file:', err);
    }
  }, [filePath, session, updateSaveState]);

  const handleKeepLocal = useCallback(() => {
    updateSaveState('dirty');
  }, [updateSaveState]);

  /** 双击标题栏最大化/还原；命中按钮或下拉菜单时不触发，避免误触。 */
  const handleHeaderDoubleClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, .nexus-menu-dropdown')) return;
    window.nexus?.maximizeWindow?.();
  }, []);

  /**
   * 撤销/重做走 session，与编辑器 Mod-z / Mod-Shift-z 共用同一份历史，
   * 避免菜单与快捷键产生两条独立的 undo 栈。
   */
  const handleUndo = useCallback(() => {
    session.undo();
  }, [session]);

  const handleRedo = useCallback(() => {
    session.redo();
  }, [session]);

  /** 复制/剪切/粘贴依赖编辑器 DOM 选区，执行前把焦点交还给编辑器。 */
  const focusActiveEditor = useCallback(() => {
    const activeView = (window as unknown as { nexusActiveView?: { focus: () => void } })
      .nexusActiveView;
    activeView?.focus();
  }, []);

  const handleCopy = useCallback(async () => {
    focusActiveEditor();
    const { source, selection } = session.getSnapshot();
    const from = Math.min(selection.anchor, selection.head);
    const to = Math.max(selection.anchor, selection.head);
    if (from === to) return;
    const selectedText = source.slice(from, to);
    try {
      await navigator.clipboard?.writeText(selectedText);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  }, [focusActiveEditor, session]);

  const handleCut = useCallback(async () => {
    focusActiveEditor();
    const { source, selection } = session.getSnapshot();
    const from = Math.min(selection.anchor, selection.head);
    const to = Math.max(selection.anchor, selection.head);
    if (from === to) return;
    const selectedText = source.slice(from, to);
    try {
      await navigator.clipboard?.writeText(selectedText);
      session.dispatch({
        changes: [{ from, to, insert: '' }],
        selection: { anchor: from, head: from },
        userEvent: 'delete.cut'
      });
    } catch (err) {
      console.error('Cut failed:', err);
    }
  }, [focusActiveEditor, session]);

  const handleSelectAll = useCallback(() => {
    const { source } = session.getSnapshot();
    session.dispatch({
      changes: [],
      selection: { anchor: 0, head: source.length }
    });
    focusActiveEditor();
  }, [focusActiveEditor, session]);

  /** 粘贴无法用 execCommand 触发，改为读取剪贴板文本后写入 canonical source。 */
  const handlePaste = useCallback(async () => {
    focusActiveEditor();
    try {
      const text = await navigator.clipboard?.readText();
      if (!text) return;
      const { selection } = session.getSnapshot();
      const from = Math.min(selection.anchor, selection.head);
      const to = Math.max(selection.anchor, selection.head);
      const caret = from + text.length;
      session.dispatch({
        changes: [{ from, to, insert: text }],
        selection: { anchor: caret, head: caret },
        userEvent: 'input.paste'
      });
    } catch (err) {
      console.error('Paste failed:', err);
    }
  }, [focusActiveEditor, session]);

  const menus = useMemo<MenuBarMenu[]>(
    () => [
      {
        id: 'file',
        label: t('menu.file'),
        items: [
          {
            label: t('cmd.newFile'),
            shortcut: formatShortcut('Mod-N'),
            onSelect: () => void handleNewFile()
          },
          {
            label: t('cmd.openFile'),
            shortcut: formatShortcut('Mod-O'),
            onSelect: () => void handleOpenFile()
          },
          {
            label: t('cmd.save'),
            shortcut: formatShortcut('Mod-S'),
            onSelect: () => void saveFile({ immediate: true })
          },
          {
            label: t('cmd.saveAs'),
            shortcut: formatShortcut('Mod-Shift-S'),
            onSelect: () => void saveAs()
          },
          { label: '', separator: true },
          {
            label: t('cmd.openInWorkspace'),
            onSelect: () => {
              // Placeholder for opening in workspace
            }
          },
          {
            label: t('cmd.openContainingFolder'),
            onSelect: () => {
              // Placeholder for opening containing folder
            }
          },
          {
            label: t('cmd.revealInFileExplorer'),
            onSelect: () => {
              // Placeholder for revealing in file explorer
            }
          },
          { label: '', separator: true },
          {
            label: t('cmd.closeFile'),
            shortcut: formatShortcut('Mod-W'),
            onSelect: () => {
              if (window.nexus?.closeWindow) window.nexus.closeWindow();
            }
          }
        ]
      },
      {
        id: 'edit',
        label: t('menu.edit'),
        items: [
          { label: t('cmd.undo'), shortcut: formatShortcut('Mod-Z'), onSelect: handleUndo },
          { label: t('cmd.redo'), shortcut: formatShortcut('Mod-Shift-Z'), onSelect: handleRedo },
          { label: t('cmd.copy'), shortcut: formatShortcut('Mod-C'), onSelect: handleCopy },
          { label: t('cmd.cut'), shortcut: formatShortcut('Mod-X'), onSelect: handleCut },
          {
            label: t('cmd.paste'),
            shortcut: formatShortcut('Mod-V'),
            onSelect: () => void handlePaste()
          },
          { label: t('cmd.selectAll'), shortcut: formatShortcut('Mod-A'), onSelect: handleSelectAll }
        ]
      },
      {
        id: 'appearance',
        label: t('menu.appearance'),
        items: [
          {
            label: t('theme.light'),
            active: theme.type === 'light',
            onSelect: () => setTheme('light')
          },
          {
            label: t('theme.dark'),
            active: theme.type === 'dark',
            onSelect: () => setTheme('dark')
          },
          { label: '', separator: true },
          {
            label: t('lang.zhCN'),
            active: locale === 'zh-CN',
            onSelect: () => setLocale('zh-CN')
          },
          {
            label: t('lang.enUS'),
            active: locale === 'en-US',
            onSelect: () => setLocale('en-US')
          },
          { label: '', separator: true },
          {
            // 默认关：进源码的默认路径是代码块 header 上的按钮（显式动作、效果可预期）。
            // 打开后点图表 = 瞥一眼源码，光标一离开就回到预览。
            label: t('mermaid.clickToReveal'),
            active: mermaidClickToReveal,
            onSelect: () => mermaidPreviewPreference.set(!mermaidClickToReveal)
          }
        ]
      }
    ],
    [
      t,
      handleNewFile,
      handleOpenFile,
      saveFile,
      saveAs,
      handleUndo,
      handleRedo,
      handleCopy,
      handleCut,
      handlePaste,
      handleSelectAll,
      theme.type,
      setTheme,
      locale,
      setLocale,
      mermaidClickToReveal
    ]
  );

  /** 当前上下文里「正在看的东西」：lightweight 是文件，workspace 是目录。 */
  const activePath = filePath ?? workspaceRoot;
  const fileName = activePath ? activePath.replace(/^.*[\\/]/, '') : 'Untitled.md';

  /**
   * 状态栏唯一展示的东西：加载态优先（它是瞬时的），之后是保存态。
   *
   * 文案与指示点色调都从这一个值派生。此前两者各自用不同判据
   * （标题栏用状态映射、状态栏用 `saveState !== 'saved'`），
   * 于是刚打开的文件标题栏说 Saved、状态栏说 Modified。
   */
  const statusDisplay: { tone: string; text: string } =
    status !== 'ready'
      ? {
          tone: status,
          text: t(status === 'loading' ? 'status.loading' : 'status.loadError')
        }
      : { tone: SAVE_STATE_TONE[saveState], text: t(SAVE_STATE_KEY[saveState]) };

  /**
   * 窗口标题：`<文件名> — <模式名>`。
   *
   * Electron 的窗口标题跟随 `document.title`，而 `index.html` 里的 `<title>` 只是个中性初值 ——
   * 之前那里写死了「Nexus Lite」，于是全量模式的窗口标题也一直挂着 Lite
   * （`BrowserWindow` 的 title 会被页面的 `<title>` 覆盖，改主进程没用）。
   */
  useEffect(() => {
    const appName = workspaceRoot ? t('app.name.workspace') : t('app.name.lite');
    document.title = `${fileName || t('tab.untitled')} — ${appName}`;
  }, [fileName, workspaceRoot, t]);

  return (
    <div className="nexus-app-root">
      {/* Header Bar */}
      <header className="nexus-header-bar" onDoubleClick={handleHeaderDoubleClick}>
        <div className="nexus-header-left">
          <span className="nexus-app-title">
            {workspaceRoot ? t('app.name.workspace') : t('app.name.lite')}
          </span>
          <MenuBar menus={menus} />
        </div>

        <div className="nexus-header-center" title={activePath ?? 'Untitled'}>
          <span className="nexus-filename">{fileName}</span>
          {activePath && <span className="nexus-filepath-subtitle">{activePath}</span>}
        </div>

        <div className="nexus-header-right">
          <button
            type="button"
            className="nexus-header-button nexus-theme-toggle"
            onClick={() => setTheme(theme.type === 'light' ? 'dark' : 'light')}
            aria-label={t('cmd.toggleTheme')}
            title={t('cmd.toggleTheme')}
          >
            <span aria-hidden="true">{theme.type === 'light' ? MoonIcon : SunIcon}</span>
          </button>

          <button
            type="button"
            className="nexus-header-button nexus-surface-toggle"
            onClick={() => setSurfaceKind(surfaceKind === 'source' ? 'visual' : 'source')}
            aria-pressed={surfaceKind === 'visual'}
            aria-label={surfaceKind === 'source' ? t('surface.toVisual') : t('surface.toSource')}
            title={surfaceKind === 'source' ? t('surface.toVisual') : t('surface.toSource')}
          >
            {surfaceKind === 'source' ? CodeIcon : EyeIcon}
          </button>

          <WindowControls
            labels={{
              minimize: t('window.minimize'),
              maximize: t('window.maximize'),
              restore: t('window.restore'),
              close: t('window.close')
            }}
          />
        </div>
      </header>

      {/* Link Navigation Failure Banner */}
      {linkError && (
        <div className="nexus-warning-banner" role="alert">
          <span>{linkError}</span>
          <button
            type="button"
            className="nexus-banner-dismiss-btn"
            onClick={() => setLinkError(null)}
          >
            {t('banner.dismiss')}
          </button>
        </div>
      )}

      {/* ReadOnly Banner */}
      {saveState === 'readonly' && (
        <div className="nexus-warning-banner" role="alert">
          <span>{t('banner.readonly')}</span>
          <button type="button" className="nexus-banner-saveas-btn" onClick={saveAs}>
            {t('cmd.saveAs')}
          </button>
        </div>
      )}

      {/* External Conflict Banner */}
      {saveState === 'external-changed' && (
        <div className="nexus-conflict-banner" role="alert">
          <span className="nexus-conflict-text">
            {t('banner.conflict')}
          </span>
          <div className="nexus-conflict-actions">
            <button
              type="button"
              className="nexus-conflict-reload-btn"
              onClick={handleReloadExternal}
            >
              {t('banner.reload')}
            </button>
            <button
              type="button"
              className="nexus-conflict-keep-btn"
              onClick={handleKeepLocal}
            >
              {t('banner.keepLocal')}
            </button>
          </div>
        </div>
      )}

      {/* External Deleted/Renamed Banner */}
      {saveState === 'deleted' && (
        <div className="nexus-warning-banner" role="alert">
          <span>{t('banner.deleted')}</span>
          <button type="button" className="nexus-banner-saveas-btn" onClick={saveAs}>
            {t('cmd.saveAs')}
          </button>
        </div>
      )}

      {/* Save Error Recovery Banner */}
      {saveState === 'error' && (
        <div className="nexus-save-error-banner" role="alert">
          <span className="nexus-save-error-text">
            {t('banner.saveError', { reason: saveError ?? t('banner.saveErrorUnknown') })}
          </span>
          <div className="nexus-save-error-actions">
            <button
              type="button"
              className="nexus-save-error-retry"
              onClick={() => saveFile({ immediate: true })}
            >
              {t('editor.retry')}
            </button>
            <button
              type="button"
              className="nexus-save-error-saveas"
              onClick={saveAs}
            >
              {t('cmd.saveAs')}
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="nexus-body">
        {/* 活动栏与面板只在工作区模式下出现；lightweight 保持原来的单栏布局 */}
        {status === 'ready' && workspaceRoot && (
          <ActivityBar
            activeId={activity.activeId}
            panelOpen={activity.panelOpen}
            onSelect={handleActivitySelect}
            onOpenSettings={() => setCommandPaletteOpen(true)}
          />
        )}

        {status === 'ready' && workspaceRoot && (
          <div
            className={`nexus-activity-panel${
              activity.panelOpen ? ' nexus-activity-panel-open' : ''
            }`}
            style={{ '--nexus-panel-width': `${panelWidth}px` } as React.CSSProperties}
          >
            {/* 拖拽把手：只在展开时挂载，收起状态下没有可拖的东西 */}
            {activity.panelOpen && (
              <div
                className={`nexus-panel-resizer${
                  isResizing ? ' nexus-panel-resizer-active' : ''
                }`}
                role="separator"
                aria-orientation="vertical"
                aria-label={t('panel.resize')}
                title={t('panel.resizeHint')}
                onMouseDown={handleResizeStart}
                onDoubleClick={handleResizeReset}
              />
            )}
            {/* 面板内容保留挂载、只切换可见性：WorkspaceSidebar 挂载时会跑一次索引，
                卸载重建就意味着每次切回来都重新索引一遍。用 hidden 属性不行 ——
                它会被 CSS 里的 display 覆盖。 */}
            <div
              className={`nexus-panel-slot${
                activity.activeId === 'workspace' ? '' : ' nexus-panel-slot-hidden'
              }`}
            >
              <WorkspaceSidebar
                rootPath={workspaceRoot}
                activeFilePath={filePath}
                onOpenFile={handleOpenWorkspaceFile}
                onIndexed={handleIndexed}
              />
            </div>
            <div
              className={`nexus-panel-slot${
                activity.activeId === 'outline' ? '' : ' nexus-panel-slot-hidden'
              }`}
            >
              {/* 大纲是「当前文档」的视图：没有活动文档时它没有意义 */}
              {activeDocument ? (
                <OutlinePanel
                  session={session}
                  onJump={handleOutlineJump}
                  filePath={filePath}
                  onOpenFile={handleOpenWorkspaceFile}
                />
              ) : (
                <p className="nexus-panel-placeholder">{t('workspace.pickFile')}</p>
              )}
            </div>
            <div
              className={`nexus-panel-slot${
                activity.activeId === 'search' ? '' : ' nexus-panel-slot-hidden'
              }`}
            >
              {/* 搜索覆盖整个工作区，不依赖当前文档 */}
              <SearchPanel onOpenFile={handleOpenWorkspaceFile} />
            </div>
            <div
              className={`nexus-panel-slot${
                activity.activeId === 'tags' ? '' : ' nexus-panel-slot-hidden'
              }`}
            >
              {/* 标签来自索引（磁盘内容），编辑后用 documentRevision 触发重读 */}
              <TagsPanel
                onOpenFile={handleOpenWorkspaceFile}
                revision={documentRevision}
              />
            </div>
            <div
              className={`nexus-panel-slot${
                activity.activeId === 'extensions' ? '' : ' nexus-panel-slot-hidden'
              }`}
            >
              <PluginsPanel
                host={extensionHostRef.current ?? undefined}
                revision={documentRevision}
              />
            </div>
          </div>
        )}

        <main className="nexus-main-content">
        {/* 标签栏挂在编辑区容器**内部**：它只该横跨编辑区，不该延伸到活动栏和侧栏上方。
            放在这里还有个好处 —— 侧栏展开/收起时标签栏宽度自动跟着变，不需要额外同步。 */}
        <TabBar
          documents={workspaceSnapshot.documents}
          activeId={workspaceSnapshot.activeId}
          onActivate={store.activate}
          onClose={handleCloseTab}
        />
        {status === 'loading' && (
          <div className="nexus-state-container">
            <div className="nexus-loading-spinner" />
            <p className="nexus-state-text">{t('status.loadingDocument')}</p>
          </div>
        )}

        {status === 'error' && (
          <div className="nexus-state-container">
            <div className="nexus-error-card" role="alert">
              <span className="error-title">{t('error.unableToOpen')}</span>
              <p className="error-description">{errorMessage}</p>
              <button
                type="button"
                className="nexus-retry-btn"
                onClick={loadDocument}
              >
                {t('editor.retry')}
              </button>
            </div>
          </div>
        )}
        {/* 没有活动文档时的空态。workspace 模式下这是正常起点（从左侧挑一个文件），
            lightweight 模式下只会在启动的一瞬间出现。 */}
        {status === 'ready' && !activeDocument && (
          <div className="nexus-workspace-empty">
            <span className="nexus-workspace-empty-title">{t('workspace.title')}</span>
            {workspaceRoot && (
              <code className="nexus-workspace-empty-path">{workspaceRoot}</code>
            )}
            <p className="nexus-workspace-empty-note">
              {workspaceRoot ? t('workspace.pickFile') : t('workspace.pending')}
            </p>
          </div>
        )}
        {status === 'ready' && activeDocument && (
          // 只包编辑区：投影抛错时保留顶栏、菜单栏和状态栏，
          // 让 Mod-M 切换 surface 成为一条真实可用的恢复路径。
          // resetKey 绑 surfaceKind，切回 Source 会自动清除错误状态。
          <ErrorBoundary resetKey={surfaceKind} titleKey="error.surfaceTitle">
            <EditorSurface
              session={session}
              surfaceId="main-editor"
              surfaceKind={surfaceKind}
              saveState={saveState}
              saveError={saveError}
              readOnly={saveState === 'readonly'}
              documentDirectory={getDocumentDirectory(filePath)}
              linkNavigator={handleLinkNavigation}
              extensionHost={extensionHostRef.current ?? undefined}
              theme={theme.type}
              locale={locale}
              onChange={handleContentChange}
              onSelectionChange={handleSelectionChange}
              className="nexus-editor-full"
            />
          </ErrorBoundary>
        )}
        </main>
      </div>

      {/* Status Bar Footer */}
      <footer className="nexus-status-bar">
        <div className="status-bar-left">
          <span className={`status-dot ${statusDisplay.tone}`} aria-hidden="true" />
          {/* 保存状态现在是这里唯一的展示位（标题栏的徽标已移除），
              所以 aria-live 也搬过来，屏幕阅读器才会播报状态变化。 */}
          <span
            className="status-text"
            role="status"
            aria-live="polite"
            title={saveError ?? statusDisplay.text}
          >
            {statusDisplay.text}
          </span>
        </div>

        <div className="status-bar-right">
          <span className="status-metric">
            {t('status.lineColumn', {
              line: String(selection.line),
              column: String(selection.column)
            })}
          </span>
          {selection.selectedTextLength > 0 && (
            <span className="status-metric">
              ({t('status.selected', { count: String(selection.selectedTextLength) })})
            </span>
          )}
          {/* 专有名词，不翻译 */}
          <span className="status-metric status-format">
            {workspaceRoot ? 'Workspace' : 'Markdown'}
          </span>
        </div>
      </footer>
      <CommandPalette 
        isOpen={isCommandPaletteOpen} 
        onClose={() => setCommandPaletteOpen(false)} 
      />
      {/* 只在工作区模式提供：快速打开找的是索引里的文件，lightweight 下没有索引 */}
      {quickOpenOpen && workspaceRoot && (
        <QuickOpen
          onOpenFile={(targetPath) => {
            setQuickOpenOpen(false);
            void handleOpenWorkspaceFile(targetPath);
          }}
          onClose={() => setQuickOpenOpen(false)}
        />
      )}
    </div>
  );
};
