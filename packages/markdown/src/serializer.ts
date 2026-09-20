import { getRowCellRanges } from './parser.js';
import type {
  MarkdownBlockNode,
  MarkdownInlineNode,
  MarkdownListItem,
  MarkdownNode,
  MarkdownParseResult,
  MarkdownRoot
} from './types.js';

export interface MarkdownSerializeOptions {
  /**
   * If true, forces reconstruction from AST rather than preserving raw slices.
   * Defaults to false.
   */
  forceReconstruct?: boolean;
}

/**
 * Marks a node as dirty, signaling to the serializer that it or its descendants
 * have been modified and must be re-serialized rather than using cached raw text.
 */
export function markDirty(node: MarkdownNode): void {
  node.dirty = true;
  node.modified = true;
}

/**
 * Checks whether a table cell (an array of inline nodes or an inline node) is dirty.
 */
export function isCellDirty(cell: MarkdownInlineNode[] | unknown, source?: string): boolean {
  if (!cell) return false;
  if (Array.isArray(cell)) {
    if ((cell as { dirty?: boolean; modified?: boolean }).dirty === true || (cell as { dirty?: boolean; modified?: boolean }).modified === true) {
      return true;
    }
    return cell.some((node) => isNodeDirty(node, source));
  }
  return isNodeDirty(cell as MarkdownNode, source);
}

/**
 * Recursively checks whether an AST node or any of its descendants has been modified.
 */
export function isNodeDirty(node: MarkdownNode, source?: string): boolean {
  if (node.dirty === true || node.modified === true) {
    return true;
  }

  if (typeof node.raw !== 'string' || node.raw.length === 0) {
    return true;
  }

  if (typeof source === 'string' && node.range) {
    if (
      typeof node.range.from !== 'number' ||
      typeof node.range.to !== 'number' ||
      node.range.from < 0 ||
      node.range.to > source.length ||
      node.range.from > node.range.to ||
      node.raw !== source.slice(node.range.from, node.range.to)
    ) {
      return true;
    }
  }

  return hasDirtyChildren(node, source);
}

/**
 * 检查节点的子孙节点是否被标记修改或数据脏化
 */
function hasDirtyChildren(node: MarkdownNode, source?: string): boolean {
  if ('children' in node && Array.isArray(node.children)) {
    if (node.children.some((c) => isNodeDirty(c, source))) {
      return true;
    }
  }
  if ('items' in node && Array.isArray(node.items)) {
    if (node.items.some((item) => isNodeDirty(item, source))) {
      return true;
    }
  }
  if (node.type === 'table') {
    if (
      node.headers.some((cell) => isCellDirty(cell, source)) ||
      node.rows.some((row) => row.some((cell) => isCellDirty(cell, source)))
    ) {
      return true;
    }
  }
  return false;
}

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

function splitLinesWithBreaks(str: string): { text: string; break: string }[] {
  const lines: { text: string; break: string }[] = [];
  let start = 0;
  while (start < str.length) {
    const nextNl = str.indexOf('\n', start);
    if (nextNl === -1) {
      lines.push({ text: str.slice(start), break: '' });
      break;
    }
    if (nextNl > start && str[nextNl - 1] === '\r') {
      lines.push({ text: str.slice(start, nextNl - 1), break: '\r\n' });
    } else {
      lines.push({ text: str.slice(start, nextNl), break: '\n' });
    }
    start = nextNl + 1;
  }
  return lines;
}

/**
 * Escapes unescaped pipe characters in table cell text to prevent breaking table structure.
 * Preserves already-escaped pipes (\|) and correctly handles escaped backslashes (\\| -> \\\|).
 */
export function escapeTableCellPipes(cellText: string): string {
  let result = '';
  let i = 0;
  while (i < cellText.length) {
    if (cellText[i] === '|') {
      let backslashes = 0;
      let k = i - 1;
      while (k >= 0 && cellText[k] === '\\') {
        backslashes++;
        k--;
      }
      if (backslashes % 2 === 0) {
        result += '\\';
      }
      result += '|';
      i++;
    } else {
      result += cellText[i];
      i++;
    }
  }
  return result;
}

