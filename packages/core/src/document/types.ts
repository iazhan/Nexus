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
 * 能被 Viewer 打开、但不是 Markdown 的类型。
 *
 * 单独取出来是因为它有一条**不同的行为契约**：Markdown 是可编辑的
 * canonical source，而这些都是**严格只读**的（Phase 3 的验收第 3 条：
 * 打开浏览后原文件的 mtime 与内容哈希必须不变）。
 */
export type ViewerDocumentType = Exclude<DocumentType, 'markdown'>;

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
  return type === 'pdf' || type === 'docx' || type === 'image';
}
