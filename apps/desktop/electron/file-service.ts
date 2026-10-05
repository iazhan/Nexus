import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import {
  FileServiceError,
  documentTypeForPath,
  getPathExtension,
  isMarkdownPath,
  shouldIgnoreDirectory,
  supportedDocumentExtensions,
  type DocumentType,
  type FileDocument,
  type FileWatchListener,
  type Unsubscribe,
  type WorkspaceDocumentFile,
  type WorkspaceDirectoryEntry,
  type WorkspaceMarkdownFile,
  type WorkspaceScanResult
} from '@nexus/core';
import type { FileDialog } from './file-dialog.js';
import type { DeleteMode, SaveAttachmentRequest } from '../ipc/channels.js';
import { logError } from './logger.js';

/**
 * 文件句柄最小接口，便于测试 mock 与原子保存操作。
 *
 * `data` 收 `Uint8Array` 是为了**附件**（粘贴进来的图片是字节，不是文本）。
 * 与 `readFileBuffer` 那条分开的理由同源：`string | Uint8Array` 只在这一个签名上出现，
 * 不会把返回类型也污染成联合类型。
 */
export interface FileHandleLike {
  writeFile(data: string | Uint8Array, encoding?: BufferEncoding): Promise<void>;
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
  /**
   * 按字节读取，**不做任何解码**。附件（PDF / DOCX / 图片）走这条。
   *
   * 单独一个方法而不是把 `readFile` 的 `encoding` 放宽成 `BufferEncoding | null`：
   * 后者会让返回类型变成 `string | Buffer`，每个调用点都要多一次收窄，
   * 而实际只有一个调用点需要字节。
   */
  readFileBuffer(filePath: string): Promise<Uint8Array>;
  /**
   * 按**偏移**读一段字节 —— `nexus-asset://` 的 Range 原语（P3-07）。
   *
   * 与 `readFileBuffer` 分开是必须的，不是图省事：PDF.js 会发很多次 Range 请求，
   * 把偏移读实现成「读全文再切片」等于每个请求都过一遍整个文件。
   * `FileHandleLike` 上没有 `read`（只有 writeFile / sync / close），
   * 所以偏移读只能落在适配层。
   *
   * 参数是 `length` 而不是 `end`：对齐 Node 的
   * `fs.read(fd, buffer, offset, length, position)` 与 `Buffer.alloc(length)`。
   * **闭区间 → 长度的转换只在 `FileService.readAssetRange` 一处发生**，
   * 免得两个约定在中间层来回换算。
   *
   * 必填而非可选：可选成员会被漏实现，然后在运行时静默拿到 `undefined`
   * （P3-03 给 `readFileBuffer` 定过同一条）。
   */
  readRange(filePath: string, start: number, length: number): Promise<Uint8Array>;
  open(filePath: string, flags: string | number, mode?: number): Promise<FileHandleLike>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  /**
   * 递归创建目录。附件落盘要它 —— `assets/` 通常还不存在，而 `atomicWriteFile`
   * 在同目录开临时文件，目录不在就直接 `ENOENT`。
   *
   * 必填而非可选：可选成员会被漏实现，然后在运行时静默拿到 `undefined`
   * （P3-03 给 `readFileBuffer`、P3-07 给 `readRange` 定过同一条）。
   */
  mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void>;
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

  async readFileBuffer(filePath: string): Promise<Uint8Array> {
    // Buffer 是 Uint8Array 的子类，按声明类型返回即可（不复制，零成本）。
    return fsPromises.readFile(filePath);
  }

