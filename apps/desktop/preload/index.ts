import { contextBridge, ipcRenderer, webFrame } from 'electron';
import type {
  LaunchContext,
  FileDocument,
  FileWatchListener,
  FileWatchEvent,
  Unsubscribe,
  WorkspaceScanResult,
  IndexedDocument,
  SearchHit,
  IndexWorkspaceResult,
  WorkspaceGraph,
  HistoryEntry
} from '@nexus/core';
import {
  IPC_CHANNELS,
  type FileWatchIpcPayload,
  type SaveAttachmentRequest,
  type WindowState
} from '../ipc/channels.js';
import type { NexusBridge } from './types.js';
import { installThemeBoot } from './theme-boot.js';
import { applyStoredUiZoom, uiZoomFactor } from './ui-zoom.js';

// 最早执行的一段：首帧之前把主题落到 `<html data-theme>` 上。放在 bridge 之前，
// 因为它和 IPC 无关，越早越好。
installThemeBoot(document, window);

// 与主题同一个理由，但**更简单**：缩放不碰 DOM，随时可调，所以不需要等 `<html>`。
// 晚一帧的代价是「先按 100% 画一帧再跳」—— 改的是布局视口，跳一下整窗都要重排。
applyStoredUiZoom(window, (factor) => webFrame.setZoomFactor(factor));

const listeners = new Map<string, FileWatchListener>();

// 单一监听通道分发，按 subscriptionId 精确派发到对应的渲染进程监听器
ipcRenderer.on(
  IPC_CHANNELS.fileWatchEvent,
  (_event, payload: FileWatchIpcPayload | string, maybeEvent?: FileWatchEvent) => {
    let subId: string;
    let watchEvent: FileWatchEvent;

    if (typeof payload === 'string') {
      subId = payload;
      watchEvent = maybeEvent as FileWatchEvent;
    } else if (payload && typeof payload === 'object') {
      subId = payload.subscriptionId;
      watchEvent = payload.event;
    } else {
      return;
    }

    const listener = listeners.get(subId);
    if (listener) {
      try {
        listener(watchEvent);
      } catch (err) {
        console.error('[Nexus Preload] Watch listener execution error:', err);
      }
    }
  }
);

let subscriptionCounter = 0;

