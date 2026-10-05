/**
 * 行内序列化。`serializeInlines` / `serializeInline` 互相递归（容器节点的子节点还要走行内规则）。
 */
import type { MarkdownInlineNode } from '../types.js';
import { hasDirtyChildren, isNodeDirty } from './dirty.js';

/**
 * Serializes an array of inline nodes to Markdown text, preserving untouched child slices.
 */
export function serializeInlines(
  nodes: MarkdownInlineNode[],
  sourceOrForce?: string | boolean,
  forceReconstruct = false
): string {
  const source = typeof sourceOrForce === 'string' ? sourceOrForce : undefined;
  const force = typeof sourceOrForce === 'boolean' ? sourceOrForce : forceReconstruct;

  return nodes
    .map((n) => {
      if (!force && !isNodeDirty(n, source)) {
        return n.raw;
      }
      return serializeInline(n, source, force);
    })
    .join('');
}

/**
 * Serializes a single inline node to Markdown text, preserving original delimiter styles (__ vs **).
 */
export function serializeInline(
  node: MarkdownInlineNode,
  sourceOrForce?: string | boolean,
  forceReconstruct = false
): string {
  const source = typeof sourceOrForce === 'string' ? sourceOrForce : undefined;
  const force = typeof sourceOrForce === 'boolean' ? sourceOrForce : forceReconstruct;

  if (!force && !isNodeDirty(node, source)) {
    return node.raw;
  }

  // If node's raw was modified directly without dirty/modified flags,
  // and no dirty children exist, return the node's updated raw.
  if (
    !force &&
    node.dirty !== true &&
    node.modified !== true &&
    typeof node.raw === 'string' &&
    node.raw.length > 0 &&
    !hasDirtyChildren(node, source)
  ) {
    return node.raw;
  }

  switch (node.type) {
    case 'text':
      if ((node as { escaped?: boolean }).escaped) {
        return `\\${node.value}`;
      }
      return node.value;
    case 'bold': {
      const delim = typeof node.raw === 'string' && node.raw.startsWith('__') ? '__' : '**';
      return `${delim}${serializeInlines(node.children, source, force)}${delim}`;
    }
    case 'italic': {
      const delim = typeof node.raw === 'string' && node.raw.startsWith('_') ? '_' : '*';
      return `${delim}${serializeInlines(node.children, source, force)}${delim}`;
    }
    case 'strike': {
      const raw =
        typeof node.raw === 'string' && node.raw.length > 0
          ? node.raw
          : source && node.range
            ? source.slice(node.range.from, node.range.to)
            : '';
      const delim = raw.startsWith('~') && !raw.startsWith('~~') ? '~' : '~~';
      return `${delim}${serializeInlines(node.children, source, force)}${delim}`;
    }
    case 'highlight': {
      return `==${serializeInlines(node.children, source, force)}==`;
    }
    case 'inline-code': {
      if (node.value.length === 0) {
        return '';
      }
      const raw =
        typeof node.raw === 'string' && node.raw.length > 0
          ? node.raw
          : source && node.range
            ? source.slice(node.range.from, node.range.to)
            : '';

      const openMatch = raw.match(/^`+/);
      const origDelimLen = openMatch ? openMatch[0].length : 1;
      const fenceStr = openMatch ? openMatch[0] : '`';
      const origInner =
        openMatch && raw.endsWith(fenceStr) && raw.length >= origDelimLen * 2
          ? raw.slice(origDelimLen, raw.length - origDelimLen)
          : '';
      const origHadPadding =
        origInner.length >= 2 &&
        origInner.startsWith(' ') &&
        origInner.endsWith(' ') &&
        origInner.trim().length > 0;

      // Find all consecutive backtick runs in new value
      const backtickRuns = new Set<number>();
      for (const m of node.value.matchAll(/`+/g)) {
        backtickRuns.add(m[0].length);
      }

      // Minimum delimiter length: must be >= origDelimLen and not appear in value
      let delimLen = Math.max(origDelimLen, 1);
      while (backtickRuns.has(delimLen)) {
        delimLen++;
      }
      const fence = '`'.repeat(delimLen);

      // In CommonMark, code span padding is required if value starts/ends with a backtick,
      // or if it has leading/trailing spaces, or if original raw had space padding.
      let needsPadding = false;
      if (node.value.startsWith('`') || node.value.endsWith('`')) {
        needsPadding = true;
      } else if (
        (node.value.startsWith(' ') || node.value.endsWith(' ')) &&
        node.value.trim().length > 0
      ) {
        needsPadding = true;
      } else if (origHadPadding) {
        needsPadding = true;
      }

      if (needsPadding) {
        return `${fence} ${node.value} ${fence}`;
      }
      return `${fence}${node.value}${fence}`;
    }
    case 'link': {
      const titleAttr = node.title ? ` "${node.title}"` : '';
      return `[${serializeInlines(node.children, source, force)}](${node.href}${titleAttr})`;
    }
    case 'image': {
      const titleAttr = node.title ? ` "${node.title}"` : '';
      return `![${node.alt}](${node.src}${titleAttr})`;
    }
    case 'inline-math':
      return `$${node.formula}$`;
    case 'wikilink':
      return node.alias
        ? `[[${node.target}|${node.alias}]]`
        : `[[${node.target}]]`;
    case 'raw':
      return node.value;
  }
}

