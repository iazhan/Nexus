// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  IDENTITY_VIEW,
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  fitView,
  panBy,
  projectPoint,
  unprojectPoint,
  zoomAt
} from '../src/workspace/graph-view.js';

/**
 * 画布视图变换（缩放 / 平移）。
 *
 * 这一层必须有单测，因为它的错误**在画面上看不出来**：投影写反了图照样画得出来、
 * 照样好看，只有「点不中」这一个症状，而那很容易被当成「鼠标没对准」。
 * 所以正反两面都要守：投影与反投影互为逆、缩放时锚点不动。
 *
 * `apps/desktop/renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

const close = (actual: number, expected: number, tolerance = 1e-9) =>
  expect(Math.abs(actual - expected)).toBeLessThan(tolerance);

describe('图谱视图变换', () => {
  describe('投影与反投影', () => {
    it('单位视图下是恒等变换', () => {
      expect(projectPoint(IDENTITY_VIEW, 12, 34)).toEqual({ x: 12, y: 34 });
      expect(unprojectPoint(IDENTITY_VIEW, 12, 34)).toEqual({ x: 12, y: 34 });
    });

    it('两者互为逆 —— 任意视图下往返都回到原点', () => {
      // 少了这条，投影写反（比如忘了乘 scale）也能过「投影对不对」的一半断言
      const view = { scale: 2.5, offsetX: -40, offsetY: 17 };
      for (const [x, y] of [
        [0, 0],
        [100, 50],
        [-30, 220]
      ] as const) {
        const screen = projectPoint(view, x, y);
        const back = unprojectPoint(view, screen.x, screen.y);
        close(back.x, x);
        close(back.y, y);
      }
    });
  });

  describe('zoomAt', () => {
    it('锚点下的图坐标在缩放前后落在同一个屏幕位置', () => {
      // 这就是滚轮缩放的**全部要点**：不补偿偏移的话图会往左上角跑，
      // 用户想看清的那个点跑到视野外。
      const before = { scale: 1, offsetX: 0, offsetY: 0 };
      const anchorX = 120;
      const anchorY = 80;
      const target = unprojectPoint(before, anchorX, anchorY);

      const after = zoomAt(before, 1.6, anchorX, anchorY);
      const moved = projectPoint(after, target.x, target.y);

      close(moved.x, anchorX, 1e-6);
      close(moved.y, anchorY, 1e-6);
      expect(after.scale).toBeGreaterThan(before.scale);
    });

    it('缩小方向同样保持锚点', () => {
      const before = { scale: 2, offsetX: -15, offsetY: 30 };
      const target = unprojectPoint(before, 200, 140);

      const after = zoomAt(before, 0.5, 200, 140);
      const moved = projectPoint(after, target.x, target.y);

      close(moved.x, 200, 1e-6);
      close(moved.y, 140, 1e-6);
    });

    it('缩放被夹在上下限之间', () => {
      expect(zoomAt({ scale: 1, offsetX: 0, offsetY: 0 }, 100, 0, 0).scale).toBe(MAX_SCALE);
      expect(zoomAt({ scale: 1, offsetX: 0, offsetY: 0 }, 0.001, 0, 0).scale).toBe(MIN_SCALE);
    });

    it('已经到极限时原样返回，不做无谓的偏移补偿', () => {
      // 补偿本身是浮点运算，到了极限还补偿的话，反复滚轮会让画面缓慢漂移
      const atMax = { scale: MAX_SCALE, offsetX: 7, offsetY: -3 };
      expect(zoomAt(atMax, 2, 50, 50)).toBe(atMax);
      expect(zoomAt({ scale: MIN_SCALE, offsetX: 0, offsetY: 0 }, 0.5, 50, 50).scale).toBe(
        MIN_SCALE
      );
    });
  });

  describe('panBy', () => {
    it('只加偏移，不动缩放', () => {
      const moved = panBy({ scale: 1.5, offsetX: 10, offsetY: 20 }, -4, 6);
      expect(moved).toEqual({ scale: 1.5, offsetX: 6, offsetY: 26 });
    });

    it('返回新对象 —— 原地改会让 React 认不出变化', () => {
      const before = { scale: 1, offsetX: 0, offsetY: 0 };
      expect(panBy(before, 1, 1)).not.toBe(before);
      expect(before).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
    });
  });

  describe('clampScale', () => {
    it('夹在上下限之间', () => {
      expect(clampScale(0.01)).toBe(MIN_SCALE);
      expect(clampScale(100)).toBe(MAX_SCALE);
      expect(clampScale(1.5)).toBe(1.5);
    });

    it('非有限值退回 1 —— NaN 一旦进了 scale，后面每次投影都是 NaN', () => {
      // 退回 **1** 而不是 MAX_SCALE：`fitView` 在「所有点重合」时会算出 Infinity，
      // 那时正确的行为是保持原尺寸，而不是把图放大到上限。
      expect(clampScale(NaN)).toBe(1);
      expect(clampScale(Infinity)).toBe(1);
      expect(clampScale(-Infinity)).toBe(1);
    });
  });

  describe('fitView', () => {
    const viewport = { width: 400, height: 300 };

    it('所有点都落进视口，四周留出 padding', () => {
      const points = [
        { x: 0, y: 0 },
        { x: 200, y: 100 }
      ];
      const view = fitView(points, viewport, 20);

      for (const point of points) {
        const screen = projectPoint(view, point.x, point.y);
        expect(screen.x).toBeGreaterThanOrEqual(20 - 1e-6);
        expect(screen.x).toBeLessThanOrEqual(viewport.width - 20 + 1e-6);
        expect(screen.y).toBeGreaterThanOrEqual(20 - 1e-6);
        expect(screen.y).toBeLessThanOrEqual(viewport.height - 20 + 1e-6);
      }
    });

    it('居中：点集的中心落在视口中心', () => {
      const view = fitView(
        [
          { x: 0, y: 0 },
          { x: 200, y: 100 }
        ],
        viewport,
        20
      );
      const center = projectPoint(view, 100, 50);

      close(center.x, viewport.width / 2, 1e-6);
      close(center.y, viewport.height / 2, 1e-6);
    });

    it('空点集返回单位视图，而不是 NaN 视图', () => {
      expect(fitView([], viewport, 20)).toEqual(IDENTITY_VIEW);
    });

    it('所有点重合时不做除以 0', () => {
      const view = fitView(
        [
          { x: 50, y: 50 },
          { x: 50, y: 50 }
        ],
        viewport,
        20
      );

      expect(Number.isFinite(view.scale)).toBe(true);
      expect(Number.isFinite(view.offsetX)).toBe(true);
      expect(Number.isFinite(view.offsetY)).toBe(true);
      // 重合的点仍应被居中
      close(projectPoint(view, 50, 50).x, viewport.width / 2, 1e-6);
    });

    it('视口为 0 时返回单位视图', () => {
      expect(fitView([{ x: 1, y: 2 }], { width: 0, height: 0 }, 20)).toEqual(IDENTITY_VIEW);
    });

    it('padding 大到吃光可用区域时不产生负数或 NaN', () => {
      const view = fitView(
        [
          { x: 0, y: 0 },
          { x: 100, y: 100 }
        ],
        { width: 40, height: 40 },
        100
      );

      expect(Number.isFinite(view.scale)).toBe(true);
      expect(view.scale).toBeGreaterThanOrEqual(MIN_SCALE);
    });
  });
});
