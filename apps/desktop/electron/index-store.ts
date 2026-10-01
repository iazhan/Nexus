import { Database } from 'node-sqlite3-wasm';
import fs from 'node:fs';
import type {
  DocumentType,
  ExtractionStatus,
  GraphEdge,
  IndexedDocument,
  SearchHit,
  WorkspaceGraph
} from '@nexus/core';

/**
 * 工作区索引的存储层。
 *
 * ## 为什么是 WebAssembly 版 SQLite
 *
 * 见 `docs/adr/0002-local-index-storage.md`。一句话：Electron 34 内置 Node 20.19.1，
 * 没有 `node:sqlite`；本机没有 MSVC，而 `better-sqlite3` v13 不提供预编译二进制。
 * 所以选了零编译的 `node-sqlite3-wasm`。
 *
 * ## 索引是派生数据
 *
 * 这个库里**不允许**存在只有它才知道的事实。删掉 .db 文件之后，扫一遍工作区必须能
 * 重建出等价索引。schema 变更时因此直接**丢表重建**而不是写迁移脚本 —— 重建成本
 * 是几秒钟的扫盘，而迁移脚本会长期背着「派生数据的格式」这个不该背的包袱。
 *
 * ## 中文检索
 *
 * 写入和查询都走 `segmentForIndex()` 按字切分，原因见该函数的注释。
 */

/**
 * schema 版本。改表结构、或改**任何会改变派生内容**的抽取判据，都要 +1 —— 旧库会被整个重建。
 *
 * v4（Phase 3 / P3-04）：`documents` 加 `type` 列，附件开始进索引。
 * v5（Phase 3 / P3-10）：`documents` 加 `extraction_status` 列，被 Markdown 引用过的
 * PDF / DOCX 提取出的文本开始进 FTS。
 * v6（0.55.0）：标签抽取判据收紧 —— 代码块 / 行内代码 / frontmatter 里的 `#` 不算标签，
 * 且纯数字不算（`#1984` 无效）。**表结构一个字没改**，但 `tags` 表的内容变了，而
 * 「内容没变就跳过」的判据（`contentHash`）会让那些文件永远留着重扫前的旧标签 ——
 * 只有版本号能把它们逼出来。这就是「改判据也要 +1」的原因。
 * v7（0.55.1）：v6 只跳过了**行首围栏**，于是 `    #include <stdio.h>` 这类缩进代码块、
 * 以及列表项 / 引用块里的代码块照旧被收成标签。同样是派生内容变了，同样要 +1。
 * 注意这里**没有迁移脚本** —— 索引是派生数据，重建成本是几秒扫盘，
 * 而迁移脚本会长期背着「派生数据的格式」这个不该背的包袱（见文件头注释）。
 * 所以「schema v7 的 migration」在本项目里的含义就是「把版本号改掉」。
 */
