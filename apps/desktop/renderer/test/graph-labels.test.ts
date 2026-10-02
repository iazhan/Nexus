// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  clampToWidth,
  planGraphLabels,
  type GraphLabelCandidate
} from '../src/workspace/graph-labels.js';

/**
 * 标签避让布局。
 *
 * 判据必须**正反两面**：「任意两个标签不相交」对「一个标签都不画」同样成立 ——
 * 而「全丢」正是实现里最容易出现的错法（碰撞判定写反、或者过滤条件写成了恒真）。
 * 所以每条避让断言都配一条「空间够时标签必须全在」。
 *
 * `apps/desktop/renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

/** 等宽字体：每个字符 6px。让「宽度」在断言里可算，不必依赖真实字体度量。 */
const measure = (text: string) => text.length * 6;

const VIEWPORT = { width: 400, height: 300 };

function candidate(overrides: Partial<GraphLabelCandidate> & { id: number }): GraphLabelCandidate {
  return {
    screenX: 200,
    screenY: 150,
    radiusPx: 3,
    text: `n${overrides.id}`,
    isActive: false,
    degree: 0,
    ...overrides
  };
}

const plan = (candidates: GraphLabelCandidate[], maxLabels = 40) =>
  planGraphLabels({
    candidates,
    viewport: VIEWPORT,
    maxLabels,
    maxLabelWidthPx: 120,
    measureTextWidth: measure
  });