  async readRange(filePath: string, start: number, length: number): Promise<Uint8Array> {
    const handle = await fsPromises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      // 文件在 stat 与 read 之间被截断时 bytesRead < length。返回**实际读到的**字节，
      // 而不是把零填充的尾巴当内容交出去 —— 后者会让 206 的 content-length 撒谎。
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
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

  async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
    await fsPromises.mkdir(dirPath, options);
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
 * 重名时最多试多少个后缀。100 是「够用且不会把一次粘贴变成一百次 stat」的折中：
 * 真要撞满 100 次，模板里必定少了 `{timestamp}` 这类区分位，那时报错比继续找更好。
 */
const MAX_ATTACHMENT_COLLISION_ATTEMPTS = 100;

/**
 * 原子写入文件：
 * 1. 同目录下创建唯一临时文件；
 * 2. 写入内容后 sync/close；
 * 3. Windows 平台若目标已存在，使用备份文件交换并在失败时尽力恢复原文件；
 * 4. 失败清理临时文件，且不能吞错。
 *
 * `content` 收字节是为了附件：粘贴进来的图片必须**原样**落盘，过一遍字符串编码
 * 会把 PNG 的字节改坏（`utf-8` 解码再编码不是恒等变换）。
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string | Uint8Array,
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
    logError(`[Nexus File Service] 文件清理失败: ${filePath}`, error);
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

/**
 * Windows 上文件名不允许出现的字符。
 *
 * `:` 与 `?` `*` 在 NTFS 上是保留字符，`<` `>` `"` 是历史遗留的保留字符，`|` 同上。
 * 不区分平台地一律拒绝：这是**用户敲进来的名字**，跨平台一致比「在 Linux 上能建出来」
 * 有用得多，而且这个应用的目标平台就是 Windows。
 *
 * 控制字符（0x00–0x1F）**不写进这个字符组**：写进去会被 `no-control-regex` 拦下，
 * 而为一个判断加 `eslint-disable` 不如按码点判来得直白（同
 * `renderer/src/settings/preference-specs.ts` 里那处过滤）。
 */
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*]/;

/** 名字里有没有非法字符。控制字符单独按码点判，见上。 */
function hasIllegalNameChar(name: string): boolean {
  if (ILLEGAL_NAME_CHARS.test(name)) return true;
  for (const char of name) {
    if (char.charCodeAt(0) <= 0x1f) return true;
  }
  return false;
}

/**
 * 校验用户敲进来的新名字。
 *
 * 只做「这个名字能不能成为一个文件名」，不碰扩展名 —— 那条是 `renameFile` 的职责，
 * 因为要跟旧名字比才有意义。
 *
 * 拒绝空、`.`、`..`：`path.join(目录, '..')` 会跑到父目录去，那不是改名。
 * 拒绝结尾的 `.` 与空格：Windows 会**静默**把它们吃掉，于是「改成 `a .md`」在资源
 * 管理器里看起来是 `a.md`、在这里又是另一个名字 —— 与其解释不如直接拒绝。
 */
function assertRenameableName(name: string, filePath: string): void {
  if (name.length === 0) {
    throw new FileServiceError('IO_ERROR', '文件名不能为空', filePath);
  }
  if (name === '.' || name === '..') {
    throw new FileServiceError('IO_ERROR', `文件名不能是 ${name}`, filePath);
  }
  if (hasIllegalNameChar(name)) {
    throw new FileServiceError('IO_ERROR', '文件名不能包含 < > : " / \\ | ? * 等字符', filePath);
  }
  if (name.endsWith('.') || name.endsWith(' ')) {
    throw new FileServiceError('IO_ERROR', '文件名不能以点或空格结尾', filePath);
  }
}

/**
 * 新建文件时的扩展名归一化。
 *
 * 没写扩展名就补 `.md`（敲「周报」的意图显然是「周报.md」）；写了但不是 Markdown
 * 就直接拒绝 —— 这条通道只能造**空文本**文件，造一个空 `.png` 只会让图片查看器
 * 打开一片空白，而用户还以为自己新建了一张图。
 *
 * 归一化放在主进程而不是渲染进程：这条规则只该有一份，否则「界面上显示的名字」
 * 与「磁盘上的名字」会分家。
 */
function normalizeNewFileName(name: string, directoryPath: string): string {
  if (path.extname(name) === '') return `${name}.md`;
  if (isMarkdownPath(name)) return name;

  throw new FileServiceError(
    'UNSUPPORTED_TYPE',
    `只能新建 Markdown 文件（.md / .markdown），收到 "${path.extname(name)}"`,
    path.join(directoryPath, name)
  );
}

function wrapIoError(action: string, filePath: string, err: unknown): FileServiceError {
  if (err instanceof FileServiceError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new FileServiceError('IO_ERROR', `${action}: ${message}`, filePath);
}

/**
 * 扩展名判定的**唯一事实源**在 `@nexus/core` 的 `document/extensions.ts`
 * （`documentTypeForPath` / `isMarkdownPath`）。
 *
 * 这里刻意不再保留一份 `MARKDOWN_EXTENSIONS`：曾经 main 侧有一份硬编码、
 * core 侧又有一份白名单，两处并存时「改了一处忘了另一处」不会报错，
 * 只会让扫描/打开/写入对同一个文件给出不同结论。
 */

/**
 * 「哪些目录不看」的判定在 `@nexus/core` 的 `workspace/ignore-rules.ts` —— 那里是唯一事实源。
 *
 * 搬走的理由是设置页要能改它：用户填的那串规则得用**同一个**判定去解释，两处各写一份的话
 * 「设置页显示 `drafts`、实际没跳过」这种错不会报错。为什么是前缀判定而不是逐个列举，
 * 见 core 那份的注释（实测 97 个文档里 12 个来自别的工具的快照与回收站）。
 */

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
  /**
   * 用户自定义的跳过规则（已由 `parseIgnoreRules` 归一化）。
   *
   * 由调用方注入而不是在这里读全局：主进程的「当前宿主设置」是一份可变状态，
   * 而扫描是**可以被并发触发**的（工作区打开时自动跑一次、用户按重建索引又跑一次）。
   * 从参数进来，这一次扫描用的就是同一个快照。
   *
   * 不传即「只有内置规则」—— 与加这条通道之前的行为一致。
   */
  ignoreRules?: readonly string[];
}

/**
 * 「移到系统回收站」这一动作的适配器。
 *
 * 抽一层而不是直接 `import { shell } from 'electron'`：`file-service.ts` 是**不 import
 * electron 的纯模块**（`dialog` / `fsAdapter` 都靠注入），所以它在普通 node 测试里跑得起来。
 * 回收站是同一条理由 —— 它也只是另一个「只有主进程才有的能力」。测试注入一个记账的假实现，
 * 就能断言「这条分支真的走了回收站」，而不是断言「文件没了」（那对两条分支都成立）。
 */
export interface TrashAdapter {
  trashItem(filePath: string): Promise<void>;
}

/** FileService 初始化配置。 */
export interface FileServiceOptions {
  dialog?: FileDialog;
  fsAdapter?: FileSystemAdapter;
  trash?: TrashAdapter;
  debounceMs?: number;
  allowedPaths?: string[];
  /** 启动时即授权的工作区根目录 */
  workspaceRoots?: string[];
  /**
   * 启动时即授权的**资源读取根目录** —— 只对 `nexus-asset://` 生效（P3-07）。
   *
   * 与 `workspaceRoots` 的区别是**权限大小**，不是方便程度：
   * `workspaceRoots` 之下的文件可读**也可写**；`assetRoots` 之下的文件**只能被
   * 资源通道读取**，`readFile` / `writeFile` / `watchFile` 一律照旧拒绝。
   * 两条判据因此不能合并成一个集合。
   *
   * 用途只有一个：**轻量模式下被打开文档所在的那一层目录**。Markdown 里
   * `![](./assets/a.png)` 这类相对引用是相对文档自身解析的，所以「文档所在目录」
   * 就是它的资源边界。没有这条，轻量模式下所有内嵌图片都会 403。
   */
  assetRoots?: string[];
  forceBackupSwap?: boolean;
}

/**
 * 桌面端核心文件服务。
 * 负责本地 Markdown 文件的受控访问、原子保存与变更监听。
 */
export class FileService {
  private readonly dialog?: FileDialog;
  private readonly trash?: TrashAdapter;
  private readonly fsAdapter: FileSystemAdapter;
  private readonly debounceMs: number;
  private readonly forceBackupSwap: boolean;
  private readonly allowedPaths = new Set<string>();
  /** 已授权的工作区根（含用户传入路径与其 realpath） */
  private readonly allowedRoots = new Set<string>();
  /**
   * 已授权的**资源读取**根（P3-07）。**只被 `authorizeAsset` 查询** ——
   * 这条集合里的路径不能读写，只能经 `nexus-asset://` 取字节。
   */
  private readonly assetRoots = new Set<string>();
  /** 只存 realpath 化的根，用于识别符号链接逃逸 */
  private readonly realRoots = new Set<string>();

