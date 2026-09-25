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
