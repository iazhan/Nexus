/**
 * 块级对齐：把两份 Markdown 源按**顶层块**对齐。
 *
 * 这是冲突解决的地基 —— UI 渲染的行与实际应用的合并结果**都从这一份对齐派生**。
 * 分成两处实现会静默漂移：用户看到「改的是 A 块」，应用下去却动了 B 块，而那是不可逆的。
 *
 * ## 三层降级
 *
 * 1. 比较键**完全相等**（LCS）→ `same`
 * 2. 间隙内**首行相似度** > 阈值（Levenshtein）→ `changed`
 * 3. 剩下未匹配的 → `left-only` / `right-only`
 *
 * 比 Tine 的 Concord 少一层「相同 `id::`」：source-first 模型里没有块 id，**块身份就是它的文本**。
 *
 * ## 只比首行
 *
 * 块的首行是它最稳定的特征（标题文本、列表项的第一句）。整块比较会把「改了一个字」和
 * 「换了一整段」混为一谈，两者在合并时该给用户看的东西完全不同。
 *
 * ## 比较键要归一换行
 *
 * 键取块的 raw 去尾随空白、并把 `\r\n` 折成 `\n`。少了这一步，CRLF 文档与 LF 文档的同一块
 * 会被判成两块不同的东西 —— 而 Windows 上 Obsidian / 记事本写出来的笔记全是 CRLF。
 *
 * ## 上限与退化
 *
 * LCS 是 O(n×m)。块数超限就退化为「整体增删」：结果**仍然正确**（每一块都能被看到并选择），
 * 只是不够精细。对齐走的是手动触发的合并路径，不是热路径。
 *
 * ## 只读
 *
 * 不碰任何序列化路径 —— 往返不变量（未编辑时字节保真）不受影响。
 */
import { parseMarkdown } from './parser.js';
import type { MarkdownBlockNode } from './types.js';

/**
 * 单侧块数上限。超过就退化为整体增删，见文件头「上限与退化」。
 *
 * 3000 与行级 diff 的 `MAX_DIFF_LINES` 同值 —— 同一仓库里的同类上限不引入第二个数字。
 * 配合下面的 typed array，3000×3000 的表约占 27MB，而不是普通数组的 ~70MB。
 * （实测语料里最长的一篇是 2389 块，所以这个上限刚好把它收进来。）
 */
const MAX_ALIGN_BLOCKS = 3000;

/**
 * 首行相似度阈值。低于它就不配对 —— 硬凑成 `changed` 比老实标成增删更误导。
 *
 * 取 0.8（同 Tine）。**代价是短块对改动敏感**：Levenshtein 按最长边归一，11 个字的块
 * 改 3 个字就掉到 0.79，于是「改一句」会呈现成 `left-only` + `right-only`。
 * 这是取舍不是缺陷 —— 多出一块让用户自己看，比把两块不相干的东西摆成「同一块的两版」安全。
 */
const SIMILARITY_THRESHOLD = 0.8;

/** 参与 Levenshtein 的首行长度上限。超过则退化为公共前缀比较，避免 O(n×m) 失控。 */
const MAX_SIMILARITY_CHARS = 200;

export type AlignKind = 'same' | 'changed' | 'left-only' | 'right-only';

export interface AlignedRow {
  kind: AlignKind;
  /** 左文档该块的原文；`null` = 左侧没有对应块。 */
  left: string | null;
  /** 右文档该块的原文；`null` = 右侧没有对应块。 */
  right: string | null;
  /** 左文档顶层块里的下标；`null` 同上。 */
  leftIndex: number | null;
  /** 右文档顶层块里的下标；`null` 同上。 */
  rightIndex: number | null;
}

/**
 * 对齐两份 Markdown 源。顺序即文档顺序（左、右各自的下标单调递增）。
 */
export function alignBlocks(left: string, right: string): AlignedRow[] {
  const leftBlocks = topLevelBlocks(left);
  const rightBlocks = topLevelBlocks(right);

  if (leftBlocks.length > MAX_ALIGN_BLOCKS || rightBlocks.length > MAX_ALIGN_BLOCKS) {
    return [
      ...leftBlocks.map((raw, i) => makeRow('left-only', raw, null, i, null)),
      ...rightBlocks.map((raw, i) => makeRow('right-only', null, raw, null, i))
    ];
  }

  const leftKeys = leftBlocks.map(compareKey);
  const rightKeys = rightBlocks.map(compareKey);

  const rows: AlignedRow[] = [];
  let li = 0;
  let ri = 0;

  for (const [pi, pj] of lcsPairs(leftKeys, rightKeys, (a, b) => a === b)) {
    rows.push(...alignGap(leftBlocks, leftKeys, rightBlocks, rightKeys, li, pi, ri, pj));
    rows.push(makeRow('same', leftBlocks[pi]!, rightBlocks[pj]!, pi, pj));
    li = pi + 1;
    ri = pj + 1;
  }
  rows.push(
    ...alignGap(leftBlocks, leftKeys, rightBlocks, rightKeys, li, leftBlocks.length, ri, rightBlocks.length)
  );

  return rows;
}

