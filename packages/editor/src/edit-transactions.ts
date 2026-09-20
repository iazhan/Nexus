import {
  parseMarkdown,
  type MarkdownBlockNode,
  type MarkdownListItem,
  type MarkdownRoot,
  type MarkdownNode
} from '@nexus/markdown';
import { createMarkdownChangeSet, mapMarkdownSelection } from './document-session.js';
import type { MarkdownEditTransaction, MarkdownSelection } from './types.js';

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



interface LineInfo {
  text: string;
  from: number;
  to: number;
  number: number;
}

function getLineAt(source: string, pos: number): LineInfo {
  let lineStart = 0;
  let lineNumber = 1;
  while (lineStart < source.length) {
    const lf = source.indexOf('\n', lineStart);
    const lineEnd = lf === -1 ? source.length : (source[lf - 1] === '\r' ? lf - 1 : lf);
    const nextStart = lf === -1 ? source.length : lf + 1;

    if (pos >= lineStart && pos <= (lf === -1 ? source.length : lf)) {
      return {
        text: source.slice(lineStart, lineEnd),
        from: lineStart,
        to: lineEnd,
        number: lineNumber
      };
    }

    lineStart = nextStart;
    lineNumber++;
  }

  return {
    text: '',
    from: source.length,
    to: source.length,
    number: lineNumber
  };
}

export function parseLines(source: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let lineStart = 0;
  let num = 1;

  while (lineStart <= source.length) {
    const lf = source.indexOf('\n', lineStart);
    const lineEnd = lf === -1 ? source.length : (source[lf - 1] === '\r' ? lf - 1 : lf);
    lines.push({
      text: source.slice(lineStart, lineEnd),
      from: lineStart,
      to: lineEnd,
      number: num++
    });
    if (lf === -1) break;
    lineStart = lf + 1;
  }

  return lines;
}

/**
 * 根据文档位置在 AST 根节点列表中查找包含该位置的顶级块索引。
 */
export function findContainingBlockIndex(root: MarkdownRoot, pos: number, sourceLength: number): number {
  for (let i = 0; i < root.children.length; i++) {
    const block = root.children[i]!;
    const nextBlock = root.children[i + 1];
    const boundary = nextBlock ? nextBlock.range.from : sourceLength;
    if (pos >= block.range.from && pos < boundary) {
      return i;
    }
  }
  if (root.children.length > 0 && pos === sourceLength) {
    return root.children.length - 1;
  }
  return -1;
}

/**
 * 根据文档位置查找包含该位置的顶级块节点。
 */
export function findContainingBlock(root: MarkdownRoot, pos: number, sourceLength: number): MarkdownBlockNode | null {
  const index = findContainingBlockIndex(root, pos, sourceLength);
  return index >= 0 ? root.children[index]! : null;
}

/**
 * 计算 AST 节点正文结束位置，排除末尾自带的换行符（如 heading、list 在 AST 范围包含末尾 \n），
 * 同时保留行尾空格（如两个空格硬换行）等全部正文切片。
 */
export function getContentEnd(source: string, range: { from: number; to: number }): number {
  let to = range.to;
  while (to > range.from && (source[to - 1] === '\n' || source[to - 1] === '\r')) {
    to--;
  }
  return to;
}

function isBlockNode(node: MarkdownNode): node is MarkdownBlockNode {
  const t = node.type;
  return (
    t === 'paragraph' ||
    t === 'heading' ||
    t === 'blockquote' ||
    t === 'list' ||
    t === 'code-block' ||
    t === 'table' ||
    t === 'block-math' ||
    t === 'raw' ||
    t === 'horizontal-rule'
  );
}

export interface BlockContext {
  /** 当前命中的最深可编辑 block 节点 */
  node: MarkdownBlockNode | MarkdownListItem;
  /** 从 root 到当前 node 的完整 AST 路径 */
  path: (MarkdownRoot | MarkdownBlockNode | MarkdownListItem)[];
  /** 当前 node 所属的直接父容器 */
  parent: MarkdownRoot | MarkdownBlockNode | MarkdownListItem;
  /** 父容器内的同级 block 列表 */
  siblings: (MarkdownBlockNode | MarkdownListItem)[];
  /** 当前 node 在 siblings 列表中的索引 */
  index: number;
}

/**
 * 根据 source position 深入 AST 树，找到最深的可编辑 block 及其父容器与上下文。
 *
 * 支持容器：
 * - root children
 * - blockquote children
 * - list item children 中的 block
 * - nested blockquote
 * - nested list item 内的 block
 * - 多层 list / blockquote 组合
 */
