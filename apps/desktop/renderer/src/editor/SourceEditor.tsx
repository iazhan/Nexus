import React, { useEffect, useRef } from 'react';
import {
  createSessionEditorView,
  getSelectionInfo,
  setEditorReadOnly,
  setDocumentDirectory,
  setWorkspaceAssets,
  setEditorLineNumbers,
  setEditorSpellCheck,
  setEditorTypewriter,
  setEditorThemeConfig,
  setEditorLocale,
  setMermaidPreviewSettings,
  applyEditorVim,
  loadVimExtension,
  type EditorSurfaceKind,
  type EditorSaveState,
  type EditorSelectionInfo,
  type MarkdownDocumentSession,
  type SessionEditorViewHandle,
  type EditorScrollAnchor,
  type EditorView,
  type LinkNavigator,
  type WorkspaceImageProvider,
  type WorkspaceAssetEntry
} from '@nexus/editor';
import { mermaidPreviewPreference, settings } from '../platform';

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
  /**
   * 粘贴图片时的落盘钩子。返回要插进文档的 Markdown 片段，`null` 表示不处理。
   *
   * 落盘是宿主的职责：编辑器包不认识 IPC。宿主在这里决定文件写在哪、
   * 以及引用写成什么形状。
   */
  onPasteFiles?: (files: readonly File[]) => Promise<string | null>;
  /**
   * 工作区图片列表，点图片就地编辑时浮出。缺省表示不提供「选一张」入口 ——
   * 图片照样就地揭示，地址直接手打。
   */
  workspaceImages?: WorkspaceImageProvider;
  /**
   * 工作区资源清单，供 `![[…]]` 判断「候选路径存在吗」。
   *
   * 与 `documentDirectory` 一样**建视图时传一次、变化时再推**：清单跟着索引走，
   * 而索引会在拖入文件、重命名之后刷新。
   */
  workspaceAssets?: readonly WorkspaceAssetEntry[];
  extensionHost?: import('@nexus/editor').ExtensionHost;
  theme?: 'light' | 'dark';
  locale?: string;
  onChange?: (value: string) => void;
  onSelectionChange?: (selection: EditorSelectionInfo) => void;
  /**
   * 视图建好 / 销毁时回调，给宿主一个**显式的 view 引用**。
   *
   * 为什么不能靠 `window.nexusActiveView`：那个全局没有变化通知，而 view 会在切 surface
   * （Source ↔ Visual）时重建。需要 view 来做滚动相关计算的宿主（大纲的「当前在第几节」）
   * 得知道它什么时候换了一个。
   */
  onViewReady?: (view: EditorView | null) => void;
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
  onPasteFiles,
  workspaceImages,
  workspaceAssets,
  extensionHost,
  theme,
  locale,
  onChange,
  onSelectionChange,
  onViewReady,
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

  // 落盘钩子同理：它要读当前文档的路径与当前设置，而 EditorView 只在 session/surface
  // 变化时重建。包一层 ref 转发，粘贴发生时用的永远是最新那一个回调。
  const onPasteFilesRef = useRef(onPasteFiles);
  onPasteFilesRef.current = onPasteFiles;

  // 图片列表同理：它按当前文档目录算相对路径，而 EditorView 只在 session/surface
  // 变化时重建。包一层 ref 转发，打开选择器时用的永远是最新那一个。
  const workspaceImagesRef = useRef(workspaceImages);
  workspaceImagesRef.current = workspaceImages;

  const onViewReadyRef = useRef(onViewReady);
  onViewReadyRef.current = onViewReady;

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
      workspaceAssets,
      linkNavigator: (request) => linkNavigatorRef.current?.(request),
      onPasteFiles: (files) => onPasteFilesRef.current?.(files) ?? Promise.resolve(null),
      // **有才传**：`undefined` 就是「这个宿主不提供选图入口」（轻量模式没有工作区），
      // 编辑器据此不浮面板。传一个恒返回 `[]` 的提供者会让轻量模式弹出一句
      // 「这个工作区里还没有图片」——那里根本没有工作区。
      ...(workspaceImages ? { workspaceImages: () => workspaceImagesRef.current?.() ?? [] } : {}),
      extensionHost,
      theme,
      locale,
      lineNumbers: settings.get('editor.lineNumbers'),
      spellCheck: settings.get('editor.spellCheck'),
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
    onViewReadyRef.current?.(handle.view);
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
      // 与上面那行 `nexusActiveView` 的清理同一个位置、同一个理由：
      // 留着已销毁的 view，宿主下一次读它就会抛。
      onViewReadyRef.current?.(null);
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

  // 行号槽。**唯一一个走 CodeMirror compartment 的外观项** —— 其余（字号、行高、内容宽度、
  // 代码块行号、表格列宽）都是 CSS 变量。判据：`lineNumbers()` 会建一个 gutter DOM 与一块宽度，
  // 只把它藏起来那截宽度还在，正文与左边框之间会空一条。
  useEffect(() => {
    const apply = () => {
      if (handleRef.current) {
        setEditorLineNumbers(handleRef.current.view, settings.get('editor.lineNumbers'));
      }
    };
    apply();
    return settings.subscribe('editor.lineNumbers', apply);
  }, []);

  // 拼写检查。与行号同一个形状，但走 `contentAttributes` 而不是 gutter。
  useEffect(() => {
    const apply = () => {
      if (handleRef.current) {
        setEditorSpellCheck(handleRef.current.view, settings.get('editor.spellCheck'));
      }
    };
    apply();
    return settings.subscribe('editor.spellCheck', apply);
  }, []);

  /**
   * 打字机模式与 Vim 键位。
   *
   * 这两项**没有构造参数**，只能在视图建好之后装上 —— 前者的 `ViewPlugin` 拿不到构造期的
   * view，后者的扩展是异步 `import()` 来的。所以这个 effect 的依赖必须与上面那个挂载 effect
   * 一致（切 session / 切 surface 会重建视图），否则新视图上这两项会静默失效。
   *
   * vim 那条还多两层竞态要挡，都写在 `applyVim` 里。
   */
  useEffect(() => {
    let cancelled = false;

    const applyTypewriter = () => {
      if (handleRef.current) {
        setEditorTypewriter(handleRef.current.view, settings.get('editor.typewriterMode'));
      }
    };
    applyTypewriter();

    const applyVim = async () => {
      const view = handleRef.current?.view;
      if (!view) return;
      if (!settings.get('editor.vimKeybindings')) {
        applyEditorVim(view, null);
        return;
      }

      const extension = await loadVimExtension();
      // 等 import 的这段时间里可能发生两件事，判据不同、都要挡：
      // ① 视图被销毁或换了一个（切 surface / 关标签页）—— 对旧 view dispatch 会抛；
      // ② 用户把开关又关掉了 —— 不重读一次设置，就会把它重新装回去。
      if (cancelled || handleRef.current?.view !== view) return;
      applyEditorVim(view, settings.get('editor.vimKeybindings') ? extension : null);
    };
    void applyVim().catch((error: unknown) => {
      // 加载失败（chunk 没打出来、被 CSP 挡住）不该把编辑器搞崩：开关停在「没生效」，
      // 并在控制台留一句 —— 静默失败会让用户反复拨那个开关。
      console.warn('[Nexus] Vim 扩展加载失败:', error);
    });

    const unsubscribers = [
      settings.subscribe('editor.typewriterMode', applyTypewriter),
      settings.subscribe('editor.vimKeybindings', () => {
        void applyVim().catch((error: unknown) => {
          console.warn('[Nexus] Vim 扩展加载失败:', error);
        });
      })
    ];
    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [session, surfaceId, surfaceKind]);

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

  // 资源清单同理：索引刷新后要重新推给视图，否则刚拖进来的图片会一直停在占位符上
  // （清单是解析嵌入时的存在性依据，缺了它那一档就落回文档目录兜底）。
  const prevAssetsRef = useRef(workspaceAssets);
  useEffect(() => {
    if (prevAssetsRef.current !== workspaceAssets) {
      prevAssetsRef.current = workspaceAssets;
      if (handleRef.current) {
        setWorkspaceAssets(handleRef.current.view, workspaceAssets ?? []);
      }
    }
  }, [workspaceAssets]);

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
