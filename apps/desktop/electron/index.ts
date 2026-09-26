import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BrowserWindow as BrowserWindowType } from 'electron';
import {
  parseLaunchArgs,
  type LaunchContext,
  type FileWatchEvent,
  type Unsubscribe
} from '@nexus/core';
import { createHash } from 'node:crypto';
import { FileService } from './file-service.js';
import { createElectronFileDialog } from './file-dialog.js';
import { HistoryStore } from './history-store.js';
import { IndexStore } from './index-store.js';
import { indexWorkspace } from './indexer.js';
import {
  IPC_CHANNELS,
  type FileWatchIpcPayload,
  type WindowState
} from '../ipc/channels.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

  // ready-to-show 在隐藏窗口下并不保证触发（冷启动 dev 时首次绘制可能不发生），
  // 因此同时监听 did-finish-load 并加超时兜底，保证窗口一定可见。
  let windowShown = false;
  const showWindow = () => {
    if (windowShown || mainWindow.isDestroyed()) return;
    windowShown = true;
    mainWindow.show();
    // 无边框窗口不会自动取得键盘焦点，未聚焦时用户输入与自动化按键都会被丢弃。
    mainWindow.focus();
  };

  // 最大化/还原状态回传，保证自绘按钮图标与窗口实际状态一致。
  const notifyWindowState = () => {
    if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send(IPC_CHANNELS.windowStateChanged, {
      maximized: mainWindow.isMaximized()
    } satisfies WindowState);
  };
  mainWindow.on('maximize', notifyWindowState);
  mainWindow.on('unmaximize', notifyWindowState);

  mainWindow.once('ready-to-show', showWindow);
  mainWindow.webContents.once('did-finish-load', showWindow);
  const showFallbackTimer = setTimeout(showWindow, 3000);
  mainWindow.once('closed', () => clearTimeout(showFallbackTimer));

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
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return mainWindow;
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

function getOrCreateSession(webContents: Electron.WebContents): WebContentsSession {
  let session = sessions.get(webContents.id);
  if (!session) {
    const browserWindow = BrowserWindow.fromWebContents(webContents) ?? undefined;
    const dialog = createElectronFileDialog(browserWindow);
    const service = new FileService({
      dialog,
      allowedPaths: launchContext.filePath ? [launchContext.filePath] : [],
      workspaceRoots: launchContext.workspaceRoot ? [launchContext.workspaceRoot] : []
    });

    // 构造函数不能 await，只登记了字符串层面的根；realpath 层面必须在这里补一次，
    // 否则「工作区内的符号链接指向外部」那条防护不会生效。
    if (launchContext.workspaceRoot) {
      void service.authorizeWorkspace(launchContext.workspaceRoot).catch((err) => {
        console.error('[Nexus Shell] 授权工作区失败:', err);
      });
    }

    session = {
      service,
      subscriptions: new Map(),
      workspaceRoot: launchContext.workspaceRoot ?? null
    };
    sessions.set(webContents.id, session);

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

ipcMain.handle(IPC_CHANNELS.saveAs, async (event, content: string) => {
  const session = getOrCreateSession(event.sender);
  return await session.service.saveAs(content);
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
  return indexWorkspace({ service, store, rootPath });
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