export function findDeepestBlockAtPos(
  root: MarkdownRoot,
  pos: number,
  sourceOrLength: string | number
): BlockContext | null {
  const source = typeof sourceOrLength === 'string' ? sourceOrLength : null;
  const sourceLength: number = typeof sourceOrLength === 'string' ? sourceOrLength.length : sourceOrLength;

  if (root.children.length === 0) return null;
  if (pos < 0 || pos >= sourceLength) return null;

  function getNodeEnd(node: MarkdownNode): number {
    if (source !== null) {
      return getContentEnd(source, node.range);
    }
    return node.range.to;
  }

  let currentParent: MarkdownRoot | MarkdownBlockNode | MarkdownListItem = root;
  let currentSiblings: (MarkdownBlockNode | MarkdownListItem)[] = root.children;
  const currentPath: (MarkdownRoot | MarkdownBlockNode | MarkdownListItem)[] = [root];

  while (true) {
    let foundIndex = -1;
    for (let i = 0; i < currentSiblings.length; i++) {
      const node = currentSiblings[i]!;
      const from = node.range.from;
      let to = getNodeEnd(node);
      if (node.type === 'list-item' && node.children.length > 0) {
        to = getNodeEnd(node.children[node.children.length - 1]!);
      }

      if (pos >= from && pos < to) {
        foundIndex = i;
        break;
      }
    }

    if (foundIndex === -1) {
      // 当前层级所有兄弟节点均不包含 pos（即 pos 处于 gap 或超出范围）
      return null;
    }

    const currentNode = currentSiblings[foundIndex]!;
    currentPath.push(currentNode);

    // 检查是否能向更深层容器下潜
    if (currentNode.type === 'blockquote') {
      if (currentNode.children.length > 0) {
        currentParent = currentNode;
        currentSiblings = currentNode.children;
        continue;
      }
      return null;
    }

    if (currentNode.type === 'list') {
      if (currentNode.items.length > 0) {
        currentParent = currentNode;
        currentSiblings = currentNode.items;
        continue;
      }
      return null;
    }

    if (currentNode.type === 'list-item') {
      const childBlocks = currentNode.children.filter(isBlockNode);
      if (childBlocks.length > 0) {
        let matchedChildIndex = -1;
        for (let k = 0; k < childBlocks.length; k++) {
          const cb = childBlocks[k]!;
          const cbFrom = cb.range.from;
          const cbTo = getNodeEnd(cb);
          if (pos >= cbFrom && pos <= cbTo) {
            matchedChildIndex = k;
            break;
          }
        }
        if (matchedChildIndex !== -1) {
          currentParent = currentNode;
          currentSiblings = childBlocks;
          continue;
        }
        return null;
      }

      return {
        node: currentNode,
        path: currentPath,
        parent: currentParent,
        siblings: currentSiblings,
        index: foundIndex
      };
    }

    return {
      node: currentNode,
      path: currentPath,
      parent: currentParent,
      siblings: currentSiblings,
      index: foundIndex
    };
  }
}


export function getQuotePrefixLength(lineText: string, quoteDepth: number): number {
  if (quoteDepth <= 0) return 0;
  let count = 0;
  let idx = 0;
  while (idx < lineText.length && count < quoteDepth) {
    while (idx < lineText.length && (lineText[idx] === ' ' || lineText[idx] === '\t')) {
      idx++;
    }
    if (idx < lineText.length && lineText[idx] === '>') {
      idx++;
      count++;
    } else {
      break;
    }
  }
  if (count === quoteDepth && idx < lineText.length && lineText[idx] === ' ') {
    idx++;
  }
  return idx;
}

export interface ListItemContext {
  item: MarkdownListItem;
  parentList: MarkdownBlockNode & { type: 'list' };
  parentItem: MarkdownListItem | null;
  itemIndex: number;
  quoteDepth: number;
}

/**
 * 基于 Markdown AST 递归查找光标或偏移量所在的列表项上下文，支持任意层级的 blockquote 和 list 互相嵌套。
 */
export function findListItemAtPos(root: MarkdownRoot, pos: number): ListItemContext | null {
  let deepestContext: ListItemContext | null = null;
  let maxDepth = -1;

  function traverseBlocks(
    nodes: readonly MarkdownNode[],
    parentList: (MarkdownBlockNode & { type: 'list' }) | null,
    parentItem: MarkdownListItem | null,
    quoteDepth: number,
    depth: number
  ) {
    for (const node of nodes) {
      if (node.type === 'list') {
        for (let i = 0; i < node.items.length; i++) {
          const item = node.items[i]!;
          const nextItem = node.items[i + 1];
          const isInsideItem = nextItem
            ? (pos >= item.range.from && pos < nextItem.range.from)
            : (pos >= item.range.from && pos <= item.range.to);

          if (isInsideItem) {
            if (depth >= maxDepth) {
              maxDepth = depth;
              deepestContext = {
                item,
                parentList: node,
                parentItem,
                itemIndex: i,
                quoteDepth
              };
            }
            // 递归遍历该 item 内部的子块（包括嵌套的 list、blockquote 等）
            traverseBlocks(item.children, node, item, quoteDepth, depth + 1);
          }
        }
      } else if (node.type === 'blockquote') {
        traverseBlocks(node.children, parentList, parentItem, quoteDepth + 1, depth + 1);
      }
    }
  }

  traverseBlocks(root.children, null, null, 0, 0);
  return deepestContext;
}

/**
 * Creates a transaction to handle Enter in Visual Mode:
 * - Splits paragraph into two blocks or creates empty blocks at bounds
 * - Splits headings, turning right side into normal paragraph
 * - Splits list items or exits list if empty
 * - Splits inside blockquotes or exits blockquote if empty
 * - Preserves formatting continuity across block boundaries
 * - Does not slice atomic inline nodes
 * - Returns null inside non-editable blocks (code, table, math, raw)
 */
