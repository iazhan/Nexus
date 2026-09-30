import type { FileWatchEvent } from '@nexus/core';

/**
 * 主进程与 preload 共用的 IPC channel，避免业务代码散落字符串字面量。
 */
export const IPC_CHANNELS = {
  getLaunchContext: 'nexus:get-launch-context',
  openFile: 'nexus:open-file',
  openExternal: 'nexus:open-external',
  /** 把文本写进系统剪贴板（P3-11 的「复制引用」）。 */
  copyText: 'nexus:copy-text',
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
  /** 在系统文件管理器里打开 `<workspace>/.nexus/history`。目录不存在时返回 `false`。 */
  openHistoryDirectory: 'nexus:open-history-directory',
  setDirty: 'nexus:set-dirty',
  requestSaveAndClose: 'nexus:request-save-and-close',
  readyToClose: 'nexus:ready-to-close',
  closeWindow: 'nexus:close-window',
  minimizeWindow: 'nexus:minimize-window',
  maximizeWindow: 'nexus:maximize-window',
  getWindowState: 'nexus:get-window-state',
  windowStateChanged: 'nexus:window-state-changed',
  /**
   * 打开设置窗口（单例）。
   *
   * 设置是**独立窗口**而不是主窗口内的一个视图 —— 界面上靠 `?window=settings` 查询串区分角色，
   * 不走这里（角色必须在首帧前确定，见主进程的 `WINDOW_ROLE_QUERY`）。这条通道只负责「开窗」。
   */
  openSettingsWindow: 'nexus:open-settings-window',
  /**
   * 打开主题窗口（单例）。与设置窗口同理 —— 角色靠 `?window=theme` 查询串区分，这条通道只负责开窗。
   *
   * 入口在**设置窗口的外观分组**里，不在主窗口：主题编辑器是外观设置的下钻，主窗口不该再多一个齿轮。
   */
  openThemeWindow: 'nexus:open-theme-window',
  /**
   * 「本窗口刚改了本机偏好」。渲染进程 → 主进程，主进程再广播给**其他**窗口。
   *
   * 为什么不用 `window` 的 `storage` 事件（那是原生的跨窗口机制）：dev 下页面来自
   * `http://localhost:6200`、打包后是 `file://`，两种 origin 的 storage 分区语义不同，
   * `storage` 事件在 `file://` 下是否跨窗口派发不能赌。主进程中转是确定的，且两种形态一致。
   */
  notifySettingsChanged: 'nexus:notify-settings-changed',
  /** 上面那条的中转结果。主进程 → 其他窗口。 */
  settingsChanged: 'nexus:settings-changed'
} as const;

/**
 * 这个渲染进程是哪个窗口。
 *
 * 定义在这里而不是渲染进程里：主进程的 `loadRenderer()` 与渲染进程的 `readWindowRole()` 必须
 * 是**同一份**联合类型，两边各写一遍的话，加一个角色时漏改一边不会有任何东西报错 ——
 * 主进程照常按新角色加载，渲染进程把它当主窗口渲染。
 */
export type WindowRole = 'main' | 'settings' | 'theme';

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
