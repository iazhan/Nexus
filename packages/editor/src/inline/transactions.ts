import { parseMarkdown, sanitizeUrl, type MarkdownInlineNode } from '@nexus/markdown';
import type {
  MarkdownChange,
  MarkdownEditTransaction,
  MarkdownSelection
} from '../types.js';
import type {
  ImageEditValue,
  InlineCodeEditValue,
  InlineEditContext,
  LinkEditValue,
  WikiLinkEditValue
} from './types.js';
import {
  escapeMarkdownInlineText,
  extractLinkRawLabel,
  getInlineNodePlainText
} from './text-utils.js';
import { findInlineNodeAtRange, verifyCandidateNode } from './node-lookup.js';
import {
  getReferenceKind,
  parseLocalParenDescriptor,
  requiresAngleBrackets
} from './link-syntax.js';

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