/** 顶层块（`root.children`）的原文，顺序即文档顺序。 */
function topLevelBlocks(source: string): string[] {
  if (source.trim().length === 0) return [];
  return parseMarkdown(source).root.children.map((block: MarkdownBlockNode) => block.raw);
}

/** 比较键：折换行 + 去尾随空白。见文件头「比较键要归一换行」。 */
function compareKey(raw: string): string {
  return raw.replace(/\r\n/g, '\n').trimEnd();
}

/**
 * 在一段「间隙」（两侧都没有被 L1 匹配上的区间）里找相似配对。
 *
 * 间隙通常很短 —— L1 已经把大部分块吃掉了 —— 所以这里直接用一次带阈值的 LCS，
 * 不做更细的启发式。
 */
function alignGap(
  leftBlocks: readonly string[],
  leftKeys: readonly string[],
  rightBlocks: readonly string[],
  rightKeys: readonly string[],
  lFrom: number,
  lTo: number,
  rFrom: number,
  rTo: number
): AlignedRow[] {
  if (lFrom >= lTo && rFrom >= rTo) return [];

  const gapLeft = leftKeys.slice(lFrom, lTo);
  const gapRight = rightKeys.slice(rFrom, rTo);
  const pairs = lcsPairs(gapLeft, gapRight, similarFirstLine);

  const rows: AlignedRow[] = [];
  let li = lFrom;
  let ri = rFrom;

  for (const [gi, gj] of pairs) {
    const pi = lFrom + gi;
    const pj = rFrom + gj;
    for (let k = li; k < pi; k += 1) rows.push(makeRow('left-only', leftBlocks[k]!, null, k, null));
    for (let k = ri; k < pj; k += 1) rows.push(makeRow('right-only', null, rightBlocks[k]!, null, k));
    rows.push(makeRow('changed', leftBlocks[pi]!, rightBlocks[pj]!, pi, pj));
    li = pi + 1;
    ri = pj + 1;
  }
  for (let k = li; k < lTo; k += 1) rows.push(makeRow('left-only', leftBlocks[k]!, null, k, null));
  for (let k = ri; k < rTo; k += 1) rows.push(makeRow('right-only', null, rightBlocks[k]!, null, k));

  return rows;
}

/**
 * 最长公共子序列的匹配对，返回 `[左下标, 右下标]`，按下标升序。
 *
 * `canMatch` 而不是「相等」：同一份代码服务 L1（键完全相等）与 L2（首行相似）两趟，
 * 两趟的差别只在传进来的判据上 —— 分开写两份 LCS 就等于把这段回溯逻辑复制一遍。
 *
 * 回溯时**先走左**（`>=`）：与行级 diff 的 `line-diff.ts` 同一约定，「改一块」呈现为
 * 「左边在上、右边在下」。
 */
