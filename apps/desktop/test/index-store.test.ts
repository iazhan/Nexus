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

  describe('附件进索引（Phase 3 / P3-04）', () => {
    it('附件进索引但不进全文检索', async () => {
      await writeDoc('note.md', '正文里提到 manual 这个词。');
      await writeDoc('manual.pdf', 'manual 也出现在附件的正文里');

      const store = IndexStore.open(dbPath);
      await indexWorkspace({ service, store, rootPath: workspace });

      expect(store.listDocuments().map((doc) => [doc.name, doc.type])).toEqual([
        ['manual.pdf', 'pdf'],
        ['note.md', 'markdown']
      ]);
      // 附件不写 FTS：`manual` 只命中 Markdown 正文。这条同时钉住了
      // 「附件标题没被塞进 FTS」—— 它的 title 也叫 manual。
      expect(store.search('manual').map((hit) => hit.name)).toEqual(['note.md']);

      store.close();
    });

    it('附件的类型与标题来自路径，元数据来自 stat', async () => {
      await writeDoc('assets/logo.png', 'PNG 占位内容');

      const store = IndexStore.open(dbPath);
      await indexWorkspace({ service, store, rootPath: workspace });

      const doc = store.listDocuments()[0]!;
      expect(doc.type).toBe('image');
      expect(doc.title).toBe('logo');
      expect(doc.sizeBytes).toBe(Buffer.byteLength('PNG 占位内容', 'utf-8'));
      // 附件指纹是 stat 指纹，不是内容 sha256 —— 见 core 的
      // attachmentContentFingerprint()：不读全文是有意的取舍。
      expect(doc.contentHash.startsWith('stat:')).toBe(true);

      store.close();
    });

    it('未变动的附件被跳过，改动后重新索引', async () => {
      const filePath = await writeDoc('assets/logo.png', '第一版');

      const store = IndexStore.open(dbPath);
      await indexWorkspace({ service, store, rootPath: workspace });
      const first = store.getDocumentByPath(filePath)!;

      // 内容与 mtime 都没变 → 跳过
      const second = await indexWorkspace({ service, store, rootPath: workspace });
      expect(second).toMatchObject({ scanned: 1, indexed: 0, skipped: 1 });

      // 重写会推进 mtime → 指纹变化 → 重新索引
      await fsPromises.writeFile(filePath, '第二版更长一些', 'utf-8');
      const third = await indexWorkspace({ service, store, rootPath: workspace });
      expect(third).toMatchObject({ scanned: 1, indexed: 1, skipped: 0 });

      expect(store.getDocumentByPath(filePath)!.contentHash).not.toBe(first.contentHash);

      store.close();
    });

    it('磁盘上消失的附件会被清掉', async () => {
      await writeDoc('keep.md', '留下。');
      const gone = await writeDoc('assets/gone.pdf', '会被删掉。');

      const store = IndexStore.open(dbPath);
      await indexWorkspace({ service, store, rootPath: workspace });
      expect(store.getStats().documents).toBe(2);

      await fsPromises.unlink(gone);
      const result = await indexWorkspace({ service, store, rootPath: workspace });

      expect(result.removed).toBe(1);
      expect(store.listDocuments().map((doc) => doc.name)).toEqual(['keep.md']);

      store.close();
    });

    it('`[[短名]]` 能命中同名的附件', async () => {
      await writeDoc('index.md', '见 [[stm32]]。');
      await writeDoc('stm32.pdf', 'PDF 占位');

      const store = IndexStore.open(dbPath);
      await indexWorkspace({ service, store, rootPath: workspace });

      const pdf = store.listDocuments().find((doc) => doc.name === 'stm32.pdf')!;
      expect(store.findBacklinks(pdf).map((doc) => doc.name)).toEqual(['index.md']);

      store.close();
    });

    it('同名共存时 `[[短名]]` 只归 Markdown，附件要写全名', async () => {
      await writeDoc('short.md', '短名：[[stm32]]。');
      await writeDoc('full.md', '全名：[[stm32.pdf]]。');
      await writeDoc('stm32.md', '笔记本体。');
      await writeDoc('stm32.pdf', 'PDF 占位');

      const store = IndexStore.open(dbPath);
      await indexWorkspace({ service, store, rootPath: workspace });

      const markdown = store.listDocuments().find((doc) => doc.name === 'stm32.md')!;
      const pdf = store.listDocuments().find((doc) => doc.name === 'stm32.pdf')!;

      // `[[stm32]]` 归 .md —— 与 resolveWikiLink 的候选顺序是同一套规则。
      // 反向链接侧没有「顺序」只有集合匹配，所以这条要靠 hasMarkdownTarget() 兜住。
      expect(store.findBacklinks(markdown).map((doc) => doc.name)).toEqual(['short.md']);
      // 附件不抢短名：只有写全名的那篇指向它
      expect(store.findBacklinks(pdf).map((doc) => doc.name)).toEqual(['full.md']);

      store.close();
    });

    it('图谱里附件的边按同一套口径连', async () => {
      await writeDoc('index.md', '见 [[manual]]。');
      await writeDoc('manual.pdf', 'PDF 占位');

      const store = IndexStore.open(dbPath);
      await indexWorkspace({ service, store, rootPath: workspace });

      const graph = store.getGraph();
      expect(graph.nodes).toHaveLength(2);
      expect(graph.edges).toHaveLength(1);
      expect(graph.nodes.every((node) => node.degree === 1)).toBe(true);

      store.close();
    });
  });

  describe('可重建性（Phase 2 验收标准）', () => {
    it('删掉索引库后重新扫描，得到等价索引', async () => {
      await writeDoc('root.md', '# 根\n\nEtherCAT 从站。');
      await writeDoc('notes/a.md', '# A\n\n缓存一致性。');
      await writeDoc('notes/deep/b.markdown', '# B\n\n解耦。');
      // Phase 3 / P3-04：附件也进索引。重建后它的**类型与元数据**必须等价恢复 ——
      // 这是 Phase 3 验收第 2 条。它同时是「附件指纹必须能从磁盘重算」的守卫：
      // 哪天改成读全文算哈希、或者顺手加一个只有索引才知道的字段，这条会先红。
      await writeDoc('assets/diagram.png', 'PNG 占位');
      await writeDoc('docs/manual.pdf', '%PDF-1.4 占位');

      // 快照带上 type 与 sizeBytes：只比 path + title + hash 的话，
      // 「附件被当成 Markdown 索引」这种错法照样能过。
      const snapshot = (store: IndexStore) =>
        store.listDocuments().map((doc) => ({
          path: doc.path,
          title: doc.title,
          type: doc.type,
          sizeBytes: doc.sizeBytes,
          hash: doc.contentHash
        }));

      const first = IndexStore.open(dbPath);
      await indexWorkspace({ service, store: first, rootPath: workspace });
      const before = snapshot(first);
      const beforeHits = first.search('从站').map((hit) => hit.relativePath);
      first.close();

      // 删库 —— 索引是派生数据，这一步不该丢任何用户内容
      fs.unlinkSync(dbPath);

      const rebuilt = IndexStore.open(dbPath);
      await indexWorkspace({ service, store: rebuilt, rootPath: workspace });
      const after = snapshot(rebuilt);

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