const SCHEMA_VERSION = '7';

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS documents (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     path TEXT NOT NULL UNIQUE,
     relative_path TEXT NOT NULL,
     name TEXT NOT NULL,
     title TEXT NOT NULL,
     -- 文档类型（Phase 3 / P3-04）。**派生自 path**，不是独立事实 —— 存它是为了让
     -- 「只要 Markdown」这类过滤能在 SQL 层完成，而不是把全表拉进内存再筛。
     type TEXT NOT NULL DEFAULT 'markdown',
     size_bytes INTEGER NOT NULL DEFAULT 0,
     modified_at_ms INTEGER NOT NULL DEFAULT 0,
     content_hash TEXT NOT NULL,
     -- 文本提取状态（Phase 3 / P3-10）。**派生自「文件内容 + 它有没有被引用」**，
     -- 同样是可重建的：删库重建必然得到同一个值。取值见 ExtractionStatus。
     --
     -- 默认 'none' 同时承担两个语义：「没有处理器认领这个类型」（图片、Markdown）
     -- 与「这一轮它没被引用」。两者在界面上都不显示任何提示，所以不必再区分。
     extraction_status TEXT NOT NULL DEFAULT 'none',
     indexed_at_ms INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_documents_relative_path ON documents(relative_path)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type)`,
  // FTS5 虚表自带 rowid，这里让它等于 documents.id，查询时 join 回去。
  // 正文存的是**切分后**的文本，见 segmentForIndex()。
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
     title,
     body,
     tokenize='unicode61'
   )`,
  // 反向链接：某篇文档里出现了哪些 wikilink 目标。
  //
  // 存的是**归一化后的目标名**（去掉 `.md`、转小写），不是解析出来的 document id ——
  // 链接指向的文档可能在链接写完之后才被创建，存 id 就意味着每次新增文件都要重建索引。
  // 代价是查询时要拿当前文档的路径/文件名去比对，见 findBacklinks()。
  `CREATE TABLE IF NOT EXISTS links (
     source_id INTEGER NOT NULL,
     target TEXT NOT NULL,
     PRIMARY KEY (source_id, target)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_links_target ON links(target)`,
  // 标签。与 links 同构：只存「哪篇文档有哪个标签」，标签本身不是实体。
  //
  // 标签在索引器里已经归一化（去掉前导 `#`、转小写）—— 与 links 同样的理由：
  // 归一化只做一次，查询端只做等值比较。
  `CREATE TABLE IF NOT EXISTS tags (
     source_id INTEGER NOT NULL,
     tag TEXT NOT NULL,
     PRIMARY KEY (source_id, tag)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag)`
];

/** 重建时要按依赖顺序丢掉的表。 */
const DROP_STATEMENTS = [
  `DROP TABLE IF EXISTS tags`,
  `DROP TABLE IF EXISTS links`,
  `DROP TABLE IF EXISTS search_fts`,
  `DROP TABLE IF EXISTS documents`,
  `DROP TABLE IF EXISTS meta`
];

/** 写入一篇文档所需的全部字段。 */
export interface UpsertDocumentInput {
  path: string;
  relativePath: string;
  name: string;
  /** 文档类型。决定这篇文档要不要进全文索引，见 `upsertDocument`。 */
  type: DocumentType;
  title: string;
  sizeBytes: number;
  modifiedAtMs: number;
  contentHash: string;
  /**
   * 原始正文（未切分）；切分在本层内部完成。
   *
   * **附件传空串** —— 附件不进全文检索，正文从不参与查询。这里用空串而不是
   * 可选字段，是为了让「Markdown 必须给正文」在类型上不可省略：漏传会变成
   * 索引里一篇搜不到的空文档，而那要等到用户搜不到东西才会被发现。
   */
  body: string;
  /**
   * 本文档里的 wikilink 目标，**已归一化**（去掉 `.md`、转小写）。
   *
   * 归一化放在索引器里做，存进来的必须已经是这个形式 —— 查询端
   * （`findBacklinks`）只做等值比较，两边各归一化一次迟早不一致。
   */
  links: string[];
  /**
   * 本文档里的标签，**已归一化**（去掉前导 `#`、转小写）。
   *
   * 与 `links` 同理：归一化只做一次。
   */
  tags: string[];
}

export interface IndexStats {
  documents: number;
}

/**
 * 按汉字切分：每个 CJK 字符两侧补空格，英文与数字保持原样。
 *
 * ```
 * EtherCAT 从站配置 → EtherCAT 从 站 配 置
 * ```
 *
 * **必须这么做**（ADR-0002 实测数据）：
 *   - `unicode61` 把连续 CJK 当成**一个 token** → `从站配置` 能命中，`从站` 命中 0 条；
 *   - `trigram` 的索引就是 3-gram → **查询词少于 3 字符无法匹配**，`从站`/`时钟`/`解耦` 全落空。
 * 中文词汇绝大多数是 2 字词，这两种内置分词器都不可用。
 */