export function createParagraphOrHeadingSplitTransaction(
  source: string,
  selection: MarkdownSelection
): MarkdownEditTransaction | null {
  const pos = selection.head;
  const { root } = parseMarkdown(source);
  const targetBlock = findContainingBlock(root, pos, source.length);

  if (!targetBlock) return null;
  if (
    targetBlock.type === 'code-block' ||
    targetBlock.type === 'table' ||
    targetBlock.type === 'block-math' ||
    targetBlock.type === 'raw'
  ) {
    return null;
  }

  const eol = detectEol(source);
  const blockSep = eol + eol;

  // Check if position is inside an atomic node
  const atomicRanges = findAtomicRanges(source);
  let targetPos = pos;
  for (const range of atomicRanges) {
    if (pos > range.from && pos < range.to) {
      targetPos = range.to;
      break;
    }
  }

  const line = getLineAt(source, targetPos);

  // 1. Check if inside a list item (powered by AST)
  const listContext = findListItemAtPos(root, targetPos);
  if (listContext) {
    const quotePrefixLen = getQuotePrefixLength(line.text, listContext.quoteDepth);
    const quotePrefix = line.text.slice(0, quotePrefixLen);
    const afterQuote = line.text.slice(quotePrefixLen);
    const indentMatch = afterQuote.match(/^[ \t]*/);
    const indent = indentMatch ? indentMatch[0] : '';
    const afterIndent = afterQuote.slice(indent.length);

    const markerMatch = listContext.parentList.ordered
      ? afterIndent.match(/^(\d+[.)])([ \t]+)/)
      : afterIndent.match(/^([*+-])([ \t]+)/);

    if (markerMatch) {
      const fullMarker = markerMatch[1]!;
      const afterMarker = afterIndent.slice(markerMatch[0].length);

      const isTask = listContext.item.task === true;
      let taskPrefix = '';
      let content = afterMarker;
      if (isTask) {
        const taskMatch = afterMarker.match(/^\[([ xX])\]([ \t]+)/);
        if (taskMatch) {
          taskPrefix = taskMatch[0];
          content = afterMarker.slice(taskPrefix.length);
        }
      }

      // Check if empty item: content is empty and cursor is at/after marker
      if (
        content.trim().length === 0 &&
        targetPos >= line.from + quotePrefixLen + indent.length + fullMarker.length
      ) {
        const removeStart = line.from + quotePrefixLen + indent.length;
        const removeEnd = line.to;
        return {
          changes: [{ from: removeStart, to: removeEnd, insert: '' }],
          selection: { anchor: removeStart, head: removeStart },
          userEvent: 'list.exit'
        };
      }

      // Non-empty item: split
      let newMarker = fullMarker;
      if (listContext.parentList.ordered) {
        const numMatch = fullMarker.match(/^(\d+)([.)])$/);
        if (numMatch) {
          const nextNum = parseInt(numMatch[1]!, 10) + 1;
          newMarker = `${nextNum}${numMatch[2]}`;
        }
      }
      const newCheckbox = isTask ? '[ ] ' : '';
      const newLinePrefix = `${quotePrefix}${indent}${newMarker} ${newCheckbox}`;

      if (targetPos >= line.to) {
        const insert = `${eol}${newLinePrefix}`;
        const newPos = line.to + insert.length;
        return {
          changes: [{ from: line.to, to: line.to, insert }],
          selection: { anchor: newPos, head: newPos },
          userEvent: 'input.enter'
        };
      }

      const replaceTo = targetPos < line.to && source[targetPos] === ' ' ? targetPos + 1 : targetPos;
      const insert = `${eol}${newLinePrefix}`;
      const newPos = targetPos + insert.length;
      return {
        changes: [{ from: targetPos, to: replaceTo, insert }],
        selection: { anchor: newPos, head: newPos },
        userEvent: 'input.enter'
      };
    }
  }

  // 2. Check if inside blockquote (not list item)
  const quoteMatch = line.text.match(/^([ \t]*>[ \t]*)+/);
  if (quoteMatch) {
    const quotePrefix = quoteMatch[0];
    const afterQuote = line.text.slice(quotePrefix.length);

    if (afterQuote.trim().length === 0) {
      return {
        changes: [{ from: line.from, to: line.to, insert: '' }],
        selection: { anchor: line.from, head: line.from },
        userEvent: 'blockquote.exit'
      };
    }

    const insert = `${eol}${quotePrefix}`;
    const newPos = targetPos + insert.length;
    return {
      changes: [{ from: targetPos, to: targetPos, insert }],
      selection: { anchor: newPos, head: newPos },
      userEvent: 'input.enter'
    };
  }

  // 3. Heading handling (powered by AST)
  if (targetBlock.type === 'heading') {
    const indentMatch = line.text.match(/^[ \t]{0,3}/);
    const indent = indentMatch ? indentMatch[0] : '';
    const hashes = '#'.repeat(targetBlock.depth);
    const afterHashes = line.text.slice(indent.length + hashes.length);
    const spaceMatch = afterHashes.match(/^[ \t]+/);
    const prefixSpace = spaceMatch ? spaceMatch[0] : ' ';
    const rawContentWithClosing = afterHashes.slice(prefixSpace.length);
    const closingMatch = rawContentWithClosing.match(/[ \t]+#{1,6}[ \t]*$/);
    const closingHashes = closingMatch ? closingMatch[0] : '';
    const content = closingMatch
      ? rawContentWithClosing.slice(0, rawContentWithClosing.length - closingHashes.length)
      : rawContentWithClosing;
    const contentStart = line.from + indent.length + hashes.length + prefixSpace.length;
    const contentEnd = contentStart + content.length;

    if (targetPos >= line.to) {
      const insert = blockSep;
      return {
        changes: [{ from: line.to, to: line.to, insert }],
        selection: { anchor: line.to + insert.length, head: line.to + insert.length },
        userEvent: 'input.enter'
      };
    }

    if (targetPos >= contentStart && targetPos <= contentEnd) {
      const offsetInContent = targetPos - contentStart;
      const leftContent = content.slice(0, offsetInContent).trimEnd();
      const rightContent = content.slice(offsetInContent).trimStart();

      const newHeading = `${indent}${hashes}${prefixSpace}${leftContent}${closingHashes}`;
      const newParagraph = rightContent;
      const replacement = `${newHeading}${blockSep}${newParagraph}`;

      const newCaret = line.from + newHeading.length + blockSep.length;
      return {
        changes: [{ from: line.from, to: line.to, insert: replacement }],
        selection: { anchor: newCaret, head: newCaret },
        userEvent: 'input.enter'
      };
    }

    const insert = blockSep;
    return {
      changes: [{ from: line.from, to: line.from, insert }],
      selection: { anchor: line.from + insert.length, head: line.from + insert.length },
      userEvent: 'input.enter'
    };
  }

  // 4. Paragraph handling
  const replaceTo = targetPos < source.length && source[targetPos] === ' ' ? targetPos + 1 : targetPos;

  const formattingSpans = findFormattingSpans(source);
  const activeSpan = formattingSpans.find(
    (s) => targetPos > s.from + s.open.length && targetPos < s.to - s.close.length
  );

  if (activeSpan) {
    const insert = `${activeSpan.close}${blockSep}${activeSpan.open}`;
    const newPos = targetPos + insert.length;
    return {
      changes: [{ from: targetPos, to: replaceTo, insert }],
      selection: { anchor: newPos, head: newPos },
      userEvent: 'input.enter'
    };
  }

  const insert = blockSep;
  const newPos = targetPos + insert.length;
  return {
    changes: [{ from: targetPos, to: replaceTo, insert }],
    selection: { anchor: newPos, head: newPos },
    userEvent: 'input.enter'
  };
}

