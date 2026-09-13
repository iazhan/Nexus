/**
 * 已打开的本地文档，内容保持 UTF-8 原文。
 */
export interface FileDocument {
  /** 规范化后的绝对路径 */
  path: string;
  /** 文件原始内容 */
  content: string;
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
