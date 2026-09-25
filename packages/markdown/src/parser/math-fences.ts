/**
 * 块级公式围栏的预处理：`marked` 把空行当段落边界，会把被空行拆开的 `$$ ... $$`
 * 切成多个 paragraph，这里在映射前把它们合并回一个 token。
 */
import type { Token, Tokens } from 'marked';

/**
 * 在 `raw` 里找「整行只有 `$$`」的围栏行，返回该行结束处的偏移（含行尾换行）；
 * 找不到返回 `null`。
 */
function findStandaloneMathFenceEnd(raw: string): number | null {
  let offset = 0;
  while (offset <= raw.length) {
    const nextBreak = raw.indexOf('\n', offset);
    const lineEnd = nextBreak === -1 ? raw.length : nextBreak;
    if (raw.slice(offset, lineEnd).trim() === '$$') {
      return nextBreak === -1 ? raw.length : nextBreak + 1;
    }
    if (nextBreak === -1) break;
    offset = nextBreak + 1;
  }
  return null;
}

/** 第一行是不是「整行只有 `$$`」的围栏。 */
function startsWithMathFence(raw: string): boolean {
  const lineEnd = raw.indexOf('\n');
  return raw.slice(0, lineEnd === -1 ? raw.length : lineEnd).trim() === '$$';
}

/**
 * 把被空行拆开的 `$$ ... $$` 围栏合并回一个 paragraph token。
 *
 * `marked` 把空行当段落边界，所以
 *
 *     $$
 *
 *     E = mc^2
 *
 *     $$
 *
 * 会变成三个 paragraph，而下面 `case 'paragraph'` 的块级公式判定要求开合 `$$`
 * 落在**同一个** paragraph 里 → 认不出来。
 *
 * 后果是两个事实源对同一段语法给出不同答案：`findMarkdownMarkers`（独立扫描器）
 * 认它是块级公式并画上底纹，AST 不认、永不渲染——用户看到一块"有底纹但不渲染"的源码。
 *
 * 合并规则刻意保守，两道守卫保证不会误吞内容：
 * 1. 已经自带闭合围栏的 paragraph 原样放行（既有判定负责）；
 * 2. 向后只跨越 `paragraph` / `space`，碰到标题、列表、代码块等立刻放弃合并。
 */
export function mergeBlankSeparatedMathFences(tokens: Token[]): Token[] {
  const result: Token[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type !== 'paragraph') {
      result.push(token);
      continue;
    }

    // (1) 一个 paragraph 里可能挤着**多个**公式：两段围栏之间没有空行时，
    //     整体就是一个 paragraph。按围栏把它切开，让每个公式各自成 token。
    //     不切的话下面的闭合判定会把它当成"首尾都是 `$$` 的一个公式"，
    //     公式体里混进 `$$` 和下一段公式；而 marker 扫描器认得是两段，两边又不一致。
    let rest = token.raw;
    let split = false;
    while (startsWithMathFence(rest)) {
      const firstBreak = rest.indexOf('\n');
      if (firstBreak === -1) break;
      const fenceEnd = findStandaloneMathFenceEnd(rest.slice(firstBreak + 1));
      if (fenceEnd === null) break;
      const blockEnd = firstBreak + 1 + fenceEnd;
      const block = rest.slice(0, blockEnd);
      result.push({ type: 'paragraph', raw: block, text: block } as Tokens.Paragraph);
      rest = rest.slice(blockEnd);
      split = true;
    }
    if (split) {
      if (rest) {
        result.push({ type: 'paragraph', raw: rest, text: rest } as Tokens.Paragraph);
      }
      continue;
    }

    // (2) 首行是围栏、但本 paragraph 内没有闭合围栏 —— 跨空行去找闭合围栏。
    if (!startsWithMathFence(token.raw)) {
      result.push(token);
      continue;
    }

    let merged = token.raw;
    let endIndex = -1;
    let remainder = '';
    for (let j = i + 1; j < tokens.length; j++) {
      const candidate = tokens[j]!;
      if (candidate.type === 'space') {
        merged += candidate.raw;
        continue;
      }
      if (candidate.type !== 'paragraph') break;
      const fenceEnd = findStandaloneMathFenceEnd(candidate.raw);
      if (fenceEnd !== null) {
        merged += candidate.raw.slice(0, fenceEnd);
        remainder = candidate.raw.slice(fenceEnd);
        endIndex = j;
        break;
      }
      merged += candidate.raw;
    }

    if (endIndex === -1) {
      result.push(token);
      continue;
    }

    result.push({ type: 'paragraph', raw: merged, text: merged } as Tokens.Paragraph);
    if (remainder) {
      result.push({ type: 'paragraph', raw: remainder, text: remainder } as Tokens.Paragraph);
    }
    i = endIndex;
  }

  return result;
}