function lcsPairs(
  leftKeys: readonly string[],
  rightKeys: readonly string[],
  canMatch: (a: string, b: string) => boolean
): Array<[number, number]> {
  const n = leftKeys.length;
  const m = rightKeys.length;
  if (n === 0 || m === 0) return [];

  // 两张表都走 typed array：3000×3000 时普通数组是 ~70MB，Uint8/Uint16 是 ~27MB。
  // 上界由 `MAX_ALIGN_BLOCKS` 兜住，所以 Uint16 存得下（上限远小于 65535）。
  const stride = m + 1;

  // 先算匹配矩阵，避免在 O(n×m) 的表里反复调用 Levenshtein
  const can = new Uint8Array(n * m);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      can[i * m + j] = canMatch(leftKeys[i]!, rightKeys[j]!) ? 1 : 0;
    }
  }

  const table = new Uint16Array((n + 1) * stride);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * stride + j] = can[i * m + j]
        ? table[(i + 1) * stride + (j + 1)]! + 1
        : Math.max(table[(i + 1) * stride + j]!, table[i * stride + (j + 1)]!);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (can[i * m + j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * stride + j]! >= table[i * stride + (j + 1)]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * 两个块的首行是否「足够像」。
 *
 * 先做两次廉价排除（长度差、超长），再算 Levenshtein —— 在 LCS 的表里它会被调用
 * n×m 次，直接算会在长文档上失控。
 */
function similarFirstLine(a: string, b: string): boolean {
  if (a === b) return true;
  const lineA = firstLine(a);
  const lineB = firstLine(b);
  if (lineA.length === 0 || lineB.length === 0) return false;

  const longer = Math.max(lineA.length, lineB.length);
  if (Math.abs(lineA.length - lineB.length) / longer > 1 - SIMILARITY_THRESHOLD) return false;

  if (lineA.length > MAX_SIMILARITY_CHARS || lineB.length > MAX_SIMILARITY_CHARS) {
    return commonPrefixRatio(lineA, lineB) >= SIMILARITY_THRESHOLD;
  }

  const distance = levenshtein(lineA, lineB);
  return 1 - distance / longer >= SIMILARITY_THRESHOLD;
}

function firstLine(key: string): string {
  const nl = key.indexOf('\n');
  return nl === -1 ? key : key.slice(0, nl);
}

function commonPrefixRatio(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i / Math.max(a.length, b.length);
}

/** 标准 DP，两行滚动数组 —— 只需要距离，不需要回溯路径。 */
function levenshtein(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;

  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let j = 0; j <= m; j += 1) prev[j] = j;

  for (let i = 1; i <= n; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= m; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[m]!;
}

function makeRow(
  kind: AlignKind,
  left: string | null,
  right: string | null,
  leftIndex: number | null,
  rightIndex: number | null
): AlignedRow {
  return { kind, left, right, leftIndex, rightIndex };
}

// ---------------------------------------------------------------------------
// 三路：给定共同祖先，把两侧的改动合并成一行行的**建议**
// ---------------------------------------------------------------------------

/**
 * 建议采纳哪一侧。
 *
 * `both` = base 里没有这一块、两边各加了不同的东西 —— 都保留（写成相邻块）不丢内容。
 * `conflict` = 两边都动了同一块且结果不同 —— **不给建议**，交给人判。
 */
export type ThreeWaySuggestion = 'mine' | 'theirs' | 'both' | 'conflict';

export interface ThreeWayRow {
  /** 锚在 base 的哪一块；`null` = base 里没有（两侧的新增）。 */
  baseIndex: number | null;
  base: string | null;
  mine: string | null;
  theirs: string | null;
  suggestion: ThreeWaySuggestion;
}

/**
 * 三路对齐：有共同祖先 `base` 时，把 `mine` / `theirs` 的改动合成逐行建议。
 *
 * 这是 Tine ADR 0056 的核心机制。没有 base 的两路对齐只能说「两边不一样」，
 * **说不出「谁改的」** —— 于是每一行都只能默认「保留我这边」，用户得自己逐块推理。
 * 有了 base，「只改了一边」的行能直接预选那一边，只有真正争用的行才需要思考。
 *
 * ## 建议只是建议
 *
 * `suggestion` 永远只是**预选**，不是自动应用。Tine 明确拒绝自动合并（数据安全），
 * Nexus 判据 13 同源 —— 失败方向必须选「不做」。
 *
 * ## 决策表
 *
 * | mine 侧 | theirs 侧 | 建议 |
 * | --- | --- | --- |
 * | 未改 | 未改 | `mine`（等价，无变化） |
 * | 改了 | 未改 | `mine` |
 * | 未改 | 改了 | `theirs` |
 * | 删了 | 未改 | `mine` |
 * | 未改 | 删了 | `theirs` |
 * | 删了 | 删了 | `mine`（等价，都删了） |
 * | 改了 | 改了（**结果相同**） | `mine`（等价 —— 两边独立改成了同一样子，不是冲突） |
 * | 改了 | 改了（结果不同） | `conflict` |
 * | 删了 | 改了 | `conflict` |
 * | 改了 | 删了 | `conflict` |
 *
 * 「两边改成了同一样子」那一格是**必须单列的**：只按「两边都动了」判冲突，
 * 会把「两人各自修正了同一个错别字」报成冲突，而它恰恰是最不需要人管的。
 *
 * ## base 里没有的块
 *
 * 两侧各自新增的块归到「前一个 base 块之后」，**按出现顺序配对**：内容相同就合成一行，
 * 不同则给 `both`（两块都留）。配对是简化的（按序号而非做集合匹配）——
 * 真实场景里两侧同时在同一位置加不同内容本来就少见，而 `both` 不丢内容。
 */
export function alignThreeWay(base: string, mine: string, theirs: string): ThreeWayRow[] {
  const baseBlocks = topLevelBlocks(base);
  const mineState = sideState(alignBlocks(base, mine));
  const theirsState = sideState(alignBlocks(base, theirs));

  const rows: ThreeWayRow[] = [];

  // 先放「在最前面」的新增块（键 `-1`），再逐个 base 块 —— 每块**之后**跟它的新增块。
  rows.push(...mergeAdded(mineState.addedAfter.get(-1) ?? [], theirsState.addedAfter.get(-1) ?? []));

  for (let i = 0; i < baseBlocks.length; i += 1) {
    const baseText = baseBlocks[i]!;
    const mineSide = mineState.byBase[i] ?? { kind: 'same' as const, text: baseText };
    const theirsSide = theirsState.byBase[i] ?? { kind: 'same' as const, text: baseText };

    const mineMoved = mineSide.kind !== 'same';
    const theirsMoved = theirsSide.kind !== 'same';

    if (mineMoved && theirsMoved && mineSide.text !== theirsSide.text) {
      rows.push(makeThreeWayRow(i, baseText, mineSide.text, theirsSide.text, 'conflict'));
    } else if (!mineMoved && theirsMoved) {
      rows.push(makeThreeWayRow(i, baseText, baseText, theirsSide.text, 'theirs'));
    } else {
      // 其余全部落这里：都没动 / 只有 mine 动 / 两边动成了同一样子。
      rows.push(makeThreeWayRow(i, baseText, mineSide.text, theirsSide.text, 'mine'));
    }

    rows.push(
      ...mergeAdded(mineState.addedAfter.get(i) ?? [], theirsState.addedAfter.get(i) ?? [])
    );
  }

  return rows;
}

/** 一侧相对 base 的状态。 */
interface SideState {
  /** base 块 i 在这一侧的样子：`same` 未改 / `changed` 改过 / `deleted` 删了。 */
  byBase: Array<{ kind: 'same' | 'changed' | 'deleted'; text: string | null }>;
  /** 插在 base 块 i **之后**的新增块；键 `-1` 表示在最前面。 */
  addedAfter: Map<number, string[]>;
}

/**
 * 把两路对齐的结果折成「按 base 块索引」的状态。
 *
 * 两路的每一行要么锚在一个 base 块上（`same` / `changed` / `left-only`），
 * 要么是这一侧新增的（`right-only`）—— 后者没有 base 锚点，只能挂到前一个 base 块之后。
 */
function sideState(rows: readonly AlignedRow[]): SideState {
  const byBase: SideState['byBase'] = [];
  const addedAfter = new Map<number, string[]>();
  let lastBase = -1;

  for (const row of rows) {
    if (row.kind === 'right-only') {
      const existing = addedAfter.get(lastBase);
      if (existing) existing.push(row.right!);
      else addedAfter.set(lastBase, [row.right!]);
      continue;
    }
    const index = row.leftIndex!;
    byBase[index] = {
      kind: row.kind === 'same' ? 'same' : row.kind === 'changed' ? 'changed' : 'deleted',
      text: row.right
    };
    lastBase = index;
  }

  return { byBase, addedAfter };
}

/** 两侧在同一位置各自新增的块：内容相同就合成一行，不同则给 `both`。 */
function mergeAdded(mineAdded: readonly string[], theirsAdded: readonly string[]): ThreeWayRow[] {
  const rows: ThreeWayRow[] = [];
  const count = Math.max(mineAdded.length, theirsAdded.length);

  for (let k = 0; k < count; k += 1) {
    const mineText = mineAdded[k] ?? null;
    const theirsText = theirsAdded[k] ?? null;

    if (mineText !== null && theirsText !== null) {
      rows.push(
        makeThreeWayRow(null, null, mineText, theirsText, mineText === theirsText ? 'mine' : 'both')
      );
    } else if (mineText !== null) {
      rows.push(makeThreeWayRow(null, null, mineText, null, 'mine'));
    } else {
      rows.push(makeThreeWayRow(null, null, null, theirsText, 'theirs'));
    }
  }

  return rows;
}

function makeThreeWayRow(
  baseIndex: number | null,
  base: string | null,
  mine: string | null,
  theirs: string | null,
  suggestion: ThreeWaySuggestion
): ThreeWayRow {
  return { baseIndex, base, mine, theirs, suggestion };
}
