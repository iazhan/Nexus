import { createHash } from 'node:crypto';
import path from 'node:path';
import { attachmentContentFingerprint, type IndexWorkspaceResult } from '@nexus/core';
import type { FileService, ScanWorkspaceOptions } from './file-service.js';
import type { IndexStore } from './index-store.js';

/**
 * 工作区索引器：扫盘 → （Markdown 读内容）→ 写进索引库。
 *
 * 做**文档级**索引、全文检索，以及出链（wikilink 目标）的收集。
 *
 * Phase 3 / P3-04 起**附件也进索引**，但只记元数据：类型、大小、修改时间，
 * 以及按 stat 算的内容指纹。附件不进全文检索，也没有出链和标签 —— 它的用途是
 * 「能被列出来、能被 wikilink 指到、能被 Viewer 打开」，不参与检索。
 *
 * headings 仍不进索引 —— 大纲面板直接从**当前源码**解析，那样才能跟随编辑实时更新；
 * tags 等需求明确之后再落。
 *
 * 全量而非增量：索引是派生数据，重建的代价只是几秒扫盘，而增量状态本身
 * 就是一类需要维护、会出错、还无法自证正确的数据。这里只用内容指纹跳过
 * 「读进来发现没变」的文件，不做基于 mtime 的猜测 —— 附件的指纹**就是** stat 指纹，
 * 那是刻意的取舍，见 core 的 `attachmentContentFingerprint()`。
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

  const scan = await service.scanWorkspaceFiles(rootPath, options.scanOptions);

  let indexed = 0;
  let skipped = 0;
  const errors: string[] = [];
  const seenPaths = new Set<string>();

  for (const file of scan.files) {
    seenPaths.add(file.path);

    try {
      // 附件**不读内容**：它不进全文检索，正文从不参与查询，而给一个 200MB 的 PDF
      // 每次全量索引都读一遍算哈希是纯粹白付的 IO。指纹改用 stat，代价与理由见
      // `attachmentContentFingerprint()`。
      const content = file.type === 'markdown' ? await service.readFile(file.path) : null;
      const contentHash =
        content !== null
          ? createHash('sha256').update(content, 'utf8').digest('hex')
          : attachmentContentFingerprint(file.sizeBytes, file.modifiedAtMs);

      // 跳过判据对两类文档是同一条：指纹没变就不重写。附件的指纹是 stat 指纹，
      // 所以「改了内容但 size 与 mtime 都没变」不会触发重索引 —— 那需要人为构造，
      // 且附件本来就是只读展示，见 `attachmentContentFingerprint()` 的说明。
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
          type: file.type,
          title: deriveTitle(file.name),
          sizeBytes: file.sizeBytes,
          modifiedAtMs: file.modifiedAtMs,
          contentHash,
          body: content ?? '',
          links: content !== null ? extractWikiLinkTargets(content) : [],
          tags: content !== null ? extractTags(content) : []
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

/**
 * `#标签`：`#` 前必须是行首或空白，`#` 后紧跟非空白、非 `#` 的字符。
 *
 * 这条「前面要是空白」的约束同时排除了两类最常见的误判：
 *   - `# 标题` —— `#` 后是空格，ATX 标题不是标签
 *   - `https://x.com/#anchor` —— `#` 前是 `/`，URL 片段不是标签
 */
const TAG_PATTERN = /(?:^|\s)#([^\s#]+)/g;

/** 标签的终止标点：遇到就认为标签结束。 */
const TAG_TERMINATOR = /[.,;:!?，。；：！？、()（）[\]【】"'`]/;

/**
 * 提取正文里的标签并归一化（去前导 `#`、转小写）。
 *
 * 与出链一样用正则、**不跳过代码块**：多收一个标签不致命，
 * 漏掉真的会让人以为功能坏了。
 */
export function extractTags(source: string): string[] {
  const tags = new Set<string>();

  for (const match of source.matchAll(TAG_PATTERN)) {
    // 正则只能按空白切，所以 `#dma，还有` 会整段被吃进来。
    // 这里再按标点截断一次，只取第一个标点之前的部分。
    const candidate = match[1]?.split(TAG_TERMINATOR)[0]?.trim();
    if (!candidate) continue;
    tags.add(candidate.toLowerCase());
  }

  return [...tags];
}
