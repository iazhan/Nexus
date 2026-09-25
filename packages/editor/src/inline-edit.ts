import {
  Facet,
  type Extension
} from '@codemirror/state';
import {
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view';
import { extensionHostFacet, mountExtension, type EditorExtensionControl } from './extensions.js';
import { editorLocaleFacet } from './source-editor.js';
import { translate } from '@nexus/i18n';
import {
  parseMarkdown,
  sanitizeUrl,
  type MarkdownInlineNode,
  type MarkdownRoot
} from '@nexus/markdown';
import type { MarkdownDocumentSession } from './document-session.js';
import type {
  MarkdownChange,
  MarkdownEditTransaction,
  MarkdownSelection
} from './types.js';

export type InlineEditNodeType = 'link' | 'image' | 'inline-code' | 'wikilink';

export interface InlineEditContext {
  nodeType: InlineEditNodeType;
  range: { from: number; to: number };
  raw: string;
  source: string;
}

export interface LinkEditValue {
  label: string;
  destination: string;
  title?: string;
  syntax?: 'inline' | 'angle' | 'autolink';
}

export interface ImageEditValue {
  alt: string;
  destination: string;
  title?: string;
}

export interface InlineCodeEditValue {
  value: string;
}

export interface WikiLinkEditValue {
  target: string;
  alias?: string;
}

export interface ImageEditContext {
  range: { from: number; to: number };
  raw: string;
  alt: string;
  destination: string;
  title?: string;
}

export type ImageSourceResolver = (
  currentSource: string,
  context: ImageEditContext
) => Promise<string | null> | string | null;

export interface InlineEditExtensionOptions {
  imageSourceResolver?: ImageSourceResolver;
  surfaceId?: string;
}

const inlineEditOptionsFacet = Facet.define<InlineEditExtensionOptions, InlineEditExtensionOptions>({
  combine: (values) => values[0] ?? {}
});

export function escapeMarkdownInlineText(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/([[\]*_`$<>~|])/g, '\\$1');
}

export function unescapeMarkdownInlineText(str: string): string {
  return str.replace(/\\([[\]*_`$<>~|\\])/g, '$1');
}

export function extractLinkRawLabel(raw: string): string | null {
  const startIdx = raw.startsWith('![') ? 2 : raw.startsWith('[') ? 1 : -1;
  if (startIdx === -1) return null;
  let depth = 0;
  for (let i = startIdx; i < raw.length; i++) {
    if (raw[i] === '\\') {
      i++;
      continue;
    }
    if (raw[i] === '[') {
      depth++;
    } else if (raw[i] === ']') {
      if (depth === 0) {
        return raw.slice(startIdx, i);
      }
      depth--;
    }
  }
  return null;
}

export function getInlineNodePlainText(node: MarkdownInlineNode): string {
  if (node.type === 'link') {
    const hasRichChildren = node.children.some((c) =>
      ['strong', 'emphasis', 'inline-code', 'inline-math', 'wikilink', 'image'].includes(c.type)
    );
    if (!hasRichChildren && typeof node.raw === 'string' && node.raw.startsWith('[')) {
      const labelSlice = extractLinkRawLabel(node.raw);
      if (labelSlice !== null) {
        return unescapeMarkdownInlineText(labelSlice);
      }
    }
  }
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.map(getInlineNodePlainText).join('');
  }
  if ('value' in node && typeof node.value === 'string') {
    return unescapeMarkdownInlineText(node.value);
  }
  if (node.type === 'inline-math') {
    return node.formula;
  }
  if (node.type === 'image') {
    return node.alt;
  }
  if (node.type === 'wikilink') {
    return node.alias ?? node.target;
  }
  return '';
}

