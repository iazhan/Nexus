import type { DocumentType } from '../document/types.js';
import type { ExtractionStatus } from '../processor/types.js';

/**
 * 已打开的本地文档，内容保持 UTF-8 原文。
 */
export interface FileDocument {
  /** 规范化后的绝对路径 */
  path: string;
  /** 文件原始内容 */
  content: string;
  /** 文件是否为只读 */
  readOnly?: boolean;
}

/**
 * 工作区扫描命中的一个 Markdown 文件。
 */
export interface WorkspaceMarkdownFile {
  /** 绝对路径 */
  path: string;
  /** 相对工作区根，始终用正斜杠，便于跨平台比较与展示 */
  relativePath: string;
  /** 文件名（含扩展名） */
  name: string;
  /** 最后修改时间（毫秒）；stat 失败时为 0 */
  modifiedAtMs: number;
  /** 字节数；stat 失败时为 0 */
  sizeBytes: number;
}

/**
 * 工作区扫描命中的一个文档文件 —— Markdown 或附件（Phase 3 / P3-04）。
 *
 * 与 `WorkspaceMarkdownFile` 的唯一区别是多了 `type`。用继承而不是另起一个平级
 * 接口，是为了让「只关心路径与元数据」的调用方继续接收父类型 —— 多出来的字段
 * 对它们是透明的。
 */
export interface WorkspaceDocumentFile extends WorkspaceMarkdownFile {
  type: DocumentType;
}

/**
 * 工作区里的一个**目录**。
 *
 * 与 `WorkspaceDocumentFile` 平级而不是它的子类：目录没有大小、修改时间、内容哈希，
 * 强行共用会把三个「对文件才有意义」的字段变成「目录上恒为 0」—— 而 0 与「不知道」
 * 在类型上分不开，下游迟早拿它当真的用。
 *
 * `path` 与 `relativePath` 都给：主进程两样都知道，而让渲染进程拿 `relativePath`
 * 去拼绝对路径等于把「工作区根是哪一层、分隔符是什么」复制一份过去。
 */
export interface WorkspaceDirectoryEntry {
  /** 绝对路径 */
  path: string;
  /** 相对工作区根，始终用正斜杠 */
  relativePath: string;
  /** 目录名（不含路径） */
  name: string;
}

/**
 * 工作区扫描结果。
 *
 * 泛型参数是 Phase 3 / P3-04 加的：同一个扫描器既要服务「只收 Markdown」的索引器
 * （P2 的契约），也要服务「Markdown + 附件」的新扫描。带默认值是为了让既有调用方
 * 一行都不用改。
 */
export interface WorkspaceScanResult<T = WorkspaceMarkdownFile> {
  files: T[];
  /** 是否因达到 maxFiles 而提前停止 */
  truncated: boolean;
  /** 被跳过的目录数（node_modules、.git 等） */
  skippedDirectories: number;
}

/**
 * 被索引的一篇文档 —— Markdown 或附件。
 *
 * 索引是派生数据 —— 这里除了路径、标题和内容哈希，**不该有别的字段**。
 * 任何「只有索引才知道的事实」都会让「删库重建」不再等价。
 */
export interface IndexedDocument {
  id: number;
  path: string;
  relativePath: string;
  name: string;
  title: string;
  /**
   * 文档类型（Phase 3 / P3-04）。
   *
   * 存进索引是**派生**的 —— 由路径经 `documentTypeForPath()` 判定，不是独立事实，
   * 所以不违反上面那条不变量。之所以落库而不是查询时现算：Quick Open、文件树、
   * 反向链接、图谱都要问「这是不是附件」，让每个消费方各跑一遍白名单判定
   * 迟早出现某一处忘了过滤（P3-03 把白名单归并到 core 就是同一个教训）。
   */
  type: DocumentType;
  sizeBytes: number;
  modifiedAtMs: number;
  contentHash: string;
  /**
   * **文本提取状态**（Phase 3 / P3-10）。
   *
   * 只有附件会带上有意义的值；Markdown 恒为 `'none'`（它本身就是文本，不需要提取）。
   *
   * 落库而不是查询时现算：界面要凭它显示「未提取到文本」，而那个判断只该有
   * **一处**判据。让侧栏与搜索面板各自去问一次「这个 PDF 提过没有」，
   * 迟早出现「一边说提过、一边说没提过」。
   */
  extractionStatus: ExtractionStatus;
}

