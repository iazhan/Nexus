import { documentTypeForPath, type ViewerDocumentType } from '@nexus/core';

/**
 * 一个路径应该被打开成什么。
 *
 * 三种可能，且**互斥**：可编辑的 Markdown、只读附件、白名单外（打不开）。
 * 抽成纯函数是为了让「这个路径归谁」只有一个判断点 —— 链接跳转、文件树、
 * 快速打开、启动参数四条入口都经过它。分散判断的后果很具体：同一条路径
 * 从链接点进去是只读查看、从文件树点进去却报「不支持的格式」。
 */
export type OpenTarget =
  | { readonly kind: 'editor'; readonly path: string }
  | { readonly kind: 'viewer'; readonly path: string; readonly type: ViewerDocumentType }
  | { readonly kind: 'unsupported'; readonly path: string };

export function classifyOpenTarget(filePath: string): OpenTarget {
  const type = documentTypeForPath(filePath);

  if (type === null) return { kind: 'unsupported', path: filePath };
  if (type === 'markdown') return { kind: 'editor', path: filePath };
  return { kind: 'viewer', path: filePath, type };
}
