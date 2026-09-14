import type {
  MarkdownBlockNode,
  MarkdownInlineNode,
  MarkdownRoot
} from './types.js';

/**
 * Extracts plain text from an array of inline or block nodes.
 */
export function extractTextContent(
  nodes: (MarkdownInlineNode | MarkdownBlockNode)[]
): string {
  let result = '';

  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'inline-code':
      case 'raw':
        result += node.value;
        break;
      case 'bold':
      case 'italic':
        result += extractTextContent(node.children);
        break;
      case 'link':
        result += extractTextContent(node.children);
        break;
      case 'image':
        result += node.alt;
        break;
      case 'inline-math':
        result += node.raw;
        break;
      case 'wikilink':
        result += node.alias ?? node.target;
        break;
      case 'heading':
      case 'paragraph':
        result += extractTextContent(node.children) + '\n';
        break;
      case 'blockquote':
        result += extractTextContent(node.children);
        break;
      case 'list':
        for (const item of node.items) {
          result += extractTextContent(item.children) + '\n';
        }
        break;
      case 'code-block':
        result += node.value + '\n';
        break;
      case 'block-math':
        result += node.raw + '\n';
        break;
      case 'table':
        for (const headerRow of node.headers) {
          result += extractTextContent(headerRow) + ' ';
        }
        result += '\n';
        for (const row of node.rows) {
          for (const cell of row) {
            result += extractTextContent(cell) + ' ';
          }
          result += '\n';
        }
        break;
    }
  }

  return result;
}

/**
 * Counts the total number of block and inline nodes in a Markdown root.
 */
export function countNodes(root: MarkdownRoot): number {
  let count = 0;

  function countInline(nodes: MarkdownInlineNode[]) {
    for (const node of nodes) {
      count++;
      if ('children' in node && Array.isArray(node.children)) {
        countInline(node.children);
      }
    }
  }

  function countBlock(nodes: MarkdownBlockNode[]) {
    for (const node of nodes) {
      count++;
      if (node.type === 'heading' || node.type === 'paragraph') {
        countInline(node.children);
      } else if (node.type === 'blockquote') {
        countBlock(node.children);
      } else if (node.type === 'list') {
        for (const item of node.items) {
          count++;
          for (const child of item.children) {
            if ('depth' in child || 'items' in child || child.type === 'blockquote' || child.type === 'code-block' || child.type === 'block-math' || child.type === 'table') {
              countBlock([child as MarkdownBlockNode]);
            } else {
              countInline([child as MarkdownInlineNode]);
            }
          }
        }
      } else if (node.type === 'table') {
        for (const h of node.headers) countInline(h);
        for (const r of node.rows) {
          for (const c of r) countInline(c);
        }
      }
    }
  }

  countBlock(root.children);
  return count;
}
