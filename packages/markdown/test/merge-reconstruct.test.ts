import { describe, it, expect } from 'vitest';
import {
  alignThreeWay,
  joinMergedBlocks,
  topLevelBlockSlices,
  type ThreeWaySuggestion
} from '../src/align.js';
import { parseMarkdown } from '../src/parser.js';
import { serializeMarkdown } from '../src/serializer.js';

/** 用空行拼一份文档。 */
const doc = (...blocks: string[]): string => `${blocks.join('\n\n')}\n`;

/**
 * 照合并面板的规则重建一份合并结果。
 *
 * **这份实现刻意与面板里的那份分开写**：面板要是写错了，测试跟着错就白测了。
 * 这里只用导出的三个函数（`alignThreeWay` / `topLevelBlockSlices` / `joinMergedBlocks`），
 * 规则本身短到可以一眼看完。
 */
function mergeWith(
  base: string,
  mine: string,
  theirs: string,
  picks?: Record<number, ThreeWaySuggestion | 'drop'>
): string {
  const rows = alignThreeWay(base, mine, theirs);
  const mineSlices = topLevelBlockSlices(mine);
  const theirsSlices = topLevelBlockSlices(theirs);

  const blocks: string[] = [];
  rows.forEach((row, index) => {
    const pick = picks?.[index] ?? row.suggestion;
    if (pick === 'drop') return;
    if (pick === 'both') {
      if (row.mineIndex !== null) blocks.push(mineSlices[row.mineIndex]!.text);
      if (row.theirsIndex !== null) blocks.push(theirsSlices[row.theirsIndex]!.text);
    } else if (pick === 'mine') {
      if (row.mineIndex !== null) blocks.push(mineSlices[row.mineIndex]!.text);
    } else if (pick === 'theirs') {
      if (row.theirsIndex !== null) blocks.push(theirsSlices[row.theirsIndex]!.text);
    }
  });

  return joinMergedBlocks(blocks, mine);
}

describe('顶层块切片', () => {
  it('与顶层块一一对应', () => {
    const src = doc('# 标题', '正文。', '- a\n- b', '> 引用');
    const slices = topLevelBlockSlices(src);
    const blocks = parseMarkdown(src).root.children;
    expect(slices).toHaveLength(blocks.length);
    for (let i = 0; i < blocks.length; i += 1) {
      expect(slices[i]!.text).toBe(blocks[i]!.raw.trimEnd());
    }
  });

  it('去掉尾随空白：块间空行不属于任何块', () => {
    // 这条是「为什么不能直接 join(raw)」的核心：块间那个 `\n\n` 谁也不带。
    const slices = topLevelBlockSlices(doc('# A', 'B'));
    expect(slices.map((s) => s.text)).toEqual(['# A', 'B']);
  });

  it('空文档与纯空白文档都没有块', () => {
    expect(topLevelBlockSlices('')).toEqual([]);
    expect(topLevelBlockSlices('   \n')).toEqual([]);
    expect(topLevelBlockSlices('\n\n')).toEqual([]);
  });

  it('偏移落在原文上', () => {
    const src = doc('# 标题', '正文一段。');
    for (const slice of topLevelBlockSlices(src)) {
      expect(src.slice(slice.from, slice.to).trimEnd()).toBe(slice.text);
    }
  });
});

describe('合并结果重建', () => {
  const LONG_BASE = '这一段说明讲的是缓存策略，以及它在读路径上的取舍。';
  const LONG_MINE = '这一段说明讲的是缓存失效策略，以及它在读路径上的取舍。';
  const LONG_THEIRS = '这一段说明讲的是缓存策略，以及它在写路径上的取舍。';

  it('幂等：两侧完全一致时输出与输入逐字节相同（LF）', () => {
    const src = doc('# 标题', LONG_BASE, '- a\n- b', '> 引用');
    expect(mergeWith(src, src, src)).toBe(src);
  });

  it('幂等：CRLF 文档保持 CRLF', () => {
    const src = '# 标题\r\n\r\n正文。\r\n';
    expect(mergeWith(src, src, src)).toBe(src);
  });

  it('幂等：没有尾换行的文档不凭空补一个', () => {
    const src = '# 标题\n\n正文。';
    expect(mergeWith(src, src, src)).toBe(src);
  });

  it('各改一块 → 两块都取到，其余保持', () => {
    const base = doc('# 标题', LONG_BASE, '保持不动。', LONG_THEIRS);
    const mine = doc('# 标题', LONG_MINE, '保持不动。', LONG_THEIRS);
    const theirs = doc('# 标题', LONG_BASE, '保持不动。', '这一段说明讲的是缓存策略，以及它在删除路径上的取舍。');
    const merged = mergeWith(base, mine, theirs);
    expect(merged).toContain('缓存失效策略');
    expect(merged).toContain('删除路径');
    expect(merged).toContain('保持不动。');
  });

  it('尾部纯追加 → 结果等于追加后的那份', () => {
    // 曾有一个版本在这里丢掉追加块前的空行 —— 规范化之后不会了，钉住它。
    const base = doc('# 标题', '正文。');
    const appended = doc('# 标题', '正文。', '新加的一段。');
    expect(mergeWith(base, base, appended)).toBe(appended);
  });

  it('用户改选 → 结果跟着变（建议只是预选）', () => {
    const base = doc(LONG_BASE);
    const mine = doc(LONG_MINE);
    const theirs = doc(LONG_THEIRS);
    // 冲突行默认不定；显式选磁盘。
    expect(mergeWith(base, mine, theirs, { 0: 'theirs' })).toContain('写路径');
    expect(mergeWith(base, mine, theirs, { 0: 'mine' })).toContain('失效');
  });

  it('drop → 该块从结果里消失', () => {
    const base = doc('# 标题', '会被丢弃。');
    const merged = mergeWith(base, base, base, { 1: 'drop' });
    expect(merged).not.toContain('会被丢弃');
    expect(merged).toContain('# 标题');
  });

  it('两侧各自新增不同内容 → both 都留下，一个字节都不丢', () => {
    const base = doc('锚点。');
    const mine = doc('锚点。', '我加的一段。');
    const theirs = doc('锚点。', '他加的一段。');
    const merged = mergeWith(base, mine, theirs);
    expect(merged).toContain('我加的一段');
    expect(merged).toContain('他加的一段');
  });

  it('规范化空白：三空行被规整成一个空行（显式合并的已知代价）', () => {
    const base = doc('# A', 'B');
    const three = '# A\n\n\n\nB\n';
    expect(mergeWith(three, three, three)).toBe(base);
  });

  it('重建是只读的：不碰序列化路径，往返不变量仍成立', () => {
    const src = doc('# 标题', LONG_BASE, '- a\n- b');
    mergeWith(src, src, doc(LONG_MINE));
    expect(serializeMarkdown(parseMarkdown(src))).toBe(src);
  });
});
