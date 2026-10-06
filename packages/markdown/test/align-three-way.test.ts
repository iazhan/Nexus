import { describe, it, expect } from 'vitest';
import { alignThreeWay } from '../src/align.js';

const doc = (...blocks: string[]): string => `${blocks.join('\n\n')}\n`;

/** 决策表里每一格的用例都从这里取，避免每处各写一份长句子。 */
const LONG_BASE = '这一段说明讲的是缓存策略，以及它在读路径上的取舍。';
const LONG_MINE = '这一段说明讲的是缓存失效策略，以及它在读路径上的取舍。';
const LONG_THEIRS = '这一段说明讲的是缓存策略，以及它在写路径上的取舍。';

describe('三路对齐', () => {
  it('三份相同 → 全 mine，无冲突', () => {
    const src = doc('# 标题', LONG_BASE, '- 列表项');
    const rows = alignThreeWay(src, src, src);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.suggestion === 'mine')).toBe(true);
    expect(rows.every((r) => r.mine === r.base && r.theirs === r.base)).toBe(true);
  });

  it('只有 mine 改了 → 建议 mine，theirs 侧保持 base', () => {
    const rows = alignThreeWay(doc(LONG_BASE), doc(LONG_MINE), doc(LONG_BASE));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.suggestion).toBe('mine');
    expect(rows[0]!.mine).toContain('失效');
    expect(rows[0]!.theirs).toBe(rows[0]!.base);
  });

  it('只有 theirs 改了 → 建议 theirs', () => {
    const rows = alignThreeWay(doc(LONG_BASE), doc(LONG_BASE), doc(LONG_THEIRS));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.suggestion).toBe('theirs');
    expect(rows[0]!.theirs).toContain('写路径');
    expect(rows[0]!.mine).toBe(rows[0]!.base);
  });

  it('两边独立改成了同一样子 → 不是冲突', () => {
    // 「两人各自修正了同一个错别字」—— 最不需要人管的一格，不能报成 conflict。
    const same = doc(LONG_MINE);
    const rows = alignThreeWay(doc(LONG_BASE), same, same);
    expect(rows[0]!.suggestion).toBe('mine');
    expect(rows[0]!.mine).toBe(rows[0]!.theirs);
  });

  it('两边改成不同样子 → conflict', () => {
    const rows = alignThreeWay(doc(LONG_BASE), doc(LONG_MINE), doc(LONG_THEIRS));
    expect(rows[0]!.suggestion).toBe('conflict');
    expect(rows[0]!.mine).toContain('失效');
    expect(rows[0]!.theirs).toContain('写路径');
    expect(rows[0]!.base).toBe(LONG_BASE + '\n');
  });

  it('一边删一边改 → conflict', () => {
    const base = doc(LONG_BASE, '第二段保持不动。');
    const mine = doc('第二段保持不动。'); // mine 删掉了第一块
    const theirs = doc(LONG_THEIRS, '第二段保持不动。');
    const rows = alignThreeWay(base, mine, theirs);
    const first = rows.find((r) => r.baseIndex === 0)!;
    expect(first.suggestion).toBe('conflict');
    expect(first.mine).toBeNull();
    expect(first.theirs).toContain('写路径');
  });

  it('两边都删同一块 → 无冲突', () => {
    const base = doc(LONG_BASE, '第二段。');
    const both = doc('第二段。');
    const rows = alignThreeWay(base, both, both);
    const first = rows.find((r) => r.baseIndex === 0)!;
    expect(first.suggestion).toBe('mine');
    expect(first.mine).toBeNull();
    expect(first.theirs).toBeNull();
  });

  it('一边删、另一边没动 → 建议删的那一边', () => {
    const base = doc(LONG_BASE, '第二段。');
    const mine = doc('第二段。');
    const rows = alignThreeWay(base, mine, base);
    expect(rows.find((r) => r.baseIndex === 0)!.suggestion).toBe('mine');
  });

  it('两边各加不同的块 → both（都保留）', () => {
    const base = doc('原有段落。');
    const mine = doc('原有段落。', '我加的一段。');
    const theirs = doc('原有段落。', '对方加的一段。');
    const rows = alignThreeWay(base, mine, theirs);
    expect(rows.map((r) => r.suggestion)).toEqual(['mine', 'both']);
    const added = rows[1]!;
    expect(added.baseIndex).toBeNull();
    expect(added.mine).toContain('我加的');
    expect(added.theirs).toContain('对方加的');
  });

  it('两边加相同的块 → 合成一行，不重复', () => {
    const base = doc('原有段落。');
    const same = doc('原有段落。', '两边都加的一段。');
    const rows = alignThreeWay(base, same, same);
    expect(rows.map((r) => r.suggestion)).toEqual(['mine', 'mine']);
    expect(rows[1]!.baseIndex).toBeNull();
    expect(rows[1]!.mine).toBe(rows[1]!.theirs);
  });

  it('只有一边加了块 → 建议那一边', () => {
    const base = doc('原有段落。');
    const mine = doc('原有段落。', '只有我加的。');
    const rows = alignThreeWay(base, mine, base);
    expect(rows.map((r) => r.suggestion)).toEqual(['mine', 'mine']);
    expect(rows[1]!.theirs).toBeNull();
  });

  it('新增块插在中间时，落在它前面那个 base 块之后', () => {
    const base = doc('甲。', '乙。', '丙。');
    const mine = doc('甲。', '乙。', '插在乙后面的。', '丙。');
    const rows = alignThreeWay(base, mine, base);
    const added = rows.find((r) => r.baseIndex === null)!;
    expect(added.mine).toContain('插在乙后面的');
    // 它在「乙」那一行之后、「丙」之前
    const addedAt = rows.indexOf(added);
    expect(rows[addedAt - 1]!.base).toContain('乙');
    expect(rows[addedAt + 1]!.base).toContain('丙');
  });

  it('baseIndex 覆盖 base 的每一块，且单调递增', () => {
    const base = doc('甲。', '乙。', '丙。', '丁。');
    const mine = doc('甲改。', '乙。', '丙。', '丁。');
    const theirs = doc('甲。', '乙。', '丙。', '丁改。');
    const rows = alignThreeWay(base, mine, theirs);
    const indexes = rows.map((r) => r.baseIndex).filter((i): i is number => i !== null);
    expect(indexes).toEqual([0, 1, 2, 3]);
  });

  it('三份相同 → 没有 conflict，且没有重复块', () => {
    // 五个顶层块：标题 / 段落 / 标题 / 列表 / 引用。
    // 列表项写成**一个**参数（含换行）：`doc()` 用空行拼接，拆成两个参数会被 marked
    // 读成一个松散列表，块数就不对了。
    const src = doc('# 一', '正文。', '## 二', '- 项一\n- 项二', '> 引用');
    const rows = alignThreeWay(src, src, src);
    expect(rows.some((r) => r.suggestion === 'conflict')).toBe(false);
    expect(rows).toHaveLength(5);
  });
});
