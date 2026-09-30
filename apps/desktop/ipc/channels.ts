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
  /**
   * 把粘贴进来的图片落到文档目录下，返回实际落盘的绝对路径。
   *
   * 单独一条而不是复用 `writeFile`：`writeFile` 收的是字符串，图片是字节 ——
   * 过一遍 `utf-8` 解码再编码**不是恒等变换**，PNG 会被改坏。
   */
  saveAttachment: 'nexus:save-attachment',
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
  /** 在系统文件管理器里打开该工作区的索引库目录（在 `userData` 下）。不存在时返回 `false`。 */
  openIndexDirectory: 'nexus:open-index-directory',
  /**
   * 该工作区的索引库**文件**路径（`.db`）。设置页把它当只读值显示。
   *
   * 与上面那条是同一个库的两半 —— 两者都由主进程的 `index-path.ts` 算出，所以
   * 「显示的位置」与「打开的位置」不会分家。
   */
  getIndexPath: 'nexus:get-index-path',
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
  settingsChanged: 'nexus:settings-changed',
  /**
   * 渲染进程 → 主进程：**把主进程要用的设置值送过去**。
   *
   * 本机偏好存在渲染进程的存储里，主进程读不到（`notifySettingsChanged` 是空载荷的
   * 广播，收方自己去读 —— 而主进程没有可读的地方）。所以凡是要主进程**照着做**的设置，
   * 都得由渲染进程显式送一份过来。
   *
   * 与 `notifySettingsChanged` 分成两条而不是合并：那条是**给别的窗口**的信号
   * （收方各读各的存档），这条是**给主进程**的数据。合并的话主进程就要区分
   * 「这次广播是不是给我的」，而窗口之间的广播本来也不该顺带传值。
   */
  syncHostSettings: 'nexus:sync-host-settings'
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

/**
 * 一次附件落盘请求。**名字与扩展名已经算好**，主进程不再解释模板 ——
 * 「叫什么」是渲染进程的偏好（模板可改），「放不放得下」才是主进程的事。
 *
 * 形状定义在这里而不是 `electron/file-service.ts`：它是**跨进程的契约**，
 * 而 `NexusBridge`（preload）与 `FileService`（main）两边都要用它。
 * 定义在主进程那一侧的话，preload 只能再写一遍 —— 两份形状漂移不会被任何东西报错。
 */
export interface SaveAttachmentRequest {
  /** 当前文档的绝对路径。附件落在它的目录下 —— 没有文档就没有落点。 */
  documentPath: string;
  /** 相对文档目录的子目录；空串表示与文档同目录。 */
  directory: string;
  /** 不含扩展名的文件名。 */
  fileName: string;
  /** 含前导点的扩展名，如 `.png`。 */
  extension: string;
  /** 文件字节。图片必须原样落盘，过一遍 `utf-8` 解码再编码会把 PNG 改坏。 */
  data: Uint8Array;
}

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * 主进程需要照着做的那些设置值。
 *
 * **只放「主进程必须知道才能干活」的项**，不放本机偏好本身 —— 这份东西每改一次设置就
 * 过一趟 IPC，塞进全部设置项是白付的序列化，而且会让「哪一项真的影响主进程」变得看不出来。
 * 加一项的条件很硬：**没有它，主进程的某个行为就是错的**。
 *
 * 形状定义在这里而不是 `electron/host-settings.ts`：它是跨进程契约，
 * `NexusBridge`（preload）与主进程两侧都要用它（同 `SaveAttachmentRequest` 的理由）。
 */
export interface HostSettings {
  /**
   * 扫描工作区时跳过的**用户自定义**目录规则（已由 `parseIgnoreRules` 归一化）。
   *
   * 内置规则（点开头目录、`node_modules` / `dist` / `out` / `build`）不在这里 ——
   * 它们不可配置，跟着代码走。这里只放用户加的那部分。
   */
  ignoreRules: readonly string[];
  /**
   * 每个文档最多留几份历史快照。`null` ＝ **不清理**。
   *
   * 送的是**解析后的数值**而不是存档里的字符串（`'unlimited'` / `'100'`）：
   * 「存档格式」是渲染进程的事，主进程只该拿到「留几份」这个答案。
   * 解析规则见 `@nexus/core` 的 `parseHistoryRetention` —— 认不出的值一律当不清理。
   */
  historyRetention: number | null;
  /**
   * 启动时是否恢复上次打开的工作区。
   *
   * **这一项与上面两项有一处结构性的不同**：它的消费者是**下一次启动**的 `launchContext`，
   * 而那东西在主进程模块加载时就定下来了 —— 那时还没有渲染进程能把它送过来。
   * 所以主进程会把它**连同上次的工作区一起落盘**（`electron/recent-workspace.ts`），
   * 这是 `host-settings.ts` 那句「内存而不是落盘」的唯一例外。
   */
  restoreLastWorkspace: boolean;
}

/**
 * 一份「什么都还没同步过」的初始值：行为与加这条通道之前完全一致。
 *
 * `historyRetention: null` 就是那个「完全一致」—— 没收到设置之前不删任何历史。
 * 注意它**不等于**设置项的默认档位（100）：默认档位是「用户没选过时界面上显示什么」，
 * 这里是「主进程还没听到用户的选择时该怎么做」，后者必须更保守。
 *
 * `restoreLastWorkspace: false` 同理：没听到之前不恢复，空启动还是空启动。
 */
export const DEFAULT_HOST_SETTINGS: HostSettings = {
  ignoreRules: [],
  historyRetention: null,
  restoreLastWorkspace: false
};

/**
 * 文件监听 IPC 传输载荷。
 */
export interface FileWatchIpcPayload {
  subscriptionId: string;
  event: FileWatchEvent;
}
