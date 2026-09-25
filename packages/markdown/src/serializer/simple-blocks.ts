/**
 * 只依赖行内序列化器的简单块：标题、段落、块级公式。
 */
import type { MarkdownBlockNode } from '../types.js';
import { serializeInlines } from './inline.js';

export function serializeHeading(
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

export function serializeBlockMath(
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

export function serializeParagraph(
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

