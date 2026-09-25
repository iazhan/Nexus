import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import type { FileDocument, Unsubscribe } from '@nexus/core';
import {
  MarkdownDocumentSession,
  openSearchPanel,
  resolveRelativePath,
  revealHeadingAnchor,
  ExtensionHost,
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

  // File and Editor State
  const [filePath, setFilePath] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<EditorSaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
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
  const sessionRef = useRef<MarkdownDocumentSession | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const unwatchRef = useRef<Unsubscribe | null>(null);
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;

  if (sessionRef.current === null) {
    sessionRef.current = new MarkdownDocumentSession();
  }
  const session = sessionRef.current;

  const extensionHostRef = useRef<ExtensionHost | null>(null);
  if (extensionHostRef.current === null) {
    const host = new ExtensionHost();
    extensionHostRef.current = host;
    import('@nexus/math').then(({ MathExtension }) => {
      host.register(new MathExtension());
    }).catch(e => console.error('Failed to load @nexus/math:', e));
    import('@nexus/mermaid').then(({ MermaidExtension }) => {
      host.register(new MermaidExtension());
    }).catch(e => console.error('Failed to load @nexus/mermaid:', e));
  }

  // Expose session on window for smoke testing and developer debugging
  if (typeof window !== 'undefined') {
    (window as any).nexusSession = session;
    // Mermaid 显示偏好还没有设置界面，先从这里暴露给 E2E 翻转
    (window as any).nexusMermaidPreview = mermaidPreviewPreference;
  }

  // Synchronize dirty state with Electron main process
  const updateSaveState = useCallback((nextState: EditorSaveState) => {
    setSaveState(nextState);
    // 保存中、保存失败、冲突状态仍然代表存在未持久化内容，关闭保护不能失效。
    window.nexus?.setDirty?.(
      nextState === 'dirty' ||
      nextState === 'saving' ||
      nextState === 'error' ||
      nextState === 'external-changed'
    );
  }, []);

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
   * 把已打开的文件灌进 session。系统对话框与链接跳转共用这一段，
   * 避免两条路径在 dirty / readOnly / 错误清理上出现分歧。
   */
  const applyOpenedDocument = useCallback(
    (fileDoc: FileDocument) => {
      setFilePath(fileDoc.path);
      initialContentRef.current = fileDoc.content;
      session.replaceSource(fileDoc.content, {
        selection: { anchor: 0, head: 0 }
      });
      updateSaveState(fileDoc.readOnly ? 'readonly' : 'clean');
      setSaveError(null);
    },
    [session, updateSaveState]
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
        setLinkError(`无法打开链接目标：${targetPath}（${err instanceof Error ? err.message : String(err)}）`);
        return false;
      }
    },
    [applyOpenedDocument]
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
          `File "${ctx.unsupportedPath}" cannot be opened. Nexus Lite only supports Markdown (.md, .markdown) documents.`
        );
        return;
      }

      // If a file path was passed in context, load its content
      if (ctx.filePath) {
        const fileDoc = await window.nexus.openFile(ctx.filePath);
        if (!isCurrentRequest()) return;

        setFilePath(fileDoc.path);
        initialContentRef.current = fileDoc.content;
        session.replaceSource(fileDoc.content, {
          selection: { anchor: 0, head: 0 }
        });
        updateSaveState(fileDoc.readOnly ? 'readonly' : 'clean');
        setStatus('ready');
      } else {
        // No file provided: open an empty markdown editor
        setFilePath(null);
        initialContentRef.current = '';
        session.replaceSource('', {
          selection: { anchor: 0, head: 0 }
        });
        updateSaveState('clean');
        setStatus('ready');
      }
    } catch (err) {
      console.error('Failed to load file or initialize editor:', err);
      if (!isCurrentRequest()) return;

      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(message);
      setStatus('error');
    }
  }, [session, updateSaveState]);

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

  // 新建空文档：置空 filePath 会触发监听清理，文档回到未命名的干净状态。
  // 定义在快捷键 effect 之前，否则 effect 的依赖数组会在渲染期读到未初始化的绑定（TDZ）。
  const handleNewFile = useCallback(() => {
    setFilePath(null);
    initialContentRef.current = '';
    session.replaceSource('', { selection: { anchor: 0, head: 0 } });
    setSaveError(null);
    updateSaveState('clean');
  }, [session, updateSaveState]);

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
    ({ href }) => {
      const target = href.trim();
      if (!target) return false;

      // 1. 文档内锚点：光标落到标题上并滚动过去
      if (target.startsWith('#')) {
        const view = (window as unknown as { nexusActiveView?: EditorView }).nexusActiveView;
        if (!view) return false;
        if (revealHeadingAnchor(view, target)) {
          setLinkError(null);
          return true;
        }
        setLinkError(`文档内找不到锚点：${target}`);
        return true;
      }

      // 2. 外部协议。这里再判一次白名单，是不把"净化器放行过"当成"一定能开"；
      //    主进程侧还有第三道校验，被拒时它返回 false。
      if (/^(?:https?|mailto):/i.test(target)) {
        const openExternal = window.nexus?.openExternal;
        if (!openExternal) return false;
        void openExternal(target)
          .then((opened) => {
            setLinkError(opened ? null : `系统未接受这个链接：${target}`);
          })
          .catch((err: unknown) => {
            console.error('Failed to open external link:', err);
            setLinkError(`无法打开外部链接：${target}`);
          });
        return true;
      }

      // 3. 相对路径：必须相对当前文档目录解析，否则会被当成进程 cwd。
      const directory = getDocumentDirectory(filePath);
      if (!directory) {
        setLinkError(`当前文档尚未保存，无法解析相对链接：${target}`);
        return true;
      }
      const resolved = resolveRelativePath(directory, target);
      if (!resolved) {
        setLinkError(`无法解析这个相对链接：${target}`);
        return true;
      }

      void openDocumentAt(resolved);
      return true;
    },
    [filePath, openDocumentAt]
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

  const fileName = filePath ? filePath.replace(/^.*[\\/]/, '') : 'Untitled.md';

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

  return (
    <div className="nexus-app-root">
      {/* Header Bar */}
      <header className="nexus-header-bar" onDoubleClick={handleHeaderDoubleClick}>
        <div className="nexus-header-left">
          <span className="nexus-app-title">Nexus Lite</span>
          <MenuBar menus={menus} />
        </div>

        <div className="nexus-header-center" title={filePath ?? 'Untitled'}>
          <span className="nexus-filename">{fileName}</span>
          {filePath && <span className="nexus-filepath-subtitle">{filePath}</span>}
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
            知道了
          </button>
        </div>
      )}

      {/* ReadOnly Banner */}
      {saveState === 'readonly' && (
        <div className="nexus-warning-banner" role="alert">
          <span>文件处于只读模式。无法直接保存更改，请另存为。</span>
          <button type="button" className="nexus-banner-saveas-btn" onClick={saveAs}>
            另存为...
          </button>
        </div>
      )}

      {/* External Conflict Banner */}
      {saveState === 'external-changed' && (
        <div className="nexus-conflict-banner" role="alert">
          <span className="nexus-conflict-text">
            文件已在外部被修改。请选择：重新加载（放弃本地未保存修改）或保留当前内容（将在保存时覆盖外部内容）。
          </span>
          <div className="nexus-conflict-actions">
            <button
              type="button"
              className="nexus-conflict-reload-btn"
              onClick={handleReloadExternal}
            >
              重新加载 (Reload)
            </button>
            <button
              type="button"
              className="nexus-conflict-keep-btn"
              onClick={handleKeepLocal}
            >
              保留当前 (Keep Local)
            </button>
          </div>
        </div>
      )}

      {/* External Deleted/Renamed Banner */}
      {saveState === 'deleted' && (
        <div className="nexus-warning-banner" role="alert">
          <span>文件已被外部删除或移动。请尽快另存为以防数据丢失。</span>
          <button type="button" className="nexus-banner-saveas-btn" onClick={saveAs}>
            另存为...
          </button>
        </div>
      )}

      {/* Save Error Recovery Banner */}
      {saveState === 'error' && (
        <div className="nexus-save-error-banner" role="alert">
          <span className="nexus-save-error-text">
            保存失败：{saveError ?? '无法写入目标文件'}。
          </span>
          <div className="nexus-save-error-actions">
            <button
              type="button"
              className="nexus-save-error-retry"
              onClick={() => saveFile({ immediate: true })}
            >
              重试 (Retry)
            </button>
            <button
              type="button"
              className="nexus-save-error-saveas"
              onClick={saveAs}
            >
              另存为 (Save As...)
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="nexus-main-content">
        {status === 'loading' && (
          <div className="nexus-state-container">
            <div className="nexus-loading-spinner" />
            <p className="nexus-state-text">Loading document...</p>
          </div>
        )}

        {status === 'error' && (
          <div className="nexus-state-container">
            <div className="nexus-error-card" role="alert">
              <span className="error-title">Unable to open document</span>
              <p className="error-description">{errorMessage}</p>
              <button
                type="button"
                className="nexus-retry-btn"
                onClick={loadDocument}
              >
                Retry
              </button>
            </div>
          </div>
        )}
        {status === 'ready' && (
          // 只包编辑区：投影抛错时保留顶栏、菜单栏和状态栏，
          // 让 Mod-M 切换 surface 成为一条真实可用的恢复路径。
          // resetKey 绑 surfaceKind，切回 Source 会自动清除错误状态。
          <ErrorBoundary resetKey={surfaceKind} title="Unable to render this surface">
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
          <span className="status-metric status-format">Markdown</span>
        </div>
      </footer>
      <CommandPalette 
        isOpen={isCommandPaletteOpen} 
        onClose={() => setCommandPaletteOpen(false)} 
      />
    </div>
  );
};