function reconstructTableFromAST(
  block: Extract<MarkdownBlockNode, { type: 'table' }>,
  source?: string,
  force = false
): string {
  const headerLine =
    '| ' +
    block.headers
      .map((h) => escapeTableCellPipes(serializeInlines(h, source, force)))
      .join(' | ') +
    ' |';
  const alignLine =
    '| ' +
    block.align
      .map((a) => {
        if (a === 'center') return ':---:';
        if (a === 'right') return '---:';
        if (a === 'left') return ':---';
        return '---';
      })
      .join(' | ') +
    ' |';
  const rowLines = block.rows.map(
    (r) =>
      '| ' +
      r
        .map((c) => escapeTableCellPipes(serializeInlines(c, source, force)))
        .join(' | ') +
      ' |'
  );
  return [headerLine, alignLine, ...rowLines].join('\n');
}

function replaceDirtyCellsInLine(
  lineText: string,
  ranges: { slotStart: number; slotEnd: number; from: number; to: number }[],
  cells: MarkdownInlineNode[][],
  source?: string,
  force = false
): string {
  interface Replacement {
    start: number;
    end: number;
    text: string;
  }
  const replacements: Replacement[] = [];

  for (let c = 0; c < cells.length; c++) {
    const cell = cells[c];
    if (cell && isCellDirty(cell, source)) {
      const cellRange = ranges[c];
      if (cellRange) {
        const forceCell =
          force ||
          (cell as { dirty?: boolean; modified?: boolean }).dirty === true ||
          (cell as { dirty?: boolean; modified?: boolean }).modified === true;
        const serialized = escapeTableCellPipes(serializeInlines(cell, source, forceCell));
        replacements.push({
          start: cellRange.from,
          end: cellRange.to,
          text: serialized
        });
      }
    }
  }

  replacements.sort((a, b) => b.start - a.start);
  let updated = lineText;
  for (const rep of replacements) {
    updated = updated.slice(0, rep.start) + rep.text + updated.slice(rep.end);
  }
  return updated;
}

function serializeTable(
  block: Extract<MarkdownBlockNode, { type: 'table' }>,
  source?: string,
  force = false
): string {
  const rawText =
    typeof block.raw === 'string' && block.raw.length > 0
      ? block.raw
      : source && block.range
        ? source.slice(block.range.from, block.range.to)
        : '';

  if (force || rawText.length === 0) {
    return reconstructTableFromAST(block, source, force);
  }

  const lines = splitLinesWithBreaks(rawText);
  const expectedDataRows = block.rows.length;

  if (lines.length < 2 + expectedDataRows) {
    return reconstructTableFromAST(block, source, force);
  }

  const headerRanges = getRowCellRanges(lines[0]!.text);
  if (headerRanges.length !== block.headers.length) {
    return reconstructTableFromAST(block, source, force);
  }

  for (let r = 0; r < expectedDataRows; r++) {
    const rowRanges = getRowCellRanges(lines[2 + r]!.text);
    if (rowRanges.length !== block.rows[r]!.length) {
      return reconstructTableFromAST(block, source, force);
    }
  }

  let headerLineText = lines[0]!.text;
  if (block.headers.some((cell) => isCellDirty(cell, source))) {
    headerLineText = replaceDirtyCellsInLine(headerLineText, headerRanges, block.headers, source, force);
  }

  const separatorLineText = lines[1]!.text;

  const rowLinesText: string[] = [];
  for (let r = 0; r < expectedDataRows; r++) {
    let rowLineText = lines[2 + r]!.text;
    const rowCells = block.rows[r]!;
    if (rowCells.some((cell) => isCellDirty(cell, source))) {
      const rowRanges = getRowCellRanges(rowLineText);
      rowLineText = replaceDirtyCellsInLine(rowLineText, rowRanges, rowCells, source, force);
    }
    rowLinesText.push(rowLineText);
  }

  let result = '';
  result += headerLineText + lines[0]!.break;
  result += separatorLineText + lines[1]!.break;
  for (let r = 0; r < expectedDataRows; r++) {
    result += rowLinesText[r] + lines[2 + r]!.break;
  }
  for (let idx = 2 + expectedDataRows; idx < lines.length; idx++) {
    result += lines[idx]!.text + lines[idx]!.break;
  }

  return result;
}

