import { Database } from 'node-sqlite3-wasm';
import type { IndexedDocument, SearchHit } from '@nexus/core';

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

/** schema 版本。改表结构就 +1 —— 旧库会被整个重建。 */
const SCHEMA_VERSION = '1';

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
     size_bytes INTEGER NOT NULL DEFAULT 0,
     modified_at_ms INTEGER NOT NULL DEFAULT 0,
     content_hash TEXT NOT NULL,
     indexed_at_ms INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_documents_relative_path ON documents(relative_path)`,
  // FTS5 虚表自带 rowid，这里让它等于 documents.id，查询时 join 回去。
  // 正文存的是**切分后**的文本，见 segmentForIndex()。
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
     title,
     body,
     tokenize='unicode61'
   )`
];

/** 重建时要按依赖顺序丢掉的表。 */
const DROP_STATEMENTS = [
  `DROP TABLE IF EXISTS search_fts`,
  `DROP TABLE IF EXISTS documents`,
  `DROP TABLE IF EXISTS meta`
];

/** 写入一篇文档所需的全部字段。 */
export interface UpsertDocumentInput {
  path: string;
  relativePath: string;
  name: string;
  title: string;
  sizeBytes: number;
  modifiedAtMs: number;
  contentHash: string;
  /** 原始正文（未切分）；切分在本层内部完成 */
  body: string;
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
    const db = new Database(dbPath);
    const store = new IndexStore(db, dbPath);
    try {
      store.ensureSchema();
    } catch (err) {
      db.close();
      throw err;
    }
    return store;
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
      `SELECT id, path, relative_path, name, title, size_bytes, modified_at_ms, content_hash
         FROM documents WHERE path = ?`,
      [filePath]
    );
    return row ? mapDocument(row) : null;
  }

  /** 按相对路径排序的全部文档 —— 供 Quick Open 之类的扁平列表使用。 */
  listDocuments(): IndexedDocument[] {
    const rows = this.db.all(
      `SELECT id, path, relative_path, name, title, size_bytes, modified_at_ms, content_hash
         FROM documents ORDER BY relative_path`
    );
    return rows.map(mapDocument);
  }

  /**
   * 写入或更新一篇文档（含全文索引）。
   *
   * 同一事务里替换 FTS 行：先删旧的再插新的，避免同一文档留下两份索引。
   */
  upsertDocument(input: UpsertDocumentInput, nowMs: number): number {
    this.db.exec('BEGIN');
    try {
      this.db.run(
        `INSERT INTO documents(path, relative_path, name, title, size_bytes, modified_at_ms, content_hash, indexed_at_ms)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           relative_path = excluded.relative_path,
           name = excluded.name,
           title = excluded.title,
           size_bytes = excluded.size_bytes,
           modified_at_ms = excluded.modified_at_ms,
           content_hash = excluded.content_hash,
           indexed_at_ms = excluded.indexed_at_ms`,
        [
          input.path,
          input.relativePath,
          input.name,
          input.title,
          input.sizeBytes,
          input.modifiedAtMs,
          input.contentHash,
          nowMs
        ]
      );

      const row = this.db.get(`SELECT id FROM documents WHERE path = ?`, [input.path]);
      const documentId = Number(row?.id ?? 0);
      if (documentId <= 0) {
        throw new Error(`写入文档后拿不到 id: ${input.path}`);
      }

      this.db.run(`DELETE FROM search_fts WHERE rowid = ?`, [documentId]);
      this.db.run(`INSERT INTO search_fts(rowid, title, body) VALUES(?, ?, ?)`, [
        documentId,
        segmentForIndex(input.title),
        segmentForIndex(input.body)
      ]);

      this.db.exec('COMMIT');
      return documentId;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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
              d.name AS name, d.title AS title
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
      title: String(row.title)
    }));
  }

  getStats(): IndexStats {
    const row = this.db.get(`SELECT COUNT(*) AS count FROM documents`);
    return { documents: Number(row?.count ?? 0) };
  }
}

function mapDocument(row: Record<string, unknown>): IndexedDocument {
  return {
    id: Number(row.id),
    path: String(row.path),
    relativePath: String(row.relative_path),
    name: String(row.name),
    title: String(row.title),
    sizeBytes: Number(row.size_bytes ?? 0),
    modifiedAtMs: Number(row.modified_at_ms ?? 0),
    contentHash: String(row.content_hash)
  };
}
