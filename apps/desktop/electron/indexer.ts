import { createHash } from 'node:crypto';
import path from 'node:path';
import type { IndexWorkspaceResult } from '@nexus/core';
import type { FileService, ScanWorkspaceOptions } from './file-service.js';
import type { IndexStore } from './index-store.js';

/**
 * 工作区索引器：扫盘 → 读内容 → 写进索引库。
 *
 * 只做**文档级**索引与全文检索。headings / links / tags 属于知识层（P2-06），
 * 那部分要等 Resolver 与 Outline 的需求明确之后再落，免得先建一堆用不上的表。
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
          body: content
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
