/**
 * 脏标记判定。
 *
 * `isCellDirty` / `isNodeDirty` / `hasDirtyChildren` 三者**互相递归**（判断一个节点是否
 * 脏要看子节点，判断子节点又要看它的子节点），构成一个强连通分量，必须留在同一个模块里。
 *
 * `markDirty` 是唯一的写入口；其余三个都是只读判定。
 */
import type { MarkdownInlineNode, MarkdownNode } from '../types.js';

/**
 * Marks a node as dirty, signaling to the serializer that it or its descendants
 * have been modified and must be re-serialized rather than using cached raw text.
 */
export function markDirty(node: MarkdownNode): void {
  node.dirty = true;
  node.modified = true;
}

/**
 * Checks whether a table cell (an array of inline nodes or an inline node) is dirty.
 */
export function isCellDirty(cell: MarkdownInlineNode[] | unknown, source?: string): boolean {
  if (!cell) return false;
  if (Array.isArray(cell)) {
    if ((cell as { dirty?: boolean; modified?: boolean }).dirty === true || (cell as { dirty?: boolean; modified?: boolean }).modified === true) {
      return true;
    }
    return cell.some((node) => isNodeDirty(node, source));
  }
  return isNodeDirty(cell as MarkdownNode, source);
}

/**
 * Recursively checks whether an AST node or any of its descendants has been modified.
 */
export function isNodeDirty(node: MarkdownNode, source?: string): boolean {
  if (node.dirty === true || node.modified === true) {
    return true;
  }

  if (typeof node.raw !== 'string' || node.raw.length === 0) {
    return true;
  }

  if (typeof source === 'string' && node.range) {
    if (
      typeof node.range.from !== 'number' ||
      typeof node.range.to !== 'number' ||
      node.range.from < 0 ||
      node.range.to > source.length ||
      node.range.from > node.range.to ||
      node.raw !== source.slice(node.range.from, node.range.to)
    ) {
      return true;
    }
  }

  return hasDirtyChildren(node, source);
}

/**
 * 检查节点的子孙节点是否被标记修改或数据脏化
 */
export function hasDirtyChildren(node: MarkdownNode, source?: string): boolean {
  if ('children' in node && Array.isArray(node.children)) {
    if (node.children.some((c) => isNodeDirty(c, source))) {
      return true;
    }
  }
  if ('items' in node && Array.isArray(node.items)) {
    if (node.items.some((item) => isNodeDirty(item, source))) {
      return true;
    }
  }
  if (node.type === 'table') {
    if (
      node.headers.some((cell) => isCellDirty(cell, source)) ||
      node.rows.some((row) => row.some((cell) => isCellDirty(cell, source)))
    ) {
      return true;
    }
  }
  return false;
}

