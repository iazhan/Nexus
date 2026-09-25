/**
 * 序列化入口：`serializeNode` 按节点类型分派，`serializeMarkdown` 负责整篇文档的
 * 块切片拼接（未改动部分逐字节保真，只重排改动的块）。
 */
import type {
  MarkdownInlineNode,
  MarkdownNode,
  MarkdownParseResult,
  MarkdownRoot
} from '../types.js';
import { isNodeDirty } from './dirty.js';
import { serializeInline } from './inline.js';
import { serializeBlock, serializeListItem } from './blocks.js';

export interface MarkdownSerializeOptions {
  /**
   * If true, forces reconstruction from AST rather than preserving raw slices.
   * Defaults to false.
   */
  forceReconstruct?: boolean;
}

/**
 * Serializes any AST node (root, block, inline, or list-item).
 */
export function serializeNode(
  node: MarkdownNode,
  options?: MarkdownSerializeOptions
): string {
  const force = options?.forceReconstruct ?? false;
  if ('type' in node) {
    if (node.type === 'root') {
      return serializeMarkdown(node, options);
    }
    if (node.type === 'list-item') {
      return serializeListItem(node, '- ', undefined, force);
    }
    if (
      node.type === 'heading' ||
      node.type === 'paragraph' ||
      node.type === 'blockquote' ||
      node.type === 'list' ||
      node.type === 'code-block' ||
      node.type === 'block-math' ||
      node.type === 'table' ||
      node.type === 'horizontal-rule' ||
      node.type === 'raw'
    ) {
      return serializeBlock(node, undefined, force);
    }
    return serializeInline(node as MarkdownInlineNode, undefined, force);
  }
  return '';
}

/**
 * Serializes a MarkdownParseResult or MarkdownRoot to Markdown string.
 *
 * Guarantees:
 * 1. Byte-for-byte round-trip fidelity when unmodified (`serializeMarkdown(parseMarkdown(source)) === source`).
 * 2. Partial editing support: preserves untouched block slices and original whitespace gaps.
 * 3. Full AST reconstruction when options.forceReconstruct is set.
 */
export function serializeMarkdown(
  document: MarkdownParseResult | MarkdownRoot,
  options?: MarkdownSerializeOptions
): string {
  const force = options?.forceReconstruct ?? false;

  const root: MarkdownRoot = 'root' in document ? document.root : document;
  const source: string | undefined = 'source' in document ? document.source : document.raw;

  // 1. Force reconstruction mode
  if (force) {
    const isCrlf = typeof source === 'string' && source.includes('\r\n');
    const newline = isCrlf ? '\r\n' : '\n';
    const blockSep = `${newline}${newline}`;
    const blockStrs = root.children.map((b) => serializeBlock(b, source, true));
    let out = '';
    for (let i = 0; i < blockStrs.length; i++) {
      const bStr = blockStrs[i]!;
      if (i > 0) {
        if (out.endsWith('\r\n\r\n') || out.endsWith('\n\n')) {
          // already separated
        } else if (out.endsWith('\r\n') || out.endsWith('\n')) {
          out += newline;
        } else {
          out += blockSep;
        }
      }
      out += bStr;
    }
    return out;
  }

  // 2. Fast-path: empty root or whitespace-only documents
  if (root.children.length === 0) {
    return source ?? '';
  }

  // 3. Check for byte-exact preservation when source is available and no node is dirty
  if (typeof source === 'string') {
    let allUntouched = true;
    let lastTo = 0;

    for (const b of root.children) {
      if (
        isNodeDirty(b, source) ||
        !b.range ||
        typeof b.range.from !== 'number' ||
        typeof b.range.to !== 'number' ||
        b.range.from < lastTo ||
        b.range.to > source.length ||
        b.raw !== source.slice(b.range.from, b.range.to)
      ) {
        allUntouched = false;
        break;
      }
      lastTo = b.range.to;
    }

    if (allUntouched) {
      return source;
    }

    // 4. Partial-editing mode:
    // Retains untouched block slices and inter-block whitespace, while serializing modified blocks
    let out = '';
    let curOffset = 0;

    for (const b of root.children) {
      const isDirty = isNodeDirty(b, source);
      const isUntouched =
        !isDirty &&
        b.range &&
        typeof b.range.from === 'number' &&
        typeof b.range.to === 'number' &&
        b.range.from >= curOffset &&
        b.range.to <= source.length &&
        b.raw === source.slice(b.range.from, b.range.to);

      if (isUntouched) {
        // Retain original preceding gap/newlines
        out += source.slice(curOffset, b.range.from);
        // Retain exact raw block content
        out += b.raw;
        curOffset = b.range.to;
      } else {
        // Block is modified or synthesized
        if (
          b.range &&
          typeof b.range.from === 'number' &&
          b.range.from >= curOffset &&
          b.range.from <= source.length
        ) {
          // Preceding gap from original source before this block
          out += source.slice(curOffset, b.range.from);
          out += serializeBlock(b, source, false);
          if (typeof b.range.to === 'number' && b.range.to >= b.range.from && b.range.to <= source.length) {
            curOffset = b.range.to;
          }
        } else {
          // Completely new block without an original position
          if (curOffset > 0 && !out.endsWith('\n\n') && !out.endsWith('\r\n\r\n')) {
            const isCRLF = source.includes('\r\n');
            out += isCRLF ? '\r\n\r\n' : '\n\n';
          }
          out += serializeBlock(b, source, false);
        }
      }
    }

    // Retain trailing suffix (blank lines, trailing comments, etc.)
    if (curOffset < source.length) {
      out += source.slice(curOffset);
    }

    return out;
  }

  // 5. Fallback if no original source is available
  return root.children.map((b) => serializeBlock(b, undefined, false)).join('\n\n');
}