function findInlineNodeAtRange(
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

function verifyCandidateNode(
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

interface LocalParenDescriptor {
  wsBeforeDest: string;
  hasAngle: boolean;
  destRaw: string;
  destination: string;
  wsBetween: string;
  hadTitle: boolean;
  titleRaw: string;
  titleQuoteOpen: string;
  titleQuoteClose: string;
  titleValue: string;
  wsAfter: string;
}

export function requiresAngleBrackets(dest: string): boolean {
  if (/[\s\r\n]/.test(dest)) return true;
  let depth = 0;
  for (let i = 0; i < dest.length; i++) {
    if (dest[i] === '\\') {
      i++;
      continue;
    }
    if (dest[i] === '(') {
      depth++;
    } else if (dest[i] === ')') {
      depth--;
      if (depth < 0) return true;
    }
  }
  return depth !== 0;
}

function parseLocalParenDescriptor(insideParen: string): LocalParenDescriptor {
  const wsBeforeMatch = insideParen.match(/^[\s\r\n]*/);
  const wsBeforeDest = wsBeforeMatch ? wsBeforeMatch[0] : '';
  let i = wsBeforeDest.length;

  let hasAngle = false;
  let destRaw = '';
  let destination = '';

  if (insideParen[i] === '<') {
    hasAngle = true;
    const start = i;
    i++;
    while (i < insideParen.length) {
      if (insideParen[i] === '\\') {
        i += 2;
        continue;
      }
      if (insideParen[i] === '>') {
        break;
      }
      i++;
    }
    if (i < insideParen.length && insideParen[i] === '>') {
      destRaw = insideParen.slice(start, i + 1);
      destination = insideParen.slice(start + 1, i);
      i++;
    } else {
      destRaw = insideParen.slice(start);
      destination = insideParen.slice(start + 1);
    }
  } else {
    const start = i;
    let parenDepth = 0;
    while (i < insideParen.length) {
      const ch = insideParen[i];
      if (!ch) {
        break;
      }
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (/[\s\r\n]/.test(ch)) {
        break;
      }
      if (ch === '(') {
        parenDepth++;
      } else if (ch === ')') {
        if (parenDepth > 0) {
          parenDepth--;
        } else {
          break;
        }
      }
      i++;
    }
    destRaw = insideParen.slice(start, i);
    destination = destRaw;
  }

  const afterDest = insideParen.slice(i);
  const wsBetweenMatch = afterDest.match(/^[\s\r\n]*/);
  let wsBetween = wsBetweenMatch ? wsBetweenMatch[0] : '';
  i += wsBetween.length;

  let hadTitle = false;
  let titleRaw = '';
  let titleQuoteOpen = '"';
  let titleQuoteClose = '"';
  let titleValue = '';
  let wsAfter = '';

  if (i < insideParen.length) {
    const firstTitleChar = insideParen[i];
    if (firstTitleChar === '"' || firstTitleChar === "'" || firstTitleChar === '(') {
      hadTitle = true;
      titleQuoteOpen = firstTitleChar;
      titleQuoteClose = firstTitleChar === '(' ? ')' : firstTitleChar;
      const titleStart = i;
      i++;
      while (i < insideParen.length) {
        if (insideParen[i] === '\\') {
          i += 2;
          continue;
        }
        if (insideParen[i] === titleQuoteClose) {
          break;
        }
        i++;
      }
      if (i < insideParen.length && insideParen[i] === titleQuoteClose) {
        titleRaw = insideParen.slice(titleStart, i + 1);
        titleValue = insideParen.slice(titleStart + 1, i);
        i++;
      } else {
        titleRaw = insideParen.slice(titleStart);
        titleValue = insideParen.slice(titleStart + 1);
      }
    }
  }

  const wsAfterMatch = insideParen.slice(i).match(/^[\s\r\n]*/);
  wsAfter = wsAfterMatch ? wsAfterMatch[0] : '';

  if (!hadTitle) {
    wsAfter = wsBetween;
    wsBetween = '';
  }

  return {
    wsBeforeDest,
    hasAngle,
    destRaw,
    destination,
    wsBetween,
    hadTitle,
    titleRaw,
    titleQuoteOpen,
    titleQuoteClose,
    titleValue,
    wsAfter
  };
}

export type ReferenceKind = 'inline' | 'autolink' | 'full' | 'collapsed' | 'shortcut';

export function getReferenceKind(raw: string): ReferenceKind {
  if (raw.startsWith('<') && raw.endsWith('>')) return 'autolink';
  if (raw.includes('](')) return 'inline';
  if (!raw.startsWith('[') && !raw.startsWith('![')) return 'inline';

  const startIdx = raw.startsWith('![') ? 2 : 1;
  let firstClose = -1;
  for (let i = startIdx; i < raw.length; i++) {
    if (raw[i] === '\\') {
      i++;
      continue;
    }
    if (raw[i] === ']') {
      firstClose = i;
      break;
    }
  }
  if (firstClose === -1) return 'inline';
  if (firstClose === raw.length - 1) return 'shortcut';

  const afterFirst = raw.slice(firstClose + 1);
  if (afterFirst === '[]') return 'collapsed';
  if (afterFirst.startsWith('[') && afterFirst.endsWith(']')) return 'full';
  return 'inline';
}

export function createLinkEditTransaction(
  source: string,
  context: InlineEditContext,
  value: LinkEditValue,
  selection?: MarkdownSelection
): MarkdownEditTransaction | null {
  if (context.source !== source) {
    return null;
  }
  if (
    context.range.from < 0 ||
    context.range.to > source.length ||
    context.range.from > context.range.to ||
    source.slice(context.range.from, context.range.to) !== context.raw
  ) {
    return null;
  }

  const { root } = parseMarkdown(source);
  const targetNode = findInlineNodeAtRange(root, 'link', context.range);
  if (!targetNode || targetNode.type !== 'link') {
    return null;
  }

  if (
    /[\r\n]/.test(value.label) ||
    /[\r\n]/.test(value.destination) ||
    (value.title && /[\r\n]/.test(value.title))
  ) {
    return null;
  }

  const sanitizeResult = sanitizeUrl(value.destination);
  if (sanitizeResult.isBlocked) {
    return null;
  }

  const originalPlainLabel = getInlineNodePlainText(targetNode);
  let newRaw: string;

  const refKind = getReferenceKind(context.raw);
  const isAutolink = refKind === 'autolink';

  if (refKind === 'shortcut' || refKind === 'collapsed') {
    return null;
  }

  if (refKind === 'full') {
    if (value.destination !== targetNode.href) {
      return null;
    }
    if (value.title && value.title !== targetNode.title) {
      return null;
    }
    const labelSlice = extractLinkRawLabel(context.raw);
    if (labelSlice === null) return null;
    const closeBracketIdx = labelSlice.length + 1;
    const refPart = context.raw.slice(closeBracketIdx);
    const labelStr =
      value.label === originalPlainLabel
        ? labelSlice
        : escapeMarkdownInlineText(value.label);
    newRaw = `[${labelStr}${refPart}`;
  } else if (isAutolink) {
    if (!value.title && (value.label === originalPlainLabel || value.label === value.destination)) {
      newRaw = `<${value.destination}>`;
    } else {
      const labelStr = escapeMarkdownInlineText(value.label);
      const titleStr = value.title ? ` "${value.title.replace(/"/g, '\\"')}"` : '';
      newRaw = `[${labelStr}](${value.destination}${titleStr})`;
    }
  } else {
    const labelSlice = extractLinkRawLabel(context.raw);
    if (labelSlice === null) return null;
    const parenOpenIdx = labelSlice.length + 1;
    if (context.raw.slice(parenOpenIdx, parenOpenIdx + 2) !== '](') return null;
    const insideParen = context.raw.slice(parenOpenIdx + 2, -1);
    const desc = parseLocalParenDescriptor(insideParen);

    const useAngle =
      value.syntax === 'angle' ||
      (desc.hasAngle && value.syntax !== 'inline') ||
      requiresAngleBrackets(value.destination);

    const destStr =
      value.destination === targetNode.href
        ? desc.destRaw
        : (useAngle ? `<${value.destination}>` : value.destination);

    let labelStr: string;
    if (value.label === originalPlainLabel) {
      labelStr = labelSlice;
    } else {
      labelStr = escapeMarkdownInlineText(value.label);
    }

    let destAndTitleStr: string;
    if (!value.title) {
      destAndTitleStr = `${desc.wsBeforeDest}${destStr}${desc.wsAfter}`;
    } else if (value.title === targetNode.title && desc.hadTitle) {
      destAndTitleStr = `${desc.wsBeforeDest}${destStr}${desc.wsBetween}${desc.titleRaw}${desc.wsAfter}`;
    } else {
      const openQ = desc.hadTitle ? desc.titleQuoteOpen : '"';
      const closeQ = desc.hadTitle ? desc.titleQuoteClose : '"';
      const safeTitle = value.title.replace(
        new RegExp(closeQ === ')' ? '\\)' : closeQ, 'g'),
        `\\${closeQ}`
      );
      const spacing = desc.hadTitle && desc.wsBetween ? desc.wsBetween : ' ';
      destAndTitleStr = `${desc.wsBeforeDest}${destStr}${spacing}${openQ}${safeTitle}${closeQ}${desc.wsAfter}`;
    }

    newRaw = `[${labelStr}](${destAndTitleStr})`;
  }

  if (newRaw === context.raw) {
    return null;
  }

  const semanticValidator = (node: MarkdownInlineNode): boolean => {
    if (node.type !== 'link') return false;
    if (node.href !== value.destination && node.href !== targetNode.href) return false;
    const expectedTitle = value.title ? value.title : undefined;
    const actualTitle = node.title ? node.title : undefined;
    if (actualTitle !== expectedTitle) return false;
    const plain = getInlineNodePlainText(node);
    if (node.raw.startsWith('<') && node.raw.endsWith('>')) {
      if (plain !== value.destination) return false;
    } else {
      if (plain !== value.label) return false;
    }
    return true;
  };

  const candidateSource =
    source.slice(0, context.range.from) + newRaw + source.slice(context.range.to);
  const newEnd = context.range.from + newRaw.length;
  if (!verifyCandidateNode(candidateSource, context.range.from, newEnd, 'link', newRaw, semanticValidator)) {
    return null;
  }

  const changes: MarkdownChange[] = [
    {
      from: context.range.from,
      to: context.range.to,
      insert: newRaw
    }
  ];

  const nextPos = context.range.from + newRaw.length;
  const nextSelection: MarkdownSelection = selection ?? { anchor: nextPos, head: nextPos };

  return {
    changes,
    selection: nextSelection,
    userEvent: 'link.edit'
  };
}

export function createImageEditTransaction(
  source: string,
  context: InlineEditContext,
  value: ImageEditValue,
  selection?: MarkdownSelection
): MarkdownEditTransaction | null {
  if (context.source !== source) {
    return null;
  }
  if (
    context.range.from < 0 ||
    context.range.to > source.length ||
    context.range.from > context.range.to ||
    source.slice(context.range.from, context.range.to) !== context.raw
  ) {
    return null;
  }

  const { root } = parseMarkdown(source);
  const targetNode = findInlineNodeAtRange(root, 'image', context.range);
  if (!targetNode || targetNode.type !== 'image') {
    return null;
  }

  if (
    /[\r\n]/.test(value.alt) ||
    /[\r\n]/.test(value.destination) ||
    (value.title && /[\r\n]/.test(value.title))
  ) {
    return null;
  }

  const sanitizeResult = sanitizeUrl(value.destination);
  if (sanitizeResult.isBlocked) {
    return null;
  }

  const refKind = getReferenceKind(context.raw);

  if (refKind === 'shortcut' || refKind === 'collapsed') {
    return null;
  }

  let newRaw: string;

  if (refKind === 'full') {
    if (value.destination !== targetNode.src) {
      return null;
    }
    if (value.title && value.title !== targetNode.title) {
      return null;
    }
    const altSlice = extractLinkRawLabel(context.raw);
    if (altSlice === null) return null;
    const closeBracketIdx = altSlice.length + 2;
    const refPart = context.raw.slice(closeBracketIdx);
    const altStr =
      value.alt === targetNode.alt
        ? altSlice
        : escapeMarkdownInlineText(value.alt);
    newRaw = `![${altStr}${refPart}`;
  } else {
    const altSlice = extractLinkRawLabel(context.raw);
    if (altSlice === null) return null;
    const parenOpenIdx = altSlice.length + 2;
    if (context.raw.slice(parenOpenIdx, parenOpenIdx + 2) !== '](') return null;
    const insideParen = context.raw.slice(parenOpenIdx + 2, -1);
    const desc = parseLocalParenDescriptor(insideParen);

    const useAngle = desc.hasAngle || requiresAngleBrackets(value.destination);
    const destStr = useAngle ? `<${value.destination}>` : value.destination;

    const altStr =
      value.alt === targetNode.alt ? altSlice : escapeMarkdownInlineText(value.alt);

    let destAndTitleStr: string;
    if (!value.title) {
      destAndTitleStr = `${desc.wsBeforeDest}${destStr}${desc.wsAfter}`;
    } else if (value.title === targetNode.title && desc.hadTitle) {
      destAndTitleStr = `${desc.wsBeforeDest}${destStr}${desc.wsBetween}${desc.titleRaw}${desc.wsAfter}`;
    } else {
      const openQ = desc.hadTitle ? desc.titleQuoteOpen : '"';
      const closeQ = desc.hadTitle ? desc.titleQuoteClose : '"';
      const safeTitle = value.title.replace(
        new RegExp(closeQ === ')' ? '\\)' : closeQ, 'g'),
        `\\${closeQ}`
      );
      const spacing = desc.hadTitle && desc.wsBetween ? desc.wsBetween : ' ';
      destAndTitleStr = `${desc.wsBeforeDest}${destStr}${spacing}${openQ}${safeTitle}${closeQ}${desc.wsAfter}`;
    }

    newRaw = `![${altStr}](${destAndTitleStr})`;
  }

  if (newRaw === context.raw) {
    return null;
  }

  const semanticValidator = (node: MarkdownInlineNode): boolean => {
    if (node.type !== 'image') return false;
    if (node.src !== value.destination) return false;
    if (node.alt !== value.alt) return false;
    const expectedTitle = value.title ? value.title : undefined;
    const actualTitle = node.title ? node.title : undefined;
    if (actualTitle !== expectedTitle) return false;
    return true;
  };

  const candidateSource =
    source.slice(0, context.range.from) + newRaw + source.slice(context.range.to);
  const newEnd = context.range.from + newRaw.length;
  if (!verifyCandidateNode(candidateSource, context.range.from, newEnd, 'image', newRaw, semanticValidator)) {
    return null;
  }

  const changes: MarkdownChange[] = [
    {
      from: context.range.from,
      to: context.range.to,
      insert: newRaw
    }
  ];

  const nextPos = context.range.from + newRaw.length;
  const nextSelection: MarkdownSelection = selection ?? { anchor: nextPos, head: nextPos };

  return {
    changes,
    selection: nextSelection,
    userEvent: 'image.edit'
  };
}

export function createInlineCodeEditTransaction(
  source: string,
  context: InlineEditContext,
  value: InlineCodeEditValue,
  selection?: MarkdownSelection
): MarkdownEditTransaction | null {
  if (context.source !== source) {
    return null;
  }
  if (
    context.range.from < 0 ||
    context.range.to > source.length ||
    context.range.from > context.range.to ||
    source.slice(context.range.from, context.range.to) !== context.raw
  ) {
    return null;
  }

  if (/[\r\n]/.test(value.value)) {
    return null;
  }

  const { root } = parseMarkdown(source);
  const targetNode = findInlineNodeAtRange(root, 'inline-code', context.range);
  if (!targetNode || targetNode.type !== 'inline-code') {
    return null;
  }

  if (value.value === targetNode.value) {
    return null;
  }

  const origFenceMatch = context.raw.match(/^`+/);
  const origFenceLength = origFenceMatch ? origFenceMatch[0].length : 1;
  const origHadPadding =
    context.raw.length >= origFenceLength * 2 + 2 &&
    context.raw[origFenceLength] === ' ' &&
    context.raw[context.raw.length - origFenceLength - 1] === ' ';

  const backtickRuns = new Set<number>();
  const matches = value.value.match(/`+/g);
  let maxRun = 0;
  if (matches) {
    for (const m of matches) {
      backtickRuns.add(m.length);
      if (m.length > maxRun) maxRun = m.length;
    }
  }

  const requiredFenceLength = maxRun === 0 ? 1 : maxRun + 1;
  let selectedFenceLength = Math.max(origFenceLength, requiredFenceLength);
  while (backtickRuns.has(selectedFenceLength)) {
    selectedFenceLength++;
  }

  const fence = '`'.repeat(selectedFenceLength);
  let needsPadding = false;
  if (
    value.value.startsWith('`') ||
    value.value.endsWith('`') ||
    value.value.includes('`') ||
    ((value.value.startsWith(' ') || value.value.endsWith(' ')) &&
      value.value.trim().length > 0) ||
    (origHadPadding && value.value.trim().length > 0)
  ) {
    needsPadding = true;
  }

  const newRaw = needsPadding ? `${fence} ${value.value} ${fence}` : `${fence}${value.value}${fence}`;

  if (newRaw === context.raw) {
    return null;
  }

  const semanticValidator = (node: MarkdownInlineNode): boolean => {
    if (node.type !== 'inline-code') return false;
    if (node.value !== value.value) return false;
    return true;
  };

  const candidateSource =
    source.slice(0, context.range.from) + newRaw + source.slice(context.range.to);
  const newEnd = context.range.from + newRaw.length;
  if (!verifyCandidateNode(candidateSource, context.range.from, newEnd, 'inline-code', newRaw, semanticValidator)) {
    return null;
  }

  const changes: MarkdownChange[] = [
    {
      from: context.range.from,
      to: context.range.to,
      insert: newRaw
    }
  ];

  const nextPos = context.range.from + newRaw.length;
  const nextSelection: MarkdownSelection = selection ?? { anchor: nextPos, head: nextPos };

  return {
    changes,
    selection: nextSelection,
    userEvent: 'code.edit'
  };
}

export function createWikiLinkEditTransaction(
  source: string,
  context: InlineEditContext,
  value: WikiLinkEditValue,
  selection?: MarkdownSelection
): MarkdownEditTransaction | null {
  if (context.source !== source) {
    return null;
  }
  if (
    context.range.from < 0 ||
    context.range.to > source.length ||
    context.range.from > context.range.to ||
    source.slice(context.range.from, context.range.to) !== context.raw
  ) {
    return null;
  }

  if (
    !value.target.trim() ||
    value.target !== value.target.trim() ||
    value.target.includes('|') ||
    value.target.includes('[') ||
    value.target.includes(']') ||
    /[\r\n]/.test(value.target)
  ) {
    return null;
  }

  if (value.alias !== undefined) {
    if (
      value.alias.trim() === '' ||
      value.alias.includes('|') ||
      value.alias.includes('[') ||
      value.alias.includes(']') ||
      /[\r\n]/.test(value.alias)
    ) {
      return null;
    }
  }

  const { root } = parseMarkdown(source);
  const targetNode = findInlineNodeAtRange(root, 'wikilink', context.range);
  if (!targetNode || targetNode.type !== 'wikilink') {
    return null;
  }

  const insideOriginal = context.raw.slice(2, -2);
  const pipeIdx = insideOriginal.indexOf('|');
  let targetStr: string;
  let aliasStr: string | undefined;

  if (value.target === targetNode.target) {
    const origTargetPart = pipeIdx !== -1 ? insideOriginal.slice(0, pipeIdx) : insideOriginal;
    targetStr = origTargetPart;
  } else {
    targetStr = value.target;
  }

  if (value.alias) {
    if (value.alias === targetNode.alias && pipeIdx !== -1) {
      aliasStr = insideOriginal.slice(pipeIdx + 1);
    } else if (pipeIdx !== -1) {
      const origAliasPart = insideOriginal.slice(pipeIdx + 1);
      const wsBefore = origAliasPart.match(/^\s*/)?.[0] ?? '';
      const wsAfter = origAliasPart.match(/\s*$/)?.[0] ?? '';
      aliasStr = `${wsBefore}${value.alias}${wsAfter}`;
    } else {
      aliasStr = value.alias;
    }
  }

  const newRaw = aliasStr !== undefined ? `[[${targetStr}|${aliasStr}]]` : `[[${targetStr}]]`;

  if (newRaw === context.raw) {
    return null;
  }

  const semanticValidator = (node: MarkdownInlineNode): boolean => {
    if (node.type !== 'wikilink') return false;
    if (node.target !== value.target) return false;
    const expectedAlias = value.alias && value.alias.trim() ? value.alias.trim() : undefined;
    const actualAlias = node.alias ? node.alias.trim() : undefined;
    if (actualAlias !== expectedAlias) return false;
    return true;
  };

  const candidateSource =
    source.slice(0, context.range.from) + newRaw + source.slice(context.range.to);
  const newEnd = context.range.from + newRaw.length;
  if (!verifyCandidateNode(candidateSource, context.range.from, newEnd, 'wikilink', newRaw, semanticValidator)) {
    return null;
  }

  const changes: MarkdownChange[] = [
    {
      from: context.range.from,
      to: context.range.to,
      insert: newRaw
    }
  ];

  const nextPos = context.range.from + newRaw.length;
  const nextSelection: MarkdownSelection = selection ?? { anchor: nextPos, head: nextPos };

  return {
    changes,
    selection: nextSelection,
    userEvent: 'wikilink.edit'
  };
}

export class LinkWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly label: string,
    public readonly safeHref: string | null,
    public readonly isBlocked: boolean = false,
    public readonly title?: string
  ) {
    super();
  }

  public toDOM(): HTMLElement {
    const a = document.createElement('a');
    a.className = 'cm-visual-link cm-visual-link-widget';
    a.dataset.from = String(this.from);
    a.dataset.to = String(this.to);
    a.setAttribute('role', 'link');
    a.setAttribute('tabindex', '-1');

    if (this.isBlocked || !this.safeHref) {
      a.classList.add('cm-visual-link-blocked');
      a.setAttribute('aria-disabled', 'true');
      a.setAttribute('title', this.title || 'Blocked unsafe link');
    } else {
      a.setAttribute('href', this.safeHref);
      if (this.title) {
        a.setAttribute('title', this.title);
      }
    }
    a.textContent = this.label || this.safeHref || this.raw;

    a.addEventListener('click', (e) => {
      e.preventDefault();
    });

    return a;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof LinkWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.label === this.label &&
      other.safeHref === this.safeHref &&
      other.isBlocked === this.isBlocked &&
      other.title === this.title
    );
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

export class ImageWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly alt: string,
    public readonly safeSrc: string | null,
    public readonly isBlocked: boolean = false,
    public readonly title?: string,
    public readonly displaySrc?: string | null
  ) {
    super();
  }

  public toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-visual-image cm-visual-image-widget';
    span.dataset.from = String(this.from);
    span.dataset.to = String(this.to);
    span.setAttribute('role', 'img');
    span.setAttribute('tabindex', '-1');

    const effectiveSrc = this.displaySrc !== undefined ? this.displaySrc : this.safeSrc;

    if (this.isBlocked || !effectiveSrc) {
      span.classList.add('cm-visual-image-blocked');
      span.setAttribute('aria-label', this.alt || (this.isBlocked ? 'Blocked unsafe image' : 'Unresolved image'));
      const placeholder = document.createElement('span');
      placeholder.className = 'cm-visual-image-placeholder';
      placeholder.textContent = this.isBlocked
        ? `[Blocked Image: ${this.alt || 'unsafe'}]`
        : `[Image: ${this.alt || 'unresolved'}]`;
      span.appendChild(placeholder);
    } else {
      const img = document.createElement('img');
      img.src = effectiveSrc;
      img.alt = this.alt;
      if (this.title) {
        img.title = this.title;
      }
      span.appendChild(img);
    }

    span.addEventListener('click', (e) => {
      e.preventDefault();
    });

    return span;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof ImageWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.alt === this.alt &&
      other.safeSrc === this.safeSrc &&
      other.isBlocked === this.isBlocked &&
      other.title === this.title &&
      other.displaySrc === this.displaySrc
    );
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 激活公式时应该把光标落在哪个偏移：紧跟在起始定界符之后，并夹在 `to - 1` 之内
 * （空公式 `$$` 时 `from + 2` 会越界）。
 */
