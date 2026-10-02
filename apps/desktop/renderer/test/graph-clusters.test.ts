// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  CLUSTER_TOKENS,
  LEGEND_MAX_ROWS,
  UNCLUSTERED_TOKEN,
  assignClusterSlots,
  clusterOf,
  rankClusters
} from '../src/workspace/graph-clusters.js';

/**
 * 图谱分区：谁和谁一类、谁拿哪个颜色。
 *
 * 这一层的错法**在画面上看不出来** —— 两个分区共用一个颜色，用户只会以为
 * 「这两个目录是一伙的」，而图例正指着两个同样的色块。所以「不撞色」是这里的核心判据。
 *
 * `apps/desktop/renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

describe('图谱分区', () => {
  describe('clusterOf', () => {
    it('取顶层目录名', () => {
      expect(clusterOf('notes/a.md')).toBe('notes');
      // 只取**顶层**：再深的目录不再细分，否则分区数会爆炸
      expect(clusterOf('notes/deep/deeper/a.md')).toBe('notes');
    });

    it('根目录下的文档没有分区', () => {
      expect(clusterOf('a.md')).toBeNull();
      expect(clusterOf('')).toBeNull();
    });

    it('反斜杠当分隔符', () => {
      expect(clusterOf('notes\\a.md')).toBe('notes');
    });

    it('以分隔符开头时没有分区名（不是「空名字的分区」）', () => {
      expect(clusterOf('/a.md')).toBeNull();
    });
  });

  describe('rankClusters', () => {
    it('按文档数降序，同数按名字', () => {
      const ranked = rankClusters(
        new Map([
          ['b', 1],
          ['a', 1],
          ['big', 9]
        ])
      );

      expect(ranked).toEqual(['big', 'a', 'b']);
    });
  });

  describe('assignClusterSlots', () => {
    const countsOf = (entries: Array<[string, number]>) => new Map(entries);

    it('不超过调色板大小时每个分区拿到**互不相同**的槽位', () => {
      // 这条是核心：撞色会让图例说谎
      const counts = countsOf(
        CLUSTER_TOKENS.map((_, index) => [`c${index}`, CLUSTER_TOKENS.length - index])
      );
      const slots = assignClusterSlots(counts);

      const assigned = [...slots.values()];
      expect(assigned).toHaveLength(CLUSTER_TOKENS.length);
      expect(new Set(assigned).size).toBe(CLUSTER_TOKENS.length);
      expect(assigned.every((slot) => slot !== null)).toBe(true);
    });

    it('超出调色板的分区共用中性色（`null`），**不复用**前面的槽位', () => {
      // 复用会让图例出现两个同样的色块，而它们属于不同的目录
      const counts = countsOf(
        Array.from({ length: CLUSTER_TOKENS.length + 3 }, (_, index) => [
          `c${index}`,
          CLUSTER_TOKENS.length + 3 - index
        ])
      );
      const slots = assignClusterSlots(counts);

      const assigned = [...slots.values()];
      expect(assigned.slice(0, CLUSTER_TOKENS.length)).toEqual(
        CLUSTER_TOKENS.map((_, index) => index)
      );
      expect(assigned.slice(CLUSTER_TOKENS.length)).toEqual([null, null, null]);
    });

    it('确定：同一份输入两次得到同一张表', () => {
      const counts = countsOf([
        ['b', 2],
        ['a', 2]
      ]);
      expect([...assignClusterSlots(counts)]).toEqual([...assignClusterSlots(counts)]);
    });

    it('空输入给空表', () => {
      expect(assignClusterSlots(new Map()).size).toBe(0);
    });

    it('图例行数与调色板同宽 —— 否则图例会列出画面上没有的颜色', () => {
      expect(LEGEND_MAX_ROWS).toBe(CLUSTER_TOKENS.length);
    });

    it('中性色与调色板不是同一个 token', () => {
      expect(CLUSTER_TOKENS as readonly string[]).not.toContain(UNCLUSTERED_TOKEN);
    });
  });
});
