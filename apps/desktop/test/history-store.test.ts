// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HistoryStore } from '../electron/history-store.js';
import { FileService } from '../electron/file-service.js';
import { createTempDir } from './smoke-harness.js';

/** 与 `HistoryStore` 同口径的内容哈希（sha256 前 8 位）—— 铺盘造数据时要造对。 */
function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);
}

describe('版本历史存储', () => {
  let workspace: string;
  let store: HistoryStore;

  beforeEach(() => {
    workspace = createTempDir('nexus-history-');
    store = new HistoryStore(workspace);
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('验收 1：依次保存 A、B、C → 历史里 2 条', () => {
    // 语义是「保存**前**把当前内容交进来」：
    //   写 A 时没有旧内容 → 不留
    //   写 B 前留 A
    //   写 C 前留 B
    store.record('notes/dma.md', 'A');
    store.record('notes/dma.md', 'B');

    expect(store.list('notes/dma.md')).toHaveLength(2);
  });

  it('验收 2：重复保存同一内容 → 条数不变', () => {
    store.record('dma.md', 'A');
    const afterFirst = store.list('dma.md').length;

    expect(store.record('dma.md', 'A')).toBeNull();
    expect(store.record('dma.md', 'A')).toBeNull();
    expect(store.list('dma.md')).toHaveLength(afterFirst);
  });

  it('内容变回旧值时也算重复 —— 按哈希去重，不是按时间', () => {
    store.record('dma.md', 'A');
    store.record('dma.md', 'B');

    // A 已经有一份了，不必再存
    expect(store.record('dma.md', 'A')).toBeNull();
    expect(store.list('dma.md')).toHaveLength(2);
  });

  it('目录镜像工作区结构，文件名带时间戳与哈希', () => {
    store.record('notes/deep/dma.md', 'content');

    const directory = store.directoryFor('notes/deep/dma.md');
    expect(directory).toBe(path.join(workspace, '.nexus', 'history', 'notes', 'deep', 'dma.md'));

    const names = fs.readdirSync(directory);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^\d{8}T\d{6}-[0-9a-f]{8}\.md$/);
  });

  it('时间戳不含冒号 —— Windows 文件名不允许', () => {
    store.record('dma.md', 'content');

    const names = fs.readdirSync(store.directoryFor('dma.md'));
    expect(names[0]).not.toContain(':');
  });

  it('读回的内容与写入时一致', () => {
    const content = '# 标题\n\n带中文与 emoji 🧮 的正文。\n';
    store.record('dma.md', content);

    const [entry] = store.list('dma.md');
    expect(store.read('dma.md', entry!)).toBe(content);
  });

  it('新的在前', () => {
    // 时间戳精度是秒，同一秒内写多条会拿到相同前缀 —— 这里只断言排序方向
    store.record('dma.md', 'A');
    store.record('dma.md', 'B');

    const entries = store.list('dma.md');
    expect(entries[0]!.savedAt >= entries[1]!.savedAt).toBe(true);
  });

  it('没有历史时返回空数组，不抛错', () => {
    expect(store.list('never-saved.md')).toEqual([]);
  });

  it('不同文档的历史互不干扰', () => {
    store.record('a.md', 'A');
    store.record('b.md', 'B');

    expect(store.list('a.md')).toHaveLength(1);
    expect(store.list('b.md')).toHaveLength(1);
  });

  it('目录里的无关文件被忽略', () => {
    store.record('dma.md', 'A');

    fs.writeFileSync(path.join(store.directoryFor('dma.md'), 'README.txt'), 'x', 'utf8');
    fs.writeFileSync(path.join(store.directoryFor('dma.md'), 'malformed.md'), 'x', 'utf8');

    expect(store.list('dma.md')).toHaveLength(1);
  });
});

/**
 * 保留上限。
 *
 * **用例在磁盘上直接铺出时间戳递增的历史**，不靠连着调 `record` —— 时间戳精度是秒，
 * 同一秒内写多条会拿到相同的 `savedAt`，而 `list` 对并列不做保证（落在 `readdir` 顺序上，
 * 也就是文件名即哈希的顺序）。那样写出来的用例「谁被删掉」是不确定的，会随机红。
 * 铺盘还顺带覆盖了「上限调小之后，已有的那一堆怎么办」这个真实场景。
 */
describe('版本历史 · 保留上限', () => {
  let workspace: string;
  let store: HistoryStore;

  beforeEach(() => {
    workspace = createTempDir('nexus-history-retention-');
    store = new HistoryStore(workspace);
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  /** 铺 `count` 份历史，时间戳递增（旧 → 新），内容是 `内容 1` … `内容 count`。 */
  function seed(relativePath: string, count: number): void {
    const directory = store.directoryFor(relativePath);
    fs.mkdirSync(directory, { recursive: true });

    for (let index = 1; index <= count; index += 1) {
      const savedAt = `20260901T${String(index).padStart(6, '0')}`;
      // 哈希必须是真的内容哈希：去重是按它比的，编一个会让「去重命中」那条用例假红。
      const hash = contentHash(`内容 ${index}`);
      fs.writeFileSync(path.join(directory, `${savedAt}-${hash}.md`), `内容 ${index}`, 'utf8');
    }
  }

  /** 目录里实际剩几个文件 —— 「真的删了」与「只是没列出来」的区别。 */
  function fileCount(relativePath: string): number {
    return fs.readdirSync(store.directoryFor(relativePath)).length;
  }

  /** 当前历史的内容，新的在前。 */
  function contents(relativePath: string): string[] {
    return store.list(relativePath).map((entry) => store.read(relativePath, entry));
  }

  it('不超上限时一个都不删', () => {
    seed('dma.md', 3);

    expect(store.record('dma.md', '新的', 5)).not.toBeNull();
    expect(contents('dma.md')).toEqual(['新的', '内容 3', '内容 2', '内容 1']);
  });

  it('超上限时删掉最旧的，留下最新的 N 份', () => {
    seed('dma.md', 4);

    store.record('dma.md', '新的', 2);

    expect(contents('dma.md')).toEqual(['新的', '内容 4']);
  });

  it('删的是磁盘上的文件，不只是「不列出来」', () => {
    seed('dma.md', 4);

    store.record('dma.md', '新的', 2);

    // 少了 3 个（内容 1/2/3）。不这么断言的话，「list 过滤掉了」也能骗过上面那条。
    expect(fileCount('dma.md')).toBe(2);
  });

  it('上限调小之后，第一次留快照就把多余的削到上限', () => {
    seed('dma.md', 20);

    store.record('dma.md', '新的', 2);

    expect(contents('dma.md')).toEqual(['新的', '内容 20']);
    expect(fileCount('dma.md')).toBe(2);
  });

  it('**去重命中时也修剪** —— 否则把上限调小要等下次内容真的变了才生效', () => {
    seed('dma.md', 4);

    // 存一个已经存在的内容：不写新条目，但仍该把多余的削掉
    expect(store.record('dma.md', '内容 2', 2)).toBeNull();

    expect(contents('dma.md')).toEqual(['内容 4', '内容 3']);
  });

  it('不清理（null）时永不删', () => {
    seed('dma.md', 30);

    store.record('dma.md', '新的', null);

    expect(fileCount('dma.md')).toBe(31);
  });

  it('刚写的那条不会被自己削掉 —— 上限 1 时留下的必须正是它', () => {
    seed('dma.md', 3);

    store.record('dma.md', '刚写的', 1);

    expect(contents('dma.md')).toEqual(['刚写的']);
  });

  it('上限只管自己这份文档，不碰别的', () => {
    seed('a.md', 3);
    seed('b.md', 3);

    store.record('a.md', '新的', 1);

    expect(fileCount('a.md')).toBe(1);
    expect(fileCount('b.md')).toBe(3);
  });
});

describe('验收 4：.nexus 不参与索引', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = createTempDir('nexus-history-scan-');
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('历史快照不会被当成工作区文档', async () => {
    // 一份真文档 + 一份历史快照
    fs.writeFileSync(path.join(workspace, 'real.md'), '# 真文档\n', 'utf8');
    const historyDir = path.join(workspace, '.nexus', 'history');
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, '20260926T103000Z-a1b2c3d4.md'), '# 快照\n', 'utf8');

    const service = new FileService();
    // FileService 有工作区边界检查，扫描前必须先授权根目录
    await service.authorizeWorkspace(workspace);

    const result = await service.scanWorkspaceMarkdownFiles(workspace);

    const paths = result.files.map((file) => file.relativePath.replace(/\\/g, '/'));
    expect(paths).toContain('real.md');
    // 关键断言：快照不在扫描结果里
    expect(paths.some((item) => item.includes('.nexus'))).toBe(false);
    expect(paths).toHaveLength(1);
  });
});

