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
import { IPC_CHANNELS, type FileWatchIpcPayload } from '../ipc/channels.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse launch arguments upon main process startup
const launchContext: LaunchContext = parseLaunchArgs(process.argv, {
  execPath: process.execPath
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

function createWindow(): BrowserWindowType {
  const mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'Nexus Lite',
    autoHideMenuBar: true,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });

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

  // Open external links in user's default browser
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
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
      allowedPaths: launchContext.filePath ? [launchContext.filePath] : []
    });

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
