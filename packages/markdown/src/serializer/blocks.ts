/**
 * 块级序列化器。
 *
 * `serializeBlock` / `serializeListItem` / `serializeBlockquote` 三者**互相递归**
 * （列表项里可以有嵌套块，引用块里也可以有列表和引用块），构成一个强连通分量，
 * 必须留在同一个模块里 —— 拆开会在 ESM 顶层形成循环依赖。
 */
import type { MarkdownBlockNode, MarkdownInlineNode, MarkdownListItem } from '../types.js';
import { hasDirtyChildren, isNodeDirty } from './dirty.js';
import { serializeInline } from './inline.js';
import { splitLinesWithBreaks } from './text-utils.js';
import { serializeTable } from './table.js';
import { serializeBlockMath, serializeHeading, serializeParagraph } from './simple-blocks.js';
import { serializeCodeBlock } from './code-block.js';

function isBlockChild(
  node: MarkdownInlineNode | MarkdownBlockNode
): node is MarkdownBlockNode {
  return (
    node.type === 'heading' ||
    node.type === 'paragraph' ||
    node.type === 'blockquote' ||
    node.type === 'list' ||
    node.type === 'code-block' ||
    node.type === 'block-math' ||
    node.type === 'table' ||
    node.type === 'horizontal-rule' ||
    (node.type === 'raw' && (node as { block?: boolean }).block === true)
  );
}

/**
 * Serializes a single list item, preserving original marker styles (* vs - vs 1.).
 */
export function serializeListItem(
  item: MarkdownListItem,
  defaultMarker = '- ',
  sourceOrForce?: string | boolean,
  forceReconstruct = false
): string {
  const source = typeof sourceOrForce === 'string' ? sourceOrForce : undefined;
  const force = typeof sourceOrForce === 'boolean' ? sourceOrForce : forceReconstruct;

  if (!force && !isNodeDirty(item, source)) {
    return item.raw;
  }

  // If node's raw was modified directly without dirty/modified flags,
  // and no dirty children exist, return the node's updated raw.
  if (
    !force &&
    item.dirty !== true &&
    item.modified !== true &&
    typeof item.raw === 'string' &&
    item.raw.length > 0 &&
    !hasDirtyChildren(item, source)
  ) {
    return item.raw;
  }

  let marker = defaultMarker;
  if (!force && typeof item.raw === 'string' && item.raw.length > 0) {
    const firstLine = item.raw.split(/\r?\n/)[0] ?? '';
    const strippedFirstLine = firstLine.replace(/^[ \t]*(?:>[ \t]*)+/, '');
    const match = strippedFirstLine.match(/^([ \t]*)(?:[*+-]|\d+[.)])[ \t]*/);
    if (match) {
      marker = match[0];
      if (!marker.endsWith(' ') && !marker.endsWith('\t')) {
        marker += ' ';
      }
    }
  } else if (!force && source && item.range) {
    const rawSlice = source.slice(item.range.from, item.range.to);
    const firstLine = rawSlice.split(/\r?\n/)[0] ?? '';
    const strippedFirstLine = firstLine.replace(/^[ \t]*(?:>[ \t]*)+/, '');
    const match = strippedFirstLine.match(/^([ \t]*)(?:[*+-]|\d+[.)])[ \t]*/);
    if (match) {
      marker = match[0];
      if (!marker.endsWith(' ') && !marker.endsWith('\t')) {
        marker += ' ';
      }
    }
  }

  const taskPrefix = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';

  const isCrlf =
    (typeof item.raw === 'string' && item.raw.includes('\r\n')) ||
    (typeof source === 'string' && source.includes('\r\n'));
  const newline = isCrlf ? '\r\n' : '\n';

  let childContent = '';
  let lastEnd = -1;
  for (let i = 0; i < item.children.length; i++) {
    const c = item.children[i]!;
    if (isBlockChild(c)) {
      if (!force && typeof source === 'string' && c.range && lastEnd !== -1 && c.range.from >= lastEnd) {
        const gap = source.slice(lastEnd, c.range.from);
        childContent += gap;
      } else {
        if (childContent.length > 0) {
          const prev = i > 0 ? item.children[i - 1] : undefined;
          const prevIsBlock = prev && isBlockChild(prev);
          const hadBlankLine =
            typeof source === 'string' &&
            c.range &&
            lastEnd !== -1 &&
            c.range.from >= lastEnd &&
            /\n[ \t]*\r?\n/.test(source.slice(lastEnd, c.range.from));
          const needsBlankLine =
            hadBlankLine ||
            (prevIsBlock && (
              (prev?.type === 'blockquote' && c.type === 'blockquote') ||
              (prev?.type === 'paragraph' && c.type === 'paragraph') ||
              (prev?.type === 'code-block' && c.type === 'code-block')
            ));

          if (needsBlankLine) {
            if (!childContent.endsWith('\n\n') && !childContent.endsWith('\r\n\r\n')) {
              if (childContent.endsWith('\n')) {
                childContent += newline;
              } else {
                childContent += `${newline}${newline}`;
              }
            }
          } else if (!childContent.endsWith('\n')) {
            childContent += newline;
          }
        }
      }
      let blockStr = serializeBlock(c, source, force);
      if (force) {
        const itemIndent = ' '.repeat(marker.length);
        const bLines = blockStr.split(/\r?\n/);
        if (childContent.length > 0) {
          blockStr = bLines
            .map((line) => (line.length > 0 ? `${itemIndent}${line}` : ''))
            .join(newline);
        } else {
          blockStr = bLines
            .map((line, idx) => (idx === 0 ? line : line.length > 0 ? `${itemIndent}${line}` : ''))
            .join(newline);
        }
      } else if (isNodeDirty(c, source) && c.type === 'raw') {
        const indentMatch = typeof c.raw === 'string' ? c.raw.match(/^[ \t]*/) : null;
        const indent = indentMatch ? indentMatch[0] : ' '.repeat(marker.length);
        if (indent.length > 0) {
          blockStr = blockStr
            .split(/\r?\n/)
            .map((line) => (line.length > 0 ? `${indent}${line}` : ''))
            .join(newline);
        }
      }
      childContent += blockStr;
      if (c.range) {
        lastEnd = c.range.to;
      }
    } else {
      const inlineStr = serializeInline(c, source, force);
      childContent += inlineStr;
      if (c.range) {
        lastEnd = c.range.to;
      }
    }
  }

  let result = `${marker}${taskPrefix}${childContent}`;
  if (!result.endsWith('\n')) {
    if (typeof item.raw === 'string' && item.raw.length > 0) {
      if (item.raw.endsWith('\r\n')) {
        result += '\r\n';
      } else if (item.raw.endsWith('\n')) {
        result += '\n';
      }
      // If original item.raw had no newline (e.g. at EOF), do not force a trailing newline.
    } else {
      result += newline;
    }
  }

  return result;
}

