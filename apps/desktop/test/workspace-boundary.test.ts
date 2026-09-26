import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileService, isPathInside } from '../electron/file-service.js';

/**
 * 工作区边界（P2-03）。
 *
 * 这是唯一一处做错会变成路径穿越漏洞的地方，所以测试重点在**负向**：
 * 前缀相同的兄弟目录、`..` 回溯、符号链接指向外部，都必须被拒。
 */
describe('工作区边界与目录扫描', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-ws-boundary-'));
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  describe('isPathInside', () => {
    it('前缀相同的兄弟目录不能被当成子目录', () => {
      const root = path.join(tempDir, 'Notes');

      // `...\Notes2` 以 `...\Notes` 开头，但 startsWith 判据会把它错认为子目录
      expect(isPathInside(root, path.join(tempDir, 'Notes2', 'a.md'))).toBe(false);
      expect(isPathInside(root, path.join(root, 'a.md'))).toBe(true);
      expect(isPathInside(root, root)).toBe(true);
      // `..` 回溯到父级也不行
      expect(isPathInside(root, path.join(root, '..', 'outside.md'))).toBe(false);
    });

    it('Windows 盘符与大小写差异不误判', () => {
      if (process.platform !== 'win32') return;
      expect(isPathInside('C:\\Notes', 'c:\\notes\\sub\\a.md')).toBe(true);
      expect(isPathInside('C:\\Notes', 'D:\\Notes\\a.md')).toBe(false);
    });
  });

  describe('authorizeWorkspace', () => {
    it('授权后目录下的文件可读写，工作区之外仍被拒', async () => {
      const workspace = path.join(tempDir, 'vault');
      await fsPromises.mkdir(path.join(workspace, 'notes'), { recursive: true });
      const inside = path.join(workspace, 'notes', 'a.md');
      await fsPromises.writeFile(inside, '# a\n', 'utf-8');

      const outside = path.join(tempDir, 'outside.md');
      await fsPromises.writeFile(outside, '# outside\n', 'utf-8');

      const service = new FileService();
      await service.authorizeWorkspace(workspace);

      await expect(service.readFile(inside)).resolves.toBe('# a\n');
      await service.writeFile(inside, '# a edited\n');
      await expect(fsPromises.readFile(inside, 'utf-8')).resolves.toBe('# a edited\n');

      await expect(service.readFile(outside)).rejects.toMatchObject({ code: 'OUT_OF_BOUNDS' });
      await expect(service.writeFile(outside, 'x')).rejects.toMatchObject({
        code: 'OUT_OF_BOUNDS'
      });
    });

    it('授权不存在的路径抛 NOT_FOUND，授权文件（非目录）抛 IO_ERROR', async () => {
      const service = new FileService();

      await expect(service.authorizeWorkspace(path.join(tempDir, 'missing'))).rejects.toMatchObject(
        { code: 'NOT_FOUND' }
      );

      const filePath = path.join(tempDir, 'a.md');
      await fsPromises.writeFile(filePath, 'x', 'utf-8');
      await expect(service.authorizeWorkspace(filePath)).rejects.toMatchObject({
        code: 'IO_ERROR'
      });
    });

    it('构造时通过 workspaceRoots 注入的根立即生效', async () => {
      const workspace = path.join(tempDir, 'vault');
      await fsPromises.mkdir(workspace, { recursive: true });
      const inside = path.join(workspace, 'a.md');
      await fsPromises.writeFile(inside, '# a\n', 'utf-8');

      const service = new FileService({ workspaceRoots: [workspace] });
      await expect(service.readFile(inside)).resolves.toBe('# a\n');
    });

    it('工作区内的符号链接指向外部时，读写被拒绝', async () => {
      const workspace = path.join(tempDir, 'vault');
      const outside = path.join(tempDir, 'outside');
      await fsPromises.mkdir(workspace, { recursive: true });
      await fsPromises.mkdir(outside, { recursive: true });

      const secret = path.join(outside, 'secret.md');
      await fsPromises.writeFile(secret, '# secret\n', 'utf-8');

      const linkPath = path.join(workspace, 'link.md');
      try {
        await fsPromises.symlink(secret, linkPath, 'file');
      } catch (err) {
        // Windows 未开开发者模式时创建 symlink 需要管理员权限 —— 明确跳过，
        // 但打印原因，免得「环境不支持」被误读成「防护有效」。
        console.warn(`跳过符号链接用例：${(err as Error).message}`);
        return;
      }

      // 先证明链接真的建起来了，否则下面的断言可能只是因为路径不存在而"通过"
      expect((await fsPromises.lstat(linkPath)).isSymbolicLink()).toBe(true);
      // 从链接读到的确实是外部内容 —— 说明字符串边界看不出问题，只能靠 realpath
      await expect(fsPromises.readFile(linkPath, 'utf-8')).resolves.toBe('# secret\n');

      const service = new FileService();
      await service.authorizeWorkspace(workspace);

      // 纯字符串边界认为它在工作区内，只有 realpath 校验能识破
      await expect(service.readFile(linkPath)).rejects.toMatchObject({ code: 'OUT_OF_BOUNDS' });
    });
  });

  describe('scanWorkspaceMarkdownFiles', () => {
    it('递归收集 markdown、跳过 node_modules 与 .git、relativePath 用正斜杠', async () => {
      const workspace = path.join(tempDir, 'vault');
      await fsPromises.mkdir(path.join(workspace, 'notes', 'deep'), { recursive: true });
      await fsPromises.mkdir(path.join(workspace, 'node_modules', 'pkg'), { recursive: true });
      await fsPromises.mkdir(path.join(workspace, '.git'), { recursive: true });

      await fsPromises.writeFile(path.join(workspace, 'root.md'), '# root\n', 'utf-8');
      await fsPromises.writeFile(path.join(workspace, 'notes', 'a.md'), '# a\n', 'utf-8');
      await fsPromises.writeFile(
        path.join(workspace, 'notes', 'deep', 'b.markdown'),
        '# b\n',
        'utf-8'
      );
      await fsPromises.writeFile(path.join(workspace, 'notes', 'skip.txt'), 'x', 'utf-8');
      await fsPromises.writeFile(
        path.join(workspace, 'node_modules', 'pkg', 'readme.md'),
        '# no\n',
        'utf-8'
      );
      await fsPromises.writeFile(path.join(workspace, '.git', 'x.md'), '# no\n', 'utf-8');

      const service = new FileService();
      await service.authorizeWorkspace(workspace);
      const result = await service.scanWorkspaceMarkdownFiles(workspace);

      expect(result.files.map((f) => f.relativePath).sort()).toEqual([
        'notes/a.md',
        'notes/deep/b.markdown',
        'root.md'
      ]);
      expect(result.truncated).toBe(false);
      expect(result.skippedDirectories).toBe(2);

      const rootEntry = result.files.find((f) => f.relativePath === 'root.md');
      expect(rootEntry?.name).toBe('root.md');
      expect(rootEntry?.path).toBe(path.join(workspace, 'root.md'));
      expect(rootEntry?.sizeBytes).toBeGreaterThan(0);
      expect(rootEntry?.modifiedAtMs).toBeGreaterThan(0);
    });

    it('跳过点开头的工具元数据目录，不把快照与回收站当文档', async () => {
      const workspace = path.join(tempDir, 'vault');
      await fsPromises.mkdir(path.join(workspace, 'notes'), { recursive: true });

      // 前四条是实际踩过的：`.marking` 是另一个笔记工具的快照、`.nestnote` 是
      // 它的回收站、`.nexus` 是本应用的版本历史、`.obsidian` 是配置。
      // 最后一条是**任意新目录** —— 断言的是「点开头一律跳过」这条前缀规则，
      // 而不是又往黑名单里补了一个名字。
      const ghostFiles = [
        '.marking/snapshots/0258fd9162334454.md',
        '.nestnote/trash/1780421906423-d4f7aded-_.md',
        '.obsidian/workspace.md',
        '.nexus/history/notes/a/20260926T103000-8aab2c99.md',
        '.brand-new-tool/export.md'
      ];
      for (const relative of ghostFiles) {
        const absolute = path.join(workspace, relative);
        await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
        await fsPromises.writeFile(absolute, '# ghost\n', 'utf-8');
      }

      await fsPromises.writeFile(path.join(workspace, 'root.md'), '# root\n', 'utf-8');
      await fsPromises.writeFile(path.join(workspace, 'notes', 'a.md'), '# a\n', 'utf-8');

      const service = new FileService();
      await service.authorizeWorkspace(workspace);
      const result = await service.scanWorkspaceMarkdownFiles(workspace);

      expect(result.files.map((f) => f.relativePath).sort()).toEqual(['notes/a.md', 'root.md']);
      // 只计顶层被跳过的目录：`.marking` 被跳过就不会再往下走 `snapshots`
      expect(result.skippedDirectories).toBe(ghostFiles.length);
    });

    it('未授权的工作区无法扫描', async () => {
      const service = new FileService();
      await expect(service.scanWorkspaceMarkdownFiles(tempDir)).rejects.toMatchObject({
        code: 'OUT_OF_BOUNDS'
      });
    });

    it('超过 maxFiles 时截断并标记 truncated', async () => {
      const workspace = path.join(tempDir, 'vault');
      await fsPromises.mkdir(workspace, { recursive: true });
      for (let i = 0; i < 5; i += 1) {
        await fsPromises.writeFile(path.join(workspace, `n${i}.md`), '# x\n', 'utf-8');
      }

      const service = new FileService();
      await service.authorizeWorkspace(workspace);
      const result = await service.scanWorkspaceMarkdownFiles(workspace, { maxFiles: 3 });

      expect(result.files).toHaveLength(3);
      expect(result.truncated).toBe(true);
    });
  });
});
