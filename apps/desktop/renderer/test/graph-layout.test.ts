import { describe, it, expect } from 'vitest';
import type { WorkspaceGraph } from '@nexus/core';
import { layoutGraph } from '../src/workspace/graph-layout.js';

const SIZE = { width: 400, height: 300 };

function makeGraph(nodeIds: number[], edges: Array<[number, number]>): WorkspaceGraph {
  return {
    nodes: nodeIds.map((id) => ({
      id,
      path: `/vault/doc-${id}.md`,
      relativePath: `doc-${id}.md`,
      name: `doc-${id}.md`,
      degree: 0
    })),
    edges: edges.map(([source, target]) => ({ source, target }))
  };
}

describe('图谱布局', () => {
  it('空图返回空数组', () => {
    expect(layoutGraph(makeGraph([], []), SIZE)).toEqual([]);
  });

  it('每个节点都拿到坐标，id 原样保留', () => {
    const result = layoutGraph(makeGraph([7, 8, 9], []), SIZE);
    expect(result.map((node) => node.id).sort((a, b) => a - b)).toEqual([7, 8, 9]);
  });

  it('坐标落在画布内', () => {
    const result = layoutGraph(makeGraph([1, 2, 3, 4, 5], [[1, 2]]), SIZE);

    for (const node of result) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(SIZE.width);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(SIZE.height);
    }
  });

  it('确定性 —— 同样的输入两次得到同样的坐标', () => {
    const input = makeGraph([1, 2, 3, 4], [[1, 2], [2, 3]]);
    expect(layoutGraph(input, SIZE)).toEqual(layoutGraph(input, SIZE));
  });

  it('有边相连的节点比无关节点更近', () => {
    // 1—2 相连，3 孤立
    const result = layoutGraph(makeGraph([1, 2, 3], [[1, 2]]), { width: 600, height: 600 });
    const byId = new Map(result.map((node) => [node.id, node]));
    const distance = (a: number, b: number) =>
      Math.hypot(byId.get(a)!.x - byId.get(b)!.x, byId.get(a)!.y - byId.get(b)!.y);

    expect(distance(1, 2)).toBeLessThan(distance(1, 3));
  });

  it('单节点不会崩', () => {
    const result = layoutGraph(makeGraph([1], []), SIZE);
    expect(result).toHaveLength(1);
    expect(Number.isFinite(result[0]!.x)).toBe(true);
    expect(Number.isFinite(result[0]!.y)).toBe(true);
  });

  it('边指向不存在的节点时被忽略，其余布局照常', () => {
    const result = layoutGraph(makeGraph([1, 2], [[1, 999]]), SIZE);

    expect(result).toHaveLength(2);
    expect(result.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });

  it('孤立节点的图也不产生 NaN（全部重合时的分支）', () => {
    const result = layoutGraph(makeGraph([1, 2, 3], []), SIZE);
    expect(result.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });
});
