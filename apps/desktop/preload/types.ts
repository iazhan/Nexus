import type {
  LaunchContext,
  FileDocument,
  FileWatchListener,
  Unsubscribe,
  WorkspaceScanResult
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
  /**
   * 授权一个工作区根目录，该目录下的文件随即可读写。返回规范化后的绝对路径。
   */
  authorizeWorkspace: (rootPath: string) => Promise<string>;
  /**
   * 递归扫描工作区下的 Markdown 文件。跳过 node_modules/.git 等目录，不跟随符号链接。
   */
  scanWorkspace: (rootPath: string) => Promise<WorkspaceScanResult>;
  /** 当前已授权的工作区根目录。 */
  getWorkspaceRoots: () => Promise<string[]>;
  setDirty: (isDirty: boolean) => void;
  onSaveAndCloseRequested: (callback: () => Promise<void>) => Unsubscribe;
  readyToClose: () => void;
  closeWindow: () => void;
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  getWindowState: () => Promise<WindowState>;
  onWindowStateChanged: (callback: (state: WindowState) => void) => Unsubscribe;
}
