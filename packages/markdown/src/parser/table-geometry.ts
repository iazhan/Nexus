/**
 * 表格几何：管道定界符扫描、表格边界判定、单元格范围计算，以及把 marked 的 table token
 * 裁到「第一个不含未转义 `|` 的行」为止。
 */
import { marked, type Token, type Tokens } from 'marked';

/**
 * Returns all unescaped pipe '|' indices in a table row line.
 */
export function getUnescapedPipes(line: string): number[] {
  const pipes: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|') {
      let backslashes = 0;
      let k = i - 1;
      while (k >= 0 && line[k] === '\\') {
        backslashes++;
        k--;
      }
      if (backslashes % 2 === 0) {
        pipes.push(i);
      }
    }
  }
  return pipes;
}

/**
 * Returns the exact column cell ranges inside a table row line.
 * Correctly handles tables with or without leading/trailing pipes and escaped pipes.
 */
/**
 * 计算表格在源码中的真实结束位置与数据行数量。
 *
 * marked 的 table token 会一直吞到空行或下一个块级结构为止（GFM 语义），
 * 于是表格后面紧跟的普通段落也会被算成数据行。编辑器需要更严格的边界：
 * 表格在第一个不含未转义 `|` 的行结束，紧随其后的段落仍是独立段落。
 */
export function resolveTableBounds(
  source: string,
  tokenStart: number,
  tokenEnd: number
): { end: number; dataRowCount: number } {
  let offset = tokenStart;
  let lineIndex = 0;
  let dataRowCount = 0;
  let end = tokenStart;

  while (offset < tokenEnd) {
    const nextBreak = source.indexOf('\n', offset);
    const lineEnd = nextBreak === -1 || nextBreak >= tokenEnd ? tokenEnd : nextBreak;
    const lineText = source.slice(offset, lineEnd);

    // 前两行是表头与分隔行，之后每一行都必须含未转义 `|` 才算数据行
    if (lineIndex >= 2 && getUnescapedPipes(lineText).length === 0) {
      break;
    }
    if (lineIndex >= 2) {
      dataRowCount += 1;
    }

    end = nextBreak === -1 || nextBreak >= tokenEnd ? lineEnd : nextBreak + 1;
    if (nextBreak === -1 || nextBreak >= tokenEnd) break;
    offset = nextBreak + 1;
    lineIndex += 1;
  }

  return { end, dataRowCount };
}

export function getRowCellRanges(
  line: string,
  rowOffset = 0
): { slotStart: number; slotEnd: number; from: number; to: number }[] {
  const pipes = getUnescapedPipes(line);
  const hasLeadingPipe = pipes.length > 0 && line.slice(0, pipes[0]).trim() === '';
  const hasTrailingPipe =
    pipes.length > 0 && line.slice(pipes[pipes.length - 1]! + 1).trim() === '';

  const delimiters: number[] = [];
  if (hasLeadingPipe) {
    delimiters.push(pipes[0]!);
  } else {
    delimiters.push(-1);
  }

  const startIdx = hasLeadingPipe ? 1 : 0;
  const endIdx = hasTrailingPipe ? pipes.length - 1 : pipes.length;
  for (let p = startIdx; p < endIdx; p++) {
    delimiters.push(pipes[p]!);
  }

  if (hasTrailingPipe) {
    delimiters.push(pipes[pipes.length - 1]!);
  } else {
    delimiters.push(line.length);
  }

  const cells: { slotStart: number; slotEnd: number; from: number; to: number }[] = [];
  for (let i = 0; i < delimiters.length - 1; i++) {
    const p1 = delimiters[i]!;
    const p2 = delimiters[i + 1]!;
    const segment = line.slice(p1 + 1, p2);
    const leadMatch = segment.match(/^\s*/);
    const trailMatch = segment.match(/\s*$/);
    const leadLen = leadMatch ? leadMatch[0].length : 0;
    const trailLen = trailMatch ? trailMatch[0].length : 0;
    const cFrom = rowOffset + p1 + 1 + leadLen;
    const cTo = Math.max(cFrom, rowOffset + p2 - trailLen);
    cells.push({
      slotStart: p1 + 1,
      slotEnd: p2,
      from: cFrom,
      to: cTo
    });
  }
  return cells;
}

/**
 * 把 marked 的 table token 裁到「第一个不含未转义 `|` 的行」为止，并把裁掉的文本重新 lex 成后续 token。
 *
 * marked 遵循 GFM：表格只会被空行或新的块级结构打断，因此紧跟表格的普通段落行也会被
 * 当作数据行。编辑器需要更严格的边界，否则紧随的段落会被吞进表格、无法单独编辑；
 * 同时必须把剩余文本重新 token 化，否则这部分内容会直接从 AST 中消失。
 */
export function splitTrailingTableLines(tokens: Token[]): Token[] {
  const result: Token[] = [];

  for (const token of tokens) {
    if (token.type !== 'table') {
      result.push(token);
      continue;
    }

    const raw = token.raw;
    let offset = 0;
    let lineIndex = 0;
    let keptRows = 0;
    let cutOffset = -1;

    while (offset < raw.length) {
      const nextBreak = raw.indexOf('\n', offset);
      const lineEnd = nextBreak === -1 ? raw.length : nextBreak;
      const lineText = raw.slice(offset, lineEnd);

      if (lineIndex >= 2) {
        if (lineText.trim().length === 0 || getUnescapedPipes(lineText).length === 0) {
          cutOffset = offset;
          break;
        }
        keptRows += 1;
      }

      if (nextBreak === -1) break;
      offset = nextBreak + 1;
      lineIndex += 1;
    }

    if (cutOffset === -1) {
      result.push(token);
      continue;
    }

    const tableToken = token as Tokens.Table;
    const tableRaw = raw.slice(0, cutOffset);
    const tailRaw = raw.slice(cutOffset);

    result.push({
      ...tableToken,
      raw: tableRaw,
      rows: tableToken.rows.slice(0, keptRows)
    } as Token);

    if (tailRaw.length > 0) {
      const tailTokens = marked.lexer(tailRaw, { gfm: true, breaks: false });
      if (tailTokens.length > 0) {
        result.push(...tailTokens);
      } else {
        // 纯空白的尾巴也必须留下 token：否则后续 token 匹配源码偏移时会整体错位
        result.push({ type: 'space', raw: tailRaw } as Token);
      }
    }
  }

  return result;
}

