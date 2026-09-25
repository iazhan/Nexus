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
 * 工作区扫描结果。
 */
export interface WorkspaceScanResult {
  files: WorkspaceMarkdownFile[];
  /** 是否因达到 maxFiles 而提前停止 */
  truncated: boolean;
  /** 被跳过的目录数（node_modules、.git 等） */
  skippedDirectories: number;
}

/**
 * 被索引的一篇 Markdown 文档。
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
  sizeBytes: number;
  modifiedAtMs: number;
  contentHash: string;
}

/** 全文检索命中的一条结果。 */
export interface SearchHit {
  documentId: number;
  path: string;
  relativePath: string;
  name: string;
  title: string;
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
  /** 扫描是否因达到上限而提前结束 */
  truncated: boolean;
  /** 单个文件失败的原因（不阻断整次索引） */
  errors: string[];
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