function getBlockquoteDepth(node: Extract<MarkdownBlockNode, { type: 'blockquote' }>): {
  depth: number;
  deepestNode: Extract<MarkdownBlockNode, { type: 'blockquote' }>;
} {
  let depth = 1;
  let curr: Extract<MarkdownBlockNode, { type: 'blockquote' }> = node;
  while (
    curr.type === 'blockquote' &&
    curr.children.length === 1 &&
    curr.children[0]!.type === 'blockquote'
  ) {
    depth++;
    curr = curr.children[0] as Extract<MarkdownBlockNode, { type: 'blockquote' }>;
  }
  return { depth, deepestNode: curr };
}

function extractLineQuotePrefix(
  lineText: string,
  minDepth: number,
  isCodeBlock = false
): { prefix: string; content: string } {
  let remaining = lineText;
  let prefix = '';
  let count = 0;
  while (true) {
    const match = remaining.match(/^[ \t]*>[ \t]?/);
    if (!match) break;
    if (isCodeBlock && count >= minDepth) break;
    prefix += match[0];
    remaining = remaining.slice(match[0].length);
    count++;
  }
  return { prefix, content: remaining };
}

function serializeBlockquote(
  block: Extract<MarkdownBlockNode, { type: 'blockquote' }>,
  source?: string,
  force = false
): string {
  const rawText =
    typeof block.raw === 'string' && block.raw.length > 0
      ? block.raw
      : source && block.range
        ? source.slice(block.range.from, block.range.to)
        : '';

  if (force || !rawText) {
    const origLines =
      typeof rawText === 'string' && rawText.length > 0
        ? splitLinesWithBreaks(rawText)
        : [];
    const defaultBreak =
      origLines.length > 0 && origLines[0]!.break.length > 0
        ? origLines[0]!.break
        : (typeof source === 'string' && source.includes('\r\n'))
          ? '\r\n'
          : '\n';

    const inner = block.children
      .map((c) => serializeBlock(c, source, true))
      .join(`${defaultBreak}${defaultBreak}`);

    const resLines = inner
      .split(/\r?\n/)
      .map((line) => (line.length > 0 ? `> ${line}` : '>'));

    let res = '';
    for (let k = 0; k < resLines.length; k++) {
      const lineStr = resLines[k]!;
      const isLast = k === resLines.length - 1;
      const lineBreak =
        k < origLines.length && origLines[k]!.break.length > 0
          ? origLines[k]!.break
          : isLast
            ? ''
            : defaultBreak;
      res += lineStr + lineBreak;
    }

    const trailingNewline =
      origLines.length > 0
        ? origLines[origLines.length - 1]!.break
        : '';
    if (trailingNewline && !res.endsWith('\n')) {
      res += trailingNewline;
    }
    return res;
  }

  const { depth, deepestNode } = getBlockquoteDepth(block);
  const isCrlf = rawText.includes('\r\n');
  const defaultBreak = isCrlf ? '\r\n' : '\n';
  const originalLines = splitLinesWithBreaks(rawText);

  interface LineInfo {
    start: number;
    end: number;
    text: string;
    break: string;
    prefix: string;
    content: string;
  }
  const lineInfos: LineInfo[] = [];
  let curOffset = block.range ? block.range.from : 0;
  for (const orig of originalLines) {
    const lineEnd = curOffset + orig.text.length + orig.break.length;
    const matchingChild = deepestNode.children.find((c) => {
      if (!c.range) return false;
      return c.range.from < lineEnd && c.range.to > curOffset;
    });
    const isCode = matchingChild?.type === 'code-block';
    const { prefix, content } = extractLineQuotePrefix(orig.text, depth, isCode);
    lineInfos.push({
      start: curOffset,
      end: lineEnd,
      text: orig.text,
      break: orig.break || defaultBreak,
      prefix,
      content
    });
    curOffset = lineEnd;
  }

  let lineIdx = 0;
  let result = '';

  for (let i = 0; i < deepestNode.children.length; i++) {
    const child = deepestNode.children[i]!;
    const cStart = child.range ? child.range.from : -1;
    const cEnd = child.range ? child.range.to : -1;

    // 1. Output any inter-block lines before this child verbatim from originalLines
    if (cStart !== -1) {
      while (lineIdx < lineInfos.length && lineInfos[lineIdx]!.end <= cStart) {
        const info = lineInfos[lineIdx]!;
        result += info.text + info.break;
        lineIdx++;
      }
    }

    // 2. Find lines that belong to this child
    const childLineIndices: number[] = [];
    if (cStart !== -1 && cEnd !== -1) {
      while (lineIdx < lineInfos.length && lineInfos[lineIdx]!.start < cEnd) {
        childLineIndices.push(lineIdx);
        lineIdx++;
      }
    }

    // 3. Serialize this child
    if (!isNodeDirty(child, source) && childLineIndices.length > 0) {
      // Child is not dirty - emit original lines verbatim!
      for (const idx of childLineIndices) {
        const info = lineInfos[idx]!;
        result += info.text + info.break;
      }
    } else {
      // Child is dirty - serialize it
      const childStr = serializeBlock(child, source, false);
      const childLines = childStr.replace(/\r?\n$/, '').split(/\r?\n/);
      const fallbackPrefix =
        childLineIndices.length > 0
          ? lineInfos[childLineIndices[0]!]!.prefix
          : lineInfos.length > 0
            ? lineInfos[0]!.prefix
            : '> ';
      const fallbackBreak =
        childLineIndices.length > 0
          ? lineInfos[childLineIndices[0]!]!.break
          : defaultBreak;

      for (let k = 0; k < childLines.length; k++) {
        let lineContent = childLines[k]!;
        const origLineInfo =
          k < childLineIndices.length ? lineInfos[childLineIndices[k]!]! : null;
        const prefix = origLineInfo ? origLineInfo.prefix : fallbackPrefix;
        const lineBreak = origLineInfo ? origLineInfo.break : fallbackBreak;

        if (origLineInfo && lineContent.startsWith(origLineInfo.prefix)) {
          lineContent = lineContent.slice(origLineInfo.prefix.length);
        } else if (origLineInfo && lineContent === origLineInfo.prefix.trimEnd()) {
          lineContent = '';
        } else if (lineContent.startsWith(prefix)) {
          lineContent = lineContent.slice(prefix.length);
        } else if (lineContent === prefix.trimEnd()) {
          lineContent = '';
        }

        const formatted =
          lineContent.length > 0 ? `${prefix}${lineContent}` : prefix.trimEnd();

        result += formatted + lineBreak;
      }
    }
  }

  // 4. Output any remaining trailing lines after the last child
  while (lineIdx < lineInfos.length) {
    const info = lineInfos[lineIdx]!;
    result += info.text + info.break;
    lineIdx++;
  }

  // Handle trailing newline if original didn't have one
  if (
    rawText &&
    !rawText.endsWith('\n') &&
    !rawText.endsWith('\r') &&
    (result.endsWith('\n') || result.endsWith('\r'))
  ) {
    result = result.replace(/\r?\n$/, '');
  }

  return result;
}

