/**
 * 行内层映射：`parseSpecialInlineSyntax` 处理 marked 不认的项目特有语法（wikilink、
 * 行内公式等），`mapInlineTokens` 把 marked 的 inline token 转成项目 AST。
 */
import type { Token, Tokens } from 'marked';
import { sanitizeUrl } from '../security.js';
import type { MarkdownDiagnostic, MarkdownInlineNode, SourceRange } from '../types.js';
import { matchTokenEndInSource } from './source-offsets.js';

/**
 * Parses inline text to identify math ($...$, $$...$$) and wikilinks ([[...]])
 * while preserving all other text verbatim with exact source ranges.
 */
export function parseSpecialInlineSyntax(
  rawText: string,
  baseOffset = 0,
  source?: string
): MarkdownInlineNode[] {
  const nodes: MarkdownInlineNode[] = [];
  if (!rawText) return nodes;

  const fullSource = source ?? rawText;
  const len = rawText.length;
  let i = 0;
  let textBufferStart = 0;

  const flushText = (endIdx: number) => {
    if (endIdx > textBufferStart) {
      const from = baseOffset + textBufferStart;
      const to = baseOffset + endIdx;
      const raw = fullSource.slice(from, to);
      nodes.push({
        type: 'text',
        value: rawText.slice(textBufferStart, endIdx),
        range: { from, to },
        raw
      });
      textBufferStart = endIdx;
    }
  };

  while (i < len) {
    // 1. Escaped characters: e.g. \$ or \[\[
    if (rawText[i] === '\\' && i + 1 < len) {
      i += 2;
      continue;
    }

    // 2. Block math within text: $$...$$
    if (rawText.startsWith('$$', i)) {
      const closeIdx = rawText.indexOf('$$', i + 2);
      if (closeIdx !== -1) {
        flushText(i);
        const from = baseOffset + i;
        const to = baseOffset + closeIdx + 2;
        const formula = rawText.slice(i + 2, closeIdx);
        const raw = fullSource.slice(from, to);
        nodes.push({
          type: 'inline-math',
          formula,
          range: { from, to },
          raw
        });
        i = closeIdx + 2;
        textBufferStart = i;
        continue;
      }
    }

    // 3. Inline math: $...$
    if (rawText[i] === '$') {
      const nextChar = rawText[i + 1];
      const isValidStart =
        nextChar !== undefined &&
        nextChar !== ' ' &&
        nextChar !== '\t' &&
        nextChar !== '\r' &&
        nextChar !== '\n' &&
        nextChar !== '$';

      if (isValidStart) {
        let scan = i + 1;
        let foundClose = -1;

        while (scan < len) {
          if (
            (rawText[scan] === '\n' && scan + 1 < len && rawText[scan + 1] === '\n') ||
            (rawText[scan] === '\r' && scan + 3 < len && rawText.slice(scan, scan + 4) === '\r\n\r\n')
          ) {
            break; // Do not span multiple paragraphs
          }
          if (rawText[scan] === '\\') {
            scan += 2;
            continue;
          }
          if (rawText[scan] === '$') {
            const prevChar = rawText[scan - 1];
            const afterChar = rawText[scan + 1];
            const isPrevWhitespace =
              prevChar === ' ' ||
              prevChar === '\t' ||
              prevChar === '\r' ||
              prevChar === '\n';
            const isNextDigit =
              afterChar !== undefined && afterChar >= '0' && afterChar <= '9';

            if (!isPrevWhitespace && !isNextDigit) {
              foundClose = scan;
              break;
            }
          }
          scan++;
        }

        if (foundClose !== -1) {
          flushText(i);
          const from = baseOffset + i;
          const to = baseOffset + foundClose + 1;
          const formula = rawText.slice(i + 1, foundClose);
          const raw = fullSource.slice(from, to);
          nodes.push({
            type: 'inline-math',
            formula,
            range: { from, to },
            raw
          });
          i = foundClose + 1;
          textBufferStart = i;
          continue;
        }
      }
    }

    // 4. Wikilink: [[target]] or [[target|alias]]
    if (rawText.startsWith('[[', i)) {
      const closeIdx = rawText.indexOf(']]', i + 2);
      if (closeIdx !== -1) {
        const inner = rawText.slice(i + 2, closeIdx);
        // Wikilink cannot span newlines or contain brackets
        if (!inner.includes('\n') && !inner.includes('\r') && !inner.includes('[') && !inner.includes(']')) {
          flushText(i);
          const pipeIdx = inner.indexOf('|');
          let target = inner;
          let alias: string | undefined = undefined;
          if (pipeIdx !== -1) {
            target = inner.slice(0, pipeIdx).trim();
            alias = inner.slice(pipeIdx + 1).trim();
          } else {
            target = target.trim();
          }

          const from = baseOffset + i;
          const to = baseOffset + closeIdx + 2;
          const raw = fullSource.slice(from, to);
          nodes.push({
            type: 'wikilink',
            target,
            alias,
            range: { from, to },
            raw
          });
          i = closeIdx + 2;
          textBufferStart = i;
          continue;
        }
      }
    }

    i++;
  }

  flushText(len);
  return nodes;
}

/**
 * Maps marked inline tokens into project AST inline nodes with exact source ranges.
 */