/**
 * Creates a transaction to handle Backspace at block boundary:
 * - Merges two adjacent paragraphs when cursor is at start of second paragraph
 * - Merges paragraph into previous heading when cursor is at start of paragraph
 * - Unwraps list marker to plain text when cursor is at start of list item content
 * - Unwraps blockquote prefix to plain text when cursor is at start of quote content
 * - Guards against document start and non-mergeable blocks (code, table, math, raw)
 */
export function createBlockMergeTransaction(
  source: string,
  selection: MarkdownSelection
): MarkdownEditTransaction | null {
  if (selection.anchor !== selection.head) return null;
  const pos = selection.head;
  const { root } = parseMarkdown(source);
  const blocks = root.children;

  if (blocks.length > 0 && pos === blocks[0]!.range.from) {
    return null;
  }

  const line = getLineAt(source, pos);

  // Check if cursor is at start of list item content (AST 语义驱动)
  const listContext = findListItemAtPos(root, pos);
  if (listContext) {
    const quotePrefixLen = getQuotePrefixLength(line.text, listContext.quoteDepth);
    const afterQuote = line.text.slice(quotePrefixLen);
    const indentMatch = afterQuote.match(/^[ \t]*/);
    const indent = indentMatch ? indentMatch[0] : '';
    const afterIndent = afterQuote.slice(indent.length);

    const markerMatch = listContext.parentList.ordered
      ? afterIndent.match(/^(\d+[.)])([ \t]+)/)
      : afterIndent.match(/^([*+-])([ \t]+)/);

    if (markerMatch) {
      const afterMarker = afterIndent.slice(markerMatch[0].length);
      let taskLen = 0;
      if (listContext.item.task) {
        const taskMatch = afterMarker.match(/^\[([ xX])\]([ \t]+)/);
        if (taskMatch) {
          taskLen = taskMatch[0].length;
        }
      }

      const prefixLen = quotePrefixLen + indent.length + markerMatch[0].length + taskLen;
      const contentStartPos = line.from + prefixLen;

      if (pos === contentStartPos) {
        const removeStart = line.from + quotePrefixLen;
        const removeEnd = contentStartPos;
        return {
          changes: [{ from: removeStart, to: removeEnd, insert: '' }],
          selection: { anchor: removeStart, head: removeStart },
          userEvent: 'delete.backward'
        };
      }
    }
  }

  const deepestBlock = findDeepestBlockAtPos(root, pos, source);

  // Check if cursor is at start of blockquote content (AST 语义驱动)
  const isInsideQuote = deepestBlock?.path.some((n) => n.type === 'blockquote');
  if (isInsideQuote) {
    const quoteMatch = line.text.match(/^([ \t]*>[ \t]*)+/);
    if (quoteMatch) {
      const quotePrefix = quoteMatch[0];
      const contentStartPos = line.from + quotePrefix.length;
      if (pos === contentStartPos) {
        return {
          changes: [{ from: line.from, to: contentStartPos, insert: '' }],
          selection: { anchor: line.from, head: line.from },
          userEvent: 'delete.backward'
        };
      }
    }
  }

  // Find block starting at pos (AST 语义驱动，支持嵌套块与顶级块)
  let currentBlock: MarkdownBlockNode | MarkdownListItem | null = null;
  let prevBlock: MarkdownBlockNode | MarkdownListItem | null = null;

  if (deepestBlock && deepestBlock.node.range.from === pos && deepestBlock.index > 0) {
    currentBlock = deepestBlock.node;
    prevBlock = deepestBlock.siblings[deepestBlock.index - 1] ?? null;
  } else {
    const blockIndex = blocks.findIndex((b) => b.range.from === pos);
    if (blockIndex > 0) {
      currentBlock = blocks[blockIndex] ?? null;
      prevBlock = blocks[blockIndex - 1] ?? null;
    }
  }

  if (!currentBlock || !prevBlock) return null;

  if (
    prevBlock.type === 'code-block' ||
    prevBlock.type === 'table' ||
    prevBlock.type === 'block-math' ||
    prevBlock.type === 'raw'
  ) {
    return null;
  }

  if (currentBlock.type === 'paragraph' && (prevBlock.type === 'paragraph' || prevBlock.type === 'heading')) {
    let mergeFrom = prevBlock.range.to;
    while (
      mergeFrom > prevBlock.range.from &&
      (source[mergeFrom - 1] === '\n' || source[mergeFrom - 1] === '\r')
    ) {
      mergeFrom--;
    }
    const changes = [{ from: mergeFrom, to: currentBlock.range.from, insert: '' }];
    const nextSelection = { anchor: mergeFrom, head: mergeFrom };

    return {
      changes,
      selection: nextSelection,
      userEvent: 'delete.backward'
    };
  }

  return null;
}

