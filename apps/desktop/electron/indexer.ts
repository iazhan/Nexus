import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  attachmentContentFingerprint,
  attachmentReferences,
  normalizeWikilinkTarget,
  type IndexWorkspaceResult,
  type ProcessorRegistry
} from '@nexus/core';
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
 * Phase 3 / P3-10 起**被 Markdown 引用过的 PDF / DOCX** 例外：它们的文本会被提取
 * 出来并进全文索引（计划 §10.1 决策 1）。见下方 `extractReferencedAttachments()`。
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
  /**
   * 文档处理器注册表（Phase 3 / P3-10）。**不传就不做文本提取。**
   *
   * 刻意做成可选：P2 建索引的契约与那批用例因此一个字都不用改，而「不装处理器」
   * 本身也是一个正当配置（只想建文档索引、不想付提取的代价）。
   *
   * 代价是「忘了传」不会报错。所以生产装配（`electron/index.ts`）那条路径由
   * `p3-10-extraction-index.test.ts` 端到端钉住 —— 漏接的表现是「PDF 搜不到」，
   * 那正是这个切片最该被验到的行为。
   */
  processors?: ProcessorRegistry;
}

const INDEX_EVENT_LOOP_YIELD_EVERY = 4;
const INDEX_WRITE_BATCH_SIZE = 32;

