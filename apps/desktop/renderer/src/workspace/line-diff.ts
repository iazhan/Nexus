import type { DiffLine } from '@nexus/core';

/**
 * 超过这个行数就不做 LCS。
 *
 * 表是 O(n×m) 的：3000 行两侧就是 900 万个格子，在渲染进程里会明显卡顿。
 * 超限时退化成「整体替换」—— 结果仍然正确，只是不够精细。
 */
const MAX_DIFF_LINES = 3000;

/**
 * 行级差异（LCS）。
 *
 * ## 为什么自己写而不是引库
 *
 * 需要的就是「行级、两个版本、只读展示」这一件事。引入 diff 库要多一个依赖，
 * 而这里的核心逻辑（LCS 表 + 回溯）只有三十来行，可测、可读。
 * 真需要字符级或三路合并时再考虑引库。
 *
 * ## 顺序约定
 *
 * 回溯时**先输出删除、后输出新增**，所以一段改动的呈现是「旧行在上、新行在下」，
 * 和 git diff 的习惯一致。
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  if (beforeLines.length > MAX_DIFF_LINES || afterLines.length > MAX_DIFF_LINES) {
    return [
      ...beforeLines.map((text) => ({ kind: 'removed' as const, text })),
      ...afterLines.map((text) => ({ kind: 'added' as const, text }))
    ];
  }

  const rows = beforeLines.length;
  const cols = afterLines.length;

  // table[i][j] = beforeLines[i..] 与 afterLines[j..] 的最长公共子序列长度
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0)
  );

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i]![j] =
        beforeLines[i] === afterLines[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < rows && j < cols) {
    if (beforeLines[i] === afterLines[j]) {
      result.push({ kind: 'same', text: beforeLines[i]! });
      i += 1;
      j += 1;
      continue;
    }

    // 相等时优先走删除分支 —— 这样「改一行」呈现为「删一行 + 加一行」，
    // 而不是先加后删
    if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      result.push({ kind: 'removed', text: beforeLines[i]! });
      i += 1;
    } else {
      result.push({ kind: 'added', text: afterLines[j]! });
      j += 1;
    }
  }

  while (i < rows) {
    result.push({ kind: 'removed', text: beforeLines[i]! });
    i += 1;
  }
  while (j < cols) {
    result.push({ kind: 'added', text: afterLines[j]! });
    j += 1;
  }

  return result;
}

/**
 * 按行切分，**不保留结尾的空元素**。
 *
 * `'a\n'.split('\n')` 得到 `['a', '']`，末尾那个空串是行终止符的产物而不是一行。
 * 不处理的话，每次 diff 末尾都会多出一条不存在的空行。
 */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];

  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
