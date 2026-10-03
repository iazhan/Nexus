import { describe, expect, it } from 'vitest';
import { fitZoom, ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN } from '../src/viewer/zoom.js';

/**
 * 「适合窗口」的判据是**宽高同时放得下**，不是「按宽度铺满」。
 *
 * 两者的差别只在长图上，所以 fixture 里必须有一张长图 —— 全用 4:3 的照片时两者算出来
 * 一模一样，这条约束就测不出来。
 *
 * `clampZoom` / `stepZoom` / `zoomPercent` / `wheelZoomFactor` 的用例仍在
 * `pdf-layout.test.ts`：实现搬到了 `viewer/zoom.ts`，但那几条断言的所在位置没有跟着搬
 * （它们测的是 PDF 侧的入口，转出后仍然有效）。
 */
describe('fitZoom（适合窗口）', () => {
  it('取宽高两个比例里更小的那个', () => {
    // 4000×800 的宽图：宽受限（1000/4000 = 0.25 < 600/800 = 0.75）
    expect(fitZoom(4000, 800, 1000, 600)).toBe(0.25);
    // 800×4000 的长图：高受限（600/4000 = 0.15 < 1000/800 = 1.25）
    expect(fitZoom(800, 4000, 1000, 600)).toBe(0.15);
  });

  it('长图算出来低于 50% —— 下限若留在 0.5，「适合窗口」就等于失效', () => {
    // 4000×3000 的照片放进 1200×700 的内容区：min(0.3, 0.2333…) = 0.2333…
    const scale = fitZoom(4000, 3000, 1200, 700);
    expect(scale).toBeLessThan(0.5);
    expect(scale).toBeGreaterThan(ZOOM_MIN);
  });

  it('不变量：算出的缩放下，宽和高都不超过容器', () => {
    const cases: ReadonlyArray<readonly [number, number, number, number]> = [
      [4000, 3000, 1200, 700],
      [800, 4000, 1000, 600],
      [200, 100, 1000, 600],
      [1920, 1080, 1200, 700]
    ];
    for (const [width, height, availableWidth, availableHeight] of cases) {
      const scale = fitZoom(width, height, availableWidth, availableHeight);
      expect(width * scale).toBeLessThanOrEqual(availableWidth + 1e-9);
      expect(height * scale).toBeLessThanOrEqual(availableHeight + 1e-9);
    }
  });

  it('小图不会放到超过上限 —— 一个 10px 的图标铺满窗口没有意义', () => {
    expect(fitZoom(10, 10, 5000, 5000)).toBe(ZOOM_MAX);
  });

  it('量不出来时回落 100%，不是回落到区间端点', () => {
    expect(fitZoom(0, 100, 1000, 600)).toBe(ZOOM_DEFAULT);
    expect(fitZoom(100, 0, 1000, 600)).toBe(ZOOM_DEFAULT);
    expect(fitZoom(100, 100, 0, 600)).toBe(ZOOM_DEFAULT);
    expect(fitZoom(100, 100, 1000, 0)).toBe(ZOOM_DEFAULT);
    expect(fitZoom(Number.NaN, 100, 1000, 600)).toBe(ZOOM_DEFAULT);
  });
});
