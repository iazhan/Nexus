import type { MarkdownBlockNode, SourceRange } from '@nexus/markdown';

/**
 * Minimal duck-typed DOM Node interface allowing pure function execution
 * in both browser DOM environments and Node.js testing environments.
 */
export interface MinimalDomNode {
  nodeType: number;
  nodeName: string;
  textContent?: string | null;
  nodeValue?: string | null;
  childNodes?: MinimalDomNode[] | NodeListOf<ChildNode> | readonly MinimalDomNode[];
  getAttribute?: (name: string) => string | null;
}

export interface EditableBlockSnapshot {
  key: string;
  type: 'paragraph' | 'heading';
  depth?: 1 | 2 | 3 | 4 | 5 | 6;
  sourceRange: SourceRange;
  markdownBefore: string;
}

/**
 * Generates a stable unique identity string for a block node.
 */
export function getBlockNodeKey(node: MarkdownBlockNode): string {
  return `${node.type}:${node.range.from}:${node.range.to}`;
}

/**
 * Escapes CommonMark ASCII punctuation characters that aren't already escaped.
 */
export function escapeMarkdownPunctuation(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\' && i + 1 < text.length) {
      result += ch + text[i + 1]!;
      i++;
    } else if (/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(ch)) {
      result += '\\' + ch;
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * Formats an inline code string according to CommonMark rules:
 * - Preserves original delimiter length (e.g. double backticks ``) unless conflict requires upgrade
 * - Finds runs of backticks in value and upgrades fence if needed
 * - Preserves original space padding or adds necessary padding
 */
export function formatInlineCode(
  value: string,
  origDelimLen = 1,
  origHadPadding = false
): string {
  if (value.length === 0) {
    return '';
  }

  // Find all consecutive backtick runs in value
  const backtickRuns = new Set<number>();
  for (const m of value.matchAll(/`+/g)) {
    backtickRuns.add(m[0].length);
  }

  let delimLen = Math.max(origDelimLen, 1);
  while (backtickRuns.has(delimLen)) {
    delimLen++;
  }
  const fence = '`'.repeat(delimLen);

  let needsPadding = false;
  if (value.startsWith('`') || value.endsWith('`')) {
    needsPadding = true;
  } else if ((value.startsWith(' ') || value.endsWith(' ')) && value.trim().length > 0) {
    needsPadding = true;
  } else if (origHadPadding) {
    needsPadding = true;
  }

  return needsPadding ? `${fence} ${value} ${fence}` : `${fence}${value}${fence}`;
}

/**
 * Serializes DOM nodes within an editable block into clean Markdown inline syntax.
 * Adheres strictly to security and fidelity constraints:
 * - Operates purely on DOM text nodes and attributes without HTML string injection
 * - Preserves opaque/non-editable inlines ($math$, [[wiki]], raw HTML) via data-raw
 * - Preserves escaped characters via data-raw and data-value
 * - Preserves inline-code delimiter length and padding
 * - Preserves bold (** or __) and italic (* or _) delimiters
 * - Neutralizes unrecognized or dangerous elements as safe plain text
 */
export function serializeEditableInlineContent(root: MinimalDomNode | Node): string {
  const domNode = root as MinimalDomNode;

  // Text Node (nodeType === 3)
  if (domNode.nodeType === 3) {
    return domNode.nodeValue ?? domNode.textContent ?? '';
  }

  // Non-Element Node (not 1 and not 3)
  if (domNode.nodeType !== 1) {
    return '';
  }

  const getAttr = (name: string): string | null => {
    if (typeof domNode.getAttribute === 'function') {
      return domNode.getAttribute(name);
    }
    return null;
  };

  const rawAttr = getAttr('data-raw');
  const nodeType = getAttr('data-node-type');

  // Handle escaped text nodes
  if (nodeType === 'escaped') {
    const originalVal = getAttr('data-value');
    const currentText = domNode.textContent ?? '';

    // If unmodified, return original raw (e.g. "\*")
    if (originalVal !== null && currentText === originalVal && rawAttr !== null) {
      return rawAttr;
    }
    if (currentText.length === 0) {
      return '';
    }
    return escapeMarkdownPunctuation(currentText);
  }

  // If node has explicit data-raw (non-editable inlines: math, wikilink, raw HTML, image, link)
  if (
    nodeType === 'inline-math' ||
    nodeType === 'wikilink' ||
    nodeType === 'raw' ||
    nodeType === 'image' ||
    nodeType === 'link'
  ) {
    if (rawAttr !== null) {
      return rawAttr;
    }
  }

  const tagName = domNode.nodeName.toUpperCase();

  // Helper to serialize all child nodes recursively
  const serializeChildren = (): string => {
    if (!domNode.childNodes) return '';
    const children = Array.from(domNode.childNodes as unknown as ArrayLike<MinimalDomNode>);
    return children.map(serializeEditableInlineContent).join('');
  };

  // Bold mark (STRONG, B, or data-node-type="bold")
  if (tagName === 'STRONG' || tagName === 'B' || nodeType === 'bold') {
    const delim = getAttr('data-delim') || '**';
    const inner = serializeChildren();
    return `${delim}${inner}${delim}`;
  }

  // Italic mark (EM, I, or data-node-type="italic")
  if (tagName === 'EM' || tagName === 'I' || nodeType === 'italic') {
    const delim = getAttr('data-delim') || '*';
    const inner = serializeChildren();
    return `${delim}${inner}${delim}`;
  }

  // Inline Code mark (CODE or data-node-type="inline-code")
  if (tagName === 'CODE' || nodeType === 'inline-code') {
    const originalVal = getAttr('data-value');
    const delimLenAttr = getAttr('data-delim-len');
    const hadPaddingAttr = getAttr('data-had-padding');
    const codeText = domNode.textContent ?? '';

    // If unmodified, return original raw slice verbatim
    if (originalVal !== null && codeText === originalVal && rawAttr !== null) {
      return rawAttr;
    }

    const origDelimLen = delimLenAttr ? parseInt(delimLenAttr, 10) || 1 : 1;
    const origHadPadding = hadPaddingAttr === 'true';

    return formatInlineCode(codeText, origDelimLen, origHadPadding);
  }

  // Line break (<br>)
  if (tagName === 'BR') {
    return '\n';
  }

  // Recognized inline containers (SPAN, P, DIV, etc.)
  if (tagName === 'SPAN' || tagName === 'P' || tagName === 'DIV') {
    return serializeChildren();
  }

  // Unrecognized or potentially dangerous element: treat content purely as plain text
  return domNode.textContent ?? '';
}

/**
 * Reconstructs the full heading block string from new inline markdown text,
 * preserving leading indentation, # depth, spaces after hashes, closing # sequences,
 * and original line break endings (CRLF or LF).
 */
export function buildHeadingReplacement(
  originalRaw: string,
  depth: 1 | 2 | 3 | 4 | 5 | 6,
  newInlines: string
): string {
  const newline = originalRaw.endsWith('\r\n')
    ? '\r\n'
    : originalRaw.endsWith('\n')
      ? '\n'
      : '';

  const match = originalRaw.match(/^([ \t]*)(#{1,6})([ \t]+)/);
  if (!match) {
    const hashes = '#'.repeat(depth);
    return `${hashes} ${newInlines}${newline}`;
  }

  const leadIndent = match[1] ?? '';
  const hashes = match[2]!.length === depth ? match[2]! : '#'.repeat(depth);
  const afterMarkerSpace = match[3] ?? ' ';

  const lineContent = originalRaw.slice(0, originalRaw.length - newline.length);
  const closeMatch = lineContent.match(/([ \t]+)(#{1,6})([ \t]*)$/);
  let closeSequence = '';
  if (closeMatch) {
    const closePreSpaces = closeMatch[1]!;
    const closeHashes = match[2]!.length === depth ? closeMatch[2]! : '#'.repeat(depth);
    const closePostSpaces = closeMatch[3]!;
    closeSequence = `${closePreSpaces}${closeHashes}${closePostSpaces}`;
  }

  return `${leadIndent}${hashes}${afterMarkerSpace}${newInlines}${closeSequence}${newline}`;
}

/**
 * Reconstructs the paragraph block string from new inline markdown text,
 * preserving original line break ending (CRLF, LF, or none).
 */
export function buildParagraphReplacement(
  originalRaw: string,
  newInlines: string
): string {
  if (originalRaw.endsWith('\r\n') && !newInlines.endsWith('\r\n')) {
    return newInlines + '\r\n';
  }
  if (originalRaw.endsWith('\n') && !newInlines.endsWith('\n')) {
    return newInlines + '\n';
  }
  return newInlines;
}

/**
 * Reconstructs a block replacement string based on its block type.
 */
export function buildBlockReplacement(
  block: MarkdownBlockNode,
  newInlines: string
): string {
  if (block.type === 'heading') {
    return buildHeadingReplacement(block.raw, block.depth, newInlines);
  }
  if (block.type === 'paragraph') {
    return buildParagraphReplacement(block.raw, newInlines);
  }
  return newInlines;
}

/**
 * Performs localized source replacement on a half-open interval [from, to).
 * Guarantees that untouched source outside the target range is preserved with byte-for-byte fidelity.
 */
export function updateSourceWithBlock(
  source: string,
  range: SourceRange,
  replacement: string
): string {
  if (
    range.from < 0 ||
    range.to > source.length ||
    range.from > range.to
  ) {
    throw new RangeError(
      `SourceRange [${range.from}, ${range.to}) out of bounds for source of length ${source.length}`
    );
  }

  return source.slice(0, range.from) + replacement + source.slice(range.to);
}
