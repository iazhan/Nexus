import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { BrowserWindow as BrowserWindowType } from 'electron';
import { parseUserThemes, type UserTheme } from '@nexus/theme';
import {
  ASSET_SCHEME,
  parseLaunchArgs,
  type LaunchContext,
  DOCUMENT_TYPES,
  type DocumentType,
  type FileWatchEvent,
  type GraphQuery,
  type HistoryEntry,
  type Unsubscribe,
  isOrphanMode
} from '@nexus/core';
import { FileService } from './file-service.js';
import { buildDiagnostics } from './diagnostics.js';
import { indexDirectoryForWorkspace, indexPathForWorkspace } from './index-path.js';
import { ASSET_SCHEME_PRIVILEGES, createAssetHandler } from './asset-protocol.js';
import { createElectronFileDialog } from './file-dialog.js';
import { createElectronTrash } from './trash.js';
import { HistoryStore, HISTORY_DIR } from './history-store.js';
import {
  hostCapabilityEnabled,
  hostSettings,
  sanitizeHostSettings,
  updateHostSettings
} from './host-settings.js';
import {
  applyRecentWorkspace,
  EMPTY_RECENT_WORKSPACE,
  readRecentWorkspace,
  writeRecentWorkspace
} from './recent-workspace.js';
import { IndexStore } from './index-store.js';
import { deriveTitle, indexSingleFile, indexWorkspace } from './indexer.js';
import { rewriteReferencesInSource } from './link-rewrite.js';
import { findMentionsOfDocument } from './mentions.js';
import { createProcessorRegistry } from './processor/index.js';
import { checkNow, getUpdateState, installNow, remindLater, setupAutoUpdater, skipVersion, updatesSupported } from './updater.js';
import { loadChangelog } from './changelog.js';
import { forgetWindow, isWindowDirty, markWindowDirty } from './window-dirty.js';
import {
  scanThemeDirectory,
  syncThemeDirectory,
  themeDirectoryPath,
  type ThemeDirectoryScan
} from './theme-directory.js';
import { themeBootPayload } from './theme-boot-payload.js';
import {
  DELETE_MODES,
  IPC_CHANNELS,
  SETTINGS_SECTION_PARAM,
  type CreateDirectoryRequest,
  type CreateFileRequest,
  type DeleteMode,
  type FileWatchIpcPayload,
  type RenameFileChange,
  type RenameFileRequest,
  type RenameFileResult,
  type RenameFileSkip,
  type ThemeBootPayload,
  type ThemeBootRequest,
  type ThemeSyncResult,
  type WindowRole,
  type WindowState
} from '../ipc/channels.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 资源协议（`nexus-asset://`，P3-07）的 privileged 声明。
 *
 * **必须在模块顶层、早于 `app.whenReady()` 调用** —— Electron 只在这个窗口期内
 * 接受 scheme 注册，晚一步注册的 scheme 拿不到 `standard` / `secure` /
 * `supportFetchAPI` 这些特权，症状是请求能到达 handler 但 CSP 与 fetch 行为都对不上，
 * 且没有任何报错。真正的 handler 挂载在 `ensureAssetProtocol`（app ready 之后）。
 */
protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: { ...ASSET_SCHEME_PRIVILEGES } }
]);

/**
 * 已经挂过资源协议 handler 的 session。
 *
 * 同一 scheme 在同一 session 上注册两次会抛，而 `getOrCreateSession` 是**按
 * webContents** 建的 —— 多窗口时同一个 `defaultSession` 会被走到两次。
 * 用 WeakSet 而不是 `protocol.isProtocolHandled()`：我们只关心「本进程挂过没有」，
 * 不依赖 Electron 跨版本行为有变化的查询接口。
 */
const assetProtocolSessions = new WeakSet<Electron.Session>();

/**
 * 在某个 session 上挂载 `nexus-asset://` handler。
 *
 * **复用调用方传进来的 FileService 实例**，不另建一个：边界判据
 * （`checkBoundary` + `assertNoSymlinkEscape`）只有那一份实现，新建实例等于把
 * 授权逻辑复制一份 —— 正是 P3-03 在扩展名表上踩过的坑。
 *
 * 多窗口共用 `defaultSession` 时第一个 service 生效，这是**正确的**：
 * `launchContext`（`workspaceRoot` / `filePath`）是进程级的，所有窗口的根完全相同。
 */
function ensureAssetProtocol(targetSession: Electron.Session, service: FileService): void {
  if (assetProtocolSessions.has(targetSession)) return;
  assetProtocolSessions.add(targetSession);
  targetSession.protocol.handle(ASSET_SCHEME, createAssetHandler(service));
}

/**
 * 判断启动参数里的路径是目录还是文件，决定是否进入 workspace 模式。
 *
 * 刻意用同步 fs 调用：launchContext 在模块顶层求值，而窗口创建依赖它，没法 await。
 * 这里的「同步」是文件系统调用，不受本机「同步进程创建恒 EBUSY」的限制 ——
 * 那条只针对 spawn / exec 系，fs.statSync 正常。
 */
function classifyLaunchPath(targetPath: string): 'directory' | 'file' | 'unknown' {
  try {
    return fs.statSync(targetPath).isDirectory() ? 'directory' : 'file';
  } catch {
    // 路径不存在或没有权限：按 unknown 处理，由调用方降级为「不支持的文件」，
    // 不能因为一次 stat 失败就把用户送进一个空工作区。
    return 'unknown';
  }
}

/**
 * 开发便利：`NEXUS_WORKSPACE` 环境变量直接指定工作区，跳过命令行参数。
 *
 * 为什么需要它：`electron-vite dev` 启动 Electron 时**没有**把额外参数透传给应用的
 * 官方途径（它的 CLI 只认自己的选项），而开发时经常要反复进工作区模式。
 * 生产环境仍然走命令行参数 —— 这里只是给开发期开一条确定的入口，
 * 而且它比「猜 electron-vite 会不会透传」稳得多。
 */
function applyWorkspaceEnvOverride(context: LaunchContext): LaunchContext {
  const fromEnv = process.env.NEXUS_WORKSPACE?.trim();
  if (!fromEnv) return context;

  if (classifyLaunchPath(fromEnv) !== 'directory') {
    console.warn(`[Nexus Shell] NEXUS_WORKSPACE 不是有效目录，已忽略: ${fromEnv}`);
    return context;
  }

  return {
    mode: 'workspace',
    filePath: null,
    documentType: null,
    workspaceRoot: fromEnv,
    unsupportedPath: null
  };
}

/**
 * `userData` 目录。取不到时**整个「最近工作区」功能静默关闭** ——
 * 它只影响「下次启动方不方便」，不值得为它让应用起不来。
 */
function userDataDirectory(): string | null {
  try {
    return app.getPath('userData');
  } catch (error) {
    console.warn('[Nexus Shell] 取不到 userData 目录，本次不记录也不恢复工作区:', error);
    return null;
  }
}

/**
 * 最近工作区落盘的目录。**模块顶层求值**：`launchContext` 要用它，而后者必须在
 * 任何窗口创建之前定下来（见 `recent-workspace.ts` 的头注释）。
 */
const recentWorkspaceDir = userDataDirectory();
const startupState = recentWorkspaceDir
  ? readRecentWorkspace(recentWorkspaceDir)
  : { ...EMPTY_RECENT_WORKSPACE };

// Parse launch arguments upon main process startup
const launchContext: LaunchContext = applyRecentWorkspace(
  applyWorkspaceEnvOverride(
    parseLaunchArgs(process.argv, {
      execPath: process.execPath,
      classifyPath: classifyLaunchPath
    })
  ),
  startupState,
  (targetPath) => classifyLaunchPath(targetPath) === 'directory'
);
console.log('[Nexus Shell] Initialized launch context:', JSON.stringify(launchContext));

/**
 * 记下这次的工作区，供**下一次**启动恢复。
 *
 * 与「要不要恢复」分开：设置关着时照样记。这样用户之后打开那一项，上次的工作区立刻能用 ——
 * 若只在设置开着时才记，用户会看到「打开了设置，但它要等下一次进工作区才有用」。
 */
if (recentWorkspaceDir && launchContext.workspaceRoot) {
  writeRecentWorkspace(recentWorkspaceDir, {
    ...startupState,
    workspaceRoot: launchContext.workspaceRoot
  });
}

/**
 * 用户主题目录（`<home>/.nexus/themes`）。**模块顶层求值**：首帧主题要在任何窗口创建之前
 * 定下来，而它读的就是这个目录（见 `theme-directory.ts` 的头注释）。
 */
const themeDirectory = themeDirectoryPath(os.homedir());

/**
 * 目录快照的缓存。窗口有三个（主 / 设置 / 主题），每个 preload 都会来问一次首帧载荷，
 * 而扫描是同步 IO —— 不缓存的话它会在启动路径上被跑三遍。
 */
let themeDirectoryCache: ThemeDirectoryScan | null = null;

function currentThemeScan(): ThemeDirectoryScan {
  themeDirectoryCache ??= scanThemeDirectory(themeDirectory);
  return themeDirectoryCache;
}

/** 按 id 取并集，**前者优先**（目录是事实源，存档里多出来的那些只是还没落盘）。 */
function mergeThemeLists(primary: readonly UserTheme[], extra: readonly UserTheme[]): UserTheme[] {
  const byId = new Map(primary.map((theme) => [theme.id, theme]));
  for (const theme of extra) {
    if (!byId.has(theme.id)) byId.set(theme.id, theme);
  }
  return [...byId.values()];
}

/**
 * 首帧请求的处理：**目录是主题的事实源**，所以「用哪套主题、要不要注入变量」由主进程算。
 *
 * ## 为什么一次性迁移在这里做
 *
 * 用户主题原本存在渲染进程的 localStorage 里（键 `nexus-user-theme`），主进程读不到 ——
 * 那份存档的**原文**由 preload 带过来。顺序是「读存档 → 写文件 → 确认全部写成功 → 打标记」，
 * **不能反**：先停读再写的话，一次磁盘写失败（权限 / 磁盘满 / 目录被占）就等于用户主题全丢，
 * 且没有撤销。
 *
 * 迁移没成功时**把那几套一并交出去**（它们只是还没落盘）：列表里照样看得见、能选，
 * 下一次启动重试。否则用户会以为主题没了。
 */
