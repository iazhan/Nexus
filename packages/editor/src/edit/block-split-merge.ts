import {
  parseMarkdown,
  type MarkdownBlockNode,
  type MarkdownListItem
} from '@nexus/markdown';
import type { MarkdownEditTransaction, MarkdownSelection } from '../types.js';
import { detectEol, findAtomicRanges, findFormattingSpans } from './source-scan.js';
import {
  findContainingBlock,
  findDeepestBlockAtPos,
  findListItemAtPos,
  getLineAt,
  getQuotePrefixLength
} from './lookup.js';

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
  // 回车只插入一个换行：段落/标题拆分不额外制造空行（与 Markra 及默认 CodeMirror 行为一致）。
  const lineBreak = eol;

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
      const insert = lineBreak;
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
      const replacement = `${newHeading}${lineBreak}${newParagraph}`;

      const newCaret = line.from + newHeading.length + lineBreak.length;
      return {
        changes: [{ from: line.from, to: line.to, insert: replacement }],
        selection: { anchor: newCaret, head: newCaret },
        userEvent: 'input.enter'
      };
    }

    const insert = lineBreak;
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
    const insert = `${activeSpan.close}${lineBreak}${activeSpan.open}`;
    const newPos = targetPos + insert.length;
    return {
      changes: [{ from: targetPos, to: replaceTo, insert }],
      selection: { anchor: newPos, head: newPos },
      userEvent: 'input.enter'
    };
  }

  const insert = lineBreak;
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