export async function indexWorkspace(
  options: IndexWorkspaceOptions
): Promise<IndexWorkspaceResult> {
  const { service, store, rootPath } = options;
  const nowMs = options.nowMs ?? Date.now();

  const scan = await service.scanWorkspaceFiles(rootPath, options.scanOptions);
  // wasm SQLite 的逐路径查询会反复获取/释放文件锁；一次读出当前索引后在内存比较，
  // 热索引也不再为每个文件执行一轮同步数据库往返。
  const existingByPath = new Map(store.listDocuments().map((document) => [document.path, document]));

  let indexed = 0;
  let skipped = 0;
  const errors: string[] = [];
  const seenPaths = new Set<string>();
  let pendingUpserts: Parameters<IndexStore['upsertDocuments']>[0] = [];

  /** 每批统一提交后释放 SQLite 锁，避免逐文档事务的同步 VFS 往返。 */
  const flushUpserts = () => {
    if (pendingUpserts.length === 0) return;
    indexed += store.upsertDocuments(pendingUpserts, nowMs).length;
    pendingUpserts = [];
  };

  // 「被 Markdown 引用过的附件」的两个匹配集合（Phase 3 / P3-10）。
  // 在**同一个循环里**顺手收集：正文已经读进来了，为它再扫一遍盘是白付的 IO。
  // 注意收集发生在「指纹没变就跳过」**之前** —— 跳过的是写库，不是解析。
  const referencedPaths = new Set<string>();
  const referencedWikilinkTargets = new Set<string>();

  for (const [index, file] of scan.files.entries()) {
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

      if (content !== null) {
        const references = attachmentReferences(content, file.relativePath);
        for (const reference of references.paths) {
          referencedPaths.add(reference.toLowerCase());
        }
        for (const target of references.wikilinkTargets) {
          referencedWikilinkTargets.add(target);
        }
      }

      // 跳过判据对两类文档是同一条：指纹没变就不重写。附件的指纹是 stat 指纹，
      // 所以「改了内容但 size 与 mtime 都没变」不会触发重索引 —— 那需要人为构造，
      // 且附件本来就是只读展示，见 `attachmentContentFingerprint()` 的说明。
      const existing = existingByPath.get(file.path);
      if (existing && existing.contentHash === contentHash) {
        skipped += 1;
      } else {
        pendingUpserts.push({
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
        });
      }
    } catch (err) {
      // 单个文件读不动（权限、扫描途中被删）不该让整次索引失败
      errors.push(
        `${file.relativePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 每批结束让出主进程事件循环，保存、文件监听和窗口 IPC 不必等整轮扫完。
    if (pendingUpserts.length >= INDEX_WRITE_BATCH_SIZE) flushUpserts();

    if ((index + 1) % INDEX_EVENT_LOOP_YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  flushUpserts();

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

  const extraction = await extractReferencedAttachments({
    service,
    store,
    processors: options.processors,
    references: { paths: referencedPaths, wikilinkTargets: referencedWikilinkTargets },
    // 扫描被截断时引用集合也是**不完整**的 —— 没扫到的 Markdown 里的引用看不见。
    // 这时「没被引用」这个结论不成立，所以只提取、**不清除**任何东西。
    allowClearing: !scan.truncated
  });

  return {
    scanned: scan.files.length,
    indexed,
    skipped,
    removed,
    extracted: extraction.extracted,
    truncated: scan.truncated,
    errors: [...errors, ...extraction.errors]
  };
}

/**
 * 给「被 Markdown 引用过的附件」提取文本，写进全文索引（Phase 3 / P3-10）。
 *
 * ## 为什么是第二遍而不是在主循环里做
 *
 * 因为「这个附件被引用了」这个判断要**等所有 Markdown 都读完**才能下 ——
 * 一篇在扫描顺序里排最后的笔记可能引用了排最前面的那个 PDF。主循环里做只能
 * 看到一半的引用集合，表现是「引用它的那篇笔记在文件树里靠后就提取不到」，
 * 一种要靠运气才能复现的 bug。
 *
 * ## 跳过判据：靠 `extraction_status` 而不是另存指纹
 *
 * 附件的 `content_hash` **就是** stat 指纹，而 `upsertDocument` 在内容变化时会把
 * `extraction_status` 重置成 `'none'`。于是：
 *
 *   - 状态不是 `'none'` ⟹ 当前内容已经提取过 ⟹ 跳过（几百页的手册不会每轮重读）；
 *   - 状态是 `'none'` ⟹ 要么刚变过、要么刚被引用上 ⟹ 提取。
 *
 * 不需要再存一个「提取时的指纹」—— 那会是同一件事的第二处记录，两者不同步时
 * 表现是「文件改了但索引里的文本还是旧的」，极难察觉。
 */
async function extractReferencedAttachments(options: {
  service: FileService;
  store: IndexStore;
  processors: ProcessorRegistry | undefined;
  references: { paths: ReadonlySet<string>; wikilinkTargets: ReadonlySet<string> };
  allowClearing: boolean;
}): Promise<{ extracted: number; errors: string[] }> {
  const { service, store, processors, references, allowClearing } = options;
  if (processors === undefined) return { extracted: 0, errors: [] };

  const referencedPaths = new Set(
    store.findReferencedAttachments(references).map((document) => document.path)
  );

  let extracted = 0;
  const errors: string[] = [];

  for (const document of store.listDocuments()) {
    if (document.type === 'markdown') continue;

    if (!referencedPaths.has(document.path)) {
      // 没被引用 → 把上一轮可能留下的文本清掉。不清的话，一篇笔记删掉对某个 PDF
      // 的引用之后，那个 PDF 的正文会永远留在索引里 —— 搜得到、点进去却「没引用」，
      // 而用户已经把引用删了。
      if (allowClearing && document.extractionStatus !== 'none') {
        store.setExtraction(document.path, { status: 'none', text: '' });
      }
      continue;
    }

    // 已经提过且内容没变（变了会被 upsertDocument 重置成 'none'）
    if (document.extractionStatus !== 'none') continue;

    try {
      const bytes = await service.readDocumentBytes(document.path);
      const outcome = await processors.extract(document.type, {
        relativePath: document.relativePath,
        bytes
      });
      store.setExtraction(document.path, { status: outcome.status, text: outcome.text });

      if (outcome.status === 'extracted') extracted += 1;
      if (outcome.status === 'failed') {
        errors.push(`${document.relativePath}: ${outcome.message ?? '提取失败'}`);
      }
    } catch (err) {
      // 读不动（权限、扫描途中被删）与提取失败同样处理：记一条、继续
      errors.push(
        `${document.relativePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { extracted, errors };
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
 * 归一化本身在 `@nexus/core` 的 `normalizeWikilinkTarget()` —— 查询端只做等值比较，
 * 两边各归一化一次迟早不一致，而那种不一致的表现是「能跳转但查不到反向链接」，
 * 很难察觉。
 *
 * 用正则而不是完整 parser：索引器只要目标名，为几个链接跑一遍 AST 不划算。
 * 代价是**代码块里的 `[[...]]` 也会被收进来**。这是刻意选的方向：
 * 反向链接多一条不致命，而漏掉真链接会让人以为功能坏了。
 */
export function extractWikiLinkTargets(source: string): string[] {
  const targets = new Set<string>();

  for (const match of source.matchAll(WIKILINK_PATTERN)) {
    const raw = match[1];
    if (!raw) continue;
    const normalized = normalizeWikilinkTarget(raw);
    if (normalized.length === 0) continue;
    targets.add(normalized);
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
