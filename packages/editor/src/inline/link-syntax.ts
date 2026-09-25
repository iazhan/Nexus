export interface LocalParenDescriptor {
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

export function parseLocalParenDescriptor(insideParen: string): LocalParenDescriptor {
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