function resolveThemeBoot(raw: unknown): ThemeBootPayload {
  const request = (raw ?? {}) as Partial<ThemeBootRequest>;
  const choice = typeof request.choice === 'string' ? request.choice : null;
  const prefersDark = request.prefersDark === true;
  const storedThemes = typeof request.storedThemes === 'string' ? request.storedThemes : null;

  let scan = currentThemeScan();
  const migrated = request.migrated === true;

  if (migrated) {
    return {
      ...themeBootPayload(choice, prefersDark, scan.themes),
      themes: scan.themes,
      broken: scan.broken,
      migrated: true,
      directory: themeDirectory
    };
  }

  const legacy = storedThemes ? parseUserThemes(storedThemes) : [];
  const merged = mergeThemeLists(scan.themes, legacy);
  const result =
    legacy.length > 0
      ? syncThemeDirectory(
          themeDirectory,
          merged,
          scan.themes.map((theme) => theme.id)
        )
      : null;

  if (result && result.failed.length > 0) {
    console.warn('[Nexus Shell] 用户主题写盘失败，本次仍按存档里的那几套走:', result.failed);
    return {
      ...themeBootPayload(choice, prefersDark, merged),
      themes: merged,
      broken: scan.broken,
      migrated: false,
      directory: themeDirectory
    };
  }

  // 写出去了（或本来就没有要写的）：目录才是权威，重扫一次。
  themeDirectoryCache = null;
  scan = currentThemeScan();
  return {
    ...themeBootPayload(choice, prefersDark, scan.themes),
    themes: scan.themes,
    broken: scan.broken,
    migrated: true,
    directory: themeDirectory
  };
}

function getPreloadPath(): string {
  const cjsPath = path.join(__dirname, '../preload/index.cjs');
  if (fs.existsSync(cjsPath)) {
    return cjsPath;
  }
  const mjsPath = path.join(__dirname, '../preload/index.mjs');
  if (fs.existsSync(mjsPath)) {
    return mjsPath;
  }
  return path.join(__dirname, '../preload/index.js');
}

/**
 * 允许交给系统默认程序打开的协议白名单。
 *
 * 主进程必须自己再判一次：渲染进程传来的字符串不可信——即使它已经过 `sanitizeUrl`，
 * 也不能把"净化器放行过"当成"shell.openExternal 可以无条件执行"。少了这道闸，
 * openExternal 就是一个任意协议执行入口（例如 `ms-msdt:`、自定义 handler）。
 */
const EXTERNAL_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function toAllowedExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string' || !rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (!EXTERNAL_URL_PROTOCOLS.has(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * 渲染进程靠这个查询串判断「我该渲染主界面还是设置界面」。
 *
 * 走 URL 而不是 IPC：角色必须在**首帧之前**就确定。`getLaunchContext` 是异步 invoke，
 * 等它回来再决定渲染什么，用户会先看到主界面闪一下再变成设置页。查询串在
 * `main.tsx` 里是同步可读的，零闪烁、零往返。
 *
 * 两个窗口都**显式**带角色（主窗口也带 `window=main`），不靠「没带参数就是主窗口」：
 * 那样两个 URL 无法互相区分，测试里按 URL 找目标就得写「含 index.html 且不含 settings」
 * 这种反向条件，改一个窗口的加载方式就会悄悄失配。
 */
const WINDOW_ROLE_PARAM = 'window';
/** 角色 → `loadFile` 的查询串。四个窗口一张表，加角色只动这里与 `window-role.ts`。 */
const WINDOW_QUERY: Record<WindowRole, Record<string, string>> = {
  main: { [WINDOW_ROLE_PARAM]: 'main' },
  settings: { [WINDOW_ROLE_PARAM]: 'settings' },
  theme: { [WINDOW_ROLE_PARAM]: 'theme' },
  update: { [WINDOW_ROLE_PARAM]: 'update' }
};

/**
 * 把渲染产物装进窗口。三个窗口跑**同一份产物**，只有角色参数不同 ——
 * 另开一个构建目标意味着主题、i18n、设置存档、样式全都要么抽公共包要么抄一遍。
 */
function loadRenderer(
  win: BrowserWindowType,
  role: WindowRole,
  extraQuery: Record<string, string> = {}
): void {
  // 两条路（dev 的 loadURL / 打包的 loadFile）**共用同一份 query**。原先各拼一次，
  // 加参数时漏改一条的症状是「dev 能用、打包不能用」—— 而本地开发跑的正是 dev。
  const query = { ...WINDOW_QUERY[role], ...extraQuery };
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl) {
    win.loadURL(`${devServerUrl}?${new URLSearchParams(query).toString()}`);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'), { query });
  }
}

/**
 * 无边框窗口的「显示时机」。
 *
 * `ready-to-show` 在隐藏窗口下并不保证触发（冷启动 dev 时首次绘制可能不发生），
 * 因此同时监听 `did-finish-load` 并加超时兜底，保证窗口一定可见。
 *
 * 两个窗口都要这一段，所以抽出来 —— 抄两遍的话，将来只给其中一个补了兜底定时器的清理，
 * 另一个就会在窗口销毁后留下一个还在跑的 timer。
 */
function showWhenReady(win: BrowserWindowType): void {
  let shown = false;
  const show = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
    // 无边框窗口不会自动取得键盘焦点，未聚焦时用户输入与自动化按键都会被丢弃。
    win.focus();
  };

  win.once('ready-to-show', show);
  win.webContents.once('did-finish-load', show);
  const fallbackTimer = setTimeout(show, 3000);
  win.once('closed', () => clearTimeout(fallbackTimer));
}

/**
 * 把「最大化状态变了」推给**该窗口自己**。
 *
 * 不能只推给主窗口：自绘的还原图标是每个窗口各自维护的状态，漏推的那个窗口会在最大化之后
 * 一直显示「最大化」图标。同理也不能广播给所有窗口 —— 每个窗口问的是自己的状态。
 */
function broadcastWindowState(win: BrowserWindowType): void {
  const notify = () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(IPC_CHANNELS.windowStateChanged, {
      maximized: win.isMaximized()
    } satisfies WindowState);
  };
  win.on('maximize', notify);
  win.on('unmaximize', notify);
}

function createWindow(): BrowserWindowType {
  const mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 640,
    minHeight: 480,
    show: false,
    // 中性初值：页面加载后会被 renderer 的 document.title 覆盖（它按运行模式设置）。
    // 这里写死「Nexus Lite」会让全量模式在启动的头几百毫秒里挂错标题。
    title: 'Nexus',
    // 无边框窗口：最小化/最大化/关闭由渲染进程自绘，tooltip 才能跟随应用内语言。
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  /**
   * 立刻初始化 session —— 这一步顺带挂上 `nexus-asset://` 协议。
   *
   * **不能等第一次 IPC**（2026-09-27 P3-07 实测踩到）。`getOrCreateSession` 原本
   * 只在 IPC handler 里被调用，注释里的理由是「renderer 要请求资源，必然先经过
   * 一次 IPC 打开文档」。那个假设对 PDF 成立（PDF 由 IPC 打开文档触发），
   * **对图片不成立**：图片 Viewer 可以由**启动参数**直接进入
   * （`nexus photo.png`），renderer 一挂载就请求 `<img src="nexus-asset://…">`，
   * 那时一个 IPC 都还没发生 —— 协议没挂上，请求 `TypeError: Failed to fetch`，
   * 界面上只显示「图片加载失败」。
   *
   * 症状之所以难查，是因为它**只在一条入口上出现**：从文件树点开图片正常，
   * 用启动参数打开永远失败。
   */
  getOrCreateSession(mainWindow.webContents);

  // ready-to-show / did-finish-load / 超时兜底三路兜住「窗口一定可见」，见 showWhenReady。
  showWhenReady(mainWindow);

  // 最大化/还原状态回传，保证自绘按钮图标与窗口实际状态一致。
  broadcastWindowState(mainWindow);

  mainWindow.on('close', async (event) => {
    const isDirty = isWindowDirty(mainWindow.id);
    if (isDirty) {
      event.preventDefault();

      // 在自动化测试环境中通知渲染进程拦截成功，避免原生弹窗阻塞测试执行
      if (process.env.NODE_ENV === 'test') {
        mainWindow.webContents.send('nexus:unsaved-close-prevented');
        return;
      }

      const { response: choice } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['保存', '不保存', '取消'],
        defaultId: 0,
        cancelId: 2,
        title: '未保存的更改',
        message: '当前文档有未保存的更改。是否在退出前保存？'
      });

      if (choice === 0) {
        // 请求渲染进程保存后退出
        mainWindow.webContents.send(IPC_CHANNELS.requestSaveAndClose);
      } else if (choice === 1) {
        // 不保存直接退出
        markWindowDirty(mainWindow.id, false);
        mainWindow.close();
      }
      // choice === 2 取消：已通过 preventDefault 阻止关闭
    }
  });

  // Open external links in user's default browser.
  // 与 openExternal IPC 共用同一份协议白名单，避免两条路径出现两种策略。
  mainWindow.webContents.setWindowOpenHandler((details) => {
    const allowed = toAllowedExternalUrl(details.url);
    if (allowed) {
      void shell.openExternal(allowed);
    }
    return { action: 'deny' };
  });

  // Load renderer
  loadRenderer(mainWindow, 'main');

  // 主窗口没了，设置窗口跟着走。不这么做的话关掉主窗口会留下一个孤立的设置窗口
  // （`window-all-closed` 也就永远不触发，进程不退出）。
  mainWindow.once('closed', () => {
    // 忘掉这个窗口的脏标记。窗口 id 不复用，但残留的 `true` 会让「有没有未保存的更改」
    // 永远为真 —— 那正是更新安装判定「能不能立即重启」的依据。
    forgetWindow(mainWindow.id);
    closeSettingsWindow();
    closeThemeWindow();
    closeUpdateWindow();
  });

  return mainWindow;
}

