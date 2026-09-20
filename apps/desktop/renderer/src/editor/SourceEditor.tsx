import React, { useEffect, useRef } from 'react';
import {
  createSessionEditorView,
  getSelectionInfo,
  setEditorReadOnly,
  setDocumentDirectory,
  type EditorSurfaceKind,
  type EditorSaveState,
  type EditorSelectionInfo,
  type MarkdownDocumentSession,
  type SessionEditorViewHandle
} from '@nexus/editor';

export type { EditorSaveState, EditorSelectionInfo };

export interface SourceEditorProps {
  session: MarkdownDocumentSession;
  surfaceId: string;
  surfaceKind?: EditorSurfaceKind;
  saveState?: EditorSaveState;
  saveError?: string | null;
  readOnly?: boolean;
  documentDirectory?: string | null;
  onChange?: (value: string) => void;
  onSelectionChange?: (selection: EditorSelectionInfo) => void;
  className?: string;
}

/**
 * React bridge for a session-backed CodeMirror Source/Visual surface.
 * The session owns canonical Markdown; this module only owns the view lifecycle.
 */
export const EditorSurface: React.FC<SourceEditorProps> = ({
  session,
  surfaceId,
  surfaceKind = 'source',
  readOnly = false,
  documentDirectory,
  onChange,
  onSelectionChange,
  className
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<SessionEditorViewHandle | null>(null);

  // Store latest callbacks in refs so we do not recreate EditorView on parent re-renders
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  useEffect(() => {
    return session.subscribe((snapshot, transaction) => {
      if (transaction && transaction.changes.length > 0) {
        onChangeRef.current?.(snapshot.source);
      }
    });
  }, [session]);

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;

    // StrictMode safeguard: destroy previous view if already created
    if (handleRef.current) {
      handleRef.current.destroy();
      handleRef.current = null;
    }

    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId,
      surfaceKind,
      readOnly,
      documentDirectory,
      onSelectionChange: () => {
        const view = handleRef.current?.view;
        if (view) {
          onSelectionChangeRef.current?.(getSelectionInfo(view.state));
        }
      }
    });

    handleRef.current = handle;
    if (typeof window !== 'undefined') {
      (window as any).nexusActiveView = handle.view;
    }
    onSelectionChangeRef.current?.(getSelectionInfo(handle.view.state));

    return () => {
      handle.destroy();
      if (typeof window !== 'undefined' && (window as any).nexusActiveView === handle.view) {
        (window as any).nexusActiveView = null;
      }
      if (handleRef.current === handle) {
        handleRef.current = null;
      }
    };
  }, [session, surfaceId, surfaceKind]);

  // Dynamic read-only configuration
  const prevReadOnlyRef = useRef(readOnly);
  useEffect(() => {
    if (prevReadOnlyRef.current !== readOnly) {
      prevReadOnlyRef.current = readOnly;
      if (handleRef.current) {
        setEditorReadOnly(handleRef.current.view, readOnly);
      }
    }
  }, [readOnly]);

  // Dynamic document directory configuration
  const prevDocDirRef = useRef(documentDirectory);
  useEffect(() => {
    if (prevDocDirRef.current !== documentDirectory) {
      prevDocDirRef.current = documentDirectory;
      if (handleRef.current) {
        setDocumentDirectory(handleRef.current.view, documentDirectory ?? null);
      }
    }
  }, [documentDirectory]);

  return (
    <div
      ref={containerRef}
      className={`nexus-source-editor ${className ?? ''}`}
      data-testid={`nexus-${surfaceKind}-editor`}
      data-surface-kind={surfaceKind}
    />
  );
};

/** 保留 SourceEditor 命名别名，实际接口与 EditorSurface 一致并必须传入 session。 */
export const SourceEditor = EditorSurface;
