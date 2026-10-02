import { describe, it, expect } from 'vitest';
import type { WorkspaceGraph } from '@nexus/core';
import {
  DEFAULT_ITERATIONS,
  GRAPH_EDGE_PADDING,
  iterationsForNodeCount,
  layoutGraph
} from '../src/workspace/graph-layout.js';

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

/**
 * 迭代次数按节点数收缩。
 *
 * 斥力是 O(n²)，800 个节点跑满 300 次迭代实测 451ms —— 肉眼可见的卡死。
 * 真实工作区（~100 篇）只有 8ms，所以这个收缩平时不生效，它是给大库兜底的。
 */
describe('布局迭代预算', () => {
  it('小图跑满上限', () => {
    expect(iterationsForNodeCount(10)).toBe(DEFAULT_ITERATIONS);
    expect(iterationsForNodeCount(100)).toBe(DEFAULT_ITERATIONS);
    expect(iterationsForNodeCount(200)).toBe(DEFAULT_ITERATIONS);
  });

  it('节点一多就往下压', () => {
    // 与实测对齐：n=800 压到两位数（451ms → 约 130ms）
    const at800 = iterationsForNodeCount(800);
    expect(at800).toBeLessThan(DEFAULT_ITERATIONS);
    expect(at800).toBeGreaterThanOrEqual(40);
    // 单调：节点越多，迭代越少
    expect(iterationsForNodeCount(1600)).toBeLessThan(at800);
  });

  it('有下限，不会退化成只画个圆环', () => {
    // 只跑几次迭代的图基本还是初始圆环的形状，没有可读性
    expect(iterationsForNodeCount(1_000_000)).toBeGreaterThanOrEqual(40);
  });

  it('空图与非法输入回到默认值', () => {
    expect(iterationsForNodeCount(0)).toBe(DEFAULT_ITERATIONS);
    expect(iterationsForNodeCount(-5)).toBe(DEFAULT_ITERATIONS);
    expect(iterationsForNodeCount(Number.NaN)).toBe(DEFAULT_ITERATIONS);
  });

  it('按节点数传进去时结果与不传一致 —— 小图上不该有任何差别', () => {
    const graph = makeGraph([1, 2, 3, 4], [[1, 2], [2, 3]]);
    const implicit = layoutGraph(graph, SIZE);
    const explicit = layoutGraph(graph, {
      ...SIZE,
      iterations: iterationsForNodeCount(graph.nodes.length)
    });

    expect(explicit).toEqual(implicit);
  });
});

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

  it('节点不贴画布边缘 —— 贴边的点会被裁掉一半，标签也放不下', () => {
    const result = layoutGraph(makeGraph([1, 2, 3, 4, 5, 6, 7, 8], [[1, 2], [3, 4]]), SIZE);

    for (const node of result) {
      expect(node.x).toBeGreaterThanOrEqual(GRAPH_EDGE_PADDING);
      expect(node.x).toBeLessThanOrEqual(SIZE.width - GRAPH_EDGE_PADDING);
      expect(node.y).toBeGreaterThanOrEqual(GRAPH_EDGE_PADDING);
      expect(node.y).toBeLessThanOrEqual(SIZE.height - GRAPH_EDGE_PADDING);
    }
  });

  it('只有一两个节点时初始圆环也被钳进边距', () => {
    // 迭代里那次钳位只在节点**真的移动**时才执行，而单节点时位移量恒为 0 ——
    // 不在这里再钳一次的话，圆环半径会把点留在画布外（宽 40 时初始 x 会算到 34）。
    const narrow = { width: 40, height: 300 };
    const result = layoutGraph(makeGraph([1], []), narrow);

    expect(result[0]!.x).toBeGreaterThanOrEqual(GRAPH_EDGE_PADDING);
    expect(result[0]!.x).toBeLessThanOrEqual(narrow.width - GRAPH_EDGE_PADDING);
  });

  it('节点不整排贴在画布边上（重心回拉）', () => {
    /*
      4 个节点挤在一条窄画布里。没有重心回拉时，斥力只往外推、没有任何回拉，
      它们会全部漂到底边被钳住 —— 实测是**全部 4 个 y 都等于下边界**，图排成一条水平线。
      所以这条断言必须同时看两件事：纵向真的铺开了，且不是所有点都贴着边。
    */
    const narrow = { width: 240, height: 575 };
    const result = layoutGraph(makeGraph([1, 2, 3, 4], [[1, 2], [2, 3]]), narrow);

    const ys = result.map((node) => node.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(20);

    const onBoundary = result.filter(
      (node) =>
        node.x <= GRAPH_EDGE_PADDING + 0.5 ||
        node.x >= narrow.width - GRAPH_EDGE_PADDING - 0.5 ||
        node.y <= GRAPH_EDGE_PADDING + 0.5 ||
        node.y >= narrow.height - GRAPH_EDGE_PADDING - 0.5
    );
    expect(onBoundary.length).toBeLessThan(result.length);
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