/** 设置窗口的尺寸。比主窗口小一圈 —— 它没有编辑区要装。 */
const SETTINGS_WINDOW_SIZE = { width: 880, height: 640, minWidth: 560, minHeight: 420 };

/** 当前开着的设置窗口。`null` = 没开。 */
let settingsWindow: BrowserWindowType | null = null;

/**
 * 打开设置窗口，**单例**：已经开着就还原 + 聚焦，不新建。
 *
 * 三条刻意的决定：
 *
 * 1. **不调 `getOrCreateSession()`** —— 设置窗口没有工作区，不读文档、不建索引。
 *    `nexus-asset://` 也不需要单独挂：它与主窗口共用 `defaultSession`，主窗口已经挂过了。
 * 2. **无边框自绘**，与主窗口一致。窗口控制 IPC（最小化 / 最大化 / 关闭）本来就按
 *    `BrowserWindow.fromWebContents(event.sender)` 定位窗口，所以这里不需要任何改动。
 * 3. **关闭即销毁**，不做「隐藏起来复用」。设置窗口没有需要保活的状态 —— 分组停在哪儿
 *    存在 `settings.lastSection` 里，重建一次就能恢复。
 * 4. **`section` 参数只决定「落在哪一组」**，且已开着时会**重新加载**：单例窗口只聚焦
 *    的话分组不会变，用户从活动栏点「在设置中管理」会以为点了没反应。第 3 条
 *    （没有需要保活的状态）正是重载安全的前提。
 */
function createSettingsWindow(section?: string): BrowserWindowType {
  const extraQuery: Record<string, string> = section
    ? { [SETTINGS_SECTION_PARAM]: section }
    : {};

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
    // 指定了分组就重新加载（理由见头注释第 4 条）。
    if (section) loadRenderer(settingsWindow, 'settings', extraQuery);
    return settingsWindow;
  }

  const win = new BrowserWindow({
    ...SETTINGS_WINDOW_SIZE,
    show: false,
    // 中性初值，与主窗口同理：真正的标题由渲染进程按语言设置。
    title: 'Nexus',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  settingsWindow = win;

  showWhenReady(win);
  broadcastWindowState(win);
  win.once('closed', () => {
    settingsWindow = null;
  });

  loadRenderer(win, 'settings', extraQuery);

  return win;
}

function closeSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
  settingsWindow = null;
}

/**
 * 主题窗口的尺寸。比设置窗口宽一倍 —— 它是**左调右看**的两栏工作台，一栏放控件、一栏放结果，
 * 挤在一栏里就得上下滚（那正是它从设置页里搬出来的原因）。
 *
 * 最小宽度按两栏各自的下限之和留：左栏控件最窄 ~520px（16 个取色器两列），右栏预览 ~380px。
 */
const THEME_WINDOW_SIZE = { width: 1340, height: 840, minWidth: 1040, minHeight: 620 };

/** 当前开着的主题窗口。`null` = 没开。 */
let themeWindow: BrowserWindowType | null = null;

/**
 * 打开主题窗口，**单例**：已经开着就还原 + 聚焦。
 *
 * 与设置窗口同构（不调 `getOrCreateSession()`、无边框自绘、关闭即销毁），只有两点不同：
 *
 * 1. **入口在设置窗口里**，所以「重复点」这一种情况要从设置窗口挡 —— 单例判定是唯一手段。
 * 2. **不跟着设置窗口一起关**。主题窗口是完整的工作台（有自己的标题栏与关闭键），用户完全可能
 *    关掉设置、留着它继续调色。它只跟**主窗口**走（见 `createWindow()` 的 `closed`）——
 *    那才是进程生命周期的那一档。
 */
