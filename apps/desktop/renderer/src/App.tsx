import React, {
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore
} from 'react';
import type { FileDocument, Unsubscribe, ViewerDocumentType } from '@nexus/core';
import { countDocumentCharacters, isViewerDocumentType, parsePageAnchor } from '@nexus/core';
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
import { DarkIcon, LightIcon } from './components/theme-icons.js';
import { formatShortcut, matchesShortcut } from '@nexus/command';
import { DEFAULT_SHORTCUTS, REDO_SHORTCUT, resolveShortcut } from './keybindings.js';
import { commandRegistry, mermaidPreviewPreference, settings } from './platform.js';
import { useTheme, useLocale, useSettingValue, useKeybindingTable } from './hooks.js';
import { CommandPalette } from './CommandPalette.js';
import { WorkspaceStore } from './workspace/store.js';
import { TabBar } from './workspace/TabBar.js';
import { WorkspaceSidebar } from './workspace/WorkspaceSidebar.js';
import { OutlinePanel } from './workspace/OutlinePanel.js';
import { SearchPanel } from './workspace/SearchPanel.js';
import { PluginsPanel } from './workspace/PluginsPanel.js';
import { TagsPanel } from './workspace/TagsPanel.js';
import { GraphPanel } from './workspace/GraphPanel.js';
import { HistoryPanel } from './workspace/HistoryPanel.js';
import { QuickOpen } from './workspace/QuickOpen.js';
import { resolveWikiLink } from './workspace/wikilink.js';
import { classifyOpenTarget } from './workspace/open-target.js';
import { ViewerRendererRegistry } from './viewer/registry.js';
import { ViewerSurface } from './viewer/ViewerSurface.js';
import { PANEL_DEFAULT_WIDTH, clampPanelWidth } from './workspace/panel-width.js';
import { ActivityBar } from './shell/ActivityBar.js';
import {
  INITIAL_ACTIVITY_STATE,
  toggleActivity,
  type ActivityId
} from './shell/activity-bar-state.js';
import { projectMenuItems } from './settings/registry.js';

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

/** 太阳 / 月亮在 `components/theme-icons.tsx` —— 设置页的模式卡片也要画它们。 */

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

/** 取路径最后一段（文件名）。同时兼容 `/` 与 `\` —— 工作区路径可能来自任一侧。 */
function getFileName(filePath: string | null): string {
  if (!filePath) return '';
  return filePath.replace(/^.*[\\/]/, '');
}

/**
 * 菜单项上显示的快捷键文案。**每次调用现读**当前生效表，所以取消绑定的项会当场变成
 * `undefined`（菜单不画那一格），不需要调用方自己判空。
 */
function shortcutLabel(commandId: string): string | undefined {
  const spec = resolveShortcut(commandId);
  return spec ? formatShortcut(spec) : undefined;
}

