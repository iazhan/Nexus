import type {
  LaunchContext,
  FileDocument,
  FileWatchListener,
  Unsubscribe,
  WorkspaceScanResult,
  IndexedDocument,
  SearchHit,
  IndexWorkspaceResult,
  WorkspaceGraph
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
  setDirty: (isDirty: boolean) => void;
  onSaveAndCloseRequested: (callback: () => Promise<void>) => Unsubscribe;
  readyToClose: () => void;
  closeWindow: () => void;
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  getWindowState: () => Promise<WindowState>;
  onWindowStateChanged: (callback: (state: WindowState) => void) => Unsubscribe;
}
