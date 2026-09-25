import {
  parseMarkdown,
  type MarkdownInlineNode,
  type MarkdownRoot
} from '@nexus/markdown';
import type { InlineEditNodeType } from './types.js';

export function findInlineNodeAtRange(
  root: MarkdownRoot,
  type: InlineEditNodeType,
  range: { from: number; to: number }
): MarkdownInlineNode | null {
  let match: MarkdownInlineNode | null = null;

  function walk(node: unknown): void {
    if (!node || typeof node !== 'object' || match) return;
    const n = node as Record<string, unknown>;
    const nodeRange = n.range as { from: number; to: number } | undefined;
    if (
      nodeRange &&
      nodeRange.from === range.from &&
      nodeRange.to === range.to &&
      n.type === type
    ) {
      match = node as MarkdownInlineNode;
      return;
    }
    if (Array.isArray(n.children)) {
      for (const child of n.children) walk(child);
    }
    if (n.type === 'list' && Array.isArray(n.items)) {
      for (const item of n.items) walk(item);
    }
    if (n.type === 'table') {
      if (Array.isArray(n.headers)) {
        for (const row of n.headers) if (Array.isArray(row)) for (const c of row) walk(c);
      }
      if (Array.isArray(n.rows)) {
        for (const row of n.rows) if (Array.isArray(row)) for (const cList of row) if (Array.isArray(cList)) for (const c of cList) walk(c);
      }
    }
  }

  walk(root);
  return match;
}

export function verifyCandidateNode(
  source: string,
  from: number,
  to: number,
  expectedType: InlineEditNodeType,
  expectedRaw: string,
  semanticValidator?: (node: MarkdownInlineNode) => boolean
): boolean {
  try {
    const { root } = parseMarkdown(source);
    let matchedNode: MarkdownInlineNode | null = null;
    let hasConflictingNode = false;

    function walk(node: unknown): void {
      if (!node || typeof node !== 'object' || hasConflictingNode) return;
      const n = node as Record<string, unknown>;
      const r = n.range as { from: number; to: number } | undefined;
      if (r) {
        if (r.from === from && r.to === to && n.type === expectedType) {
          if (matchedNode) {
            hasConflictingNode = true;
            return;
          }
          matchedNode = n as unknown as MarkdownInlineNode;
        } else if (r.from < to && r.to > from) {
          const isAncestor = r.from <= from && r.to >= to;
          const isDescendant = r.from >= from && r.to <= to;
          if (!isAncestor && !isDescendant) {
            hasConflictingNode = true;
            return;
          }
        }
      }

      if (Array.isArray(n.children)) {
        for (const c of n.children) walk(c);
      }
      if (n.type === 'list' && Array.isArray(n.items)) {
        for (const item of n.items) walk(item);
      }
      if (n.type === 'table') {
        if (Array.isArray(n.headers)) {
          for (const row of n.headers) if (Array.isArray(row)) for (const c of row) walk(c);
        }
        if (Array.isArray(n.rows)) {
          for (const row of n.rows) if (Array.isArray(row)) for (const cList of row) if (Array.isArray(cList)) for (const c of cList) walk(c);
        }
      }
    }

    walk(root);

    if (
      !matchedNode ||
      hasConflictingNode ||
      (matchedNode as MarkdownInlineNode).raw !== expectedRaw
    ) {
      return false;
    }

    if (semanticValidator && !semanticValidator(matchedNode)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

