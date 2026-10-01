import { isImageNode, type FileTreeNode } from './tree.js';

export interface ImageFilterResult {
  nodes: FileTreeNode[];
  /** 被藏起来的图片数。用来区分「工作区本来就是空的」与「被过滤器滤空了」。 */
  hiddenImageCount: number;
}

/**
 * 按「显示图片」这个开关过滤树。**只过滤图片**，PDF / DOCX 照常显示。
 *
 * ## 为什么只藏图片
 *
 * 这一栏的意图是「树被图淹了」—— 一个 vault 里几十张截图平铺在笔记中间，扫一眼全是
 * 缩略名。而 PDF / DOCX 在同一个 vault 里通常是个位数、且往往正是要找的东西
 * （手册、规格书），把它们一起藏起来只会让人以为文件丢了。
 *
 * Markra 也是这么切的：`fileTreeAssetsVisible` 判的是 `file.kind === 'asset'`，
 * 而 asset 就是图片；attachment 走另一套「托管目录」规则，不受这个开关影响。
 *
 * ## 因过滤才变空的目录**丢掉**，本来就空的目录**保留**
 *
 * 这两种「空」看起来一样，含义完全不同：
 *
 * - `assets/` 里有 50 张图，关掉图片之后它空了 —— 留着的话用户看到一个空目录，
 *   而里面其实有东西，那是**界面在说谎**。丢掉它。
 * - 一个刚建好、还没放东西的 `素材/` 本来就空 —— 它没藏过任何东西，留着，
 *   用户正要往里放东西。
 *
 * 判据就是「这个子树里有没有藏过图片」。Markra 的 `filterMarkdownFileTreeAssets`
 * 用 `nodes.length > 0 || !hiddenAssetFound` 决定去留，是同一件事；
 * OpenKnowledge 更直接 —— 目录路径只由存活下来的文档推导，被过滤空的目录根本不进树。
 */
export function filterTreeByImageVisibility(
  nodes: readonly FileTreeNode[],
  showImages: boolean
): ImageFilterResult {
  if (showImages) return { nodes: nodes as FileTreeNode[], hiddenImageCount: 0 };
  return filterNodes(nodes);
}

function filterNodes(nodes: readonly FileTreeNode[]): ImageFilterResult {
  const kept: FileTreeNode[] = [];
  let hiddenImageCount = 0;

  for (const node of nodes) {
    if (node.type === 'file') {
      if (isImageNode(node)) {
        hiddenImageCount += 1;
        continue;
      }
      kept.push(node);
      continue;
    }

    const children = filterNodes(node.children);
    hiddenImageCount += children.hiddenImageCount;

    // 里面有东西 → 留；里面空但**没藏过图片**（本来就是空的）→ 也留；
    // 里面空且藏过图片（因过滤才变空）→ 丢。
    if (children.nodes.length > 0 || children.hiddenImageCount === 0) {
      kept.push({ ...node, children: children.nodes });
    }
  }

  return { nodes: kept, hiddenImageCount };
}
