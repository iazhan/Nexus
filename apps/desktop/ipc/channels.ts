import type { FileWatchEvent } from '@nexus/core';

/**
 * 主进程与 preload 共用的 IPC channel，避免业务代码散落字符串字面量。
 */
export const IPC_CHANNELS = {
  getLaunchContext: 'nexus:get-launch-context',
  openFile: 'nexus:open-file',
  readFile: 'nexus:read-file',
  writeFile: 'nexus:write-file',
  saveAs: 'nexus:save-as',
  watchFile: 'nexus:watch-file',
  unwatchFile: 'nexus:unwatch-file',
  fileWatchEvent: 'nexus:file-watch-event'
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * 文件监听 IPC 传输载荷。
 */
export interface FileWatchIpcPayload {
  subscriptionId: string;
  event: FileWatchEvent;
}
