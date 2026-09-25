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
});