/**
 * 永久删除一个文档时，它的版本历史**一起**没。
 *
 * 口径来自「两条分支各自自洽」：回收站那一档是「还能找回来」，所以历史留着（恢复到同一
 * 路径时历史跟着回来）；永久删除是「什么都不留」，留着历史等于留了一份用户以为已经删掉的
 * 副本 —— 那是**内容本身**，不是元数据。
 *
 * 三条判据，缺一条都会留下可见的毛病：
 *   1. 该文档的历史目录真的没了；
 *   2. 向上收空目录（`notes/deep/dma.md` 删掉后 `notes/deep/` 若空了不该留一个空壳）；
 *   3. 别人的历史**不受影响**（收空目录收到一半撞上非空就停，不能连坐）。
 */
describe('版本历史 · 删除文档时一并清掉', () => {
  let workspace: string;
  let store: HistoryStore;

  beforeEach(() => {
    workspace = createTempDir('nexus-history-forget-');
    store = new HistoryStore(workspace);
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('forget 之后该文档的历史目录不存在，list 也空了', () => {
    store.record('notes/dma.md', 'A');
    store.record('notes/dma.md', 'B');
    expect(store.list('notes/dma.md')).toHaveLength(2);

    store.forget('notes/dma.md');

    expect(fs.existsSync(store.directoryFor('notes/dma.md'))).toBe(false);
    expect(store.list('notes/dma.md')).toHaveLength(0);
  });

  it('向上收掉空掉的祖先目录', () => {
    store.record('notes/deep/dma.md', 'A');
    const deepDir = path.join(workspace, '.nexus', 'history', 'notes', 'deep');
    expect(fs.existsSync(deepDir)).toBe(true);

    store.forget('notes/deep/dma.md');

    // `notes/` 下没有别的文档了，所以整条链都该收干净
    expect(fs.existsSync(path.join(workspace, '.nexus', 'history', 'notes'))).toBe(false);
    // 历史根自己不能跟着被收掉 —— 那会让下一次 record 找不到父目录。
    expect(fs.existsSync(path.join(workspace, '.nexus', 'history'))).toBe(true);
  });

  it('同目录下还有别的文档时，祖先目录留着', () => {
    store.record('notes/a.md', 'A');
    store.record('notes/b.md', 'B');

    store.forget('notes/a.md');

    expect(fs.existsSync(store.directoryFor('notes/a.md'))).toBe(false);
    // b 的历史还在，`notes/` 因此非空 —— 收空目录必须在非空处停下，不能连坐。
    expect(store.list('notes/b.md')).toHaveLength(1);
    expect(fs.existsSync(store.directoryFor('notes/b.md'))).toBe(true);
  });

  it('删一个从来没有过历史的文档不抛错', () => {
    // 永久删除会无条件调它，所以「没历史」必须是正常路径而不是异常路径。
    expect(() => store.forget('never-saved.md')).not.toThrow();
    expect(() => store.forget('notes/never-saved.md')).not.toThrow();
  });
});

/**
 * 文档改名时把历史目录一起搬过去。
 *
 * **不搬的话「可回退」这条路自己就断了** —— 历史按相对路径组织，改名后
 * `list(新路径)` 什么都找不到，而用户刚刚才因为「要改写别人的文件」被承诺过
 * 「改前的内容进了版本历史」。所以这不是可选项。
 */
describe('版本历史 · 改名时一起搬', () => {
  let workspace: string;
  let store: HistoryStore;

  beforeEach(() => {
    workspace = createTempDir('nexus-history-rename-');
    store = new HistoryStore(workspace);
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function fileCount(relativePath: string): number {
    return fs.readdirSync(store.directoryFor(relativePath)).length;
  }

  function contents(relativePath: string): string[] {
    return store.list(relativePath).map((entry) => store.read(relativePath, entry));
  }

  it('改名后按新路径能读回同样的历史，旧路径空了', () => {
    store.record('notes/dma.md', 'A');
    store.record('notes/dma.md', 'B');
    // 排序：时间戳精度是秒，同一秒内写的几条 `savedAt` 相同，`list` 对并列不做保证
    // （落在 `readdir` 顺序上）。所以这里比集合，不比顺序。
    const before = contents('notes/dma.md').sort();

    store.rename('notes/dma.md', 'notes/dma2.md');

    expect(contents('notes/dma2.md').sort()).toEqual(before);
    expect(fs.existsSync(store.directoryFor('notes/dma.md'))).toBe(false);
    expect(store.list('notes/dma.md')).toEqual([]);
  });

  it('搬到别的目录时父目录会被建出来', () => {
    store.record('a.md', 'A');

    store.rename('a.md', 'deep/nested/b.md');

    expect(contents('deep/nested/b.md')).toEqual(['A']);
  });

  it('旧位置空掉的祖先目录收干净，历史根保住', () => {
    store.record('notes/deep/dma.md', 'A');

    store.rename('notes/deep/dma.md', 'dma2.md');

    expect(contents('dma2.md')).toEqual(['A']);
    expect(fs.existsSync(path.join(workspace, '.nexus', 'history', 'notes'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, '.nexus', 'history'))).toBe(true);
  });

  it('新路径已经有历史时逐条并过去，两边都不丢', () => {
    // 真实来路：`b.md` 曾经存在过，被「移到回收站」删掉后历史留了下来，
    // 现在 `a.md` 改名成了 `b.md`。
    store.record('a.md', 'A1');
    store.record('a.md', 'A2');
    store.record('b.md', 'B1');

    store.rename('a.md', 'b.md');

    expect(contents('b.md').sort()).toEqual(['A1', 'A2', 'B1']);
    expect(fileCount('b.md')).toBe(3);
    expect(fs.existsSync(store.directoryFor('a.md'))).toBe(false);
  });

  it('从来没有过历史的文档，改名不抛错也不留下空目录', () => {
    expect(() => store.rename('never-saved.md', 'renamed.md')).not.toThrow();
    expect(fs.existsSync(store.directoryFor('renamed.md'))).toBe(false);
  });

  it('同一路径改名（只差大小写）时什么都不做', () => {
    store.record('dma.md', 'A');

    store.rename('dma.md', 'dma.md');

    expect(contents('dma.md')).toEqual(['A']);
  });
});
