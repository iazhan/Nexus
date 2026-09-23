import type {
  LaunchContext,
  FileDocument,
  FileWatchListener,
  Unsubscribe
} from '@nexus/core';
import type { WindowState } from '../ipc/channels.js';

export interface NexusBridge {
  getLaunchContext: () => Promise<LaunchContext>;
  openFile: (filePath?: string) => Promise<FileDocument>;
  /**
   * 用系统默认程序打开外部链接（http/https/mailto）。
   * 返回 `false` 表示协议不在白名单内、URL 非法，或系统调用失败。
   */
  openExternal: (url: string) => Promise<boolean>;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  saveAs: (content: string) => Promise<string>;
  watchFile: (filePath: string, listener: FileWatchListener) => Unsubscribe;
  setDirty: (isDirty: boolean) => void;
  onSaveAndCloseRequested: (callback: () => Promise<void>) => Unsubscribe;
  readyToClose: () => void;
  closeWindow: () => void;
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  getWindowState: () => Promise<WindowState>;
  onWindowStateChanged: (callback: (state: WindowState) => void) => Unsubscribe;
}
