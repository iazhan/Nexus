import { describe, it, expect } from 'vitest';
import { fuzzyMatch, rankByFuzzy } from '../src/workspace/fuzzy.js';

describe('模糊匹配', () => {
  it('子序列命中，不要求连续', () => {
    expect(fuzzyMatch('ndma', 'notes/dma.md')).not.toBeNull();
  });

  it('顺序不对就命中不了', () => {
    expect(fuzzyMatch('amdb', 'dma.md')).toBeNull();
  });

  it('缺少字符就命中不了', () => {
    expect(fuzzyMatch('dmaz', 'dma.md')).toBeNull();
  });

  it('大小写不敏感', () => {
    expect(fuzzyMatch('DMA', 'dma.md')).not.toBeNull();
  });

  it('空查询匹配一切，得分为 0', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] });
  });

  it('返回命中位置，供 UI 高亮', () => {
    expect(fuzzyMatch('dma', 'dma.md')!.positions).toEqual([0, 1, 2]);
  });

  it('连续命中比零散命中得分高', () => {
    const consecutive = fuzzyMatch('dma', 'dma.md')!;
    const scattered = fuzzyMatch('dma', 'd-m-a-x.md')!;
    expect(consecutive.score).toBeGreaterThan(scattered.score);
  });

  it('短目标排在长路径前面', () => {
    const ranked = rankByFuzzy('dma', ['notes/archive/dma-old.md', 'dma.md'], (item) => item);
    expect(ranked[0]!.item).toBe('dma.md');
  });

  it('命中不了的被过滤掉', () => {
    expect(rankByFuzzy('xyz', ['a.md', 'b.md'], (item) => item)).toEqual([]);
  });

  it('结果数量受 limit 限制', () => {
    const items = Array.from({ length: 60 }, (_, index) => `file-${index}.md`);
    expect(rankByFuzzy('file', items, (item) => item, 10)).toHaveLength(10);
  });
});
