import { parseMarkdown, type MarkdownNode } from '@nexus/markdown';

export function detectEol(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

export interface AtomicNodeRange {
  from: number;
  to: number;
  type: string;
}

/**
 * Finds all atomic/opaque inline and block nodes that must not be sliced in half.
 * Traverses @nexus/markdown AST directly without regex duplication.
 */
export function findAtomicRanges(source: string): AtomicNodeRange[] {
  const { root } = parseMarkdown(source);
  const ranges: AtomicNodeRange[] = [];

  function walk(node: MarkdownNode) {
    if (!node) return;
    if (node.type === 'inline-code') {
      ranges.push({ from: node.range.from, to: node.range.to, type: 'inline-code' });
      return;
    }
    if (node.type === 'inline-math') {
      ranges.push({ from: node.range.from, to: node.range.to, type: 'inline-math' });
      return;
    }
    if (node.type === 'wikilink') {
      ranges.push({ from: node.range.from, to: node.range.to, type: 'wikilink' });
      return;
    }
    if (node.type === 'link') {
      ranges.push({ from: node.range.from, to: node.range.to, type: 'link' });
      return;
    }
    if (node.type === 'image') {
      ranges.push({ from: node.range.from, to: node.range.to, type: 'image' });
      return;
    }
    if (node.type === 'raw') {
      ranges.push({ from: node.range.from, to: node.range.to, type: 'raw' });
      return;
    }
    if (node.type === 'code-block') {
      ranges.push({ from: node.range.from, to: node.range.to, type: 'code-block' });
      return;
    }
    if (node.type === 'block-math') {
      ranges.push({ from: node.range.from, to: node.range.to, type: 'block-math' });
      return;
    }
    if (node.type === 'text' && node.escaped) {
      ranges.push({ from: node.range.from, to: node.range.to, type: 'escape' });
      return;
    }

    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children) {
        walk(child as MarkdownNode);
      }
    }
    if (node.type === 'list') {
      for (const item of node.items) {
        walk(item);
      }
    }
    if (node.type === 'table') {
      for (const row of node.headers) {
        for (const cell of row) walk(cell);
      }
      for (const row of node.rows) {
        for (const cellList of row) {
          for (const cell of cellList) walk(cell);
        }
      }
    }
  }

  walk(root);
  return ranges.sort((a, b) => a.from - b.from);
}

export interface FormattingSpan {
  from: number;
  to: number;
  open: string;
  close: string;
  type: 'strong' | 'emphasis' | 'strike';
}

/**
 * 读一段行内代码的围栏与内容边界。
 *
 * 围栏长度**必须从原文数反引号**：内容里含反引号时围栏会加长（`` ``a`b`` ``），
 * 按单个反引号去删就会删错、按单个反引号去包会写出坏语法。
 *
 * `open` / `close` 把**填充空格**算进去（CommonMark 里内容以反引号开头或结尾时
 * 要靠两侧空格把围栏与内容隔开，解析时那一对空格会被剥掉），所以
 * `from + open.length` 恒等于内容起点、`to - close.length` 恒等于内容终点 ——
 * 调用方不必再各判一次「有没有填充」。
 */
export function readInlineCodeFence(
  source: string,
  from: number,
  to: number
): { open: string; close: string; contentFrom: number; contentTo: number } {
  const raw = source.slice(from, to);
  const fence = /^`+/.exec(raw)?.[0] ?? '`';
  const inner = raw.length >= fence.length * 2 ? raw.slice(fence.length, raw.length - fence.length) : '';
  const padded =
    inner.length >= 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim().length > 0;
  const pad = padded ? ' ' : '';
  return {
    open: fence + pad,
    close: pad + fence,
    contentFrom: from + fence.length + pad.length,
    contentTo: to - fence.length - pad.length
  };
}

/** 把一个选区内容包成行内代码时要用的围栏：比内容里最长的一段反引号还长一位。 */
export function inlineCodeFenceFor(content: string): string {
  const runs = content.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(longest + 1);
}

/**
 * Extracts formatting spans from AST for bold and italic including alternative delimiters and nesting.
 */
export function findFormattingSpans(source: string): FormattingSpan[] {
  const { root } = parseMarkdown(source);
  const spans: FormattingSpan[] = [];

  function walk(node: MarkdownNode) {
    if (!node) return;
    if (node.type === 'bold') {
      const open = node.raw.startsWith('__') ? '__' : '**';
      const close = node.raw.endsWith('__') ? '__' : '**';
      spans.push({
        from: node.range.from,
        to: node.range.to,
        open,
        close,
        type: 'strong'
      });
      for (const child of node.children) {
        walk(child);
      }
      return;
    }
    if (node.type === 'italic') {
      const open = node.raw.startsWith('_') ? '_' : '*';
      const close = node.raw.endsWith('_') ? '_' : '*';
      spans.push({
        from: node.range.from,
        to: node.range.to,
        open,
        close,
        type: 'emphasis'
      });
      for (const child of node.children) {
        walk(child);
      }
      return;
    }
    if (node.type === 'strike') {
      const raw =
        typeof node.raw === 'string' && node.raw.length > 0
          ? node.raw
          : source && node.range
            ? source.slice(node.range.from, node.range.to)
            : '';
      const delim = raw.startsWith('~') && !raw.startsWith('~~') ? '~' : '~~';
      spans.push({
        from: node.range.from,
        to: node.range.to,
        open: delim,
        close: delim,
        type: 'strike'
      });
      for (const child of node.children) {
        walk(child);
      }
      return;
    }

    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children) {
        walk(child as MarkdownNode);
      }
    }
    if (node.type === 'list') {
      for (const item of node.items) {
        walk(item);
      }
    }
    if (node.type === 'table') {
      for (const row of node.headers) {
        for (const cell of row) walk(cell);
      }
      for (const row of node.rows) {
        for (const cellList of row) {
          for (const cell of cellList) walk(cell);
        }
      }
    }
  }

  walk(root);
  return spans.sort((a, b) => a.from - b.from);
}



