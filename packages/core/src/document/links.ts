import { supportedDocumentExtensions } from './extensions.js';

/**
 * `[[目标]]` 的全部候选写法，**顺序即优先级**（Phase 3 / P3-04）。
 *
 * ## 为什么需要它
 *
 * P2 的链接解析只认 Markdown：`[[stm32]]` 的候选是 `stm32` 与 `stm32.md`。
 * Phase 3 引入附件之后，用户想链接一个 PDF 只有两条路 —— 写全名 `[[stm32.pdf]]`，
 * 或写短名 `[[stm32]]` 让解析器去猜。
 *
 * 写全名本来就是通的（`[[stm32.pdf]]` 直接等于附件的文件名）。不通的只有短名，
 * 而用户没有理由记住「链接附件要写扩展名、链接笔记不用」。
 *
 * ## 候选顺序是契约的一部分，不是实现细节
 *
 * 工作区里同时存在 `stm32.md` 与 `stm32.pdf` 时，`[[stm32]]` **归 `.md`** ——
 * 由这里的顺序决定。这是刻意的：附件引用必须显式写扩展名才不会歧义，
 * 因为笔记才是知识库的主体，短名默认指向笔记更符合预期。
 *
 * ## 已经带扩展名的不再叠加
 *
 * `[[stm32.pdf]]` 只返回 `['stm32.pdf']`，不会生成 `stm32.pdf.md` 这种荒谬候选。
 * 判据是「以**白名单里**的某个扩展名结尾」而不是「含点」—— 后者会把
 * `[[v1.2]]` 误判成带扩展名（`.2` 不在白名单里，它应当继续展开成 `v1.2.md`）。
 *
 * 大小写不敏感：返回的候选全部小写，调用方拿文档的小写路径/文件名去比。
 */
export function wikilinkCandidates(target: string): readonly string[] {
  const needle = target.trim().toLowerCase();
  if (needle.length === 0) return [];

  const extensions = supportedDocumentExtensions();

  if (extensions.some((extension) => needle.endsWith(extension))) {
    return [needle];
  }

  // 顺序即优先级：`name` 原样 → `name.md` → `name.markdown` → 其余白名单扩展名。
  // `supportedDocumentExtensions()` 的返回顺序已经把 `.md` / `.markdown` 排在前面，
  // 所以这里直接展开，不再手工排序 —— 白名单调整时不会出现两处顺序不一致。
  return [needle, ...extensions.map((extension) => needle + extension)];
}

/**
 * 附件的**内容指纹**（P3-04）。
 *
 * ## 为什么不读全文算 sha256
 *
 * Markdown 的 `contentHash` 是正文的 sha256 —— 它必须检测「内容变了」，
 * 因为增量索引靠它跳过没变的文件。附件不同：
 *
 * - 附件**不进全文检索**，内容从不参与查询，索引里只需要「这个路径上有个多大的什么东西」；
 * - 一个 200MB 的 PDF 每次全量索引都读一遍算哈希，是纯粹白付的 IO。
 *
 * 所以附件用 `stat` 指纹。它同样满足「索引是派生数据」这条不变量 ——
 * 同样的磁盘状态必然算出同样的指纹，删库重建仍然等价（Phase 3 验收第 2 条）。
 *
 * ## 代价（要认下来）
 *
 * 内容变了但 size 与 mtime 都没变时，指纹不变、索引不更新。这种情形在真实磁盘上
 * 需要人为构造（改写内容再回写 mtime），而附件本来就是只读展示，代价可接受。
 */
export function attachmentContentFingerprint(sizeBytes: number, modifiedAtMs: number): string {
  return `stat:${sizeBytes}:${Math.trunc(modifiedAtMs)}`;
}
