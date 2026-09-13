import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { LaunchContext } from '@nexus/core';

export type ShellStatus = 'loading' | 'ready' | 'error';

export const App: React.FC = () => {
  const [context, setContext] = useState<LaunchContext | null>(null);
  const [status, setStatus] = useState<ShellStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  const initLaunchContext = useCallback(async () => {
    setStatus('loading');
    setErrorMessage(null);

    try {
      if (!window.nexus || typeof window.nexus.getLaunchContext !== 'function') {
        throw new Error(
          'Nexus bridge is unavailable. Preload script may have failed to initialize.'
        );
      }

      const ctx = await window.nexus.getLaunchContext();
      if (!isMountedRef.current) return;

      if (!ctx || typeof ctx.mode !== 'string') {
        throw new Error('Invalid launch context received from shell bridge.');
      }

      setContext(ctx);
      setStatus('ready');
    } catch (err) {
      console.error('Failed to retrieve launch context from bridge:', err);
      if (!isMountedRef.current) return;

      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(message);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    initLaunchContext();

    return () => {
      isMountedRef.current = false;
    };
  }, [initLaunchContext]);

  const displayMode = context
    ? context.mode.charAt(0).toUpperCase() + context.mode.slice(1)
    : 'Lightweight';
  const displayFile = context?.filePath ?? 'No file selected';

  return (
    <main className="nexus-container">
      <header className="nexus-header">
        <h1 className="nexus-title">Nexus Lite</h1>
        <span className="nexus-badge">{displayMode}</span>
      </header>

      {status === 'error' ? (
        <section className="nexus-card">
          <div className="nexus-error-card" role="alert">
            <span className="error-title">Shell initialization failed</span>
            <p className="error-description">{errorMessage}</p>
            <button
              type="button"
              className="nexus-retry-btn"
              onClick={initLaunchContext}
            >
              Retry
            </button>
          </div>
        </section>
      ) : (
        <section className="nexus-card">
          <div className="nexus-field">
            <span className="field-label">Mode:</span>
            <span className="field-value">{displayMode}</span>
          </div>

          <div className="nexus-field">
            <span className="field-label">File:</span>
            <span className="field-value file-path">{displayFile}</span>
          </div>

          {context?.unsupportedPath && (
            <div className="nexus-alert" role="alert">
              <span className="alert-title">Unsupported file type</span>
              <p className="alert-message">
                File <code>{context.unsupportedPath}</code> cannot be opened. Nexus
                Lite currently only supports Markdown (<code>.md</code>,{' '}
                <code>.markdown</code>) documents.
              </p>
            </div>
          )}
        </section>
      )}

      <footer className="nexus-footer">
        {status === 'loading' && (
          <span className="status-indicator loading">Initializing shell...</span>
        )}
        {status === 'ready' && (
          <span className="status-indicator ready">Shell ready</span>
        )}
        {status === 'error' && (
          <span className="status-indicator error">Shell error</span>
        )}
      </footer>
    </main>
  );
};
