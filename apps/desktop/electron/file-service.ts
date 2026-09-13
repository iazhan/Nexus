import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import {
  FileServiceError,
  type FileDocument,
  type FileWatchListener,
  type Unsubscribe
} from '@nexus/core';
import type { FileDialog } from './file-dialog.js';

/**
 * 文件句柄最小接口，便于测试 mock 与原子保存操作。
 */
export interface FileHandleLike {
  writeFile(data: string, encoding: BufferEncoding): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * 文件监听器最小接口。
 */
export interface FSWatcherLike {
  close(): void;
  on(event: 'change', listener: (eventType: string, filename: string | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

/**
 * 文件系统适配层，消除对 Electron GUI 和具体运行时实现的硬依赖。
 */
export interface FileSystemAdapter {
  readFile(filePath: string, encoding: BufferEncoding): Promise<string>;
  open(filePath: string, flags: string | number, mode?: number): Promise<FileHandleLike>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  stat(filePath: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
  watch(
    filePath: string,
    options: { persistent?: boolean },
    listener?: (eventType: string, filename: string | null) => void
  ): FSWatcherLike;
  exists?(filePath: string): Promise<boolean>;
}

/**
 * 默认基于 Node.js 原生 fs 的文件系统适配器。
 */
export class DefaultFileSystemAdapter implements FileSystemAdapter {
  async readFile(filePath: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    return fsPromises.readFile(filePath, { encoding });
  }

  async open(filePath: string, flags: string | number, mode?: number): Promise<FileHandleLike> {
    const handle = await fsPromises.open(filePath, flags, mode);
    return {
      writeFile: (data, encoding) => handle.writeFile(data, encoding),
      sync: () => handle.sync(),
      close: () => handle.close()
    };
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    return fsPromises.rename(oldPath, newPath);
  }

  async unlink(filePath: string): Promise<void> {
    return fsPromises.unlink(filePath);
  }

  async stat(filePath: string): Promise<{ isFile(): boolean; isDirectory(): boolean }> {
    return fsPromises.stat(filePath);
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  watch(
    filePath: string,
    options: { persistent?: boolean },
    listener?: (eventType: string, filename: string | null) => void
  ): FSWatcherLike {
    return fs.watch(filePath, options, listener);
  }
}

/** 原子保存配置选项。 */
export interface AtomicWriteOptions {
  fsAdapter?: FileSystemAdapter;
  forceBackupSwap?: boolean;
}

/**
 * 原子写入文件：
 * 1. 同目录下创建唯一临时文件；
 * 2. 写入内容后 sync/close；
 * 3. Windows 平台若目标已存在，使用备份文件交换并在失败时尽力恢复原文件；
 * 4. 失败清理临时文件，且不能吞错。
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const fsAdapter = options.fsAdapter ?? new DefaultFileSystemAdapter();
  const dir = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  const uniqueToken = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const tmpPath = path.join(dir, `.${basename}.${uniqueToken}.tmp`);
  const bakPath = path.join(dir, `.${basename}.${uniqueToken}.bak`);

  // 1. 打开同目录临时文件写入并 sync
  let handle: FileHandleLike | null = null;
  try {
    handle = await fsAdapter.open(tmpPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // 忽略句柄关闭错误
      }
      handle = null;
    }
    await safeUnlink(fsAdapter, tmpPath);
    throw wrapIoError('写入临时文件失败', targetPath, err);
  }

  try {
    await handle.close();
    handle = null;
  } catch (err) {
    await safeUnlink(fsAdapter, tmpPath);
    throw wrapIoError('关闭临时文件句柄失败', targetPath, err);
  }

  // 2. 检测目标文件是否存在
  let targetExists = false;
  try {
    if (fsAdapter.exists) {
      targetExists = await fsAdapter.exists(targetPath);
    } else {
      await fsAdapter.stat(targetPath);
      targetExists = true;
    }
  } catch (err) {
    if (!isNotFoundError(err)) {
      throw wrapIoError('检查目标文件是否存在失败', targetPath, err);
    }
    targetExists = false;
  }

  const isWindows = process.platform === 'win32';
  const shouldBackupSwap = (isWindows || options.forceBackupSwap) && targetExists;

  if (shouldBackupSwap) {
    // Windows 下目标已存在：先备份原文件，再以临时文件替换目标；失败尽力恢复原文件
    try {
      await fsAdapter.rename(targetPath, bakPath);
    } catch (bakErr) {
      await safeUnlink(fsAdapter, tmpPath);
      throw wrapIoError('创建原文件备份失败', targetPath, bakErr);
    }

    try {
      await fsAdapter.rename(tmpPath, targetPath);
    } catch (renameErr) {
      // 替换失败，尽力将备份文件恢复为原文件
      try {
        await fsAdapter.rename(bakPath, targetPath);
      } catch {
        // 尽力恢复，原错误仍须向外抛出
      }
      await safeUnlink(fsAdapter, tmpPath);
      throw wrapIoError('原子替换目标文件失败', targetPath, renameErr);
    }

    // 替换成功后清理备份文件
    await safeUnlink(fsAdapter, bakPath);
  } else {
    // 目标不存在或非 Windows：直接将临时文件重命名为目标文件
    try {
      await fsAdapter.rename(tmpPath, targetPath);
    } catch (renameErr) {
      await safeUnlink(fsAdapter, tmpPath);
      throw wrapIoError('重命名替换目标文件失败', targetPath, renameErr);
    }
  }
}

/** 尽力清理临时或备份文件。 */
async function safeUnlink(fsAdapter: FileSystemAdapter, filePath: string): Promise<void> {
  try {
    await fsAdapter.unlink(filePath);
  } catch (error) {
    if (isNotFoundError(error)) return;
    console.error(`[Nexus File Service] 文件清理失败: ${filePath}`, error);
  }
}

/** 统一包装 IO 异常，保证不吞错。 */
function getErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return undefined;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isNotFoundError(err: unknown): boolean {
  return getErrorCode(err) === 'ENOENT';
}

function wrapIoError(action: string, filePath: string, err: unknown): FileServiceError {
  if (err instanceof FileServiceError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new FileServiceError('IO_ERROR', `${action}: ${message}`, filePath);
}

/** FileService 初始化配置。 */
export interface FileServiceOptions {
  dialog?: FileDialog;
  fsAdapter?: FileSystemAdapter;
  debounceMs?: number;
  allowedPaths?: string[];
  forceBackupSwap?: boolean;
}

/**
 * 桌面端核心文件服务。
 * 负责本地 Markdown 文件的受控访问、原子保存与变更监听。
 */
export class FileService {
  private readonly dialog?: FileDialog;
  private readonly fsAdapter: FileSystemAdapter;
  private readonly debounceMs: number;
  private readonly forceBackupSwap: boolean;
  private readonly allowedPaths = new Set<string>();

  constructor(options: FileServiceOptions = {}) {
    this.dialog = options.dialog;
    this.fsAdapter = options.fsAdapter ?? new DefaultFileSystemAdapter();
    this.debounceMs = options.debounceMs ?? 50;
    this.forceBackupSwap = options.forceBackupSwap ?? false;

    if (options.allowedPaths) {
      for (const p of options.allowedPaths) {
        this.allowedPaths.add(this.toPathKey(p));
      }
    }
  }

  /**
   * 打开指定 Markdown 文件。未传路径时通过注入的 FileDialog 交互选择。
   * 成功打开后建立精确的 allowed file boundary。
   */
  async openFile(filePath?: string): Promise<FileDocument> {
    let targetPath = filePath;

    if (!targetPath) {
      if (!this.dialog) {
        throw new FileServiceError('IO_ERROR', '未注入 FileDialog，无法打开文件选择对话框');
      }
      const chosen = await this.dialog.openFile();
      if (!chosen) {
        throw new FileServiceError('CANCELLED', '用户取消了打开文件');
      }
      targetPath = chosen;
    }

    this.validateExtension(targetPath);
    const normalizedPath = this.normalizePath(targetPath);

    let content: string;
    try {
      content = await this.fsAdapter.readFile(normalizedPath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileServiceError('NOT_FOUND', `文件未找到: ${normalizedPath}`, normalizedPath);
      }
      throw wrapIoError('读取文件失败', normalizedPath, err);
    }

    // 建立精确的 allowed file boundary
    this.allowedPaths.add(this.toPathKey(normalizedPath));

    return {
      path: normalizedPath,
      content
    };
  }

  /**
   * 读取允许范围内的 Markdown 文件内容。
   */
  async readFile(filePath: string): Promise<string> {
    const normalizedPath = this.normalizePath(filePath);
    this.checkBoundary(normalizedPath);
    this.validateExtension(normalizedPath);

    try {
      return await this.fsAdapter.readFile(normalizedPath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileServiceError('NOT_FOUND', `文件未找到: ${normalizedPath}`, normalizedPath);
      }
      throw wrapIoError('读取文件失败', normalizedPath, err);
    }
  }

  /**
   * 将内容以原子方式保存到指定文件。
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    const normalizedPath = this.normalizePath(filePath);
    this.checkBoundary(normalizedPath);
    this.validateExtension(normalizedPath);

    await atomicWriteFile(normalizedPath, content, {
      fsAdapter: this.fsAdapter,
      forceBackupSwap: this.forceBackupSwap
    });
  }

  /**
   * 另存为文件：通过对话框选择新路径，原子写入并将其纳入 allowed file boundary。
   */
  async saveAs(content: string): Promise<string> {
    if (!this.dialog) {
      throw new FileServiceError('IO_ERROR', '未注入 FileDialog，无法打开保存对话框');
    }

    const chosen = await this.dialog.saveFile();
    if (!chosen) {
      throw new FileServiceError('CANCELLED', '用户取消了另存为');
    }

    this.validateExtension(chosen);
    const normalizedPath = this.normalizePath(chosen);

    await atomicWriteFile(normalizedPath, content, {
      fsAdapter: this.fsAdapter,
      forceBackupSwap: this.forceBackupSwap
    });

    // 成功保存后将其加入 allowed boundary
    this.allowedPaths.add(this.toPathKey(normalizedPath));

    return normalizedPath;
  }

  /**
   * 监听文件变更。过滤无关事件并提供去抖，unsubscribe 保证幂等且释放底座资源。
   */
  watchFile(filePath: string, listener: FileWatchListener): Unsubscribe {
    const normalizedPath = this.normalizePath(filePath);
    this.checkBoundary(normalizedPath);
    this.validateExtension(normalizedPath);

    const targetBasename = path.basename(normalizedPath);
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let isUnsubscribed = false;
    let watcher: FSWatcherLike | null = null;
    let pendingEventType: 'changed' | 'renamed' | 'deleted' = 'changed';

    const triggerEvent = async () => {
      if (isUnsubscribed) return;
      try {
        let fileExists = false;
        try {
          if (this.fsAdapter.exists) {
            fileExists = await this.fsAdapter.exists(normalizedPath);
          } else {
            await this.fsAdapter.stat(normalizedPath);
            fileExists = true;
          }
        } catch (err) {
          if (!isNotFoundError(err)) {
            throw err;
          }
          fileExists = false;
        }

        if (!fileExists) {
          listener({ type: 'deleted', path: normalizedPath });
        } else {
          listener({
            type: pendingEventType === 'renamed' ? 'renamed' : 'changed',
            path: normalizedPath
          });
        }
      } catch (err) {
        listener({
          type: 'error',
          path: normalizedPath,
          message: err instanceof Error ? err.message : String(err)
        });
      }
    };

    const handleFsEvent = (eventType: string, filename: string | null) => {
      if (isUnsubscribed) return;

      // 过滤目标文件：如果 filename 存在，必须与目标文件 basename 匹配
      if (filename) {
        const isMatch =
          process.platform === 'win32'
            ? filename.toLowerCase() === targetBasename.toLowerCase()
            : filename === targetBasename;
        if (!isMatch) {
          return;
        }
      }

      if (eventType === 'rename') {
        pendingEventType = 'renamed';
      } else {
        pendingEventType = 'changed';
      }

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        void triggerEvent();
      }, this.debounceMs);
    };

    try {
      // 监听父目录，原子替换会更换目标文件 inode；监听目录可继续接收后续变更。
      watcher = this.fsAdapter.watch(path.dirname(normalizedPath), { persistent: false }, handleFsEvent);

      // 监听底座 watcher 错误并上报
      watcher.on('error', (err: Error) => {
        if (isUnsubscribed) return;
        listener({
          type: 'error',
          path: normalizedPath,
          message: err.message,
          code: (err as NodeJS.ErrnoException).code
        });
      });
    } catch (err) {
      throw wrapIoError('启动文件监听失败', normalizedPath, err);
    }

    // 返回幂等 unsubscribe 回调
    return () => {
      if (isUnsubscribed) return;
      isUnsubscribed = true;

      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }

      if (watcher) {
        try {
          watcher.close();
        } catch {
          // 忽略 close 异常
        }
        watcher = null;
      }
    };
  }

  /** 获取当前已授权的文件路径集合。 */
  getAllowedPaths(): string[] {
    return Array.from(this.allowedPaths);
  }

  /** 路径规范化为系统绝对路径。 */
  private normalizePath(inputPath: string): string {
    if (!inputPath || typeof inputPath !== 'string') {
      throw new FileServiceError('OUT_OF_BOUNDS', '无效的文件路径');
    }
    return path.resolve(inputPath);
  }

  /** 校验是否为 .md 或 .markdown 扩展名。 */
  private validateExtension(filePath: string): void {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.md' && ext !== '.markdown') {
      throw new FileServiceError(
        'UNSUPPORTED_TYPE',
        `不支持的文件扩展名 "${ext}"，仅支持 .md 和 .markdown 文件`,
        filePath
      );
    }
  }

  /** 生成比较键（Windows 平台忽略大小写）。 */
  private toPathKey(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  /** 校验路径是否在 allowed boundary 内。 */
  private checkBoundary(normalizedPath: string): void {
    const key = this.toPathKey(normalizedPath);
    if (!this.allowedPaths.has(key)) {
      throw new FileServiceError(
        'OUT_OF_BOUNDS',
        `访问路径超出允许边界: ${normalizedPath}`,
        normalizedPath
      );
    }
  }
}
