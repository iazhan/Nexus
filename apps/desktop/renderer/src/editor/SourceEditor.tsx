import React, { useEffect, useRef } from 'react';
import {
  createSessionEditorView,
  getSelectionInfo,
  setEditorReadOnly,
  setDocumentDirectory,
  setEditorThemeConfig,
  setEditorLocale,
  setMermaidPreviewSettings,
  type EditorSurfaceKind,
  type EditorSaveState,
  type EditorSelectionInfo,
  type MarkdownDocumentSession,
  type SessionEditorViewHandle,
  type EditorScrollAnchor,
  type LinkNavigator
} from '@nexus/editor';
import { mermaidPreviewPreference } from '../platform';

export type { EditorSaveState, EditorSelectionInfo };

export interface SourceEditorProps {
  session: MarkdownDocumentSession;
  surfaceId: string;
  surfaceKind?: EditorSurfaceKind;
  saveState?: EditorSaveState;
  saveError?: string | null;
  readOnly?: boolean;
  documentDirectory?: string | null;
  /** Ctrl/Cmd+左键点击普通链接时的导航策略。 */
  linkNavigator?: LinkNavigator;
  extensionHost?: import('@nexus/editor').ExtensionHost;
  theme?: 'light' | 'dark';
  locale?: string;
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
  linkNavigator,
  extensionHost,
  theme,
  locale,
  onChange,
  onSelectionChange,
  className
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<SessionEditorViewHandle | null>(null);

  /**
   * 上一个 view 销毁前捕获的滚动锚点，交给下一个 view 恢复。
   *
   * 跨 surface 切换时，`[session, surfaceId, surfaceKind]` 变化会让 effect 重跑：
   * 先跑旧 effect 的 cleanup（捕获），再跑新 effect（恢复）。App 里的 `<EditorSurface>`
   * 没有 key，所以是同一个组件实例，ref 能跨切换存活。
   *
   * 不能搬 `scrollTop`：视觉投影把表格 / 代码块 / mermaid 渲染成块级 widget，
   * 同一份 source 在两个 surface 里的像素高度不同。锚点是位置语义，能跨布局差异。
   */
  const pendingScrollRef = useRef<EditorScrollAnchor | null>(null);
  /** 首次挂载不抢焦点（文档刚载入时焦点该留在顶栏/对话框上）。 */
  const hasMountedRef = useRef(false);

  // Store latest callbacks in refs so we do not recreate EditorView on parent re-renders
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  // 导航策略会随 filePath 变化（相对链接要按当前文档目录解析），但 EditorView 只在
  // session/surface 变化时重建。用 ref 转发，保证回调永远是最新那一个。
  const linkNavigatorRef = useRef(linkNavigator);
  linkNavigatorRef.current = linkNavigator;

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
      linkNavigator: (request) => linkNavigatorRef.current?.(request),
      extensionHost,
      theme,
      locale,
      scrollTo: pendingScrollRef.current ?? undefined,
      onSelectionChange: () => {
        const view = handleRef.current?.view;
        if (view) {
          onSelectionChangeRef.current?.(getSelectionInfo(view.state));
        }
      }
    });
    pendingScrollRef.current = null;

    handleRef.current = handle;
    if (typeof window !== 'undefined') {
      (window as any).nexusActiveView = handle.view;
    }
    onSelectionChangeRef.current?.(getSelectionInfo(handle.view.state));

    // 切 surface 时把焦点还给编辑器：旧 view 一销毁，焦点就落到 body，新 view 不聚焦则
    // 光标不可见、也打不了字——"保持光标位置"就只剩一个看不见的 offset。
    // 顺序上必须在构造（已带 scrollTo）之后：`view.focus()` 内部走 `focusPreventScroll`，
    // 不会滚动，所以不会把刚恢复的视口顶边带跑。
    if (hasMountedRef.current) {
      handle.view.focus();
    }
    hasMountedRef.current = true;

    return () => {
      // 必须在 destroy() 之前捕获：销毁之后 viewState 就没了。
      pendingScrollRef.current = handle.captureScroll();
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

  // Dynamic theme configuration
  const prevThemeRef = useRef(theme);
  useEffect(() => {
    if (prevThemeRef.current !== theme) {
      prevThemeRef.current = theme;
      if (handleRef.current) {
        setEditorThemeConfig(handleRef.current.view, theme ?? 'light');
      }
    }
  }, [theme]);

  // Dynamic locale configuration
  const prevLocaleRef = useRef(locale);
  useEffect(() => {
    if (prevLocaleRef.current !== locale) {
      prevLocaleRef.current = locale;
      if (handleRef.current && locale) {
        setEditorLocale(handleRef.current.view, locale);
      }
    }
  }, [locale]);

  // Mermaid 块显示偏好（只有 visual surface 装了那个 Compartment）
  useEffect(() => {
    if (surfaceKind !== 'visual') return;
    const apply = (clickToReveal: boolean) => {
      if (handleRef.current) {
        setMermaidPreviewSettings(handleRef.current.view, { clickToReveal });
      }
    };
    apply(mermaidPreviewPreference.get());
    return mermaidPreviewPreference.subscribe(apply);
  }, [surfaceKind]);

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
