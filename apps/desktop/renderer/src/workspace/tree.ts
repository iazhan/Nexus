import type { IndexedDocument } from '@nexus/core';

/**
 * 文件树节点。
 *
 * 目录节点**没有绝对路径** —— 索引里只有文件，目录是相对路径里推出来的，
 * 它不对应磁盘上的一个实体。展开/折叠只需要 `relativePath` 当 key，
 * 别为了「统一」给目录编一个假路径出来。
 */
export interface FileTreeNode {
  name: string;
  relativePath: string;
  type: 'file' | 'directory';
  /** 文件节点的绝对路径；目录节点为 null */
  path: string | null;
  children: FileTreeNode[];
}

/**
 * 把扁平的文档列表还原成层级树。
 *
 * 索引里存的是 `notes/deep/a.md` 这样的相对路径，树的形状完全由它推导 ——
 * 所以**不需要额外记录目录**，删掉索引重建后树也一样（这是「索引是派生数据」的直接体现）。
 *
 * 排序：目录在前、文件在后，同类按名称（`localeCompare`，对中文也合理）。
 */
export function buildFileTree(documents: readonly IndexedDocument[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];

  for (const document of documents) {
    const segments = document.relativePath.split('/').filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;

    let siblings = roots;
    let relativeSoFar = '';

    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index]!;
      const isLeaf = index === segments.length - 1;
      relativeSoFar = relativeSoFar.length > 0 ? `${relativeSoFar}/${name}` : name;

      let node = siblings.find(
        (candidate) => candidate.name === name && candidate.type === (isLeaf ? 'file' : 'directory')
      );

      if (!node) {
        node = {
          name,
          relativePath: relativeSoFar,
          type: isLeaf ? 'file' : 'directory',
          path: isLeaf ? document.path : null,
          children: []
        };
        siblings.push(node);
      }

      siblings = node.children;
    }
  }

  sortTree(roots);
  return roots;
}

/** 目录优先，同类按名称。就地排序。 */
function sortTree(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const node of nodes) {
    sortTree(node.children);
  }
}

/**
 * 默认展开的目录集合：只有顶层。
 *
 * 全部展开在稍大的库里会淹掉整个面板，全部折叠又要点很多次才看到内容 ——
 * 顶层展开是两者之间最省事的默认值。
 */
export function defaultExpandedDirectories(tree: readonly FileTreeNode[]): Set<string> {
  const expanded = new Set<string>();
  for (const node of tree) {
    if (node.type === 'directory') expanded.add(node.relativePath);
  }
  return expanded;
}
