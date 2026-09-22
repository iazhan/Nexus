import { parseMarkdown, type MarkdownBlockNode, type SourceRange } from '@nexus/markdown';
import type { EditorView } from '@codemirror/view';
import type { MarkdownEditTransaction } from './types.js';
import { walkBlockNodes } from './ast-walker.js';

/**
 * 代码块上下文，包含 fence 字符、长度、缩进、换行风格和代码内容。
 */
export interface CodeBlockContext {
  range: SourceRange;
  raw: string;
  source: string;
  fenceChar: '`' | '~';
  fenceLength: number;
  language?: string;
  value: string;
  indent: string;
  openingLineRaw: string;
  openingInfoPrefix: string;
  openingInfoSuffix: string;
  linePrefix: string;
  hasClosingFence: boolean;
  closingFenceRaw?: string;
  closingFenceLength?: number;
  closingFenceTrailing?: string;
  trailingNewline: string | null;
  newline: '\r\n' | '\n';
}

/**
 * 解析 code-block AST 节点为 CodeBlockContext。
 */
export function parseCodeBlockContext(
  source: string,
  node: Extract<MarkdownBlockNode, { type: 'code-block' }>
): CodeBlockContext {
  const isCRLF = node.raw.includes('\r\n');
  const newline = isCRLF ? '\r\n' : '\n';
  const firstLine = node.raw.split(/\r?\n/)[0] ?? '';
  const match = firstLine.match(/^([ \t]*(?:>[ \t]*)*)(`{3,}|~{3,})(.*)$/);
  const indent = match ? (match[1] ?? '') : '';
  const fenceStr = match ? (match[2] ?? '```') : '```';
  const fenceChar = fenceStr[0] === '~' ? '~' : '`';
  const fenceLength = fenceStr.length;
  const openingInfo = match?.[3] ?? '';
  const openingInfoPrefix = openingInfo.match(/^[ \t]*/)?.[0] ?? '';
  const openingInfoSuffix = openingInfo.match(/[ \t]*$/)?.[0] ?? '';

  const trailingNewline = node.raw.endsWith('\r\n')
    ? '\r\n'
    : node.raw.endsWith('\n')
      ? '\n'
      : null;

  const trimmedRaw = trailingNewline
    ? node.raw.slice(0, -trailingNewline.length)
    : node.raw;

  const rawLines = trimmedRaw.split(/\r?\n/);
  const lastLine = rawLines[rawLines.length - 1] ?? '';
  const closingMatch = lastLine.match(/^([ \t]*(?:>[ \t]*)*)(`{3,}|~{3,})([ \t]*)$/);
  const linePrefix = closingMatch ? (closingMatch[1] ?? indent) : indent;
  const closingFenceStr = closingMatch ? (closingMatch[2] ?? '') : '';
  const closingFenceTrailing = closingMatch ? (closingMatch[3] ?? '') : '';
  const hasClosingFence =
    rawLines.length > 1 &&
    Boolean(closingMatch) &&
    closingFenceStr[0] === fenceChar &&
    closingFenceStr.length >= fenceLength;

  return {
    range: { from: node.range.from, to: node.range.to },
    raw: node.raw,
    source,
    fenceChar,
    fenceLength,
    language: node.language,
    value: node.value,
    indent,
    openingLineRaw: firstLine,
    openingInfoPrefix,
    openingInfoSuffix,
    linePrefix,
    hasClosingFence,
    closingFenceRaw: hasClosingFence ? lastLine : undefined,
    closingFenceLength: hasClosingFence ? closingFenceStr.length : undefined,
    closingFenceTrailing: hasClosingFence ? closingFenceTrailing : undefined,
    trailingNewline,
    newline
  };
}

/**
 * 校验候选文本重新解析后是否包含预期的代码块。
 */
function verifyCandidateCodeBlock(
  candidateSource: string,
  expectedFrom: number,
  expectedLanguage?: string,
  expectedValue?: string,
  expectedTo?: number,
  expectedRaw?: string,
  expectedClosingFenceRaw?: string
): boolean {
  const { root } = parseMarkdown(candidateSource);
  let matches = 0;
  let valid = false;
  walkBlockNodes(root.children, (child) => {
    if (child.type === 'code-block' && child.range.from === expectedFrom) {
      matches++;
      if (expectedTo !== undefined && child.range.to !== expectedTo) return false;
      if (expectedRaw !== undefined) {
        if (child.raw !== expectedRaw) return false;
        if (candidateSource.slice(expectedFrom, child.range.to) !== expectedRaw) return false;
      }
      if (expectedLanguage !== undefined) {
        const lang = child.language || '';
        if (lang !== expectedLanguage) return false;
      }
      if (expectedValue !== undefined) {
        if (child.value !== expectedValue) {
          // marked 会把带 Tab 的闭合 fence 作为 value 尾部返回。仅在 raw、范围和
          // 闭合行均精确匹配时兼容这一上游差异，避免放宽未闭合代码块校验。
          const parserValueWithClosingFence = expectedClosingFenceRaw === undefined
            ? null
            : `${expectedValue}\n${expectedClosingFenceRaw}`;
          if (child.value !== parserValueWithClosingFence) return false;
        }
      }
      valid = true;
      return true;
    }
    return false;
  });
  return matches === 1 && valid;
}

function buildOpeningLine(context: CodeBlockContext, fenceLength: number): string {
  if (fenceLength === context.fenceLength) return context.openingLineRaw;
  return `${context.indent}${context.fenceChar.repeat(fenceLength)}${context.openingLineRaw.slice(
    context.indent.length + context.fenceLength
  )}`;
}

function buildLanguageOpeningLine(context: CodeBlockContext, language: string): string {
  const fence = context.fenceChar.repeat(context.fenceLength);
  return `${context.indent}${fence}${context.openingInfoPrefix}${language}${context.openingInfoSuffix}`;
}

/**
 * 创建修改代码块代码内容的事务。
 */
export function createCodeBlockValueTransaction(
  source: string,
  context: CodeBlockContext,
  newValue: string
): MarkdownEditTransaction | null {
  if (source !== context.source) return null;
  if (source.slice(context.range.from, context.range.to) !== context.raw) return null;

  // 1. 检查新内容中的 backtick 或 tilde run，计算所需最小 fence 长度
  const fenceRegex = context.fenceChar === '~' ? /~+/g : /`+/g;
  const matches = newValue.match(fenceRegex);
  let maxRun = 0;
  if (matches) {
    for (const m of matches) {
      if (m.length > maxRun) maxRun = m.length;
    }
  }

  // opening fence 长度永不降级低于原有长度，若内容包含更长连续字符则自动扩展
  const minRequiredLength = maxRun > 0 ? maxRun + 1 : 3;
  const openingFenceLength = Math.max(context.fenceLength, minRequiredLength);
  const openLine = buildOpeningLine(context, openingFenceLength);

  let closeLine: string | null = null;
  if (context.hasClosingFence) {
    const originalClosingLen = context.closingFenceLength ?? context.fenceLength;
    if (
      originalClosingLen >= openingFenceLength &&
      originalClosingLen >= minRequiredLength &&
      context.closingFenceRaw !== undefined
    ) {
      closeLine = context.closingFenceRaw;
    } else {
      const closingFenceLen = Math.max(openingFenceLength, minRequiredLength);
      const closeFence = context.fenceChar.repeat(closingFenceLen);
      const trailing = context.closingFenceTrailing ?? '';
      closeLine = `${context.linePrefix}${closeFence}${trailing}`;
    }
  }

  const formattedLines = newValue.split(/\r?\n/).map((line) => {
    if (context.linePrefix) {
      return context.linePrefix + line;
    }
    return line;
  });

  const rawParts = [openLine, ...formattedLines];
  if (closeLine !== null) {
    rawParts.push(closeLine);
  }
  let newRaw = rawParts.join(context.newline);
  if (context.trailingNewline !== null) {
    newRaw += context.trailingNewline;
  }

  if (
    !buildAndVerifyCandidate(
      source,
      context,
      newRaw,
      undefined,
      newValue,
      closeLine ?? undefined
    )
  ) {
    return null;
  }

  return {
    changes: [{ from: context.range.from, to: context.range.to, insert: newRaw }],
    userEvent: 'code-block.value-edit'
  };
}

function buildAndVerifyCandidate(
  source: string,
  context: CodeBlockContext,
  newRaw: string,
  expectedLanguage?: string,
  expectedValue?: string,
  expectedClosingFence?: string
): boolean {
  const candidate =
    source.slice(0, context.range.from) +
    newRaw +
    source.slice(context.range.to);

  return verifyCandidateCodeBlock(
    candidate,
    context.range.from,
    expectedLanguage,
    expectedValue,
    context.range.from + newRaw.length,
    newRaw,
    expectedClosingFence
  );
}

/**
 * 创建修改代码块语言标识的事务。
 */
export function createCodeBlockLanguageTransaction(
  source: string,
  context: CodeBlockContext,
  newLanguage: string
): MarkdownEditTransaction | null {
  if (source !== context.source) return null;
  if (source.slice(context.range.from, context.range.to) !== context.raw) return null;

  const firstLine = buildLanguageOpeningLine(context, newLanguage);

  const matchNl = context.raw.match(/\r?\n/);
  let newRaw = '';
  if (matchNl && matchNl.index !== undefined) {
    const remainder = context.raw.slice(matchNl.index);
    newRaw = firstLine + remainder;
  } else {
    newRaw = firstLine;
  }

  if (
    !buildAndVerifyCandidate(
      source,
      context,
      newRaw,
      newLanguage,
      undefined
    )
  ) {
    return null;
  }

  return {
    changes: [{ from: context.range.from, to: context.range.to, insert: newRaw }],
    userEvent: 'code-block.language-edit'
  };
}

/**
 * 查找指定位置的代码块并向 EditorView 派发语言切换事务。
 */
export function dispatchCodeBlockLanguageChange(
  view: EditorView,
  from: number,
  nextLang: string,
  currentLang?: string
): void {
  if (view.state.readOnly) return;
  if (nextLang === (currentLang || '')) return;

  const src = view.state.doc.toString();
  const parsed = parseMarkdown(src);
  let target: Extract<MarkdownBlockNode, { type: 'code-block' }> | null = null;
  walkBlockNodes(parsed.root.children, (child) => {
    if (child.type === 'code-block' && child.range.from === from) {
      target = child;
      return true;
    }
    return false;
  });
  if (target) {
    const ctx = parseCodeBlockContext(src, target);
    const tx = createCodeBlockLanguageTransaction(src, ctx, nextLang);
    if (tx) {
      view.dispatch({ changes: tx.changes, userEvent: tx.userEvent });
    }
  }
}

