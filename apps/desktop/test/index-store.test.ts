import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { createProcessorRegistry } from '../electron/processor/index.js';
import { createPdf } from './fixtures/documents.js';

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

  const writeDoc = async (relativePath: string, content: string | Buffer) => {
    const absolute = path.join(workspace, relativePath);
    await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
    await fsPromises.writeFile(absolute, content);
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
    it('冷索引与热索引都从一次文档快照比对路径，不逐文件查询数据库', async () => {
      await writeDoc('a.md', '甲。');
      await writeDoc('b.md', '乙。');
      await writeDoc('assets/one.png', 'png');

      const store = IndexStore.open(dbPath);
      const perPathLookup = vi.spyOn(store, 'getDocumentByPath');
      const batchUpsert = vi.spyOn(store, 'upsertDocuments');
      const singleUpsert = vi.spyOn(store, 'upsertDocument');

      const first = await indexWorkspace({ service, store, rootPath: workspace });
      expect(first).toMatchObject({ scanned: 3, indexed: 3, skipped: 0 });
      expect(perPathLookup).not.toHaveBeenCalled();
      expect(batchUpsert).toHaveBeenCalledTimes(1);
      expect(singleUpsert).not.toHaveBeenCalled();

      const second = await indexWorkspace({ service, store, rootPath: workspace });
      expect(second).toMatchObject({ scanned: 3, indexed: 0, skipped: 3 });
      expect(perPathLookup).not.toHaveBeenCalled();
      expect(batchUpsert).toHaveBeenCalledTimes(1);

      store.close();
    });

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

  describe('锁目录诊断', () => {
    it('SQLite 因锁目录无法打开时给出可行动的路径提示', async () => {
      await fsPromises.mkdir(`${dbPath}.lock`);

      expect(() => IndexStore.open(dbPath)).toThrow(/索引数据库锁目录已存在/);
      expect(() => IndexStore.open(dbPath)).toThrow(`${dbPath}.lock`);
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
      expect(store.findBacklinks(pdf).map((entry) => entry.document.name)).toEqual(['index.md']);

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
      expect(store.findBacklinks(markdown).map((entry) => entry.document.name)).toEqual(['short.md']);
      // 附件不抢短名：只有写全名的那篇指向它
      expect(store.findBacklinks(pdf).map((entry) => entry.document.name)).toEqual(['full.md']);

      store.close();
    });

    it('`[[目标#锚点]]` 照样连上边，锚点被带回', async () => {
      // 走的是「读文件 → 抽 links → 落库 → 查反向链接」整条链。只测 extractWikiLinkTargets
      // 抓不住「抽取对了但落库时又用回了带锚点的目标名」这类断层。
      await writeDoc('dma.md', 'DMA 主体。');
      await writeDoc('index.md', '见 [[dma#性能]]。');

      const store = IndexStore.open(dbPath);
      await indexWorkspace({ service, store, rootPath: workspace });

      const dma = store.listDocuments().find((doc) => doc.name === 'dma.md')!;
      const backlinks = store.findBacklinks(dma);
      expect(backlinks.map((entry) => entry.document.name)).toEqual(['index.md']);
      expect(backlinks[0]!.anchor).toBe('性能');

      // 图谱走的是同一张 links 表，所以这条边必须也连上 —— 改之前它和反向链接
      // 一起消失，而两处是两条独立的查询路径，只测一处会漏。
      expect(store.getGraph().edges).toHaveLength(1);

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

  /**
   * 图谱的范围裁剪与类型筛选。
   *
   * 两个口径必须一起守：**裁剪掉谁**（节点集合）与 **degree 怎么算**。
   * 后者最容易错：先按全量算 degree、再筛节点，就会得到「一个点很大却只连着一根线」——
   * 那看起来像漏画了边，而实际上是算错了大小。
   */
  describe('图谱的范围与筛选', () => {
    /*
      a 同时指向 b 与 lonely：于是从 b 出发走一跳时，lonely 是**二跳**邻居、必须在图外，
      而 a—lonely 那条边也必须跟着消失。没有这条边的话，「不留指向图外的线」这句断言
      是空的 —— 子图内部本来就没有通向图外的边。
    */
    const chain = async () => {
      await writeDoc('a.md', 'A → [[b]] 与 [[lonely]]');
      await writeDoc('b.md', 'B → [[c]]，附件 [[manual.pdf]]');
      await writeDoc('c.md', 'C 是终点。');
      await writeDoc('lonely.md', '谁也不链。');
      await writeDoc('manual.pdf', 'PDF 占位');
    };

    const openIndexed = async () => {
      const store = IndexStore.open(dbPath);
      await indexWorkspace({ service, store, rootPath: workspace });
      return store;
    };

    const names = (graph: { nodes: Array<{ name: string }> }) =>
      graph.nodes.map((node) => node.name).sort();

    it('按中心文档裁邻域：只留中心与一跳之内', async () => {
      await chain();
      const store = await openIndexed();

      const center = store.listDocuments().find((doc) => doc.name === 'b.md')!;
      const graph = store.getGraph({ centerPath: center.path, degrees: 1 });

      // b 一跳之内：a（指向它）、c（它指向的）、manual.pdf（它引用的）。
      // lonely 只有经过 a 才够得到（二跳），必须在图外。
      expect(names(graph)).toEqual(['a.md', 'b.md', 'c.md', 'manual.pdf']);
      // 子图内三条边：a—b、b—c、b—manual。
      // 而 a—lonely **不能**出现 —— 一端在图外的边要整条丢掉，否则画出来是一条通向空处的线。
      expect(graph.edges).toHaveLength(3);

      store.close();
    });

    it('degrees 覆盖整个连通分量时等于全图', async () => {
      // 反例：链式连通的 4 篇，从一端走 3 跳就够到全部。
      // 少了这条，BFS 少走一跳也能过上面那条「一跳之内」的用例。
      await writeDoc('n1.md', '[[n2]]');
      await writeDoc('n2.md', '[[n3]]');
      await writeDoc('n3.md', '[[n4]]');
      await writeDoc('n4.md', '终点。');

      const store = await openIndexed();
      const full = store.getGraph();
      const start = store.listDocuments().find((doc) => doc.name === 'n1.md')!;

      expect(names(store.getGraph({ centerPath: start.path, degrees: 3 }))).toEqual(names(full));
      expect(store.getGraph({ centerPath: start.path, degrees: 3 }).edges).toHaveLength(
        full.edges.length
      );

      store.close();
    });

    it('中心文档不在索引里时退回全图，而不是给一张空图', async () => {
      await chain();
      const store = await openIndexed();

      const full = store.getGraph();
      const fallback = store.getGraph({ centerPath: '/vault/还没建的.md', degrees: 1 });

      expect(names(fallback)).toEqual(names(full));

      store.close();
    });

    it('按类型筛选：被筛掉的节点与它的边一起消失', async () => {
      await chain();
      const store = await openIndexed();

      const graph = store.getGraph({ types: ['markdown'] });

      expect(names(graph)).toEqual(['a.md', 'b.md', 'c.md', 'lonely.md']);
      // 正反两面：只断言「附件没了」对「把笔记也一起筛掉」同样成立
      expect(graph.nodes.every((node) => node.type === 'markdown')).toBe(true);
      expect(graph.nodes.some((node) => node.name === 'b.md')).toBe(true);

      store.close();
    });

    it('degree 只数**返回的**边 —— 筛掉附件后引用它的笔记要跟着变小', async () => {
      await chain();
      const store = await openIndexed();

      const full = store.getGraph();
      const b = store.listDocuments().find((doc) => doc.name === 'b.md')!;
      const degreeOf = (graph: { nodes: Array<{ id: number; degree: number }> }) =>
        graph.nodes.find((node) => node.id === b.id)!.degree;

      // 全量下 b 连着 a、c 与 manual.pdf，三条
      expect(degreeOf(full)).toBe(3);
      // 筛掉附件后只剩 a 与 c —— 若 degree 仍按全量算，这里会是 3，节点画得比它的线多
      expect(degreeOf(store.getGraph({ types: ['markdown'] }))).toBe(2);

      store.close();
    });

    /**
     * 断链。它不再被丢掉，而是变成一个 `kind: 'missing'` 的节点。
     *
     * 丢掉是**静默消失**：用户看到某篇文档在图上什么也不连，以为它没有引用，
     * 而真相是它引用了一篇还没建的笔记。
     */
    describe('断链节点', () => {
      const missingOf = (graph: { nodes: Array<{ kind: string; name: string }> }) =>
        graph.nodes.filter((node) => node.kind === 'missing').map((node) => node.name).sort();

      it('指向不存在的文档时生成 missing 节点，边照画', async () => {
        await writeDoc('index.md', '见 [[还没写的方案]]。');

        const store = await openIndexed();
        const graph = store.getGraph();

        expect(missingOf(graph)).toEqual(['还没写的方案']);
        // 两个节点（index.md 与那个断链）、一条边
        expect(graph.nodes).toHaveLength(2);
        expect(graph.edges).toHaveLength(1);

        store.close();
      });

      it('missing 节点的 id 是合成且确定的，不会撞上真实文档 id', async () => {
        await writeDoc('index.md', '见 [[a-没建]] 与 [[b-没建]]。');

        const store = await openIndexed();
        const first = store.getGraph();
        const second = store.getGraph();

        // 同一份工作区两次取图必须完全一致 —— 否则布局会画出两种形状
        expect(first).toEqual(second);

        const documentIds = store.listDocuments().map((doc) => doc.id);
        for (const node of first.nodes.filter((item) => item.kind === 'missing')) {
          expect(documentIds).not.toContain(node.id);
        }
        // 目标名排序后依次编号，所以「a-没建」的 id 比「b-没建」小
        const byName = new Map(first.nodes.map((node) => [node.name, node.id]));
        expect(byName.get('a-没建')!).toBeLessThan(byName.get('b-没建')!);

        store.close();
      });

      it('degree 把断链算进去 —— 它确实连着一条边', async () => {
        await writeDoc('index.md', '见 [[还没写的方案]]。');

        const store = await openIndexed();
        const graph = store.getGraph();
        const index = graph.nodes.find((node) => node.name === 'index.md')!;
        const missing = graph.nodes.find((node) => node.kind === 'missing')!;

        expect(index.degree).toBe(1);
        expect(missing.degree).toBe(1);

        store.close();
      });

      it('来源被类型筛掉时，它的断链也跟着消失', async () => {
        // 来源不可见时那个点会变成悬空的 —— 用户看不出是谁引出来的
        await writeDoc('note.md', '见 [[还没写的方案]]。');
        await writeDoc('manual.pdf', 'PDF 占位');

        const store = await openIndexed();
        expect(missingOf(store.getGraph({ types: ['pdf'] }))).toEqual([]);
        // 正反两面：不过滤时它必须在
        expect(missingOf(store.getGraph())).toEqual(['还没写的方案']);

        store.close();
      });

      it('断链算一跳邻居 —— 从中心文档看得到「它引用了什么还没建的东西」', async () => {
        await writeDoc('a.md', '见 [[还没写的方案]]。');
        await writeDoc('b.md', '无关。');

        const store = await openIndexed();
        const a = store.listDocuments().find((doc) => doc.name === 'a.md')!;
        const graph = store.getGraph({ centerPath: a.path, degrees: 1 });

        expect(graph.nodes.map((node) => node.name).sort()).toEqual(['a.md', '还没写的方案']);

        store.close();
      });

      it('被类型筛掉的目标**不是**断链 —— 它明明存在，只是藏起来了', async () => {
        /*
          这条守的是一个很隐蔽的错法：用「筛过的那批文档」去建目标名映射时，
          `[[manual.pdf]]` 会解析不到任何文档，于是图上多出一个「还没创建」的红点。
          而那个附件就在那儿。「缺失」的含义是「整个工作区都没有这个目标」，
          不是「当前看不见」—— 所以映射必须用**全部**文档来建。
        */
        await writeDoc('note.md', '见 [[manual.pdf]]。');
        await writeDoc('manual.pdf', 'PDF 占位');

        const store = await openIndexed();

        expect(missingOf(store.getGraph({ types: ['markdown'] }))).toEqual([]);
        // 反向：真的没有这个目标时才算断链
        expect(missingOf(store.getGraph({ types: ['image'] }))).toEqual([]);
        expect(missingOf(store.getGraph())).toEqual([]);

        store.close();
      });

      it('有锚点的断链不把锚点带进节点名', async () => {
        // 归一化在抽取期就切掉了锚点，这里守的是「别把 `dma#性能` 当成要新建的文件名」
        await writeDoc('index.md', '见 [[还没写的方案#第三版]]。');

        const store = await openIndexed();
        expect(missingOf(store.getGraph())).toEqual(['还没写的方案']);

        store.close();
      });
    });

    /**
     * 孤儿与枢纽。
     *
     * 这一组的关键判据是**出度的口径**：数的是「**写下来的**链接」，
     * 解析不出来的目标也算。把它排除的话，一篇全是断链的文档会被报成孤儿 ——
     * 而那恰恰是最需要被看见的一类（用户以为它连着什么，其实什么都没连上）。
     */
    describe('孤儿与枢纽', () => {
      /*
        夹具的度数（人算的）：
                    out  in
        index.md      2   0
        a.md          1   0
        b.md          1   1
        hub.md        0   3
        lonely.md     0   0
        dead.md       1   0   ← 唯一那条链接指向不存在的文档
      */
      const fixture = async () => {
        await writeDoc('index.md', '[[hub]] 与 [[b]]');
        await writeDoc('a.md', '[[hub]]');
        await writeDoc('b.md', '[[hub]]');
        await writeDoc('hub.md', '枢纽，谁也不链。');
        await writeDoc('lonely.md', '谁也不链，也没人链。');
        await writeDoc('dead.md', '[[还没写的]]');
      };

      const names = (documents: Array<{ name: string }>) => documents.map((doc) => doc.name).sort();

      it('按文件名排序列出三种模式的孤儿', async () => {
        await fixture();
        const store = await openIndexed();

        // 没人引用：index / a / lonely / dead（hub 被三篇引用，b 被 index 引用）
        expect(names(store.getOrphans('incoming'))).toEqual([
          'a.md',
          'dead.md',
          'index.md',
          'lonely.md'
        ]);
        // 不引用别人：hub 与 lonely（dead 有一条链接，虽然指向空处）
        expect(names(store.getOrphans('outgoing'))).toEqual(['hub.md', 'lonely.md']);
        // 两者都缺只有 lonely
        expect(names(store.getOrphans('both'))).toEqual(['lonely.md']);

        store.close();
      });

      it('默认模式是 both', async () => {
        await fixture();
        const store = await openIndexed();

        expect(names(store.getOrphans())).toEqual(names(store.getOrphans('both')));

        store.close();
      });

      it('只有断链的文档**不算**出链为 0', async () => {
        await fixture();
        const store = await openIndexed();

        const outgoing = names(store.getOrphans('outgoing'));
        expect(outgoing).not.toContain('dead.md');
        // 反向：真正一条链接都没写的仍在名单里
        expect(outgoing).toContain('lonely.md');

        store.close();
      });

      it('自链接不算入度 —— 否则自己引用自己就不是孤儿了', async () => {
        await writeDoc('self.md', '[[self]]');
        const store = await openIndexed();

        expect(names(store.getOrphans('incoming'))).toEqual(['self.md']);

        store.close();
      });

      it('已删除文档留下的出链不算数', async () => {
        /*
          `removeDocuments()` 只删 `documents` 与 `search_fts`，**不删 `links`** ——
          表里会留下来源已经不在的行。不判来源是否存在的话，hub 会一直背着一条
          来自幽灵文档的入链，`getHubs` 的计数也就永远偏高。
        */
        await fixture();
        const store = await openIndexed();
        const hub = store.listDocuments().find((doc) => doc.name === 'hub.md')!;

        expect(store.getHubs().find((entry) => entry.document.id === hub.id)!.count).toBe(3);

        const a = store.listDocuments().find((doc) => doc.name === 'a.md')!;
        store.removeDocuments([a.path]);

        expect(store.getHubs().find((entry) => entry.document.id === hub.id)!.count).toBe(2);

        store.close();
      });

      it('枢纽按入链降序，同分按相对路径，且不含 0 入度的文档', async () => {
        await fixture();
        const store = await openIndexed();

        expect(store.getHubs().map((entry) => [entry.document.name, entry.count])).toEqual([
          ['hub.md', 3],
          ['b.md', 1]
        ]);
        // 0 入度的一律不进榜 —— 否则真正的枢纽会被一堆「没人引用」的文档挤下去
        expect(store.getHubs().some((entry) => entry.count === 0)).toBe(false);

        store.close();
      });

      it('limit 生效，且非法 limit 落回默认', async () => {
        await fixture();
        const store = await openIndexed();

        expect(store.getHubs(1).map((entry) => entry.document.name)).toEqual(['hub.md']);
        expect(store.getHubs(0)).toEqual([]);
        // NaN / 负数走默认值 20，而不是把列表清空
        expect(store.getHubs(Number.NaN)).toHaveLength(2);

        store.close();
      });

      it('空工作区两种查询都给空数组', async () => {
        const store = await openIndexed();

        expect(store.getOrphans('both')).toEqual([]);
        expect(store.getHubs()).toEqual([]);

        store.close();
      });
    });

    /**
     * 边的方向。
     *
     * 一条边一行，`mutual` 记住「两边都写了」—— 不拆成两条重合的线，那会把密处读成一团麻。
     * 这一组的关键是**别把「同方向的重复」误判成双向**。
     */
    describe('边的方向', () => {
      const edgeOf = (graph: { edges: Array<{ source: number; target: number; mutual: boolean }> }) =>
        graph.edges;

      it('单向：source → target，mutual 为假', async () => {
        await writeDoc('a.md', '[[b]]');
        await writeDoc('b.md', '终点。');

        const store = await openIndexed();
        const a = store.listDocuments().find((doc) => doc.name === 'a.md')!;
        const b = store.listDocuments().find((doc) => doc.name === 'b.md')!;

        expect(edgeOf(store.getGraph())).toEqual([
          { source: a.id, target: b.id, mutual: false }
        ]);

        store.close();
      });

      it('互引：仍然只有一条边，标成 mutual', async () => {
        await writeDoc('a.md', '[[b]]');
        await writeDoc('b.md', '[[a]]');

        const store = await openIndexed();
        const graph = store.getGraph();

        expect(graph.edges).toHaveLength(1);
        expect(graph.edges[0]!.mutual).toBe(true);

        store.close();
      });

      it('同方向的重复**不**算互引', async () => {
        /*
          一篇里写 `[[dma]]` 与 `[[notes/dma]]`，两条链接指向同一篇 —— 解析后是同一个
          (source, target) 对。按「这条边出现过第二次」判 mutual 的话，这里会画成双箭头，
          而实际上根本没有反向引用。
        */
        await writeDoc('notes/dma.md', 'DMA 主体。');
        await writeDoc('index.md', '见 [[dma]] 与 [[notes/dma]]。');

        const store = await openIndexed();
        const graph = store.getGraph();

        expect(graph.edges).toHaveLength(1);
        expect(graph.edges[0]!.mutual).toBe(false);

        store.close();
      });

      it('同一份工作区两次取图完全一致（朝向也一致）', async () => {
        // 朝向取决于哪一行先被扫到 —— 不加 ORDER BY 的话换个查询计划箭头就反了
        await writeDoc('a.md', '[[b]]');
        await writeDoc('b.md', '[[c]]');
        await writeDoc('c.md', '[[a]]');

        const store = await openIndexed();
        expect(store.getGraph()).toEqual(store.getGraph());

        store.close();
      });

      it('断链一律单向 —— 对面没有文档，不可能互引', async () => {
        await writeDoc('index.md', '[[还没写的]]');

        const store = await openIndexed();
        expect(store.getGraph().edges.every((edge) => edge.mutual === false)).toBe(true);

        store.close();
      });
    });

    it('范围与类型可以叠加', async () => {
      await chain();
      const store = await openIndexed();

      const center = store.listDocuments().find((doc) => doc.name === 'b.md')!;
      const graph = store.getGraph({
        centerPath: center.path,
        degrees: 1,
        types: ['markdown']
      });

      expect(names(graph)).toEqual(['a.md', 'b.md', 'c.md']);

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
      // Phase 3 / P3-10 把「附件元数据」扩展成了「元数据 + 提取状态」：被 Markdown
      // 引用过的 PDF 会被提取文本并进全文索引，重建后这些都必须等价恢复。
      // 计划 §9 第 2 条明确要求**扩展这个块**而不是另写一套「可重建性」测试 ——
      // 同一个不变量有两处断言时，只会改一处。
      await writeDoc('docs/datasheet.pdf', createPdf(['ZebraQuartz']));
      await writeDoc(
        'notes/引用.md',
        '见 [手册](../docs/datasheet.pdf) 与 ![](../assets/diagram.png)。'
      );

      // 快照带上 type / sizeBytes / extractionStatus：只比 path + title + hash 的话，
      // 「附件被当成 Markdown 索引」或「提取状态没恢复」这类错法照样能过。
      const snapshot = (store: IndexStore) =>
        store.listDocuments().map((doc) => ({
          path: doc.path,
          title: doc.title,
          type: doc.type,
          sizeBytes: doc.sizeBytes,
          hash: doc.contentHash,
          extractionStatus: doc.extractionStatus
        }));

      const processors = createProcessorRegistry();
      const first = IndexStore.open(dbPath);
      await indexWorkspace({ service, store: first, rootPath: workspace, processors });
      const before = snapshot(first);
      const beforeHits = first.search('从站').map((hit) => hit.relativePath);
      // `ZebraQuartz` 只出现在 PDF 的**正文**里（文件名是 datasheet，标题会进 FTS），
      // 所以这条命中只可能来自提取出的文本。
      const beforeExtractedHits = first.search('ZebraQuartz').map((hit) => hit.relativePath);
      expect(beforeExtractedHits).toEqual(['docs/datasheet.pdf']);
      expect(before.find((doc) => doc.path.endsWith('datasheet.pdf'))?.extractionStatus).toBe(
        'extracted'
      );
      // 没被任何笔记引用的 PDF 不提取 —— 计划 §10.1 决策 1
      expect(before.find((doc) => doc.path.endsWith('manual.pdf'))?.extractionStatus).toBe('none');
      first.close();

      // 删库 —— 索引是派生数据，这一步不该丢任何用户内容
      fs.unlinkSync(dbPath);

      const rebuilt = IndexStore.open(dbPath);
      await indexWorkspace({ service, store: rebuilt, rootPath: workspace, processors });
      const after = snapshot(rebuilt);

      expect(after).toEqual(before);
      expect(rebuilt.search('从站').map((hit) => hit.relativePath)).toEqual(beforeHits);
      expect(rebuilt.search('ZebraQuartz').map((hit) => hit.relativePath)).toEqual(
        beforeExtractedHits
      );

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