/**
 * Creates a transaction to indent a list item (Tab):
 * - Indents item if it has a preceding sibling
 * - Indents entire subtree (continuation lines, nested lists, grandchildren, child code/quote blocks)
 * - Maps selection accurately via ChangeSet
 * - Preserves markers, tasks, multi-line contents, blockquote prefixes
 */
export function createListIndentTransaction(
  source: string,
  selection: MarkdownSelection
): MarkdownEditTransaction | null {
  const pos = selection.head;
  const { root } = parseMarkdown(source);
  const context = findListItemAtPos(root, pos);
  if (!context) return null;

  const { item, itemIndex, parentItem, quoteDepth } = context;
  if (itemIndex === 0 && !parentItem) {
    return null;
  }


  const allLines = parseLines(source);
  const itemLines = allLines.filter(
    (l) => l.from < item.range.to && (l.to >= item.range.from || l.from >= item.range.from)
  );
  if (itemLines.length === 0) return null;

  const indentStr = '  ';
  const changes: { from: number; to: number; insert: string }[] = [];

  for (const line of itemLines) {
    if (line.text.length === 0) continue;
    const prefixLen = getQuotePrefixLength(line.text, quoteDepth);
    const insertPos = line.from + prefixLen;
    changes.push({
      from: insertPos,
      to: insertPos,
      insert: indentStr
    });
  }

  if (changes.length === 0) return null;

  const changeSet = createMarkdownChangeSet(source, changes);
  const nextSelection = mapMarkdownSelection(selection, changeSet);

  return {
    changes,
    selection: nextSelection,
    userEvent: 'list.indent'
  };
}

/**
 * Creates a transaction to outdent a list item (Shift-Tab):
 * - Decreases indent of entire item subtree by 2 spaces
 * - Maps selection accurately via ChangeSet
 * - No-op on root list items (prevents negative indent)
 */
export function createListOutdentTransaction(
  source: string,
  selection: MarkdownSelection
): MarkdownEditTransaction | null {
  const pos = selection.head;
  const { root } = parseMarkdown(source);
  const context = findListItemAtPos(root, pos);
  if (!context) return null;

  const { item, parentItem, quoteDepth } = context;

  const allLines = parseLines(source);
  const itemLines = allLines.filter(
    (l) => l.from < item.range.to && (l.to >= item.range.from || l.from >= item.range.from)
  );
  if (itemLines.length === 0) return null;

  const firstLine = itemLines[0]!;
  const firstPrefixLen = getQuotePrefixLength(firstLine.text, quoteDepth);
  const firstLineAfterQuote = firstLine.text.slice(firstPrefixLen);
  const firstLineIndentMatch = firstLineAfterQuote.match(/^[ \t]+/);
  const firstLineIndentLen = firstLineIndentMatch ? firstLineIndentMatch[0].length : 0;

  if (!parentItem && firstLineIndentLen < 2) {
    return null;
  }
  if (firstLineIndentLen === 0) {
    return null;
  }

  const removeCount = Math.min(2, firstLineIndentLen);
  const changes: { from: number; to: number; insert: string }[] = [];

  for (const line of itemLines) {
    if (line.text.length === 0) continue;
    const prefixLen = getQuotePrefixLength(line.text, quoteDepth);
    const afterQuote = line.text.slice(prefixLen);
    const indentMatch = afterQuote.match(/^[ \t]+/);
    const lineIndent = indentMatch ? indentMatch[0].length : 0;
    const toRemove = Math.min(removeCount, lineIndent);
    if (toRemove > 0) {
      changes.push({
        from: line.from + prefixLen,
        to: line.from + prefixLen + toRemove,
        insert: ''
      });
    }
  }

  if (changes.length === 0) return null;

  const changeSet = createMarkdownChangeSet(source, changes);
  const nextSelection = mapMarkdownSelection(selection, changeSet);

  return {
    changes,
    selection: nextSelection,
    userEvent: 'list.outdent'
  };
}

