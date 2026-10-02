/**
 * 文档类型契约（Phase 3 Document Center）。
 *
 * 只描述「这是什么类型的文档」，不描述「怎么渲染」—— 渲染是 renderer 的事。
 * 这里是 main / preload / renderer 与索引层共用的**唯一来源**。
 *
 * 为什么不放进 `@nexus/document` 独立包：Phase 3 目前只需要这几个纯类型与
 * 几个纯函数，建包是猜需求（同 P2-08 对 `repository` 包的判断）。等 Phase 4
 * 真的出现多后端（本地文件 / SQLite / 远端缓存）时再抽包。
 */
export type DocumentType = 'markdown' | 'pdf' | 'docx' | 'image';

/**
 * 全部文档类型。**顺序即界面上的展示顺序** —— 图谱的类型筛选条按它排。
 *
 * 定义成数组而不是手写联合，理由与 `VIEWER_DOCUMENT_TYPES` 相同：让「有哪些类型」
 * 只有一处判据。索引层用它校验库里的脏值，渲染层用它校验存档里的脏值。
 */
export const DOCUMENT_TYPES = ['markdown', 'pdf', 'docx', 'image'] as const;

/**
 * 全部 viewer 类型。**顺序就是 UI 里的分组顺序** —— 附件区的分组直接照这个数组排。
 *
 * 定义成数组而不是手写联合，是为了让「有哪些 viewer 类型」只有**一处**判据：
 * `ViewerDocumentType` 从它派生，`isViewerDocumentType()` 也从它派生。
 * 手写两遍的后果是具体的 —— 新增一个类型时，类型会跟着变而守卫不会，
 * 于是新类型在运行时被当成「不是 viewer」，而**编译器一声不吭**。
 */
export const VIEWER_DOCUMENT_TYPES = ['image', 'pdf', 'docx'] as const;

/**
 * 能被 Viewer 打开、但不是 Markdown 的类型。
 *
 * 单独取出来是因为它有一条**不同的行为契约**：Markdown 是可编辑的
 * canonical source，而这些都是**严格只读**的（Phase 3 的验收第 3 条：
 * 打开浏览后原文件的 mtime 与内容哈希必须不变）。
 */
export type ViewerDocumentType = (typeof VIEWER_DOCUMENT_TYPES)[number];

/**
 * 类型守卫：把 `DocumentType | null` 收窄成 `ViewerDocumentType`。
 *
 * 存在的理由是 `LaunchContext.documentType` 的类型只能是 `DocumentType | null`
 * （它同时服务于 lightweight 与 viewer 两种模式），而 renderer 在 viewer 分支里
 * 需要的是「确定不是 Markdown」这个更强的事实。让调用方写
 * `ctx.documentType as ViewerDocumentType` 会把「viewer 模式一定不是 Markdown」
 * 这条**由 main 侧保证**的约定降级成一句断言 —— 约定变了不会有任何提示。
 */
export function isViewerDocumentType(
  type: DocumentType | null | undefined
): type is ViewerDocumentType {
  if (type === null || type === undefined) return false;
  // 这里放宽的只是**入参**的类型（`readonly ['image','pdf','docx']` 的 `includes`
  // 只接受那三个字面量，而调用方给的是更宽的 `DocumentType`）。
  // 判据本身仍然只有 `VIEWER_DOCUMENT_TYPES` 一处 —— 不重复列举。
  return (VIEWER_DOCUMENT_TYPES as readonly DocumentType[]).includes(type);
}
