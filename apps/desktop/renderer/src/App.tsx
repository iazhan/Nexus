import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { LaunchContext, Unsubscribe } from '@nexus/core';
import {
  MarkdownDocumentSession,
  hasMathMarkers,
  openSearchPanel,
  ExtensionHost,
  type EditorSurfaceKind,
  type EditorSaveState,
  type EditorSelectionInfo
} from '@nexus/editor';
import { EditorSurface } from './editor/SourceEditor.js';

export type ShellStatus = 'loading' | 'ready' | 'error';

/**
 * 检测数学扩展状态；解析器异常时仍保留普通 Markdown 编辑能力，并明确显示降级状态。
 */
function detectMathStatus(source: string): { hasMath: boolean; failed: boolean } {
  try {
    return { hasMath: hasMathMarkers(source), failed: false };
  } catch (error) {
    console.error('Math extension detection failed:', error);
    return {
      hasMath: source.includes('$$') || /\\$(?:[^$\\]|\\.)+\\$/.test(source),
      failed: true
    };
  }
}

function getDocumentDirectory(filePath: string | null): string | null {
  if (!filePath) return null;
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastSlash === -1) return null;
  return filePath.slice(0, lastSlash);
}

export const App: React.FC = () => {
  const [context, setContext] = useState<LaunchContext | null>(null);
  const [status, setStatus] = useState<ShellStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // File and Editor State
  const [filePath, setFilePath] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<EditorSaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
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

  // Save implementation
  const saveFile = useCallback((_options: { immediate?: boolean } = {}): Promise<boolean> => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    return enqueueSave(async () => {
      const currentSource = session.getSnapshot().source;

      // Untitled document or readonly document: prompt saveAs
      if (!filePath || saveStateRef.current === 'readonly') {
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
  }, [enqueueSave, filePath, session, updateSaveState]);

  const saveAs = useCallback((): Promise<boolean> => {
    return enqueueSave(async () => {
      const currentSource = session.getSnapshot().source;
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
        console.error('Save As failed:', err);
        const msg = err instanceof Error ? err.message : String(err);
        setSaveError(msg);
        updateSaveState('error');
        return false;
      }
    });
  }, [enqueueSave, session, updateSaveState]);

  // Open file
  const handleOpenFile = useCallback(async () => {
    try {
      if (!window.nexus?.openFile) return;
      const fileDoc = await window.nexus.openFile();
      if (!fileDoc) return;

      setFilePath(fileDoc.path);
      initialContentRef.current = fileDoc.content;
      session.replaceSource(fileDoc.content, {
        selection: { anchor: 0, head: 0 }
      });
      updateSaveState(fileDoc.readOnly ? 'readonly' : 'clean');
      setSaveError(null);
    } catch (err: unknown) {
      console.error('Open file failed:', err);
    }
  }, [session, updateSaveState]);

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

      setContext(ctx);

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

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const isMod = e.ctrlKey || e.metaKey;

      if (isMod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (e.shiftKey) {
          saveAs();
        } else {
          saveFile({ immediate: true });
        }
      } else if (isMod && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault();
        handleOpenFile();
      } else if (isMod && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        setSurfaceKind((prev) => (prev === 'source' ? 'visual' : 'source'));
      } else if (isMod && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault();
        if (window.nexus?.closeWindow) {
          window.nexus.closeWindow();
        }
      } else if (isMod && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        const activeView = (window as any).nexusActiveView;
        if (activeView) {
          openSearchPanel(activeView);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleOpenFile, saveAs, saveFile]);

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

  const displayMode = context
    ? context.mode.charAt(0).toUpperCase() + context.mode.slice(1)
    : 'Lightweight';

  const fileName = filePath ? filePath.replace(/^.*[\\/]/, '') : 'Untitled.md';
  const isDirty = saveState !== 'saved';
  const mathStatus = detectMathStatus(session.getSnapshot().source);
  const hasMath = mathStatus.hasMath;
  const mathExtensionFailed = mathStatus.failed;

  return (
    <div className="nexus-app-root">
      {/* Header Bar */}
      <header className="nexus-header-bar">
        <div className="nexus-header-left">
          <span className="nexus-app-title">Nexus Lite</span>
          <span className="nexus-badge">{displayMode}</span>
        </div>

        <div className="nexus-header-center" title={filePath ?? 'Untitled'}>
          <span className="nexus-filename">
            {fileName}
            {isDirty && <span className="nexus-dirty-indicator">*</span>}
          </span>
          {filePath && <span className="nexus-filepath-subtitle">{filePath}</span>}
        </div>

        <div className="nexus-header-right">
          <div className="nexus-surface-switcher" role="group" aria-label="Editor surface">
            <button
              type="button"
              className={surfaceKind === 'source' ? 'active' : ''}
              aria-pressed={surfaceKind === 'source'}
              onClick={() => setSurfaceKind('source')}
            >
              Source
            </button>
            <button
              type="button"
              className={surfaceKind === 'visual' ? 'active' : ''}
              aria-pressed={surfaceKind === 'visual'}
              onClick={() => setSurfaceKind('visual')}
            >
              Visual
            </button>
          </div>
          <span className={`nexus-save-badge ${saveState}`}>
            {saveState === 'dirty' && 'Unsaved'}
            {saveState === 'saving' && 'Saving...'}
            {(saveState === 'saved' || saveState === 'clean') && 'Saved'}
            {saveState === 'error' && 'Save Error'}
            {saveState === 'readonly' && 'Read Only'}
            {saveState === 'external-changed' && 'Conflict'}
            {saveState === 'deleted' && 'Deleted'}
          </span>
        </div>
      </header>

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
          <EditorSurface
            session={session}
            surfaceId="main-editor"
            surfaceKind={surfaceKind}
            saveState={saveState}
            saveError={saveError}
            readOnly={saveState === 'readonly'}
            documentDirectory={getDocumentDirectory(filePath)}
            extensionHost={extensionHostRef.current ?? undefined}
            onChange={handleContentChange}
            onSelectionChange={handleSelectionChange}
            className="nexus-editor-full"
          />
        )}
      </main>

      {/* Status Bar Footer */}
      <footer className="nexus-status-bar">
        <div className="status-bar-left">
          <span className={`status-dot ${status === 'ready' ? (isDirty ? 'dirty' : 'ready') : status}`} />
          <span className="status-text">
            {status === 'loading' && 'Loading...'}
            {status === 'error' && 'Error'}
            {status === 'ready' && (isDirty ? 'Modified' : 'Ready')}
          </span>
          {hasMath && (
            <span className={`status-extension-badge ${mathExtensionFailed ? 'error' : 'active'}`}>
              {mathExtensionFailed ? 'Math: Unavailable' : 'Math: Ready'}
            </span>
          )}
        </div>

        <div className="status-bar-right">
          <span className="status-metric">
            Ln {selection.line}, Col {selection.column}
          </span>
          {selection.selectedTextLength > 0 && (
            <span className="status-metric">
              ({selection.selectedTextLength} selected)
            </span>
          )}
          <span className="status-metric status-format">Markdown</span>
        </div>
      </footer>
    </div>
  );
};
