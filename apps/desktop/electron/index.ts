import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BrowserWindow as BrowserWindowType } from 'electron';
import {
  ASSET_SCHEME,
  parseLaunchArgs,
  type LaunchContext,
  type FileWatchEvent,
  type HistoryEntry,
  type Unsubscribe
} from '@nexus/core';
import { createHash } from 'node:crypto';
import { FileService } from './file-service.js';
import { ASSET_SCHEME_PRIVILEGES, createAssetHandler } from './asset-protocol.js';
import { createElectronFileDialog } from './file-dialog.js';
import { HistoryStore, HISTORY_DIR } from './history-store.js';
import { IndexStore } from './index-store.js';
import { indexWorkspace } from './indexer.js';
import { createProcessorRegistry } from './processor/index.js';
import {
  IPC_CHANNELS,
  type FileWatchIpcPayload,
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

// Parse launch arguments upon main process startup
const launchContext: LaunchContext = applyWorkspaceEnvOverride(
  parseLaunchArgs(process.argv, {
    execPath: process.execPath,
    classifyPath: classifyLaunchPath
  })
);
console.log('[Nexus Shell] Initialized launch context:', JSON.stringify(launchContext));

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
/** 角色 → `loadFile` 的查询串。三个窗口一张表，加角色只动这里与 `window-role.ts`。 */
const WINDOW_QUERY: Record<WindowRole, Record<string, string>> = {
  main: { [WINDOW_ROLE_PARAM]: 'main' },
  settings: { [WINDOW_ROLE_PARAM]: 'settings' },
  theme: { [WINDOW_ROLE_PARAM]: 'theme' }
};

/**
 * 把渲染产物装进窗口。三个窗口跑**同一份产物**，只有角色参数不同 ——
 * 另开一个构建目标意味着主题、i18n、设置存档、样式全都要么抽公共包要么抄一遍。
 */
function loadRenderer(win: BrowserWindowType, role: WindowRole): void {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl) {
    win.loadURL(`${devServerUrl}?${WINDOW_ROLE_PARAM}=${role}`);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: WINDOW_QUERY[role] });
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
    const isDirty = windowDirtyMap.get(mainWindow.id) ?? false;
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
        windowDirtyMap.set(mainWindow.id, false);
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
    closeSettingsWindow();
    closeThemeWindow();
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
 */
function createSettingsWindow(): BrowserWindowType {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
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

  loadRenderer(win, 'settings');

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

const windowDirtyMap = new Map<number, boolean>();

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
 * 不同工作区不会互相覆盖。
 */
const indexStores = new Map<number, { rootPath: string; store: IndexStore }>();

function indexPathForWorkspace(rootPath: string): string {
  const digest = createHash('sha256').update(rootPath).digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), 'workspace-index', `${digest}.db`);
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

  const dbPath = indexPathForWorkspace(rootPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const store = IndexStore.open(dbPath);
  indexStores.set(webContentsId, { rootPath, store });
  return store;
}

function getIndexStore(webContentsId: number): IndexStore | null {
  return indexStores.get(webContentsId)?.store ?? null;
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

    new HistoryStore(root).record(relativePath, previous);
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

  const indexDir = path.dirname(indexPathForWorkspace(rootPath));
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
  return getOrCreateSession(event.sender).service.scanWorkspaceMarkdownFiles(rootPath);
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

  const store = openIndexStore(event.sender.id, rootPath);
  // 处理器注册表**每次索引新建**：它是无状态的纯装配，缓存在进程级只会让
  // 「测试之间不串味」这条性质消失（`p3-10-processors.test.ts` 有一条钉它）。
  // 两个处理器内部的模块懒加载缓存是进程级的，那部分本来就该共用。
  return indexWorkspace({
    service,
    store,
    rootPath,
    processors: createProcessorRegistry()
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

ipcMain.handle(IPC_CHANNELS.getGraph, (event) => {
  return getIndexStore(event.sender.id)?.getGraph() ?? { nodes: [], edges: [] };
});

ipcMain.on(IPC_CHANNELS.setDirty, (event, isDirty: boolean) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    windowDirtyMap.set(win.id, Boolean(isDirty));
  }
});

ipcMain.on(IPC_CHANNELS.readyToClose, (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    windowDirtyMap.set(win.id, false);
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
ipcMain.handle(IPC_CHANNELS.openSettingsWindow, () => {
  createSettingsWindow();
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

// App lifecycle
app.whenReady().then(() => {
  createWindow();

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
