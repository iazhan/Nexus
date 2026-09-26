import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import {
  FileServiceError,
  type FileDocument,
  type FileWatchListener,
  type Unsubscribe,
  type WorkspaceMarkdownFile,
  type WorkspaceScanResult
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
 * readdir 返回的目录项最小接口。
 */
export interface DirectoryEntryLike {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * 文件系统适配层，消除对 Electron GUI 和具体运行时实现的硬依赖。
 */
export interface FileSystemAdapter {
  readFile(filePath: string, encoding: BufferEncoding): Promise<string>;
  open(filePath: string, flags: string | number, mode?: number): Promise<FileHandleLike>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  stat(
    filePath: string
  ): Promise<{ isFile(): boolean; isDirectory(): boolean; size?: number; mtimeMs?: number }>;
  readdir?(dirPath: string): Promise<DirectoryEntryLike[]>;
  realpath?(filePath: string): Promise<string>;
  watch(
    filePath: string,
    options: { persistent?: boolean },
    listener?: (eventType: string, filename: string | null) => void
  ): FSWatcherLike;
  exists?(filePath: string): Promise<boolean>;
  access?(filePath: string, mode?: number): Promise<void>;
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

  async stat(
    filePath: string
  ): Promise<{ isFile(): boolean; isDirectory(): boolean; size?: number; mtimeMs?: number }> {
    return fsPromises.stat(filePath);
  }

  async readdir(dirPath: string): Promise<DirectoryEntryLike[]> {
    return fsPromises.readdir(dirPath, { withFileTypes: true });
  }

  async realpath(filePath: string): Promise<string> {
    return fsPromises.realpath(filePath);
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

  async access(filePath: string, mode?: number): Promise<void> {
    return fsPromises.access(filePath, mode);
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

/** 支持的 Markdown 扩展名（小写，含点）。 */
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

/** 扫描工作区时跳过的目录名（按名称精确匹配）。 */
const SKIPPED_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.obsidian',
  '.trash',
  // 本应用自己的元数据目录。版本历史存在 `.nexus/history/` 下，
  // 里面的 `.md` 是**快照**不是文档 —— 不排除的话它们会被索引成文档、
  // 还会出现在文件树里。
  '.nexus',
  'dist',
  'out',
  'build',
  '.cache'
]);

/**
 * 判断 target 是否位于 root 之下（含 root 自身）。
 *
 * 用 `path.relative` 而不是字符串 `startsWith` —— 后者会被前缀相同的兄弟目录骗过：
 * `C:\Notes2` 以 `C:\Notes` 开头，但它不是 `C:\Notes` 的子目录。
 * `path.win32.relative` 在 Windows 上大小写不敏感，与本仓库的 `toPathKey` 口径一致。
 */
export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '') return true; // 就是 root 自己
  if (path.isAbsolute(relative)) return false; // 不同盘符 / 不同根
  return !relative.startsWith('..') && !relative.startsWith(`..${path.sep}`);
}

/**
 * 扫描参数。只在 main 侧使用，不进共享契约。
 */
export interface ScanWorkspaceOptions {
  /** 收集上限，默认 20000。达到上限即停止并置 truncated */
  maxFiles?: number;
  /** 递归深度上限，默认 24 */
  maxDepth?: number;
}

/** FileService 初始化配置。 */
export interface FileServiceOptions {
  dialog?: FileDialog;
  fsAdapter?: FileSystemAdapter;
  debounceMs?: number;
  allowedPaths?: string[];
  /** 启动时即授权的工作区根目录 */
  workspaceRoots?: string[];
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
  /** 已授权的工作区根（含用户传入路径与其 realpath） */
  private readonly allowedRoots = new Set<string>();
  /** 只存 realpath 化的根，用于识别符号链接逃逸 */
  private readonly realRoots = new Set<string>();

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

    // 构造函数不能 await，所以这里只做字符串层面的根登记；
    // realpath 层面的登记要显式调用 authorizeWorkspace()。
    if (options.workspaceRoots) {
      for (const root of options.workspaceRoots) {
        this.allowedRoots.add(this.toPathKey(root));
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
    let readOnly = false;
    try {
      content = await this.fsAdapter.readFile(normalizedPath, 'utf-8');
      try {
        if (this.fsAdapter.access) {
          await this.fsAdapter.access(normalizedPath, fs.constants.W_OK);
        }
      } catch {
        readOnly = true;
      }
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
      content,
      readOnly
    };
  }

  /**
   * 读取允许范围内的 Markdown 文件内容。
   */
  async readFile(filePath: string): Promise<string> {
    const normalizedPath = this.normalizePath(filePath);
    this.checkBoundary(normalizedPath);
    this.validateExtension(normalizedPath);
    await this.assertNoSymlinkEscape(normalizedPath);

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
    await this.assertNoSymlinkEscape(normalizedPath);

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
    if (!MARKDOWN_EXTENSIONS.has(ext)) {
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

  /**
   * 校验路径是否在 allowed boundary 内。
   *
   * 两种授权形态，任一命中即放行：
   *   - 精确文件：lightweight 单文件打开、saveAs 之后
   *   - 目录根：workspace 模式，根之下的任意路径
   */
  private checkBoundary(normalizedPath: string): void {
    if (this.isAuthorized(normalizedPath)) return;
    throw new FileServiceError(
      'OUT_OF_BOUNDS',
      `访问路径超出允许边界: ${normalizedPath}`,
      normalizedPath
    );
  }

  private isAuthorized(normalizedPath: string): boolean {
    if (this.allowedPaths.has(this.toPathKey(normalizedPath))) return true;
    return this.isInsideAnyRoot(this.allowedRoots, normalizedPath);
  }

  private isInsideAnyRoot(roots: Set<string>, targetPath: string): boolean {
    for (const root of roots) {
      if (isPathInside(root, targetPath)) return true;
    }
    return false;
  }

  /**
   * 在字符串边界之上再做一次 realpath 校验，识别「工作区内的符号链接指向工作区外」。
   *
   * 字符串判断看不穿 symlink/junction，而这正是边界模型最容易漏的一条。
   * 只在授权过目录根时执行（单文件模式没有 root 可比），且 realpath 失败一律放行：
   * 目标不存在是正常情况（新建文件），后续读写会给出更准确的错误。
   */
  private async assertNoSymlinkEscape(normalizedPath: string): Promise<void> {
    if (this.realRoots.size === 0 || !this.fsAdapter.realpath) return;

    let real: string;
    try {
      real = await this.fsAdapter.realpath(normalizedPath);
    } catch {
      return;
    }

    if (this.isInsideAnyRoot(this.realRoots, real)) return;

    throw new FileServiceError(
      'OUT_OF_BOUNDS',
      `路径经符号链接指向工作区外: ${normalizedPath} → ${real}`,
      normalizedPath
    );
  }

  /**
   * 授权一个工作区根目录：该目录下的任意文件都可读写。
   *
   * 除字符串路径外同时登记 realpath，让 `assertNoSymlinkEscape` 能识破
   * 「工作区里的链接指向外部」这种逃逸。
   */
  async authorizeWorkspace(rootPath: string): Promise<string> {
    const normalized = this.normalizePath(rootPath);

    let isDirectory = false;
    try {
      isDirectory = (await this.fsAdapter.stat(normalized)).isDirectory();
    } catch (err) {
      if (isNotFoundError(err)) {
        throw new FileServiceError('NOT_FOUND', `工作区目录不存在: ${normalized}`, normalized);
      }
      throw wrapIoError('读取工作区目录失败', normalized, err);
    }

    if (!isDirectory) {
      throw new FileServiceError('IO_ERROR', `不是目录: ${normalized}`, normalized);
    }

    this.allowedRoots.add(this.toPathKey(normalized));

    if (this.fsAdapter.realpath) {
      try {
        const real = await this.fsAdapter.realpath(normalized);
        this.allowedRoots.add(this.toPathKey(real));
        this.realRoots.add(this.toPathKey(real));
      } catch {
        // realpath 失败不阻塞授权：字符串边界已经生效
      }
    }

    return normalized;
  }

  /**
   * 递归扫描工作区下的 Markdown 文件。
   *
   * 索引是派生数据、扫盘是唯一的重建途径，所以这里不做增量，每次全量跑。
   * 不跟随符号链接（避免目录环路与越界），跳过 node_modules/.git 等目录。
   * 结果顺序不保证稳定，调用方自行排序。
   */
  async scanWorkspaceMarkdownFiles(
    rootPath: string,
    options: ScanWorkspaceOptions = {}
  ): Promise<WorkspaceScanResult> {
    const normalizedRoot = this.normalizePath(rootPath);
    this.checkBoundary(normalizedRoot);

    const readdir = this.fsAdapter.readdir;
    if (!readdir) {
      throw new FileServiceError('IO_ERROR', '文件系统适配层未实现 readdir，无法扫描工作区');
    }

    const maxFiles = options.maxFiles ?? 20000;
    const maxDepth = options.maxDepth ?? 24;

    const files: WorkspaceMarkdownFile[] = [];
    let truncated = false;
    let skippedDirectories = 0;

    const walk = async (dirPath: string, depth: number): Promise<void> => {
      if (truncated || depth > maxDepth) return;

      let entries: DirectoryEntryLike[];
      try {
        entries = await readdir(dirPath);
      } catch (err) {
        // 单个目录读不动（权限不足、扫描途中被删）不该让整次扫描失败
        if (isNotFoundError(err)) return;
        throw wrapIoError('读取目录失败', dirPath, err);
      }

      for (const entry of entries) {
        if (truncated) return;

        const childPath = path.join(dirPath, entry.name);

        if (entry.isSymbolicLink()) continue;

        if (entry.isDirectory()) {
          if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
            skippedDirectories += 1;
            continue;
          }
          await walk(childPath, depth + 1);
          continue;
        }

        if (!entry.isFile()) continue;
        if (!MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }

        let sizeBytes = 0;
        let modifiedAtMs = 0;
        try {
          const stats = await this.fsAdapter.stat(childPath);
          sizeBytes = stats.size ?? 0;
          modifiedAtMs = stats.mtimeMs ?? 0;
        } catch {
          // stat 失败（扫描途中被删）仍然收录，元数据留 0
        }

        files.push({
          path: childPath,
          relativePath: path.relative(normalizedRoot, childPath).split(path.sep).join('/'),
          name: entry.name,
          sizeBytes,
          modifiedAtMs
        });
      }
    };

    await walk(normalizedRoot, 0);

    return { files, truncated, skippedDirectories };
  }

  /** 获取当前已授权的工作区根目录。 */
  getWorkspaceRoots(): string[] {
    return Array.from(this.allowedRoots);
  }
}
