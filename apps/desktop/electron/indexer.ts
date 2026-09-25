import { createHash } from 'node:crypto';
import path from 'node:path';
import type { IndexWorkspaceResult } from '@nexus/core';
import type { FileService, ScanWorkspaceOptions } from './file-service.js';
import type { IndexStore } from './index-store.js';

/**
 * 工作区索引器：扫盘 → 读内容 → 写进索引库。
 *
 * 做**文档级**索引、全文检索，以及出链（wikilink 目标）的收集。
 * headings 仍不进索引 —— 大纲面板直接从**当前源码**解析，那样才能跟随编辑实时更新；
 * tags 等需求明确之后再落。
 *
 * 全量而非增量：索引是派生数据，重建的代价只是几秒扫盘，而增量状态本身
 * 就是一类需要维护、会出错、还无法自证正确的数据。这里只用内容哈希跳过
 * 「读进来发现没变」的文件，不做基于 mtime 的猜测。
 */

export interface IndexWorkspaceOptions {
  service: FileService;
  store: IndexStore;
  rootPath: string;
  /** 注入时间便于测试断言，默认 Date.now() */
  nowMs?: number;
  /** 透传给扫描的上限/深度选项，用于测试触发截断路径 */
  scanOptions?: ScanWorkspaceOptions;
}

export async function indexWorkspace(
  options: IndexWorkspaceOptions
): Promise<IndexWorkspaceResult> {
  const { service, store, rootPath } = options;
  const nowMs = options.nowMs ?? Date.now();

  const scan = await service.scanWorkspaceMarkdownFiles(rootPath, options.scanOptions);

  let indexed = 0;
  let skipped = 0;
  const errors: string[] = [];
  const seenPaths = new Set<string>();

  for (const file of scan.files) {
    seenPaths.add(file.path);

    try {
      const content = await service.readFile(file.path);
      const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');

      const existing = store.getDocumentByPath(file.path);
      if (existing && existing.contentHash === contentHash) {
        skipped += 1;
        continue;
      }

      store.upsertDocument(
        {
          path: file.path,
          relativePath: file.relativePath,
          name: file.name,
          title: deriveTitle(file.name),
          sizeBytes: file.sizeBytes,
          modifiedAtMs: file.modifiedAtMs,
          contentHash,
          body: content,
          links: extractWikiLinkTargets(content)
        },
        nowMs
      );
      indexed += 1;
    } catch (err) {
      // 单个文件读不动（权限、扫描途中被删）不该让整次索引失败
      errors.push(
        `${file.relativePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 扫描被截断时**不能**清理任何记录：没扫到不等于磁盘上没有，
  // 否则一次触顶的扫描会把索引删掉一大半。
  let removed = 0;
  if (!scan.truncated) {
    const stale = store
      .listDocuments()
      .filter((document) => !seenPaths.has(document.path))
      .map((document) => document.path);
    removed = store.removeDocuments(stale);
  }

  return {
    scanned: scan.files.length,
    indexed,
    skipped,
    removed,
    truncated: scan.truncated,
    errors
  };
}

/** 标题取文件名（去扩展名）—— 零解析依赖，且对任何 Markdown 都稳定。 */
function deriveTitle(fileName: string): string {
  const extension = path.extname(fileName);
  return extension ? fileName.slice(0, -extension.length) : fileName;
}

/** `[[目标]]` 或 `[[目标|别名]]`。 */
const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

/**
 * 提取正文里的 wikilink 目标，**归一化**成 `links` 表要的形式（去 `.md`、转小写）。
 *
 * 归一化在这里做、查询端只做等值比较 —— 两边各归一化一次迟早不一致，
 * 而那种不一致的表现是「能跳转但查不到反向链接」，很难察觉。
 *
 * 用正则而不是完整 parser：索引器只要目标名，为几个链接跑一遍 AST 不划算。
 * 代价是**代码块里的 `[[...]]` 也会被收进来**。这是刻意选的方向：
 * 反向链接多一条不致命，而漏掉真链接会让人以为功能坏了。
 */
export function extractWikiLinkTargets(source: string): string[] {
  const targets = new Set<string>();

  for (const match of source.matchAll(WIKILINK_PATTERN)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    targets.add(raw.toLowerCase().replace(/\.md$/, ''));
  }

  return [...targets];
}