function createThemeWindow(): BrowserWindowType {
  if (themeWindow && !themeWindow.isDestroyed()) {
    if (themeWindow.isMinimized()) themeWindow.restore();
    themeWindow.focus();
    return themeWindow;
  }

  const win = new BrowserWindow({
    ...THEME_WINDOW_SIZE,
    show: false,
    title: 'Nexus',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  themeWindow = win;

  showWhenReady(win);
  broadcastWindowState(win);
  win.once('closed', () => {
    themeWindow = null;
  });

  loadRenderer(win, 'theme');

  return win;
}

function closeThemeWindow(): void {
  if (themeWindow && !themeWindow.isDestroyed()) themeWindow.close();
  themeWindow = null;
}

/**
 * 更新窗口的尺寸。比设置窗口窄一圈 —— 它是一列内容（版本 + 更新日志 + 按钮），没有左栏要装。
 * 高度给得比宽度多：更新日志是纵向滚的。
 */
const UPDATE_WINDOW_SIZE = { width: 720, height: 640, minWidth: 520, minHeight: 480 };

/** 当前开着的更新窗口。`null` = 没开。 */
let updateWindow: BrowserWindowType | null = null;

/**
 * 打开更新窗口，**单例**。与设置窗口同构（不调 `getOrCreateSession()`、无边框自绘、关闭即销毁）。
 *
 * 不跟着设置窗口走，只跟**主窗口**走（同主题窗口）—— 它是「看一眼更新了什么」的短命窗口，
 * 主窗口关掉之后留着它没有意义。
 */
function createUpdateWindow(): BrowserWindowType {
  if (updateWindow && !updateWindow.isDestroyed()) {
    if (updateWindow.isMinimized()) updateWindow.restore();
    updateWindow.focus();
    return updateWindow;
  }

  const win = new BrowserWindow({
    ...UPDATE_WINDOW_SIZE,
    show: false,
    // 中性初值，与主窗口同理：真正的标题由渲染进程按语言设置。
    title: 'Nexus',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  updateWindow = win;

  showWhenReady(win);
  broadcastWindowState(win);
  win.once('closed', () => {
    updateWindow = null;
  });

  loadRenderer(win, 'update');

  return win;
}

function closeUpdateWindow(): void {
  if (updateWindow && !updateWindow.isDestroyed()) updateWindow.close();
  updateWindow = null;
}

/**
 * 内置 `changelog.json` 所在目录。
 *
 * 打包后由 `electron-builder.yml` 的 `extraResources` 放进 `resources/`；
 * dev 下 `app.getAppPath()` 是 `apps/desktop`，而那份文件在**仓库根**（上面两级）——
 * 它同时是「发版时人工维护的那份」与「打包进 resources 的那份」，只有一个事实源。
 */
function changelogDir(): string {
  return app.isPackaged ? process.resourcesPath : path.resolve(app.getAppPath(), '..', '..');
}

interface WebContentsSession {
  service: FileService;
  subscriptions: Map<string, Unsubscribe>;
  /** 工作区根；Lightweight 模式为 null。版本历史需要它来算相对路径。 */
  workspaceRoot: string | null;
}

const sessions = new Map<number, WebContentsSession>();

/**
 * 每个渲染进程持有自己的工作区索引库。
 *
 * 库文件放在 userData 下而不是工作区里：工作区是用户的目录，不该被我们塞进
 * `.nexus/index.db` 之类的东西；而放在 userData 里，用户想重建时删掉它就行，
 * 索引本来就是可以随时重建的派生数据。
 *
 * 文件名用工作区路径的哈希 —— 同一个工作区重复打开会复用同一个库，
 * 不同工作区不会互相覆盖。**路径本身怎么算在 `index-path.ts`**（纯函数，可单测）；
 * 这里只负责把 `userData` 接上去，它是 `app.getPath` 唯一的出现处。
 */
const indexStores = new Map<number, { rootPath: string; store: IndexStore }>();

function indexPathFor(rootPath: string): string {
  return indexPathForWorkspace(app.getPath('userData'), rootPath);
}

function indexDirectoryFor(rootPath: string): string {
  return indexDirectoryForWorkspace(app.getPath('userData'), rootPath);
}

function openIndexStore(webContentsId: number, rootPath: string): IndexStore {
  const existing = indexStores.get(webContentsId);
  if (existing && existing.rootPath === rootPath) {
    return existing.store;
  }

  if (existing) {
    try {
      existing.store.close();
    } catch {
      // 换工作区时旧库关不掉不该阻断新库打开
    }
  }

  const dbPath = indexPathFor(rootPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const store = IndexStore.open(dbPath);
  indexStores.set(webContentsId, { rootPath, store });
  return store;
}

function getIndexStore(webContentsId: number): IndexStore | null {
  return indexStores.get(webContentsId)?.store ?? null;
}

/**
 * 关掉再重开某个渲染进程的索引库。
 *
 * 「重建索引」必须走这里，不能直接复用 `openIndexStore` 的缓存：`ensureSchema()`
 * **只在 open 的时候跑**，而复用一个已经打开的库会跳过版本检查 —— 于是
 * 「改了抽取判据 + bump 了 `SCHEMA_VERSION`」不会触发重建，用户点「重建索引」看到的
 * 还是旧标签（内容没变的文件被 `contentHash` 跳过，那条跳过判据本身是对的）。
 *
 * 版本一致时重开只是白跑一遍检查，一个字节都不会丢 —— 所以对「外部改了文件、
 * 想让索引跟上」那个原本的用途没有任何影响。
 */
function reopenIndexStore(webContentsId: number, rootPath: string): IndexStore {
  const existing = indexStores.get(webContentsId);
  if (existing !== undefined && existing.rootPath === rootPath) {
    try {
      existing.store.close();
    } catch {
      // 关不掉也继续 —— 关键是下面那行 delete，它让下一次 open 重新走一遍 ensureSchema
    }
    indexStores.delete(webContentsId);
  }
  return openIndexStore(webContentsId, rootPath);
}

/**
 * 保存前留一份历史快照。
 *
 * 三件刻意做的事：
 *
 * 1. **在写盘之前读旧内容** —— 覆盖之后读到的就是新内容，历史会失去意义。
 * 2. **失败不影响保存** —— 历史是附加能力，它出问题不该让用户的保存失败。
 * 3. **内容没变就直接返回** —— `HistoryStore.record` 内部也按哈希去重，
 *    这里先挡一道是因为「读整个旧文件」本身有 IO 成本，能省则省。
 *
 * 上限（每个文档留几份）也在这里传给 `record`。**它由 `record` 自己去重后修剪**，
 * 所以这里不额外判一次 —— 两处各判一次的话，「把上限调小」在两条路径上会表现不一致。
 *
 * Lightweight 模式没有工作区，也就没有「相对于工作区的路径」，直接跳过。
 */
function recordHistory(session: WebContentsSession, filePath: string, content: string): void {
  const root = session.workspaceRoot;
  if (!root) return;

  try {
    // 新文件没有「旧内容」可留
    if (!fs.existsSync(filePath)) return;

    const previous = fs.readFileSync(filePath, 'utf8');
    if (previous === content) return;

    const relativePath = path.relative(root, filePath).replace(/\\/g, '/');
    // 在工作区之外（或正好是根）就不留 —— 历史是按工作区组织的
    if (!relativePath || relativePath.startsWith('..')) return;

    // 上限来自渲染进程（本机偏好存在那边），走宿主设置通道过来。
    // 没收到过就是 `null` ＝ 不清理，方向安全。
    new HistoryStore(root).record(relativePath, previous, hostSettings().historyRetention);
  } catch (err) {
    console.error('[Nexus Shell] 留历史快照失败（不影响保存）:', err);
  }
}

/**
 * 从 IPC 事件推出「工作区根 + 文档相对路径」。
 *
 * 三个历史相关的 handler 都要这一步，抽出来免得各写一遍 ——
 * 而且「不在工作区内就返回 null」这条判断只该有一处。
 */
function historyTarget(
  event: Electron.IpcMainInvokeEvent,
  documentPath: unknown
): { session: WebContentsSession; root: string; relativePath: string } | null {
  if (typeof documentPath !== 'string' || documentPath.length === 0) return null;

  const session = getOrCreateSession(event.sender);
  const root = session.workspaceRoot;
  if (!root) return null;

  const relativePath = path.relative(root, documentPath).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('..')) return null;

  return { session, root, relativePath };
}

/**
 * 忘掉某文档的全部版本历史。**只该在永久删除之后调用** —— 回收站分支刻意不动历史，
 * 那正是「可逆」的一半（文件恢复到同一路径时，历史也就跟着回来了）。
 *
 * 与 `recordHistory` 对称：那个在写盘前留一份，这个在删掉后全部忘掉。
 *
 * 注意它用的是 `historyTarget`，而那个函数只做路径运算、**不碰文件系统** ——
 * 所以在这里「文件已经不存在了」不影响它算得出相对路径。
 *
 * 失败只记日志：文件已经删掉了，一个删不掉的历史目录不该把整次删除变成「失败」，
 * 那会让用户重试，而重试只会撞上「文件不存在」。
 */
function forgetHistory(event: Electron.IpcMainInvokeEvent, documentPath: unknown): void {
  const target = historyTarget(event, documentPath);
  if (!target) return;

  try {
    new HistoryStore(target.root).forget(target.relativePath);
  } catch (err) {
    console.error('[Nexus Shell] 清理历史失败（不影响删除）:', err);
  }
}

/** 参数不是合法条目时抛错 —— 静默返回空数组会让 UI 显示「没有历史」。 */
function requireEntry(value: unknown): HistoryEntry {
  if (typeof value !== 'object' || value === null) {
    throw new Error('历史条目格式不正确');
  }

  const entry = value as Partial<HistoryEntry>;
  if (typeof entry.savedAt !== 'string' || typeof entry.hash !== 'string') {
    throw new Error('历史条目缺少 savedAt / hash');
  }

  return { savedAt: entry.savedAt, hash: entry.hash, sizeBytes: entry.sizeBytes ?? 0 };
}

ipcMain.handle(IPC_CHANNELS.listHistory, (event, documentPath: unknown) => {
  const target = historyTarget(event, documentPath);
  if (!target) return [];

  return new HistoryStore(target.root).list(target.relativePath);
});

ipcMain.handle(IPC_CHANNELS.readHistory, (event, documentPath: unknown, entry: unknown) => {
  const target = historyTarget(event, documentPath);
  if (!target) throw new Error('readHistory: 文档不在工作区内');

  return new HistoryStore(target.root).read(target.relativePath, requireEntry(entry));
});

ipcMain.handle(
  IPC_CHANNELS.restoreHistory,
  async (event, documentPath: unknown, entry: unknown) => {
    const target = historyTarget(event, documentPath);
    if (!target) throw new Error('restoreHistory: 文档不在工作区内');

    const { session, root, relativePath } = target;
    const content = new HistoryStore(root).read(relativePath, requireEntry(entry));

    // **覆盖之前把当前内容也留一份** —— 恢复因此是可逆的：
    // 万一恢复了不该恢复的版本，用户还能从历史里把恢复前的内容找回来。
    // 这里复用保存路径的同一个函数，语义完全一致。
    recordHistory(session, documentPath as string, content);

    await session.service.writeFile(documentPath as string, content);
  }
);

/**
 * 删除一个文件。`mode` 收 `unknown` 后自己校验 —— 跨了进程边界，编译期形状不作数。
 *
 * **认不出的值按回收站处理，而不是报错。** 报错会让一次误传变成「删不掉」，
 * 而按回收站处理最坏也只是「用户以为永久删了、其实还能从回收站找回」——
 * 两个方向里只有后者是可恢复的（同 `DeleteMode` 的注释、同 `parseHistoryRetention`）。
 *
 * 永久删除那一支会**连版本历史一起忘掉**：两条分支各自的语义要自洽，
 * 「永久删除 = 什么都不留」。回收站分支刻意不动历史。
 */
ipcMain.handle(IPC_CHANNELS.deleteFile, async (event, filePath: unknown, mode: unknown) => {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('deleteFile: filePath 必须是非空字符串');
  }

  const resolved: DeleteMode = DELETE_MODES.includes(mode as DeleteMode)
    ? (mode as DeleteMode)
    : 'trash';

  const session = getOrCreateSession(event.sender);
  await session.service.deleteFile(filePath, resolved);

  // 索引里的记录一并去掉，否则树、标签、图谱都还认为它存在（**索引是派生数据**，
  // 但派生的时机是「重建索引」，而删一个文件不该逼着用户重建一次全量）。
  //
  // `removeDocuments` 按**绝对路径精确匹配**，而这里收的就是索引自己写进去的那条路径
  // —— 渲染进程是从 `listIndexedDocuments` 拿到的，两边字符串一致。
  // 索引还没建过时 `getIndexStore` 返回 `null`，那时本来就没有记录要清。
  getIndexStore(event.sender.id)?.removeDocuments([filePath]);

  // 放在删除**之后**：删失败时历史必须原样留着，否则用户既没了文件也没了历史。
  if (resolved === 'permanent') {
    forgetHistory(event, filePath);
  }
});

/**
 * 校验「新建」类请求。**认不出的字段一律抛错，不猜。**
 *
 * 与 `requireRenameRequest` 同一形状：跨进程传来的都是 `unknown`，先收窄再使用。
 * 这里不做文件名合法性校验 —— 那件事的判据在 `FileService`（`assertRenameableName`
 * 与 `normalizeNewFileName`），在门口再写一份只会多一处会漂的规则。
 */
function requireCreateRequest<T extends { rootPath: string; directoryPath: string }>(
  value: unknown,
  label: string
): T {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${label}: 请求格式不正确`);
  }

  const request = value as Partial<T>;
  if (typeof request.rootPath !== 'string' || request.rootPath.length === 0) {
    throw new Error(`${label}: rootPath 必须是非空字符串`);
  }
  if (typeof request.directoryPath !== 'string' || request.directoryPath.length === 0) {
    throw new Error(`${label}: directoryPath 必须是非空字符串`);
  }

  return request as T;
}

/**
 * 列出工作区里所有目录。**跳过规则与索引取同一份宿主设置** ——
 * 两处不一致的症状是「索引跳过了 `.git`、树里却看得见」，而谁对说不清。
 */
ipcMain.handle(IPC_CHANNELS.listWorkspaceDirectories, async (event, rootPath: unknown) => {
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    throw new Error('listWorkspaceDirectories: 需要非空的工作区路径');
  }

  const service = getOrCreateSession(event.sender).service;
  return service.listWorkspaceDirectories(rootPath, {
    ignoreRules: hostSettings().ignoreRules
  });
});

/**
 * 新建一个空的 Markdown 文件，并**当场**把它写进索引。
 *
 * 为什么必须当场写索引：树、搜索、标签、图谱都从索引读，而索引只在「重建」时更新。
 * 不补这一下的话，新建的文件在下次重建之前搜不到、不进图谱 —— 而重建可能要等到
 * 用户重开工作区。删除那条路早就这么做了（`removeDocuments` 就地清一条），
 * **新建是它的镜像**。
 *
 * 索引写失败**不让整个新建失败**：文件已经在磁盘上了，报错会让用户以为没建成，
 * 然后再建一次 —— 而第二次会撞 `EEXIST`。索引是派生数据，下次重建会自己追上。
 */
ipcMain.handle(IPC_CHANNELS.createFile, async (event, value: unknown) => {
  const request = requireCreateRequest<CreateFileRequest>(value, 'createFile');
  const session = getOrCreateSession(event.sender);

  const created = await session.service.createFile(request.directoryPath, request.fileName);

  const store = getIndexStore(event.sender.id);
  if (store) {
    try {
      await indexSingleFile({
        service: session.service,
        store,
        rootPath: request.rootPath,
        filePath: created
      });
    } catch (err) {
      console.error('[Nexus] 新建文件已落盘，但写入索引失败:', created, err);
    }
  }

  return created;
});

/** 新建一个子目录。索引不用动 —— 索引里只有文件。 */
ipcMain.handle(IPC_CHANNELS.createDirectory, async (event, value: unknown) => {
  const request = requireCreateRequest<CreateDirectoryRequest>(value, 'createDirectory');
  const session = getOrCreateSession(event.sender);

  return session.service.createDirectory(request.directoryPath, request.name);
});

/**
 * 校验渲染进程传来的重命名请求。**认不出的字段一律按最保守的一档处理，不猜。**
 */
function requireRenameRequest(value: unknown): RenameFileRequest {
  if (typeof value !== 'object' || value === null) {
    throw new Error('renameFile: 请求格式不正确');
  }

  const request = value as Partial<RenameFileRequest>;
  if (typeof request.filePath !== 'string' || request.filePath.length === 0) {
    throw new Error('renameFile: filePath 必须是非空字符串');
  }
  if (typeof request.newName !== 'string' || request.newName.trim().length === 0) {
    throw new Error('renameFile: newName 必须是非空字符串');
  }

  return {
    filePath: request.filePath,
    newName: request.newName,
    // 认不出的值回落 **false** ＝ 不改正文。这是一次「改别人文件」的动作，
    // 失败方向必须是「不做」—— 与 `DeleteMode` 认不出落 `trash` 是同一条判据。
    updateLinks: request.updateLinks === true,
    skipPaths: Array.isArray(request.skipPaths)
      ? request.skipPaths.filter((item): item is string => typeof item === 'string')
      : [],
    dryRun: request.dryRun === true
  };
}

/**
 * 把 IPC 传来的图谱查询收敛成一个可信对象。
 *
 * 与 `requireRenameRequest` 的取舍**相反**：那个认不出就抛错（改别人文件，失败方向必须是不做），
 * 这里认不出一律**当没传**。原因是这个查询只影响「看什么」，不写任何东西 ——
 * 一个坏值让它退回全图，用户至少还看得到东西；抛错则会把整个图谱面板打挂。
 *
 * `types` 里认不出的字符串直接丢掉，但**保留「数组为空」这个事实**：那是用户把类型开关
 * 全关掉的意思，结果就是一张空图。渲染进程那边有「显示全部」的出路，所以空图是可达的
 * 正常状态，不该被悄悄改成「不过滤」。
 */
function readGraphQuery(value: unknown): GraphQuery {
  if (typeof value !== 'object' || value === null) return {};
  const query = value as Partial<GraphQuery>;

  const centerPath =
    typeof query.centerPath === 'string' && query.centerPath.length > 0
      ? query.centerPath
      : undefined;

  const degrees =
    typeof query.degrees === 'number' && Number.isFinite(query.degrees) && query.degrees >= 0
      ? Math.min(Math.floor(query.degrees), 10)
      : undefined;

  const types = Array.isArray(query.types)
    ? query.types.filter((item): item is DocumentType => DOCUMENT_TYPES.includes(item as DocumentType))
    : undefined;

  return { centerPath, degrees, types };
}

/** 绝对路径 → 工作区相对路径（正斜杠）。没有工作区或在工作区之外时返回 `null`。 */
function relativeInWorkspace(root: string | null, filePath: string): string | null {
  if (!root) return null;
  const relativePath = path.relative(root, filePath).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('..')) return null;
  return relativePath;
}

/**
 * 重命名一个文件，并按需回写指向它的引用。
 *
 * ## 一条通道同时承担「试算」与「执行」
 *
 * `dryRun: true` 时只读盘、算计划、原样返回，**一个字节都不写**。分两条通道的话，
 * 「预览用的计划」与「执行时重算的计划」会变成两份可能漂的代码，而它们必须完全一致
 * —— 用户看到的和实际发生的对不上，比不给预览更糟。
 *
 * ## 回写的三条不变量要求（蓝图 §10.2 的口径）
 *
 * ① **语义不变** —— 改的是写法不是指向，判定用 `resolveWikiLink`（与「能不能跳转」
 * 同一套），附件用 `resolveWorkspacePath`（与索引期同一套）。
 * ② **可预览** —— `dryRun` 把每篇的 `before` / `after` 全文交给渲染进程画 diff。
 * ③ **可回退** —— 写盘前 `recordHistory`，改前的内容进版本历史；历史目录跟着改名搬。
 *
 * ## 两处「不做什么」
 *
 * - **索引只改被改名那一行，不重算被回写文档的正文。** 后者与「用户自己编辑并保存」
 *   是同一件事，而那条路径同样不重算（索引在侧栏挂载 / 手动重建时才刷新）。
 *   为改名单独引入第二种刷新机制会让「索引什么时候是准的」变得说不清。
 *   被改名那一行必须改 —— 它的 `path` 已经指向一个不存在的文件了。
 * - **索引还没建过时不回写。** 没有文档列表就判定不了「这条引用指向谁」，
 *   而猜着改正是这条功能最该避免的失败方式。
 */
ipcMain.handle(IPC_CHANNELS.renameFile, async (event, raw: unknown) => {
  const request = requireRenameRequest(raw);
  const session = getOrCreateSession(event.sender);
  const store = getIndexStore(event.sender.id);
  const root = session.workspaceRoot;

  // 目标路径先算出来（含全部校验，不改盘）—— 预览要看到的就是它
  const targetPath = await session.service.resolveRenameTarget(request.filePath, request.newName);

  const fromRelative = relativeInWorkspace(root, request.filePath);
  const toRelative = relativeInWorkspace(root, targetPath);
  const documents = store?.listDocuments() ?? [];
  const skipKeys = new Set(request.skipPaths.map((item) => item.toLowerCase()));

  const changes: RenameFileChange[] = [];
  const skipped: RenameFileSkip[] = [];

  if (request.updateLinks && fromRelative !== null && toRelative !== null) {
    for (const document of documents) {
      // 附件没有正文可改
      if (document.type !== 'markdown') continue;

      let before: string;
      try {
        before = await session.service.readFile(document.path);
      } catch {
        // 读不动就跳过（权限、扫描途中被删）—— 不改比改错好
        continue;
      }

      const rewritten = rewriteReferencesInSource(
        before,
        document.relativePath,
        fromRelative,
        toRelative,
        documents
      );

      for (const target of rewritten.unresolved) {
        skipped.push({ relativePath: document.relativePath, reason: 'unresolved', target });
      }
      if (rewritten.count === 0) continue;

      // 有未保存修改的文档**照样读、照样算计划**，只是不写盘。这样报告才准确 ——
      // 否则「N 篇文档有未保存的修改」里会混进一堆本来就没有引用的文档，
      // 而「读」是只读的，没有任何风险。
      if (skipKeys.has(document.path.toLowerCase())) {
        skipped.push({ relativePath: document.relativePath, reason: 'dirty' });
        continue;
      }

      changes.push({
        path: document.path,
        relativePath: document.relativePath,
        before,
        after: rewritten.text
      });
    }
  }

  if (request.dryRun) {
    const plan: RenameFileResult = { renamed: null, changes, skipped };
    return plan;
  }

  // 真的改：先改名 → 再搬历史 → 最后逐篇写回。
  const renamedPath = await session.service.renameFile(request.filePath, request.newName);

  // 历史按相对路径组织，改名后不搬目录的话「可回退」这条路自己就断了。
  // 必须在写回之前：被改名那篇自己的快照要落在**新**路径下。
  if (root && fromRelative !== null && toRelative !== null && fromRelative !== toRelative) {
    try {
      new HistoryStore(root).rename(fromRelative, toRelative);
    } catch (err) {
      console.error('[Nexus Shell] 搬历史目录失败（不影响改名）:', err);
    }
  }

  const applied: RenameFileChange[] = [];

  for (const change of changes) {
    // 被改名的那一篇已经换了路径，写回要落到新路径上
    const target =
      change.path.toLowerCase() === request.filePath.toLowerCase() ? renamedPath : change.path;

    let current: string;
    try {
      current = await session.service.readFile(target);
    } catch {
      skipped.push({ relativePath: change.relativePath, reason: 'changed' });
      continue;
    }

    // 预览之后、执行之前被别人改了 —— 跳过。防的是「预览开着的时候用户在别的
    // 编辑器里改了那篇文档」，而这条校验的成本极低（内容本来就在手里）。
    if (current !== change.before) {
      skipped.push({ relativePath: change.relativePath, reason: 'changed' });
      continue;
    }

    try {
      // 传 `after` 而不是 `current`：`recordHistory` 的语义是「即将写入 `content`，
      // 先把盘上的旧内容留一份」。传 `current` 会命中它自己的「内容没变」短路，
      // 一个快照都不会留 —— 那正是「可回退」这一条悄悄失效的方式。
      recordHistory(session, target, change.after);
      await session.service.writeFile(target, change.after);
      applied.push(change);
    } catch (err) {
      console.error('[Nexus Shell] 回写引用失败:', err);
      skipped.push({ relativePath: change.relativePath, reason: 'failed' });
    }
  }

  // 索引那一行**就地**改，`id` 保持不变（见 `IndexStore.renameDocument`）。
  // 不改的话树、标签页、图谱都还指着旧路径，而旧路径已经不存在了。
  const newName = path.basename(renamedPath);
  if (store && toRelative !== null) {
    store.renameDocument(request.filePath, renamedPath, toRelative, newName, deriveTitle(newName));
  }

  const result: RenameFileResult = {
    renamed: {
      from: request.filePath,
      to: renamedPath,
      relativePath: toRelative ?? newName
    },
    changes: applied,
    skipped
  };
  return result;
});

/**
 * 打开版本历史目录。**路径由主进程拼**，不接受渲染进程给的目录 —— 这里做的是「打开一个文件夹」，
 * 交给渲染进程指定等于把「打开任意路径」的能力开放出去。
 *
 * 目录不存在（工作区里从未保存过任何版本）返回 `false` 而不是抛：那是正常状态，
 * 抛异常会让设置页把「还没写过东西」显示成一次失败。
 */
ipcMain.handle(IPC_CHANNELS.openHistoryDirectory, async (event, rootPath: unknown) => {
  if (typeof rootPath !== 'string' || rootPath.trim() === '') return false;

  const { service } = getOrCreateSession(event.sender);
  const authorizedRoots = service.getWorkspaceRoots();
  if (!authorizedRoots.some((root) => path.resolve(root) === path.resolve(rootPath))) {
    throw new Error('openHistoryDirectory: 该工作区尚未授权');
  }

  const historyDir = path.join(rootPath, HISTORY_DIR);
  if (!fs.existsSync(historyDir)) return false;

  // `shell.openPath` 用**返回的字符串**报错（空串才是成功），不抛。
  const failure = await shell.openPath(historyDir);
  return failure === '';
});

/**
 * 打开用户主题目录。**路径由主进程拼**，不接受渲染进程给的目录（同 `openHistoryDirectory`）。
 *
 * 目录不存在时**先建出来**：这个入口的典型用法就是「第一次进来看看该把文件放哪」，
 * 返回 `false` 会让用户以为这个功能坏了。建不出来才返回 `false`。
 */
ipcMain.handle(IPC_CHANNELS.openThemeDirectory, async () => {
  try {
    fs.mkdirSync(themeDirectory, { recursive: true });
  } catch {
    return false;
  }

  // `shell.openPath` 用**返回的字符串**报错（空串才是成功），不抛。
  return (await shell.openPath(themeDirectory)) === '';
});

/**
 * 应用版本号。
 *
 * `app.getVersion()` 读的是**应用目录**的 `package.json`（打包后是安装包里的那一份），
 * 所以界面显示的版本与用户装的那个包一定一致 —— 这也是不让渲染进程自己拼一个版本号的原因。
 *
 * 没有参数、不查授权：它不是路径，不泄露任何东西。
 */
ipcMain.handle(IPC_CHANNELS.getAppVersion, () => app.getVersion());

/**
 * 这个构建有没有更新通道。设置页的「检查更新」按钮据此禁用并说明原因 ——
 * 未打包时（`electron-vite dev`）包里没有 `app-update.yml`，点下去只会失败。
 */
ipcMain.handle(IPC_CHANNELS.canCheckUpdates, () => updatesSupported());

/**
 * 手动检查更新。走 `handle` 而不是 `on`：界面要在等待期间禁用按钮（防连点），
 * 而它需要能等到这次检查真的开始。
 *
 * **返回检查之后的状态快照** —— 界面直接拿它刷新，不必再问一次 `getUpdateState`。
 * 错误不往外抛（见 `checkNow`）：抛出去在渲染进程那边没有落点，用户会看到「点了没反应」。
 */
ipcMain.handle(IPC_CHANNELS.checkForUpdates, () => checkNow());

/** 当前更新状态。窗口打开时先取一次，之后靠 `updateStateChanged` 广播跟进。 */
ipcMain.handle(IPC_CHANNELS.getUpdateState, () => getUpdateState());

/** 跳过某个版本。传的是**版本号** —— 理由见 `skipVersion` 的注释。 */
ipcMain.handle(IPC_CHANNELS.skipUpdateVersion, (_event, version: unknown) =>
  skipVersion(typeof version === 'string' ? version : '')
);

/** 稍后提醒。有期限，到期自动恢复提示。 */
ipcMain.handle(IPC_CHANNELS.remindUpdateLater, () => remindLater());

/**
 * 立即重启并安装。**返回是否真的发起了重启** —— 有未保存文档时是 `false`，
 * 界面据此提示「先保存再退出」，而不是让用户以为点了没反应。
 */
ipcMain.handle(IPC_CHANNELS.installUpdateNow, () => installNow());

/** 打开更新窗口（单例）。入口有两处：主窗口的提示条、设置页的版本行。 */
ipcMain.handle(IPC_CHANNELS.openUpdateWindow, () => {
  createUpdateWindow();
});

/**
 * 更新日志。**在主进程拉**：渲染进程的 CSP `connect-src` 没有 `https:`，发不出外部请求。
 *
 * 三层回落（远端文件 → 内置文件 → GitHub Releases notes）见 `electron/changelog.ts`。
 * 不做缓存：这条通道只在更新窗口打开时调一次，而缓存要额外处理失效，代价大于收益。
 */
ipcMain.handle(IPC_CHANNELS.getChangelog, () => loadChangelog({ dir: changelogDir() }));

/**
 * 诊断信息。用户报问题时贴出来的一段事实。
 *
 * **不接受参数**（与 `getAppVersion` 同理，但理由不同）：工作区根由主进程从自己的会话里取，
 * 所以没有「拿一个任意路径来问」的口子 —— `getIndexPath` 那种带参数的通道才需要查授权。
 *
 * **不打开索引库**：`better-sqlite3` 的 `new Database(path)` 会创建库文件，而设置页里看一眼
 * 诊断就凭空多出一个 `.db` 是说不通的副作用。所以索引那部分只有文件系统事实（在不在、多大、
 * 什么时候改的），文档数不在这里 —— 那个在侧栏看得到。
 *
 * `process.versions.electron` / `.chrome` 在渲染进程里也存在，但**这里才是权威的**：
 * 渲染进程报的是它自己那个进程的运行时，用户装的那个包以主进程为准。
 */
ipcMain.handle(IPC_CHANNELS.getDiagnostics, (event) => {
  const { service } = getOrCreateSession(event.sender);
  const workspaceRoot = service.getWorkspaceRoots()[0] ?? null;

  return buildDiagnostics({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron ?? 'unknown',
    chromium: process.versions.chrome ?? 'unknown',
    node: process.versions.node,
    workspaceRoot,
    indexDbPath: workspaceRoot ? indexPathFor(workspaceRoot) : null
  });
});

/**
 * 该工作区的索引库**文件**路径。与下面那条是同一个库的两半：这个只把路径交出去，
 * 不打开任何东西。
 *
 * **仍然要查授权** —— 返回值里含 `userData` 的绝对路径。不查的话，任何渲染进程都能
 * 拿一个任意字符串问出「你的用户数据目录在哪」。
 *
 * 目录不存在也照常返回：路径是工作区路径的**纯函数**，索引还没建时它照样是
 * 「将来会建在这里」，而那正是用户想知道的。这一点与 `openIndexDirectory` 刻意不同 ——
 * 那个要真的打开一个目录，目录不在就没得开。
 */
ipcMain.handle(IPC_CHANNELS.getIndexPath, async (event, rootPath: unknown) => {
  if (typeof rootPath !== 'string' || rootPath.trim() === '') return null;

  const { service } = getOrCreateSession(event.sender);
  const authorizedRoots = service.getWorkspaceRoots();
  if (!authorizedRoots.some((root) => path.resolve(root) === path.resolve(rootPath))) {
    throw new Error('getIndexPath: 该工作区尚未授权');
  }

  return indexPathFor(rootPath);
});

/**
 * 打开索引库目录。
 *
 * 与上面那条同一套纪律：**路径由主进程拼**，不接受渲染进程给的目录。索引落在 `userData` 下
 * （`indexPathForWorkspace` 用工作区路径的哈希做文件名），所以这里取它的父目录 ——
 * 用户想看的是「这个工作区的库文件在不在、多大」，不是某个 `.db`。
 *
 * 目录不存在（这个工作区还没建过索引）返回 `false`，不抛：那是正常状态。
 */
ipcMain.handle(IPC_CHANNELS.openIndexDirectory, async (event, rootPath: unknown) => {
  if (typeof rootPath !== 'string' || rootPath.trim() === '') return false;

  const { service } = getOrCreateSession(event.sender);
  const authorizedRoots = service.getWorkspaceRoots();
  if (!authorizedRoots.some((root) => path.resolve(root) === path.resolve(rootPath))) {
    throw new Error('openIndexDirectory: 该工作区尚未授权');
  }

  const indexDir = indexDirectoryFor(rootPath);
  if (!fs.existsSync(indexDir)) return false;

  const failure = await shell.openPath(indexDir);
  return failure === '';
});

function getOrCreateSession(webContents: Electron.WebContents): WebContentsSession {  let session = sessions.get(webContents.id);
  if (!session) {
    const browserWindow = BrowserWindow.fromWebContents(webContents) ?? undefined;
    const dialog = createElectronFileDialog(browserWindow);

    /**
     * 轻量模式下，被打开文档**所在的那一层目录**是它的资源边界（P3-07）。
     *
     * Markdown 里的 `![](./assets/a.png)` 是相对文档自身解析的，所以「文档所在目录」
     * 就是它引用得到的资源范围。没有这一条，`nexus-asset://` 会把每一张内嵌图片
     * 都判成 `OUT_OF_BOUNDS` —— 因为轻量模式的 `allowedPaths` 只含被打开的那一个 `.md`。
     *
     * **只在没有工作区时登记**：工作区模式下 `workspaceRoots` 已经覆盖了文档所在目录，
     * 再登记一次没有收益，却会让「工作区外的文件也能被打开」这种异常情形顺带
     * 获得一个资源根。条件写出来比「反正冗余」更好读。
     *
     * 它是 `assetRoots` 而不是 `allowedPaths`：**这个集合本身不授权写**，轻量模式下
     * 可编辑的文件仍然只有用户打开的那一个。唯一的写入口子是 `saveAttachment`，
     * 而它写什么是 API 形状决定的（`<文档目录>[/<子目录>]/<算好的名字>.<扩展名>`），
     * 调用方指定不了任意路径 —— 附件必须落在资源通道读得到的地方，见 `file-service.ts`。
     */
    const assetRoots =
      !launchContext.workspaceRoot && launchContext.filePath
        ? [path.dirname(launchContext.filePath)]
        : [];

    const service = new FileService({
      dialog,
      trash: createElectronTrash(),
      allowedPaths: launchContext.filePath ? [launchContext.filePath] : [],
      workspaceRoots: launchContext.workspaceRoot ? [launchContext.workspaceRoot] : [],
      assetRoots
    });

    // 构造函数不能 await，只登记了字符串层面的根；realpath 层面必须在这里补一次，
    // 否则「工作区内的符号链接指向外部」那条防护不会生效。
    if (launchContext.workspaceRoot) {
      void service.authorizeWorkspace(launchContext.workspaceRoot).catch((err) => {
        console.error('[Nexus Shell] 授权工作区失败:', err);
      });
    }

    // 资源根同理补一次 realpath：轻量模式下 `realRoots` 本来会是空的，
    // 于是 `assertNoSymlinkEscape` 整条不生效。补上之后，文档目录里的链接
    // 指向目录外也会被拒。失败不致命（字符串边界已经在构造函数里生效）。
    for (const assetRoot of assetRoots) {
      void service.authorizeAssetRoot(assetRoot).catch((err) => {
        console.error('[Nexus Shell] 授权资源根失败:', err);
      });
    }

    session = {
      service,
      subscriptions: new Map(),
      workspaceRoot: launchContext.workspaceRoot ?? null
    };
    sessions.set(webContents.id, session);

    // 资源通道（图片与 PDF 都走 `nexus-asset://`）挂在这里，是因为只有这里才拿得到
    // 「与读写 Markdown 同一个」FileService 实例 —— 换一个实例会让协议看到一套
    // 边界授权状态、IPC 看到另一套。
    //
    // **但触发时机不能只靠 IPC**：`createWindow` 会在窗口建好后主动调一次本函数。
    // 原先注释里的「renderer 要请求资源必然先经过一次 IPC」对 PDF 成立、对图片
    // 不成立（图片 Viewer 可由启动参数直接进入），见 `createWindow` 里的说明。
    ensureAssetProtocol(webContents.session, service);

    const cleanup = () => {
      const current = sessions.get(webContents.id);
      if (current) {
        for (const unsub of current.subscriptions.values()) {
          try {
            unsub();
          } catch {
            // 避免单个注销错误阻断整体清理
          }
        }
        current.subscriptions.clear();
        sessions.delete(webContents.id);
      }

      const indexEntry = indexStores.get(webContents.id);
      if (indexEntry) {
        try {
          indexEntry.store.close();
        } catch {
          // 关库失败不影响渲染进程的其余清理
        }
        indexStores.delete(webContents.id);
      }
    };

    webContents.once('destroyed', cleanup);
    webContents.on('render-process-gone', cleanup);
  }
  return session;
}

// 注册 typed IPC 处理器
ipcMain.handle(IPC_CHANNELS.getLaunchContext, () => {
  return launchContext;
});

ipcMain.handle(IPC_CHANNELS.openFile, async (event, filePath?: string) => {
  const session = getOrCreateSession(event.sender);
  return await session.service.openFile(filePath);
});

/**
 * 打开一个工作区：给了路径就用它，没给就弹目录选择框。取消返回 `null`。
 *
 * 授权在 `FileService.openWorkspace` 里做；这里补上它做不到的那一半 —— 把结果记成
 * 「下次启动的回落目标」。**重读**文件再写，而不是用模块加载时那份 `startupState`：
 * 后者是启动那一刻的快照，而「用户刚刚打开了哪个目录」发生在之后，两者之间渲染进程
 * 已经同步过一次设置 —— 拿旧快照覆盖会把那次同步抹掉。
 */
ipcMain.handle(IPC_CHANNELS.openWorkspace, async (event, rootPath: unknown) => {
  if (rootPath !== undefined && rootPath !== null && typeof rootPath !== 'string') {
    throw new Error('openWorkspace: rootPath 必须是非空字符串或省略');
  }

  const session = getOrCreateSession(event.sender);
  const root = await session.service.openWorkspace(
    typeof rootPath === 'string' && rootPath.length > 0 ? rootPath : null
  );
  if (!root) return null;

  session.workspaceRoot = root;
  if (recentWorkspaceDir) {
    writeRecentWorkspace(recentWorkspaceDir, {
      ...readRecentWorkspace(recentWorkspaceDir),
      workspaceRoot: root
    });
  }
  return root;
});

ipcMain.handle(IPC_CHANNELS.openExternal, async (_event, url: unknown) => {
  const allowed = toAllowedExternalUrl(url);
  if (!allowed) return false;
  try {
    await shell.openExternal(allowed);
    return true;
  } catch (err) {
    console.error('[Nexus Shell] Failed to open external URL:', err);
    return false;
  }
});

ipcMain.handle(IPC_CHANNELS.copyText, (_event, text: unknown) => {
  // 只接受字符串。写剪贴板是系统级副作用，不接受任何形状不明的输入 ——
  // 一个对象被 `writeText` 静默转成 `[object Object]` 的话，用户粘出来的是垃圾。
  if (typeof text !== 'string') return false;
  clipboard.writeText(text);
  return true;
});

ipcMain.handle(IPC_CHANNELS.readFile, async (event, filePath: string) => {
  const session = getOrCreateSession(event.sender);
  return await session.service.readFile(filePath);
});

ipcMain.handle(IPC_CHANNELS.writeFile, async (event, filePath: string, content: string) => {
  const session = getOrCreateSession(event.sender);

  // 写盘**之前**留历史 —— 覆盖之后再读就拿到新内容了。
  recordHistory(session, filePath, content);

  await session.service.writeFile(filePath, content);
});

/**
 * 另存为。`defaultPath` 决定对话框停在哪个目录（`files.newDocumentLocation`），
 * 收 `unknown` 后自己判类型 —— 它跨了进程边界，编译期形状不作数。
 */
ipcMain.handle(IPC_CHANNELS.saveAs, async (event, content: string, defaultPath?: unknown) => {
  const session = getOrCreateSession(event.sender);
  return await session.service.saveAs(
    content,
    typeof defaultPath === 'string' && defaultPath.length > 0 ? defaultPath : null
  );
});

/**
 * 附件落盘。参数逐个校验而不是整体信任 —— 这条通道的输入跨了进程边界，
 * 而 `SaveAttachmentRequest` 是编译期的形状，运行时什么都能传进来。
 *
 * `data` 收 `Uint8Array`：Electron 的结构化克隆会把它还原成 `Uint8Array`
 * （不是 `Buffer`），而 `atomicWriteFile` 收的正是 `Uint8Array`，两边对得上。
 */
ipcMain.handle(IPC_CHANNELS.saveAttachment, async (event, request: unknown) => {
  if (typeof request !== 'object' || request === null) {
    throw new Error('saveAttachment: 参数必须是对象');
  }

  const { documentPath, directory, fileName, extension, data } = request as Record<string, unknown>;
  if (typeof documentPath !== 'string' || documentPath.length === 0) {
    throw new Error('saveAttachment: documentPath 必须是非空字符串');
  }
  if (typeof directory !== 'string' || typeof fileName !== 'string' || fileName.length === 0) {
    throw new Error('saveAttachment: directory / fileName 形状不对');
  }
  if (typeof extension !== 'string' || !/^\.[A-Za-z0-9]{1,8}$/.test(extension)) {
    throw new Error(`saveAttachment: 扩展名非法: ${String(extension)}`);
  }
  if (!(data instanceof Uint8Array)) {
    throw new Error('saveAttachment: data 必须是 Uint8Array');
  }

  const session = getOrCreateSession(event.sender);
  return await session.service.saveAttachment({
    documentPath,
    directory,
    fileName,
    extension,
    data
  });
});

ipcMain.handle(
  IPC_CHANNELS.watchFile,
  async (event, subscriptionId: string, filePath: string) => {
    const sender = event.sender;
    const session = getOrCreateSession(sender);

    // 重复注册同 ID 时先清理旧订阅
    const existing = session.subscriptions.get(subscriptionId);
    if (existing) {
      existing();
      session.subscriptions.delete(subscriptionId);
    }

    const unsubscribe = session.service.watchFile(filePath, (watchEvent: FileWatchEvent) => {
      if (!sender.isDestroyed()) {
        const payload: FileWatchIpcPayload = {
          subscriptionId,
          event: watchEvent
        };
        sender.send(IPC_CHANNELS.fileWatchEvent, payload);
      }
    });

    session.subscriptions.set(subscriptionId, unsubscribe);
  }
);

const handleUnwatch = (senderId: number, subscriptionId: string) => {
  const session = sessions.get(senderId);
  if (session) {
    const unsub = session.subscriptions.get(subscriptionId);
    if (unsub) {
      unsub();
      session.subscriptions.delete(subscriptionId);
    }
  }
};

ipcMain.handle(IPC_CHANNELS.unwatchFile, (event, subscriptionId: string) => {
  handleUnwatch(event.sender.id, subscriptionId);
});

ipcMain.on(IPC_CHANNELS.unwatchFile, (event, subscriptionId: string) => {
  handleUnwatch(event.sender.id, subscriptionId);
});

// workspace 模式：授权根目录与扫描 Markdown 文件。
// 两条都走 FileService 的边界校验，渲染进程不能凭一个字符串就读到工作区外的文件。
ipcMain.handle(IPC_CHANNELS.authorizeWorkspace, async (event, rootPath: unknown) => {
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    throw new Error('authorizeWorkspace: 需要非空的目录路径');
  }
  return getOrCreateSession(event.sender).service.authorizeWorkspace(rootPath);
});

ipcMain.handle(IPC_CHANNELS.scanWorkspace, async (event, rootPath: unknown) => {
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    throw new Error('scanWorkspace: 需要非空的目录路径');
  }
  return getOrCreateSession(event.sender).service.scanWorkspaceMarkdownFiles(rootPath, {
    ignoreRules: hostSettings().ignoreRules
  });
});

