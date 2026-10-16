import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileServiceError } from '@nexus/core';
import {
  FileService,
  DefaultFileSystemAdapter,
  type DirectoryEntryLike,
  type FileSystemAdapter
} from '../electron/file-service.js';
import type { FileDialog, FileDialogOptions } from '../electron/file-dialog.js';

/**
 * 复制 / 移动这批原语全落在真实文件系统上，所以用例**不 mock fs** —— 唯一被换掉的是
 * 「只有主进程才有」的两样东西（目录对话框、适配层里那几个要注入失败的成员）。
 * mock 掉 `rename` / `copyFile` 的后果是断言变成「调用方传对了参数」，
 * 而这一批真正会错的地方是**落点算得对不对、失败时留没留下垃圾**。
 */
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
    rename: (from, to) => (overrides.rename ? overrides.rename(from, to) : baseFs.rename(from, to)),
    unlink: (p) => (overrides.unlink ? overrides.unlink(p) : baseFs.unlink(p)),
    copyFile: (from, to) =>
      overrides.copyFile ? overrides.copyFile(from, to) : baseFs.copyFile(from, to),
    rmdir: (p, opts) => (overrides.rmdir ? overrides.rmdir(p, opts) : baseFs.rmdir(p, opts)),
    mkdir: (p, opts) => (overrides.mkdir ? overrides.mkdir(p, opts) : baseFs.mkdir(p, opts)),
    readdir: (p) => {
      if (overrides.readdir) return overrides.readdir(p);
      if (baseFs.readdir) return baseFs.readdir(p);
      throw new Error('测试适配层未实现 readdir');
    },
    stat: (p) => (overrides.stat ? overrides.stat(p) : baseFs.stat(p)),
    exists: (p) => {
      if (overrides.exists) return overrides.exists(p);
      if (baseFs.exists) return baseFs.exists(p);
      return fsPromises.access(p).then(
        () => true,
        () => false
      );
    },
    realpath: overrides.realpath ?? baseFs.realpath,
    watch: (p, opts, l) => (overrides.watch ? overrides.watch(p, opts, l) : baseFs.watch(p, opts, l))
  };
}

async function expectFileServiceError(
  promise: Promise<unknown>,
  code: FileServiceError['code']
): Promise<FileServiceError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(FileServiceError);
    const serviceError = err as FileServiceError;
    expect(serviceError.code).toBe(code);
    return serviceError;
  }
  throw new Error(`期望抛出 ${code}，但调用成功了`);
}

/** 目录树快照：相对路径 → 内容（目录以 `/` 结尾）。断言「搬完之后盘上到底有什么」。 */
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fsPromises.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        result[`${relative}/`] = '';
        await walk(full);
        continue;
      }
      result[relative] = await fsPromises.readFile(full, 'utf-8');
    }
  };

  await walk(root);
  return result;
}

function fakeEntry(name: string, kind: 'file' | 'directory' | 'symlink'): DirectoryEntryLike {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'symlink'
  };
}