export function mathActivationAnchor(from: number, to: number, raw: string): number {
  const delimiterLength = raw.match(/^\$+/)?.[0].length ?? 1;
  return Math.max(from, Math.min(to - 1, from + delimiterLength));
}

/**
 * 把光标送进「被整体替换」的公式范围内部。
 *
 * 为什么需要它：整节点替换的 widget 会把点击吞掉，CodeMirror 只能把光标贴到 range
 * 的**边界**，而揭示判据（`isNodeRevealed()` / markra 的 `selectionRevealsRange`）要求
 * 光标**严格落在范围内部**——于是永远揭示不了，公式永远停在渲染态。
 * 这里显式 dispatch 一个内部位置，下一帧装饰重建时替换消失、源码变回真实文本。
 */
export function activateMathSource(
  view: EditorView,
  from: number,
  to: number,
  raw: string
): void {
  view.focus();
  view.dispatch({
    selection: { anchor: mathActivationAnchor(from, to, raw) }
  });
}

export class InlineMathWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly formula: string
  ) {
    super();
  }

  private control?: EditorExtensionControl;

  public toDOM(view: EditorView): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-visual-inline-math cm-visual-inline-math-widget';
    span.dataset.from = String(this.from);
    span.dataset.to = String(this.to);
    // 渲染体本身就是一个可激活的编辑入口：点击/回车把光标送进 range 内部，
    // 下一次投影重建时这个 widget 消失、`$...$` 变回可编辑的真实文本。
    span.setAttribute('role', 'button');
    span.setAttribute('tabindex', '0');
    span.setAttribute(
      'aria-label',
      translate(view.state.facet(editorLocaleFacet), 'editor.editInlineMath')
    );

    const host = view.state.facet(extensionHostFacet);

    this.control = mountExtension(
      host,
      { type: 'inline-math', from: this.from, to: this.to, text: this.formula },
      span,
      this.formula,
      () => {
        span.innerHTML = '';
        span.textContent = this.formula ? `$${this.formula}$` : '$$';
      },
      undefined,
      view.state.facet(editorLocaleFacet)
    );
    (span as any).__nexusExtensionControl = this.control;

    const activate = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      activateMathSource(view, this.from, this.to, this.raw);
    };
    // 用 mousedown 而不是 click：CM 的落光标逻辑也走 mousedown，
    // 晚一步处理就会先把光标贴到 widget 边界。
    span.addEventListener('mousedown', activate);
    span.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') activate(event);
    });

    return span;
  }

  public updateDOM(dom: HTMLElement, _view: EditorView): boolean {
    const control = (dom as any).__nexusExtensionControl as EditorExtensionControl | undefined;
    if (control) {
      control.update(this.formula);
      this.control = control;
      return true;
    }
    return false;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof InlineMathWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.formula === this.formula
    );
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