ipcMain.handle(IPC_CHANNELS.getWorkspaceRoots, (event) => {
  return getOrCreateSession(event.sender).service.getWorkspaceRoots();
});

// 工作区索引。三条都要求先有已授权的工作区 —— 索引的边界必须和文件访问的边界一致，
// 否则渲染进程可以借索引读到工作区外的文件内容。
ipcMain.handle(IPC_CHANNELS.rebuildIndex, async (event, rootPath: unknown) => {
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    throw new Error('rebuildIndex: 需要非空的工作区路径');
  }

  const service = getOrCreateSession(event.sender).service;
  const authorizedRoots = service.getWorkspaceRoots();
  if (authorizedRoots.length === 0) {
    throw new Error('rebuildIndex: 该工作区尚未授权');
  }

  // 重开而不是复用：`ensureSchema()` 只在 open 时跑，复用一个已经打开的库会跳过
  // 版本检查 —— 那样「改了抽取判据 + bump 了 SCHEMA_VERSION」不会触发重建。
  const store = reopenIndexStore(event.sender.id, rootPath);
  // 处理器注册表**每次索引新建**：它是无状态的纯装配，缓存在进程级只会让
  // 「测试之间不串味」这条性质消失（`p3-10-processors.test.ts` 有一条钉它）。
  // 两个处理器内部的模块懒加载缓存是进程级的，那部分本来就该共用。
  return indexWorkspace({
    service,
    store,
    rootPath,
    // 跳过规则与「扫描工作区」那条通道取的是**同一份**宿主设置 —— 索引与文件树是
    // 两个投影，规则不一致会让「树里没有、搜索里有」。
    scanOptions: { ignoreRules: hostSettings().ignoreRules },
    // 启停谓词与设置同源：`hostCapabilityEnabled` 每次查表现读渲染进程刚送来的那份
    // `disabledCapabilities`，所以关掉一个处理器之后下一次索引就变了（P1-4b）。
    processors: createProcessorRegistry(hostCapabilityEnabled)
  });
});

