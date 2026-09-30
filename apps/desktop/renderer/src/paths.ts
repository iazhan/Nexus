/**
 * 路径的小工具。
 *
 * 前两个原本是 `App.tsx` 里的私有函数。搬出来是因为 `newDocumentDirectory` 需要被测试：
 * 它是「设置值 → 具体目录」这一步的判断，而 `App.tsx` 是 2000 行、拉着一整套运行时的
 * 组件文件，从测试里 import 它等于为了测一个三元表达式把整个应用装起来。
 *
 * 这里**只做字符串切分，不碰文件系统**：目录存不存在、能不能写，是主进程的事
 * （`file-service.ts` 的边界校验）。在渲染进程猜这些只会多出一个会过期的答案。
 */

import { NEW_DOCUMENT_LOCATION_WORKSPACE } from './settings/preference-specs.js';

/** 取路径所在的目录（不含末尾分隔符）。没有分隔符时返回 `null` —— 裸文件名没有目录。 */
export function getDocumentDirectory(filePath: string | null): string | null {
  if (!filePath) return null;
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastSlash === -1) return null;
  return filePath.slice(0, lastSlash);
}

/** 取路径最后一段（文件名）。同时兼容 `/` 与 `\` —— 工作区路径可能来自任一侧。 */
export function getFileName(filePath: string | null): string {
  if (!filePath) return '';
  return filePath.replace(/^.*[\\/]/, '');
}

/**
 * 新建文档第一次保存时，对话框停在哪个目录。
 *
 * 三个输入都可能是空的，所以规则要按顺序读：
 * - 选了「工作区根目录」且有工作区 → 用它；
 * - 否则用**记住的最近一个文档目录**（`document` 选项，也是轻量模式下 `workspace` 的回落）；
 * - 都没有 → `null`，调用方不传 `defaultPath`，交给系统决定。
 *
 * 「工作区」在轻量模式（只开了一个文件）下没有工作区可去，**回落到记住的目录而不是
 * 直接放弃**：与其把对话框丢到一个用户没指定的位置，不如用它刚才在的地方。
 *
 * 判据是 `NEW_DOCUMENT_LOCATION_WORKSPACE` 这个常量而不是裸字符串：选项表与这里的分支
 * 一旦各写一份，改一处就会让「选了工作区根目录、对话框还是停在文档旁边」静默发生。
 */
export function newDocumentDirectory(
  location: string,
  workspaceRoot: string | null,
  lastDocumentDirectory: string | null
): string | null {
  if (location === NEW_DOCUMENT_LOCATION_WORKSPACE && workspaceRoot) {
    return workspaceRoot;
  }
  return lastDocumentDirectory;
}