/**
 * Creates a transaction to toggle a task checkbox ([ ] <-> [x]) at exact SourceRange.
 */
export function createTaskCheckboxToggleTransaction(
  source: string,
  range: { from: number; to: number }
): MarkdownEditTransaction | null {
  const current = source.slice(range.from, range.to);
  let insert: string;

  if (current === '[ ]') {
    insert = '[x]';
  } else if (current.toLowerCase() === '[x]') {
    insert = '[ ]';
  } else {
    return null;
  }

  return {
    changes: [{ from: range.from, to: range.to, insert }],
    userEvent: 'task.toggle'
  };
}

/**
 * Creates a transaction to apply or unwrap inline formatting (Mod-B / Mod-I):
 * - Uses AST formatting spans directly
 * - Unwraps with precise delimiter fidelity (_italic_ deletes _, *italic* deletes *)
 * - Does not corrupt bold ** or __ when toggling italic
 * - Wraps with default format markers (** or *)
 * - Guards against collapsed selections and atomic nodes
 */
export function createInlineFormatTransaction(
  source: string,
  selection: MarkdownSelection,
  format: 'strong' | 'emphasis' | 'strike'
): MarkdownEditTransaction | null {
  if (selection.anchor === selection.head) return null;

  const from = Math.min(selection.anchor, selection.head);
  const to = Math.max(selection.anchor, selection.head);
  const isReversed = selection.anchor > selection.head;
  const makeSelection = (start: number, end: number) => ({
    anchor: isReversed ? end : start,
    head: isReversed ? start : end
  });

  // Guard: selection inside atomic nodes
  const atomicRanges = findAtomicRanges(source);
  for (const r of atomicRanges) {
    if ((from >= r.from && from < r.to) || (to > r.from && to <= r.to)) {
      return null;
    }
  }

  const formattingSpans = findFormattingSpans(source);

  if (format === 'strong') {
    const matchingSpan = formattingSpans.find(
      (s) =>
        s.type === 'strong' &&
        ((s.from + s.open.length === from && s.to - s.close.length === to) ||
          (s.from === from && s.to === to))
    );

    if (matchingSpan) {
      const isInner =
        matchingSpan.from + matchingSpan.open.length === from &&
        matchingSpan.to - matchingSpan.close.length === to;
      const nextFrom = isInner ? from - matchingSpan.open.length : from;
      const nextTo = isInner
        ? to - matchingSpan.open.length
        : to - matchingSpan.open.length - matchingSpan.close.length;
      return {
        changes: [
          { from: matchingSpan.from, to: matchingSpan.from + matchingSpan.open.length, insert: '' },
          { from: matchingSpan.to - matchingSpan.close.length, to: matchingSpan.to, insert: '' }
        ],
        selection: makeSelection(nextFrom, nextTo),
        userEvent: 'format.bold'
      };
    }

    const marker = '**';
    return {
      changes: [
        { from, to: from, insert: marker },
        { from: to, to, insert: marker }
      ],
      selection: makeSelection(from + marker.length, to + marker.length),
      userEvent: 'format.bold'
    };
  }

  if (format === 'emphasis') {
    const matchingSpan = formattingSpans.find(
      (s) =>
        s.type === 'emphasis' &&
        ((s.from + s.open.length === from && s.to - s.close.length === to) ||
          (s.from === from && s.to === to))
    );

    if (matchingSpan) {
      const isInner =
        matchingSpan.from + matchingSpan.open.length === from &&
        matchingSpan.to - matchingSpan.close.length === to;
      const nextFrom = isInner ? from - matchingSpan.open.length : from;
      const nextTo = isInner
        ? to - matchingSpan.open.length
        : to - matchingSpan.open.length - matchingSpan.close.length;
      return {
        changes: [
          { from: matchingSpan.from, to: matchingSpan.from + matchingSpan.open.length, insert: '' },
          { from: matchingSpan.to - matchingSpan.close.length, to: matchingSpan.to, insert: '' }
        ],
        selection: makeSelection(nextFrom, nextTo),
        userEvent: 'format.italic'
      };
    }

    // If selection is inside a strong formatting span, wrap outside the strong delimiters
    const enclosingStrong = formattingSpans.find(
      (s) =>
        s.type === 'strong' &&
        s.from + s.open.length === from &&
        s.to - s.close.length === to
    );

    const marker = '*';
    if (enclosingStrong) {
      return {
        changes: [
          { from: enclosingStrong.from, to: enclosingStrong.from, insert: marker },
          { from: enclosingStrong.to, to: enclosingStrong.to, insert: marker }
        ],
        selection: makeSelection(from + marker.length, to + marker.length),
        userEvent: 'format.italic'
      };
    }

    return {
      changes: [
        { from, to: from, insert: marker },
        { from: to, to, insert: marker }
      ],
      selection: makeSelection(from + marker.length, to + marker.length),
      userEvent: 'format.italic'
    };
  }

  if (format === 'strike') {
    const matchingSpan = formattingSpans.find(
      (s) =>
        s.type === 'strike' &&
        ((s.from + s.open.length === from && s.to - s.close.length === to) ||
          (s.from === from && s.to === to))
    );

    if (matchingSpan) {
      const isInner =
        matchingSpan.from + matchingSpan.open.length === from &&
        matchingSpan.to - matchingSpan.close.length === to;
      const nextFrom = isInner ? from - matchingSpan.open.length : from;
      const nextTo = isInner
        ? to - matchingSpan.open.length
        : to - matchingSpan.open.length - matchingSpan.close.length;
      return {
        changes: [
          { from: matchingSpan.from, to: matchingSpan.from + matchingSpan.open.length, insert: '' },
          { from: matchingSpan.to - matchingSpan.close.length, to: matchingSpan.to, insert: '' }
        ],
        selection: makeSelection(nextFrom, nextTo),
        userEvent: 'format.strike'
      };
    }

    const marker = '~~';
    return {
      changes: [
        { from, to: from, insert: marker },
        { from: to, to, insert: marker }
      ],
      selection: makeSelection(from + marker.length, to + marker.length),
      userEvent: 'format.strike'
    };
  }

  return null;
}