ipcMain.handle(IPC_CHANNELS.searchIndex, (event, query: unknown, limit: unknown) => {
  if (typeof query !== 'string') {
    throw new Error('searchIndex: 查询必须是字符串');
  }

  const store = getIndexStore(event.sender.id);
  if (!store) return [];

  const effectiveLimit =
    typeof limit === 'number' && Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), 200)
      : 50;

  return store.search(query, effectiveLimit);
});

ipcMain.handle(IPC_CHANNELS.listIndexedDocuments, (event) => {
  return getIndexStore(event.sender.id)?.listDocuments() ?? [];
});

// 反向链接：查的是索引里记录的出链，所以只对**已索引**的文档有意义。
// 文档还没进索引时返回空数组，而不是报错 —— 用户看到「暂无反向链接」比看到报错合理。
ipcMain.handle(IPC_CHANNELS.findBacklinks, (event, documentPath: unknown) => {
  if (typeof documentPath !== 'string' || documentPath.length === 0) {
    throw new Error('findBacklinks: 需要文档路径');
  }

  const store = getIndexStore(event.sender.id);
  if (!store) return [];

  const document = store.getDocumentByPath(documentPath);
  if (!document) return [];

  return store.findBacklinks(document);
});

ipcMain.handle(IPC_CHANNELS.listTags, (event) => {
  return getIndexStore(event.sender.id)?.listTags() ?? [];
});