/** 全文检索命中的一条结果。 */
export interface SearchHit {
  documentId: number;
  path: string;
  relativePath: string;
  name: string;
  title: string;
  /**
   * 文档类型。搜索面板凭它显示类型徽标 ——
   * P3-10 起附件也会出现在结果里（被 Markdown 引用过的 PDF/DOCX 提取出的文本进了
   * 全文索引），不标出来用户会以为搜到的是笔记。
   */
  type: DocumentType;
  /** 与 `IndexedDocument.extractionStatus` 同义，见那里的说明。 */
  extractionStatus: ExtractionStatus;
}

/** 一次工作区索引的结果统计。 */
export interface IndexWorkspaceResult {
  /** 扫到的 Markdown 文件数 */
  scanned: number;
  /** 新增或更新的文档数 */
  indexed: number;
  /** 内容哈希未变、跳过的文档数 */
  skipped: number;
  /** 磁盘上已消失、从索引里清掉的文档数 */
  removed: number;
  /**
   * 本次**提取出文本**的附件数（Phase 3 / P3-10）。
   *
   * 只统计「真的提出了字」的：被引用但提不出文本（扫描版 PDF）的不算，
   * 它们的状态在 `extractionStatus` 里是 `empty`，那是另一件事。
   */
  extracted: number;
  /** 扫描是否因达到上限而提前结束 */
  truncated: boolean;
  /**
   * 单个文件失败的原因（不阻断整次索引）。
   *
   * 包含两类：读不动（权限、扫描途中被删）与**提取失败**（损坏的 PDF/DOCX）。
   * 两者都带 `相对路径: 原因` 的形状 —— 分开成两个数组只会让消费方两处都写。
   */
  errors: string[];
}

/** 图谱里一个**已存在**的文档节点。 */
export interface GraphDocumentNode {
  kind: 'document';
  id: number;
  /** 绝对路径。点击节点要拿它去打开文档，相对路径不够。 */
  path: string;
  relativePath: string;
  name: string;
  /**
   * 文档类型。图谱侧要它做两件事：按类型筛选，以及**不只用颜色区分节点**
   * （蓝图 §12 的要求 —— 只靠颜色的话，色觉障碍用户读不出哪个点是附件）。
   */
  type: DocumentType;
  /** 关联的边数（出入合并计）。用来决定节点画多大。**只数本次返回的边**。 */
  degree: number;
}

/**
 * 图谱里一个**指向不存在的文档**的节点（死链）。
 *
 * ## 为什么要给它一个节点，而不是把这条边丢掉
 *
 * 丢掉是「静默消失」：用户看到某篇文档在图上什么也不连，以为它没有引用，
 * 而真相是它引用了一篇还没建的笔记。`[[还没写的方案]]` 在写下来的那一刻就是一条
 * **真实存在**的链接，只是目标还没落地 —— 图谱的职责是把它显示出来，而不是替用户
 * 判断它不算数。
 *
 * ## `id` 是合成的
 *
 * 它不在 `documents` 表里，没有真 id。合成规则见 `IndexStore.getGraph()`：从
 * `max(documents.id) + 1` 起按目标名排序依次编号。**必须是确定性的** ——
 * 同一份工作区两次打开要得到同一组 id，否则布局形状会变。
 *
 * 因此它**不能**拿去当文档 id 用：没有 `path`，点它只能走「新建」而不是「打开」。
 */
export interface GraphMissingNode {
  kind: 'missing';
  id: number;
  /** 展示名 = 归一化后的链接目标（如 `notes/dma`）。 */
  name: string;
  /**
   * 归一化后的链接目标，与 `links.target` 同一口径（切掉锚点、去 `.md`、小写）。
   *
   * 「新建」时由它推导落点，所以它必须是可以直接拼成路径的形状 —— 不能带锚点。
   */
  linkTarget: string;
  degree: number;
}

