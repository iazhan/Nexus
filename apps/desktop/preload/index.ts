import { contextBridge, ipcRenderer } from 'electron';
import type {
  LaunchContext,
  FileDocument,
  FileWatchListener,
  FileWatchEvent,
  Unsubscribe
} from '@nexus/core';
import {
  IPC_CHANNELS,
  type FileWatchIpcPayload,
  type WindowState
} from '../ipc/channels.js';
import type { NexusBridge } from './types.js';

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

  readFile: (filePath: string): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.readFile, filePath);
  },

  writeFile: (filePath: string, content: string): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.writeFile, filePath, content);
  },

  saveAs: (content: string): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.saveAs, content);
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
  }
};

// 安全暴露强类型桥接对象，严禁向 main world 暴露 ipcRenderer 或 Node API
contextBridge.exposeInMainWorld('nexus', bridge);