ipcMain.handle(IPC_CHANNELS.findDocumentsByTag, (event, tag: unknown) => {
  if (typeof tag !== 'string') {
    throw new Error('findDocumentsByTag: 标签必须是字符串');
  }
  return getIndexStore(event.sender.id)?.findDocumentsByTag(tag) ?? [];
});

ipcMain.handle(IPC_CHANNELS.getGraph, (event, query: unknown) => {
  return (
    getIndexStore(event.sender.id)?.getGraph(readGraphQuery(query)) ?? { nodes: [], edges: [] }
  );
});

/*
  未链接提及：扫全库正文，所以比其它查询重。**按需调用** —— 反向链接面板只在换文档时问一次。
  文档不在索引里（或不是 Markdown）时返回空结果，而不是报错：「暂无提及」比一个错误合理。
*/
ipcMain.handle(IPC_CHANNELS.findMentions, async (event, documentPath: unknown) => {
  if (typeof documentPath !== 'string' || documentPath.length === 0) {
    throw new Error('findMentions: 需要文档路径');
  }

  const store = getIndexStore(event.sender.id);
  if (!store) return { mentions: [], truncated: false };

  return findMentionsOfDocument({
    service: getOrCreateSession(event.sender).service,
    store,
    documentPath
  });
});

ipcMain.handle(IPC_CHANNELS.getGraphOrphans, (event, mode: unknown) => {
  return getIndexStore(event.sender.id)?.getOrphans(isOrphanMode(mode) ? mode : 'both') ?? [];
});