const intersects = (
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number }
) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe('图谱标签避让', () => {
  it('没有候选时返回空数组', () => {
    expect(plan([])).toEqual([]);
  });

  it('视口或上限不合法时直接返回空数组', () => {
    expect(plan([candidate({ id: 1 })], 0)).toEqual([]);
    expect(
      planGraphLabels({
        candidates: [candidate({ id: 1 })],
        viewport: { width: 0, height: 300 },
        maxLabels: 10,
        maxLabelWidthPx: 120,
        measureTextWidth: measure
      })
    ).toEqual([]);
  });

  it('空间够时**每个**候选都拿到标签', () => {
    // 这条是上面所有避让断言的反面。少了它，「碰撞就丢」被写成「全丢」也照样绿。
    const placements = plan([
      candidate({ id: 1, screenX: 60, screenY: 60 }),
      candidate({ id: 2, screenX: 200, screenY: 60 }),
      candidate({ id: 3, screenX: 340, screenY: 60 }),
      candidate({ id: 4, screenX: 60, screenY: 240 }),
      candidate({ id: 5, screenX: 200, screenY: 240 }),
      candidate({ id: 6, screenX: 340, screenY: 240 })
    ]);

    expect(placements.map((p) => p.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('任意两个标签矩形不相交', () => {
    // 挤在一起的一簇：只有一个能占到「正下方」，其余必须换锚点或放弃
    const placements = plan(
      Array.from({ length: 12 }, (_, index) =>
        candidate({ id: index + 1, screenX: 200 + (index % 3) * 6, screenY: 150 + (index % 4) * 5 })
      )
    );

    expect(placements.length).toBeGreaterThan(0);
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        expect(
          intersects(placements[i]!.rect, placements[j]!.rect),
          `标签 ${placements[i]!.text} 与 ${placements[j]!.text} 重叠了`
        ).toBe(false);
      }
    }
  });

  it('标签不会盖住**别的**节点', () => {
    // 目标节点的正下方坐着一个别的点 —— 标签必须换到上面/侧面，而不是压在那个点上
    const placements = plan([
      candidate({ id: 1, screenX: 200, screenY: 100, text: 'target' }),
      candidate({ id: 2, screenX: 200, screenY: 118, radiusPx: 9, text: 'neighbor' })
    ]);

    const target = placements.find((p) => p.id === 1);
    expect(target).toBeTruthy();

    const coversNeighbor =
      target!.rect.left < 200 + 9 &&
      200 - 9 < target!.rect.right &&
      target!.rect.top < 118 + 9 &&
      118 - 9 < target!.rect.bottom;
    expect(coversNeighbor).toBe(false);
  });

  it('留了边距的靠边节点拿得到标签，且不越界', () => {
    // `layoutGraph` 会把节点钳在 `GRAPH_EDGE_PADDING` 之内，所以真实输入里不会出现
    // 圆心贴着 0 的点。这里按那个下界造最外侧的点。
    const placements = plan([
      candidate({ id: 1, screenX: 14, screenY: 14 }),
      candidate({ id: 2, screenX: 386, screenY: 286 }),
      candidate({ id: 3, screenX: 14, screenY: 286 }),
      candidate({ id: 4, screenX: 386, screenY: 14 })
    ]);

    expect(placements).toHaveLength(4);
    for (const placement of placements) {
      expect(placement.rect.left).toBeGreaterThanOrEqual(0);
      expect(placement.rect.top).toBeGreaterThanOrEqual(0);
      expect(placement.rect.right).toBeLessThanOrEqual(VIEWPORT.width);
      expect(placement.rect.bottom).toBeLessThanOrEqual(VIEWPORT.height);
    }
  });

  it('极端角落（圆心正好在 0,0）时宁可**不画**，也绝不画出界', () => {
    // 四个锚点全部越界时唯一的正确结果是放弃。写成「钳进视口再画」的话标签会飘到
    // 离节点很远的地方，用户会把标签认成别的点。
    const placements = plan([candidate({ id: 1, screenX: 0, screenY: 0 })]);

    for (const placement of placements) {
      expect(placement.rect.left).toBeGreaterThanOrEqual(0);
      expect(placement.rect.top).toBeGreaterThanOrEqual(0);
    }
  });

  it('超过上限时按重要度截断，活跃文档一定在', () => {
    const candidates = [
      candidate({ id: 1, screenX: 40, screenY: 40 }),
      candidate({ id: 2, screenX: 140, screenY: 40 }),
      candidate({ id: 3, screenX: 240, screenY: 40 }),
      candidate({ id: 4, screenX: 340, screenY: 40 }),
      // 离中心最远，但它是活跃文档 —— 必须挤进来
      candidate({ id: 5, screenX: 380, screenY: 280, isActive: true })
    ];

    const placements = plan(candidates, 2);

    expect(placements).toHaveLength(2);
    expect(placements.map((p) => p.id)).toContain(5);
    expect(placements.find((p) => p.id === 5)!.isActive).toBe(true);
  });

  it('同一份输入两次调用结果完全一致（布局必须确定性）', () => {
    const candidates = Array.from({ length: 10 }, (_, index) =>
      candidate({ id: index + 1, screenX: 50 + index * 30, screenY: 150 })
    );

    expect(plan(candidates)).toEqual(plan(candidates));
  });

  it('文本左上角落在自己的矩形内 —— 画的时候不会飘到别处', () => {
    const placements = plan([candidate({ id: 1, text: 'dma' })]);
    const placement = placements[0]!;

    expect(placement.textX).toBeGreaterThan(placement.rect.left);
    expect(placement.textY).toBeGreaterThan(placement.rect.top);
    expect(placement.textX).toBeLessThan(placement.rect.right);
    expect(placement.textY).toBeLessThan(placement.rect.bottom);
  });
});

describe('标签文本截断', () => {
  it('放得下就原样返回', () => {
    expect(clampToWidth('dma', 120, measure)).toBe('dma');
  });

  it('放不下就截断成 `…`，且截断后确实放得下', () => {
    const clamped = clampToWidth('very-long-document-name.md', 42, measure);

    expect(clamped.endsWith('…')).toBe(true);
    expect(measure(clamped)).toBeLessThanOrEqual(42);
    expect(clamped.length).toBeLessThan('very-long-document-name.md'.length);
  });

  it('截断保留的是**前部** —— 区分度在前部', () => {
    expect(clampToWidth('dma-性能-测试', 42, measure).startsWith('dma')).toBe(true);
  });

  it('连 `…` 都放不下时返回空串，而不是硬塞一个字符', () => {
    expect(clampToWidth('dma', 3, measure)).toBe('');
    expect(clampToWidth('dma', 0, measure)).toBe('');
  });

  it('空文本返回空串', () => {
    expect(clampToWidth('   ', 120, measure)).toBe('');
    expect(clampToWidth('', 120, measure)).toBe('');
  });
});