function serializeHeading(
  block: Extract<MarkdownBlockNode, { type: 'heading' }>,
  source?: string,
  force = false
): string {
  const title = serializeInlines(block.children, source, force);
  const rawText =
    typeof block.raw === 'string' && block.raw.length > 0
      ? block.raw
      : source && block.range
        ? source.slice(block.range.from, block.range.to)
        : '';

  if (force || rawText.length === 0) {
    const hashes = '#'.repeat(block.depth);
    return `${hashes} ${title}\n`;
  }

  const match = rawText.match(/^([ \t]*)(#{1,6})([ \t]+)/);
  if (!match) {
    const hashes = '#'.repeat(block.depth);
    const newline = rawText.endsWith('\r\n') ? '\r\n' : rawText.endsWith('\n') ? '\n' : '';
    return `${hashes} ${title}${newline}`;
  }

  const leadIndent = match[1] ?? '';
  const hashes = match[2]!.length === block.depth ? match[2]! : '#'.repeat(block.depth);
  const afterMarkerSpace = match[3] ?? ' ';
  const newline = rawText.endsWith('\r\n') ? '\r\n' : rawText.endsWith('\n') ? '\n' : '';

  // Check for closing sequence of # characters: e.g. " ##\r\n" or " ###  \n"
  // CommonMark: preceded by at least one space/tab, optionally followed by spaces/tabs
  const lineContent = rawText.slice(0, rawText.length - newline.length);
  const closeMatch = lineContent.match(/([ \t]+)(#{1,6})([ \t]*)$/);
  let closeSequence = '';
  if (closeMatch) {
    const closePreSpaces = closeMatch[1]!;
    const closeHashes = match[2]!.length === block.depth ? closeMatch[2]! : '#'.repeat(block.depth);
    const closePostSpaces = closeMatch[3]!;
    closeSequence = `${closePreSpaces}${closeHashes}${closePostSpaces}`;
  }

  return `${leadIndent}${hashes}${afterMarkerSpace}${title}${closeSequence}${newline}`;
}

function serializeCodeBlock(
  block: Extract<MarkdownBlockNode, { type: 'code-block' }>,
  source?: string,
  force = false
): string {
  const rawText =
    typeof block.raw === 'string' && block.raw.length > 0
      ? block.raw
      : source && block.range
        ? source.slice(block.range.from, block.range.to)
        : '';

  if (force || rawText.length === 0) {
    const lang = block.language ?? '';
    return `\`\`\`${lang}\n${block.value}\n\`\`\``;
  }

  const strippedOpen = rawText.replace(/^[ \t]*(?:>[ \t]*)+/, '');
  const openMatch = strippedOpen.match(/^([ \t]*)(`{3,}|~{3,})([^\r\n]*)(\r?\n)?/);
  if (!openMatch) {
    const lang = block.language ?? '';
    return `\`\`\`${lang}\n${block.value}\n\`\`\``;
  }

  const openIndent = openMatch[1] ?? '';
  const fenceChar = openMatch[2] ?? '```';
  const originalLangInfo = openMatch[3] ?? '';
  const newline = openMatch[4] || (rawText.includes('\r\n') ? '\r\n' : '\n');

  // Check if rawText actually had a closing fence
  // In CommonMark, a closing fence must be on a line after the opening line,
  // preceded by 0-3 spaces, using the same fence character and at least as many characters.
  const rawLines = rawText.split(/\r?\n/);
  let hasClosingFence = false;
  let closeIndent = openIndent;
  let closeFence = fenceChar;
  const trailingNewline = rawText.endsWith('\r\n') ? '\r\n' : rawText.endsWith('\n') ? '\n' : '';

  const closeRegex = new RegExp(`^([ \\t]*)(${fenceChar[0]}{${fenceChar.length},})[ \\t]*$`);
  if (rawLines.length >= 2) {
    const lastLineIdx = rawText.endsWith('\n') ? rawLines.length - 2 : rawLines.length - 1;
    if (lastLineIdx > 0) {
      const candidateLine = rawLines[lastLineIdx]!;
      const strippedCandidate = candidateLine.replace(/^[ \t]*(?:>[ \t]*)+/, '');
      const match = strippedCandidate.match(closeRegex);
      if (match) {
        hasClosingFence = true;
        closeIndent = match[1] && match[1].length > 0 ? match[1] : openIndent;
        closeFence = match[2] ?? fenceChar;
      }
    }
  }

  let langStr = originalLangInfo;
  if (block.language !== undefined) {
    if (originalLangInfo.trim() !== block.language) {
      langStr = block.language;
    }
  } else if (originalLangInfo.trim().length > 0) {
    langStr = '';
  }

  let normalizedValue = block.value;
  if (newline === '\r\n') {
    normalizedValue = normalizedValue.replace(/\r?\n/g, '\r\n');
  } else {
    normalizedValue = normalizedValue.replace(/\r?\n/g, '\n');
  }

  // Indent non-empty lines with opening fence indentation
  let indentedValue = normalizedValue;
  if (openIndent.length > 0 && normalizedValue.length > 0) {
    const valLines = normalizedValue.split(newline);
    indentedValue = valLines
      .map((line) => (line.length > 0 ? `${openIndent}${line}` : ''))
      .join(newline);
  }

  if (hasClosingFence) {
    const valueContent = indentedValue.length > 0 ? `${indentedValue}${newline}` : '';
    return `${openIndent}${fenceChar}${langStr}${newline}${valueContent}${closeIndent}${closeFence}${trailingNewline}`;
  } else {
    // Unclosed code block in original raw must remain unclosed
    if (indentedValue.length > 0) {
      return `${openIndent}${fenceChar}${langStr}${newline}${indentedValue}${trailingNewline}`;
    } else {
      return `${openIndent}${fenceChar}${langStr}${trailingNewline}`;
    }
  }
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

function serializeBlockMath(
  block: Extract<MarkdownBlockNode, { type: 'block-math' }>,
  source?: string,
  force = false
): string {
  const rawText =
    !force && typeof block.raw === 'string' && block.raw.length > 0
      ? block.raw
      : !force && block.raw === undefined && source && block.range
        ? source.slice(block.range.from, block.range.to)
        : '';

  if (force || rawText.length === 0) {
    return `$$\n${block.formula}\n$$`;
  }

  const match = rawText.match(/^([ \t]*\$\$)([\s\S]*?)(\$\$[ \t]*(\r?\n)?)$/);
  if (!match) {
    const newline = rawText.includes('\r\n') ? '\r\n' : '\n';
    const trailingNewline = rawText.endsWith('\r\n') ? '\r\n' : rawText.endsWith('\n') ? newline : '';
    return `$$${newline}${block.formula}${newline}$$${trailingNewline}`;
  }

  const openPart = match[1]!;
  const middle = match[2]!;
  const closePart = match[3]!;

  const leadPad = middle.match(/^\s*/)?.[0] ?? '';
  const trailPad = middle.match(/\s*$/)?.[0] ?? '';

  return `${openPart}${leadPad}${block.formula}${trailPad}${closePart}`;
}

function serializeParagraph(
  block: Extract<MarkdownBlockNode, { type: 'paragraph' }>,
  source?: string,
  force = false
): string {
  const inlinesText = serializeInlines(block.children, source, force);
  if (!force) {
    const rawText =
      typeof block.raw === 'string' && block.raw.length > 0
        ? block.raw
        : source && block.range
          ? source.slice(block.range.from, block.range.to)
          : '';
    if (rawText.endsWith('\r\n') && !inlinesText.endsWith('\r\n')) {
      return inlinesText + '\r\n';
    } else if (rawText.endsWith('\n') && !inlinesText.endsWith('\n')) {
      return inlinesText + '\n';
    }
  }
  return inlinesText;
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
