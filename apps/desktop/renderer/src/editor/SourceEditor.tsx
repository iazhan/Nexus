import React, { useEffect, useRef } from 'react';
import {
  createSourceEditorView,
  setEditorReadOnly,
  type EditorView,
  type EditorSaveState,
  type EditorSelectionInfo
} from '@nexus/editor';

export type { EditorSaveState, EditorSelectionInfo };

export interface SourceEditorProps {
  initialValue: string;
  saveState?: EditorSaveState;
  saveError?: string | null;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onSelectionChange?: (selection: EditorSelectionInfo) => void;
  className?: string;
}

/**
 * React wrapper around CodeMirror 6 Source Mode editor.
 * Guarantees single EditorView lifecycle, StrictMode safety, and clean teardown.
 */
export const SourceEditor: React.FC<SourceEditorProps> = ({
  initialValue,
  readOnly = false,
  onChange,
  onSelectionChange,
  className
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Store latest callbacks in refs so we do not recreate EditorView on parent re-renders
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  // initialValue is only used once on initial view mount
  const initialValueRef = useRef(initialValue);

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;

    // StrictMode safeguard: destroy previous view if already created
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    const view = createSourceEditorView({
      parent,
      doc: initialValueRef.current,
      readOnly,
      onChange: (val) => {
        onChangeRef.current?.(val);
      },
      onSelectionChange: (sel) => {
        onSelectionChangeRef.current?.(sel);
      }
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []); // Mount only once

  // Dynamic read-only configuration
  const prevReadOnlyRef = useRef(readOnly);
  useEffect(() => {
    if (prevReadOnlyRef.current !== readOnly) {
      prevReadOnlyRef.current = readOnly;
      if (viewRef.current) {
        setEditorReadOnly(viewRef.current, readOnly);
      }
    }
  }, [readOnly]);

  return (
    <div
      ref={containerRef}
      className={`nexus-source-editor ${className ?? ''}`}
      data-testid="nexus-source-editor"
    />
  );
};