  constructor(options: FileServiceOptions = {}) {
    this.dialog = options.dialog;
    this.trash = options.trash;
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

    // 资源根同理：字符串登记是**同步**的，于是「窗口一建好、renderer 立刻请求图片」
    // 时边界已经生效。realpath 那半交给 authorizeAssetRoot()。
    //
    // 同步这半不能省 —— 它的缺失会重现 P3-07 那个「只在一条入口上出现」的 bug：
    // 从启动参数直接打开 Markdown 时，renderer 挂载即请求图片，而任何 await 都还没跑完。
    if (options.assetRoots) {
      for (const root of options.assetRoots) {
        this.assetRoots.add(this.toPathKey(root));
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

    this.assertTextDocument(targetPath);
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
    this.assertTextDocument(normalizedPath);
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
   * 读取白名单内任意文档的**字节**（附件走这条，不做 UTF-8 解码）。
   *
   * 与 `readFile` 的差别只有两条，但两条都不能省：
   *   1. 不解码 —— PDF / PNG 按字节读，解成字符串即损坏；
   *   2. 放行非 Markdown 的白名单类型 —— 但仍**逐条走同一边界校验**。
   *
   * 返回 `Uint8Array` 而不是 `Buffer`：现在它只在主进程内被调用（将来的
   * `nexus-asset://` 处理器），但签名留在跨运行时安全的形状里，
   * 万一要经 IPC 递给渲染进程不必改。
   *
   * **不含 Range 参数是有意的**：P3-02 spike 已证明 `net.fetch` 不透传 Range、
   * 必须手动构造 206，而 PDF.js 的分页依赖 206。Range 读需要给适配层补一个
   * 带偏移的读原语（spike 用的是 `openSync` + `readSync`），那是 `nexus-asset://`
   * 自身的形状问题，归 P3-07 —— 现在猜 `{start,length}` 还是 `{start,end}`
   * 只会返工一次。
   */
  async readDocumentBytes(filePath: string): Promise<Uint8Array> {
    const normalizedPath = this.normalizePath(filePath);
    this.checkBoundary(normalizedPath);
    this.assertReadableDocument(normalizedPath);
    await this.assertNoSymlinkEscape(normalizedPath);

    try {
      return await this.fsAdapter.readFileBuffer(normalizedPath);
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        throw new FileServiceError('NOT_FOUND', `文件未找到: ${normalizedPath}`, normalizedPath);
      }
      throw wrapIoError('读取文件失败', normalizedPath, err);
    }
  }

  /**
   * 资源通道（`nexus-asset://`）的准入检查：规范化 → 边界 → 类型 → realpath。
   *
   * 抽成一个方法有两个理由，缺一不可：
   *   1. `statAsset` 与 `readAssetRange` 都要走一遍，而 `assertNoSymlinkEscape`
   *      会做一次 realpath 系统调用 —— PDF.js 会发很多次 Range 请求，
   *      一次请求里跑两遍纯属浪费；
   *   2. 两处各写一遍就**必然**有一处会漏。本文件已经因为「同一个判据存在两份」
   *      吃过一次亏（见文件头关于扩展名表的说明）。
   */
  private async authorizeAsset(filePath: string): Promise<string> {
    const normalizedPath = this.normalizePath(filePath);
    this.checkAssetBoundary(normalizedPath);
    this.assertReadableDocument(normalizedPath);
    await this.assertNoSymlinkEscape(normalizedPath);
    return normalizedPath;
  }

  /**
   * 校验并返回可读资源的**字节长度**。
   *
   * `nexus-asset://` 必须先拿到它才能解析 Range：后缀形式 `bytes=-500` 的起点是
   * `size - 500`，没有 size 就无从下手。所以「先 stat 再读」是协议本身的形状，
   * 不是多余的往返。
   */
  async statAsset(filePath: string): Promise<number> {
    return this.readAssetSize(await this.authorizeAsset(filePath));
  }

  /** 已通过准入检查的路径 → 字节长度。 */
  private async readAssetSize(normalizedPath: string): Promise<number> {
    let stats: { isFile(): boolean; size?: number };
    try {
      stats = await this.fsAdapter.stat(normalizedPath);
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        throw new FileServiceError('NOT_FOUND', `文件未找到: ${normalizedPath}`, normalizedPath);
      }
      throw wrapIoError('读取文件失败', normalizedPath, err);
    }

    if (!stats.isFile()) {
      throw new FileServiceError('NOT_FOUND', `不是文件: ${normalizedPath}`, normalizedPath);
    }
    // 适配层把 size 声明成可选（别的调用方不需要它）。这里必须有，
    // 否则 `Content-Range` 的分母就是 undefined —— 宁可报错，也不要发出一个撒谎的响应。
    if (typeof stats.size !== 'number') {
      throw new FileServiceError('IO_ERROR', `无法确定文件大小: ${normalizedPath}`, normalizedPath);
    }
    return stats.size;
  }

  /**
   * 按**闭区间** `[start, end]` 读资源字节（含两端）—— `nexus-asset://` 的读原语。
   *
   * 用闭区间是因为它离 HTTP 最近：`Content-Range` 写的就是 `bytes 0-99/1000` 这种
   * 闭区间，中间少一次 `±1` 换算就少一处 off-by-one 的机会。适配层的 `readRange`
   * 用 `{start, length}`（对齐 Node `fs.read`），**唯一的转换就是下面那一行**。
   *
   * 越界抛错而不是静默夹取：416 的判定必须发生在 handler 里（只有它知道该回什么
   * 头），这里悄悄修正只会让 handler 永远看不到越界。
   */
  async readAssetRange(filePath: string, start: number, end: number): Promise<Uint8Array> {
    const normalizedPath = await this.authorizeAsset(filePath);
    const size = await this.readAssetSize(normalizedPath);

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
      throw new FileServiceError(
        'IO_ERROR',
        `区间越界: ${start}-${end}（文件 ${size} 字节）`,
        normalizedPath
      );
    }
    // 允许 end 超过末字节（HTTP 的 `bytes=0-` 与 `bytes=0-99999999` 都合法），夹到 size-1。
    const lastByte = Math.min(end, size - 1);

    try {
      return await this.fsAdapter.readRange(normalizedPath, start, lastByte - start + 1);
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
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
    this.assertTextDocument(normalizedPath);
    await this.assertNoSymlinkEscape(normalizedPath);

    await atomicWriteFile(normalizedPath, content, {
      fsAdapter: this.fsAdapter,
      forceBackupSwap: this.forceBackupSwap
    });
  }

  /**
   * 删除一个文件。走回收站还是永久删除由 `mode` 选，**默认回收站**。
   *
   * ## 为什么不把回收站做成 `unlink` 上的一个布尔开关
   *
   * `unlink` 只是「永久删除」那一半的底层原语。用户真正在选的是「删了还能不能找回来」，
   * 而「找回来」这条能力**只有主进程有**（Electron 的 `shell.trashItem`，且它不在
   * `FileSystemAdapter` 的语义里 —— 那个接口描述的是 `fs` 能做的事）。所以两条分支
   * 是并列的两个实现，不是一个开关。
   *
   * ## 三条边界
   *
   * - **只删文件，不删目录。** 递归删除的语义（里面那些东西算谁的、要不要问）是另一个
   *   决定，而树上现在也没有「删目录」这个入口。越界的一律**报错**而不是静默跳过 ——
   *   静默跳过会让调用方以为删成功了。
   * - **走 `checkBoundary`，与 `writeFile` 同一条判据。** 特意**不**用
   *   `checkAssetBoundary`：`assetRoots` 是「只读的资源根」（轻量模式下文档所在的那层
   *   目录），能读不等于能删，合并会把「打开一个 md 就能删掉同目录下任何文件」放开。
   * - **符号链接照查。** 工作区里一个指向区外的 symlink 不能被这条通道删掉区外的目标；
   *   `assertNoSymlinkEscape` 认的就是这件事。
   *
   * 没注入回收站实现时**报错，而不是退回永久删除** —— 那正好把用户选的「还能找回来」
   * 变成不可逆，是这条通道最坏的一种失败方式。
   */
  async deleteFile(filePath: string, mode: DeleteMode = 'trash'): Promise<void> {
    const normalizedPath = this.normalizePath(filePath);
    this.checkBoundary(normalizedPath);
    await this.assertNoSymlinkEscape(normalizedPath);

    const info = await this.fsAdapter.stat(normalizedPath);
    if (!info.isFile()) {
      throw new FileServiceError('IO_ERROR', '只能删除文件，不能删除目录', normalizedPath);
    }

    if (mode === 'permanent') {
      await this.fsAdapter.unlink(normalizedPath);
      return;
    }

    if (!this.trash) {
      throw new FileServiceError('IO_ERROR', '未注入回收站适配器，无法移到回收站', normalizedPath);
    }

    await this.trash.trashItem(normalizedPath);
  }

  /**
   * 算出改名后的绝对路径，**并做完全部校验**，但不碰磁盘。
   *
   * 单独暴露出来是给**预览**用的：渲染进程要先把「会改成什么、哪些引用会跟着改」画出来，
   * 那需要在真正改名之前就知道目标路径。`renameFile` 内部也走这里 ——
   * 目标路径怎么拼、哪些名字不能要，只有这一份判据。
   *
   * 代价是执行时会再校验一遍。那是刻意的：两次调用之间可能有人建了同名文件，
   * 而「不覆盖别人的文件」这条比省一次 `stat` 重要得多。
   */
  async resolveRenameTarget(filePath: string, newName: string): Promise<string> {
    const normalizedPath = this.normalizePath(filePath);
    this.checkBoundary(normalizedPath);
    await this.assertNoSymlinkEscape(normalizedPath);

    const info = await this.fsAdapter.stat(normalizedPath);
    if (!info.isFile()) {
      throw new FileServiceError('IO_ERROR', '只能重命名文件，不能重命名目录', normalizedPath);
    }

    const name = newName.trim();
    assertRenameableName(name, normalizedPath);

    const currentName = path.basename(normalizedPath);
    const targetPath = path.join(path.dirname(normalizedPath), name);
    if (targetPath === normalizedPath) return normalizedPath;

    if (path.extname(name).toLowerCase() !== path.extname(currentName).toLowerCase()) {
      throw new FileServiceError(
        'IO_ERROR',
        `不能改扩展名：${currentName} → ${name}`,
        normalizedPath
      );
    }

    // 同目录下按理同根，但 `path.join` 对奇怪输入的处理不值得信任 —— 判据自己再走一遍
    this.checkBoundary(targetPath);

    // Windows 大小写不敏感：只差大小写时 `stat` 说的「已存在」就是它自己，放行。
    if (targetPath.toLowerCase() !== normalizedPath.toLowerCase()) {
      try {
        await this.fsAdapter.stat(targetPath);
        throw new FileServiceError('IO_ERROR', `目标已存在：${name}`, targetPath);
      } catch (err) {
        if (err instanceof FileServiceError) throw err;
        if (!isNotFoundError(err)) throw wrapIoError('检查目标是否存在失败', targetPath, err);
      }
    }

    return targetPath;
  }

  /**
   * 重命名一个文件：**同目录、只改基名、不改扩展名**。返回新的绝对路径。
   *
   * ## 为什么只收「新名字」而不是「新路径」
   *
   * 调用方（树内联改名）手里只有用户敲进去的那一个名字，没有目录的概念。让它去拼路径
   * 就等于把「目录从哪来」这条规则复制到渲染进程，而**目录必须由这里定** ——
   * 一旦将来允许移动到别的目录，改的是这一个地方。
   *
   * ## 三条边界，与 `deleteFile` 同源
   *
   * - `checkBoundary` + `assertNoSymlinkEscape`：源文件必须已授权、且不是逃出工作区的
   *   符号链接。目标也查一次。
   * - **只改文件，不改目录。**
   * - **目标已存在就拒绝，不静默覆盖。** 这是这条通道后果最重的一条：覆盖掉的那篇
   *   文档在磁盘上就没有了，而它可能连历史快照都没有（从没保存过第二次）。
   *
   * ## 为什么固定扩展名
   *
   * `a.md` → `a.txt` 不是改名，是格式转换，而转换要处理「文档类型变了」的一整串连锁
   * （标签页类型、附件分组、索引 `type` 列、提取缓存）。改名这条通道不背那个责任。
   */
  async renameFile(filePath: string, newName: string): Promise<string> {
    const normalizedPath = this.normalizePath(filePath);
    const targetPath = await this.resolveRenameTarget(normalizedPath, newName);
    if (targetPath === normalizedPath) return normalizedPath;

    try {
      await this.fsAdapter.rename(normalizedPath, targetPath);
    } catch (err) {
      throw wrapIoError('重命名失败', normalizedPath, err);
    }

    return targetPath;
  }

  /**
   * 另存为文件：通过对话框选择新路径，原子写入并将其纳入 allowed file boundary。
   *
   * `defaultPath` 是对话框**打开时停在哪**（`files.newDocumentLocation` 的落地处）。
   * 只影响起点，不限制选择范围 —— 保存对话框本来就可以去任何地方，这里没有加边界的理由：
   * 用户显式选中的路径随后由 `allowedPaths` 纳入，与改版前一致。
   */
  async saveAs(content: string, defaultPath?: string | null): Promise<string> {
    if (!this.dialog) {
      throw new FileServiceError('IO_ERROR', '未注入 FileDialog，无法打开保存对话框');
    }

    const chosen = await this.dialog.saveFile(
      defaultPath ? { defaultPath } : undefined
    );
    if (!chosen) {
      throw new FileServiceError('CANCELLED', '用户取消了另存为');
    }

    this.assertTextDocument(chosen);
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
   * 把粘贴进来的附件写到文档目录（或其子目录）下，返回**实际落盘的绝对路径**。
   *
   * 名字与扩展名由调用方算好（见 `@nexus/core` 的 `document/attachments.ts`），
   * 这里只负责三件**只有主进程能做**的事：边界校验、建目录、重名去重。
   * 把命名规则搬进来会让「用户改模板」变成一次 IPC 参数，而那本该是渲染进程的偏好。
   *
   * ## 边界用的是 `assetRoots`，不是 `allowedRoots`
   *
   * 这是刻意的：附件必须落在**资源通道读得到**的地方。写到别处的结果是「文件确实存在，
   * 但编辑器里那张图永远是空白」—— 而那种失败用户查不出来。让写入集合与读取集合重合，
   * 这条不变式就由类型之外的这一行保住。
   *
   * 代价是轻量模式下可写范围从「那一个 `.md`」放宽到「它所在的那一层目录」。
   * 放宽的量由 API 形状兜住：这里只会写出 `<文档目录>[/<子目录>]/<算好的名字>.<扩展名>`，
   * 没有任何一条路径能让调用方指定任意文件名。
   */
  async saveAttachment(request: SaveAttachmentRequest): Promise<string> {
    const normalizedDocument = this.normalizePath(request.documentPath);
    this.checkBoundary(normalizedDocument);

    if (request.data.length === 0) {
      throw new FileServiceError('IO_ERROR', '附件内容为空', normalizedDocument);
    }

    const baseDirectory = path.dirname(normalizedDocument);
    const targetDirectory = request.directory
      ? path.resolve(baseDirectory, request.directory)
      : baseDirectory;
    // 第二道。`directory` 已经由渲染进程归一化过（`normalizeAttachmentDirectory` 丢掉了
    // `..` 与盘符），但边界校验不能建立在「调用方已经净化过」之上 —— 这条通道写的是磁盘。
    this.checkAssetBoundary(targetDirectory);

    await this.fsAdapter.mkdir(targetDirectory, { recursive: true });

    const targetPath = await this.uniqueAttachmentPath(
      targetDirectory,
      request.fileName,
      request.extension
    );

    await atomicWriteFile(targetPath, request.data, {
      fsAdapter: this.fsAdapter,
      forceBackupSwap: this.forceBackupSwap
    });

    return targetPath;
  }

  /**
   * 重名时在扩展名前加 `-1`、`-2`…。
   *
   * 必须在这里做而不是在渲染进程：只有这里看得见文件系统。而重名**真的会发生** ——
   * 默认模板的 `{timestamp}` 只到秒，同一秒内粘两张（截图工具连拍、批量拖拽）就撞上了；
   * 用户把模板改成 `{date}` 之后，一天之内必然撞。
   */
  private async uniqueAttachmentPath(
    directory: string,
    fileName: string,
    extension: string
  ): Promise<string> {
    for (let index = 0; index < MAX_ATTACHMENT_COLLISION_ATTEMPTS; index += 1) {
      const suffix = index === 0 ? '' : `-${index}`;
      const candidate = path.join(directory, `${fileName}${suffix}${extension}`);
      if (!(await this.attachmentExists(candidate))) return candidate;
    }

    throw new FileServiceError(
      'IO_ERROR',
      `附件重名次数过多: ${fileName}${extension}`,
      directory
    );
  }

  private async attachmentExists(filePath: string): Promise<boolean> {
    try {
      await this.fsAdapter.stat(filePath);
      return true;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw wrapIoError('检查附件是否重名失败', filePath, err);
    }
  }

  /**
   * 监听文件变更。过滤无关事件并提供去抖，unsubscribe 保证幂等且释放底座资源。
   */
  watchFile(filePath: string, listener: FileWatchListener): Unsubscribe {
    const normalizedPath = this.normalizePath(filePath);
    this.checkBoundary(normalizedPath);
    this.assertTextDocument(normalizedPath);

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

  /**
   * **文本文档**判据 = 仅 Markdown。
   *
   * `openFile` / `readFile` / `writeFile` / `saveAs` / `watchFile` 走这条 ——
   * 它们全都要么返回、要么接收 **UTF-8 字符串**。附件是二进制，让它走到这里
   * 只会把字节当文本解码/写坏（且写坏是静默的），所以宁可在门口拒掉。
   */
  private assertTextDocument(filePath: string): void {
    if (isMarkdownPath(filePath)) return;
    const ext = getPathExtension(filePath);
    throw new FileServiceError(
      'UNSUPPORTED_TYPE',
      `只能读写 Markdown 文本文档（.md / .markdown），收到 "${ext || '(无扩展名)'}"`,
      filePath
    );
  }

  /**
   * **可读文档**判据 = 白名单全体（Markdown / PDF / DOCX / 图片）。**返回判出来的类型。**
   *
   * `readDocumentBytes` 与 `describeWorkspaceFile` 走这条。它比 `assertTextDocument` 宽，
   * 是因为它不做解码；宽出来的部分**不代表可以写**。
   *
   * 返回类型而不是 `void`：两处调用点都要那个类型，各自再 `documentTypeForPath` 一次
   * 等于同一个判断跑两遍 —— 而两遍之间是可以漂的（第一遍白名单里加了一种、第二遍忘了）。
   *
   * 注意这条**不替代**边界校验：调用方仍须先过 `checkBoundary` 与
   * `assertNoSymlinkEscape`。「只是读一张图片」不是绕过边界的理由。
   */
  private assertReadableDocument(filePath: string): DocumentType {
    const type = documentTypeForPath(filePath);
    if (type !== null) return type;

    const ext = getPathExtension(filePath);
    throw new FileServiceError(
      'UNSUPPORTED_TYPE',
      `不支持的文件类型 "${ext || '(无扩展名)'}"，可读类型：${supportedDocumentExtensions().join(' ')}`,
      filePath
    );
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

  /**
   * `nexus-asset://` 的边界判据：读写边界 **或** 资源根，任一命中即放行。
   *
   * 刻意**不**把这个分支并进 `checkBoundary`：那样 `readFile` / `writeFile` 也会
   * 接受资源根，等于把「轻量模式下只能编辑你打开的那一个文件」悄悄放宽成
   * 「可以编辑同目录下的任何文件」。两条判据服务两种权限，合并会同时丢掉两者。
   *
   * 顺序上先查读写边界：工作区模式下 `allowedRoots` 已经覆盖资源根，
   * 让常见路径走第一条、少一次集合遍历。
   */
  private checkAssetBoundary(normalizedPath: string): void {
    if (this.isAuthorized(normalizedPath)) return;
    if (this.isInsideAnyRoot(this.assetRoots, normalizedPath)) return;
    throw new FileServiceError(
      'OUT_OF_BOUNDS',
      `资源路径超出允许边界: ${normalizedPath}`,
      normalizedPath
    );
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
   * 打开一个工作区：给了路径就用它，没给就弹目录选择框。返回规范化后的绝对路径。
   *
   * 与 `openFile` 同形（`filePath` 缺省时弹框），差别在**后果**：这一条会把整个目录
   * 授权成可读写，而 `openFile` 只放行一个文件。所以「选目录」和「授权」合成一步 ——
   * 对话框返回的路径在授权之前不是可用的工作区，调用方拿到它之后唯一该做的事就是授权，
   * 拆开只会多出「忘了授权」这一种错误状态，而它的症状（文件树全空、读写全
   * `OUT_OF_BOUNDS`）离原因很远。
   *
   * 取消**返回 `null`**，不抛 `CANCELLED`：`openFile` / `saveAs` 抛错是因为它们承诺
   * 返回一个可用路径，这条没有这个承诺 —— 「用户改主意了」在这里是正常结局，
   * 调用方除了什么都不做没有别的反应。
   */
  async openWorkspace(rootPath?: string | null): Promise<string | null> {
    let target = rootPath;
    if (!target) {
      if (!this.dialog) {
        throw new FileServiceError('IO_ERROR', '未注入 FileDialog，无法打开目录选择对话框');
      }
      target = await this.dialog.openDirectory();
      if (!target) return null;
    }

    return await this.authorizeWorkspace(target);
  }

  /**
   * 授权一个**资源读取**根目录：该目录下的白名单文件可经 `nexus-asset://` 读取。
   *
   * 与 `authorizeWorkspace` 的唯一区别是**登记到 `assetRoots` 而不是 `allowedRoots`**，
   * 所以它不会让 `readFile` / `writeFile` 放行 —— 这条边界只服务资源通道。
   *
   * realpath 同样登记（并进 `realRoots`），于是 `assertNoSymlinkEscape` 在
   * **轻量模式下也生效**：文档目录里的链接指向目录外时会被拒。
   * 这是相对 P3-06 的净加固 —— 那条路（`file://`）连边界都没有。
   *
   * 构造函数里已经同步登记了字符串路径，所以本方法是**加固而非必需**：
   * 它失败不会让资源请求变成 403，只会少一层符号链接防护。
   */
  async authorizeAssetRoot(rootPath: string): Promise<string> {
    const normalized = this.normalizePath(rootPath);
    this.assetRoots.add(this.toPathKey(normalized));

    if (this.fsAdapter.realpath) {
      try {
        const real = await this.fsAdapter.realpath(normalized);
        this.assetRoots.add(this.toPathKey(real));
        this.realRoots.add(this.toPathKey(real));
      } catch {
        // realpath 失败不阻塞授权：字符串边界已经生效
      }
    }

    return normalized;
  }

  /**
   * 递归扫描工作区下的**全部文档文件** —— Markdown 与附件（Phase 3 / P3-04）。
   *
   * 与 `scanWorkspaceMarkdownFiles` 走同一套遍历与跳过规则，区别只在「收哪些文件」。
   * **不要为附件另写一套跳过规则** —— P2 踩过一次「逐个列举要跳过的目录，结果漏了
   * 别的笔记工具留下的元数据目录」，那次的修法就是统一成前缀判定。
   */
  async scanWorkspaceFiles(
    rootPath: string,
    options: ScanWorkspaceOptions = {}
  ): Promise<WorkspaceScanResult<WorkspaceDocumentFile>> {
    return this.walkWorkspace(rootPath, options, (name) => documentTypeForPath(name));
  }

  /**
   * 递归扫描工作区下的 Markdown 文件（P2 的契约，行为与返回形状保持不变）。
   *
   * 索引是派生数据、扫盘是唯一的重建途径，所以这里不做增量，每次全量跑。
   * 不跟随符号链接（避免目录环路与越界），跳过点开头目录与 node_modules/dist 等。
   * 结果顺序不保证稳定，调用方自行排序。
   */
  async scanWorkspaceMarkdownFiles(
    rootPath: string,
    options: ScanWorkspaceOptions = {}
  ): Promise<WorkspaceScanResult<WorkspaceMarkdownFile>> {
    const scanned = await this.walkWorkspace(rootPath, options, (name) =>
      isMarkdownPath(name) ? 'markdown' : null
    );

    // 剥掉 `type`：这是 P2 的接口，运行时形状也要保持一致 —— 否则既有断言里
    // 任何「整个对象比较」都会因为多出一个字段而失败，而失败信息看起来像
    // 「实现多返回了东西」，排查方向会跑偏。
    return {
      files: scanned.files.map((file) => ({
        path: file.path,
        relativePath: file.relativePath,
        name: file.name,
        modifiedAtMs: file.modifiedAtMs,
        sizeBytes: file.sizeBytes
      })),
      truncated: scanned.truncated,
      skippedDirectories: scanned.skippedDirectories
    };
  }

  /**
   * 列出工作区里所有目录（绝对路径 + 相对路径 + 名字，**不含根自身**）。
   *
   * ## 为什么文件树需要一条单独的通道
   *
   * 索引里只有文件，目录是从 `relativePath` 反推的 —— 一个还没放东西的 `assets/`
   * 在索引里根本不存在。于是「新建文件夹」点了界面上什么都不会发生，用户以为没成功。
   *
   * ## 跳过规则必须与索引同源
   *
   * 同一个 `shouldIgnoreDirectory` + 同一份 `ignoreRules`。各写一份的话，
   * 症状是「索引跳过了 `.git`、树里却看得见」，而两边谁对说不清。
   *
   * 只收目录：`resolveType` 恒返回 `null`，所以**一个文件都不会被 stat** ——
   * 这是一次纯目录遍历，比 `scanWorkspaceFiles` 便宜。
   *
   * 父目录一定排在子目录之前（先 push 再递归），但**同级之间的顺序不保证** ——
   * `readdir` 给什么顺序就是什么顺序，要稳定就自己排。
   */
  async listWorkspaceDirectories(
    rootPath: string,
    options: ScanWorkspaceOptions = {}
  ): Promise<WorkspaceDirectoryEntry[]> {
    const directories: WorkspaceDirectoryEntry[] = [];
    await this.walkWorkspace(rootPath, options, () => null, directories);
    return directories;
  }

  /**
   * 在工作区里**排他**新建一个空的 Markdown 文件，返回它的绝对路径。
   *
   * ## 排他（`wx`）是这条通道的全部要点
   *
   * 不能复用 `writeFile`：那条走 `atomicWriteFile`，语义是「写到这个路径」——
   * 目标已存在时它会**覆盖**。而调用方（树上那行内联输入框）拿到的名字是用户随手
   * 敲的，撞上已有文件是常态。覆盖掉别人一个月的笔记，是这条通道唯一不可逆的失败
   * 方式，所以宁可让 `open(..., 'wx')` 抛 `EEXIST`。
   *
   * 注意这里**不用** `atomicWriteFile`：它的实现是「目标 → 备份 → 临时 → 目标」，
   * 那是为「替换已有内容」设计的，用在新建上正好把要防的事做了。
   *
   * ## 名字归一化放在这里，不放在渲染进程
   *
   * 「没写扩展名就补 `.md`」这条规则只该有一份。渲染进程把用户敲的字符串原样送过来，
   * 最终叫什么由这里定 —— 否则「界面上显示的名字」与「磁盘上的名字」会成为两处判断。
   *
   * ## 为什么没有专门的错误码
   *
   * 「已存在」与别的 IO 失败只靠 message 区分。跨 IPC 之后 `FileServiceError.code`
   * 根本传不过去（Electron 只序列化 message），加一个枚举值不会让渲染进程多知道
   * 任何东西。渲染进程那条路是**本地预检**（拿树里的列表比名字），这里只是兜底。
   */
  async createFile(directoryPath: string, fileName: string): Promise<string> {
    const target = await this.resolveNewEntryPath(directoryPath, fileName, 'file');

    try {
      const handle = await this.fsAdapter.open(target, 'wx', 0o600);
      await handle.close();
    } catch (err) {
      throw this.describeCreateFailure(err, target, fileName);
    }

    return target;
  }

  /**
   * 在工作区里新建一个目录（**非递归**），返回它的绝对路径。
   *
   * 不开 `recursive` 是刻意的，理由不是「省一次 mkdir」：`recursive: true` 会把
   * **已存在的目录当成成功**（不报错），于是「新建文件夹」撞名时会静默成功 ——
   * 界面上看不出任何区别，用户只会以为自己点漏了。非递归那一档才会抛 `EEXIST`，
   * 与 `createFile` 同形。
   *
   * 顺带：名字里不能有路径分隔符（`assertRenameableName` 拦），所以「父目录不存在」
   * 这条分支走不到 —— 落点目录本身已经 `stat` 过了。
   */
  async createDirectory(directoryPath: string, name: string): Promise<string> {
    const target = await this.resolveNewEntryPath(directoryPath, name, 'directory');

    try {
      await this.fsAdapter.mkdir(target);
    } catch (err) {
      throw this.describeCreateFailure(err, target, name);
    }

    return target;
  }

  /**
   * 算出「在这个目录下新建一个叫这个名字的东西」的绝对路径，并做完所有校验。
   *
   * 与 `resolveRenameTarget` 是同一条判据的镜像：**路径怎么拼、哪些名字不能要，
   * 只有这一份**。区别在 `resolveRenameTarget` 要跟旧名字比扩展名，这里要归一化
   * 扩展名 —— 因为新建时没有「旧名字」可比。
   */
  private async resolveNewEntryPath(
    directoryPath: string,
    rawName: string,
    kind: 'file' | 'directory'
  ): Promise<string> {
    const normalizedDir = this.normalizePath(directoryPath);
    this.checkBoundary(normalizedDir);
    await this.assertNoSymlinkEscape(normalizedDir);

    const info = await this.fsAdapter.stat(normalizedDir);
    if (!info.isDirectory()) {
      throw new FileServiceError('IO_ERROR', '落点不是一个目录', normalizedDir);
    }

    const name = rawName.trim();
    assertRenameableName(name, normalizedDir);

    const finalName = kind === 'file' ? normalizeNewFileName(name, normalizedDir) : name;
    const target = path.join(normalizedDir, finalName);

    // 名字里不能有分隔符（`assertRenameableName` 已经拦了），所以 join 之后必定
    // 还在同一个目录里 —— 但 `path.join` 对奇怪输入的处理不值得信任，判据自己再走一遍。
    this.checkBoundary(target);

    return target;
  }

  /** 把 `open('wx')` / `mkdir` 的失败翻成人能读的错。 */
  private describeCreateFailure(err: unknown, target: string, name: string): FileServiceError {
    if (err instanceof FileServiceError) return err;
    if (getErrorCode(err) === 'EEXIST') {
      return new FileServiceError('IO_ERROR', `已存在同名项：${name}`, target);
    }
    if (isNotFoundError(err)) {
      return new FileServiceError('IO_ERROR', '落点目录不存在', target);
    }
    return wrapIoError('新建失败', target, err);
  }

  /**
   * 读一个工作区文件的「文件系统事实」—— 与 `walkWorkspace` 收进 `files` 的那几个字段同形。
   *
   * 给「单个文件进索引」用：那条路没有扫描结果可以依附，而索引要的字段（类型、大小、
   * 修改时间）只能从盘上现读。类型判据走与扫描**同一张白名单**（`assertReadableDocument`），
   * 各写一份的话会出现「扫描收进来了、单文件路拒掉」这种两边对不上的状态。
   *
   * `relativePath` 按 `/` 分隔：它与索引里存的那个字符串是同一个口径，不能各写一遍。
   */
  async describeWorkspaceFile(
    rootPath: string,
    filePath: string
  ): Promise<WorkspaceDocumentFile> {
    const normalizedRoot = this.normalizePath(rootPath);
    const normalizedPath = this.normalizePath(filePath);
    this.checkBoundary(normalizedRoot);
    this.checkBoundary(normalizedPath);
    await this.assertNoSymlinkEscape(normalizedPath);

    // 两个都过了边界不等于「它在这一个根之下」：一个会话可以授权多个工作区根，
    // 拿 B 根去描述 A 根里的文件，`path.relative` 会算出一串 `../..`，
    // 而那串东西会被原样写进索引的 `relativePath` —— 一个指向不存在的路径。
    if (!isPathInside(normalizedRoot, normalizedPath)) {
      throw new FileServiceError('OUT_OF_BOUNDS', '文件不在给定的工作区根之下', normalizedPath);
    }

    const type = this.assertReadableDocument(normalizedPath);

    let sizeBytes = 0;
    let modifiedAtMs = 0;
    try {
      const stats = await this.fsAdapter.stat(normalizedPath);
      sizeBytes = stats.size ?? 0;
      modifiedAtMs = stats.mtimeMs ?? 0;
    } catch (err) {
      throw wrapIoError('读取文件信息失败', normalizedPath, err);
    }

    return {
      path: normalizedPath,
      relativePath: path.relative(normalizedRoot, normalizedPath).split(path.sep).join('/'),
      name: path.basename(normalizedPath),
      type,
      sizeBytes,
      modifiedAtMs
    };
  }

  /**
   * 遍历实现。`resolveType` 返回 `null` 表示「不收这个文件」——
   * 三个公开扫描方法只是它的三种收法。
   *
   * `directories` 传进来就**顺带**收集目录（绝对路径 + 相对路径 + 名字）。做成可选的
   * 出参而不是返回值上的一个字段：`WorkspaceScanResult` 是 P2 就冻结的跨进程契约，
   * 加字段会让「整个对象比较」那类既有断言因为多出一个键而失败，而失败信息看起来
   * 像「实现多返回了东西」。
   */
  private async walkWorkspace(
    rootPath: string,
    options: ScanWorkspaceOptions,
    resolveType: (fileName: string) => DocumentType | null,
    directories?: WorkspaceDirectoryEntry[]
  ): Promise<WorkspaceScanResult<WorkspaceDocumentFile>> {
    const normalizedRoot = this.normalizePath(rootPath);
    this.checkBoundary(normalizedRoot);

    const readdir = this.fsAdapter.readdir;
    if (!readdir) {
      throw new FileServiceError('IO_ERROR', '文件系统适配层未实现 readdir，无法扫描工作区');
    }

    const maxFiles = options.maxFiles ?? 20000;
    const maxDepth = options.maxDepth ?? 24;
    const ignoreRules = options.ignoreRules ?? [];

    const files: WorkspaceDocumentFile[] = [];
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
          // 相对路径要传进去：规则里带 `/` 时按路径比（`notes/private` 只命中那一条），
          // 不带 `/` 时按目录名比（`drafts` 命中任意层级）。只给名字的话前者没法表达。
          const relativeDir = path.relative(normalizedRoot, childPath).split(path.sep).join('/');
          if (shouldIgnoreDirectory(entry.name, relativeDir, ignoreRules)) {
            skippedDirectories += 1;
            continue;
          }
          // 收集点在**跳过判据之后**：被忽略的目录既不该进索引，也不该出现在文件树上，
          // 否则会出现「索引跳过了 .git、树里却看得见」这种两边对不上的状态。
          directories?.push({ path: childPath, relativePath: relativeDir, name: entry.name });
          await walk(childPath, depth + 1);
          continue;
        }

        if (!entry.isFile()) continue;

        // 判据来自 core 的同一张白名单，不再有第二处硬编码。
        const type = resolveType(entry.name);
        if (type === null) continue;

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
          type,
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
