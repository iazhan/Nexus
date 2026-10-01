import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileServiceError, type FileWatchEvent } from '@nexus/core';
import {
  FileService,
  atomicWriteFile,
  DefaultFileSystemAdapter,
  type FileSystemAdapter,
  type FSWatcherLike
} from '../electron/file-service.js';
import type { FileDialog } from '../electron/file-dialog.js';

/**
 * 轮询等待条件成立。
 *
 * 这些用例走 mock watcher + debounce（10ms），但断言前原来只固定 sleep 30ms ——
 * 机器负载高时 debounce 回调还没跑完就断言，出现
 * "expected [] to have a length of 1" 这类偶发失败（本会话复现两次）。
 * 正向断言改成轮询；负向断言保留固定等待（只会假通过、不会假失败），但留足余量。
 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`waitFor: 条件在 ${timeoutMs}ms 内未成立`);
}

class MockFSWatcher implements FSWatcherLike {
  private listeners: Map<string, Array<(...args: unknown[]) => void>> = new Map();
  public isClosed = false;

  close(): void {
    this.isClosed = true;
  }

  on(event: 'change', listener: (eventType: string, filename: string | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    if (this.isClosed) return;
    const handlers = this.listeners.get(event) ?? [];
    for (const handler of handlers) {
      handler(...args);
    }
  }
}

async function expectFileServiceError(
  promise: Promise<unknown>,
  expectedCode: string
): Promise<FileServiceError> {
  try {
    await promise;
    expect.unreachable(`预期抛出 FileServiceError [${expectedCode}]，但操作成功执行`);
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(FileServiceError);
    const serviceError = err as FileServiceError;
    expect(serviceError.code).toBe(expectedCode);
    return serviceError;
  }
}

function createMockFsAdapter(
  overrides: Partial<FileSystemAdapter> = {},
  baseFs: FileSystemAdapter = new DefaultFileSystemAdapter()
): FileSystemAdapter {
  return {
    readFile: (p, enc) => (overrides.readFile ? overrides.readFile(p, enc) : baseFs.readFile(p, enc)),
    readFileBuffer: (p) =>
      overrides.readFileBuffer ? overrides.readFileBuffer(p) : baseFs.readFileBuffer(p),
    readRange: (p, start, length) =>
      overrides.readRange ? overrides.readRange(p, start, length) : baseFs.readRange(p, start, length),
    open: (p, flags, mode) => (overrides.open ? overrides.open(p, flags, mode) : baseFs.open(p, flags, mode)),
    rename: (oldPath, newPath) =>
      overrides.rename ? overrides.rename(oldPath, newPath) : baseFs.rename(oldPath, newPath),
    unlink: (p) => (overrides.unlink ? overrides.unlink(p) : baseFs.unlink(p)),
    stat: (p) => (overrides.stat ? overrides.stat(p) : baseFs.stat(p)),
    exists: (p) => {
      if (overrides.exists) return overrides.exists(p);
      if (baseFs.exists) return baseFs.exists(p);
      return fsPromises.access(p).then(() => true, () => false);
    },
    // `realpath` 是**可选**成员，但适配层的默认实现有它。
    // 这里必须显式透传：漏掉的话 mock 出来的适配层就没有 `realpath`，
    // 而 `assertNoSymlinkEscape` 会因此整条短路（`if (!this.fsAdapter.realpath) return`）——
    // 于是「符号链接逃逸」的用例会**静默地永远通过**。
    realpath: overrides.realpath ?? baseFs.realpath,
    watch: (p, opts, l) => (overrides.watch ? overrides.watch(p, opts, l) : baseFs.watch(p, opts, l))
  };
}

describe('FileService & atomicWriteFile', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-file-service-test-'));
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  describe('normalize & path boundary & 拒绝未授权文件', () => {
    it('未经授权的路径访问应当被拒绝并抛出 OUT_OF_BOUNDS 错误', async () => {
      const service = new FileService();
      const unauthorizedPath = path.join(tempDir, 'unauthorized.md');
      await fsPromises.writeFile(unauthorizedPath, '# Unauthorized', 'utf-8');

      // 拒绝未授权 readFile
      await expectFileServiceError(service.readFile(unauthorizedPath), 'OUT_OF_BOUNDS');

      // 拒绝未授权 writeFile
      await expectFileServiceError(
        service.writeFile(unauthorizedPath, '# New Content'),
        'OUT_OF_BOUNDS'
      );

      // 拒绝未授权 watchFile
      expect(() => {
        service.watchFile(unauthorizedPath, () => {});
      }).toThrow(FileServiceError);

      try {
        service.watchFile(unauthorizedPath, () => {});
      } catch (err) {
        expect(err).toBeInstanceOf(FileServiceError);
        expect((err as FileServiceError).code).toBe('OUT_OF_BOUNDS');
      }
    });

    it('初始化时注入 allowedPaths 应正常授权，且相对路径与目录穿透会被规范化解析', async () => {
      const targetFile = path.join(tempDir, 'allowed-doc.md');
      await fsPromises.writeFile(targetFile, '# Allowed Document', 'utf-8');

      const service = new FileService({ allowedPaths: [targetFile] });

      // 使用绝对路径读取成功
      const content = await service.readFile(targetFile);
      expect(content).toBe('# Allowed Document');

      // 相对路径和 .. 路径会被规范化为系统绝对路径并在 boundary 内命中
      const subDir = path.join(tempDir, 'sub');
      await fsPromises.mkdir(subDir, { recursive: true });
      const relativeTraversedPath = path.join(subDir, '..', 'allowed-doc.md');
      const traversedContent = await service.readFile(relativeTraversedPath);
      expect(traversedContent).toBe('# Allowed Document');

      // Windows 环境下忽略大小写路径键匹配
      if (process.platform === 'win32') {
        const upperPath = targetFile.toUpperCase();
        const upperContent = await service.readFile(upperPath);
        expect(upperContent).toBe('# Allowed Document');
      }
    });

    it('空路径或非 Markdown 扩展名应被拒绝', async () => {
      const service = new FileService();

      // 无效路径
      await expectFileServiceError(service.readFile(''), 'OUT_OF_BOUNDS');

      // 不支持的扩展名：.txt / .pdf / 无扩展名
      const txtFile = path.join(tempDir, 'document.txt');
      await fsPromises.writeFile(txtFile, 'hello', 'utf-8');

      const allowedService = new FileService({ allowedPaths: [txtFile] });
      await expectFileServiceError(allowedService.readFile(txtFile), 'UNSUPPORTED_TYPE');
      await expectFileServiceError(allowedService.writeFile(txtFile, 'update'), 'UNSUPPORTED_TYPE');
    });

    it('openFile 成功后应建立精确的 allowed file boundary', async () => {
      const targetFile = path.join(tempDir, 'dynamic-open.md');
      await fsPromises.writeFile(targetFile, '# Dynamic Boundary', 'utf-8');

      const service = new FileService();
      expect(service.getAllowedPaths()).toHaveLength(0);

      // openFile 之前拒绝读取
      await expectFileServiceError(service.readFile(targetFile), 'OUT_OF_BOUNDS');

      // 执行 openFile
      const doc = await service.openFile(targetFile);
      expect(doc.path).toBe(path.resolve(targetFile));
      expect(doc.content).toBe('# Dynamic Boundary');

      // openFile 之后已建立 boundary，直接 readFile / writeFile 均可访问
      expect(service.getAllowedPaths()).toContain(
        process.platform === 'win32'
          ? path.resolve(targetFile).toLowerCase()
          : path.resolve(targetFile)
      );
      const readContent = await service.readFile(targetFile);
      expect(readContent).toBe('# Dynamic Boundary');

      await service.writeFile(targetFile, '# Updated Boundary');
      expect(await service.readFile(targetFile)).toBe('# Updated Boundary');
    });
  });

  describe('中文、空格、Unicode 文件名与 UTF-8 / CRLF 原文读写', () => {
    it('应完美支持包含中文、空格、特殊符号与 Emoji 的文件名', async () => {
      const specialFileName = '工作 报告 2026 🚀 计划与总结 (Draft).markdown';
      const filePath = path.join(tempDir, specialFileName);
      const initialContent = '# 中文标题\n内容包含特殊字符：αβγ &  emoji 🎉';

      await fsPromises.writeFile(filePath, initialContent, 'utf-8');

      const service = new FileService();
      const opened = await service.openFile(filePath);

      expect(opened.path).toBe(path.resolve(filePath));
      expect(opened.content).toBe(initialContent);

      // 验证保存包含 Unicode 字符的内容
      const updatedContent = '# 新版工作报告\n更新了项目状态 ✨\n支持 UTF-8 编码！';
      await service.writeFile(filePath, updatedContent);

      const readBack = await service.readFile(filePath);
      expect(readBack).toBe(updatedContent);

      const diskRaw = await fsPromises.readFile(filePath, 'utf-8');
      expect(diskRaw).toBe(updatedContent);
    });

    it('应严格保持 CRLF (\\r\\n) 行尾换行符，不得被篡改为 LF', async () => {
      const crlfFileName = 'windows-style.md';
      const filePath = path.join(tempDir, crlfFileName);
      const crlfContent = '# Title\r\n\r\nFirst Line\r\nSecond Line\r\nThird Line with Unicode 中文\r\n';

      await fsPromises.writeFile(filePath, crlfContent, 'utf-8');

      const service = new FileService();
      const doc = await service.openFile(filePath);

      expect(doc.content).toBe(crlfContent);
      expect(doc.content.includes('\r\n')).toBe(true);

      // 写入包含 CRLF 的新内容
      const updatedCrlfContent = '# New Title\r\nLine A\r\nLine B\r\n';
      await service.writeFile(filePath, updatedCrlfContent);

      const readBack = await service.readFile(filePath);
      expect(readBack).toBe(updatedCrlfContent);

      const diskBytes = await fsPromises.readFile(filePath);
      expect(diskBytes.toString('utf-8')).toBe(updatedCrlfContent);
      expect(diskBytes.includes(Buffer.from('\r\n'))).toBe(true);
    });
  });

  describe('openFile / saveAs dialog cancellation 断言 CANCELLED 错误码', () => {
    it('用户取消 openFile 对话框时应当抛出 CANCELLED 错误码', async () => {
      const mockDialog: FileDialog = {
        openFile: vi.fn().mockResolvedValue(null),
        saveFile: vi.fn().mockResolvedValue(null)
      };
      const service = new FileService({ dialog: mockDialog });

      const err = await expectFileServiceError(service.openFile(), 'CANCELLED');
      expect(err.message).toContain('用户取消了打开文件');
      expect(mockDialog.openFile).toHaveBeenCalledOnce();
    });

    it('用户取消 saveAs 对话框时应当抛出 CANCELLED 错误码', async () => {
      const mockDialog: FileDialog = {
        openFile: vi.fn().mockResolvedValue(null),
        saveFile: vi.fn().mockResolvedValue(null)
      };
      const service = new FileService({ dialog: mockDialog });

      const err = await expectFileServiceError(service.saveAs('# Draft'), 'CANCELLED');
      expect(err.message).toContain('用户取消了另存为');
      expect(mockDialog.saveFile).toHaveBeenCalledOnce();
    });

    it('未注入 FileDialog 时调用无参数 openFile 或 saveAs 应抛出 IO_ERROR', async () => {
      const service = new FileService();

      await expectFileServiceError(service.openFile(), 'IO_ERROR');
      await expectFileServiceError(service.saveAs('# Test'), 'IO_ERROR');
    });
  });

  describe('saveAs 成功返回规范化路径并建立边界', () => {
    it('另存为成功后返回规范化绝对路径，自动纳入 allowed boundary 并可后续正常读写', async () => {
      const saveTarget = path.join(tempDir, '新另存文件 2026.md');
      const mockDialog: FileDialog = {
        openFile: vi.fn().mockResolvedValue(null),
        saveFile: vi.fn().mockResolvedValue(saveTarget)
      };
      const service = new FileService({ dialog: mockDialog });

      const content = '# Saved Content\n另存为内容';
      const returnedPath = await service.saveAs(content);

      // 验证返回规范化路径
      expect(returnedPath).toBe(path.resolve(saveTarget));

      // 验证磁盘文件已写入
      const diskContent = await fsPromises.readFile(returnedPath, 'utf-8');
      expect(diskContent).toBe(content);

      // 验证已建立 boundary，无需再次授权即可读取与写入
      const readBack = await service.readFile(returnedPath);
      expect(readBack).toBe(content);

      await service.writeFile(returnedPath, '# Subsequent Edit');
      expect(await service.readFile(returnedPath)).toBe('# Subsequent Edit');
    });

    it('另存为如果选择了不支持的扩展名应拒绝并抛出 UNSUPPORTED_TYPE', async () => {
      const invalidTarget = path.join(tempDir, 'note.txt');
      const mockDialog: FileDialog = {
        openFile: vi.fn().mockResolvedValue(null),
        saveFile: vi.fn().mockResolvedValue(invalidTarget)
      };
      const service = new FileService({ dialog: mockDialog });

      await expectFileServiceError(service.saveAs('text'), 'UNSUPPORTED_TYPE');
    });
  });

  /**
   * `defaultPath` 是「新建文档默认位置」的落地处：它只决定对话框**停在哪**。
   *
   * 判据取「`saveFile` 收到了什么」而不是「文件写到了哪」—— 对话框在测试里是假的，
   * 写盘路径由 mock 决定，与 defaultPath 无关。真正要钉住的是**参数有没有透传**。
   */
  describe('saveAs 把默认目录透传给对话框', () => {
    it('给了 defaultPath 时应原样传给 saveFile', async () => {
      const saveTarget = path.join(tempDir, 'draft.md');
      const mockDialog: FileDialog = {
        openFile: vi.fn().mockResolvedValue(null),
        saveFile: vi.fn().mockResolvedValue(saveTarget)
      };
      const service = new FileService({ dialog: mockDialog });

      await service.saveAs('# Draft', tempDir);

      expect(mockDialog.saveFile).toHaveBeenCalledWith({ defaultPath: tempDir });
    });

    it('没给 defaultPath 时不传选项对象，保持加设置项之前的行为', async () => {
      const saveTarget = path.join(tempDir, 'draft.md');
      const mockDialog: FileDialog = {
        openFile: vi.fn().mockResolvedValue(null),
        saveFile: vi.fn().mockResolvedValue(saveTarget)
      };
      const service = new FileService({ dialog: mockDialog });

      await service.saveAs('# Draft');
      expect(mockDialog.saveFile).toHaveBeenLastCalledWith(undefined);

      // 空串与 null 都按「没给」处理 —— 它们都不是可用的目录。
      await service.saveAs('# Draft', '');
      expect(mockDialog.saveFile).toHaveBeenLastCalledWith(undefined);

      await service.saveAs('# Draft', null);
      expect(mockDialog.saveFile).toHaveBeenLastCalledWith(undefined);
    });
  });

  describe('atomicWriteFile 正常保存与清理', () => {
    it('直接调用 atomicWriteFile 应成功落盘并清除临时文件', async () => {
      const targetPath = path.join(tempDir, 'atomic-test.md');
      const content = '# Atomic Write Content\r\nLine 2';

      await atomicWriteFile(targetPath, content);

      // 目标文件存在且内容正确
      const saved = await fsPromises.readFile(targetPath, 'utf-8');
      expect(saved).toBe(content);

      // 同级目录下没有残留 .tmp 或 .bak 临时文件
      const files = await fsPromises.readdir(tempDir);
      expect(files).toEqual(['atomic-test.md']);
    });

    it('覆盖已存在的文件时能正确写入新内容并清理所有中间文件', async () => {
      const targetPath = path.join(tempDir, 'existing-note.md');
      await fsPromises.writeFile(targetPath, '# Old Content', 'utf-8');

      const newContent = '# New Content Overwritten';
      await atomicWriteFile(targetPath, newContent);

      const saved = await fsPromises.readFile(targetPath, 'utf-8');
      expect(saved).toBe(newContent);

      const files = await fsPromises.readdir(tempDir);
      expect(files).toEqual(['existing-note.md']);
    });
  });

  describe('forceBackupSwap 模拟交换失败时原文件保留', () => {
    it('当 rename(tmpPath, targetPath) 发生异常时，原文件完整保留，临时文件被清理', async () => {
      const targetPath = path.join(tempDir, 'swap-failure-test.md');
      const originalContent = '# Original Content\r\nMust remain unchanged!';
      await fsPromises.writeFile(targetPath, originalContent, 'utf-8');

      const defaultFs = new DefaultFileSystemAdapter();
      let renameAttempted = false;

      // 模拟文件系统适配器：在将 tmpPath 替换 targetPath 时故意抛出错误
      const failingFsAdapter: FileSystemAdapter = {
        readFile: (p, enc) => defaultFs.readFile(p, enc),
        readFileBuffer: (p) => defaultFs.readFileBuffer(p),
        readRange: (p, start, length) => defaultFs.readRange(p, start, length),
        open: (p, flags, mode) => defaultFs.open(p, flags, mode),
        unlink: (p) => defaultFs.unlink(p),
        stat: (p) => defaultFs.stat(p),
        exists: (p) => (defaultFs.exists ? defaultFs.exists(p) : fsPromises.access(p).then(() => true, () => false)),
        watch: (p, opts, l) => defaultFs.watch(p, opts, l),
        rename: async (oldPath: string, newPath: string) => {
          // 如果是备份文件重命名回 targetPath，放行以测试恢复机制
          if (newPath === targetPath && oldPath.includes('.tmp')) {
            renameAttempted = true;
            throw new Error('Simulated swap error: EBUSY / Permission Denied');
          }
          return defaultFs.rename(oldPath, newPath);
        }
      };

      const failingPromise = atomicWriteFile(targetPath, '# Malicious / Failed Content', {
        fsAdapter: failingFsAdapter,
        forceBackupSwap: true
      });

      const err = await expectFileServiceError(failingPromise, 'IO_ERROR');
      expect(err.message).toContain('原子替换目标文件失败');
      expect(renameAttempted).toBe(true);

      // 核心断言：原文件内容依旧保持不变！
      const currentContent = await fsPromises.readFile(targetPath, 'utf-8');
      expect(currentContent).toBe(originalContent);

      // 检查目录下没有遗留 .tmp 或 .bak 文件
      const remainingFiles = await fsPromises.readdir(tempDir);
      expect(remainingFiles).toEqual(['swap-failure-test.md']);
    });
  });

  describe('watchFile 事件与 unsubscribe 去抖与幂等', () => {
    it('正常触发 change 事件，并可过滤不同文件名的事件', async () => {
      const filePath = path.join(tempDir, 'watched-doc.md');
      await fsPromises.writeFile(filePath, '# Watch Initial', 'utf-8');

      let capturedListener: ((eventType: string, filename: string | null) => void) | null = null;
      const mockWatcher = new MockFSWatcher();

      const mockFsAdapter = createMockFsAdapter({
        watch: (_target, _opts, listener) => {
          capturedListener = listener ?? null;
          return mockWatcher;
        }
      });

      const service = new FileService({
        fsAdapter: mockFsAdapter,
        allowedPaths: [filePath],
        debounceMs: 10
      });

      const receivedEvents: FileWatchEvent[] = [];
      const unsubscribe = service.watchFile(filePath, (event) => {
        receivedEvents.push(event);
      });

      expect(capturedListener).toBeDefined();

      // 1. 触发不相关文件的变更事件，应被过滤
      capturedListener!('change', 'other-doc.md');
      // 负向断言：debounce 窗口 + 余量，等足够久确认"确实没有事件"
      await new Promise((r) => setTimeout(r, 120));
      expect(receivedEvents).toHaveLength(0);

      // 2. 触发目标文件的 change 事件
      capturedListener!('change', path.basename(filePath));
      await waitFor(() => receivedEvents.length === 1);
      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0]).toEqual({
        type: 'changed',
        path: path.resolve(filePath)
      });

      // 3. 底层 watcher 触发 error 事件
      mockWatcher.emit('error', new Error('FS Watcher Fault'));
      expect(receivedEvents).toHaveLength(2);
      expect(receivedEvents[1]?.type).toBe('error');
      if (receivedEvents[1]?.type === 'error') {
        expect(receivedEvents[1].message).toBe('FS Watcher Fault');
      }

      unsubscribe();
    });

    it('目标文件被删除时触发 deleted 事件', async () => {
      const filePath = path.join(tempDir, 'to-be-deleted.md');
      await fsPromises.writeFile(filePath, '# Delete Me', 'utf-8');

      let capturedListener: ((eventType: string, filename: string | null) => void) | null = null;
      const mockWatcher = new MockFSWatcher();

      let fileExistsOnDisk = true;
      const mockFsAdapter = createMockFsAdapter({
        exists: async () => fileExistsOnDisk,
        watch: (_target, _opts, listener) => {
          capturedListener = listener ?? null;
          return mockWatcher;
        }
      });

      const service = new FileService({
        fsAdapter: mockFsAdapter,
        allowedPaths: [filePath],
        debounceMs: 10
      });

      const receivedEvents: FileWatchEvent[] = [];
      const unsubscribe = service.watchFile(filePath, (event) => {
        receivedEvents.push(event);
      });

      // 模拟文件被删除
      fileExistsOnDisk = false;
      capturedListener!('rename', path.basename(filePath));
      await waitFor(() => receivedEvents.length === 1);

      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0]).toEqual({
        type: 'deleted',
        path: path.resolve(filePath)
      });

      unsubscribe();
    });

    it('unsubscribe 后 watcher 被关闭，且后续事件不再回调；多次 unsubscribe 保证幂等', async () => {
      const filePath = path.join(tempDir, 'unsub-test.md');
      await fsPromises.writeFile(filePath, '# Unsub Test', 'utf-8');

      let capturedListener: ((eventType: string, filename: string | null) => void) | null = null;
      const mockWatcher = new MockFSWatcher();

      const mockFsAdapter = createMockFsAdapter({
        watch: (_target, _opts, listener) => {
          capturedListener = listener ?? null;
          return mockWatcher;
        }
      });

      const service = new FileService({
        fsAdapter: mockFsAdapter,
        allowedPaths: [filePath],
        debounceMs: 10
      });

      const receivedEvents: FileWatchEvent[] = [];
      const unsubscribe = service.watchFile(filePath, (event) => {
        receivedEvents.push(event);
      });

      expect(mockWatcher.isClosed).toBe(false);

      // 注销监听
      unsubscribe();
      expect(mockWatcher.isClosed).toBe(true);

      // 重复调用 unsubscribe 是幂等的，不抛错
      expect(() => unsubscribe()).not.toThrow();

      // 注销后触发 change 事件与 error 事件，listener 均不应收到任何通知
      capturedListener!('change', path.basename(filePath));
      mockWatcher.emit('error', new Error('Late error'));
      // 负向断言：debounce 窗口 + 余量，等足够久确认"确实没有事件"
      await new Promise((r) => setTimeout(r, 120));

      expect(receivedEvents).toHaveLength(0);
    });
  });

  /**
   * P3-03：文档类型白名单，以及「可读 ≠ 可写」这条分界。
   *
   * 重点是**负向**：白名单放宽之后，附件不能顺着「能读」滑到「能写」，
   * 也不能顺着「能读字节」滑到「能当文本读」。
   */
  describe('文档类型白名单：可读 ≠ 可写（P3-03）', () => {
    /** PNG 头。前两个字节 0x89 0x50 都不是合法 UTF-8 起始字节，解码必损坏。 */
    const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    it('附件（.pdf / .png）能按字节读，但不能走文本文档的读写通道', async () => {
      const pngPath = path.join(tempDir, 'pixel.png');
      await fsPromises.writeFile(pngPath, PNG_HEADER);

      const service = new FileService({ allowedPaths: [pngPath] });

      // 可读：字节完全一致。用 hex 比对 —— 一旦被 UTF-8 解码再编码，
      // 0x89 会变成 U+FFFD（EF BF BD），长度和内容都会变。
      const bytes = await service.readDocumentBytes(pngPath);
      expect(Buffer.from(bytes).toString('hex')).toBe(PNG_HEADER.toString('hex'));

      // 不可当文本读
      await expectFileServiceError(service.readFile(pngPath), 'UNSUPPORTED_TYPE');
      // 不可写（二进制不会被静默写坏 —— 它在门口就被拒了）
      await expectFileServiceError(service.writeFile(pngPath, 'x'), 'UNSUPPORTED_TYPE');
    });

    it('非白名单类型（.txt）连字节读也不放行', async () => {
      const txtPath = path.join(tempDir, 'notes.txt');
      await fsPromises.writeFile(txtPath, 'hello', 'utf-8');

      const service = new FileService({ allowedPaths: [txtPath] });
      await expectFileServiceError(service.readDocumentBytes(txtPath), 'UNSUPPORTED_TYPE');
    });

    it('无扩展名与 dotfile 都不在白名单里', async () => {
      const noExt = path.join(tempDir, 'LICENSE');
      const dotfile = path.join(tempDir, '.gitignore');
      await fsPromises.writeFile(noExt, 'x', 'utf-8');
      await fsPromises.writeFile(dotfile, 'x', 'utf-8');

      const service = new FileService({ allowedPaths: [noExt, dotfile] });
      await expectFileServiceError(service.readDocumentBytes(noExt), 'UNSUPPORTED_TYPE');
      await expectFileServiceError(service.readDocumentBytes(dotfile), 'UNSUPPORTED_TYPE');
    });

    it('字节读同样受边界约束，未授权路径抛 OUT_OF_BOUNDS 而不是先报类型', async () => {
      const pngPath = path.join(tempDir, 'unauthorized.png');
      await fsPromises.writeFile(pngPath, PNG_HEADER);

      const service = new FileService();
      const err = await expectFileServiceError(service.readDocumentBytes(pngPath), 'OUT_OF_BOUNDS');
      expect(err.path).toBe(path.resolve(pngPath));
    });

    it('文件不存在时抛 NOT_FOUND，而不是 UNSUPPORTED_TYPE 或空数组', async () => {
      const missing = path.join(tempDir, 'missing.png');
      const service = new FileService({ allowedPaths: [missing] });
      await expectFileServiceError(service.readDocumentBytes(missing), 'NOT_FOUND');
    });

    it('Markdown 仍可按字节读（白名单是「全体」，不是「除 Markdown 外」）', async () => {
      const mdPath = path.join(tempDir, 'doc.md');
      await fsPromises.writeFile(mdPath, '# 标题\n', 'utf-8');

      const service = new FileService({ allowedPaths: [mdPath] });
      const bytes = await service.readDocumentBytes(mdPath);
      expect(Buffer.from(bytes).toString('utf-8')).toBe('# 标题\n');
    });
  });

  /**
   * 资源根（P3-07）：轻量模式下被打开文档**所在的那一层目录**。
   *
   * 这组用例存在的理由是一次真实回归：图片从 `file://` 换到 `nexus-asset://` 之后，
   * 相对引用（`![](./assets/a.png)`）会被边界判据拦下 —— 因为轻量模式的
   * `allowedPaths` 只含被打开的那一个 `.md`。P1-04R 的端到端用例当场变红。
   *
   * 关键是**它不是「把边界放宽」而是「把边界改对」**：`file://` 那条路根本没有边界
   * （工作区外的文件也读得到），资源根比它严格得多。
   */
  describe('资源根：只读、只服务 nexus-asset://（P3-07）', () => {
    const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    it('文档同目录（含子目录）的资源可读，且字节无损', async () => {
      const assetsDir = path.join(tempDir, 'assets');
      await fsPromises.mkdir(assetsDir, { recursive: true });
      const pngPath = path.join(assetsDir, 'a.png');
      await fsPromises.writeFile(pngPath, PNG_HEADER);
      const mdPath = path.join(tempDir, 'doc.md');
      await fsPromises.writeFile(mdPath, '# t\n', 'utf-8');

      const service = new FileService({
        allowedPaths: [mdPath],
        assetRoots: [path.dirname(mdPath)]
      });

      expect(await service.statAsset(pngPath)).toBe(PNG_HEADER.byteLength);
      const bytes = await service.readAssetRange(pngPath, 0, PNG_HEADER.byteLength - 1);
      expect(Buffer.from(bytes).toString('hex')).toBe(PNG_HEADER.toString('hex'));
    });

    it('资源根**不**授予读写通道 —— 同目录的另一个 .md 依然不可读、不可写', async () => {
      const opened = path.join(tempDir, 'opened.md');
      const sibling = path.join(tempDir, 'sibling.md');
      await fsPromises.writeFile(opened, '# a\n', 'utf-8');
      await fsPromises.writeFile(sibling, '# b\n', 'utf-8');

      const service = new FileService({
        allowedPaths: [opened],
        assetRoots: [tempDir]
      });

      // 资源通道能拿到它（它是白名单内的类型）
      await expect(service.statAsset(sibling)).resolves.toBe(4);

      // 但文本读写通道不行 —— 这条是资源根与工作区根的分界线。
      // 少了它，轻量模式就悄悄变成了「可以编辑同目录下任何文件」。
      await expectFileServiceError(service.readFile(sibling), 'OUT_OF_BOUNDS');
      await expectFileServiceError(service.readDocumentBytes(sibling), 'OUT_OF_BOUNDS');
      await expectFileServiceError(service.writeFile(sibling, '# c\n'), 'OUT_OF_BOUNDS');
    });

    it('资源根之外的路径仍然 403（资源根不是「全盘放行」）', async () => {
      const rootDir = path.join(tempDir, 'inside');
      await fsPromises.mkdir(rootDir, { recursive: true });
      const outsidePng = path.join(tempDir, 'outside.png');
      await fsPromises.writeFile(outsidePng, PNG_HEADER);

      const service = new FileService({ assetRoots: [rootDir] });
      const err = await expectFileServiceError(service.statAsset(outsidePng), 'OUT_OF_BOUNDS');
      expect(err.path).toBe(path.resolve(outsidePng));
    });

    it('资源根内仍受类型白名单约束（.txt 不放行）', async () => {
      const txtPath = path.join(tempDir, 'notes.txt');
      await fsPromises.writeFile(txtPath, 'hello', 'utf-8');

      const service = new FileService({ assetRoots: [tempDir] });
      await expectFileServiceError(service.statAsset(txtPath), 'UNSUPPORTED_TYPE');
    });

    it('authorizeAssetRoot 登记 realpath，使符号链接逃逸在轻量模式下也被拒', async () => {
      const realDir = path.join(tempDir, 'real');
      await fsPromises.mkdir(realDir, { recursive: true });
      const pngPath = path.join(realDir, 'a.png');
      await fsPromises.writeFile(pngPath, PNG_HEADER);

      // 模拟「文档目录里的 link.png 实际指向目录外」：realpath 返回一个根外路径。
      const escapeTarget = path.join(tempDir, 'elsewhere.png');
      const adapter = createMockFsAdapter({
        realpath: async (p) => (p === path.resolve(pngPath) ? escapeTarget : p)
      });

      const service = new FileService({ assetRoots: [realDir], fsAdapter: adapter });
      // 字符串层面它就在 realDir 之下，所以这一步必须先通过 ——
      // 否则下面的 OUT_OF_BOUNDS 可能来自「压根没授权」，测不出 realpath 那层。
      expect(await service.statAsset(pngPath)).toBe(PNG_HEADER.byteLength);

      await service.authorizeAssetRoot(realDir);
      await expectFileServiceError(service.statAsset(pngPath), 'OUT_OF_BOUNDS');
    });
  });

  /**
   * 删除文件：回收站 / 永久 两条分支 + 边界。
   *
   * 判据**不能**是「文件没了」—— 两条分支都让文件从原路径消失，那样写等于只测了一条。
   * 所以这里断言的是**哪条分支被走了**：永久删除必须调 `fsAdapter.unlink` 且不碰回收站；
   * 回收站必须调注入的 `TrashAdapter` 且**不调** `unlink`。回收站之所以能被这样观测，
   * 正是因为它没有进 `FileSystemAdapter`（那个接口描述的是 `fs` 能做的事，而回收站是
   * Electron 独有的能力），而是构造时注入的。
   *
   * 另一半是**失败方向**：认不出、没注入、路径越界、目标是目录 —— 一律「不删」。
   * 其中最要紧的是「没注入回收站」那一条：静默降级成永久删除会让用户以为文件进了回收站，
   * 其实再也找不回来。
   */
  describe('删除文件：回收站 / 永久 + 边界', () => {
    it('永久删除走 unlink，不经过回收站', async () => {
      const target = path.join(tempDir, 'doomed.md');
      await fsPromises.writeFile(target, '# Doomed', 'utf-8');

      const unlink = vi.fn();
      const trashItem = vi.fn(async () => {});
      const service = new FileService({
        allowedPaths: [target],
        fsAdapter: createMockFsAdapter({ unlink }),
        trash: { trashItem }
      });

      await service.deleteFile(target, 'permanent');

      expect(unlink).toHaveBeenCalledOnce();
      expect(unlink).toHaveBeenCalledWith(path.resolve(target));
      expect(trashItem).not.toHaveBeenCalled();
    });

    it('回收站走注入的 TrashAdapter，且**不**调 unlink', async () => {
      const target = path.join(tempDir, 'recoverable.md');
      await fsPromises.writeFile(target, '# Recoverable', 'utf-8');

      const unlink = vi.fn();
      const trashItem = vi.fn(async () => {});
      const service = new FileService({
        allowedPaths: [target],
        fsAdapter: createMockFsAdapter({ unlink }),
        trash: { trashItem }
      });

      await service.deleteFile(target, 'trash');

      expect(trashItem).toHaveBeenCalledOnce();
      expect(trashItem).toHaveBeenCalledWith(path.resolve(target));
      // 顺手把文件真删掉，「还能找回」就是假的。
      expect(unlink).not.toHaveBeenCalled();
    });

    it('不传 mode 时走回收站 —— 最保守的那一档是默认', async () => {
      const target = path.join(tempDir, 'default-mode.md');
      await fsPromises.writeFile(target, '# Default', 'utf-8');

      const trashItem = vi.fn(async () => {});
      const service = new FileService({ allowedPaths: [target], trash: { trashItem } });

      await service.deleteFile(target);

      expect(trashItem).toHaveBeenCalledOnce();
    });

    it('没注入回收站适配器时抛 IO_ERROR，且文件仍在', async () => {
      const target = path.join(tempDir, 'no-trash.md');
      await fsPromises.writeFile(target, '# Still here', 'utf-8');

      const unlink = vi.fn();
      const service = new FileService({
        allowedPaths: [target],
        fsAdapter: createMockFsAdapter({ unlink })
      });

      await expectFileServiceError(service.deleteFile(target, 'trash'), 'IO_ERROR');

      expect(unlink).not.toHaveBeenCalled();
      expect(fsPromises.stat(target)).resolves.toBeTruthy();
    });

    it('目录不能被删 —— 抛 IO_ERROR，而不是把整棵树递归删掉', async () => {
      const dir = path.join(tempDir, 'a-directory');
      await fsPromises.mkdir(dir, { recursive: true });
      const inside = path.join(dir, 'inside.md');
      await fsPromises.writeFile(inside, 'x', 'utf-8');

      const unlink = vi.fn();
      const trashItem = vi.fn(async () => {});
      const service = new FileService({
        allowedPaths: [dir],
        fsAdapter: createMockFsAdapter({ unlink }),
        trash: { trashItem }
      });

      await expectFileServiceError(service.deleteFile(dir, 'permanent'), 'IO_ERROR');

      expect(unlink).not.toHaveBeenCalled();
      expect(trashItem).not.toHaveBeenCalled();
      expect(fsPromises.stat(inside)).resolves.toBeTruthy();
    });

    it('未授权路径抛 OUT_OF_BOUNDS，且文件没被动过', async () => {
      const target = path.join(tempDir, 'unauthorized.md');
      await fsPromises.writeFile(target, '# Unauthorized', 'utf-8');

      const unlink = vi.fn();
      const trashItem = vi.fn(async () => {});
      const service = new FileService({
        fsAdapter: createMockFsAdapter({ unlink }),
        trash: { trashItem }
      });

      const err = await expectFileServiceError(
        service.deleteFile(target, 'permanent'),
        'OUT_OF_BOUNDS'
      );
      expect(err.path).toBe(path.resolve(target));
      expect(unlink).not.toHaveBeenCalled();
      expect(trashItem).not.toHaveBeenCalled();
      expect(fsPromises.stat(target)).resolves.toBeTruthy();
    });

    it('工作区里指向区外的符号链接也删不掉（realpath 逃逸）', async () => {
      const linkPath = path.join(tempDir, 'link.md');
      await fsPromises.writeFile(linkPath, '# Link', 'utf-8');
      // 目录**外**的落点。放在 tempDir 里会被 authorizeWorkspace 一并授权，测不出逃逸。
      const escapeTarget = path.join(os.tmpdir(), 'nexus-escape-target.md');

      const unlink = vi.fn();
      const adapter = createMockFsAdapter({
        unlink,
        realpath: async (p) => (p === path.resolve(linkPath) ? escapeTarget : p)
      });

      const service = new FileService({
        allowedPaths: [linkPath],
        fsAdapter: adapter,
        trash: { trashItem: vi.fn(async () => {}) }
      });
      // 字符串层面它就在白名单里，所以这一步必须先通过 —— 否则下面的 OUT_OF_BOUNDS
      // 可能来自「压根没授权」，测不出 realpath 那一层。
      await expect(service.readFile(linkPath)).resolves.toBe('# Link');

      await service.authorizeWorkspace(tempDir);
      await expectFileServiceError(service.deleteFile(linkPath, 'permanent'), 'OUT_OF_BOUNDS');
      expect(unlink).not.toHaveBeenCalled();
    });
  });
});
