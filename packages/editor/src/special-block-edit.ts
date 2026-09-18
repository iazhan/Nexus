import { parseMarkdown, type MarkdownBlockNode, type SourceRange } from '@nexus/markdown';
import type { MarkdownEditTransaction } from './types.js';
import { walkBlockNodes } from './ast-walker.js';

/**
 * 块级数学公式上下文。
 */
export interface BlockMathContext {
  range: SourceRange;
  raw: string;
  source: string;
  formula: string;
  indent: string;
  linePrefix: string;
  hasClosing: boolean;
  newline: '\r\n' | '\n';
  isSingleLine?: boolean;
  openingLineRaw?: string;
  closingLineRaw?: string;
  singleLineLeadingWhitespace?: string;
  singleLineTrailingWhitespace?: string;
  trailingNewline?: string | null;
}

/**
 * 解析 block-math AST 节点为 BlockMathContext。
 */
export function parseBlockMathContext(
  source: string,
  node: Extract<MarkdownBlockNode, { type: 'block-math' }>
): BlockMathContext {
  const isCRLF = node.raw.includes('\r\n');
  const newline = isCRLF ? '\r\n' : '\n';
  const trimmedRaw = node.raw.endsWith('\r\n')
    ? node.raw.slice(0, -2)
    : node.raw.endsWith('\n')
      ? node.raw.slice(0, -1)
      : node.raw;
  const rawLines = trimmedRaw.split(/\r?\n/);
  const firstLine = rawLines[0] ?? '';
  const trailingNewline = node.raw.endsWith('\r\n')
    ? '\r\n'
    : node.raw.endsWith('\n')
      ? '\n'
      : null;
  const match = firstLine.match(/^([ \t]*(?:>[ \t]*)*)/);
  const indent = match ? (match[1] ?? '') : '';

  let isSingleLine = false;
  let hasClosing = false;
  let linePrefix = indent;
  let closingLineRaw: string | undefined;
  let singleLineLeadingWhitespace = '';
  let singleLineTrailingWhitespace = '';

  if (rawLines.length === 1) {
    const singleMatch = firstLine.match(/^([ \t]*(?:>[ \t]*)*)\$\$(.*)\$\$$/);
    if (singleMatch) {
      isSingleLine = true;
      hasClosing = true;
      linePrefix = singleMatch[1] ?? indent;
      const body = singleMatch[2] ?? '';
      singleLineLeadingWhitespace = body.match(/^[ \t]*/)?.[0] ?? '';
      singleLineTrailingWhitespace = body.match(/[ \t]*$/)?.[0] ?? '';
    }
  } else if (rawLines.length > 1) {
    const lastLine = rawLines[rawLines.length - 1] ?? '';
    const closingMatch = lastLine.match(/^([ \t]*(?:>[ \t]*)*)\$\$([ \t]*)$/);
    linePrefix = closingMatch ? (closingMatch[1] ?? indent) : indent;
    hasClosing = Boolean(closingMatch);
    closingLineRaw = hasClosing ? lastLine : undefined;
  }

  return {
    range: { from: node.range.from, to: node.range.to },
    raw: node.raw,
    source,
    formula: node.formula,
    indent,
    linePrefix,
    hasClosing,
    isSingleLine,
    newline,
    openingLineRaw: firstLine,
    closingLineRaw,
    singleLineLeadingWhitespace,
    singleLineTrailingWhitespace,
    trailingNewline
  };
}

/**
 * 校验候选 Markdown 文本重新解析后是否包含预期的 block-math 节点，
 * 且必须同时精确验证目标节点类型、范围、唯一性和 formula 语义，拒绝真正提前闭合或拆分节点的输入。
 */
function verifyCandidateBlockMath(
  candidateSource: string,
  expectedFrom: number,
  expectedTo: number,
  expectedFormula?: string
): boolean {
  if (expectedFormula !== undefined) {
    // 检查 formula 中是否包含未转义的独立 $$ 定界行（真正提前闭合定界符）
    const lines = expectedFormula.split(/\r?\n/);
    for (const line of lines) {
      if (/^[ \t]*(?:>[ \t]*)*(?<!\\)\$\$$/.test(line)) {
        return false;
      }
    }
  }

  const { root } = parseMarkdown(candidateSource);
  let mathNode: Extract<MarkdownBlockNode, { type: 'block-math' }> | null = null;
  let overlappingCount = 0;

  walkBlockNodes(root.children, (child) => {
    if (child.type === 'blockquote' || child.type === 'list') {
      return false;
    }
    if (child.range.from >= expectedFrom && child.range.to <= expectedTo) {
      overlappingCount++;
      if (child.type === 'block-math' && child.range.from === expectedFrom && child.range.to === expectedTo) {
        mathNode = child;
      }
    } else if (child.range.from < expectedTo && child.range.to > expectedFrom) {
      overlappingCount++;
    }
    return false;
  });

  if (!mathNode || overlappingCount !== 1) {
    return false;
  }

  if (expectedFormula !== undefined) {
    const normActual = (mathNode as Extract<MarkdownBlockNode, { type: 'block-math' }>).formula.replace(/\r\n/g, '\n').trim();
    const normExpected = expectedFormula.replace(/\r\n/g, '\n').trim();
    if (normActual !== normExpected) {
      return false;
    }
  }

  return true;
}

/**
 * 创建编辑块级数学公式内容的事务。
 * 未闭合 $$ 保持 opaque，不得通过编辑路径自动规范化成闭合公式。
 */
export function createBlockMathEditTransaction(
  source: string,
  context: BlockMathContext,
  newFormula: string
): MarkdownEditTransaction | null {
  if (source !== context.source) return null;
  if (source.slice(context.range.from, context.range.to) !== context.raw) return null;
  if (context.hasClosing === false) return null;

  let newRaw: string;

  const normalizeFormula = (value: string): string => value.replace(/\r\n/g, '\n').trim();
  const formulaUnchanged = normalizeFormula(newFormula) === normalizeFormula(context.formula);

  if (formulaUnchanged) {
    // 语义未变时直接复用原始字节，保留定界符行尾空格、单行公式空白和 EOF 换行。
    newRaw = context.raw;
  } else if (context.isSingleLine && !newFormula.includes('\n')) {
    newRaw = `${context.indent}$$${newFormula}$$`;
    if (context.trailingNewline) newRaw += context.trailingNewline;
  } else {
    const openLine = context.openingLineRaw ?? `${context.indent}$$`;
    const closeLine = context.closingLineRaw ?? `${context.linePrefix}$$`;

    const formulaLines = newFormula.split(/\r?\n/).map((line) => {
      if (context.linePrefix) {
        return context.linePrefix + line;
      }
      return line;
    });

    newRaw = [openLine, ...formulaLines, closeLine].join(context.newline);
    if (context.trailingNewline) newRaw += context.trailingNewline;
  }

  const candidate =
    source.slice(0, context.range.from) +
    newRaw +
    source.slice(context.range.to);

  const expectedTo = context.range.from + newRaw.length;

  if (!verifyCandidateBlockMath(candidate, context.range.from, expectedTo, newFormula)) {
    return null;
  }

  return {
    changes: [{ from: context.range.from, to: context.range.to, insert: newRaw }],
    userEvent: 'block-math.edit'
  };
}
