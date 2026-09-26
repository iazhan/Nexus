// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { HistoryStore } from '../electron/history-store.js';
import { FileService } from '../electron/file-service.js';
import { createTempDir } from './smoke-harness.js';

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