ipcMain.handle(IPC_CHANNELS.getGraphHubs, (event, limit: unknown) => {
  const effectiveLimit =
    typeof limit === 'number' && Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), 200)
      : 20;
  return getIndexStore(event.sender.id)?.getHubs(effectiveLimit) ?? [];
});

ipcMain.on(IPC_CHANNELS.setDirty, (event, isDirty: boolean) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    markWindowDirty(win.id, Boolean(isDirty));
  }
});

ipcMain.on(IPC_CHANNELS.readyToClose, (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    markWindowDirty(win.id, false);
    win.close();
  }
});

ipcMain.on(IPC_CHANNELS.closeWindow, (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.close();
  }
});

// 自绘窗口按钮：最小化 / 最大化（含还原） / 关闭
ipcMain.on(IPC_CHANNELS.minimizeWindow, (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.minimize();
});

ipcMain.on(IPC_CHANNELS.maximizeWindow, (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
});

ipcMain.handle(IPC_CHANNELS.getWindowState, (event): WindowState => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return { maximized: Boolean(win && !win.isDestroyed() && win.isMaximized()) };
});

// 设置窗口的入口。**只从主窗口触发** —— 设置窗口里没有「再开一个设置窗口」的入口，
// 单例判定因此只需挡「重复点主窗口的齿轮」这一种情况。
//
// `section` 是要落在哪个分组（如 `'plugins'`）。**只收字符串**：认不出的载荷一律当
// 「没指定分组」，由渲染进程回落存档 —— 主进程不认识分组名，校验在那一侧。
ipcMain.handle(IPC_CHANNELS.openSettingsWindow, (_event, section?: unknown) => {
  createSettingsWindow(typeof section === 'string' ? section : undefined);
});

// 主题窗口的入口。**只从设置窗口触发** —— 主窗口里没有直达主题编辑器的入口。
ipcMain.handle(IPC_CHANNELS.openThemeWindow, () => {
  createThemeWindow();
});

/**
 * 本机偏好变了：广播给**其他**窗口，让它们重读存档。
 *
 * 排除发起方 —— 它自己已经更新过内存了，回推一次只会让它白做一轮重读。载荷为空也是刻意的：
 * 新值在 localStorage 里，收方自己读；传值就要定义一份载荷格式，而两份格式迟早对不上。
 */
ipcMain.on(IPC_CHANNELS.notifySettingsChanged, (event) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    if (win.webContents.id === event.sender.id) continue;
    win.webContents.send(IPC_CHANNELS.settingsChanged);
  }
});

/**
 * 渲染进程送来「主进程要用的设置值」。
 *
 * 走 `handle` 而不是 `on`：渲染进程要能**等它落定**。索引启动紧跟着设置同步，
 * 只发不等的话，第一次建索引有可能跑在旧规则上 —— 症状是「填了忽略规则，第一次没生效，
 * 按一次重建索引才对」，而那是个查不出来的时序问题。
 *
 * 三个窗口都会推（它们共用同一份存储，值一样），后到的覆盖先到的，结果相同。
 */
ipcMain.handle(IPC_CHANNELS.syncHostSettings, async (_event, payload: unknown) => {
  const patch = sanitizeHostSettings(payload);
  updateHostSettings(patch);

  // 「启动时恢复上次工作区」是这一份里唯一**要落盘**的字段：它的消费者是**下一次启动**
  // 的 `launchContext`，而那一刻还没有渲染进程能把它送过来。别的字段存内存就够 ——
  // 理由见 `host-settings.ts` 与 `recent-workspace.ts` 两处的头注释。
  if (recentWorkspaceDir && 'restoreLastWorkspace' in patch) {
    writeRecentWorkspace(recentWorkspaceDir, {
      restoreLastWorkspace: patch.restoreLastWorkspace === true,
      workspaceRoot: readRecentWorkspace(recentWorkspaceDir).workspaceRoot
    });
  }
});

/**
 * 首帧主题。**唯一的 `sendSync`**：preload 在页面脚本之前跑，主题必须在那一刻定下来，
 * 而「用哪套主题」在渲染进程的 localStorage 里（见 `channels.ts` 的 `getThemeBoot`）。
 *
 * 用 `ipcMain.on` + `event.returnValue` 而不是 `handle` —— 后者是异步的，等它回来首帧已经画过。
 */
ipcMain.on(IPC_CHANNELS.getThemeBoot, (event, payload: unknown) => {
  event.returnValue = resolveThemeBoot(payload);
});

/**
 * 把渲染进程手里的主题列表对齐到目录。**不 await**（同步 fs），但用 `handle` 是为了让调用方
 * 拿到 `failed` —— 写不进去时必须说话。
 */
ipcMain.handle(IPC_CHANNELS.syncThemeLibrary, (_event, raw: unknown): ThemeSyncResult => {
  const themes = Array.isArray(raw) ? parseUserThemes(JSON.stringify({ themes: raw })) : [];
  const knownIds = currentThemeScan().themes.map((theme) => theme.id);
  const result = syncThemeDirectory(themeDirectory, themes, knownIds);
  // 目录变了，下一次扫描（别的窗口的 preload、或下一次同步）要重新读。
  themeDirectoryCache = null;
  return result;
});

// App lifecycle
app.whenReady().then(() => {
  createWindow();

  // 更新通道在窗口之后接：它 8 秒后才发第一次请求，但弹窗需要一个已存在的窗口做父级。
  // 未打包时 `setupAutoUpdater` 是空操作。
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
