// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractTags } from '../electron/indexer.js';
import { IndexStore } from '../electron/index-store.js';

describe('标签提取', () => {
  it('提取 #标签', () => {
    expect(extractTags('这是 #dma 相关。')).toEqual(['dma']);
  });

  it('归一化：转小写', () => {
    expect(extractTags('#DMA')).toEqual(['dma']);
  });

  it('ATX 标题不是标签 —— `#` 后面有空格', () => {
    expect(extractTags('# 一级标题')).toEqual([]);
    expect(extractTags('## 二级标题')).toEqual([]);
  });

  it('URL 片段不是标签 —— `#` 前面不是空白', () => {
    expect(extractTags('见 https://example.com/page#anchor')).toEqual([]);
  });

  it('行首的标签能识别', () => {
    expect(extractTags('#dma 开头的行')).toEqual(['dma']);
  });

  it('去掉粘在末尾的标点', () => {
    expect(extractTags('见 #dma，还有 #ethercat.')).toEqual(['dma', 'ethercat']);
  });

  it('去重（大小写归一后相同）', () => {
    expect(extractTags('#a 与 #A')).toEqual(['a']);
  });

  it('支持中文标签', () => {
    expect(extractTags('#电机控制')).toEqual(['电机控制']);
  });

  it('支持路径式标签', () => {
    expect(extractTags('#项目/nexus')).toEqual(['项目/nexus']);
  });

  it('没有标签时返回空数组', () => {
    expect(extractTags('普通文本，没有标签。')).toEqual([]);
  });
});

describe('标签索引', () => {
  let dir: string;
  let store: IndexStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tags-'));
    store = IndexStore.open(path.join(dir, 'index.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const put = (relativePath: string, tags: string[]) =>
    store.upsertDocument(
      {
        path: `/vault/${relativePath}`,
        relativePath,
        name: relativePath.split('/').pop() ?? relativePath,
        title: 'T',
        sizeBytes: 1,
        modifiedAtMs: 1,
        contentHash: relativePath,
        body: 'body',
        links: [],
        tags
      },
      1
    );

  it('列出标签及文档数，按标签名排序', () => {
    put('a.md', ['dma', 'ethercat']);
    put('b.md', ['dma']);

    expect(store.listTags()).toEqual([
      { tag: 'dma', count: 2 },
      { tag: 'ethercat', count: 1 }
    ]);
  });

  it('按标签找文档', () => {
    put('a.md', ['dma']);
    put('b.md', ['ethercat']);

    expect(store.findDocumentsByTag('dma').map((doc) => doc.relativePath)).toEqual(['a.md']);
  });

  it('查询时接受带 # 和大写 —— 入参归一化', () => {
    put('a.md', ['dma']);

    expect(store.findDocumentsByTag('#DMA')).toHaveLength(1);
    expect(store.findDocumentsByTag('dma')).toHaveLength(1);
  });

  it('空标签查询返回空数组', () => {
    put('a.md', ['dma']);
    expect(store.findDocumentsByTag('   ')).toEqual([]);
  });

  it('重新索引时旧标签被清掉', () => {
    put('a.md', ['old']);
    expect(store.findDocumentsByTag('old')).toHaveLength(1);

    put('a.md', ['new']);

    expect(store.findDocumentsByTag('old')).toEqual([]);
    expect(store.findDocumentsByTag('new')).toHaveLength(1);
  });

  it('多个文档带同一标签时都列出，按路径排序', () => {
    put('b.md', ['dma']);
    put('a.md', ['dma']);

    expect(store.findDocumentsByTag('dma').map((doc) => doc.relativePath)).toEqual([
      'a.md',
      'b.md'
    ]);
  });

  it('没有标签时返回空数组', () => {
    expect(store.listTags()).toEqual([]);
  });
});