export const App: React.FC = () => {
  const { resolvedTheme, themeChoice, setTheme, modeSwitchable } = useTheme();
  const { locale, setLocale, t } = useLocale();
  const [isCommandPaletteOpen, setCommandPaletteOpen] = useState(false);

  /**
   * 打开设置。设置是**独立窗口**（主进程按 `?window=settings` 建），不是主窗口里的一个视图 ——
   * 主进程侧是单例，重复点只会把已开着的那个还原并聚焦，不会开出第二个。
   *
   * 三个入口（命令面板 `Mod-,` / 菜单「首选项」/ 活动栏齿轮）共用这一个回调，
   * 免得「有的入口开窗口、有的入口还在切视图」。
   */
  const openSettingsWindow = useCallback(() => {
    void window.nexus?.openSettingsWindow?.();
  }, []);

  // Mermaid「点击图表显示源码」偏好。菜单的勾选状态必须与实际一致，
  // 所以订阅偏好变化 —— 别的入口改了也能同步过来。
  const [mermaidClickToReveal, setMermaidClickToReveal] = useState(
    mermaidPreviewPreference.get()
  );
  useEffect(() => mermaidPreviewPreference.subscribe(setMermaidClickToReveal), []);

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
   * 权威值在 `SettingsStore`（`editor.panelWidth`）而不是组件 state —— 设置窗口要能改它，
   * 而跨窗口同步走的就是 store 的广播（`platform.ts` 的 `resyncFromStorage`）。组件里这份是
   * **拖拽中的临时值**：拖拽时不写盘（每移动一像素落一次盘，拖一下能写几百次），松手才同步回去。
   */
  const [panelWidth, setPanelWidth] = useState(() => settings.get('editor.panelWidth'));
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
      // 只在真的不同时写：`settings.set` 每次都落盘并广播，而这个 effect 在 panelWidth 每次
      // 变化后都会跑 —— 不判一下，「从别的窗口同步进来的值」会被原样再广播出去一轮。
      if (settings.get('editor.panelWidth') !== panelWidth) {
        settings.set('editor.panelWidth', panelWidth);
      }
      return;
    }

    // 拖拽中给 body 加类：光标移出把手后仍是 col-resize，且不会选中沿途的文字
    document.body.classList.add('nexus-resizing');
    return () => {
      document.body.classList.remove('nexus-resizing');
    };
  }, [isResizing, panelWidth]);

  /** 设置窗口里改了宽度（或另一个窗口拖了把手）→ 主窗口跟上。 */
  useEffect(
    () =>
      settings.subscribe('editor.panelWidth', () => {
        setPanelWidth(settings.get('editor.panelWidth'));
      }),
    []
  );
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
  const savingContentRef = useRef<string | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 自动保存在设置里被关掉时，**把已经排上的那一次撤掉**。
   *
   * 只判断「要不要排新的」是不够的：用户改完字（计时器已排上）再去关自动保存，那一枪照样会响，
   * 表现是「明明关了还是写盘了」。关掉之后未保存的内容仍然算未保存 —— 状态栏照常标 dirty，
   * 保存改由 `Cmd+S` 与关闭窗口前的那一次承担。
   */
  useEffect(
    () =>
      settings.subscribe('general.autoSave', () => {
        if (settings.get('general.autoSave') || !debounceTimerRef.current) return;
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }),
    []
  );
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const unwatchRef = useRef<Unsubscribe | null>(null);

  /**
   * 工作区状态层：打开了哪些文档、哪一个是活动的。
   *
   * 它取代了此前散在这里的 `filePath` / `saveState` / `saveError` / `session` 四个
   * useState。那些是「当前文档」的投影 —— 多标签页之后必须由文档集合派生，
   * 各自再存一份必然会漂移，而漂移的症状是「标题栏显示 A 的路径、保存写的是 B 的内容」。
   *
   * P3-05 起它**也装只读文档**（`kind === 'viewer'`）：此前 pdf/docx/图片是这里
   * 另立的一个 `viewerDocument` useState，且刻意不进标签页。那样做的问题是
   * 「现在看的是哪个文档」有两个答案，而标签栏只认识其中一个 —— 于是标签栏
   * 永远不可能显示附件。见 `workspace/store.ts` 的 `DocumentKind`。
   */
  const storeRef = useRef<WorkspaceStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new WorkspaceStore();
  }
  const store = storeRef.current;

  /**
   * Viewer 渲染器登记表。
   *
   * 与 `ExtensionHost` 同一套懒加载形状（§7 第 9 条）：这里只登记「哪个类型归谁」，
   * 渲染器包本体要等真的渲染第一个该类型文档才 import。三个类型（图片 / PDF / DOCX）
   * 在 P3-08 全部登记完毕，本文件从此不再需要改。
   */
  const viewerRegistryRef = useRef<ViewerRendererRegistry | null>(null);
  if (viewerRegistryRef.current === null) {
    const registry = new ViewerRendererRegistry();
    // 图片：第一个真实渲染器（P3-06）。登记是急切的、加载是懒的 ——
    // `load` 必须写成 `() => import(...)`，先在别处 import 再包一层会让
    // 渲染器跟着入口块一起进主包，P1-06 换来的收益当场还回去。
    registry.registerLazy({
      type: 'image',
      load: () => import('./viewer/image/ImageRenderer.js')
    });
    // PDF：P3-07。这个 import 是**唯一**能把 pdfjs-dist（约 350KB min 后）
    // 拉下来的路径，所以「打开 Markdown 的工作区不下载 pdfjs」这条不变量
    // 完全取决于它保持成动态 import（§9 验收第 6 条）。
    registry.registerLazy({
      type: 'pdf',
      load: () => import('./viewer/pdf/PdfRenderer.js')
    });
    // DOCX：P3-08。同上 —— mammoth 加上它的依赖（jszip / @xmldom/xmldom）
    // 是三个渲染器里最重的一个，只有真的打开 DOCX 才该下载它。
    registry.registerLazy({
      type: 'docx',
      load: () => import('./viewer/docx/DocxRenderer.js')
    });
    viewerRegistryRef.current = registry;
  }

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

  /**
   * 活动的可编辑文档。活动的是附件时为 null。
   *
   * 全文件那几十处 `session.xxx` 都靠它 —— 让它们各自判 `kind` 会变成几十个
   * 可能漏改的判断点，而漏掉一处就是「往只读文档里写」。
   */
  const activeEditor = activeDocument?.kind === 'editor' ? activeDocument : null;
  const session = activeEditor?.session ?? fallbackSessionRef.current;
  const filePath = activeDocument?.filePath ?? null;
  const saveState = activeDocument?.saveState ?? 'clean';
  const saveError = activeDocument?.saveError ?? null;

  /** 状态栏字数的显隐。走 `useSettingValue` 而不是 `settings.get`：后者不会在改设置时重渲染。 */
  const showCharacterCount = useSettingValue('editor.wordCount');

  /**
   * 生效的快捷键表。**只为了拿到一个「改过绑定就变」的依赖** —— 菜单里的标签由模块级的
   * `shortcutLabel` 现读，键盘分发在事件里现读，两者都不需要这个值本身。少了它，在设置窗口
   * 改完绑定后菜单会一直显示旧组合键。
   */
  const keybindings = useKeybindingTable();

  /**
   * 状态栏字数。
   *
   * 订阅 session 而不是在 `handleContentChange` 里算：后者只在编辑器 `onChange` 时跑，
   * 而**打开文件、切标签、外部重载**都会换内容却不经过那条回调 —— 那些时刻数字会停在上一个
   * 文档的值上。session 的订阅覆盖所有内容变更来源，一处就够。
   */
  const [characterCount, setCharacterCount] = useState(0);
  useEffect(() => {
    const sync = () => setCharacterCount(countDocumentCharacters(session.getSnapshot().source));
    sync();
    return session.subscribe(sync);
  }, [session]);

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
      // 走 updateActiveEditor 而不是 updateActive：附件的保存态不该被改
      // （它是恒定的 `readonly`，改了就成了一条假的状态）。见 store 里那段说明。
      store.updateActiveEditor((document) => {
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
    // Viewer 渲染器的懒加载状态：E2E 用它证明「不打开附件就不下载渲染器包」。
    // 判据与上面那条同名同义（`requestedIds()`），两条懒加载不变量写法一致。
    (window as any).nexusViewerRenderers = viewerRegistryRef.current;
    // 文档集合（含只读附件）：E2E 需要证明「附件进的是同一份标签页集合」，
    // 而 DOM 上的标签栏在只有一个文档时是不渲染的。
    (window as any).nexusWorkspace = store;
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

    // 附件没有可写内容：活动的是 PDF / 图片时 Ctrl+S 什么都不该发生。
    //
    // 不能只靠菜单项的 `disabled` —— 快捷键走的是命令注册表，绕过菜单。
    // 少了这道守卫的后果很具体：`saveState === 'readonly'` 会走 `performSaveAs`，
    // 于是「在 PDF 上按 Ctrl+S」弹出一个保存对话框，把一份空文档存成 .md。
    if (!activeEditor) {
      return Promise.resolve(false);
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
        savingContentRef.current = currentSource;
        try {
          await window.nexus.writeFile(filePath, currentSource);
        } finally {
          savingContentRef.current = null;
        }

        // 写入期间可能发生新编辑；此时旧快照已落盘，但不能把当前文档标记为已保存。
        const sourceStillCurrent = session.getSnapshot().source === currentSource;
        if (sourceStillCurrent) {
          initialContentRef.current = currentSource;
          updateSaveState('saved');
          setSaveError(null);
          // 保存会在覆盖前留一份历史（main 进程的 writeFile），历史面板的数据源因此变了。
          // 这里 bump 一次让它重读 —— 面板始终挂载、切 activity 不触发重读，
          // 否则保存那一刻产生的历史要等到用户下一次编辑才会出现。
          setDocumentRevision((previous) => previous + 1);
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
  }, [activeEditor, enqueueSave, filePath, performSaveAs, session, updateSaveState]);

  const saveAs = useCallback((): Promise<boolean> => {
    // 同 `saveFile`：附件没有「另存为」可言。
    if (!activeEditor) return Promise.resolve(false);
    return enqueueSave(() => performSaveAs(session.getSnapshot().source));
  }, [activeEditor, enqueueSave, performSaveAs, session]);

  /**
   * 把已打开的文件灌进工作区。系统对话框与链接跳转共用这一段，
   * 避免两条路径在 dirty / readOnly / 错误清理上出现分歧。
   *
   * 只处理**可编辑 Markdown**：调用方已经过 `classifyOpenTarget()`，
   * 附件走 `openViewerDocumentAt()`。
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
   * 打开一份只读附件。
   *
   * 只登记路径与类型，**不读内容** —— 内容怎么来是渲染器的事（P3-06 起走
   * `nexus-asset://`，见 §5.1）。在这里顺手读一遍会把 200MB 的 PDF 塞进
   * IPC 与 renderer 内存，而渲染器最终还是要按 Range 重新取一次。
   *
   * `page` 来自引用里的 `#page=` 锚点（P3-11）。同一份附件已经开着时它只换位置、
   * 不新建标签页 —— 那条规则在 store 里，这里只负责把值递进去。
   */
  const openViewerDocumentAt = useCallback(
    (targetPath: string, type: ViewerDocumentType, page?: number) => {
      store.openViewerDocument({ filePath: targetPath, type, page });
      // 附件不参与编辑，所以窗口不该处于「有未保存内容」的状态 ——
      // 否则关窗确认框会因为「刚才看了一眼 PDF」而弹出来。
      window.nexus?.setDirty?.(false);
    },
    [store]
  );

  /**
   * 按路径打开一个文件 —— **四条入口共用这一个判断点**：
   * 侧栏文件树、快速打开（Ctrl+P）、编辑器里的链接跳转、wikilink 解析出的附件。
   *
   * 分流本身在 `classifyOpenTarget()`（纯函数、有单测）。这里只负责把三种结果
   * 落到各自的动作上。原先这条逻辑散在两个函数里（`handleOpenWorkspaceFile`
   * 与 `openDocumentAt`），两者唯一的差别只是日志文案 —— 而「链接点进去能开、
   * 文件树点进去报不支持」正是从这种分叉里长出来的。
   *
   * `page` 是引用里的 `#page=` 锚点（P3-11），只对 viewer 分支有意义。
   */
  const handleOpenWorkspaceFile = useCallback(
    async (targetPath: string, page?: number): Promise<boolean> => {
      const target = classifyOpenTarget(targetPath);

      if (target.kind === 'unsupported') {
        // 白名单外：不静默失败。用户分不清「文件坏了」和「这个格式不做」时，
        // 下一步动作会完全不同（去修文件 vs 换个格式）。
        setLinkError(t('link.error.unsupportedTarget', { target: targetPath }));
        return false;
      }

      if (target.kind === 'viewer') {
        // `page` 只对 viewer 有意义（`#page=` 是引用 PDF 的位置），Markdown 分支忽略它。
        openViewerDocumentAt(target.path, target.type, page);
        setLinkError(null);
        return true;
      }

      if (!window.nexus?.openFile) return false;
      try {
        const fileDoc = await window.nexus.openFile(target.path);
        if (!fileDoc) return false;
        applyOpenedDocument(fileDoc);
        setLinkError(null);
        return true;
      } catch (err: unknown) {
        console.error('Failed to open workspace file:', err);
        // 失败必须可见，否则用户分不清"链接坏了"和"这个功能没做"。
        setLinkError(
          t('link.error.openFailed', {
            target: targetPath,
            reason: err instanceof Error ? err.message : String(err)
          })
        );
        return false;
      }
    },
    [applyOpenedDocument, openViewerDocumentAt, t]
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

  // Watch file for external modifications
  useEffect(() => {
    if (unwatchRef.current) {
      unwatchRef.current();
      unwatchRef.current = null;
    }

    // 只监听**可编辑文档**。
    //
    // `filePath` 现在对附件也非 null（附件是标签页，也有路径），但 `watchFile`
    // 走的是 `assertTextDocument` —— 对 PDF 调它只会拿到一个拒绝，而 `saveStateRef`
    // 与 `session` 也都是兜底值，那条回调没有任何正确行为可言。
    // 附件的「外部改动」由渲染器自己处理（P3-07 起：Range 请求本来就会重新读盘）。
    if (!activeEditor || !filePath || !window.nexus?.watchFile) {
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
          // 自身保存触发的 watcher 可能先于 IPC 完成返回。确认磁盘内容与本次保存
          // 的快照一致后忽略该事件，避免把 saving 瞬间误判为外部冲突。
          if (saveStateRef.current === 'saving' && savingContentRef.current !== null) {
            try {
              const freshContent = await window.nexus?.readFile?.(filePath);
              if (freshContent === savingContentRef.current) return;
            } catch (readErr) {
              console.error('Failed to verify file during save:', readErr);
              setSaveError(String(readErr));
              updateSaveState('error');
              return;
            }
            updateSaveState('external-changed');
            return;
          }

          // Only auto-reload if document is completely clean and saved
          const isDocClean =
            (saveStateRef.current === 'saved' || saveStateRef.current === 'clean' || saveStateRef.current === 'readonly') &&
            initialContentRef.current === session.getSnapshot().source;

          // 关掉自动重载后**一律提示**，干净文档也提示 —— 否则「始终提示」在干净文档上
          // 等于没生效（那时它和 smart 走的是同一条路）。
          const autoReload = settings.get('general.externalChange') === 'smart';

          if (autoReload && isDocClean && window.nexus?.readFile) {
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
          } else {
            // 有本地未持久化内容（保存中 / 保存失败 / 已 dirty）时也走这里：必须进入冲突保护路径。
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
  }, [activeEditor, filePath, session, updateSaveState]);

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

      // viewer 模式：PDF / DOCX / 图片等非 Markdown 文档。
      // 只读查看，不进可编辑会话 —— 这几类文档没有「source 与投影」的二分。
      // P3-05 起它开成**一个正常的标签页**（`kind: 'viewer'`），只是不读内容：
      // 真正的渲染器由 `ViewerSurface` 按类型查表决定，P3-06 起逐个接入。
      if (ctx.mode === 'viewer' && ctx.filePath && isViewerDocumentType(ctx.documentType)) {
        setWorkspaceRoot(null);
        openViewerDocumentAt(ctx.filePath, ctx.documentType);
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
  }, [openViewerDocumentAt, store]);

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
      if (filePath && settings.get('general.autoSave')) {
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
        }
        // 延迟**读时取值**：改设置后下一次输入就按新值走，不需要重挂这个回调。
        debounceTimerRef.current = setTimeout(() => {
          saveFile({ immediate: false });
        }, settings.get('general.autoSaveDelay'));
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
   *
   * **只在刚关掉的是可编辑文档时补**：补的目的是让编辑器有个落脚点，而关掉一份
   * PDF 之后凭空冒出一个「未命名.md」是凭空造状态 —— 用户刚做的事是「关掉预览」，
   * 得到的却是一份新文档。关掉附件后如果标签页空了，如实显示空态即可。
   */
  const closeDocumentAndEnsureEditor = useCallback(
    (id: string) => {
      const closing = store.getDocuments().find((document) => document.id === id);
      store.closeDocument(id);

      if (closing?.kind === 'editor' && store.isEmpty) {
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

      // 走得到这里的必然是**可编辑文档**：附件的 saveState 恒为 `readonly`，
      // 上面那个分支已经把它送走了。这里的收窄是给类型看的，同时也是断言 ——
      // 若哪天附件有了别的保存态，会在这里被挡住而不是静默存一份空内容。
      if (document.kind !== 'editor') {
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
   *                          （可带 `#page=` 页码锚点，P3-11 的引用就是这种）
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

      void handleOpenWorkspaceFile(resolved, parsePageAnchor(target) ?? undefined);
      return true;
    },
    [filePath, handleOpenWorkspaceFile, t]
  );

  /**
   * 宿主命令的注册与键盘分发。
   *
   * `shortcut` 字段取 `DEFAULT_SHORTCUTS` 而不是写字面量：**生效值由覆盖表决定**
   * （`resolveShortcut`），命令上带的那份只是默认值。两处各写一个字面量的话，改默认值时
   * 设置页显示的和实际按下去生效的会分叉。
   *
   * 分发循环**每次事件现读** `resolveShortcut`，不把结果缓进闭包 —— 否则在设置窗口改完绑定
   * 之后，主窗口要等到这个 effect 因别的原因重跑才会用上新值。
   */
  useEffect(() => {
    const unsubs = [
      commandRegistry.registerCommand({
        id: 'new-file',
        titleKey: 'cmd.newFile',
        shortcut: DEFAULT_SHORTCUTS['new-file'],
        execute: () => void handleNewFile()
      }),
      commandRegistry.registerCommand({
        id: 'open-file',
        titleKey: 'cmd.openFile',
        shortcut: DEFAULT_SHORTCUTS['open-file'],
        execute: handleOpenFile
      }),
      commandRegistry.registerCommand({
        id: 'save',
        titleKey: 'cmd.save',
        shortcut: DEFAULT_SHORTCUTS['save'],
        execute: () => saveFile({ immediate: true })
      }),
      commandRegistry.registerCommand({
        id: 'save-as',
        titleKey: 'cmd.saveAs',
        shortcut: DEFAULT_SHORTCUTS['save-as'],
        execute: saveAs
      }),
      commandRegistry.registerCommand({
        id: 'toggle-theme',
        titleKey: 'cmd.toggleTheme',
        // 保留预设，只翻模式 —— 当前渲染出浅色就切深色。`choiceWithMode` 在切不动时是恒等，
        // 这里先挡一道是为了让命令面板里那条不再是个「点了没反应」的项。
        execute: () => {
          if (!modeSwitchable) return;
          setTheme(resolvedTheme.type === 'light' ? 'dark' : 'light');
        }
      }),
      commandRegistry.registerCommand({
        id: 'toggle-locale',
        titleKey: 'cmd.toggleLocale',
        execute: () => setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN')
      }),
      commandRegistry.registerCommand({
        id: 'toggle-surface',
        titleKey: 'cmd.toggleSurface',
        shortcut: DEFAULT_SHORTCUTS['toggle-surface'],
        execute: () => setSurfaceKind((prev) => (prev === 'source' ? 'visual' : 'source'))
      }),
      commandRegistry.registerCommand({
        id: 'find',
        titleKey: 'cmd.find',
        shortcut: DEFAULT_SHORTCUTS['find'],
        execute: () => {
          const activeView = (window as unknown as { nexusActiveView?: EditorView }).nexusActiveView;
          if (activeView) openSearchPanel(activeView);
        }
      }),
      commandRegistry.registerCommand({
        id: 'replace',
        titleKey: 'cmd.replace',
        shortcut: DEFAULT_SHORTCUTS['replace'],
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
      }),
      /**
       * 下面三条原本是 `handleKeyDown` 里的硬编码分支。提升成命令是为了让它们**可重映射** ——
       * 一个改不了的组合键留在「可重映射动作表」外面，用户只会觉得那张表在骗人。
       */
      commandRegistry.registerCommand({
        id: 'palette.open',
        titleKey: 'cmd.palette',
        shortcut: DEFAULT_SHORTCUTS['palette.open'],
        execute: () => setCommandPaletteOpen(true)
      }),
      // 快速打开与命令面板分开：一个是「找文件」，一个是「找命令」，
      // 混成一个入口会让两个都很慢。
      commandRegistry.registerCommand({
        id: 'quick-open',
        titleKey: 'quickopen.title',
        shortcut: DEFAULT_SHORTCUTS['quick-open'],
        execute: () => setQuickOpenOpen(true)
      }),
      commandRegistry.registerCommand({
        id: 'window.close',
        titleKey: 'cmd.closeFile',
        shortcut: DEFAULT_SHORTCUTS['window.close'],
        execute: () => {
          if (window.nexus?.closeWindow) window.nexus.closeWindow();
        }
      }),
      commandRegistry.registerCommand({
        id: 'settings.open',
        titleKey: 'cmd.openSettings',
        shortcut: DEFAULT_SHORTCUTS['settings.open'],
        execute: openSettingsWindow
      })
    ];

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      for (const cmd of commandRegistry.getCommands()) {
        const spec = resolveShortcut(cmd.id);
        if (spec && matchesShortcut(e, spec)) {
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
  }, [handleOpenFile, saveAs, saveFile, resolvedTheme, setTheme, modeSwitchable, locale, setLocale, openSettingsWindow]);

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
            shortcut: shortcutLabel('new-file'),
            onSelect: () => void handleNewFile()
          },
          {
            label: t('cmd.openFile'),
            shortcut: shortcutLabel('open-file'),
            onSelect: () => void handleOpenFile()
          },
          {
            label: t('cmd.save'),
            shortcut: shortcutLabel('save'),
            // 附件是只读的，没有「保存」可言。禁用而不是留着点了没反应 ——
            // 后者会让用户以为保存失败了。快捷键侧由 `saveFile` 自己守。
            disabled: !activeEditor,
            onSelect: () => void saveFile({ immediate: true })
          },
          {
            label: t('cmd.saveAs'),
            shortcut: shortcutLabel('save-as'),
            disabled: !activeEditor,
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
            shortcut: shortcutLabel('window.close'),
            onSelect: () => {
              if (window.nexus?.closeWindow) window.nexus.closeWindow();
            }
          }
        ]
      },
      {
        id: 'edit',
        label: t('menu.edit'),
        // 这一组全部作用于**编辑器的 session**（选区、撤销栈）。活动的是附件时
        // 它们操作的是兜底 session —— 不会崩，但也没有任何可见效果。
        // 禁用是如实表达「这里没有可编辑的东西」；附件自己的复制（PDF 选区）
        // 由渲染器处理，不走这一组。
        //
        // **这一组的快捷键是写死的**，不走 `shortcutLabel` —— 它们不经过宿主的 keydown 分发
        // （撤销/重做归 CodeMirror 的 keymap，剪贴板归操作系统），所以改不了。设置页的
        // 「固定键」清单列的正是这批（见 `keybindings.ts` 的 `FIXED_SHORTCUTS`）。
        items: [
          {
            label: t('cmd.undo'),
            shortcut: formatShortcut('Mod-Z'),
            disabled: !activeEditor,
            onSelect: handleUndo
          },
          {
            label: t('cmd.redo'),
            // 平台不同：Apple 是 `Mod-Shift-Z`，其余平台是 `Mod-Y`（`historyKeymap` 就这么分）。
            // 原来写死 `Mod-Shift-Z`，在 Windows 上显示的是一个按下去不生效的组合键。
            shortcut: formatShortcut(REDO_SHORTCUT),
            disabled: !activeEditor,
            onSelect: handleRedo
          },
          {
            label: t('cmd.copy'),
            shortcut: formatShortcut('Mod-C'),
            disabled: !activeEditor,
            onSelect: handleCopy
          },
          {
            label: t('cmd.cut'),
            shortcut: formatShortcut('Mod-X'),
            disabled: !activeEditor,
            onSelect: handleCut
          },
          {
            label: t('cmd.paste'),
            shortcut: formatShortcut('Mod-V'),
            disabled: !activeEditor,
            onSelect: () => void handlePaste()
          },
          {
            label: t('cmd.selectAll'),
            shortcut: formatShortcut('Mod-A'),
            disabled: !activeEditor,
            onSelect: handleSelectAll
          }
        ]
      },
      {
        id: 'appearance',
        label: t('menu.preferences'),
        // 菜单由注册表投影，装的是**所有** `menu: true` 的字段（跨 Appearance / General /
        // Editor 三个分组）。按分组过滤会让语言与 mermaid 从菜单里消失 —— 那是功能回退，
        // 所以标题也跟着从「外观」改成「首选项」。
        items: projectMenuItems({ t, onOpenSettings: openSettingsWindow })
      }
    ],
    [
      t,
      activeEditor,
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
      resolvedTheme.type,
      // 投影在渲染期读 accessor，值变了必须重新投影 —— 否则菜单勾选状态会停在旧值上。
      themeChoice,
      setTheme,
      locale,
      setLocale,
      mermaidClickToReveal,
      openSettingsWindow,
      // 改过快捷键之后菜单上的标签要跟着换。`keybindings` 的身份只在覆盖项真变了时才变。
      keybindings
    ]
  );

  /** 当前上下文里「正在看的东西」：lightweight 是文件，workspace 是目录。 */
  const activePath = filePath ?? workspaceRoot;
  const fileName = activePath ? activePath.replace(/^.*[\\/]/, '') : 'Untitled.md';

  /**
   * 状态栏右侧的模式标签。
   *
   * 打开附件时必须如实显示它的类型 —— 在 PDF 标签页上写着「Markdown」是直接
   * 骗人，而且用户会据此判断「这个文件到底被正确识别了没有」。
   * `Workspace` / `Markdown` 两个专有名词保持不翻译（既有行为）。
   */
  const formatLabel = workspaceRoot
    ? 'Workspace'
    : activeDocument && activeDocument.type !== 'markdown'
      ? t(`document.type.${activeDocument.type}`)
      : 'Markdown';

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
            onClick={() => setTheme(resolvedTheme.type === 'light' ? 'dark' : 'light')}
            // 用户主题与单变体预设没有另一边可切 —— 禁用比按下去没反应清楚。
            disabled={!modeSwitchable}
            aria-label={t('cmd.toggleTheme')}
            title={t('cmd.toggleTheme')}
          >
            <span aria-hidden="true">{resolvedTheme.type === 'light' ? DarkIcon : LightIcon}</span>
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
      {/* 只对**可编辑文档**显示：附件的 saveState 也是 `readonly`，但它不是
          「只读打开的 Markdown，可以另存为」—— 对一份 PDF 说「Changes cannot be
          saved in place — use Save As」是彻头彻尾的误导（那个按钮在附件上
          也已经被 `saveAs` 守成了空操作）。 */}
      {activeEditor && saveState === 'readonly' && (
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
          onOpenSettings={openSettingsWindow}
        />
      )}

      {status === 'ready' && workspaceRoot && (
        <div
          className={`nexus-activity-panel${
            activity.panelOpen ? ' nexus-activity-panel-open' : ''
          }`}
          style={{ '--nx-panel-width': `${panelWidth}px` } as React.CSSProperties}
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
              activity.activeId === 'graph' ? '' : ' nexus-panel-slot-hidden'
            }`}
          >
            {/* 图谱来自索引（磁盘内容），编辑后用 documentRevision 触发重读 */}
            <GraphPanel
              activeFilePath={filePath}
              onOpenFile={handleOpenWorkspaceFile}
              revision={documentRevision}
            />
          </div>
          <div
            className={`nexus-panel-slot${
              activity.activeId === 'history' ? '' : ' nexus-panel-slot-hidden'
            }`}
          >
            {/* 历史面板要拿当前内容做对比，所以把 session 也传进去 */}
            <HistoryPanel
              filePath={filePath}
              session={activeDocument ? session : null}
              onRestored={handleIndexed}
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
      {/* 只读文档：交给 Viewer 外壳按类型查表。
          这里**不认识任何格式** —— 「png 用什么渲染」由登记表回答，
          所以 P3-06/07/08 各自注册一个渲染器即可，这一段不用再改。 */}
      {status === 'ready' && activeDocument?.kind === 'viewer' && (
        <ViewerSurface
          document={{
            path: activeDocument.filePath,
            name: getFileName(activeDocument.filePath),
            type: activeDocument.type,
            page: activeDocument.viewerPage,
            // 有工作区时引用相对工作区根（蓝图 §11.4），轻量模式下退回文档所在目录 ——
            // 那时没有工作区可言，相对同目录是唯一能点开的写法。
            citationBase:
              workspaceRoot ??
              getDocumentDirectory(activeDocument.filePath) ??
              activeDocument.filePath
          }}
          registry={viewerRegistryRef.current}
        />
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
      {status === 'ready' && activeDocument?.kind === 'editor' && (
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
            theme={resolvedTheme.type}
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
          {showCharacterCount && (
            <span className="status-metric" data-status-metric="character-count">
              {t('status.characterCount', { count: String(characterCount) })}
            </span>
          )}
          {/* 专有名词（Workspace / Markdown）不翻译；附件类型由 formatLabel 给出 */}
          <span className="status-metric status-format">{formatLabel}</span>
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
