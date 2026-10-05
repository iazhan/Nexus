import React, {
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore
} from 'react';
import type { AppMode, FileDocument, IndexedDocument, Unsubscribe, ViewerDocumentType } from '@nexus/core';
import {
  attachmentExtension,
  buildDocumentLink,
  countDocumentCharacters,
  documentTitleOf,
  expandAttachmentName,
  formatAttachmentReference,
  isViewerDocumentType,
  missingTargetToWorkspacePath,
  parseLinkFormat,
  parsePageAnchor,
  relativePathFrom,
  resolveWikiLink,
  scanTags
} from '@nexus/core';
import {
  MarkdownDocumentSession,
  openSearchPanel,
  handleVisualModB,
  handleVisualModI,
  handleVisualModStrike,
  handleVisualInlineCode,
  handleVisualClearFormatting,
  handleVisualBlockFormat,
  resolveRelativePath,
  revealHeadingAnchor,
  revealHeadingAt,
  ExtensionHost,
  MATH_EXTENSION_ID,
  MERMAID_EXTENSION_ID,
  isMathMarker,
  isMermaidMarker,
  createFormattingAnalyzer,
  createBlockFormatAnalyzer,
  createInsertDocumentLinkTransaction,
  EMPTY_FORMATTING_STATE,
  EMPTY_BLOCK_FORMAT_STATE,
  type EditorView,
  type EditorSurfaceKind,
  type EditorSaveState,
  type EditorSelectionInfo,
  type LinkNavigator,
  type WorkspaceImageProvider,
  type WorkspaceAssetEntry
} from '@nexus/editor';
import { EditorSurface } from './editor/SourceEditor.js';
import { EditorToolbar } from './editor/EditorToolbar.js';
import {
  SELECTION_ACTION_SPECS,
  SelectionToolbar,
  useSelectionAnchor,
  type SelectionAction
} from './editor/SelectionToolbar.js';
import { BLOCK_FORMAT_SPECS, blockFormatMenuItems } from './editor/block-format-specs.js';
import { createSlashCommandHost } from './editor/slash-commands.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { MenuBar, type MenuBarMenu } from './MenuBar.js';
import { WindowControls } from './WindowControls.js';
import { formatShortcut, matchesShortcut } from '@nexus/command';
import { DEFAULT_SHORTCUTS, REDO_SHORTCUT, resolveShortcut } from './keybindings.js';
import { commandRegistry, mermaidPreviewPreference, settings } from './platform.js';
import { useTheme, useLocale, useSettingValue, useKeybindingTable } from './hooks.js';
import { CommandPalette } from './CommandPalette.js';
import { ContextMenu, type ContextMenuItem } from './components/ContextMenu.js';
import type { FileTreeNode } from './workspace/tree.js';
import { parseDeleteMode } from './settings/preference-specs.js';
import type { RenameFileResult } from '../../ipc/channels.js';
import { WorkspaceStore, hasUnsavedChanges } from './workspace/store.js';
import { TabBar } from './workspace/TabBar.js';
import { WorkspaceSidebar } from './workspace/WorkspaceSidebar.js';
import { WorkspaceEmpty } from './workspace/WorkspaceEmpty.js';
import { RenamePreview } from './workspace/RenamePreview.js';
import { describeSkips, unsavedPaths } from './workspace/rename.js';
import { linkFailureKey } from './workspace/link-failure.js';
import { buildWorkspaceImageOptions } from './workspace/image-picker.js';
import { buildWorkspaceAssetEntries } from './workspace/workspace-assets.js';
import { OutlinePanel } from './workspace/OutlinePanel.js';
import { SearchPanel } from './workspace/SearchPanel.js';
import { PluginsPanel } from './workspace/PluginsPanel.js';
import { TagsPanel } from './workspace/TagsPanel.js';
import { GraphPanel } from './workspace/GraphPanel.js';
import { HistoryPanel } from './workspace/HistoryPanel.js';
import { QuickOpen } from './workspace/QuickOpen.js';
import { InsertLinkPalette } from './workspace/InsertLinkPalette.js';
import { classifyOpenTarget } from './workspace/open-target.js';
import { ViewerRendererRegistry } from './viewer/registry.js';
import { ViewerSurface } from './viewer/ViewerSurface.js';
import { UpdateNoticeBar } from './update/UpdateNoticeBar.js';
import { PANEL_DEFAULT_WIDTH, clampPanelWidth } from './workspace/panel-width.js';
import {
  CHROME_VISIBILITY,
  disabledMembers,
  isCapabilityDisabled,
  STATUS_BAR_METRICS
} from './settings/preference-specs.js';
import { ActivityBar } from './shell/ActivityBar.js';
import {
  INITIAL_ACTIVITY_STATE,
  showActivity,
  toggleActivity,
  type ActivityId
} from './shell/activity-bar-state.js';
import { projectMenuItems } from './settings/registry.js';
import { getDocumentDirectory, getFileName, newDocumentDirectory } from './paths.js';

export type ShellStatus = 'loading' | 'ready' | 'error';

/** 太阳 / 月亮在 `components/theme-icons.tsx` —— 设置页的模式卡片也要画它们。
 *  `CodeIcon` / `EyeIcon` 搬到了 `components/editor-icons.tsx`：编辑器工具栏的
 *  surface 切换按钮也要画它们，两处各留一份迟早漂成两个样子。 */

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

/**
 * 内置能力的启停谓词，两个注册表共用。
 *
 * **每次查表时现读设置**（`settings.get` 是内存读），所以改设置立即生效 ——
 * 不需要重建注册表、不需要重启。这也正是注册表把谓词当参数收下、而不是在装配时筛的原因。
 *
 * 只有这一处把「设置里的存档串」翻成「这个 id 启用吗」：两个注册表各写一遍的话，
 * 迟早有一处漏掉 `disabledMembers` 的整词比对（`pdf` 会匹配上 `pdf-text`）。
 */
function capabilityEnabled(id: string): boolean {
  return !isCapabilityDisabled(settings.get('plugins.disabled'), id);
}

/**
 * 菜单项上显示的快捷键文案。**每次调用现读**当前生效表，所以取消绑定的项会当场变成
 * `undefined`（菜单不画那一格），不需要调用方自己判空。
 */
function shortcutLabel(commandId: string): string | undefined {
  const spec = resolveShortcut(commandId);
  return spec ? formatShortcut(spec) : undefined;
}

/**
 * 「复制链接」回执停留多久。
 *
 * 4 秒：够读完一串 `[dma](../notes/dma.md)`，又不至于久到下一次复制时还挂着上一条
 * （连续复制同一个文件时，`setCopyLinkNotice` 收到同一个字符串不会触发 effect，
 * 所以那条回执会按**第一次**的时间退场 —— 这是可接受的：用户已经看到了）。
 */
