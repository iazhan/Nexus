import { documentTypeForPath, relativePathFrom, type IndexedDocument } from '@nexus/core';
import type { WorkspaceAssetEntry } from '@nexus/editor';

/**
 * 把索引里的图片转成**同步可查**的工作区资源清单，供 `![[…]]` 的回退解析。
 *
 * 为什么需要这张清单：投影是同步的，而 Obsidian 的嵌入解析要问「这个候选路径存在吗」——
 * 存在性只有宿主知道。清单递进去之后，解析就退化成纯字符串比较，不需要再回主进程。
 *
 * 三件事在这一层定死：
 * - **筛图片**：复用 `documentTypeForPath` 白名单，不另抄一份扩展名表。清单只服务图片嵌入，
 *   全量文档会让索引里每篇笔记都白占一份。
 * - **`relative` 是工作区根相对**（正斜杠）：Obsidian 往 `![[…]]` 里写的就是这个形状，
 *   直接拿它当键做精确匹配。跨卷时 `relativePathFrom` 返回 `null`，那一项丢掉。
 * - **`path` 保持绝对**：清单命中后由编辑器拼 `nexus-asset://`，宿主不需要先算 URL ——
 *   一张清单配一个文档目录，能覆盖打开的所有文档。
 */
export function buildWorkspaceAssetEntries(
  documents: readonly IndexedDocument[],
  workspaceRoot: string | null
): WorkspaceAssetEntry[] {
  if (!workspaceRoot) return [];

  const entries: WorkspaceAssetEntry[] = [];
  for (const document of documents) {
    if (documentTypeForPath(document.path) !== 'image') continue;
    const relative = relativePathFrom(workspaceRoot, document.path);
    if (relative === null) continue;
    entries.push({
      path: document.path,
      relative: relative.replace(/\\/g, '/'),
      name: document.name
    });
  }
  return entries;
}