export function mapInlineTokens(
  tokens: Token[],
  baseOffset: number,
  source: string,
  diagnostics: MarkdownDiagnostic[]
): MarkdownInlineNode[] {
  const result: MarkdownInlineNode[] = [];
  let cur = baseOffset;

  for (const token of tokens) {
    const end = matchTokenEndInSource(source, cur, token.raw);
    const range: SourceRange = { from: cur, to: end };
    const raw = source.slice(cur, end);

    switch (token.type) {
      case 'text': {
        const textToken = token as Tokens.Text;
        if (textToken.tokens && textToken.tokens.length > 0) {
          result.push(...mapInlineTokens(textToken.tokens, cur, source, diagnostics));
        } else {
          result.push(...parseSpecialInlineSyntax(raw, cur, source));
        }
        break;
      }
      case 'strong': {
        const strongToken = token as Tokens.Strong;
        // Delimiters (usually ** or __ of length 2)
        const delimMatch = raw.match(/^(\*\*|__)/);
        const delimLen = delimMatch && delimMatch[1] ? delimMatch[1].length : 2;
        const innerFrom = cur + delimLen;
        const innerEnd = Math.max(innerFrom, end - delimLen);

        let children: MarkdownInlineNode[];
        if (strongToken.tokens && strongToken.tokens.length > 0) {
          children = mapInlineTokens(strongToken.tokens, innerFrom, source, diagnostics);
        } else {
          children = parseSpecialInlineSyntax(source.slice(innerFrom, innerEnd), innerFrom, source);
        }

        result.push({
          type: 'bold',
          children,
          range,
          raw
        });
        break;
      }
      case 'em': {
        const emToken = token as Tokens.Em;
        // Delimiters (usually * or _ of length 1)
        const delimMatch = raw.match(/^(\*|_)/);
        const delimLen = delimMatch && delimMatch[1] ? delimMatch[1].length : 1;
        const innerFrom = cur + delimLen;
        const innerEnd = Math.max(innerFrom, end - delimLen);

        let children: MarkdownInlineNode[];
        if (emToken.tokens && emToken.tokens.length > 0) {
          children = mapInlineTokens(emToken.tokens, innerFrom, source, diagnostics);
        } else {
          children = parseSpecialInlineSyntax(source.slice(innerFrom, innerEnd), innerFrom, source);
        }

        result.push({
          type: 'italic',
          children,
          range,
          raw
        });
        break;
      }
      case 'del': {
        const delToken = token as Tokens.Del;
        const delimMatch = raw.match(/^(~~|~)/);
        const delimLen = delimMatch && delimMatch[1] ? delimMatch[1].length : 2;
        const innerFrom = cur + delimLen;
        const innerEnd = Math.max(innerFrom, end - delimLen);

        let children: MarkdownInlineNode[];
        if (delToken.tokens && delToken.tokens.length > 0) {
          children = mapInlineTokens(delToken.tokens, innerFrom, source, diagnostics);
        } else {
          children = parseSpecialInlineSyntax(source.slice(innerFrom, innerEnd), innerFrom, source);
        }

        result.push({
          type: 'strike',
          children,
          range,
          raw
        });
        break;
      }
      case 'codespan': {
        const codeToken = token as Tokens.Codespan;
        result.push({
          type: 'inline-code',
          value: codeToken.text,
          range,
          raw
        });
        break;
      }
      case 'link': {
        const linkToken = token as Tokens.Link;
        const sanitizeResult = sanitizeUrl(linkToken.href);
        if (sanitizeResult.isBlocked) {
          diagnostics.push({
            severity: 'warning',
            message: sanitizeResult.reason ?? 'Blocked potentially unsafe link protocol'
          });
        }

        // Link label starts at cur + 1 (after '[')
        const innerFrom = cur + 1;
        const closeBracketIdx = raw.indexOf(']');
        const innerEnd = closeBracketIdx !== -1 ? cur + closeBracketIdx : end;

        let children: MarkdownInlineNode[];
        if (linkToken.tokens && linkToken.tokens.length > 0) {
          children = mapInlineTokens(linkToken.tokens, innerFrom, source, diagnostics);
        } else {
          children = parseSpecialInlineSyntax(source.slice(innerFrom, innerEnd), innerFrom, source);
        }

        result.push({
          type: 'link',
          href: linkToken.href,
          title: linkToken.title || undefined,
          safeHref: sanitizeResult.safeUrl,
          isBlocked: sanitizeResult.isBlocked,
          children,
          range,
          raw
        });
        break;
      }
      case 'image': {
        const imgToken = token as Tokens.Image;
        const sanitizeResult = sanitizeUrl(imgToken.href);
        if (sanitizeResult.isBlocked) {
          diagnostics.push({
            severity: 'warning',
            message: sanitizeResult.reason ?? 'Blocked potentially unsafe image source'
          });
        }
        result.push({
          type: 'image',
          src: imgToken.href,
          alt: imgToken.text,
          title: imgToken.title || undefined,
          safeSrc: sanitizeResult.safeUrl,
          isBlocked: sanitizeResult.isBlocked,
          range,
          raw
        });
        break;
      }
      case 'html': {
        const htmlToken = token as Tokens.HTML;
        result.push({
          type: 'raw',
          value: htmlToken.text,
          range,
          raw,
          opaque: true
        });
        break;
      }
      case 'escape': {
        const escToken = token as Tokens.Escape;
        result.push({
          type: 'text',
          value: escToken.text,
          range,
          raw,
          escaped: true
        });
        break;
      }
      default: {
        if ('text' in token && typeof (token as { text?: unknown }).text === 'string') {
          result.push(...parseSpecialInlineSyntax(raw, cur, source));
        } else {
          result.push({
            type: 'raw',
            value: raw,
            range,
            raw,
            opaque: true
          });
        }
      }
    }

    cur = end;
  }

  return result;
}

