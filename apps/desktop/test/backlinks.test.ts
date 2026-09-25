// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractWikiLinkTargets } from '../electron/indexer.js';
import { IndexStore } from '../electron/index-store.js';

describe('出链提取', () => {
  it('提取 [[目标]]', () => {
    expect(extractWikiLinkTargets('参见 [[dma]]。')).toEqual(['dma']);
  });

  it('别名形式只取目标部分', () => {
    expect(extractWikiLinkTargets('参见 [[dma|DMA 那篇]]。')).toEqual(['dma']);
  });

  it('归一化：去掉 .md 并转小写', () => {
    expect(extractWikiLinkTargets('[[DMA.md]]')).toEqual(['dma']);
  });

  it('去重 —— 同一目标写多次只记一条', () => {
    expect(extractWikiLinkTargets('[[a]] 与 [[A]] 与 [[a.md]]')).toEqual(['a']);
  });

  it('保留路径形式的目标', () => {
    expect(extractWikiLinkTargets('[[notes/dma]]')).toEqual(['notes/dma']);
  });

  it('没有链接时返回空数组', () => {
    expect(extractWikiLinkTargets('普通文本，没有链接。')).toEqual([]);
  });

  it('空目标被忽略', () => {
    expect(extractWikiLinkTargets('[[]] 与 [[   ]]')).toEqual([]);
  });
});

describe('反向链接', () => {
  let dir: string;
  let store: IndexStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-backlink-'));
    store = IndexStore.open(path.join(dir, 'index.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const put = (relativePath: string, links: string[]) =>
    store.upsertDocument(
      {
        path: `/vault/${relativePath}`,
        relativePath,
        name: relativePath.split('/').pop() ?? relativePath,
        title: 'T',
        sizeBytes: 1,
        modifiedAtMs: 1,
        // 用路径当哈希，保证每篇互不相同
        contentHash: relativePath,
        body: 'body',
        links
      },
      1
    );

  it('按文件名找到反向链接', () => {
    put('dma.md', []);
    put('index.md', ['dma']);

    const target = store.getDocumentByPath('/vault/dma.md')!;
    expect(store.findBacklinks(target).map((doc) => doc.relativePath)).toEqual(['index.md']);
  });

  it('按相对路径也能找到 —— 与 resolveWikiLink 的口径一致', () => {
    put('notes/dma.md', []);
    put('index.md', ['notes/dma']);

    const target = store.getDocumentByPath('/vault/notes/dma.md')!;
    expect(store.findBacklinks(target).map((doc) => doc.relativePath)).toEqual(['index.md']);
  });

  it('不会把文档自己算成反向链接', () => {
    put('self.md', ['self']);

    const target = store.getDocumentByPath('/vault/self.md')!;
    expect(store.findBacklinks(target)).toEqual([]);
  });

  it('重新索引时旧的出链被清掉，而不是永远停在第一次的结果上', () => {
    put('dma.md', []);
    put('index.md', ['dma']);

    const before = store.getDocumentByPath('/vault/dma.md')!;
    expect(store.findBacklinks(before)).toHaveLength(1);

    // 改过之后不再链接 dma
    put('index.md', []);

    const after = store.getDocumentByPath('/vault/dma.md')!;
    expect(store.findBacklinks(after)).toEqual([]);
  });

  it('多个文档链接同一目标时都列出，按路径排序', () => {
    put('dma.md', []);
    put('b.md', ['dma']);
    put('a.md', ['dma']);

    const target = store.getDocumentByPath('/vault/dma.md')!;
    expect(store.findBacklinks(target).map((doc) => doc.relativePath)).toEqual(['a.md', 'b.md']);
  });

  it('没有反向链接时返回空数组', () => {
    put('lonely.md', []);

    const target = store.getDocumentByPath('/vault/lonely.md')!;
    expect(store.findBacklinks(target)).toEqual([]);
  });
});
