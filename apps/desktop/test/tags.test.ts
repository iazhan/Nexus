// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IndexStore } from '../electron/index-store.js';
import { FileService } from '../electron/file-service.js';
import { indexWorkspace } from '../electron/indexer.js';
import { createTempDir } from './smoke-harness.js';

/**
 * `tags` 表的读写，以及**索引器往它里面写什么**。
 *
 * 扫描判据（哪些 `#` 算标签、代码块与 frontmatter 怎么处理）的用例在
 * `packages/core/test/tags.test.ts` —— 判据住在 core，编辑器高亮用的是同一份。
 * 这里只管「判据跑出来的结果有没有真的落进索引」。
 */

describe('标签索引', () => {
  let dir: string;
  let store: IndexStore;

  beforeEach(() => {
    dir = createTempDir('nexus-tags-');
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
        type: 'markdown',
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

describe('索引器写进 tags 表的内容', () => {
  let tempDir: string;
  let workspace: string;
  let service: FileService;
  let store: IndexStore;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-tags-index-'));
    workspace = path.join(tempDir, 'vault');
    await fsPromises.mkdir(workspace, { recursive: true });

    service = new FileService();
    await service.authorizeWorkspace(workspace);
    store = IndexStore.open(path.join(tempDir, 'index.db'));
  });

  afterEach(async () => {
    store.close();
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  const write = (relativePath: string, content: string) =>
    fsPromises.writeFile(path.join(workspace, relativePath), content);

  it('正文 inline 与 frontmatter 的标签合并成同一份（同名不裂成两项）', async () => {
    await write(
      'a.md',
      ['---', 'tags: [硬件, DMA]', '---', '', '正文 #ethercat 与 #dma'].join('\n')
    );

    await indexWorkspace({ service, store, rootPath: workspace });

    expect(store.listTags()).toEqual([
      { tag: 'dma', count: 1 },
      { tag: 'ethercat', count: 1 },
      { tag: '硬件', count: 1 }
    ]);
  });

  it('代码块里的 `#` 不进索引 —— 围栏与缩进两种写法', async () => {
    await write(
      'b.md',
      [
        '```c',
        '#include <stdio.h>',
        '#define MAX 8',
        '```',
        '',
        '    #include <a.h>',
        '',
        '#real'
      ].join('\n')
    );

    await indexWorkspace({ service, store, rootPath: workspace });

    expect(store.listTags()).toEqual([{ tag: 'real', count: 1 }]);
  });

  it('没有 frontmatter 的文档照常收正文标签', async () => {
    await write('c.md', '# 标题\n\n正文 #dma\n');

    await indexWorkspace({ service, store, rootPath: workspace });

    expect(store.listTags()).toEqual([{ tag: 'dma', count: 1 }]);
  });

  it('编号引用不进索引 —— `见 issue #123`', async () => {
    await write('d.md', '见 issue #123，正文 #dma\n');

    await indexWorkspace({ service, store, rootPath: workspace });

    expect(store.listTags()).toEqual([{ tag: 'dma', count: 1 }]);
  });
});
