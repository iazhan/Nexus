import type { MarkdownInlineNode } from '@nexus/markdown';

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