export type GraphNode = GraphDocumentNode | GraphMissingNode;

/** 图谱里的一条边。**无向**：`A → B` 与 `B → A` 已合并。 */
export interface GraphEdge {
  source: number;
  target: number;
}

/**
 * 取图时的范围参数。全部可选，不传就是「全工作区的完整图」。
 */
export interface GraphQuery {
  /**
   * 以哪篇文档为中心（**绝对路径**）。不传 = 全图。
   *
   * 路径在索引里找不到时**退回全图**，而不是返回空图 —— 用户刚新建、还没进索引的文档
   * 是常见情形，那时给他一张空画布比给他全图更让人困惑。
   */
  centerPath?: string;
  /**
   * 邻域层数（只在有 `centerPath` 时有意义），默认 1。
   *
   * 边是无向的，所以「出链」和「入链」都算一跳 —— 与图本身的口径一致。
   */
  degrees?: number;
  /** 只保留这些文档类型。不传 = 全部类型。 */
  types?: readonly DocumentType[];
}

export interface WorkspaceGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * 一条出链的**持久化形式**：指向哪一篇 + 指向它的哪一节。
 *
 * `target` 已归一化（切掉 `#锚点`、去 `.md`、转小写），与 `links` 表存的是同一个值 ——
 * 它必须能被 `backlinkTargetsOf()` 的候选直接等值比中，否则这条链接会「写得进、查不到」。
 *
 * `anchor` 是第一个 `#` 之后的原文（未归一化：标题锚点区分大小写），没有则为 `null`。
 * 同一篇文档重复指向同一个目标时**只留第一次出现的锚点** —— `links` 表的主键是
 * `(source_id, target)`，一条边只存一行，而「代表哪个锚点」在参考实现里也是取代表值。
 */
export interface WikiLinkTarget {
  target: string;
  anchor: string | null;
}

/**
 * 一条反向链接：谁引用了我 + 引用的是我的哪一节。
 *
 * 定义在 core 而不是主进程 —— preload 要把它作为 IPC 参数类型传给渲染进程，
 * 跨进程类型不能住在一侧的实现文件里（与 `HistoryEntry` 同理）。
 */
export interface BacklinkEntry {
  document: IndexedDocument;
  anchor: string | null;
}

/**
 * 版本历史里的一条快照。
 *
 * 定义在 core 而不是 main 进程的 `history-store.ts` —— preload 要把它作为
 * IPC 参数类型传给渲染进程，跨进程类型不能住在一侧的实现文件里。
 */
export interface HistoryEntry {
  /** 保存时刻，来自文件名（`YYYYMMDDTHHMMSS`，UTC） */
  savedAt: string;
  /** 内容哈希前 8 位，用于识别与去重 */
  hash: string;
  sizeBytes: number;
}

/** 差异里一行的性质。 */
export type DiffLineKind = 'same' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/**
 * 文件监听事件，错误也通过事件显式传递给调用方。
 */
export type FileWatchEvent =
  | { type: 'changed' | 'renamed' | 'deleted'; path: string }
  | { type: 'error'; path: string; message: string; code?: string };

/** 文件监听回调。 */
export type FileWatchListener = (event: FileWatchEvent) => void;

/** 取消文件监听并释放底层资源。 */
export type Unsubscribe = () => void;

/**
 * 文件服务错误码。
 */
export type FileServiceErrorCode =
  | 'CANCELLED'
  | 'OUT_OF_BOUNDS'
  | 'UNSUPPORTED_TYPE'
  | 'NOT_FOUND'
  | 'IO_ERROR';

/**
 * 文件服务可识别错误。
 */
export class FileServiceError extends Error {
  readonly code: FileServiceErrorCode;
  readonly path?: string;

  constructor(code: FileServiceErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'FileServiceError';
    this.code = code;
    this.path = path;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
