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
import { FileService } from './file-service.js';
import { createElectronFileDialog } from './file-dialog.js';
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

// Parse launch arguments upon main process startup
const launchContext: LaunchContext = parseLaunchArgs(process.argv, {
  execPath: process.execPath,
  classifyPath: classifyLaunchPath
});
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
    title: 'Nexus Lite',
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
}

const sessions = new Map<number, WebContentsSession>();

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
      subscriptions: new Map()
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
