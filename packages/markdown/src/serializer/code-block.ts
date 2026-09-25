/**
 * 代码块序列化：按原文围栏原样保留，必要时补齐围栏长度。
 */
import type { MarkdownBlockNode } from '../types.js';

export function serializeCodeBlock(
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