describe('FileService 搬运原语（复制 / 移动）', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-transfer-test-'));
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  async function write(relativePath: string, content: string): Promise<string> {
    const full = path.join(tempDir, relativePath);
    await fsPromises.mkdir(path.dirname(full), { recursive: true });
    await fsPromises.writeFile(full, content, 'utf-8');
    return full;
  }

  async function authorize(service = new FileService()): Promise<FileService> {
    await service.authorizeWorkspace(tempDir);
    return service;
  }

  describe('resolveTransferTarget —— 只算落点，不碰磁盘', () => {
    it('不撞名时就是「目标目录 + 原名」', async () => {
      const service = await authorize();
      const source = await write('notes/a.md', '# A');
      await fsPromises.mkdir(path.join(tempDir, 'archive'));

      const target = await service.resolveTransferTarget(source, path.join(tempDir, 'archive'), 'move');
      expect(target).toBe(path.resolve(path.join(tempDir, 'archive', 'a.md')));
    });

    it('撞名时加序号，且**扩展名之前** —— `a.md` → `a-1.md` → `a-2.md`', async () => {
      const service = await authorize();
      const source = await write('notes/a.md', '# A');
      await write('archive/a.md', '# 已存在');
      await write('archive/a-1.md', '# 也占了');

      const target = await service.resolveTransferTarget(source, path.join(tempDir, 'archive'), 'copy');
      expect(path.basename(target)).toBe('a-2.md');
    });

    it('目录没有扩展名，序号加在末尾', async () => {
      const service = await authorize();
      await fsPromises.mkdir(path.join(tempDir, 'notes', 'sub'), { recursive: true });
      await fsPromises.mkdir(path.join(tempDir, 'archive', 'sub'), { recursive: true });

      const target = await service.resolveTransferTarget(
        path.join(tempDir, 'notes', 'sub'),
        path.join(tempDir, 'archive'),
        'copy'
      );
      expect(path.basename(target)).toBe('sub-1');
    });

    it('`move` 落回原目录 = 空操作（返回源路径本身，不加序号）', async () => {
      const service = await authorize();
      const source = await write('notes/a.md', '# A');

      const target = await service.resolveTransferTarget(source, path.join(tempDir, 'notes'), 'move');
      expect(target).toBe(source);
    });

    it('同一个落点，`copy` 却必然撞名 —— 这就是 `mode` 参数存在的理由', async () => {
      const service = await authorize();
      const source = await write('notes/a.md', '# A');

      const target = await service.resolveTransferTarget(source, path.join(tempDir, 'notes'), 'copy');
      expect(path.basename(target)).toBe('a-1.md');
    });

    it('源不存在时报 NOT_FOUND，不报 IO_ERROR', async () => {
      const service = await authorize();
      await fsPromises.mkdir(path.join(tempDir, 'archive'));

      await expectFileServiceError(
        service.resolveTransferTarget(path.join(tempDir, 'ghost.md'), path.join(tempDir, 'archive'), 'move'),
        'NOT_FOUND'
      );
    });

    it('落点不是目录时拒绝', async () => {
      const service = await authorize();
      const source = await write('notes/a.md', '# A');
      const notADirectory = await write('notes/b.md', '# B');

      await expectFileServiceError(
        service.resolveTransferTarget(source, notADirectory, 'move'),
        'IO_ERROR'
      );
    });

    it('不能把目录搬进它自己', async () => {
      const service = await authorize();
      await fsPromises.mkdir(path.join(tempDir, 'notes'), { recursive: true });

      await expectFileServiceError(
        service.resolveTransferTarget(path.join(tempDir, 'notes'), path.join(tempDir, 'notes'), 'copy'),
        'IO_ERROR'
      );
    });

    it('不能把目录搬进自己的子孙 —— 那不是一个结果，是一个无限结构', async () => {
      const service = await authorize();
      await fsPromises.mkdir(path.join(tempDir, 'notes', 'deep', 'deeper'), { recursive: true });

      await expectFileServiceError(
        service.resolveTransferTarget(
          path.join(tempDir, 'notes'),
          path.join(tempDir, 'notes', 'deep'),
          'copy'
        ),
        'IO_ERROR'
      );
    });

    it('源在边界外时拒绝', async () => {
      const service = await authorize();
      const outside = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-outside-'));
      try {
        await fsPromises.mkdir(path.join(tempDir, 'archive'));
        await expectFileServiceError(
          service.resolveTransferTarget(
            path.join(outside, 'x.md'),
            path.join(tempDir, 'archive'),
            'move'
          ),
          'OUT_OF_BOUNDS'
        );
      } finally {
        await fsPromises.rm(outside, { recursive: true, force: true });
      }
    });

    it('落点经符号链接指向工作区外时拒绝', async () => {
      const escapeTarget = path.resolve(path.join(os.tmpdir(), 'nexus-transfer-escape'));
      const linkDir = path.join(tempDir, 'link');
      await fsPromises.mkdir(linkDir, { recursive: true });

      // 不造真 symlink（Windows 上要提权），从适配层的 `realpath` 上模拟 ——
      // `assertNoSymlinkEscape` 认的就是它。
      const service = new FileService({
        fsAdapter: createMockFsAdapter({
          realpath: async (p) => (path.resolve(p) === path.resolve(linkDir) ? escapeTarget : p)
        })
      });
      await service.authorizeWorkspace(tempDir);
      const source = await write('notes/a.md', '# A');

      await expectFileServiceError(service.resolveTransferTarget(source, linkDir, 'move'), 'OUT_OF_BOUNDS');
    });
  });

  describe('moveEntry', () => {
    it('跨目录移动：源没了，目标在，内容一致', async () => {
      const service = await authorize();
      const source = await write('notes/a.md', '# A');
      await fsPromises.mkdir(path.join(tempDir, 'archive'));

      const target = await service.moveEntry(source, path.join(tempDir, 'archive'));

      expect(target).toBe(path.resolve(path.join(tempDir, 'archive', 'a.md')));
      // `notes/` 自己留着（空目录）—— 搬运只动条目，不清理源目录，与资源管理器一致。
      expect(await snapshot(tempDir)).toEqual({
        'archive/': '',
        'archive/a.md': '# A',
        'notes/': ''
      });
    });

    it('目录整棵子树一起搬 —— `rename` 本来就是原子的', async () => {
      const service = await authorize();
      await write('notes/a.md', '# A');
      await write('notes/sub/b.md', '# B');
      await fsPromises.mkdir(path.join(tempDir, 'archive'));

      const target = await service.moveEntry(path.join(tempDir, 'notes'), path.join(tempDir, 'archive'));

      expect(target).toBe(path.resolve(path.join(tempDir, 'archive', 'notes')));
      expect(await snapshot(tempDir)).toEqual({
        'archive/': '',
        'archive/notes/': '',
        'archive/notes/a.md': '# A',
        'archive/notes/sub/': '',
        'archive/notes/sub/b.md': '# B'
      });
    });

    it('搬回原目录是空操作，连 mtime 都不该动', async () => {
      const service = await authorize();
      const source = await write('notes/a.md', '# A');
      const before = (await fsPromises.stat(source)).mtimeMs;

      const target = await service.moveEntry(source, path.join(tempDir, 'notes'));

      expect(target).toBe(source);
      expect((await fsPromises.stat(source)).mtimeMs).toBe(before);
    });

    it('撞名时换名字，**绝不覆盖**已有的那一份', async () => {
      const service = await authorize();
      const source = await write('notes/a.md', '# 新的');
      await write('archive/a.md', '# 旧的，不能丢');
      await fsPromises.mkdir(path.join(tempDir, 'archive'), { recursive: true });

      const target = await service.moveEntry(source, path.join(tempDir, 'archive'));

      expect(path.basename(target)).toBe('a-1.md');
      expect(await snapshot(tempDir)).toEqual({
        'archive/': '',
        'archive/a-1.md': '# 新的',
        'archive/a.md': '# 旧的，不能丢',
        'notes/': ''
      });
    });
  });

  describe('copyEntry', () => {
    it('复制文件：源还在，副本内容一致', async () => {
      const service = await authorize();
      const source = await write('notes/a.md', '# A');
      await fsPromises.mkdir(path.join(tempDir, 'archive'));

      const result = await service.copyEntry(source, path.join(tempDir, 'archive'));

      expect(result.target).toBe(path.resolve(path.join(tempDir, 'archive', 'a.md')));
      expect(result.files).toEqual([result.target]);
      expect(await snapshot(tempDir)).toEqual({
        'archive/': '',
        'archive/a.md': '# A',
        'notes/': '',
        'notes/a.md': '# A'
      });
    });

    it('附件（二进制）复制后字节一致 —— 过一遍字符串编码就会坏', async () => {
      const service = await authorize();
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x00, 0xff, 0xfe, 0x1a]);
      const source = path.join(tempDir, 'notes', 'logo.png');
      await fsPromises.mkdir(path.dirname(source), { recursive: true });
      await fsPromises.writeFile(source, bytes);
      await fsPromises.mkdir(path.join(tempDir, 'archive'));

      const result = await service.copyEntry(source, path.join(tempDir, 'archive'));

      expect(Buffer.from(await fsPromises.readFile(result.target))).toEqual(bytes);
    });

    it('递归复制目录：结构一致，`files` 把整棵子树的文件都报出来', async () => {
      const service = await authorize();
      await write('notes/a.md', '# A');
      await write('notes/sub/b.md', '# B');
      await write('notes/sub/deep/c.png', 'c');
      await fsPromises.mkdir(path.join(tempDir, 'archive'));

      const result = await service.copyEntry(path.join(tempDir, 'notes'), path.join(tempDir, 'archive'));

      expect(path.basename(result.target)).toBe('notes');
      expect(result.files.map((f) => path.relative(result.target, f).split(path.sep).join('/')).sort()).toEqual([
        'a.md',
        'sub/b.md',
        'sub/deep/c.png'
      ]);
      expect(await snapshot(tempDir)).toEqual({
        'archive/': '',
        'archive/notes/': '',
        'archive/notes/a.md': '# A',
        'archive/notes/sub/': '',
        'archive/notes/sub/b.md': '# B',
        'archive/notes/sub/deep/': '',
        'archive/notes/sub/deep/c.png': 'c',
        'notes/': '',
        'notes/a.md': '# A',
        'notes/sub/': '',
        'notes/sub/b.md': '# B',
        'notes/sub/deep/': '',
        'notes/sub/deep/c.png': 'c'
      });
    });

    it('副本撞名时加序号，源不动', async () => {
      const service = await authorize();
      await write('notes/a.md', '# A');
      await write('notes/a-1.md', '# 已存在');

      const result = await service.copyEntry(
        path.join(tempDir, 'notes', 'a.md'),
        path.join(tempDir, 'notes')
      );

      expect(path.basename(result.target)).toBe('a-2.md');
    });

    it('递归时跳过符号链接 —— 跟随它会把工作区外的内容复制进来，还可能成环', async () => {
      const service = new FileService({
        fsAdapter: createMockFsAdapter({
          // 只在 `notes/` 这一层插一个链接条目，其余照旧走真 fs
          readdir: async (p) => {
            const real = await fsPromises.readdir(p, { withFileTypes: true });
            if (path.resolve(p) !== path.resolve(path.join(tempDir, 'notes'))) return real;
            return [...real, fakeEntry('escape-link', 'symlink')];
          }
        })
      });
      await service.authorizeWorkspace(tempDir);
      await write('notes/a.md', '# A');
      await fsPromises.mkdir(path.join(tempDir, 'archive'));

      const result = await service.copyEntry(path.join(tempDir, 'notes'), path.join(tempDir, 'archive'));

      expect(result.files.map((f) => path.basename(f))).toEqual(['a.md']);
      expect(await snapshot(path.join(tempDir, 'archive'))).toEqual({
        'notes/': '',
        'notes/a.md': '# A'
      });
    });

    it('中途失败时把半成品清掉 —— 留着一个「复制好了」但少了一半的目录最糟', async () => {
      const service = new FileService({
        fsAdapter: createMockFsAdapter({
          copyFile: async (from, to) => {
            // 第二个文件失败。第一个已经落盘了，正是要清理的那种状态。
            if (path.basename(from) === 'b.md') throw new Error('EBUSY: 文件被占用');
            await fsPromises.copyFile(from, to);
          }
        })
      });
      await service.authorizeWorkspace(tempDir);
      await write('notes/a.md', '# A');
      await write('notes/b.md', '# B');
      await fsPromises.mkdir(path.join(tempDir, 'archive'));

      await expectFileServiceError(
        service.copyEntry(path.join(tempDir, 'notes'), path.join(tempDir, 'archive')),
        'IO_ERROR'
      );

      // 副本那一层被整个删掉，源一个字节没动
      expect(await snapshot(tempDir)).toEqual({
        'archive/': '',
        'notes/': '',
        'notes/a.md': '# A',
        'notes/b.md': '# B'
      });
    });
  });

  describe('pickDirectory', () => {
    function dialogStub(result: string | null, seen: FileDialogOptions[] = []): FileDialog {
      return {
        openFile: async () => null,
        saveFile: async () => null,
        openDirectory: async (options) => {
          seen.push(options ?? {});
          return result;
        }
      };
    }

    it('返回选中的目录（已归一化）', async () => {
      const chosen = path.join(tempDir, 'archive');
      await fsPromises.mkdir(chosen);
      const service = new FileService({ dialog: dialogStub(chosen) });

      await expect(service.pickDirectory()).resolves.toBe(path.resolve(chosen));
    });

    it('取消时返回 null，不抛错 —— 「我改主意了」不是异常', async () => {
      const service = new FileService({ dialog: dialogStub(null) });
      await expect(service.pickDirectory()).resolves.toBeNull();
    });

    it('把 `defaultPath` 与标题透传给对话框', async () => {
      const seen: FileDialogOptions[] = [];
      const service = new FileService({ dialog: dialogStub(null, seen) });

      await service.pickDirectory({ defaultPath: tempDir, title: '移动到…' });

      expect(seen).toEqual([{ defaultPath: tempDir, title: '移动到…' }]);
    });

    it('选到工作区外**不在这里报错** —— 授权不是它的职责，`resolveTransferTarget` 会挡住', async () => {
      const outside = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-pick-outside-'));
      try {
        const service = await authorize(new FileService({ dialog: dialogStub(outside) }));
        await expect(service.pickDirectory()).resolves.toBe(path.resolve(outside));

        const source = await write('notes/a.md', '# A');
        await expectFileServiceError(service.resolveTransferTarget(source, outside, 'move'), 'OUT_OF_BOUNDS');
      } finally {
        await fsPromises.rm(outside, { recursive: true, force: true });
      }
    });

    it('未注入 FileDialog 时明确报错，而不是静默返回 null', async () => {
      const service = new FileService();
      await expectFileServiceError(service.pickDirectory(), 'IO_ERROR');
    });
  });
});
