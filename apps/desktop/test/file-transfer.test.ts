// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { launchElectronApp, createTempDir, type ElectronAppInstance } from './smoke-harness.js';

/**
 * 复制 / 移动两条 IPC 通道的真机接线。
 *
 * ## 为什么走 `window.nexus` 而不是点界面
 *
 * 这两条通道的**调用方**（树右键菜单的复制 / 移动 / 粘贴）在渲染进程那一批里单独验；
 * 这里要证的是它们自己那一半：落点算得对不对、② 的重基准写没写对、① 改的是不是
 * 恰好那几篇、索引与历史跟没跟上、以及 `updateLinks: false` 时**别人一个字节都不动**。
 * 那些全在主进程，走桥直调既够也更快 —— 点界面还要等菜单、等预览屏，而它们都不产生
 * 这里要断言的东西。
 *
 * ## 为什么只启动一次 Electron
 *
 * 同一个测试文件里第二次 `launchElectronApp` 会卡在 `Runtime.enable` 不返回
 * （见 `rename-file.test.ts` 的同一段说明）。所以五轮动作塞进一个用例，
 * 每轮之后**把盘上的事实全部断一遍**再进下一轮。
 */
describe('复制与移动的 IPC 通道', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  const ROOT_MD = '# 根\n\n见 [[notes/a]]、[[notes/b]] 与 ![logo](assets/logo.png)\n';
  const A_MD = '# A\n\n见 [b](b.md) 与 [c](sub/c.md)，还有 [[notes/b]]。\n';

  beforeAll(() => {
    tempDir = createTempDir('nexus-transfer-');
    workspace = path.join(tempDir, 'vault');

    fs.mkdirSync(path.join(workspace, 'notes', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'archive'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'elsewhere'), { recursive: true });

    fs.writeFileSync(path.join(workspace, 'root.md'), ROOT_MD, 'utf-8');
    fs.writeFileSync(path.join(workspace, 'notes', 'a.md'), A_MD, 'utf-8');
    fs.writeFileSync(path.join(workspace, 'notes', 'b.md'), '# B\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'notes', 'sub', 'c.md'), '# C\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // 历史目录镜像工作区结构。搬运不搬它的话「可回退」这条路自己就断了。
    const dir = path.join(workspace, '.nexus', 'history', 'notes', 'a.md');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '20260101T000000-aaaaaaaa.md'), '# 旧版本\n', 'utf-8');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  function read(relativePath: string): string {
    return fs.readFileSync(path.join(workspace, ...relativePath.split('/')), 'utf-8');
  }

  function exists(relativePath: string): boolean {
    return fs.existsSync(path.join(workspace, ...relativePath.split('/')));
  }

  it('落点、重基准、回写、索引与历史一起动；复制不改别人的文档', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForIndexReady();

    async function call(bridge: string, request: unknown): Promise<Record<string, unknown>> {
      return app.evaluate<Record<string, unknown>>(
        `window.nexus.${bridge}(${JSON.stringify(request)})`
      );
    }

    /** 索引里那些文档的相对路径。搬运之后树、搜索、图谱全靠它。 */
    async function indexedPaths(): Promise<string[]> {
      const documents = await app.evaluate<Array<{ relativePath: string; id: number }>>(
        'window.nexus.listIndexedDocuments()'
      );
      return documents.map((document) => document.relativePath).sort();
    }

    /** 某个相对路径在索引里的 `id`。搬运必须**就地改**那一行，否则反向链接与图谱边一起丢。 */
    async function idOf(relativePath: string): Promise<number> {
      const documents = await app.evaluate<Array<{ relativePath: string; id: number }>>(
        'window.nexus.listIndexedDocuments()'
      );
      return documents.find((document) => document.relativePath === relativePath)?.id ?? -1;
    }

    // `chooseDirectory` 会弹**原生模态**，真点下去整个渲染进程就卡住了 —— 所以这里只验
    // 「桥上有这个方法」。它自己的行为（取消返回 null、把 defaultPath 与标题透传）
    // 在 `file-service-transfer.test.ts` 里用注入的假对话框验。
    expect(await app.evaluate<boolean>('typeof window.nexus.chooseDirectory === "function"')).toBe(true);

    const aIdBefore = await idOf('notes/a.md');
    expect(aIdBefore).toBeGreaterThan(0);

    /* ── 第一轮：移动的**试算**。一个字节都不该动 ── */
    const dryRun = await call('moveFile', {
      rootPath: workspace,
      targetDirectory: path.join(workspace, 'archive'),
      entries: [{ path: path.join(workspace, 'notes', 'a.md') }],
      updateLinks: true,
      skipPaths: [],
      dryRun: true
    });

    expect(dryRun.transferred).toEqual([]);
    expect(dryRun.target).toBe(path.join(workspace, 'archive', 'a.md'));
    expect((dryRun.changes as Array<{ relativePath: string; before: string; after: string }>)).toEqual([
      expect.objectContaining({
        relativePath: 'root.md',
        before: ROOT_MD,
        after: ROOT_MD.replace('[[notes/a]]', '[[archive/a]]')
      })
    ]);
    expect(exists('notes/a.md')).toBe(true);
    expect(exists('archive/a.md')).toBe(false);

    /* ── 第二轮：真的搬。② 重基准自己、① 回写别人、历史与索引跟上 ── */
    const moved = await call('moveFile', {
      rootPath: workspace,
      targetDirectory: path.join(workspace, 'archive'),
      entries: [{ path: path.join(workspace, 'notes', 'a.md') }],
      updateLinks: true,
      skipPaths: [],
      dryRun: false
    });

    expect(moved.target).toBe(path.join(workspace, 'archive', 'a.md'));
    expect(moved.transferred).toEqual([
      {
        from: path.join(workspace, 'notes', 'a.md'),
        to: path.join(workspace, 'archive', 'a.md'),
        fromRelativePath: 'notes/a.md',
        toRelativePath: 'archive/a.md'
      }
    ]);

    expect(exists('notes/a.md')).toBe(false);
    expect(exists('archive/a.md')).toBe(true);
    // ① 指向它的引用改了写法（不是语义）
    expect(read('root.md')).toBe(ROOT_MD.replace('[[notes/a]]', '[[archive/a]]'));
    // ② 它自己的出链按新目录重算；`[[notes/b]]` 不动 —— b 没搬
    expect(read('archive/a.md')).toBe(
      '# A\n\n见 [b](../notes/b.md) 与 [c](../notes/sub/c.md)，还有 [[notes/b]]。\n'
    );
    // 历史目录跟着搬（不搬的话这一篇的「可回退」就断了）
    expect(exists('.nexus/history/archive/a.md/20260101T000000-aaaaaaaa.md')).toBe(true);
    expect(exists('.nexus/history/notes/a.md')).toBe(false);
    // 索引**就地**改那一行：`id` 不变，否则反向链接与图谱边一起丢
    expect(await idOf('archive/a.md')).toBe(aIdBefore);
    expect(await idOf('notes/a.md')).toBe(-1);

    /* ── 第三轮：复制。原件不动、别人的文档一个字节都不动 ── */
    const copied = await call('copyFile', {
      rootPath: workspace,
      targetDirectory: path.join(workspace, 'archive'),
      entries: [{ path: path.join(workspace, 'notes', 'b.md') }],
      dryRun: false
    });

    expect(copied.changes).toEqual([]);
    expect(copied.target).toBe(path.join(workspace, 'archive', 'b.md'));
    expect(read('notes/b.md')).toBe('# B\n');
    expect(read('archive/b.md')).toBe('# B\n');
    // 副本是**新文档** → 进索引
    expect(await indexedPaths()).toContain('archive/b.md');
    // `root.md` 里的 `[[notes/b]]` **不该**被改成 `[[archive/b]]` —— 原件还在原处，
    // 把它指到副本上才是错的（这是「复制」与「移动」最要紧的一条分界）
    expect(read('root.md')).toContain('[[notes/b]]');

    /* ── 第四轮：搬一个**目录**。整棵子树、路径式 wikilink、逐行索引一起动 ── */
    const bIdBefore = await idOf('notes/b.md');
    const movedDir = await call('moveFile', {
      rootPath: workspace,
      targetDirectory: path.join(workspace, 'elsewhere'),
      entries: [{ path: path.join(workspace, 'notes') }],
      updateLinks: true,
      skipPaths: [],
      dryRun: false
    });

    expect(movedDir.target).toBe(path.join(workspace, 'elsewhere', 'notes'));
    expect((movedDir.transferred as Array<{ toRelativePath: string }>).map((item) => item.toRelativePath).sort()).toEqual([
      'elsewhere/notes/b.md',
      'elsewhere/notes/sub/c.md'
    ]);

    expect(exists('notes')).toBe(false);
    expect(read('elsewhere/notes/b.md')).toBe('# B\n');
    expect(read('elsewhere/notes/sub/c.md')).toBe('# C\n');
    // ① 指向子树的引用（`root.md` 的 `[[notes/b]]`）
    expect(read('root.md')).toContain('[[elsewhere/notes/b]]');
    // ① 也改**附件式的相对引用**：`archive/a.md` 里那条 `../notes/b.md` 指的是搬走的那一篇
    expect(read('archive/a.md')).toContain('[b](../elsewhere/notes/b.md)');
    // 索引逐行就地改（`id` 不变）
    expect(await idOf('elsewhere/notes/b.md')).toBe(bIdBefore);
    expect((await indexedPaths()).filter((item) => item.startsWith('notes/'))).toEqual([]);

    /* ── 第五轮：`updateLinks: false` 时**别人一个字节都不动** ── */
    const rootBefore = read('root.md');
    const noLinks = await call('moveFile', {
      rootPath: workspace,
      targetDirectory: path.join(workspace, 'archive'),
      entries: [{ path: path.join(workspace, 'elsewhere', 'notes', 'b.md') }],
      updateLinks: false,
      skipPaths: [],
      dryRun: false
    });

    expect(noLinks.changes).toEqual([]);
    expect(read('root.md')).toBe(rootBefore);
    expect(exists('archive/b-1.md')).toBe(true); // `archive/b.md` 已经被第三轮占了
    expect(read('elsewhere/notes/sub/c.md')).toBe('# C\n');
  }, 180_000);
});
