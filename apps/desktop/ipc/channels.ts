import type { FileWatchEvent } from '@nexus/core';

/**
 * 主进程与 preload 共用的 IPC channel，避免业务代码散落字符串字面量。
 */
export const IPC_CHANNELS = {
  getLaunchContext: 'nexus:get-launch-context',
  openFile: 'nexus:open-file',
  openExternal: 'nexus:open-external',
  readFile: 'nexus:read-file',
  writeFile: 'nexus:write-file',
  saveAs: 'nexus:save-as',
  watchFile: 'nexus:watch-file',
  unwatchFile: 'nexus:unwatch-file',
  fileWatchEvent: 'nexus:file-watch-event',
  authorizeWorkspace: 'nexus:authorize-workspace',
  scanWorkspace: 'nexus:scan-workspace',
  getWorkspaceRoots: 'nexus:get-workspace-roots',
  rebuildIndex: 'nexus:rebuild-index',
  searchIndex: 'nexus:search-index',
  listIndexedDocuments: 'nexus:list-indexed-documents',
  findBacklinks: 'nexus:find-backlinks',
  listTags: 'nexus:list-tags',
  findDocumentsByTag: 'nexus:find-documents-by-tag',
  getGraph: 'nexus:get-graph',
  listHistory: 'nexus:list-history',
  readHistory: 'nexus:read-history',
  restoreHistory: 'nexus:restore-history',
  setDirty: 'nexus:set-dirty',
  requestSaveAndClose: 'nexus:request-save-and-close',
  readyToClose: 'nexus:ready-to-close',
  closeWindow: 'nexus:close-window',
  minimizeWindow: 'nexus:minimize-window',
  maximizeWindow: 'nexus:maximize-window',
  getWindowState: 'nexus:get-window-state',
  windowStateChanged: 'nexus:window-state-changed'
} as const;

/**
 * 自绘窗口按钮需要同步的最小状态集合。
 */
export interface WindowState {
  maximized: boolean;
}

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * 文件监听 IPC 传输载荷。
 */
export interface FileWatchIpcPayload {
  subscriptionId: string;
  event: FileWatchEvent;
}