/**
 * Serializes a single block node to Markdown text.
 */
export function serializeBlock(
  block: MarkdownBlockNode,
  sourceOrForce?: string | boolean,
  forceReconstruct = false
): string {
  const source = typeof sourceOrForce === 'string' ? sourceOrForce : undefined;
  const force = typeof sourceOrForce === 'boolean' ? sourceOrForce : forceReconstruct;

  if (!force && !isNodeDirty(block, source)) {
    return block.raw;
  }

  // If node's raw was modified directly without dirty/modified flags,
  // and no dirty children exist, return the node's updated raw.
  if (
    !force &&
    block.dirty !== true &&
    block.modified !== true &&
    typeof block.raw === 'string' &&
    block.raw.length > 0 &&
    !hasDirtyChildren(block, source)
  ) {
    return block.raw;
  }

  switch (block.type) {
    case 'heading':
      return serializeHeading(block, source, force);
    case 'paragraph':
      return serializeParagraph(block, source, force);
    case 'blockquote':
      return serializeBlockquote(block, source, force);
    case 'list': {
      const isCrlf =
        (typeof block.raw === 'string' && block.raw.includes('\r\n')) ||
        (typeof source === 'string' && source.includes('\r\n'));
      const newline = isCrlf ? '\r\n' : '\n';

      const indentMatch =
        typeof block.raw === 'string' && block.raw.length > 0
          ? block.raw.match(/^[ \t]*/)
          : source && block.range
            ? source.slice(block.range.from, block.range.to).match(/^[ \t]*/)
            : null;
      const indent = indentMatch ? indentMatch[0] : '';

      if (force) {
        return block.items
          .map((item, idx) => {
            const defaultMarker = block.ordered ? `${(block.start ?? 1) + idx}. ` : `- `;
            return serializeListItem(item, defaultMarker, source, true);
          })
          .map((s) => s.replace(/\r?\n$/, ''))
          .join(newline);
      }

      const itemStrings = block.items.map((item, idx) => {
        const defaultMarker = block.ordered ? `${indent}${(block.start ?? 1) + idx}. ` : `${indent}- `;
        return serializeListItem(item, defaultMarker, source, false);
      });
      let result = '';
      for (let i = 0; i < itemStrings.length; i++) {
        if (i > 0 && !result.endsWith('\n')) {
          result += newline;
        }
        result += itemStrings[i];
      }
      return result;
    }
    case 'code-block':
      return serializeCodeBlock(block, source, force);
    case 'block-math':
      return serializeBlockMath(block, source, force);
    case 'table':
      return serializeTable(block, source, force);
    case 'horizontal-rule':
      return typeof block.raw === 'string' && block.raw.length > 0 ? block.raw : '---\n';
    case 'raw':
      return block.value;
  }
}