export class InlineCodeWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly value: string
  ) {
    super();
  }

  public toDOM(): HTMLElement {
    const code = document.createElement('code');
    code.className = 'cm-visual-inline-code cm-visual-inline-code-widget';
    code.dataset.from = String(this.from);
    code.dataset.to = String(this.to);
    code.setAttribute('role', 'textbox');
    code.setAttribute('tabindex', '-1');
    code.textContent = this.value;

    code.addEventListener('click', (e) => {
      e.preventDefault();
    });

    return code;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof InlineCodeWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.value === this.value
    );
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

export class WikiLinkWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly target: string,
    public readonly alias?: string
  ) {
    super();
  }

  public toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-visual-wikilink cm-visual-wikilink-widget';
    span.dataset.from = String(this.from);
    span.dataset.to = String(this.to);
    span.setAttribute('role', 'link');
    span.setAttribute('tabindex', '-1');
    if (this.alias) {
      span.textContent = this.alias;
      span.title = this.target;
      span.setAttribute('aria-label', `${this.alias} (${this.target})`);
    } else {
      span.textContent = this.target;
      span.title = this.target;
      span.setAttribute('aria-label', this.target);
    }

    span.addEventListener('click', (e) => {
      e.preventDefault();
    });

    return span;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof WikiLinkWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.target === this.target &&
      other.alias === this.alias
    );
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

