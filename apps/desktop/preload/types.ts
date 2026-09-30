import type {
  LaunchContext,
  FileDocument,
  FileWatchListener,
  Unsubscribe,
  WorkspaceScanResult,
  IndexedDocument,
  SearchHit,
  IndexWorkspaceResult,
  WorkspaceGraph,
  HistoryEntry
} from '@nexus/core';
import type { HostSettings, SaveAttachmentRequest, WindowState } from '../ipc/channels.js';

export interface NexusBridge {
  getLaunchContext: () => Promise<LaunchContext>;
  openFile: (filePath?: string) => Promise<FileDocument>;
  /**
   * 用系统默认程序打开外部链接（http/https/mailto）。
   * 返回 `false` 表示协议不在白名单内、URL 非法，或系统调用失败。
   */
  openExternal: (url: string) => Promise<boolean>;
  /**
   * 把文本写进系统剪贴板，返回是否成功。
   *
   * 走 IPC 而不是渲染进程的 `navigator.clipboard`：sandbox 化的 preload 拿不到
   * Electron 的 `clipboard` 模块，而 Clipboard API 在 `file://` 页面下要额外的
   * 权限与聚焦条件 —— 复制失败时用户只会看到「按了没反应」。
   */
  copyText: (text: string) => Promise<boolean>;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  /**
   * 另存为，返回用户选中的路径（取消时抛 `CANCELLED`，由调用方 catch）。
   *
   * `defaultPath` 只决定对话框**打开时停在哪个目录**（`files.newDocumentLocation`
   * 的落地处），不限制能去哪 —— 它是给「新建文档第一次保存」用的默认起点。
   */
  saveAs: (content: string, defaultPath?: string | null) => Promise<string>;
  /**
   * 把粘贴进来的图片写到文档目录（或其子目录）下，返回**实际落盘的绝对路径**。
   *
   * 返回绝对路径而不是相对路径：重名去重发生在主进程（只有它看得见文件系统），
   * 所以最终文件名只有那边知道。渲染进程拿到之后再算相对路径写进 Markdown。
   */
  saveAttachment: (request: SaveAttachmentRequest) => Promise<string>;
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
  /**
   * 全量重建工作区索引（扫盘 → 解析 → 写库）。
   *
   * 幂等：内容未变的文档按内容哈希跳过。索引是派生数据，随时可以重建。
   */
  rebuildIndex: (rootPath: string) => Promise<IndexWorkspaceResult>;
  /** 全文检索。中文按字切分，2 字词可搜（见 ADR-0002）。 */
  searchIndex: (query: string, limit?: number) => Promise<SearchHit[]>;
  /** 已索引的文档列表，按相对路径排序。 */
  listIndexedDocuments: () => Promise<IndexedDocument[]>;
  /**
   * 反向链接：所有链接到该文档的文档。
   *
   * 文档还没进索引时返回空数组（而不是报错）—— 「暂无反向链接」比一个错误更合理。
   */
  findBacklinks: (documentPath: string) => Promise<IndexedDocument[]>;
  /** 所有标签及其文档数，按标签名排序。 */
  listTags: () => Promise<Array<{ tag: string; count: number }>>;
  /** 带某个标签的文档。标签可以带 `#`、大小写随意，归一化在索引层做。 */
  findDocumentsByTag: (tag: string) => Promise<IndexedDocument[]>;
  /** 整个工作区的链接图：文档为节点，wikilink 为无向边。 */
  getGraph: () => Promise<WorkspaceGraph>;
  /** 某文档的历史版本，**新的在前**。没有历史时返回空数组。 */
  listHistory: (documentPath: string) => Promise<HistoryEntry[]>;
  /** 读某一版的内容。条目不存在时抛错，不返回空字符串。 */
  readHistory: (documentPath: string, entry: HistoryEntry) => Promise<string>;
  /**
   * 把某一版写回文档。
   *
   * **恢复本身是可逆的**：覆盖之前会把当前内容也留一份历史，
   * 所以恢复了不该恢复的版本时还能找回来。
   */
  restoreHistory: (documentPath: string, entry: HistoryEntry) => Promise<void>;
  /**
   * 在系统文件管理器里打开工作区的版本历史目录。
   *
   * 返回**是否真的打开了**：目录还不存在（从未保存过任何版本）时主进程返回 `false`，
   * 而不是抛异常 —— 「还没有历史」是正常状态，不是错误。
   */
  openHistoryDirectory: (rootPath: string) => Promise<boolean>;
  /**
   * 在系统文件管理器里打开该工作区的**索引库目录**。
   *
   * 索引在 `userData` 下、不在工作区里，所以用户平时看不到它。返回是否真的打开了：
   * 目录不存在（这个工作区还没建过索引）时返回 `false`，而不是抛异常。
   */
  openIndexDirectory: (rootPath: string) => Promise<boolean>;
  /**
   * 该工作区的索引库**文件**路径（`.db`，在 `userData` 下）。
   *
   * 与 `openIndexDirectory` 是同一个库的两半：那个把文件管理器开到它所在的目录，这个把
   * 路径交给界面显示 —— 用户想知道「索引到底落在哪」时，光能打开目录是不够的
   * （目录里是一堆哈希名，看不出哪个是本工作区的）。
   *
   * 目录还没建过索引时**照样返回路径**：它是工作区路径的纯函数，值不依赖文件是否存在。
   * 工作区未授权时主进程抛异常，不返回空串 —— 路径里含 `userData`，不该对任意输入给出来。
   */
  getIndexPath: (rootPath: string) => Promise<string | null>;
  setDirty: (isDirty: boolean) => void;
  onSaveAndCloseRequested: (callback: () => Promise<void>) => Unsubscribe;
  readyToClose: () => void;
  closeWindow: () => void;
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  getWindowState: () => Promise<WindowState>;
  onWindowStateChanged: (callback: (state: WindowState) => void) => Unsubscribe;
  /**
   * 打开设置窗口。**单例** —— 已经开着就还原并聚焦，不会开出第二个。
   *
   * 只从主窗口调用：设置界面自己不再提供「打开设置」的入口。
   */
  openSettingsWindow: () => Promise<void>;
  /**
   * 打开主题窗口。**单例** —— 已经开着就还原并聚焦，不会开出第二个。
   *
   * 只从**设置窗口**的外观分组调用：主题编辑器是外观设置的下钻，主窗口里不再另开一个入口。
   */
  openThemeWindow: () => Promise<void>;
  /**
   * 应用界面缩放。值是 `ui-zoom.ts` 里的**档位字符串**（`'100'` / `'125'`…），
   * 不是倍率 —— 取值域的校验在那份口径里，这条桥只负责把值交给 `webFrame`。
   *
   * 同步方法（返回 `void`）：它只是设置当前窗口的缩放，没有可等的 IO。
   */
  setUiZoom: (value: string) => void;
  /**
   * 「本窗口刚改了本机偏好」。主进程收到后广播给**其他**窗口，让它们重读存档。
   *
   * 单向 `send` 而不是 `invoke`：广播没有返回值，也不该让写盘路径去等一个 IPC 往返。
   */
  notifySettingsChanged: () => void;
  /**
   * 把**主进程要照着做**的设置值送过去（`HostSettings`）。
   *
   * 返回 Promise 而不是单向 `send`：调用方要能等它落定 —— 索引启动紧跟着设置同步，
   * 只发不等的话第一次建索引可能跑在旧规则上。
   */
  syncHostSettings: (settings: HostSettings) => Promise<void>;
  /**
   * 别的窗口改了本机偏好，该重读了。
   *
   * 只带「变了」这个事实、不带新值：新值在存档里，收方自己重读 —— 传值就得定义一份
   * 载荷格式，而两份格式迟早对不上。
   */
  onSettingsChanged: (callback: () => void) => Unsubscribe;
}
