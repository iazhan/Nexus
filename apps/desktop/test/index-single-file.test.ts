// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { IndexedDocument } from '@nexus/core';
import { FileService } from '../electron/file-service.js';
import { IndexStore } from '../electron/index-store.js';
import { indexSingleFile, indexWorkspace } from '../electron/indexer.js';

/**
 * `indexSingleFile` 与 `indexWorkspace` 的**对账**。
 *
 * 两条路是同一件事的两种触发方式：一个是「开工作区时全量扫一遍」，一个是「新建一个
 * 文件之后补它一条」。结果必须**一模一样**。
 *
 * ## 为什么判据只能是「逐字段相等」
 *
 * 两者的差别**不会报错**。单文件那条少算了 links，症状是「反向链接少了」；
 * 少算了 tags，症状是「标签面板少一项」；body 少算了，症状是「搜不到」——
 * 全都要等到有人真的用到才会被发现，而那时离改动已经过去很久。
 * 「看起来对」在这里没有意义：这份用例的价值就在于它对不出来时会红。
 *
 * 所以这里不比对「条数」这类弱判据，而是把两条路产出的**每一行、每一个链接、
 * 每一个标签、每一条检索命中**都摊开比。
 *
 * ## 为什么不用 Electron
 *
 * 这两条路都住在主进程的纯模块里（`file-service.ts` / `indexer.ts` 都不 import
 * electron），所以整个文件在 node 里跑完，不需要冷启动 —— 也就不会占用 desktop
 * 那套「一个文件只启动一次」的批次预算。
 */
describe('单文件索引与全量索引的对账', () => {
  let tempDir: string;
  let workspace: string;
  let service: FileService;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-index-single-'));
    workspace = path.join(tempDir, 'vault');
    await fsPromises.mkdir(workspace, { recursive: true });

    service = new FileService();
    await service.authorizeWorkspace(workspace);
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  const writeFile = async (relativePath: string, content: string | Buffer) => {
    const absolute = path.join(workspace, relativePath);
    await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
    await fsPromises.writeFile(absolute, content);
    return absolute;
  };

  /** 一份带 wikilink、标签、中文正文、子目录与一个附件的 fixture。 */
  const seedWorkspace = async (): Promise<string[]> => {
    const files = [
      await writeFile('root.md', '# 根文档\n\n指向 [[dma]]，标签 #硬件 #索引\n'),
      await writeFile('notes/dma.md', '# DMA\n\n控制器支持多通道传输 #硬件\n\n见 [[deep/a]]\n'),
      await writeFile('notes/deep/a.md', '# A\n\n回到 [[root]]，标签 #嵌入式\n'),
      // 附件：只记元数据，不进全文检索
      await writeFile('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    ];
    return files;
  };

  /** 只留能比的字段：`id` 是自增的，两条路的写入批次不同，它本来就不该相等。 */
  const normalize = (documents: readonly IndexedDocument[]) =>
    documents
      .map((document) => ({
        path: document.path,
        relativePath: document.relativePath,
        name: document.name,
        title: document.title,
        type: document.type,
        sizeBytes: document.sizeBytes,
        modifiedAtMs: document.modifiedAtMs,
        contentHash: document.contentHash,
        extractionStatus: document.extractionStatus
      }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const openStore = (name: string): IndexStore => IndexStore.open(path.join(tempDir, name));

  it('逐个文件索引的结果与全量索引逐字段相等（文档行 / 链接 / 标签 / 检索命中）', async () => {
    const files = await seedWorkspace();

    const fullStore = openStore('full.db');
    const singleStore = openStore('single.db');

    try {
      await indexWorkspace({ service, store: fullStore, rootPath: workspace });

      for (const filePath of files) {
        await indexSingleFile({ service, store: singleStore, rootPath: workspace, filePath });
      }

      // ① 文档行
      expect(normalize(singleStore.listDocuments())).toEqual(
        normalize(fullStore.listDocuments())
      );

      // ② 标签（含计数）
      expect(singleStore.listTags()).toEqual(fullStore.listTags());

      // ③ 反向链接 —— 走的是 links 表，单文件那条最容易漏掉它
      const dma = fullStore.listDocuments().find((d) => d.relativePath === 'notes/dma.md');
      expect(dma).toBeTruthy();
      const backlinksOf = (store: IndexStore) =>
        store
          .findBacklinks(store.listDocuments().find((d) => d.relativePath === 'notes/dma.md')!)
          .map((document) => document.relativePath)
          .sort();
      expect(backlinksOf(singleStore)).toEqual(backlinksOf(fullStore));

      // ④ 检索命中 —— 走的是 search_fts，body 少写一段这里就会少一条
      for (const query of ['多通道', 'DMA', '嵌入式', 'EtherCAT']) {
        const hitsOf = (store: IndexStore) =>
          store
            .search(query)
            .map((hit) => hit.relativePath)
            .sort();
        expect(hitsOf(singleStore)).toEqual(hitsOf(fullStore));
      }
    } finally {
      fullStore.close();
      singleStore.close();
    }
  });

  it('内容没变时再索引一次是空操作（跳过判据与全量那条同源）', async () => {
    const files = await seedWorkspace();
    const store = openStore('skip.db');

    try {
      for (const filePath of files) {
        await indexSingleFile({ service, store, rootPath: workspace, filePath });
      }
      const before = normalize(store.listDocuments());

      // 逐个再跑一遍：内容指纹没变，所以一行都不该被重写
      for (const filePath of files) {
        await indexSingleFile({ service, store, rootPath: workspace, filePath });
      }

      expect(normalize(store.listDocuments())).toEqual(before);
    } finally {
      store.close();
    }
  });

  it('新建的空文件能被单独索引进来 —— 这正是「新建之后马上搜得到」的那条路', async () => {
    const store = openStore('created.db');

    try {
      const created = await service.createFile(workspace, '周报');
      await indexSingleFile({ service, store, rootPath: workspace, filePath: created });

      const indexed = store.listDocuments();
      expect(indexed).toHaveLength(1);
      expect(indexed[0]!.relativePath).toBe('周报.md');
      expect(indexed[0]!.title).toBe('周报');
      expect(indexed[0]!.type).toBe('markdown');
      expect(indexed[0]!.sizeBytes).toBe(0);
    } finally {
      store.close();
    }
  });

  it('文件不在给定工作区根之下时拒绝 —— 相对路径算错会写进一条指向不存在的路径', async () => {
    // 第二个工作区，两个根都授权，但文件在 B 根里 —— 拿 A 根去描述它必须被拒。
    const other = path.join(tempDir, 'other');
    await fsPromises.mkdir(other, { recursive: true });
    const outside = path.join(other, 'note.md');
    await fsPromises.writeFile(outside, '# 别的工作区\n', 'utf-8');
    await service.authorizeWorkspace(other);

    const store = openStore('boundary.db');
    try {
      await expect(
        indexSingleFile({ service, store, rootPath: workspace, filePath: outside })
      ).rejects.toThrow(/不在给定的工作区根之下/);
      expect(store.listDocuments()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