export function segmentForIndex(text: string): string {
  return text
    .replace(/([\u4e00-\u9fff\u3400-\u4dbf])/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把用户输入的查询串转成 FTS5 的 MATCH 表达式；空查询返回 null。
 *
 * 多字中文必须包成 phrase（`"从 站"`）而不是 `从 站`：后者在 FTS5 里是 AND，
 * 顺序无关、还能跨词匹配，会把「从…站」这种不相邻的情况也召回。
 * phrase 的相邻性有负向验证兜底（见 index-store 的单测）。
 */
export function buildMatchExpression(rawQuery: string): string | null {
  const trimmed = rawQuery.trim();
  if (trimmed.length === 0) return null;

  const segmented = segmentForIndex(trimmed);
  if (segmented.length === 0) return null;

  const hasCjk = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(trimmed);
  if (hasCjk && segmented.includes(' ')) {
    return `"${segmented.replace(/"/g, '""')}"`;
  }
  return segmented;
}

/**
 * 索引库。持有底层 SQLite 连接，不负责扫盘与解析（那是 indexer 的事）。
 */
export class IndexStore {
  private readonly db: Database;
  readonly dbPath: string;

  private constructor(db: Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  /** 打开（或创建）索引库，并确保 schema 是当前版本。 */
  static open(dbPath: string): IndexStore {
    let db: Database | null = null;
    try {
      db = new Database(dbPath);
      const store = new IndexStore(db, dbPath);
      store.ensureSchema();
      return store;
    } catch (err) {
      db?.close();
      const lockPath = `${dbPath}.lock`;
      let lockDirectoryExists = false;
      try {
        lockDirectoryExists = fs.statSync(lockPath).isDirectory();
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
      }
      if (lockDirectoryExists && /locked|busy/i.test(err instanceof Error ? err.message : String(err))) {
        throw new Error(
          `索引数据库锁目录已存在，可能被另一个 Nexus 实例使用，也可能是上次异常退出留下的残留：${lockPath}。关闭所有 Nexus 实例后再检查该目录。`,
          { cause: err }
        );
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  /** schema 版本不一致就把所有表丢掉重建 —— 索引是派生数据，重建比迁移划算。 */
  private ensureSchema(): void {
    const existingVersion = this.readSchemaVersion();

    if (existingVersion !== null && existingVersion !== SCHEMA_VERSION) {
      for (const statement of DROP_STATEMENTS) {
        this.db.exec(statement);
      }
    }

    for (const statement of SCHEMA_STATEMENTS) {
      this.db.exec(statement);
    }

    this.db.run(`INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)`, [
      SCHEMA_VERSION
    ]);
  }

  private readSchemaVersion(): string | null {
    try {
      const row = this.db.get(`SELECT value FROM meta WHERE key = 'schema_version'`);
      return row && typeof row.value === 'string' ? row.value : null;
    } catch {
      // meta 表还不存在 = 全新库
      return null;
    }
  }

  getDocumentByPath(filePath: string): IndexedDocument | null {
    const row = this.db.get(
      `SELECT id, path, relative_path, name, title, type, size_bytes, modified_at_ms,
              content_hash, extraction_status
         FROM documents WHERE path = ?`,
      [filePath]
    );
    return row ? mapDocument(row) : null;
  }

  /** 按相对路径排序的全部文档 —— 供 Quick Open 之类的扁平列表使用。 */
  listDocuments(): IndexedDocument[] {
    const rows = this.db.all(
      `SELECT id, path, relative_path, name, title, type, size_bytes, modified_at_ms,
              content_hash, extraction_status
         FROM documents ORDER BY relative_path`
    );
    return rows.map(mapDocument);
  }

  /**
   * 文档改名后**就地**改它那一行，`id` 保持不变。
   *
   * ## 为什么不能用 `upsertDocument()`
   *
   * 那个函数的冲突判据是 `ON CONFLICT(path)`。路径变了它就不冲突 —— 于是它**插一行新的**，
   * 旧行留在原地，而 `links.source_id` / `tags.source_id` 指向的是旧行。结果是反向链接与
   * 图谱边一起丢，且没有任何报错。
   *
   * ## 为什么不能「删了重建」
   *
   * `removeDocuments()` 只删 `documents` 与 `search_fts`，**不删 `links` / `tags`**
   * （见那里的实现）—— 同样留下孤儿行，还多付一次重建。
   *
   * ## 刻意不动的列
   *
   * `type` / `size_bytes` / `modified_at_ms` / `content_hash` / `extraction_status`
   * 一个都不动：改名不改内容。附件的提取缓存按内容哈希走，改名不该让它失效。
   *
   * @returns 是否真的更新了一行 —— 索引里没有这篇文档时返回 `false`（索引还没建过，
   *   或它本来就没被索引），调用方据此判断要不要顺带补一次索引。
   */
  renameDocument(
    oldPath: string,
    newPath: string,
    newRelativePath: string,
    newName: string,
    newTitle: string
  ): boolean {
    const row = this.db.get(`SELECT id FROM documents WHERE path = ?`, [oldPath]);
    const documentId = Number(row?.id ?? 0);
    if (documentId <= 0) return false;

    this.db.run(
      `UPDATE documents SET path = ?, relative_path = ?, name = ?, title = ? WHERE id = ?`,
      [newPath, newRelativePath, newName, newTitle, documentId]
    );
    return true;
  }

  /**
   * 写入或更新一篇文档。
   *
   * 同一事务里替换 FTS 行：先删旧的再插新的，避免同一文档留下两份索引。
   * 附件（非 Markdown）只写元数据，不碰 FTS —— 它没有可检索正文。
   */
  upsertDocument(input: UpsertDocumentInput, nowMs: number): number {
    return this.upsertDocuments([input], nowMs)[0] ?? 0;
  }

  /**
   * 在单个事务中写入一批变更文档，减少 wasm VFS 反复获取和释放目录锁的开销。
   */
  upsertDocuments(inputs: UpsertDocumentInput[], nowMs: number): number[] {
    if (inputs.length === 0) return [];

    this.db.exec('BEGIN');
    try {
      const ids = inputs.map((input) => this.upsertDocumentInTransaction(input, nowMs));
      this.db.exec('COMMIT');
      return ids;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 写入单篇文档，不管理事务；调用方负责批次提交或回滚。 */
  private upsertDocumentInTransaction(input: UpsertDocumentInput, nowMs: number): number {
    this.db.run(
      `INSERT INTO documents(path, relative_path, name, title, type, size_bytes, modified_at_ms, content_hash, indexed_at_ms)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         relative_path = excluded.relative_path,
         name = excluded.name,
         title = excluded.title,
         type = excluded.type,
         size_bytes = excluded.size_bytes,
         modified_at_ms = excluded.modified_at_ms,
         content_hash = excluded.content_hash,
         extraction_status = 'none',
         indexed_at_ms = excluded.indexed_at_ms`,
      [
        input.path,
        input.relativePath,
        input.name,
        input.title,
        input.type,
        input.sizeBytes,
        input.modifiedAtMs,
        input.contentHash,
        nowMs
      ]
    );

    const row = this.db.get(`SELECT id FROM documents WHERE path = ?`, [input.path]);
    const documentId = Number(row?.id ?? 0);
    if (documentId <= 0) throw new Error(`写入文档后拿不到 id: ${input.path}`);

    this.db.run(`DELETE FROM search_fts WHERE rowid = ?`, [documentId]);
    this.db.run(`DELETE FROM links WHERE source_id = ?`, [documentId]);
    this.db.run(`DELETE FROM tags WHERE source_id = ?`, [documentId]);

    if (input.type === 'markdown') {
      this.db.run(`INSERT INTO search_fts(rowid, title, body) VALUES(?, ?, ?)`, [
        documentId,
        segmentForIndex(input.title),
        segmentForIndex(input.body)
      ]);

      for (const target of input.links) {
        this.db.run(`INSERT OR IGNORE INTO links(source_id, target) VALUES(?, ?)`, [
          documentId,
          target
        ]);
      }

      for (const tag of input.tags) {
        this.db.run(`INSERT OR IGNORE INTO tags(source_id, tag) VALUES(?, ?)`, [documentId, tag]);
      }
    }

    return documentId;
  }

  /** 删除一批文档及其全文索引，返回实际删掉的行数。 */
  removeDocuments(filePaths: string[]): number {
    if (filePaths.length === 0) return 0;

    this.db.exec('BEGIN');
    try {
      let removed = 0;
      for (const filePath of filePaths) {
        const row = this.db.get(`SELECT id FROM documents WHERE path = ?`, [filePath]);
        const documentId = Number(row?.id ?? 0);
        if (documentId <= 0) continue;
        this.db.run(`DELETE FROM search_fts WHERE rowid = ?`, [documentId]);
        this.db.run(`DELETE FROM documents WHERE id = ?`, [documentId]);
        removed += 1;
      }
      this.db.exec('COMMIT');
      return removed;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * 全文检索。空查询返回空数组（而不是全部文档）。
   */
  search(query: string, limit = 50): SearchHit[] {
    const matchExpression = buildMatchExpression(query);
    if (matchExpression === null) return [];

    const rows = this.db.all(
      `SELECT d.id AS id, d.path AS path, d.relative_path AS relative_path,
              d.name AS name, d.title AS title, d.type AS type,
              d.extraction_status AS extraction_status
         FROM search_fts f
         JOIN documents d ON d.id = f.rowid
        WHERE search_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
      [matchExpression, limit]
    );

    return rows.map((row) => ({
      documentId: Number(row.id),
      path: String(row.path),
      relativePath: String(row.relative_path),
      name: String(row.name),
      title: String(row.title),
      type: readDocumentType(row.type),
      extractionStatus: readExtractionStatus(row.extraction_status)
    }));
  }

  /**
   * 写入（或清掉）一份附件的**文本提取结果**（Phase 3 / P3-10）。
   *
   * ## 为什么是一个独立方法，而不是 `upsertDocument` 的一个字段
   *
   * 两者的触发条件**不同**。`upsertDocument` 只在内容指纹变了时才跑；而提取结果
   * 会因为「一篇 Markdown 开始引用这个附件」而变化 —— 那时附件自己的指纹**一个字
   * 都没变**，`upsertDocument` 根本不会被调用。把提取结果塞进 upsert 的入参里，
   * 就会出现「明明引用了却一直没被提取」这种只在第二次索引才显形的问题。
   *
   * ## 幂等
   *
   * 反复写同一个结果不会产生第二行 FTS —— 先删后插，与 `upsertDocument` 同一条口径。
   * `status` 传 `'none'` 时只清 FTS 与状态，不插空行：FTS 里存一条空正文没有意义，
   * 还会让「搜得到但打开什么都没有」成为可能。
   */
  setExtraction(
    filePath: string,
    result: { status: ExtractionStatus; text: string }
  ): void {
    const row = this.db.get(`SELECT id, title FROM documents WHERE path = ?`, [filePath]);
    const documentId = Number(row?.id ?? 0);
    if (documentId <= 0) return;

    this.db.exec('BEGIN');
    try {
      this.db.run(`UPDATE documents SET extraction_status = ? WHERE id = ?`, [
        result.status,
        documentId
      ]);

      // 先删后插：与 upsertDocument 同一条口径，避免同一文档留下两份 FTS 行
      this.db.run(`DELETE FROM search_fts WHERE rowid = ?`, [documentId]);

      if (result.status === 'extracted' && result.text.length > 0) {
        // 标题照常切分 —— 中文 PDF 的标题多半也是中文，不切就搜不到
        this.db.run(`INSERT INTO search_fts(rowid, title, body) VALUES(?, ?, ?)`, [
          documentId,
          segmentForIndex(String(row?.title ?? '')),
          segmentForIndex(result.text)
        ]);
      }

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * 从工作区里挑出**被 Markdown 引用过的附件**（Phase 3 / P3-10）。
   *
   * ## 为什么「被引用」才提取
   *
   * 计划 §10.1 决策 1：只索引被引用过的附件，索引体积与重建时间可控 ——
   * P2 的「重建只要几秒」基线得以保住。一个 3000 张图 + 200 份手册的工作区里，
   * 大部分附件从没被任何笔记引用过，给它们做全文索引是纯白付的代价。
   *
   * ## 两条匹配口径，都是**复用**而不是重写
   *
   * - **路径式引用**（`![](a.png)` / `[x](a.pdf)`）：直接比对工作区相对路径，
   *   大小写不敏感。
   * - **名字式引用**（`[[stm32.pdf]]`）：走 `backlinkTargetsOf()` —— 与反向链接
   *   面板**同一个**函数。这一点是刻意的：如果这里另写一套候选规则，就会出现
   *   「反向链接面板说指到了、索引说没指到」（或反过来），而两边单独看都对。
   *   顺带，同名 Markdown 抢走短名的那条规则（`[[stm32]]` 归 `stm32.md`）
   *   也一并生效，不会把 `stm32.pdf` 误判成被引用。
   */
  findReferencedAttachments(references: {
    paths: ReadonlySet<string>;
    wikilinkTargets: ReadonlySet<string>;
  }): IndexedDocument[] {
    const referenced: IndexedDocument[] = [];

    for (const document of this.listDocuments()) {
      if (document.type === 'markdown') continue;

      if (references.paths.has(document.relativePath.toLowerCase())) {
        referenced.push(document);
        continue;
      }

      if (this.backlinkTargetsOf(document).some((target) => references.wikilinkTargets.has(target))) {
        referenced.push(document);
      }
    }

    return referenced;
  }

  /**
   * 找出所有链接到这篇文档的文档（反向链接）。
   *
   * 匹配口径必须与 `resolveWikiLink` 一致：那边是「先按相对路径、再按文件名」，
   * 都大小写不敏感。两处口径不一致的话，能跳转的链接反而查不到反向链接 ——
   * 那种不一致极难被发现，因为两边单独看都对。
   */
  findBacklinks(document: IndexedDocument): IndexedDocument[] {
    const targets = this.backlinkTargetsOf(document);
    const placeholders = targets.map(() => '?').join(', ');

    const rows = this.db.all(
      `SELECT DISTINCT d.id, d.path, d.relative_path, d.name, d.title, d.type,
              d.size_bytes, d.modified_at_ms, d.content_hash, d.extraction_status
         FROM links l
         JOIN documents d ON d.id = l.source_id
        WHERE l.target IN (${placeholders})
          AND d.id != ?
        ORDER BY d.relative_path`,
      [...targets, document.id]
    );

    return rows.map(mapDocument);
  }

  /**
   * 列出所有标签及其文档数，按标签名排序。
   *
   * 计数在 SQL 里做：拉到内存再统计的话，标签一多就要白读一遍 documents。
   */
  listTags(): Array<{ tag: string; count: number }> {
    const rows = this.db.all(
      `SELECT tag, COUNT(*) AS count FROM tags GROUP BY tag ORDER BY tag`
    );

    return rows.map((row) => ({ tag: String(row.tag), count: Number(row.count ?? 0) }));
  }

  /**
   * 带某个标签的文档，按相对路径排序。
   *
   * 这里的归一化是**入参归一化**（用户可能传 `#Tag`），不是存储归一化 ——
   * 库里存的已经统一过了，见 `UpsertDocumentInput.tags` 的说明。
   */
  findDocumentsByTag(tag: string): IndexedDocument[] {
    const normalized = tag.trim().toLowerCase().replace(/^#/, '');
    if (!normalized) return [];

    const rows = this.db.all(
      `SELECT DISTINCT d.id, d.path, d.relative_path, d.name, d.title, d.type,
              d.size_bytes, d.modified_at_ms, d.content_hash, d.extraction_status
         FROM tags t
         JOIN documents d ON d.id = t.source_id
        WHERE t.tag = ?
        ORDER BY d.relative_path`,
      [normalized]
    );

    return rows.map(mapDocument);
  }

  /**
   * 整个工作区的链接图：节点是文档，边是 wikilink。
   *
   * ## 边按**无向**合并
   *
   * `A → B` 与 `B → A` 只留一条。图谱是给人看全局形状的，双向箭头会把图读成一团麻；
   * 「谁引用谁」在单篇文档的反向链接面板里已经有了。
   *
   * ## 目标名到文档的映射只取第一个
   *
   * 同名文件落在不同目录时（`notes/dma.md` 与 `archive/dma.md`），
   * `[[dma]]` 该指向哪一篇是有歧义的（`resolveWikiLink` 会返回 ambiguous）。
   * 图谱不做歧义提示 —— 那属于跳转时的决策，这里是概览。
   */
  getGraph(): WorkspaceGraph {
    const documents = this.listDocuments();

    // 目标名 → 文档 id。口径与 resolveWikiLink / findBacklinks 一致：
    // 相对路径或文件名，都去掉 `.md` 并转小写。
    const byTarget = new Map<string, number>();
    for (const document of documents) {
      for (const key of this.backlinkTargetsOf(document)) {
        if (!byTarget.has(key)) byTarget.set(key, document.id);
      }
    }

    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    const degree = new Map<number, number>();

    for (const row of this.db.all(`SELECT source_id, target FROM links`)) {
      const source = Number(row.source_id);
      const target = byTarget.get(String(row.target));

      // 指向不存在的文档（还没建）、自链接都不进图
      if (target === undefined || target === source) continue;

      const key = source < target ? `${source}:${target}` : `${target}:${source}`;
      if (seen.has(key)) continue;
      seen.add(key);

      edges.push({ source, target });
      degree.set(source, (degree.get(source) ?? 0) + 1);
      degree.set(target, (degree.get(target) ?? 0) + 1);
    }

    return {
      nodes: documents.map((document) => ({
        id: document.id,
        path: document.path,
        relativePath: document.relativePath,
        name: document.name,
        degree: degree.get(document.id) ?? 0
      })),
      edges
    };
  }

  getStats(): IndexStats {
    const row = this.db.get(`SELECT COUNT(*) AS count FROM documents`);
    return { documents: Number(row?.count ?? 0) };
  }

  /**
   * 一篇文档可能被链接到的写法，全部小写。
   *
   * - Markdown：相对路径（去 `.md`）与文件名（去 `.md`）。
   * - 附件（Phase 3 / P3-04）：**额外**加「去掉自身扩展名」的候选，于是 `[[stm32]]`
   *   也能命中 `stm32.pdf`。
   *
   * 与 `resolveWikiLink`（renderer 侧）的匹配口径必须一致。两处若不一致，会出现
   * 「能跳转但查不到反向链接」这种极难察觉的偏差 —— 两边单独看都是对的。
   *
   * ## 为什么只给附件加「去扩展名」
   *
   * 给 Markdown 也加的话，`[[readme.txt]]` 会命中 `readme.md` —— 而用户写出 `.txt`
   * 显然不是想链接一篇 Markdown。附件反过来：短名没有别的解释，加候选才不会歧义。
   *
   * ## 同名共存时**不加**短名候选
   *
   * `stm32.md` 与 `stm32.pdf` 同时存在时，`[[stm32]]` 在跳转侧归 `.md`
   * （由 `wikilinkCandidates` 的顺序决定）。反向链接侧没有「顺序」这个概念，只有
   * 集合匹配 —— 所以这里必须显式把短名从附件的候选里去掉，否则那条链接会**同时**
   * 出现在两篇的反向链接面板里，而跳转只会去 `.md`，两处行为不一致。
   * 这是「附件引用必须显式写扩展名」这条契约的另一半。
   */
  private backlinkTargetsOf(document: IndexedDocument): string[] {
    const stripMarkdown = (value: string) => value.toLowerCase().replace(/\.md$/, '');
    const targets = new Set([stripMarkdown(document.relativePath), stripMarkdown(document.name)]);

    if (document.type !== 'markdown') {
      const stripExtension = (value: string) => value.toLowerCase().replace(/\.[^./\\]+$/, '');
      for (const short of [
        stripExtension(document.relativePath),
        stripExtension(document.name)
      ]) {
        if (short.length === 0) continue;
        if (this.hasMarkdownTarget(short)) continue;
        targets.add(short);
      }
    }

    return [...targets];
  }

  /**
   * 库里是否存在「会被短名 `shortTarget` 命中」的 Markdown 文档。
   *
   * 判据与 `backlinkTargetsOf` 对 Markdown 产出的候选一致：文件名或相对路径去掉
   * `.md` / `.markdown` 后等于 `shortTarget`。写成 SQL 而不是拉到内存里比，
   * 是因为 `getGraph()` 会对每篇文档调一次 —— 那会变成 O(n²)。
   */
  private hasMarkdownTarget(shortTarget: string): boolean {
    const row = this.db.get(
      `SELECT 1 FROM documents
        WHERE type = 'markdown'
          AND (lower(name) IN (?, ?) OR lower(relative_path) IN (?, ?))
        LIMIT 1`,
      [
        `${shortTarget}.md`,
        `${shortTarget}.markdown`,
        `${shortTarget}.md`,
        `${shortTarget}.markdown`
      ]
    );
    return Boolean(row);
  }
}

/** 允许出现在 `documents.type` 列里的值，用于把库里的字符串收敛回类型。 */
const DOCUMENT_TYPES: readonly DocumentType[] = ['markdown', 'pdf', 'docx', 'image'];

/** 允许出现在 `documents.extraction_status` 列里的值。 */
const EXTRACTION_STATUSES: readonly ExtractionStatus[] = [
  'none',
  'extracted',
  'empty',
  'failed'
];

function mapDocument(row: Record<string, unknown>): IndexedDocument {
  return {
    id: Number(row.id),
    path: String(row.path),
    relativePath: String(row.relative_path),
    name: String(row.name),
    title: String(row.title),
    type: readDocumentType(row.type),
    sizeBytes: Number(row.size_bytes ?? 0),
    modifiedAtMs: Number(row.modified_at_ms ?? 0),
    contentHash: String(row.content_hash),
    extractionStatus: readExtractionStatus(row.extraction_status)
  };
}

/**
 * 把库里的 `type` 列收敛回 `DocumentType`。
 *
 * 认不出的值一律当 Markdown —— 索引是派生数据，宁可自愈也不要让一次脏读把整个
 * 面板打挂。真出现认不出的值，说明 schema 变了而版本号没跟上，那会在
 * 「可重建性」测试里先暴露。
 */
function readDocumentType(raw: unknown): DocumentType {
  const value = typeof raw === 'string' ? raw : '';
  return DOCUMENT_TYPES.includes(value as DocumentType) ? (value as DocumentType) : 'markdown';
}

/**
 * 把库里的 `extraction_status` 列收敛回 `ExtractionStatus`。
 *
 * 与 `readDocumentType` 同一条口径：认不出一律当 `'none'`。这个方向是安全的 ——
 * `'none'` 在界面上不显示任何提示，宁可少说一句，也不要把一个脏值渲染成
 * 「未提取到文本」那种**看起来像结论**的东西。
 */
function readExtractionStatus(raw: unknown): ExtractionStatus {
  const value = typeof raw === 'string' ? raw : '';
  return EXTRACTION_STATUSES.includes(value as ExtractionStatus)
    ? (value as ExtractionStatus)
    : 'none';
}