/**
 * 根据 source 坐标找到最深的可编辑 block，并精确选中其范围，不误选相邻 gap。
 */
export function createSelectBlockAtPositionTransaction(
  source: string,
  position: number
): MarkdownEditTransaction | null {
  const { root } = parseMarkdown(source);
  const context = findDeepestBlockAtPos(root, position, source);
  if (!context) return null;

  const node = context.node;
  const from = node.range.from;
  const to = getContentEnd(source, node.range);

  return {
    changes: [],
    selection: {
      anchor: from,
      head: to
    },
    userEvent: 'select.block'
  };
}

/**
 * 根据顶级块索引全选块。
 */
export function createSelectBlockAtIndexTransaction(
  source: string,
  index: number
): MarkdownEditTransaction | null {
  const { root } = parseMarkdown(source);
  if (index < 0 || index >= root.children.length) return null;

  const block = root.children[index]!;
  const from = block.range.from;
  const to = getContentEnd(source, block.range);

  return {
    changes: [],
    selection: {
      anchor: from,
      head: to
    },
    userEvent: 'select.block'
  };
}

/**
 * 兼容旧接口：当 target 为有效坐标或索引时选中块。
 */
export function createSelectBlockTransaction(
  source: string,
  target: number
): MarkdownEditTransaction | null {
  const { root } = parseMarkdown(source);
  if (root.children.length === 0) return null;

  // 坐标优先匹配
  const posTx = createSelectBlockAtPositionTransaction(source, target);
  if (posTx) return posTx;

  // 索引匹配
  if (target >= 0 && target < root.children.length) {
    return createSelectBlockAtIndexTransaction(source, target);
  }

  return null;
}

/**
 * 在同一父容器的同级 block 列表中重排/交换两个位置的 block，保持源码完全保真。
 */