const COPY_LINK_NOTICE_MS = 4000;

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

  /**
   * 直接落到「插件」那一组。活动栏的插件面板是**只读状态视图**，管理动作在设置页 ——
   * 面板底部的跳转按钮走这一条（`?section=plugins`，见 `use-settings-section`）。
   *
   * 与上面那个分开写而不是给它加参数：那个是「打开设置」这个动作，被命令面板、菜单、
   * 活动栏齿轮三处共用；带参数的调用点只有这一处，混在一起会让三个入口各自决定落点。
   */
  const openPluginsSettings = useCallback(() => {
    void window.nexus?.openSettingsWindow?.('plugins');
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
   * 这次启动进来的模式。**只用于「还没定工作区根时该显示什么」这一个判断**，
   * 定下来之后就由 `workspaceRoot` / `activeDocument` 说了算。
   *
   * 为什么非要它：`workspaceRoot === null` 同时是「轻量模式打开一个文件」与
   * 「工作区模式还没选目录」的形状。只看 `workspaceRoot` 会把后者当成前者 ——
   * 而后者正是裸启动，退回一个空编辑器就是这次要修掉的行为。
   */
  const [launchMode, setLaunchMode] = useState<AppMode | null>(null);

  /**
   * 活动栏（最左图标列）的布局状态。纯会话内状态，不持久化 ——
   * 它是「这次看什么」，不是「文档是什么」，与 WorkspaceStore 各管一摊。
   */
  const [activity, setActivity] = useState(INITIAL_ACTIVITY_STATE);

  /**
   * 编辑器里 Ctrl+点击标签后，要求标签面板展开的那个标签。
   *
   * 带 `seq` 而不是裸字符串：连着点同一个标签两次，两次都要真的展开一次 ——
   * 而裸字符串两次是同一个值，`useEffect` 的依赖比较看不出区别。
   */
  const [tagFocus, setTagFocus] = useState<{ tag: string; seq: number } | null>(null);

  /**
   * 待兑现的「打开文档后把某个标签滚到视口第一行」。
   *
   * 为什么要排队、不在打开之后立刻滚：`handleOpenWorkspaceFile` 返回时 React 还没渲染，
   * 新文档的 EditorView 尚不存在 —— 那一刻 `activeView` 还是**上一篇**文档的，
   * 在它上面找标签只会把光标移到无关的位置。
   */
  const [pendingTagReveal, setPendingTagReveal] = useState<{
    tag: string;
    filePath: string;
  } | null>(null);

  /**
   * 待兑现的「在工作区文件树里定位到某个文件」。
   *
   * 与 `pendingTagReveal` 同形，理由也一样：定位要等**树**先把那个节点渲染出来，
   * 而树的数据要等索引跑完。所以这里只排队，由侧栏在拿到节点之后自己兑现并回调清空。
   *
   * 存对象而不是裸路径：连着对同一个文件发两次请求，裸字符串第二次与前一次值相同，
   * React 的依赖比较看不出区别，第二次就不会生效。
   */
  const [workspaceReveal, setWorkspaceReveal] = useState<{ path: string } | null>(null);

  /**
   * 文档内容版本号。唯一用途是让插件面板在编辑后重新读一次扩展状态 ——
   * `ExtensionHost` 没有变更通知，借这个信号刷新。
   */
  const [documentRevision, setDocumentRevision] = useState(0);

  /** 快速打开（Ctrl+P）是否可见。 */
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);

  /**
   * 「插入链接」的选目标面板是否可见。
   *
   * 与快速打开分开两个 state 而不是共用一个「哪个面板开着」的枚举：两者语义不同
   * （一个是「打开这篇」，一个是「把链接插到光标处」），共用一个 state 只会让
   * 两边都要判「现在开的是哪一个」。
   */
  const [insertLinkOpen, setInsertLinkOpen] = useState(false);

  /**
   * 工作区树上的右键菜单。`null` ＝ 没开着。
   *
   * 只存「哪一个文件 + 鼠标在哪」，菜单项在渲染时现算 —— 这样「删除」与后面的
   * 「重命名」「复制链接」共用同一个入口，各自只关心自己那一条。
   *
   * 坐标存的是 `clientX/clientY`（视口坐标），因为菜单是 `position: fixed` 的：
   * 树容器是 `overflow-y: auto`，绝对定位的菜单会被裁掉。
   */
  /**
   * 存的是**树上被右键的那个节点**，不只是路径 —— 菜单项要按它是目录还是文件分叉：
   * 目录上给「在此新建文件 / 新建文件夹」，文件上给「重命名 / 复制链接 / 删除」。
   *
   * 坐标存的是 `clientX/clientY`（视口坐标），因为菜单是 `position: fixed` 的：
   * 树容器是 `overflow-y: auto`，绝对定位的菜单会被裁掉。
   */
  const [fileMenu, setFileMenu] = useState<{
    node: FileTreeNode;
    x: number;
    y: number;
  } | null>(null);

  /**
   * 目录行右键菜单里的「在此新建」—— 交给侧栏去开那行输入框。
   *
   * 落点必须精确到**被右键的那个目录**，所以不能让它去读侧栏的选中状态：
   * 那个状态在侧栏里，而 `App` 看不见；靠「右键顺带设了选中」来间接传递，
   * 等于让菜单项依赖一个它无法验证的副作用。
   */
  const [pendingCreate, setPendingCreate] = useState<{
    kind: 'file' | 'folder';
    parentRelativePath: string;
  } | null>(null);

  const clearPendingCreate = useCallback(() => setPendingCreate(null), []);

  /**
   * 正在内联改名的文件（绝对路径）。`null` ＝ 没在改名。
   *
   * 由 `App` 持有而不是侧栏自己持有：发起改名的入口是右键菜单，而菜单在 `App` 手里。
   * 侧栏只负责「这个路径的那一行画成输入框」。
   */
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  /**
   * 「复制链接」刚写出去的那串文本。`null` ＝ 没显示。
   *
   * 存的是**文本本身**而不是一句「已复制」：写法由 `files.linkFormat` 决定，而设置页
   * 在另一个窗口里，用户没有别的地方能确认「刚才到底复制成了什么样子」。
   *
   * 成功也留回执（不是只在失败时说话）—— 与 VS Code 的 Copy Path 那种「静默」是有前提的：
   * 那条路复制完立刻就能粘进编辑器，而这里从树里复制，焦点在树上、编辑器里什么都不出现，
   * 静默就等于「这个菜单项点了没反应」。几秒后自己消失，不占地方。
   */
  const [copyLinkNotice, setCopyLinkNotice] = useState<string | null>(null);

  /**
   * 改名确认屏的数据。`null` ＝ 没开着。
   *
   * 只在**有引用要改**时才有值（零改动直接做完，见 `handleRenameRequest`），
   * 所以它的存在本身就意味着「这一次会动别人的文件」。
   *
   * `skipPaths` 与 `updateLinks` 是**试算那一刻**的值，跟着预览一起存下来：
   * 用户点确认时执行的那一步必须与试算用同一套参数，否则「看到的」与「做到的」
   * 会是两件事（设置窗口是可以在预览开着的时候改这一项的）。
   */
  const [renamePreview, setRenamePreview] = useState<{
    filePath: string;
    newName: string;
    skipPaths: string[];
    updateLinks: boolean;
    plan: RenameFileResult;
  } | null>(null);

  /**
   * watcher 的强制重装信号。
   *
   * watcher 的生死**只由下面那个 effect 管**（卸旧的、装新的都在它里面，靠
   * `[activeEditor, filePath, session, updateSaveState]` 这几个依赖驱动）。
   * 改名是唯一一个需要在「依赖还没变」的时候就先把旧 watcher 卸掉的场合 ——
   * 改盘之前不卸的话，旧 watcher 会把「文件不在了」报成 `deleted`，界面于是显示
   * 「文件被删除」，而那只是我们自己改的名。
   *
   * 成功路径上不需要它（`filePath` 变了，effect 自己会重跑）；它是给**失败**路径用的：
   * 那时路径没变，不 bump 的话这篇文档就永远没人监听了。
   */
  const [watchRevision, setWatchRevision] = useState(0);

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

  /** 树上的右键：只记「哪个节点 + 鼠标在哪」，菜单项在渲染时现算。 */
  const handleNodeContextMenu = useCallback((node: FileTreeNode, x: number, y: number) => {
    setFileMenu({ node, x, y });
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
   * 工作区树里是否显示**图片**。
   *
   * **它不是设置项，是视图状态** —— 一个字节都不落盘到工作区里，入口只有工具栏上那
   * 一枚开关（`FIELDS` 里没有它，所以设置页与菜单都看不到）。走 `SettingsStore` 只是
   * 因为它已经是「本机偏好」的统一入口（读写 + 订阅 + 跨窗口同步）。
   */
  const [showImages, setShowImages] = useState(() => settings.get('workspace.showImages'));
  useEffect(
    () =>
      settings.subscribe('workspace.showImages', () => {
        setShowImages(settings.get('workspace.showImages'));
      }),
    []
  );
  const handleShowImagesChange = useCallback((next: boolean) => {
    settings.set('workspace.showImages', next);
  }, []);
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
    selectedTextLength: 0,
    head: 0
  });

  /**
   * 「点条外部把它关掉」这条抑制。**只在选区没变时有效** ——
   * 一旦选区变了（`handleSelectionChange`）就复位，否则用户选了新的一段却看不到条。
   * 不把它做成视图状态：它不跨会话，也不该跨会话（判据 31 的边界在「跨会话是否成立」）。
   */
  const [selectionToolbarDismissed, setSelectionToolbarDismissed] = useState(false);

  /**
   * 当前编辑器视图。只给**需要几何计算**的宿主用（大纲判「当前在第几节」）。
   *
   * 不从 `window.nexusActiveView` 现读：那个全局没有变化通知，而切 surface
   * （Source ↔ Visual）会重建 view —— 拿不到「换了一个」这个事件，就只能在旧 view 上算。
   */
  const [activeView, setActiveView] = useState<EditorView | null>(null);

  /**
   * `activeView` 的 ref 镜像，给**命令的 `execute`** 用。
   *
   * `execute` 注册在 effect 闭包里，直接读 `activeView` 拿到的是注册那一刻的值
   * （stale closure）—— 切了 surface 之后命令还打在旧 view 上。ref 读的是当下值。
   * 与 `window.nexusActiveView` 的区别：那个全局没有变化通知、也没有类型；
   * 这个在 `onViewReady` 里同步写，是同一时机的正规入口。
   */
  const activeViewRef = useRef<EditorView | null>(null);
  const handleViewReady = useCallback((view: EditorView | null) => {
    activeViewRef.current = view;
    setActiveView(view);
  }, []);

  const isMountedRef = useRef(true);
  const loadRequestIdRef = useRef(0);
  const initialContentRef = useRef('');
  const savingContentRef = useRef<string | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 「新建文档第一次保存时对话框停在哪」的一半答案（另一半是工作区根）。
   *
   * 为什么需要记：`Ctrl+N` 之后 `filePath` 就变成 `null` 了，等到按保存时**已经没有**
   * 「当前文档」可问。所以要在有路径的时候把它记下来，而不是在需要的时候去取。
   *
   * 用 effect 跟着 `filePath` 走而不是在 `handleNewFile` 里赋值：这样
   * 「打开文件 → 新建 → 保存」与「打开工作区 → 新建 → 保存」走同一条路径，
   * 而且「关掉标签页补空白文档」那种非用户发起的情形也顺带覆盖到了。
   * 只在拿到**目录**时更新 —— 换成未命名文档时 `filePath` 变 `null`，不该把记住的清掉。
   */
  const lastDocumentDirectoryRef = useRef<string | null>(null);

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
    const registry = new ViewerRendererRegistry(capabilityEnabled);
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

  // 记住最近一次「有路径的文档」所在的目录，供新建文档保存时作默认位置（见 ref 处的注释）。
  useEffect(() => {
    const directory = getDocumentDirectory(filePath);
    if (directory) lastDocumentDirectoryRef.current = directory;
  }, [filePath]);

  /** 状态栏字数的显隐。走 `useSettingValue` 而不是 `settings.get`：后者不会在改设置时重渲染。 */
  const showCharacterCount = useSettingValue('editor.wordCount');

  /**
   * 界面元素显隐与状态栏显示项。
   *
   * **两项都存「被藏起来的那些」**（见 `GroupSettingSpec`），所以这里判的是「不在隐藏集合里」。
   * 走 `disabledMembers` 而不是自己 `value.includes(member)`：后者按**子串**匹配，当前这两组
   * 恰好没有互相包含的成员，但 `STATUS_BAR_METRICS` 已经有 `lineColumn` 这样的名字 ——
   * 将来加一个 `line` 或 `column`，`'lineColumn'.includes('line')` 就会把它误判成被藏。
   * 按成员整词比对的逻辑只该有一份。
   */
  const chromeVisibility = useSettingValue('appearance.chromeVisibility');
  const hiddenChrome = disabledMembers(CHROME_VISIBILITY.options, chromeVisibility);
  const showStatusBar = !hiddenChrome.includes('statusBar');
  const showTabBar = !hiddenChrome.includes('tabBar');
  const showEditorToolbar = !hiddenChrome.includes('editorToolbar');

  const statusBarMetrics = useSettingValue('appearance.statusBarMetrics');
  const hiddenMetrics = disabledMembers(STATUS_BAR_METRICS.options, statusBarMetrics);

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
   * 滚动落点交给 `revealHeadingAt`，与文档内锚点跳转共用同一条路径：
   * 那边已经解决了「目标只滚到视口底边」和「行号被行盒顶出视口」两个问题，
   * 在这里另写一遍 `scrollIntoView: true` 只会把同一只虫子再养一遍。
   */
  const handleOutlineJump = useCallback((offset: number) => {
    const view = (window as unknown as { nexusActiveView?: EditorView }).nexusActiveView;
    if (!view) return;

    revealHeadingAt(view, offset);
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
    const host = new ExtensionHost(capabilityEnabled);
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

  /**
   * 内置能力启停变了：叫醒两个注册表的订阅方。
   *
   * 两张注册表报的状态里都有一档 `disabled`，而且都是**现问谓词**的（`listExtensions()` /
   * `listRenderers()`），所以用户拨完开关它们报的东西立刻就变了。但 `revision` 只在
   * **加载态**跃迁时自己跳 —— 少了这一条，插件面板的 `useSyncExternalStore` 快照不变、
   * `useMemo` 也不重算，面板会一直停在旧状态。症状就是「在设置里禁用一个插件，左侧栏
   * 看到的还是『未加载』」。
   *
   * **为什么接在这里**：谓词是一个裸函数，它没有变更通知；注册表也不该认识设置系统
   * （连 `plugins.disabled` 这个键名都不该知道）。谁把谓词装进去，谁在谓词的输入变了之后
   * 喊一声 —— 那是 `App`：`capabilityEnabled` 与这两个注册表都是在这里接起来的。
   *
   * 另外两条生效信号各自在别处，都**不动**：编辑器的投影走 `SourceEditor` 的
   * `notifyCapabilitiesChanged(view)`（`StateField` 认不出设置变了），附件外壳走
   * `ViewerSurface` 的 `useSettingValue('plugins.disabled')`（它自己会重渲染）。
   * 这一条补的是**第三个**消费者 —— 靠 `revision` 订阅的插件面板。
   */
  useEffect(() => {
    const apply = () => {
      extensionHostRef.current?.notifyCapabilitiesChanged();
      viewerRegistryRef.current?.notifyCapabilitiesChanged();
    };
    return settings.subscribe('plugins.disabled', apply);
  }, []);

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

  /**
   * 新建文档第一次保存时，对话框停在哪个目录（`files.newDocumentLocation`）。
   *
   * 判断本身在 `paths.ts` 的 `newDocumentDirectory` 里 —— 放那儿是为了能单测，
   * 这里只负责把三个来源凑齐（设置值、工作区根、记住的目录）。
   */
  const newDocumentDefaultPath = useCallback((): string | null => {
    return newDocumentDirectory(
      settings.get('files.newDocumentLocation'),
      workspaceRoot,
      lastDocumentDirectoryRef.current
    );
  }, [workspaceRoot]);

  const performSaveAs = useCallback(async (currentSource: string): Promise<boolean> => {
    try {
      if (!window.nexus?.saveAs) return false;
      const chosenPath = await window.nexus.saveAs(currentSource, newDocumentDefaultPath());
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
  }, [session, updateSaveState, newDocumentDefaultPath]);

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

  /**
   * 标签面板里点文档：打开它，并把**被点击的那个标签**滚到视口第一行。
   *
   * 第二个参数是被点的标签，而不是「文档里的某个标签」—— 一篇文档可以带多个标签，
   * 用户点的是哪一行，就该定位到哪一个。
   */
  const handleOpenTaggedDocument = useCallback(
    async (targetPath: string, tag: string) => {
      const opened = await handleOpenWorkspaceFile(targetPath);
      // 打不开就不排队：排了会一直挂着，等下一次打开任何文档时突然生效。
      if (!opened) return;
      setPendingTagReveal({ tag, filePath: targetPath });
    },
    [handleOpenWorkspaceFile]
  );

  /**
   * 兑现上面那个排队项。
   *
   * 两个条件缺一不可：目标文档**已经是活动文档**、且它的 view **已就绪**。
   * 打开是异步的，少任何一个都只会拿到上一篇文档的 view。
   */
  useEffect(() => {
    if (!pendingTagReveal) return;
    if (!activeView || filePath !== pendingTagReveal.filePath) return;

    const { tag } = pendingTagReveal;
    // 先清掉再滚：即使滚动那一步抛错，也不会把这一项永远挂在队列里。
    setPendingTagReveal(null);

    // 落点走大纲跳转那条路径 —— `revealHeadingAt` 会把目标行对齐到视口第一行。
    // 找不到就什么都不做：标签可能刚被删掉，或磁盘内容与索引还没对齐。
    const match = scanTags(activeView.state.doc.toString()).find((item) => item.tag === tag);
    if (match) revealHeadingAt(activeView, match.from);
  }, [pendingTagReveal, activeView, filePath]);

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

  /**
   * 防重入。原生目录对话框是窗口级模态的，但它从 `invoke` 到弹出来之间有一小段
   * 异步间隙 —— 那段时间里再点一次（或按到菜单项）会开出两个对话框。
   */
  const openingWorkspaceRef = useRef(false);

  /**
   * 打开一个工作区。不给路径就弹目录选择框（与「打开文件」同形）。
   *
   * 与 `handleOpenFile` 的两点不同：
   * - **取消是正常结局**，不弹提示、不进错误态 —— 主进程返回 `null`，这里直接返回。
   * - 选中的目录已经由主进程授权（可读写）并记成了下次启动的回落目标，这里只负责换掉
   *   `workspaceRoot`；文件树与索引跟着这个值自己重建（侧栏的 effect 依赖 `rootPath`）。
   *
   * 返回根路径（失败/取消为 `null`）而不是 `void`：调用方要据此决定**后续那一步还做不做**。
   * 「在工作区中打开」开完工作区还要定位文件 —— 工作区没开成却去定位，会定位到
   * 上一个工作区里去。
   */
  const handleOpenWorkspace = useCallback(async (rootPath?: string): Promise<string | null> => {
    if (openingWorkspaceRef.current) return null;
    openingWorkspaceRef.current = true;
    try {
      const root = await window.nexus?.openWorkspace?.(rootPath);
      if (!root) return null;
      setWorkspaceRoot(root);
      return root;
    } catch (err: unknown) {
      console.error('Open workspace failed:', err);
      return null;
    } finally {
      openingWorkspaceRef.current = false;
    }
  }, []);

  /**
   * 「在工作区中打开」——菜单与命令面板共用的那一个动作。
   *
   * ## 两种状态，一个动作
   *
   * - **还没有工作区**：把当前文档**所在的目录**开成工作区，再定位到它。
   *   取「所在目录」而不是往上找库根，是因为渲染进程无从知道哪一层才是库根 ——
   *   猜一个更外层的目录只会开出一棵与用户预期无关的树。
   * - **已经在工作区里**：工作区已经开着，再按文档所在目录开一次会把根**收窄**到那个
   *   子目录（`D:\Notes\sub\a.md` → 根变成 `D:\Notes\sub`）。所以这时退化成
   *   **「在树里定位到它」** —— 这也正是用户此刻想要的：这个文件在工作区里哪儿？
   *
   * 两种状态都收在「定位到该文件」上，所以调用方拿到的结果是一致的：
   * 按下去之后，那个文件在树里被展开、选中、滚进视野。
   *
   * ## 为什么命令面板这条不能是空壳
   *
   * 面板不支持「点不动」的项，所以每个状态都必须有合理行为。没有文档路径时是真的无事可做
   * （没有「所在目录」可言），那一条靠命令自己的 `isEnabled` 灰显 —— 见注册处。
   */
  const openInWorkspace = useCallback(async () => {
    if (!filePath) return;
    const target = filePath;

    if (workspaceRoot === null) {
      const directory = getDocumentDirectory(target);
      if (!directory) return;
      const root = await handleOpenWorkspace(directory);
      // 开工作区失败（或用户在主进程侧取消了目录授权）就到此为止：定位到哪儿都不对。
      if (!root) return;
    }

    setWorkspaceReveal({ path: target });
    // 定位落在文件树上，所以那一屏必须真的看得见 —— 用户可能刚把面板收起来、
    // 或者正停在别的面板上。程序发起的定位用 `showActivity`（不是 `toggleActivity`：
    // 那个会「点已展开的就收起」，在这里等于把要显示的东西关掉）。
    setActivity((previous) => showActivity(previous, 'workspace'));
  }, [filePath, workspaceRoot, handleOpenWorkspace]);

  const clearWorkspaceReveal = useCallback(() => setWorkspaceReveal(null), []);

  /**
   * 给命令用的「最新动作」。
   *
   * 命令的 `execute` / `isEnabled` 在注册那一刻就把闭包固定下来了，而 `filePath` 与
   * `workspaceRoot` 每次打开文件都会变。把这两个值塞进注册 effect 的依赖数组，
   * 会让每次切文档都重注册一遍全部命令；用 ref 递最新值则只多两次赋值。
   *
   * 渲染期直接赋值是刻意的：注册表在事件里读它，那时渲染早已提交，读到的必然是本轮的。
   */
  const openInWorkspaceRef = useRef({ run: () => {}, enabled: false });
  openInWorkspaceRef.current = {
    run: () => void openInWorkspace(),
    enabled: filePath !== null
  };

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
    // `watchRevision` 不是「这次该监听谁」的一部分，它是「请重装一遍」的信号 ——
    // 改名失败时路径没变、其余依赖也没变，只能靠它把卸掉的 watcher 装回来。
    // 见 `applyRename` 里那段「先卸后改盘」。
  }, [activeEditor, filePath, session, updateSaveState, watchRevision]);

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

      setLaunchMode(ctx.mode);

      // Handle unsupported file paths
      if (ctx.unsupportedPath) {
        setStatus('error');
        setErrorMessage(
          t('file.unsupportedDetail', { path: ctx.unsupportedPath })
        );
        return;
      }

      // workspace 模式有两种形态：**已经定了目录**（来自启动参数或上次回落），
      // 和**还没有目录**（裸启动且没记过任何工作区）。两种都不开文档 ——
      // 工作区里的文档从文件树里挑，而「还没有目录」由欢迎态接管（那里有选目录的入口）。
      // 目录已在 main 进程确认存在，这里不重复判。
      if (ctx.mode === 'workspace') {
        setWorkspaceRoot(ctx.workspaceRoot);
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
    // 选区一变，之前「点外部关掉」那条抑制就作废了 —— 用户选了新的一段，条该重新浮出来。
    setSelectionToolbarDismissed(false);
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

      // 判据在 `workspace/rename.ts` 里只写一份：改名回写时「哪些文档不能动」
      // 用的是同一条（缓冲区里有磁盘上没有的东西）。
      if (!hasUnsavedChanges(document)) {
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
   * 删除一个文件（工作区树右键 → 删除）。
   *
   * 四条纪律：
   *
   * - **永久删除必须先确认**，而回收站那一档**不确认** —— 可逆的操作不该拿弹窗烦人，
   *   何况回收站本身就是「后悔」的入口。两个档位的差别只在这一点上体现，用户才分得清。
   * - 删的是**磁盘上的文件**，不只是关掉标签页。所以桥没接上时直接返回，不假装成功。
   * - 失败**说出来**：不用 `setErrorMessage`，那个只在 `status === 'error'` 时渲染
   *   （「文档打不开」那一屏），删除失败时状态是 `ready`，设了也没人看得见。
   * - 删完要**同时**收掉三处痕迹：标签页、索引里的记录、树的列表。少一处就会出现
   *   「文件没了但树里还在」。
   */
  const handleDeleteFile = useCallback(
    async (filePath: string) => {
      const bridge = window.nexus;
      if (!bridge?.deleteFile) return;

      const mode = parseDeleteMode(settings.get('files.deleteBehavior'));
      if (mode === 'permanent') {
        const name = getFileName(filePath);
        if (!window.confirm(t('workspace.deleteConfirm', { name }))) return;
      }

      try {
        await bridge.deleteFile(filePath, mode);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        window.alert(t('workspace.deleteFailed', { name: getFileName(filePath), detail }));
        return;
      }

      // 它可能开着，也可能没开 —— 右键能删树上任意一个文件，不只当前这个。
      const open = store.getDocuments().find((candidate) => candidate.filePath === filePath);
      if (open) closeDocumentAndEnsureEditor(open.id);

      // 索引里的记录由主进程在删除时一并去掉（两边是同一个动作的两半）；
      // 这里只负责让**界面**重读一次 —— 与「索引跑完」共用同一个版本号信号。
      setDocumentRevision((previous) => previous + 1);
    },
    [store, closeDocumentAndEnsureEditor, t]
  );

  /**
   * 新建文件 / 新建文件夹（工作区工具栏与树上右键菜单共用）。
   *
   * 成功时返回**新东西的绝对路径**，失败返回 `null`。侧栏据此决定要不要收起那行输入框，
   * 以及把选中项挪到哪 —— 不挪的话「删除」会继续打在上一个选中的文件上。
   *
   * 主进程在文件落盘后会**当场**把它写进索引（`createFile` 那条通道里做的），
   * 所以这里只需要 bump 版本号让界面重读一次，不必自己重建索引。
   *
   * 新建的文件夹不需要索引 —— 索引里只有文件，它靠 `listWorkspaceDirectories`
   * 从磁盘上直接看见。
   */
  const createEntry = useCallback(
    async (
      kind: 'file' | 'folder',
      directoryPath: string,
      name: string
    ): Promise<string | null> => {
      const bridge = window.nexus;
      if (!workspaceRoot || !bridge) return null;

      try {
        if (kind === 'file') {
          if (!bridge.createFile) return null;
          const created = await bridge.createFile({
            rootPath: workspaceRoot,
            directoryPath,
            fileName: name
          });
          setDocumentRevision((previous) => previous + 1);
          // 建完就打开：用户新建文件的目的就是写它，多一次点击没有信息量。
          await handleOpenWorkspaceFile(created);
          return created;
        }

        if (!bridge.createDirectory) return null;
        const created = await bridge.createDirectory({ rootPath: workspaceRoot, directoryPath, name });
        setDocumentRevision((previous) => previous + 1);
        return created;
      } catch (err) {
        // 失败要说出来。静默的话用户只会再点一次，而第二次会撞同一个错。
        window.alert(
          t('workspace.createFailed', {
            name,
            detail: err instanceof Error ? err.message : String(err)
          })
        );
        return null;
      }
    },
    [workspaceRoot, handleOpenWorkspaceFile, t]
  );

  /**
   * 点图谱上的**断链节点** → 按目标名新建一篇 Markdown 并打开。
   *
   * 落点由 `missingTargetToWorkspacePath()` 从链接目标推出来（`notes/dma` → `notes/dma.md`）。
   * 它返回 `null` 时**什么都不做**，且这是刻意的：那种情况是「这条链接指向的是别的类型的
   * 东西」（`[[stm32.pdf]]` 缺的是一个 PDF），给它建一篇 `stm32.pdf.md` 会让链接看起来通了、
   * 指向的却是一篇空笔记 —— 比让链接断着更糟，断链至少是可见的。
   *
   * 目标目录不存在时 `createFile` 会抛错，`createEntry` 会把它报出来。不在这里替用户
   * 逐级建目录：那等于按一条链接的名字在工作区里造出一串目录，代价远大于收益。
   */
  const createMissingLinkDocument = useCallback(
    async (linkTarget: string) => {
      if (!workspaceRoot) return;

      const relativePath = missingTargetToWorkspacePath(linkTarget);
      if (relativePath === null) return;

      /*
        目录与文件名从**工作区相对路径**上切，不从拼出来的绝对路径上切。

        绝对路径的分隔符跟随平台（Windows 下是 `\`），在它上面找 `/` 会找不到 ——
        于是 `fileName` 变成一整条绝对路径，`createFile` 会因为「名字里不能有分隔符」
        直接抛错。相对路径这一侧永远是正斜杠，切出来才可靠。
      */
      const slash = relativePath.lastIndexOf('/');
      const fileName = slash < 0 ? relativePath : relativePath.slice(slash + 1);
      const directoryPath =
        slash < 0 ? workspaceRoot : resolveRelativePath(workspaceRoot, relativePath.slice(0, slash));
      if (directoryPath === null) return;

      await createEntry('file', directoryPath, fileName);
    },
    [workspaceRoot, createEntry]
  );

  /**
   * 重新扫描工作区：重扫目录 + 重建索引。
   *
   * 两个参考实现都没有这个动作（Markra 靠 file watcher 整树 refresh、OpenKnowledge
   * 靠窗口 focus 自动刷新），Nexus 需要它是因为树来自**索引** —— watcher 报的变更
   * 不会自动进索引。列表由侧栏在它 resolve 之后自己重读。
   *
   * 返回值是这一轮**没处理成**的文件清单，交给侧栏那条警告条。不返回的话，
   * 「补完之后警告还在」就会变成一个说不清的状态。
   */
  const handleRefreshWorkspace = useCallback(async (): Promise<string[]> => {
    if (!workspaceRoot) return [];
    const result = await window.nexus?.rebuildIndex?.(workspaceRoot);
    return result?.errors ?? [];
  }, [workspaceRoot]);

  /**
   * 重命名的**执行**（`dryRun: false`）。三处收尾都在这里。
   *
   * 试算与执行分成两步是有原因的：主进程在真正写盘之前会**重新读一遍**每篇文档、
   * 逐篇比对 `before`，对不上就跳过（`reason: 'changed'`）—— 于是「预览开着的时候
   * 用户在别的编辑器里改了那篇」不会让回写盖掉他的改动。
   *
   * `updateLinks` 由调用方传进来而不是这里现读：它决定试算里有哪些改动，
   * 执行时必须用**同一个**值，否则用户看到的和做到的会是两件事。
   */
  const applyRename = useCallback(
    async (
      sourcePath: string,
      newName: string,
      skipPaths: readonly string[],
      updateLinks: boolean
    ) => {
      const bridge = window.nexus;
      if (!bridge?.renameFile) return;

      // 先卸旧 watcher，**再**改盘。反过来的话，改名这件事本身会被旧 watcher 报成
      // `deleted`，界面显示「文件被删除」—— 而那只是我们自己改的名。
      //
      // 但**只有正在监听的就是它时**才卸：`unwatchRef` 装的是**活动文档**的 watcher，
      // 而被改名的可以是树上任意一行。无条件卸的话，改一个没打开的文件的
      // 名字会把当前那篇的 watcher 卸掉 —— 而它的路径没变、effect 不会重跑，
      // 那篇文档从此失联（外部改动再也不提示）。
      const watched =
        filePath !== null && filePath.toLowerCase() === sourcePath.toLowerCase();
      if (watched) {
        unwatchRef.current?.();
        unwatchRef.current = null;
      }

      let result: RenameFileResult;
      try {
        result = await bridge.renameFile({
          filePath: sourcePath,
          newName,
          updateLinks,
          skipPaths,
          dryRun: false
        });
      } catch (err) {
        // 改盘失败，路径没变 —— 上面卸掉了就得让它装回来，否则那篇文档永远没人监听。
        if (watched) setWatchRevision((previous) => previous + 1);
        const detail = err instanceof Error ? err.message : String(err);
        window.alert(t('workspace.renameFailed', { name: getFileName(sourcePath), detail }));
        return;
      }

      const renamed = result.renamed;
      if (!renamed) {
        // `dryRun: false` 时主进程必定填它。这里只是给类型收窄，顺带当断言。
        if (watched) setWatchRevision((previous) => previous + 1);
        return;
      }

      // ① 换掉 store 里那条记录的路径（标签页标题、标题栏都读它）。
      //    活动的就是它时 `filePath` 会变，watcher effect 于是自己重跑一遍、
      //    用新路径装回 watcher —— **不要**在这里手工 watch，那会装出两个来。
      const open = store.getDocuments().find((document) => document.filePath === sourcePath);
      if (open) {
        store.updateDocument(open.id, (document) => {
          document.filePath = renamed.to;
        });
      }

      // ② 被回写过的文档：新内容就在 `result.changes` 里，直接灌进会话 ——
      //    不去等 watcher 报 `changed`。等它的话，关掉自动重载的用户会看到一片
      //    「被外部修改」的横幅，而那次修改正是我们刚做的；开着自动重载的则白读一次盘。
      for (const change of result.changes) {
        // 被改名那一篇在 `changes` 里记的是**旧**路径（主进程先改名、再逐篇写回），
        // 所以这里要映射到新路径上，否则它会漏掉。
        const path =
          change.path.toLowerCase() === renamed.from.toLowerCase() ? renamed.to : change.path;
        const document = store.getDocuments().find((candidate) => candidate.filePath === path);
        if (document?.kind !== 'editor') continue;

        document.session.replaceSource(change.after);
        // `initialContentRef` 是「最后一次从盘上读到的内容」，脏判定拿它比对 ——
        // 不更新的话这次回写会被当成用户自己的编辑，文档立刻变脏。
        if (store.getActiveId() === document.id) initialContentRef.current = change.after;
        // `readonly` 保留：它是「这份文档不许写」的标记，与「内容是否同步」无关。
        if (document.saveState !== 'readonly') store.setSaveState(document.id, 'clean');
      }

      // ③ 树与标签页都从**索引**读，一次 bump 两边都收到（批一建的机制）。
      setDocumentRevision((previous) => previous + 1);

      // 没改完的部分如实说出来：静默跳过等于「链接自己断了」，而用户刚被告知过会一起改。
      const skipLines = describeSkips(result.skipped, t);
      if (skipLines.length > 0) {
        window.alert(
          t('workspace.renamePartial', {
            name: getFileName(renamed.to),
            detail: skipLines.join('\n')
          })
        );
      }
    },
    // `filePath` 是「当前监听的是谁」—— 决定要不要先卸 watcher，见上面那段注释。
    [store, t, filePath]
  );

  /**
   * 发起改名：先试算，有引用要改就把 diff 摆出来让用户点头（提案 §8 D5），
   * 零改动直接做完。
   *
   * `files.updateLinksOnRename` 关掉时主进程根本不进回写循环，所以也走「零改动」
   * 那条路 —— 关掉这一项的用户不该为了改个名被弹一次窗。
   */
  const handleRenameRequest = useCallback(
    async (filePath: string, newName: string) => {
      const bridge = window.nexus;
      if (!bridge?.renameFile) return;

      // 有未保存修改的文档交给主进程跳过**写**。它照样读、照样算进计划里 ——
      // 只跳「写」不跳「算」，「N 篇文档有未保存的修改」这条回执才是准的。
      const skipPaths = unsavedPaths(store.getDocuments());
      // 试算与执行必须用同一个值，所以这里读一次、存进预览里带下去
      const updateLinks = settings.get('files.updateLinksOnRename');

      let plan: RenameFileResult;
      try {
        plan = await bridge.renameFile({ filePath, newName, updateLinks, skipPaths, dryRun: true });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        window.alert(t('workspace.renameFailed', { name: getFileName(filePath), detail }));
        return;
      }

      if (plan.changes.length === 0) {
        // 零改动：一屏「没有改动」的 diff 只是多一次点击。无法改写的那些
        // （`unresolved`）由执行那一步的回执说出来，不会漏。
        await applyRename(filePath, newName, skipPaths, updateLinks);
        return;
      }

      setRenamePreview({ filePath, newName, skipPaths, updateLinks, plan });
    },
    [store, t, applyRename]
  );

  /** 内联输入框提交。**先把输入框收掉**再试算 —— 试算是异步的，那几百毫秒里不该还挂着输入框。 */
  const handleRenameCommit = useCallback(
    (filePath: string, newName: string) => {
      setRenamingPath(null);
      void handleRenameRequest(filePath, newName);
    },
    [handleRenameRequest]
  );

  /** Escape 或失焦：只是收起输入框，磁盘上什么都没发生。 */
  const handleRenameCancel = useCallback(() => setRenamingPath(null), []);

  /** 预览上点了「改名并更新」。 */
  const handleRenameConfirm = useCallback(() => {
    const pending = renamePreview;
    if (!pending) return;
    setRenamePreview(null);
    void applyRename(pending.filePath, pending.newName, pending.skipPaths, pending.updateLinks);
  }, [renamePreview, applyRename]);

  // 回执自己退场。挂在 state 上而不是在 `handleCopyLink` 里 `setTimeout` ——
  // 后者在连续复制两次时会留下两个定时器，先到的那个把**后一次**的回执提前抹掉。
  useEffect(() => {
    if (copyLinkNotice === null) return;
    const timer = window.setTimeout(() => setCopyLinkNotice(null), COPY_LINK_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [copyLinkNotice]);

  /**
   * 树右键「复制链接」。
   *
   * 四条纪律：
   *
   * - **写法由设置决定，不由这里决定。** 这里只把「目标文档 + 当前文档」交给
   *   `buildDocumentLink`；三档取值的语义全在 `@nexus/core`（`link-format.ts`），
   *   连「认不出的存档值回落哪一档」也在那边，界面不重复一份判断。
   * - **两种格式的相对基准不一样，所以要喂两个不同的东西。** wikilink 的路径段是
   *   **工作区根相对**（这里算的 `relativePath`），Markdown 链接是**当前文档目录相对**
   *   （`buildDocumentLink` 自己从 `filePath` 推）。混用会写出一条**指向别处且不报错**的
   *   链接 —— 这是提案 §4.2 单列出来的一条。
   * - **写不出来要说出来**，三种原因各一条话（见 `copy-link.ts`）。静默什么都不做，
   *   用户会以为这个菜单项是摆设。
   * - **`copyText` 的返回值是「真写进剪贴板了吗」，不是「复制的是不是你要的」。**
   *   主进程只对非字符串返回 `false`，所以它挡不住「格式选错了」——那件事只能靠回执里的
   *   原文让用户自己看见。
   */
  const handleCopyLink = useCallback(
    async (targetPath: string) => {
      const bridge = window.nexus;
      if (!bridge?.copyText) return;

      // 工作区根相对路径。树上的行就是从索引里画的，而索引里那个 `relativePath` 也是
      // `path.relative(root, file)` 再转正斜杠 —— 与 `relativePathFrom` 同一件事，
      // 所以这里就地算，不必为它多跑一次 `listIndexedDocuments` 的 IPC 往返。
      const relativePath =
        workspaceRoot === null ? null : relativePathFrom(workspaceRoot, targetPath);
      if (relativePath === null) {
        window.alert(t(linkFailureKey('not-in-workspace', 'copy')));
        return;
      }

      const result = buildDocumentLink(
        { path: targetPath, relativePath },
        parseLinkFormat(settings.get('files.linkFormat')),
        filePath
      );
      if (!result.ok) {
        window.alert(t(linkFailureKey(result.reason, 'copy')));
        return;
      }

      // 桥自己抛（主进程 handler 出错时 `invoke` 会 reject）与它返回 `false` 是同一件事
      // —— 「没写进剪贴板」。两条都收敛到一个分支，用户看到的是一句一样的话。
      let copied = false;
      try {
        copied = await bridge.copyText(result.text);
      } catch {
        copied = false;
      }
      if (!copied) {
        window.alert(t('workspace.copyLinkFailed'));
        return;
      }
      setCopyLinkNotice(result.text);
    },
    // `workspaceRoot` 与 `filePath` 都是这一项要用的：前者算工作区根相对路径，
    // 后者是 Markdown 档的基准。漏进依赖数组会让菜单项用上一次的基准拼路径。
    [workspaceRoot, filePath, t]
  );

  /**
   * 插入链接：在面板里挑了一篇工作区文档 → 在**光标处**写出一条指向它的链接。
   *
   * 四条纪律，与「复制链接」同源但各有一处不同：
   *
   * - **写法由设置决定，不由这里决定。** 与 `handleCopyLink` 逐字相同：只把
   *   「目标文档 + 当前文档」交给 `buildDocumentLink`，三档语义全在 `@nexus/core`。
   * - **选中文字就是链接文字。** 这一段由 `createInsertDocumentLinkTransaction` 从
   *   `selection` 里取（`buildDocumentLink` 的 `label` 参数）—— 用户选中一段文字再点
   *   链接，心里想的是「把这段文字变成链接」，不是「把它删掉换成别的」。
   * - **落点是 `session.dispatch` 而不是直接派发到 `view`。** 与剪切/粘贴同一条路：
   *   session 是 source 的唯一持有者，派发到它之后 `registerSurface()` 会把新内容
   *   同步进编辑器。直接派发到 view 的话，session 里那份 source 就落后了一步。
   * - **插完把焦点还给编辑器**（面板拿走了焦点）。不然用户接下来打字会打到一个
   *   已经关掉的面板曾经待过的地方 —— 什么都不发生。
   *
   * 失败时用 `'insert'` 那一套话：`no-current-document` 在这里的含义是「这篇还没保存、
   * 没有路径」，与复制链接那边的「你还没打开文档」不是一件事（见 `link-failure.ts`）。
   */
  const handleInsertLink = useCallback(
    (target: IndexedDocument) => {
      setInsertLinkOpen(false);
      const view = activeViewRef.current;
      if (!view) return;

      const snapshot = session.getSnapshot();
      const result = createInsertDocumentLinkTransaction(snapshot.source, snapshot.selection, {
        target: { path: target.path, relativePath: target.relativePath },
        format: parseLinkFormat(settings.get('files.linkFormat')),
        currentDocumentPath: filePath
      });
      if (!result.ok) {
        window.alert(t(linkFailureKey(result.reason, 'insert')));
        return;
      }

      session.dispatch(result.transaction);
      view.focus();
    },
    [session, filePath, t]
  );

  /**
   * 右键菜单的菜单项。**每次打开时现算**而不是缓存：文案要跟着语言变，
   * 而语言是可以在窗口开着的时候切走的。
   *
   * 两类节点给两套菜单：
   *
   * - **目录** —— 只有「在此新建文件 / 新建文件夹」。落点必须是**右键的那个目录**，
   *   不能沿用工具栏那套「按选中项推」的规则：右键一个收着的目录时选中项可能还是别的
   *   地方，而用户的手指刚刚点在这一个上。
   * - **文件** —— `copy-link` 排在 `rename` 与 `delete` **之间**：`delete` 是唯一
   *   不可逆的一项，留在最后是这类菜单的通例；`copy-link` 与 `rename` 都不改别人的
   *   东西，放一组。
   *
   * 目录的 `path` 可能是 `null`（补出来的节点）—— 那时一个新建项都不给：
   * 拿一个不存在的目录去建，只会在根上冒出一个用户没要的文件。
   */
  const fileMenuItems = useCallback(
    (node: FileTreeNode): ContextMenuItem[] => {
      if (node.type === 'directory') {
        if (node.path === null) return [];
        const parentRelativePath = node.relativePath;
        return [
          {
            id: 'new-file',
            label: t('workspace.toolbar.newFile'),
            onSelect: () => setPendingCreate({ kind: 'file', parentRelativePath })
          },
          {
            id: 'new-folder',
            label: t('workspace.toolbar.newFolder'),
            onSelect: () => setPendingCreate({ kind: 'folder', parentRelativePath })
          }
        ];
      }

      const filePath = node.path;
      if (filePath === null) return [];
      return [
        {
          id: 'rename',
          label: t('workspace.renameFile'),
          onSelect: () => setRenamingPath(filePath)
        },
        {
          id: 'copy-link',
          label: t('workspace.copyLink'),
          onSelect: () => void handleCopyLink(filePath)
        },
        {
          id: 'delete',
          label: t('workspace.deleteFile'),
          danger: true,
          onSelect: () => void handleDeleteFile(filePath)
        }
      ];
    },
    [handleDeleteFile, handleCopyLink, t]
  );

  /**
   * Ctrl/Cmd+左键的链接跳转策略。
   *
   * 编辑器只负责识别（命中哪个链接、href 是什么），"往哪去"在这里定：
   *   1. `#标签`           → 切到标签面板并展开它
   *   2. wikilink          → 拿目标名去索引里解析成文档
   *   3. `#anchor`         → 文档内标题跳转，不离开当前文档
   *   4. http/https/mailto → 交给系统默认浏览器
   *   5. 相对路径           → 按当前文档目录解析，再由编辑器打开
   *                          （可带 `#page=` 页码锚点，P3-11 的引用就是这种）
   *
   * 返回 false 表示不处理，事件交回浏览器，保持默认的落光标行为。
   */
  const handleLinkNavigation = useCallback<LinkNavigator>(
    ({ href, kind }) => {
      const target = href.trim();
      if (!target) return false;

      // 0. 标签：切到标签面板并展开它。标签不是文件，没有「打开」这一说 ——
      //    它唯一能去的方向是「列出带这个标签的文档」，而那正是标签面板的职责。
      //    `target` 已归一化（去 `#`、转小写），与索引库 `tags` 表的存法一致。
      if (kind === 'tag') {
        setActivity({ activeId: 'tags', panelOpen: true });
        setTagFocus((previous) => ({ tag: target, seq: (previous?.seq ?? 0) + 1 }));
        return true;
      }

      // 1. wikilink：拿目标名去**索引**里解析。编辑器只把名字递过来，
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

      // 2. 文档内锚点：光标落到标题上并滚动过去
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

      // 3. 外部协议。这里再判一次白名单，是不把"净化器放行过"当成"一定能开"；
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

      // 4. 相对路径：必须相对当前文档目录解析，否则会被当成进程 cwd。
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
        isEnabled: () => Boolean(activeViewRef.current),
        execute: () => {
          const view = activeViewRef.current;
          if (view) openSearchPanel(view);
        }
      }),
      commandRegistry.registerCommand({
        id: 'replace',
        titleKey: 'cmd.replace',
        shortcut: DEFAULT_SHORTCUTS['replace'],
        isEnabled: () => Boolean(activeViewRef.current),
        execute: () => {
          const view = activeViewRef.current;
          if (view) openSearchPanel(view);
        }
      }),
      /**
       * 行内格式。**同一个函数引用**被快捷键（本 effect 的分发循环）、工具栏按钮与
       * 将来的右键菜单共用 —— 蓝图要求三者「同一组命令定义」，各写一遍必然漂。
       *
       * `isEnabled` 判的是「有没有活动编辑器」：没有文档时按钮该灰、面板该跳过，
       * 否则又是一个「搜得到、按下去没反应」的项。
       */
      commandRegistry.registerCommand({
        id: 'format.bold',
        titleKey: 'cmd.bold',
        shortcut: DEFAULT_SHORTCUTS['format.bold'],
        isEnabled: () => Boolean(activeViewRef.current),
        execute: () => {
          const view = activeViewRef.current;
          if (view) handleVisualModB(view);
        }
      }),
      commandRegistry.registerCommand({
        id: 'format.italic',
        titleKey: 'cmd.italic',
        shortcut: DEFAULT_SHORTCUTS['format.italic'],
        isEnabled: () => Boolean(activeViewRef.current),
        execute: () => {
          const view = activeViewRef.current;
          if (view) handleVisualModI(view);
        }
      }),
      commandRegistry.registerCommand({
        id: 'format.strike',
        titleKey: 'cmd.strike',
        shortcut: DEFAULT_SHORTCUTS['format.strike'],
        isEnabled: () => Boolean(activeViewRef.current),
        execute: () => {
          const view = activeViewRef.current;
          if (view) handleVisualModStrike(view);
        }
      }),
      commandRegistry.registerCommand({
        id: 'format.inline-code',
        titleKey: 'cmd.inlineCode',
        shortcut: DEFAULT_SHORTCUTS['format.inline-code'],
        isEnabled: () => Boolean(activeViewRef.current),
        execute: () => {
          const view = activeViewRef.current;
          if (view) handleVisualInlineCode(view);
        }
      }),
      /**
       * 插入链接。**命令只负责开面板**，真正的插入在 `handleInsertLink` 里 ——
       * 面板的 `onPick` 每次渲染现取，所以拿到的永远是当前文档的 session 与路径。
       * 命令若闭包住那个回调，就会用到注册那一刻的旧路径（换文档之后写出来的
       * Markdown 链接会相对上一篇算）。
       */
      commandRegistry.registerCommand({
        id: 'format.insert-link',
        titleKey: 'cmd.insertLink',
        shortcut: DEFAULT_SHORTCUTS['format.insert-link'],
        isEnabled: () => Boolean(activeViewRef.current),
        execute: () => setInsertLinkOpen(true)
      }),
      /**
       * 「清除格式」**不带 `shortcut`**：它没有公认的组合键，入口是选区上下文条。
       * 不带默认键不影响它在面板 / 菜单里的可用性（`isEnabled` 与其它格式命令同源），
       * 只是不参与 `resolveShortcut` 的匹配。
       */
      commandRegistry.registerCommand({
        id: 'format.clear-formatting',
        titleKey: 'cmd.clearFormatting',
        isEnabled: () => Boolean(activeViewRef.current),
        execute: () => {
          const view = activeViewRef.current;
          if (view) handleVisualClearFormatting(view);
        }
      }),
      /**
       * 块级改型。十五条命令从 `BLOCK_FORMAT_SPECS` **展开注册**，不是手写十五遍 ——
       * 动作表是「格式」菜单与命令注册的共同出处，加一项只改一处。
       *
       * 共用 `handleVisualBlockFormat(view, kind)` 一个函数引用（「命令同源」在结构上成立）。
       * **不给默认快捷键**：参考实现那套 `Mod-Alt-1..6` / `Mod-Shift-7/8` 与「按序号切标签页」
       * 是同一个键位族，先不占；入口是菜单，命令面板里也搜得到。
       */
      ...BLOCK_FORMAT_SPECS.map((spec) =>
        commandRegistry.registerCommand({
          id: spec.id,
          titleKey: spec.labelKey,
          isEnabled: () => Boolean(activeViewRef.current),
          execute: () => {
            const view = activeViewRef.current;
            if (view) handleVisualBlockFormat(view, spec.kind);
          }
        })
      ),
      commandRegistry.registerCommand({
        id: 'open-in-workspace',
        titleKey: 'cmd.openInWorkspace',
        // 没有文档就没有「所在目录」，这条命令此刻无事可做。声明出来让面板灰显 ——
        // 面板里一条搜得到、按下去没反应的命令，用户只会以为自己按错了。
        // 菜单侧用**同一个判据**（`filePath === null`），两处各写一份必然漂。
        isEnabled: () => openInWorkspaceRef.current.enabled,
        // 走 ref 而不是直接闭包 `openInWorkspace`：见 `openInWorkspaceRef` 的注释。
        execute: () => openInWorkspaceRef.current.run()
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
          // 不可用的命令**不拦事件**：拦了就等于把键吞掉，而它什么都不做
          // （`continue` 而不是 `return`，让别的命令还有机会匹配同一个组合键）。
          // 判据与命令面板、菜单同源（`Command.isEnabled`），三处不再各判一次。
          if (cmd.isEnabled && !cmd.isEnabled()) continue;
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

  /**
   * 把按钮接到**宿主命令**上。
   *
   * 工具栏与顶栏都不直接调 `setSurfaceKind` / `openSearchPanel` —— 那样按钮与快捷键
   * 就成了两份实现，而蓝图 `:394` 要求「右键 / 快捷键 / 上下文 toolbar 用**同一组命令**」。
   * 走这里之后，同一个动作无论从哪个入口来，都是同一条命令的同一个 `execute`。
   *
   * `getCommand` 先探一次：命令在挂载时的 effect 里注册，按钮画出来时它一定在；
   * 真拿不到时宁可什么都不做 —— 一次点击把整个渲染进程抛挂，用户连报错都看不到。
   */
  const runCommand = useCallback((id: string) => {
    if (commandRegistry.getCommand(id)) commandRegistry.executeCommand(id);
  }, []);

  /**
   * 活动栏那枚与命令面板 / 菜单里的 `toggle-theme` 是**同一条命令** —— 按钮不自己算
   * 「切到哪边」，那条命令里已经挡了「切不动」（用户主题 / 单变体预设）的情况。
   */
  const handleToggleTheme = useCallback(() => runCommand('toggle-theme'), [runCommand]);

  /** 编辑器工具栏那枚（顶栏那枚已删）。同一个动作不能两处各写一遍。 */
  const handleToggleSurface = useCallback(() => runCommand('toggle-surface'), [runCommand]);

  /**
   * 选区格式状态的查询器。**跨渲染持有**：它内部按 `Text` 对象标识缓存扫描结果，
   * 每次渲染新建一个的话缓存永远命中不了，等于每次选区变化都全篇重解析一次（§2.5 的性能账）。
   */
  const formattingAnalyzer = useRef(createFormattingAnalyzer());

  /**
   * 选区当前落在哪些标记里、是不是在原子节点里。
   *
   * 依赖里的 `selection` 是**重算信号**而不是数据源 —— 真实位置现读 `view.state.selection`：
   * CodeMirror 改了 state 不会让 React 重渲染，只有宿主的选区回调会。
   * 空选区时直接短路：`selectedTextLength === 0` 时这条链一次扫描都不该跑（§2.5）。
   */
  const formattingState = useMemo(() => {
    if (!activeView || selection.selectedTextLength === 0) return EMPTY_FORMATTING_STATE;
    const main = activeView.state.selection.main;
    return formattingAnalyzer.current(activeView.state.doc, {
      anchor: main.anchor,
      head: main.head
    });
  }, [activeView, selection]);

  /**
   * 选区上下文条的动作表。**id 就是宿主命令 id** —— 按钮与快捷键因此走同一条命令的
   * 同一个 `execute`（蓝图 `:394`）。图标与文案键来自 `SELECTION_ACTION_SPECS`
   * （那张表是 §3.1 的唯一出处，测试直接钉它），这里只补上运行时才知道的两件事。
   *
   * `disabled` 取 `atomic`：选区切在代码块 / 行内代码 / 公式里时，行内标记无处可施 ——
   * 判据与事务层的守卫**同一个表达式**（`formatting-query.ts`），否则会出现
   * 「按钮亮着、按下去没反应」。
   */
  const selectionActions = useMemo<SelectionAction[]>(() => {
    const disabled = formattingState.atomic;
    const active = formattingState.active;
    return SELECTION_ACTION_SPECS.map((spec) => ({
      id: spec.id,
      label: t(spec.labelKey),
      icon: spec.icon,
      disabled,
      // 没有 `format` 的动作（清除格式）不参与激活态 —— 见 spec 的说明。
      pressed: spec.format ? active.includes(spec.format) : undefined
    }));
  }, [formattingState, t]);

  /** 量出选区在视口里的位置。量不到（没有非空选区 / 没有排版）时是 `null`。 */
  const selectionAnchor = useSelectionAnchor(activeView, selection);

  /**
   * 块级状态的查询器。与 `formattingAnalyzer` 同一条约定：**跨渲染持有**，
   * 它按 `Text` 对象标识缓存解析结果 —— 每次渲染新建一个的话缓存永远命中不了，
   * 而块级判定要一次全篇解析，光标每动一格就重来一遍。
   */
  const blockFormatAnalyzer = useRef(createBlockFormatAnalyzer());

  /**
   * 光标所在块的类型 / 是不是引用 / 能不能改型。依赖里的 `selection` 同样是**重算信号**，
   * 真实位置现读 `view.state.selection`（CM 改了 state 不会让 React 重渲染）。
   */
  const blockFormatState = useMemo(() => {
    if (!activeView) return EMPTY_BLOCK_FORMAT_STATE;
    const main = activeView.state.selection.main;
    return blockFormatAnalyzer.current(activeView.state.doc, {
      anchor: main.anchor,
      head: main.head
    });
  }, [activeView, selection]);

  /**
   * 「格式」菜单的条目。**动作表 → 菜单**的投影在 `block-format-specs.ts` 里，
   * 这里只补上运行时才知道的 `t` 与 `runCommand`。
   */
  const blockFormatItems = useMemo(
    () => blockFormatMenuItems(blockFormatState, t, runCommand),
    [blockFormatState, t, runCommand]
  );

  /**
   * `/` 面板里的命令级动作。**与「格式」菜单同一张表、同一批命令 id** ——
   * 投影本身在 `slash-commands.ts` 里，这里只补上 `t` 与 `runCommand`。
   *
   * 换语言时重建这一份是必要的：编辑器建视图时只取一次宿主对象，之后靠
   * `SourceEditor` 的 ref 转发拿到最新的一份，标签才不会停在旧语言上。
   */
  const slashCommandHost = useMemo(() => createSlashCommandHost(t, runCommand), [t, runCommand]);

  /** 稳定引用 —— 内联箭头会让 `SelectionToolbar` 的「点外部」监听每次渲染都重新订阅。 */
  const dismissSelectionToolbar = useCallback(() => setSelectionToolbarDismissed(true), []);

  /**
   * 编辑器工具栏「更多」下拉里的条目。**只放已有能力里没进常驻栏的那些** ——
   * 「替换」与「插入链接」。后者在这里是**唯一不带选区也能用的入口**：
   * 选区上下文条要有非空选区才浮出来，而「光标停在一行上插一条链接」是常见写法，
   * 那时标签文字退回目标文档的标题。
   *
   * 块级动作（改型）由后续批次追加：它们要等块级事务先补齐。
   */
  const editorMoreItems = useMemo<ContextMenuItem[]>(
    () => [
      {
        id: 'insert-link',
        label: t('cmd.insertLink'),
        onSelect: () => runCommand('format.insert-link')
      },
      {
        id: 'replace',
        label: t('cmd.replace'),
        onSelect: () => runCommand('replace')
      }
    ],
    [runCommand, t]
  );

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

  /**
   * 粘贴图片：落盘 → 插入相对引用。
   *
   * 编辑器只负责「把文件交出来、拿回一段文本」（`ClipboardOptions.onPasteFiles`）；
   * 落点、命名、重名、边界校验都在这一侧往下 —— 渲染进程算名字（纯函数，可单测），
   * 主进程写盘（只有它看得见文件系统，也只有它知道那个名字是不是已经被占了）。
   *
   * 三个设置项在这里合流：`files.attachmentLocation` 决定要不要用子目录、
   * `files.attachmentDirectory` 是那个子目录、`files.attachmentNameTemplate` 是文件名。
   * **每次粘贴现读**，不订阅 —— 值与「这一刻的粘贴」绑定，订阅只会多一条要清理的链。
   *
   * 返回 `null` 表示这次不处理（文档还没存过盘、类型认不出来），编辑器会接着走文本分支。
   */
  const handlePasteFiles = useCallback(
    async (files: readonly File[]): Promise<string | null> => {
      // 没有落点：新建但还没保存的文档没有目录可写。`saveAttachment` 要求文档路径，
      // 所以这里只能不处理 —— 猜一个目录出来会把附件落在用户没指定的地方。
      const documentPath = filePath;
      const baseDirectory = getDocumentDirectory(documentPath);
      if (!documentPath || !baseDirectory) return null;

      const directory =
        settings.get('files.attachmentLocation') === 'directory'
          ? settings.get('files.attachmentDirectory')
          : '';
      const template = settings.get('files.attachmentNameTemplate');

      const references: string[] = [];
      for (const file of files) {
        const extension = attachmentExtension(file.name, file.type);
        // 认不出来的类型跳过这一个，而不是整批放弃：一次粘贴里混着 png 与别的文件时，
        // 让能处理的那几张照常落盘比「全都不动」好。
        if (extension === '') continue;

        const saved = await window.nexus?.saveAttachment({
          documentPath,
          directory,
          // 名字在**这一刻**展开：模板里的 `{timestamp}` 是「粘贴时间」，
          // 不是「用户改设置的时间」。
          fileName: expandAttachmentName(template, new Date()),
          extension,
          data: new Uint8Array(await file.arrayBuffer())
        });
        if (!saved) continue;

        const relative = relativePathFrom(baseDirectory, saved);
        // 跨盘符时不存在合法的相对路径，而绝对路径写进 Markdown 是点不开的
        // （渲染侧会把它当成相对路径拼到文档目录后面）。文件已经落盘了，只是不插引用。
        if (relative === null) continue;
        references.push(formatAttachmentReference(relative, documentTitleOf(saved)));
      }

      return references.length > 0 ? references.join('\n') : null;
    },
    [filePath]
  );

  /**
   * 图片选择器的数据源。
   *
   * **有工作区才给这个钩子**：轻量模式下没有工作区可列，编辑器据此不浮面板
   * （见 `SourceEditor` 里那条说明）。列表内容全在渲染进程算完 —— 两份写回地址
   * （`![](…)` 的文档目录相对、`![[…]]` 的最短唯一路径）与 `nexus-asset://` 缩略图
   * 都是宿主才知道的事实，编辑器不认识。
   *
   * 每次打开选择器现拉一次索引，不订阅：列表要的是**这一刻**工作区里有什么图，
   * 缓存一份只会让刚拖进来的图片不出现。
   */
  const workspaceImages = useMemo<WorkspaceImageProvider | undefined>(
    () =>
      workspaceRoot
        ? async () =>
            buildWorkspaceImageOptions(
              (await window.nexus?.listIndexedDocuments?.()) ?? [],
              getDocumentDirectory(filePath),
              workspaceRoot
            )
        : undefined,
    [workspaceRoot, filePath]
  );

  /**
   * `![[…]]` 回退解析用的工作区资源清单。
   *
   * 与 `workspaceImages`（每次打开选择器现拉）不同，这份清单要**长期有效**：投影每次重算
   * 都要拿它判断「候选路径存在吗」，不可能每帧跑一趟 IPC。所以跟着索引走 —— 进工作区
   * 拉一次，`documentRevision` 变化（侧栏索引跑完、恢复历史）再拉一次。
   *
   * 没有工作区时是 `undefined`：编辑器据此退化成「只有文档目录」的单档解析，与这个能力
   * 不存在时完全一致，不会更差。
   */
  const [workspaceAssets, setWorkspaceAssets] = useState<
    readonly WorkspaceAssetEntry[] | undefined
  >(undefined);

  useEffect(() => {
    const listIndexedDocuments = window.nexus?.listIndexedDocuments;
    if (!workspaceRoot || !listIndexedDocuments) {
      setWorkspaceAssets(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const documents = await listIndexedDocuments();
        if (!cancelled) {
          setWorkspaceAssets(buildWorkspaceAssetEntries(documents, workspaceRoot));
        }
      } catch {
        // 索引拉不动不该让所有嵌入一起变占位符：退回单档解析，同目录的图照样能显示。
        if (!cancelled) setWorkspaceAssets(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot, documentRevision]);

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
            // 「在工作区中打开」＝把当前文档放进工作区上下文，并**在树里定位到它**。
            // 两种状态都收在这个结果上，所以菜单这一项只在「没有文档」时禁用 ——
            // 与命令面板的 `isEnabled` 是同一个判据，改一处必须改另一处。
            //
            // 工作区模式下不再禁用（原先禁用了）：那时它是「这个文件在树里哪儿？」，
            // 而这个问题在工作区里同样成立、且用户问得更多。
            disabled: filePath === null,
            onSelect: () => void openInWorkspace()
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
        id: 'format',
        label: t('menu.format'),
        // 块级改型。**不放进常驻栏**：十五项排成一条栏就是蓝图 `:357` 说的
        // 「常驻工具栏不堆叠完整编辑器按钮」；下拉菜单里带 ✓ 正好能表达「这一块现在是什么」。
        // 附件（PDF / 图片）走 Viewer，没有块可言 —— 整组禁用而不是藏起来。
        items: activeEditor ? blockFormatItems : blockFormatItems.map((item) => ({ ...item, disabled: true }))
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
      filePath,
      workspaceRoot,
      handleNewFile,
      handleOpenFile,
      // 「在工作区中打开」不再直接调 `handleOpenWorkspace`：它现在是一个
      // 「开工作区 + 定位」的复合动作，菜单与命令面板共用，依赖换成那一个。
      openInWorkspace,
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
      keybindings,
      // 光标一动，「格式」菜单里的 ✓ 与禁用就要跟着换。
      blockFormatItems
    ]
  );

  /**
   * 这次会话是不是工作区模式。
   *
   * **不能拿 `workspaceRoot` 代替它。** 裸启动就是「工作区模式、还没有目录」——
   * 那一格的工作区根是 `null`，用它当判据会让顶栏与窗口标题在欢迎态显示
   * 「Nexus Lite / Untitled.md」，正好把用户期待看到的「完全版」说成轻量版。
   */
  const inWorkspace = launchMode === 'workspace';

  /**
   * 当前上下文里「正在看的东西」：lightweight 是文件，workspace 是目录。
   *
   * 欢迎态（工作区模式、还没定目录）两者都是 `null` —— 那时顶栏显示工作区名而不是
   * 一个假的 `Untitled.md`：后者会让人以为有个未保存的文档挂在那儿。
   */
  const activePath = filePath ?? workspaceRoot;
  const fileName = activePath
    ? activePath.replace(/^.*[\\/]/, '')
    : inWorkspace
      ? t('workspace.title')
      : 'Untitled.md';

  /**
   * 状态栏右侧的模式标签。
   *
   * 打开附件时必须如实显示它的类型 —— 在 PDF 标签页上写着「Markdown」是直接
   * 骗人，而且用户会据此判断「这个文件到底被正确识别了没有」。
   * `Workspace` / `Markdown` 两个专有名词保持不翻译（既有行为）。
   */
  const formatLabel = inWorkspace
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
    const appName = inWorkspace ? t('app.name.workspace') : t('app.name.lite');
    document.title = `${fileName || t('tab.untitled')} — ${appName}`;
  }, [fileName, inWorkspace, t]);

  return (
    <div className="nexus-app-root">
      {/* Header Bar */}
      <header className="nexus-header-bar" onDoubleClick={handleHeaderDoubleClick}>
        <div className="nexus-header-left">
          <span className="nexus-app-title">
            {inWorkspace ? t('app.name.workspace') : t('app.name.lite')}
          </span>
          <MenuBar menus={menus} />
        </div>

        <div className="nexus-header-center" title={activePath ?? fileName}>
          <span className="nexus-filename">{fileName}</span>
          {activePath && <span className="nexus-filepath-subtitle">{activePath}</span>}
        </div>

        <div className="nexus-header-right">
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

      {/* 复制链接回执。`role="status"` 而不是 `alert`：这是一条「事情成了」的通知，
          抢断朗读没有道理 —— 三条**失败**的路都走了 `window.alert`，那才是要打断的。 */}
      {copyLinkNotice && (
        <div className="nexus-copy-link-notice" role="status" data-copy-link-notice="">
          <span>{t('workspace.copyLinkDone', { text: copyLinkNotice })}</span>
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

      {/* 更新提示条。**非模态**：它只占一行，不挡文档、不抢焦点 —— 用户点了才打开更新窗口。
          放在 header 与 body 之间而不是 status bar 里：状态栏那一行是「当前文档的读数」，
          而这是一件与文档无关的事。 */}
      <UpdateNoticeBar />

      {/* Main Content Area */}
      <div className="nexus-body">
      {/* 活动栏与面板只在工作区模式下出现；lightweight 保持原来的单栏布局 */}
      {status === 'ready' && workspaceRoot && (
        <ActivityBar
          activeId={activity.activeId}
          panelOpen={activity.panelOpen}
          onSelect={handleActivitySelect}
          onOpenSettings={openSettingsWindow}
          themeType={resolvedTheme.type}
          themeSwitchable={modeSwitchable}
          onToggleTheme={handleToggleTheme}
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
              revision={documentRevision}
              onNodeContextMenu={handleNodeContextMenu}
              renamingPath={renamingPath}
              onRenameCommit={handleRenameCommit}
              onRenameCancel={handleRenameCancel}
              showImages={showImages}
              onShowImagesChange={handleShowImagesChange}
              onCreateFile={(directoryPath, name) => createEntry('file', directoryPath, name)}
              onCreateFolder={(directoryPath, name) => createEntry('folder', directoryPath, name)}
              onDeleteFile={(target) => void handleDeleteFile(target)}
              onRefresh={handleRefreshWorkspace}
              createRequest={pendingCreate}
              onCreateRequestHandled={clearPendingCreate}
              revealRequest={workspaceReveal}
              onRevealHandled={clearWorkspaceReveal}
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
                view={activeView}
                cursorOffset={selection.head}
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
              onOpenDocument={handleOpenTaggedDocument}
              revision={documentRevision}
              focusTag={tagFocus}
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
              onCreateMissingLink={createMissingLinkDocument}
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
              viewers={viewerRegistryRef.current ?? undefined}
              onManage={openPluginsSettings}
            />
          </div>
        </div>
      )}

      <main className="nexus-main-content">
      {/* 标签栏挂在编辑区容器**内部**：它只该横跨编辑区，不该延伸到活动栏和侧栏上方。
          放在这里还有个好处 —— 侧栏展开/收起时标签栏宽度自动跟着变，不需要额外同步。

          藏起来时**不卸载 `TabBar` 的调用方状态**：文档仍然开着，只是这条栏不画 ——
          所以「藏了标签页」不会关掉任何东西，侧栏的文件树照样能切换。 */}
      {showTabBar && (
        <TabBar
          documents={workspaceSnapshot.documents}
          activeId={workspaceSnapshot.activeId}
          onActivate={store.activate}
          onClose={handleCloseTab}
        />
      )}
      {/* 编辑器工具栏挂在**标签栏下方**。标签栏回答的是「哪些文档开着」，工具栏作用于
          **当前那一份的内容** —— 从属关系是「栏 → 文档」，所以文档这一层的东西排在下面。

          这不只是观感：工具栏**只对可编辑文档渲染**（PDF / 图片走 Viewer，撤销栈与
          surface 切换对它们没有意义，画出来只是一排点了没反应的按钮）。它若排在标签栏
          **上方**，从 .md 切到 .png 时整条消失，标签栏就跟着往上跳 32px
          （2026-10-04 实测：74 → 42）。排在下面，标签栏钉在标题栏正下方不动。 */}
      {status === 'ready' && activeDocument?.kind === 'editor' && (
        <>
          {/* 藏起来时**只是不画这一栏**，不卸载任何能力：栏上每个动作都还有第二条路
              （系统键 / 顶栏 / `Mod-M` / `Mod-F` / 菜单栏的「格式」菜单）。所以
              「藏了工具栏」不会少一个动作，只是少一条捷径 —— 这正是它进得了
              `appearance.chromeVisibility` 的原因。 */}
          {showEditorToolbar && (
            <EditorToolbar
              surfaceKind={surfaceKind}
              readOnly={saveState === 'readonly'}
              // 块级按钮的按下态 / 禁用与「格式」菜单的 ✓ / 灰出自同一个 `blockFormatState`，
              // 动作也走同一个 `runCommand` —— 两个入口是同一条命令，不是两份实现。
              formatState={blockFormatState}
              onUndo={handleUndo}
              onRedo={handleRedo}
              onToggleSurface={handleToggleSurface}
              onFind={() => runCommand('find')}
              onBlockFormat={runCommand}
              moreItems={editorMoreItems}
            />
          )}
          {/* 选区上下文条（浮层，`position: fixed`，所以放哪儿都行，跟着这一栏放便于阅读）。
              **只读时不画**：它上面只有写动作，全禁用等于浮一排死按钮 —— P0-5 的
              「降级而非隐藏」说的是那条同时带视图 / 读动作的常驻栏，不是这一条。 */}
          {saveState !== 'readonly' && (
            <SelectionToolbar
              anchor={selectionToolbarDismissed ? null : selectionAnchor}
              actions={selectionActions}
              label={t('editor.selectionToolbar.label')}
              onAction={runCommand}
              onDismiss={dismissSelectionToolbar}
            />
          )}
        </>
      )}
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
      {/* 没有活动文档时的空态。三种形态由 `WorkspaceEmpty` 自己派生（判据在那边）。 */}
      {status === 'ready' && !activeDocument && (
        <WorkspaceEmpty
          mode={launchMode}
          rootPath={workspaceRoot}
          onOpenFolder={() => void handleOpenWorkspace()}
        />
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
            onPasteFiles={handlePasteFiles}
            workspaceImages={workspaceImages}
            workspaceAssets={workspaceAssets}
            extensionHost={extensionHostRef.current ?? undefined}
            slashCommands={slashCommandHost}
            theme={resolvedTheme.type}
            locale={locale}
            onChange={handleContentChange}
            onSelectionChange={handleSelectionChange}
            onViewReady={handleViewReady}
            className="nexus-editor-full"
          />
        </ErrorBoundary>
      )}
      </main>
      </div>

      {/* Status Bar Footer。整条可藏（`appearance.chromeVisibility`），但**左侧那半永远在** ——
          保存失败只在那里说，把它也做成开关等于把「这次没保存成功」藏起来。
          右侧三项各自可藏（`appearance.statusBarMetrics`），全藏掉时这里只剩一个空 div，
          宽度为 0，不需要额外判一次。 */}
      {showStatusBar && (
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
            {!hiddenMetrics.includes('lineColumn') && (
              <span className="status-metric" data-status-metric="line-column">
                {t('status.lineColumn', {
                  line: String(selection.line),
                  column: String(selection.column)
                })}
              </span>
            )}
            {!hiddenMetrics.includes('selection') && selection.selectedTextLength > 0 && (
              <span className="status-metric" data-status-metric="selection">
                ({t('status.selected', { count: String(selection.selectedTextLength) })})
              </span>
            )}
            {showCharacterCount && (
              <span className="status-metric" data-status-metric="character-count">
                {t('status.characterCount', { count: String(characterCount) })}
              </span>
            )}
            {!hiddenMetrics.includes('format') && (
              // 专有名词（Workspace / Markdown）不翻译；附件类型由 formatLabel 给出
              <span className="status-metric status-format" data-status-metric="format">
                {formatLabel}
              </span>
            )}
          </div>
        </footer>
      )}
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
      {/* 插入链接的选目标面板。**不跟快速打开一样加 `workspaceRoot` 门槛** ——
          没有工作区时它自己画「索引为空」那一句，比按了没反应好；快速打开那边是历史写法。 */}
      {insertLinkOpen && (
        <InsertLinkPalette onPick={handleInsertLink} onClose={() => setInsertLinkOpen(false)} />
      )}
      {/* 挂在最外层而不是树里：树容器是 `overflow-y: auto`，菜单在那边会被裁掉。
          菜单自己用 `position: fixed` 定位到鼠标处。 */}
      {fileMenu && (
        <ContextMenu
          x={fileMenu.x}
          y={fileMenu.y}
          items={fileMenuItems(fileMenu.node)}
          onClose={() => setFileMenu(null)}
          label={t('workspace.fileMenu')}
        />
      )}
      {/* 改名确认屏。它要「摆出改了谁的什么」，所以自己也挂在外层（与菜单同理，
          树容器会把它裁掉）。`fromName` 取 `filePath` 而不是从索引查 —— 右键那一刻
          拿到的就是磁盘上的名字，而索引可能还没跟上。 */}
      {renamePreview && (
        <RenamePreview
          fromName={getFileName(renamePreview.filePath)}
          toName={renamePreview.newName}
          changes={renamePreview.plan.changes}
          skipped={renamePreview.plan.skipped}
          onConfirm={handleRenameConfirm}
          onCancel={() => setRenamePreview(null)}
        />
      )}
    </div>
  );
};