const bridge: NexusBridge = {
  getLaunchContext: (): Promise<LaunchContext> => {
    return ipcRenderer.invoke(IPC_CHANNELS.getLaunchContext);
  },

  openFile: (filePath?: string): Promise<FileDocument> => {
    return ipcRenderer.invoke(IPC_CHANNELS.openFile, filePath);
  },

  openExternal: (url: string): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.openExternal, url);
  },

  copyText: (text: string): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.copyText, text);
  },

  readFile: (filePath: string): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.readFile, filePath);
  },

  writeFile: (filePath: string, content: string): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.writeFile, filePath, content);
  },

  saveAs: (content: string): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.saveAs, content);
  },

  saveAttachment: (request: SaveAttachmentRequest): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.saveAttachment, request);
  },

  authorizeWorkspace: (rootPath: string): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.authorizeWorkspace, rootPath);
  },

  scanWorkspace: (rootPath: string): Promise<WorkspaceScanResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.scanWorkspace, rootPath);
  },

  getWorkspaceRoots: (): Promise<string[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.getWorkspaceRoots);
  },

  rebuildIndex: (rootPath: string): Promise<IndexWorkspaceResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.rebuildIndex, rootPath);
  },

  searchIndex: (query: string, limit?: number): Promise<SearchHit[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.searchIndex, query, limit);
  },

  listIndexedDocuments: (): Promise<IndexedDocument[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.listIndexedDocuments);
  },

  findBacklinks: (documentPath: string): Promise<IndexedDocument[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.findBacklinks, documentPath);
  },

  listTags: (): Promise<Array<{ tag: string; count: number }>> => {
    return ipcRenderer.invoke(IPC_CHANNELS.listTags);
  },

  findDocumentsByTag: (tag: string): Promise<IndexedDocument[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.findDocumentsByTag, tag);
  },

  getGraph: (): Promise<WorkspaceGraph> => {
    return ipcRenderer.invoke(IPC_CHANNELS.getGraph);
  },

  listHistory: (documentPath: string): Promise<HistoryEntry[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.listHistory, documentPath);
  },

  readHistory: (documentPath: string, entry: HistoryEntry): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.readHistory, documentPath, entry);
  },

  restoreHistory: (documentPath: string, entry: HistoryEntry): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.restoreHistory, documentPath, entry);
  },

  openHistoryDirectory: (rootPath: string): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.openHistoryDirectory, rootPath);
  },

  openIndexDirectory: (rootPath: string): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.openIndexDirectory, rootPath);
  },

  watchFile: (filePath: string, listener: FileWatchListener): Unsubscribe => {
    subscriptionCounter += 1;
    const subscriptionId = `sub_${Date.now()}_${subscriptionCounter}_${Math.random().toString(36).slice(2, 9)}`;
    listeners.set(subscriptionId, listener);

    // 发起监听，若主进程校验或初始化失败，显式向 listener 派发 error 事件，保证不吞错。
    const registration = ipcRenderer.invoke(IPC_CHANNELS.watchFile, subscriptionId, filePath);
    void registration.catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const activeListener = listeners.get(subscriptionId);
      if (activeListener) {
        activeListener({
          type: 'error',
          path: filePath,
          message
        });
      }
    });

    let isUnsubscribed = false;
    return () => {
      if (isUnsubscribed) return;
      isUnsubscribed = true;
      listeners.delete(subscriptionId);

      // 等待注册完成后再注销，避免快速取消造成主进程 watcher 泄漏。
      void registration
        .then(() => ipcRenderer.invoke(IPC_CHANNELS.unwatchFile, subscriptionId))
        .catch((err: unknown) => {
          console.error('[Nexus Preload] Failed to release file watcher:', err);
        });
    };
  },

  setDirty: (isDirty: boolean): void => {
    ipcRenderer.send(IPC_CHANNELS.setDirty, isDirty);
  },

  onSaveAndCloseRequested: (callback: () => Promise<void>): Unsubscribe => {
    const handler = async () => {
      try {
        await callback();
      } catch (err) {
        console.error('[Nexus Preload] Error during onSaveAndCloseRequested:', err);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.requestSaveAndClose, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.requestSaveAndClose, handler);
    };
  },

  readyToClose: (): void => {
    ipcRenderer.send(IPC_CHANNELS.readyToClose);
  },

  closeWindow: (): void => {
    ipcRenderer.send(IPC_CHANNELS.closeWindow);
  },

  minimizeWindow: (): void => {
    ipcRenderer.send(IPC_CHANNELS.minimizeWindow);
  },

  maximizeWindow: (): void => {
    ipcRenderer.send(IPC_CHANNELS.maximizeWindow);
  },

  getWindowState: (): Promise<WindowState> => {
    return ipcRenderer.invoke(IPC_CHANNELS.getWindowState);
  },

  onWindowStateChanged: (callback: (state: WindowState) => void): Unsubscribe => {
    const handler = (_event: unknown, state: WindowState) => {
      try {
        callback(state);
      } catch (err) {
        console.error('[Nexus Preload] Window state listener error:', err);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.windowStateChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.windowStateChanged, handler);
    };
  },

  openSettingsWindow: (): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.openSettingsWindow);
  },

  openThemeWindow: (): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.openThemeWindow);
  },

  /**
   * 应用界面缩放。走 preload 而不是主进程：`webFrame` 只在渲染进程侧有效，
   * 而缩放是**每个窗口自己的**属性（设置窗口、主题窗口各调一次，值来自同一份存档）。
   */
  setUiZoom: (value: string): void => {
    webFrame.setZoomFactor(uiZoomFactor(value));
  },

  notifySettingsChanged: (): void => {
    ipcRenderer.send(IPC_CHANNELS.notifySettingsChanged);
  },

  onSettingsChanged: (callback: () => void): Unsubscribe => {
    const handler = () => {
      try {
        callback();
      } catch (err) {
        console.error('[Nexus Preload] Settings sync listener error:', err);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.settingsChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.settingsChanged, handler);
    };
  }
};

// 安全暴露强类型桥接对象，严禁向 main world 暴露 ipcRenderer 或 Node API
contextBridge.exposeInMainWorld('nexus', bridge);
