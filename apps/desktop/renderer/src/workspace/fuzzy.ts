/**
 * 子序列模糊匹配（Ctrl+P 用）。
 *
 * 规则与 VSCode 的 quick open 同类：查询里的字符必须**按顺序**出现在目标中，
 * 但不要求连续 —— 所以 `ndma` 能命中 `notes/dma.md`。
 *
 * 打分只求「够用的排序」，不做花哨的加权：连续命中、词首命中、靠前命中加分，
 * 短目标整体加分。这些规则合起来能稳定地把「精确的文件名」排到「碰巧含这些字符的长路径」前面。
 */

export interface FuzzyMatch {
  score: number;
  /** 命中字符在目标里的下标，供 UI 高亮 */
  positions: number[];
}

/** 视为「词首」的分隔符。 */
const SEPARATORS = /[/\-_.\s]/;

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, positions: [] };

  const needle = query.toLowerCase();
  const haystack = target.toLowerCase();

  const positions: number[] = [];
  let score = 0;
  let cursor = 0;

  for (let index = 0; index < needle.length; index += 1) {
    const char = needle[index]!;
    const found = haystack.indexOf(char, cursor);
    if (found === -1) return null;

    // 与前一次命中相邻 —— 连续片段比零散命中更像用户想要的
    if (positions.length > 0 && found === cursor) score += 8;

    // 词首命中（开头，或紧跟分隔符）
    if (found === 0 || SEPARATORS.test(haystack[found - 1] ?? '')) score += 6;

    // 越靠前越可能是目标本身而不是偶然包含
    score += Math.max(0, 4 - Math.floor(found / 8));

    positions.push(found);
    cursor = found + 1;
  }

  // 短目标整体加分：`dma.md` 比 `notes/archive/dma-old.md` 更可能是想找的那个
  score += Math.max(0, 20 - target.length);

  return { score, positions };
}

/**
 * 按模糊得分给候选排序。命中不了的在结果里被丢掉。
 *
 * 返回的是 `{ item, match }`，把命中的下标一并带出去 —— 调用方要拿它做高亮，
 * 再算一次的话两边逻辑容易走偏。
 */
export function rankByFuzzy<T>(
  query: string,
  items: readonly T[],
  keyOf: (item: T) => string,
  limit = 50
): Array<{ item: T; match: FuzzyMatch }> {
  const results: Array<{ item: T; match: FuzzyMatch }> = [];

  for (const item of items) {
    const match = fuzzyMatch(query, keyOf(item));
    if (match) results.push({ item, match });
  }

  results.sort((a, b) => b.match.score - a.match.score);
  return results.slice(0, limit);
}
