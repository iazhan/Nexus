import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileService } from '../electron/file-service.js';
import {
  IndexStore,
  buildMatchExpression,
  segmentForIndex
} from '../electron/index-store.js';
import { indexWorkspace } from '../electron/indexer.js';

/**
 * 工作区索引层（P2-05）。
 *
 * 两条主线：
 *   1. **中文能搜到** —— ADR-0002 实测过，两种内置分词器都处理不了中文 2 字词，
 *      所以这里对按字切分的实现有依赖，必须有测试兜住。
 *   2. **索引可重建** —— 这是蓝图 §18 对 Phase 2 的验收标准，也是最容易被
 *      「顺手加个只有索引知道的字段」破坏的不变量。
 */
describe('工作区索引', () => {
  let tempDir: string;
  let workspace: string;
  let dbPath: string;
  let service: FileService;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-index-'));
    workspace = path.join(tempDir, 'vault');
    await fsPromises.mkdir(workspace, { recursive: true });
    dbPath = path.join(tempDir, 'index.db');

    service = new FileService();
    await service.authorizeWorkspace(workspace);
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  const writeDoc = async (relativePath: string, content: string) => {
    const absolute = path.join(workspace, relativePath);
    await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
    await fsPromises.writeFile(absolute, content, 'utf-8');
    return absolute;
  };

  describe('按字切分与查询表达式', () => {
    it('每个汉字两侧补空格，英文与数字保持原样', () => {
      expect(segmentForIndex('EtherCAT 从站配置')).toBe('EtherCAT 从 站 配 置');
      expect(segmentForIndex('STM32 DMA')).toBe('STM32 DMA');
    });

    it('多字中文包成 phrase，单字与英文不加引号', () => {
      expect(buildMatchExpression('从站')).toBe('"从 站"');
      expect(buildMatchExpression('EtherCAT')).toBe('EtherCAT');
      expect(buildMatchExpression('   ')).toBeNull();
    });
  });

  describe('检索', () => {
    it('中文 2 字词能命中（unicode61 与 trigram 都做不到这件事）', async () => {
      await writeDoc('a.md', '记录 EtherCAT 从站的 PDO 映射与分布式时钟同步。');
      await writeDoc('b.md', 'DMA 控制器支持多通道传输，注意缓存一致性。');

      const store = IndexStore.open(dbPath);
      await indexWorkspace({ service, store, rootPath: workspace });

      expect(store.search('从站').map((hit) => hit.name)).toEqual(['a.md']);
      expect(store.search('时钟').map((hit) => hit.name)).toEqual(['a.md']);
      expect(store.search('缓存').map((hit) => hit.name)).toEqual(['b.md']);
      expect(store.search('EtherCAT').map((hit) => hit.name)).toEqual(['a.md']);

      store.close();
    });

    it('phrase 要求字符相邻，不会召回「字都在但不相邻」的文档', async () => {
      await writeDoc('apart.md', '从字和站字不相邻。');
      await writeDoc('together.md', '从站配置。');

      const store = IndexStore.open(dbPath);
      await indexWorkspace({ service, store, rootPath: workspace });

      expect(store.search('从站').map((hit) => hit.name)).toEqual(['together.md']);

      store.close();
    });

    it('不存在的词返回空，不误召回', async () => {
      await writeDoc('a.md', '普通内容。');

      const store = IndexStore.open(dbPath);
      await indexWorkspace({ service, store, rootPath: workspace });

      expect(store.search('完全不存在的词汇zzz')).toEqual([]);
      expect(store.search('   ')).toEqual([]);

      store.close();
    });

    it('文件名作为标题也能被搜到', async () => {
      await writeDoc('EtherCAT 笔记.md', '正文里没有那个词。');

      const store = IndexStore.open(dbPath);
      await indexWorkspace({ service, store, rootPath: workspace });

      const hits = store.search('笔记');
      expect(hits).toHaveLength(1);
      expect(hits[0]?.title).toBe('EtherCAT 笔记');

      store.close();
    });
  });

  describe('增量与清理', () => {
    it('内容未变的文档被跳过，改过的重新索引', async () => {
      await writeDoc('a.md', '原始内容。');
      await writeDoc('b.md', '另一篇。');

      const store = IndexStore.open(dbPath);

      const first = await indexWorkspace({ service, store, rootPath: workspace });
      expect(first).toMatchObject({ scanned: 2, indexed: 2, skipped: 0, removed: 0 });

      const second = await indexWorkspace({ service, store, rootPath: workspace });
      expect(second).toMatchObject({ scanned: 2, indexed: 0, skipped: 2, removed: 0 });

      await writeDoc('a.md', '改过的内容。');
      const third = await indexWorkspace({ service, store, rootPath: workspace });
      expect(third).toMatchObject({ scanned: 2, indexed: 1, skipped: 1, removed: 0 });

      store.close();
    });

    it('更新同一文档不会在全文索引里留下两份', async () => {
      const filePath = await writeDoc('a.md', '第一版内容。');

      const store = IndexStore.open(dbPath);
      await indexWorkspace({ service, store, rootPath: workspace });

      await fsPromises.writeFile(filePath, '第二版内容。', 'utf-8');
      await indexWorkspace({ service, store, rootPath: workspace });

      expect(store.getStats().documents).toBe(1);
      expect(store.search('第一版')).toEqual([]);
      expect(store.search('第二版')).toHaveLength(1);

      store.close();
    });

    it('磁盘上消失的文档会从索引里清掉', async () => {
      await writeDoc('keep.md', '留下。');
      const gone = await writeDoc('gone.md', '会被删掉。');

      const store = IndexStore.open(dbPath);
      await indexWorkspace({ service, store, rootPath: workspace });
      expect(store.getStats().documents).toBe(2);

      await fsPromises.unlink(gone);
      const result = await indexWorkspace({ service, store, rootPath: workspace });

      expect(result.removed).toBe(1);
      expect(store.listDocuments().map((doc) => doc.name)).toEqual(['keep.md']);
      expect(store.search('会被删掉')).toEqual([]);

      store.close();
    });

    it('扫描被截断时不清理任何记录', async () => {
      await writeDoc('a.md', '甲。');
      await writeDoc('b.md', '乙。');
      await writeDoc('c.md', '丙。');

      const store = IndexStore.open(dbPath);
      await indexWorkspace({ service, store, rootPath: workspace });
      expect(store.getStats().documents).toBe(3);

      // maxFiles=1 触发截断：只扫到一个文件，但另外两个还在磁盘上。
      // 没扫到 ≠ 不存在 —— 这时候清理索引会把另外两篇删掉。
      const truncated = await indexWorkspace({
        service,
        store,
        rootPath: workspace,
        scanOptions: { maxFiles: 1 }
      });

      expect(truncated.truncated).toBe(true);
      expect(truncated.removed).toBe(0);
      expect(store.getStats().documents).toBe(3);

      store.close();
    });
  });

  describe('可重建性（Phase 2 验收标准）', () => {
    it('删掉索引库后重新扫描，得到等价索引', async () => {
      await writeDoc('root.md', '# 根\n\nEtherCAT 从站。');
      await writeDoc('notes/a.md', '# A\n\n缓存一致性。');
      await writeDoc('notes/deep/b.markdown', '# B\n\n解耦。');

      const first = IndexStore.open(dbPath);
      await indexWorkspace({ service, store: first, rootPath: workspace });
      const before = first
        .listDocuments()
        .map((doc) => ({ path: doc.path, title: doc.title, hash: doc.contentHash }));
      const beforeHits = first.search('从站').map((hit) => hit.relativePath);
      first.close();

      // 删库 —— 索引是派生数据，这一步不该丢任何用户内容
      fs.unlinkSync(dbPath);

      const rebuilt = IndexStore.open(dbPath);
      await indexWorkspace({ service, store: rebuilt, rootPath: workspace });
      const after = rebuilt
        .listDocuments()
        .map((doc) => ({ path: doc.path, title: doc.title, hash: doc.contentHash }));

      expect(after).toEqual(before);
      expect(rebuilt.search('从站').map((hit) => hit.relativePath)).toEqual(beforeHits);

      rebuilt.close();
    });

    it('schema 版本不一致时旧库被整体重建', async () => {
      await writeDoc('a.md', '内容。');

      const store = IndexStore.open(dbPath);
      await indexWorkspace({ service, store, rootPath: workspace });
      expect(store.getStats().documents).toBe(1);
      store.close();

      // 把版本号改成旧值，模拟升级后的第一次打开
      const { Database } = await import('node-sqlite3-wasm');
      const raw = new Database(dbPath);
      raw.run(`UPDATE meta SET value = '0' WHERE key = 'schema_version'`);
      raw.close();

      const reopened = IndexStore.open(dbPath);

      // 表被整体丢掉重建 —— 索引是派生数据，丢的是可重建的东西，不是用户内容
      expect(reopened.getStats().documents).toBe(0);
      reopened.close();

      // 重新扫盘即可恢复
      const recovered = IndexStore.open(dbPath);
      await indexWorkspace({ service, store: recovered, rootPath: workspace });
      expect(recovered.getStats().documents).toBe(1);
      recovered.close();
    });
  });
});
