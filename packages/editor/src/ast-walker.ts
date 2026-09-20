import type { MarkdownBlockNode } from '@nexus/markdown';

/**
 * 递归遍历 AST 块级节点树。
 * 支持深度遍历 blockquote 及 list items 中的所有块级子节点。
 * 当 visitor 返回 true 时提前终止遍历。
 */
export function walkBlockNodes(
  blocks: MarkdownBlockNode[],
  visitor: (block: MarkdownBlockNode) => boolean | void
): boolean {
  for (const block of blocks) {
    if (visitor(block) === true) return true;
    if (block.type === 'blockquote') {
      if (walkBlockNodes(block.children, visitor)) return true;
    } else if (block.type === 'list') {
      for (const item of block.items) {
        const itemBlocks = item.children.filter((c): c is MarkdownBlockNode =>
          c.type === 'paragraph' ||
          c.type === 'heading' ||
          c.type === 'blockquote' ||
          c.type === 'list' ||
          c.type === 'code-block' ||
          c.type === 'block-math' ||
          c.type === 'table' ||
          c.type === 'raw' ||
          c.type === 'horizontal-rule'
        );
        if (walkBlockNodes(itemBlocks, visitor)) return true;
      }
    }
  }
  return false;
}
