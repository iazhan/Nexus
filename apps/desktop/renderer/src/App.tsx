import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { LaunchContext } from '@nexus/core';
import {
  MarkdownDocumentSession,
  type EditorSurfaceKind,
  type EditorSaveState,
  type EditorSelectionInfo
} from '@nexus/editor';
import { EditorSurface } from './editor/SourceEditor.js';

export type ShellStatus = 'loading' | 'ready' | 'error';

export const App: React.FC = () => {
  const [context, setContext] = useState<LaunchContext | null>(null);
  const [status, setStatus] = useState<ShellStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // File and Editor State
  const [filePath, setFilePath] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<EditorSaveState>('saved');
  const [saveError] = useState<string | null>(null);
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

  if (sessionRef.current === null) {
    sessionRef.current = new MarkdownDocumentSession();
  }
  const session = sessionRef.current;

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
        setSaveState('saved');
        setStatus('ready');
      } else {
        // No file provided: open an empty markdown editor
        setFilePath(null);
        initialContentRef.current = '';
        session.replaceSource('', {
          selection: { anchor: 0, head: 0 }
        });
        setSaveState('saved');
        setStatus('ready');
      }
    } catch (err) {
      console.error('Failed to load file or initialize editor:', err);
      if (!isCurrentRequest()) return;

      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(message);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    loadDocument();

    return () => {
      isMountedRef.current = false;
    };
  }, [loadDocument]);

  const handleContentChange = useCallback((newContent: string) => {
    if (newContent !== initialContentRef.current) {
      setSaveState('dirty');
    } else {
      setSaveState('saved');
    }
  }, []);

  const handleSelectionChange = useCallback((newSelection: EditorSelectionInfo) => {
    setSelection(newSelection);
  }, []);

  const displayMode = context
    ? context.mode.charAt(0).toUpperCase() + context.mode.slice(1)
    : 'Lightweight';

  const fileName = filePath ? filePath.replace(/^.*[\\/]/, '') : 'Untitled.md';
  const isDirty = saveState === 'dirty';

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
            {saveState === 'saved' && 'Saved'}
            {saveState === 'error' && 'Save Error'}
          </span>
        </div>
      </header>

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
