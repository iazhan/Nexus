// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { WikiLinkTarget } from '@nexus/core';
import { extractWikiLinkTargets } from '../electron/indexer.js';
import { IndexStore } from '../electron/index-store.js';
import { createTempDir } from './smoke-harness.js';

describe('出链提取', () => {
  it('提取 [[目标]]', () => {
    expect(extractWikiLinkTargets('参见 [[dma]]。')).toEqual([
      { target: 'dma', anchor: null }
    ]);
  });

  it('别名形式只取目标部分', () => {
    expect(extractWikiLinkTargets('参见 [[dma|DMA 那篇]]。')).toEqual([
      { target: 'dma', anchor: null }
    ]);
  });

  it('归一化：去掉 .md 并转小写', () => {
    expect(extractWikiLinkTargets('[[DMA.md]]')).toEqual([{ target: 'dma', anchor: null }]);
  });

  it('去重 —— 同一目标写多次只记一条', () => {
    expect(extractWikiLinkTargets('[[a]] 与 [[A]] 与 [[a.md]]')).toEqual([
      { target: 'a', anchor: null }
    ]);
  });

  it('保留路径形式的目标', () => {
    expect(extractWikiLinkTargets('[[notes/dma]]')).toEqual([
      { target: 'notes/dma', anchor: null }
    ]);
  });

  it('没有链接时返回空数组', () => {
    expect(extractWikiLinkTargets('普通文本，没有链接。')).toEqual([]);
  });

  it('空目标被忽略', () => {
    expect(extractWikiLinkTargets('[[]] 与 [[   ]]')).toEqual([]);
  });

  describe('锚点', () => {
    it('锚点从目标里切出来，单独带回', () => {
      expect(extractWikiLinkTargets('见 [[dma#性能]]。')).toEqual([
        { target: 'dma', anchor: '性能' }
      ]);
    });

    it('扩展名在锚点之前 —— 先切锚点再去 .md', () => {
      expect(extractWikiLinkTargets('[[DMA.md#性能]]')).toEqual([
        { target: 'dma', anchor: '性能' }
      ]);
    });

    it('同一目标写多个锚点时只留第一个（一条边只存一行）', () => {
      expect(extractWikiLinkTargets('[[dma#甲]] 与 [[dma#乙]]')).toEqual([
        { target: 'dma', anchor: '甲' }
      ]);
    });

    it('`[[#标题]]` 是文档内链接，不该进 links 表', () => {
      expect(extractWikiLinkTargets('见 [[#性能]]。')).toEqual([]);
    });

    it('CRLF 文件里同样认得出', () => {
      expect(extractWikiLinkTargets('见 [[dma#性能]]。\r\n再看 [[ethercat]]。\r\n')).toEqual([
        { target: 'dma', anchor: '性能' },
        { target: 'ethercat', anchor: null }
      ]);
    });
  });
});

describe('反向链接', () => {
  let dir: string;
  let store: IndexStore;

  beforeEach(() => {
    dir = createTempDir('nexus-backlink-');
    store = IndexStore.open(path.join(dir, 'index.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 字符串写法等价于「不带锚点」，让不关心锚点的用例保持一行。 */
  const toTarget = (link: string | WikiLinkTarget): WikiLinkTarget =>
    typeof link === 'string' ? { target: link, anchor: null } : link;

  const put = (relativePath: string, links: Array<string | WikiLinkTarget>) =>
    store.upsertDocument(
      {
        path: `/vault/${relativePath}`,
        relativePath,
        name: relativePath.split('/').pop() ?? relativePath,
        title: 'T',
        type: 'markdown',
        sizeBytes: 1,
        modifiedAtMs: 1,
        // 用路径当哈希，保证每篇互不相同
        contentHash: relativePath,
        body: 'body',
        links: links.map(toTarget),
        tags: []
      },
      1
    );

  const backlinksOf = (relativePath: string) => {
    const target = store.getDocumentByPath(`/vault/${relativePath}`)!;
    return store.findBacklinks(target).map((entry) => entry.document.relativePath);
  };

  it('按文件名找到反向链接', () => {
    put('dma.md', []);
    put('index.md', ['dma']);

    expect(backlinksOf('dma.md')).toEqual(['index.md']);
  });

  it('按相对路径也能找到 —— 与 resolveWikiLink 的口径一致', () => {
    put('notes/dma.md', []);
    put('index.md', ['notes/dma']);

    expect(backlinksOf('notes/dma.md')).toEqual(['index.md']);
  });

  it('不会把文档自己算成反向链接', () => {
    put('self.md', ['self']);

    const target = store.getDocumentByPath('/vault/self.md')!;
    expect(store.findBacklinks(target)).toEqual([]);
  });

  it('重新索引时旧的出链被清掉，而不是永远停在第一次的结果上', () => {
    put('dma.md', []);
    put('index.md', ['dma']);

    expect(backlinksOf('dma.md')).toEqual(['index.md']);

    // 改过之后不再链接 dma
    put('index.md', []);

    const after = store.getDocumentByPath('/vault/dma.md')!;
    expect(store.findBacklinks(after)).toEqual([]);
  });

  it('多个文档链接同一目标时都列出，按路径排序', () => {
    put('dma.md', []);
    put('b.md', ['dma']);
    put('a.md', ['dma']);

    expect(backlinksOf('dma.md')).toEqual(['a.md', 'b.md']);
  });

  it('没有反向链接时返回空数组', () => {
    put('lonely.md', []);

    const target = store.getDocumentByPath('/vault/lonely.md')!;
    expect(store.findBacklinks(target)).toEqual([]);
  });

  describe('锚点', () => {
    it('带锚点的引用照样算反向链接，且锚点被带回', () => {
      put('dma.md', []);
      put('index.md', [{ target: 'dma', anchor: '性能' }]);

      const target = store.getDocumentByPath('/vault/dma.md')!;
      expect(store.findBacklinks(target)).toEqual([
        { document: expect.objectContaining({ relativePath: 'index.md' }), anchor: '性能' }
      ]);
    });

    it('不带锚点的引用锚点是 null，而不是空串', () => {
      put('dma.md', []);
      put('index.md', ['dma']);

      const target = store.getDocumentByPath('/vault/dma.md')!;
      expect(store.findBacklinks(target)[0]!.anchor).toBeNull();
    });
  });
});