export function reorderSiblingBlocks(
  source: string,
  siblings: (MarkdownBlockNode | MarkdownListItem)[],
  fromIndex: number,
  toIndex: number,
  currentSelection?: MarkdownSelection
): MarkdownEditTransaction | null {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= siblings.length ||
    toIndex >= siblings.length ||
    fromIndex === toIndex
  ) {
    return null;
  }

  const minIdx = Math.min(fromIndex, toIndex);
  const maxIdx = Math.max(fromIndex, toIndex);
  const subBlocks = siblings.slice(minIdx, maxIdx + 1);

  const blockContents: string[] = [];
  const gaps: string[] = [];

  for (let i = 0; i < subBlocks.length; i++) {
    const curBlock = subBlocks[i]!;
    const cEnd = getContentEnd(source, curBlock.range);
    blockContents.push(source.slice(curBlock.range.from, cEnd));

    if (i < subBlocks.length - 1) {
      const nextBlock = subBlocks[i + 1]!;
      gaps.push(source.slice(cEnd, nextBlock.range.from));
    }
  }

  const fromOffset = fromIndex - minIdx;
  const toOffset = toIndex - minIdx;
  const reorderedContents = [...blockContents];

  // 交换 fromOffset 与 toOffset 对应插槽的正文切片
  const temp = reorderedContents[fromOffset]!;
  reorderedContents[fromOffset] = reorderedContents[toOffset]!;
  reorderedContents[toOffset] = temp;

  let newSegment = '';
  for (let i = 0; i < reorderedContents.length; i++) {
    newSegment += reorderedContents[i];
    if (i < gaps.length) {
      newSegment += gaps[i];
    }
  }

  const rangeFrom = subBlocks[0]!.range.from;
  const rangeTo = getContentEnd(source, subBlocks[subBlocks.length - 1]!.range);

  const changes = [{ from: rangeFrom, to: rangeTo, insert: newSegment }];

  // 计算移动块在新文本段中的起始位置
  let movedBlockOffsetInSegment = 0;
  for (let i = 0; i < toOffset; i++) {
    movedBlockOffsetInSegment += reorderedContents[i]!.length + gaps[i]!.length;
  }
  const destBlockFrom = rangeFrom + movedBlockOffsetInSegment;
  const movedLen = reorderedContents[toOffset]!.length;
  const destBlockTo = destBlockFrom + movedLen;

  let nextSelection: MarkdownSelection;
  const fromBlock = siblings[fromIndex]!;
  if (
    currentSelection &&
    currentSelection.head >= fromBlock.range.from &&
    currentSelection.head <= fromBlock.range.to &&
    currentSelection.anchor >= fromBlock.range.from &&
    currentSelection.anchor <= fromBlock.range.to
  ) {
    const relHead = Math.min(
      Math.max(0, currentSelection.head - fromBlock.range.from),
      movedLen
    );
    const relAnchor = Math.min(
      Math.max(0, currentSelection.anchor - fromBlock.range.from),
      movedLen
    );
    nextSelection = {
      anchor: destBlockFrom + relAnchor,
      head: destBlockFrom + relHead
    };
  } else if (currentSelection) {
    const changeSet = createMarkdownChangeSet(source, changes);
    nextSelection = mapMarkdownSelection(currentSelection, changeSet);
  } else if (fromIndex === 0 && toIndex === 1) {
    nextSelection = {
      anchor: rangeFrom,
      head: rangeFrom + reorderedContents[0]!.length
    };
  } else {
    nextSelection = {
      anchor: destBlockFrom,
      head: destBlockTo
    };
  }

  return {
    changes,
    selection: nextSelection,
    userEvent: 'block.reorder'
  };
}

/**
 * 在同一父容器内向上或向下重排当前光标所在的最深 block。
 *
 * 核心约束：
 * 1. 只能在同一父容器的同级 block 间移动；位于容器首部向上或尾部向下时返回 null（不跨容器）。
 * 2. 保持 list marker、blockquote prefix、缩进与 gap 格式完全保真。
 * 3. 产生原 source 坐标下的单一局部变更。
 * 4. 通过 ChangeSet 或相对偏移高保真映射选区。
 */
export function createReorderBlockAtPositionTransaction(
  source: string,
  position: number,
  direction: 'up' | 'down',
  currentSelection?: MarkdownSelection
): MarkdownEditTransaction | null {
  const { root } = parseMarkdown(source);
  let context = findDeepestBlockAtPos(root, position, source);
  if (!context && currentSelection && currentSelection.anchor !== currentSelection.head) {
    const selFrom = Math.min(currentSelection.anchor, currentSelection.head);
    context = findDeepestBlockAtPos(root, selFrom, source);
  }
  if (!context && position > 0) {
    const prevCtx = findDeepestBlockAtPos(root, position - 1, source);
    if (prevCtx && getContentEnd(source, prevCtx.node.range) === position) {
      context = prevCtx;
    }
  }
  if (!context) return null;

  const { siblings, index } = context;
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= siblings.length) {
    return null;
  }

  return reorderSiblingBlocks(source, siblings, index, targetIndex, currentSelection);
}

/**
 * 基于 AST 区间重排顶级块（Reorder Block），严格保持源码原样格式。
 */
export function createReorderBlockTransaction(
  source: string,
  fromIndex: number,
  toIndex: number,
  currentSelection?: MarkdownSelection
): MarkdownEditTransaction | null {
  const { root } = parseMarkdown(source);
  return reorderSiblingBlocks(source, root.children, fromIndex, toIndex, currentSelection);
}

/**
 * 基于源位置和目标位置在同一父容器内重排 block。
 *
 * 核心约束：
 * 1. sourcePosition 与 targetPosition 均必须解析为有效的最深 block。
 * 2. 如果任一位置处于空白 gap，返回 null。
 * 3. 必须处于同一父容器的同级兄弟列表中（sourceCtx.parent === targetCtx.parent），禁止跨容器重排。
 * 4. 如果源位置与目标位置解析为同一个 block，返回 null（no-op）。
 * 5. 调用 reorderSiblingBlocks 执行对称插槽置换，完整保留原始 gap 与换行符。
 */
export function createReorderBlockToPositionTransaction(
  source: string,
  sourcePosition: number,
  targetPosition: number,
  currentSelection?: MarkdownSelection
): MarkdownEditTransaction | null {
  const { root } = parseMarkdown(source);
  const sourceCtx = findDeepestBlockAtPos(root, sourcePosition, source);
  const targetCtx = findDeepestBlockAtPos(root, targetPosition, source);

  if (!sourceCtx || !targetCtx) {
    return null;
  }

  if (sourceCtx.parent !== targetCtx.parent) {
    return null;
  }

  if (sourceCtx.index === targetCtx.index) {
    return null;
  }

  return reorderSiblingBlocks(
    source,
    sourceCtx.siblings,
    sourceCtx.index,
    targetCtx.index,
    currentSelection
  );
}



