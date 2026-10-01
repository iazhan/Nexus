import {
  documentTypeForPath,
  relativePathFrom,
  toAssetUrl,
  type IndexedDocument
} from '@nexus/core';
import type { WorkspaceImageOption } from '@nexus/editor';

/**
 * 把索引文档里**图片**那一部分转成图片选择器的选项。
 *
 * 三件事都在这一层做完，编辑器只拿到成品：
 * - **筛图片**：复用 `documentTypeForPath` 白名单，不另抄一份扩展名表。
 * - **两份地址**：`![](…)` 用**相对当前文档目录**（标准 Markdown 的基准），
 *   `![[…]]` 用 Obsidian 的**最短唯一路径** —— 文件名全库唯一时是裸名，否则是
 *   **工作区根相对**路径。两种写法各写各的，混用会让链接指向别处且不报错。
 *   跨卷时 `relativePathFrom` 返回 `null`，那一项直接丢掉：写一条解析不了的路径
 *   比不提供这个选项更糟。
 * - **缩略图地址**：`toAssetUrl` 的 `nexus-asset://`，与内嵌图片同一条通道。
 *
 * 同名文件带上相对路径消歧（与附件区 `buildAttachmentGroups` 同一套做法）——
 * `assets/logo.png` 与 `brand/logo.png` 都叫 `logo.png`，只显示名字点哪个都是猜。
 */
export function buildWorkspaceImageOptions(
  documents: readonly IndexedDocument[],
  documentDirectory: string | null,
  workspaceRoot: string | null
): WorkspaceImageOption[] {
  if (!documentDirectory) return [];

  const images = documents.filter((document) => documentTypeForPath(document.path) === 'image');
  if (images.length === 0) return [];

  const nameCounts = new Map<string, number>();
  for (const document of images) {
    nameCounts.set(document.name, (nameCounts.get(document.name) ?? 0) + 1);
  }

  const options: WorkspaceImageOption[] = [];
  for (const document of images) {
    const relative = relativePathFrom(documentDirectory, document.path);
    if (relative === null) continue;

    // 全库只有这一个文件名时写裸名 —— Obsidian 也是这么写的，而且裸名最稳：
    // 文件跟着笔记一起搬走，引用不用改。
    const duplicated = (nameCounts.get(document.name) ?? 0) > 1;
    const fromRoot =
      workspaceRoot === null ? null : relativePathFrom(workspaceRoot, document.path);
    const wikiPath = duplicated
      ? (fromRoot ?? relative).replace(/\\/g, '/')
      : document.name;

    options.push({
      path: relative.replace(/\\/g, '/'),
      wikiPath,
      name: duplicated ? relative : document.name,
      url: toAssetUrl(document.path)
    });
  }

  options.sort((left, right) => left.name.localeCompare(right.name));
  return options;
}