interface ActivePopoverState {
  view: EditorView;
  session: MarkdownDocumentSession;
  context: InlineEditContext;
  initialRevision: number;
  popoverEl: HTMLElement;
  targetEl: HTMLElement;
  cleanupListeners: () => void;
  committed: boolean;
}

export function createInlineEditExtension(
  session: MarkdownDocumentSession,
  options: InlineEditExtensionOptions = {}
): Extension {
  let activePopover: ActivePopoverState | null = null;
  let globalResolverToken = 0;

  function closeActivePopover(): void {
    if (!activePopover) return;
    const { cleanupListeners, popoverEl, targetEl, view } = activePopover;
    cleanupListeners();
    if (popoverEl.parentNode) {
      popoverEl.parentNode.removeChild(popoverEl);
    }
    activePopover = null;
    // Restore focus
    if (targetEl && targetEl.isConnected) {
      targetEl.focus?.();
    } else if (view && view.contentDOM) {
      view.contentDOM.focus();
    }
  }

  const plugin = ViewPlugin.fromClass(
    class {
      public constructor(private readonly view: EditorView) {
        this.handleClick = this.handleClick.bind(this);
        this.view.dom.addEventListener('click', this.handleClick);
      }

      private handleClick(event: MouseEvent): void {
        if (this.view.state.readOnly) {
          return;
        }

        const target = event.target as HTMLElement | null;
        if (!target) return;

        // 行内代码、普通链接与行内公式都已改为就地可编辑：正文是真实文档文本，
        // 只由 cm-visual-inline-code / cm-visual-link / cm-visual-inline-math-source
        // mark 装饰承载，没有 data-from/to。它们必须留在选择器之外，否则会被这里的
        // preventDefault 吞掉点击、导致光标无法落入。表单元格内的行内代码同理。
        // 只有 raw 结构畸形时降级出的 InlineCodeWidget / LinkWidget 仍走 popover，
        // 故按 widget 专属类名匹配。
        const widgetEl = target.closest(
          '.cm-visual-image, .cm-visual-wikilink, .cm-visual-inline-code-widget, .cm-visual-link-widget'
        ) as HTMLElement | null;
        if (!widgetEl) return;

        // 守卫先于 preventDefault：命中没有 source range 的元素时直接放行，
        // 把事件交回浏览器，让光标正常落到真实文本上。
        const from = Number(widgetEl.dataset.from);
        const to = Number(widgetEl.dataset.to);
        if (isNaN(from) || isNaN(to)) return;

        event.preventDefault();
        event.stopPropagation();

        const currentSource = session.getSnapshot().source;
        const raw = currentSource.slice(from, to);
        const { root } = parseMarkdown(currentSource);

        let nodeType: InlineEditNodeType | null = null;
        if (widgetEl.classList.contains('cm-visual-link')) nodeType = 'link';
        else if (widgetEl.classList.contains('cm-visual-image')) nodeType = 'image';
        else if (widgetEl.classList.contains('cm-visual-inline-code')) nodeType = 'inline-code';
        else if (widgetEl.classList.contains('cm-visual-wikilink')) nodeType = 'wikilink';

        if (!nodeType) return;

        const targetNode = findInlineNodeAtRange(root, nodeType, { from, to });
        if (!targetNode) return;

        const context: InlineEditContext = {
          nodeType,
          range: { from, to },
          raw,
          source: currentSource
        };

        this.openPopover(widgetEl, context, targetNode);
      }

      private openPopover(
        widgetEl: HTMLElement,
        context: InlineEditContext,
        node: MarkdownInlineNode
      ): void {
        closeActivePopover();

        // 浮层文案全部走 i18n。语言由 `editorLocaleFacet` 注入（编辑器包不读 localStorage）；
        // 每次打开浮层时现取，所以切语言后新开的浮层立刻是新语言。
        const t = (key: string) => translate(this.view.state.facet(editorLocaleFacet), key);

        const initialRevision = session.getSnapshot().revision;
        const popover = document.createElement('div');
        popover.className = `cm-inline-edit-popover cm-${context.nodeType}-editor`;
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-modal', 'false');

        const errorEl = document.createElement('span');
        errorEl.className = 'cm-inline-edit-error';
        errorEl.setAttribute('role', 'alert');

        const actionsEl = document.createElement('div');
        actionsEl.className = 'cm-inline-edit-actions';

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'cm-inline-edit-save';
        saveBtn.textContent = t('popover.save');

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'cm-inline-edit-cancel';
        cancelBtn.textContent = t('popover.cancel');

        actionsEl.appendChild(saveBtn);
        actionsEl.appendChild(cancelBtn);

        let getValues: () => unknown = () => ({});
        let isUnchanged: () => boolean = () => false;
        let firstInput: HTMLElement | null = null;

        const refKind = getReferenceKind(context.raw);
        const isReference = refKind === 'full' || refKind === 'collapsed' || refKind === 'shortcut';
        const isIdentifierBound = refKind === 'collapsed' || refKind === 'shortcut';

        if (context.nodeType === 'link' && node.type === 'link') {
          const labelField = document.createElement('label');
          labelField.className = 'cm-inline-edit-field';
          const labelTitle = document.createElement('span');
          labelTitle.className = 'cm-inline-edit-label';
          labelTitle.textContent = t('popover.linkText');
          const labelInput = document.createElement('input');
          labelInput.type = 'text';
          labelInput.className = 'cm-link-label-input';
          labelInput.setAttribute('aria-label', t('popover.linkTextAria'));
          const plainLabel = getInlineNodePlainText(node);
          labelInput.value = plainLabel;
          labelField.appendChild(labelTitle);
          labelField.appendChild(labelInput);

          const destField = document.createElement('label');
          destField.className = 'cm-inline-edit-field';
          const destTitle = document.createElement('span');
          destTitle.className = 'cm-inline-edit-label';
          destTitle.textContent = t('popover.linkDestination');
          const destInput = document.createElement('input');
          destInput.type = 'text';
          destInput.className = 'cm-link-dest-input';
          destInput.setAttribute('aria-label', t('popover.linkUrlAria'));
          destInput.value = node.href;
          if (isReference) {
            destInput.disabled = true;
            destInput.readOnly = true;
            destInput.title = t('popover.linkRefDestinationHint');
            destInput.setAttribute('aria-label', t('popover.linkRefDestinationAria'));
          }
          destField.appendChild(destTitle);
          destField.appendChild(destInput);

          const titleField = document.createElement('label');
          titleField.className = 'cm-inline-edit-field';
          const titleLabel = document.createElement('span');
          titleLabel.className = 'cm-inline-edit-label';
          titleLabel.textContent = t('popover.titleOptional');
          const titleInput = document.createElement('input');
          titleInput.type = 'text';
          titleInput.className = 'cm-link-title-input';
          titleInput.setAttribute('aria-label', t('popover.linkTitleAria'));
          titleInput.value = node.title || '';
          if (isReference) {
            titleInput.disabled = true;
            titleInput.readOnly = true;
            titleInput.title = t('popover.linkRefTitleHint');
            titleInput.setAttribute('aria-label', t('popover.linkRefTitleAria'));
          }
          if (isIdentifierBound) {
            labelInput.disabled = true;
            labelInput.readOnly = true;
            labelInput.title = t('popover.linkRefLabelHint');
            labelInput.setAttribute('aria-label', t('popover.linkRefLabelAria'));
            saveBtn.disabled = true;
          }
          titleField.appendChild(titleLabel);
          titleField.appendChild(titleInput);

          popover.appendChild(labelField);
          popover.appendChild(destField);
          popover.appendChild(titleField);

          firstInput = isReference ? labelInput : destInput;

          const initialVals = {
            label: labelInput.value,
            destination: destInput.value,
            title: titleInput.value
          };

          getValues = (): LinkEditValue => ({
            label: labelInput.value,
            destination: destInput.value,
            title: titleInput.value.trim() ? titleInput.value : undefined
          });

          isUnchanged = () => {
            const vals = getValues() as LinkEditValue;
            return (
              vals.label === initialVals.label &&
              vals.destination === initialVals.destination &&
              (vals.title || '') === initialVals.title
            );
          };
        } else if (context.nodeType === 'image' && node.type === 'image') {
          const altField = document.createElement('label');
          altField.className = 'cm-inline-edit-field';
          const altTitle = document.createElement('span');
          altTitle.className = 'cm-inline-edit-label';
          altTitle.textContent = t('popover.imageAlt');
          const altInput = document.createElement('input');
          altInput.type = 'text';
          altInput.className = 'cm-image-alt-input';
          altInput.setAttribute('aria-label', t('popover.imageAltAria'));
          altInput.value = node.alt;
          altField.appendChild(altTitle);
          altField.appendChild(altInput);

          const srcField = document.createElement('label');
          srcField.className = 'cm-inline-edit-field';
          const srcTitle = document.createElement('span');
          srcTitle.className = 'cm-inline-edit-label';
          srcTitle.textContent = t('popover.imageSource');
          const srcInput = document.createElement('input');
          srcInput.type = 'text';
          srcInput.className = 'cm-image-src-input';
          srcInput.setAttribute('aria-label', t('popover.imageSourceAria'));
          srcInput.value = node.src;
          if (isReference) {
            srcInput.disabled = true;
            srcInput.readOnly = true;
            srcInput.title = t('popover.imageRefSourceHint');
            srcInput.setAttribute('aria-label', t('popover.imageRefSourceAria'));
          }
          srcField.appendChild(srcTitle);
          srcField.appendChild(srcInput);

          let srcInputVersion = 0;
          srcInput.addEventListener('input', () => {
            srcInputVersion++;
          });

          const titleField = document.createElement('label');
          titleField.className = 'cm-inline-edit-field';
          const titleLabel = document.createElement('span');
          titleLabel.className = 'cm-inline-edit-label';
          titleLabel.textContent = t('popover.titleOptional');
          const titleInput = document.createElement('input');
          titleInput.type = 'text';
          titleInput.className = 'cm-image-title-input';
          titleInput.setAttribute('aria-label', t('popover.imageTitleAria'));
          titleInput.value = node.title || '';
          if (isReference) {
            titleInput.disabled = true;
            titleInput.readOnly = true;
            titleInput.title = t('popover.imageRefTitleHint');
            titleInput.setAttribute('aria-label', t('popover.imageRefTitleAria'));
          }
          if (isIdentifierBound) {
            altInput.disabled = true;
            altInput.readOnly = true;
            altInput.title = t('popover.imageRefAltHint');
            altInput.setAttribute('aria-label', t('popover.imageRefAltAria'));
            saveBtn.disabled = true;
          }
          titleField.appendChild(titleLabel);
          titleField.appendChild(titleInput);

          popover.appendChild(altField);
          popover.appendChild(srcField);
          popover.appendChild(titleField);

          const facetOptions = this.view.state.facet(inlineEditOptionsFacet) as InlineEditExtensionOptions | undefined;
          const resolver = !isReference ? (options.imageSourceResolver ?? facetOptions?.imageSourceResolver) : undefined;
          if (resolver) {
            const uploadBtn = document.createElement('button');
            uploadBtn.type = 'button';
            uploadBtn.className = 'cm-image-upload-btn';
            uploadBtn.textContent = t('popover.imageUpload');
            uploadBtn.addEventListener('click', async (e) => {
              e.preventDefault();
              const requestToken = ++globalResolverToken;
              const capturedRevision = initialRevision;
              const capturedInputVersion = srcInputVersion;
              try {
                const resolved = await resolver(srcInput.value, {
                  range: context.range,
                  raw: context.raw,
                  alt: altInput.value,
                  destination: srcInput.value,
                  title: titleInput.value || undefined
                });
                if (
                  !activePopover ||
                  activePopover.popoverEl !== popover ||
                  requestToken !== globalResolverToken ||
                  session.getSnapshot().revision !== capturedRevision ||
                  this.view.state.readOnly ||
                  srcInputVersion !== capturedInputVersion
                ) {
                  return;
                }
                if (typeof resolved === 'string' && resolved) {
                  srcInput.value = resolved;
                  srcInputVersion++;
                }
              } catch (err) {
                if (
                  !activePopover ||
                  activePopover.popoverEl !== popover ||
                  requestToken !== globalResolverToken ||
                  session.getSnapshot().revision !== capturedRevision ||
                  this.view.state.readOnly ||
                  srcInputVersion !== capturedInputVersion
                ) {
                  return;
                }
                errorEl.textContent = (err as Error).message || 'Resolver failed';
              }
            });
            popover.appendChild(uploadBtn);
          }

          firstInput = isReference ? altInput : srcInput;

          const initialVals = {
            alt: altInput.value,
            destination: srcInput.value,
            title: titleInput.value
          };

          getValues = (): ImageEditValue => ({
            alt: altInput.value,
            destination: srcInput.value,
            title: titleInput.value.trim() ? titleInput.value : undefined
          });

          isUnchanged = () => {
            const vals = getValues() as ImageEditValue;
            return (
              vals.alt === initialVals.alt &&
              vals.destination === initialVals.destination &&
              (vals.title || '') === initialVals.title
            );
          };
        } else if (context.nodeType === 'inline-code' && node.type === 'inline-code') {
          const codeField = document.createElement('label');
          codeField.className = 'cm-inline-edit-field';
          const codeTitle = document.createElement('span');
          codeTitle.className = 'cm-inline-edit-label';
          codeTitle.textContent = t('popover.codeValue');
          const codeInput = document.createElement('input');
          codeInput.type = 'text';
          codeInput.className = 'cm-code-input';
          codeInput.setAttribute('aria-label', t('popover.codeValueAria'));
          codeInput.value = node.value;
          codeField.appendChild(codeTitle);
          codeField.appendChild(codeInput);

          popover.appendChild(codeField);
          firstInput = codeInput;

          const initialCode = codeInput.value;
          getValues = (): InlineCodeEditValue => ({
            value: codeInput.value
          });

          isUnchanged = () => {
            const vals = getValues() as InlineCodeEditValue;
            return vals.value === initialCode;
          };
        } else if (context.nodeType === 'wikilink' && node.type === 'wikilink') {
          const targetField = document.createElement('label');
          targetField.className = 'cm-inline-edit-field';
          const targetTitle = document.createElement('span');
          targetTitle.className = 'cm-inline-edit-label';
          targetTitle.textContent = t('popover.wikiTarget');
          const targetInput = document.createElement('input');
          targetInput.type = 'text';
          targetInput.className = 'cm-wikilink-target-input';
          targetInput.setAttribute('aria-label', t('popover.wikiTargetAria'));
          targetInput.value = node.target;
          targetField.appendChild(targetTitle);
          targetField.appendChild(targetInput);

          const aliasField = document.createElement('label');
          aliasField.className = 'cm-inline-edit-field';
          const aliasTitle = document.createElement('span');
          aliasTitle.className = 'cm-inline-edit-label';
          aliasTitle.textContent = t('popover.wikiAlias');
          const aliasInput = document.createElement('input');
          aliasInput.type = 'text';
          aliasInput.className = 'cm-wikilink-alias-input';
          aliasInput.setAttribute('aria-label', t('popover.wikiAliasAria'));
          aliasInput.value = node.alias || '';
          aliasField.appendChild(aliasTitle);
          aliasField.appendChild(aliasInput);

          popover.appendChild(targetField);
          popover.appendChild(aliasField);
          firstInput = targetInput;

          const initialTarget = targetInput.value;
          const initialAlias = aliasInput.value;
          getValues = (): WikiLinkEditValue => ({
            target: targetInput.value,
            alias: aliasInput.value.trim() ? aliasInput.value : undefined
          });

          isUnchanged = () => {
            const vals = getValues() as WikiLinkEditValue;
            return vals.target === initialTarget && (vals.alias || '') === initialAlias;
          };
        }

        popover.appendChild(errorEl);
        popover.appendChild(actionsEl);

        const validate = (): { isValid: boolean; error?: string; isUnchanged: boolean } => {
          if (isUnchanged()) {
            return { isValid: true, isUnchanged: true };
          }
          const vals = getValues();
          if (context.nodeType === 'link') {
            const l = vals as LinkEditValue;
            if (/[\r\n]/.test(l.label) || /[\r\n]/.test(l.destination) || (l.title && /[\r\n]/.test(l.title))) {
              return { isValid: false, error: 'Newlines (CR/LF) are not permitted in links.', isUnchanged: false };
            }
            const sRes = sanitizeUrl(l.destination);
            if (sRes.isBlocked) {
              return { isValid: false, error: sRes.reason ?? 'Blocked potentially unsafe link protocol', isUnchanged: false };
            }
          } else if (context.nodeType === 'image') {
            const img = vals as ImageEditValue;
            if (/[\r\n]/.test(img.alt) || /[\r\n]/.test(img.destination) || (img.title && /[\r\n]/.test(img.title))) {
              return { isValid: false, error: 'Newlines (CR/LF) are not permitted in images.', isUnchanged: false };
            }
            const sRes = sanitizeUrl(img.destination);
            if (sRes.isBlocked) {
              return { isValid: false, error: sRes.reason ?? 'Blocked potentially unsafe image protocol', isUnchanged: false };
            }
          } else if (context.nodeType === 'inline-code') {
            const c = vals as InlineCodeEditValue;
            if (/[\r\n]/.test(c.value)) {
              return { isValid: false, error: 'Newlines (CR/LF) are not permitted in inline code.', isUnchanged: false };
            }
          } else if (context.nodeType === 'wikilink') {
            const w = vals as WikiLinkEditValue;
            if (!w.target.trim()) {
              return { isValid: false, error: 'WikiLink target cannot be empty.', isUnchanged: false };
            }
            if (/[\r\n]/.test(w.target) || (w.alias && /[\r\n]/.test(w.alias))) {
              return { isValid: false, error: 'Newlines (CR/LF) are not permitted in WikiLinks.', isUnchanged: false };
            }
            if (/[[\]]/.test(w.target) || (w.alias && /[[\]]/.test(w.alias))) {
              return { isValid: false, error: 'Brackets [ or ] are not permitted in WikiLinks.', isUnchanged: false };
            }
          }
          return { isValid: true, isUnchanged: false };
        };

        const commit = () => {
          if (!activePopover || activePopover.committed) return;
          if (this.view.state.readOnly) {
            closeActivePopover();
            return;
          }

          if (session.getSnapshot().revision !== initialRevision) {
            closeActivePopover();
            return;
          }

          const validation = validate();
          if (!validation.isValid) {
            errorEl.textContent = validation.error ?? 'Validation failed';
            return;
          }
          if (validation.isUnchanged) {
            closeActivePopover();
            return;
          }

          const currentSource = session.getSnapshot().source;
          const vals = getValues();

          let tx: MarkdownEditTransaction | null = null;
          if (context.nodeType === 'link') {
            tx = createLinkEditTransaction(currentSource, context, vals as LinkEditValue);
          } else if (context.nodeType === 'image') {
            tx = createImageEditTransaction(currentSource, context, vals as ImageEditValue);
          } else if (context.nodeType === 'inline-code') {
            tx = createInlineCodeEditTransaction(currentSource, context, vals as InlineCodeEditValue);
          } else if (context.nodeType === 'wikilink') {
            tx = createWikiLinkEditTransaction(currentSource, context, vals as WikiLinkEditValue);
          }

          if (tx) {
            activePopover.committed = true;
            session.dispatch(tx);
            closeActivePopover();
          } else {
            errorEl.textContent = t('popover.invalidSyntax');
          }
        };

        const handlePopoverKeydown = (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeActivePopover();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            commit();
          }
        };

        const handleOutsidePointer = (e: MouseEvent | TouchEvent) => {
          const target = e.target as HTMLElement | null;
          if (!target) return;
          if (
            popover.contains(target) ||
            widgetEl.contains(target) ||
            target.closest('.cm-inline-edit-popover')
          ) {
            return;
          }
          closeActivePopover();
        };

        popover.addEventListener('keydown', handlePopoverKeydown);
        popover.addEventListener('pointerdown', (e) => e.stopPropagation());
        popover.addEventListener('click', (e) => e.stopPropagation());

        saveBtn.addEventListener('click', (e) => {
          e.preventDefault();
          commit();
        });

        cancelBtn.addEventListener('click', (e) => {
          e.preventDefault();
          closeActivePopover();
        });

        const doc = this.view.dom.ownerDocument ?? document;
        doc.addEventListener('pointerdown', handleOutsidePointer, true);

        const cleanupListeners = () => {
          doc.removeEventListener('pointerdown', handleOutsidePointer, true);
        };

        activePopover = {
          view: this.view,
          session,
          context,
          initialRevision,
          popoverEl: popover,
          targetEl: widgetEl,
          cleanupListeners,
          committed: false
        };

        // Compute floating position within view.dom
        const widgetRect = widgetEl.getBoundingClientRect?.() ?? { left: 0, bottom: 0, top: 0 };
        const viewRect = this.view.dom.getBoundingClientRect?.() ?? { left: 0, top: 0 };
        const leftOffset = Math.max(0, widgetRect.left - viewRect.left);
        const topOffset = Math.max(0, widgetRect.bottom - viewRect.top + 4);
        popover.style.left = `${leftOffset}px`;
        popover.style.top = `${topOffset}px`;

        this.view.dom.appendChild(popover);
        firstInput?.focus();
      }

      public update(update: ViewUpdate): void {
        if (activePopover) {
          if (update.state.readOnly || update.docChanged) {
            closeActivePopover();
          }
        }
      }

      public destroy(): void {
        if (activePopover && activePopover.view === this.view) {
          closeActivePopover();
        }
        this.view.dom.removeEventListener('click', this.handleClick);
      }
    }
  );

  return [inlineEditOptionsFacet.of(options), plugin];
}
