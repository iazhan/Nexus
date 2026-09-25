import { parseMarkdown } from '@nexus/markdown';
import { createMarkdownChangeSet, mapMarkdownSelection } from '../document-session.js';
import type { MarkdownEditTransaction, MarkdownSelection } from '../types.js';
import { findListItemAtPos, getQuotePrefixLength, parseLines } from './lookup.js';

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

