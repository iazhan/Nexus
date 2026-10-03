import { describe, expect, it } from 'vitest';
import {
  BASE_SCALE,
  clampZoom,
  fitWidthZoom,
  flattenOutline,
  pageAtScrollOffset,
  pageFractionAt,
  scrollOffsetForPage,
  scrollTopForAnchor,
  stepZoom,
  wheelZoomFactor,
  zoomPercent,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP
} from '../src/viewer/pdf/pdf-layout.js';

describe('PDF 缩放', () => {
  it('夹在区间内，非有限数回落到 100%', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.05)).toBe(ZOOM_MIN);
    expect(clampZoom(99)).toBe(ZOOM_MAX);
    // NaN / Infinity 是算错了的产物，会让 canvas 的宽高变成 0 —— 不抛错，只是整页变白
    expect(clampZoom(Number.NaN)).toBe(ZOOM_DEFAULT);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(ZOOM_DEFAULT);
    // 有限的越界值是「想再小一点」的意图，夹紧而不是跳回 100%
    expect(clampZoom(0)).toBe(ZOOM_MIN);
  });

  it('走一档，且到顶/到底时停住', () => {
    expect(stepZoom(1, 1)).toBe(1 + ZOOM_STEP);
    expect(stepZoom(1, -1)).toBe(1 - ZOOM_STEP);
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
  });

  it('连走三档不攒浮点误差 —— 攒了会让「到顶了没有」的等号失灵', () => {
    // 起点用字面量 0.5 而不是 ZOOM_MIN：`0.5 + 0.25 × 3` 在二进制里会算成
    // 1.2499999999999998，正是这条要抓的错。它与缩放下限取多少无关。
    let scale = 0.5;
    for (let i = 0; i < 3; i += 1) scale = stepZoom(scale, 1);
    expect(scale).toBe(1.25);
    expect(String(scale)).not.toContain('999');
  });

  it('百分比四舍五入到整数，且不带百分号', () => {
    // 不带 `%`：这个串直接当输入框的 value，符号画在框外，塞进 value 用户每次改数字都要先删它
    expect(zoomPercent(1)).toBe('100');
    expect(zoomPercent(0.75)).toBe('75');
    // 夹过之后才格式化：超界的值显示成 300 而不是 900
    expect(zoomPercent(9)).toBe('300');
  });

  it('适合宽度：按 100% 的像素宽比', () => {
    // 页宽 400pt × 1.5 = 600px；容器 300px → 0.5
    expect(fitWidthZoom(400, 300)).toBe(0.5);
    // 容器很宽时不能超过上限
    expect(fitWidthZoom(100, 5000)).toBe(ZOOM_MAX);
    // 量不出来时回落 100%，不是回落到区间端点
    expect(fitWidthZoom(0, 300)).toBe(ZOOM_DEFAULT);
    expect(fitWidthZoom(400, 0)).toBe(ZOOM_DEFAULT);
    expect(BASE_SCALE).toBeGreaterThan(1);
  });
});

describe('滚轮缩放', () => {
  it('向上滚放大、向下滚缩小，且滚回去必然回到原处', () => {
    expect(wheelZoomFactor(-100)).toBeCloseTo(1.1052, 3);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    // 指数形式才有这个性质。加法做不到：滚到顶被夹住之后再滚回来，回不到原值。
    expect(wheelZoomFactor(-100) * wheelZoomFactor(100)).toBeCloseTo(1, 12);
    expect(wheelZoomFactor(-200)).toBeCloseTo(wheelZoomFactor(-100) ** 2, 12);
  });

  it('非有限增量不缩放 —— NaN 进了 canvas.width 就是把画布设成 0', () => {
    expect(wheelZoomFactor(Number.NaN)).toBe(1);
    expect(wheelZoomFactor(Number.POSITIVE_INFINITY)).toBe(1);
    expect(wheelZoomFactor(0)).toBe(1);
  });
});

describe('滚轮缩放的锚点', () => {
  // 两页、中间 16px 间隙：内容坐标 0–100 是第 1 页，116–216 是第 2 页
  const spans = [
    { pageNumber: 1, top: 0, height: 100 },
    { pageNumber: 2, top: 116, height: 100 }
  ];

  it('落在页内时给出页号与相对位置', () => {
    expect(pageFractionAt(spans, 0)).toEqual({ pageNumber: 1, fraction: 0 });
    expect(pageFractionAt(spans, 25)).toEqual({ pageNumber: 1, fraction: 0.25 });
    expect(pageFractionAt(spans, 166)).toEqual({ pageNumber: 2, fraction: 0.5 });
  });

  it('页的下边界属于下一页：100 在间隙里、116 是第 2 页的页首', () => {
    expect(pageFractionAt(spans, 99.9)?.pageNumber).toBe(1);
    expect(pageFractionAt(spans, 116)).toEqual({ pageNumber: 2, fraction: 0 });
  });

  it('落在页与页之间的间隙里时取上面那一页，相对位置夹到 1', () => {
    // 不兜底的话，光标恰好压在间隙上的那一次滚轮会完全不平移 —— 看起来像卡了一下
    expect(pageFractionAt(spans, 100)).toEqual({ pageNumber: 1, fraction: 1 });
    expect(pageFractionAt(spans, 110)).toEqual({ pageNumber: 1, fraction: 1 });
  });

  it('落在整列上方的留白里时取第 1 页且夹到 0', () => {
    expect(pageFractionAt(spans, -50)).toEqual({ pageNumber: 1, fraction: 0 });
  });

  it('量不到任何一页时返回 null，交给调用方退回「对齐到当前页」', () => {
    expect(pageFractionAt([], 10)).toBeNull();
    // 高度为 0 的页不能参与 —— 未渲染的页量出来就是 0，拿它算相对位置会得到 Infinity
    expect(pageFractionAt([{ pageNumber: 1, top: 0, height: 0 }], 10)).toBeNull();
  });

  it('按缩放后的实测几何算滚动位置', () => {
    // 第 2 页从 216 开始、高 200，0.5 处是 316；光标在视口内 100 处 → 滚到 216
    expect(scrollTopForAnchor(216, 200, 0.5, 100)).toBe(216);
    expect(scrollTopForAnchor(500, 400, 0.75, 150)).toBe(650);
  });

  it('不变量：算出来的滚动位置让那一相对位置正好落在光标的 y 上', () => {
    const cursorOffset = 150;
    const scrollTop = scrollTopForAnchor(500, 400, 0.75, cursorOffset);
    // 页顶在视口里的位置 = pageTop − scrollTop；再往下走 fraction × 页高 就应当补到光标处
    expect(500 - scrollTop + 0.75 * 400).toBe(cursorOffset);
  });

  it('负结果夹到 0 —— 滚动位置没有负数，流出去会被调用方拿去做算术', () => {
    expect(scrollTopForAnchor(0, 100, 0.5, 400)).toBe(0);
  });

  it('非有限输入回落到 0，不把 NaN 写进 scrollTop', () => {
    expect(scrollTopForAnchor(0, 200, Number.NaN, 100)).toBe(0);
  });
});

describe('连续滚动的当前页', () => {
  const offsets = [0, 800, 1600, 2400];

  it('取第一个还没越过的页', () => {
    expect(pageAtScrollOffset(offsets, 0)).toBe(1);
    expect(pageAtScrollOffset(offsets, 700)).toBe(1);
    expect(pageAtScrollOffset(offsets, 800)).toBe(2);
    expect(pageAtScrollOffset(offsets, 2000)).toBe(3);
    expect(pageAtScrollOffset(offsets, 99999)).toBe(4);
  });

  it('余量把「刚露头的下一页」也算进来', () => {
    // scrollTop=790 时页 2 的顶边（800）已经落在视口余量里 → 算第 2 页
    expect(pageAtScrollOffset(offsets, 790, 24)).toBe(2);
    // 余量收到 0：页 2 的顶边还在视口下方，仍算第 1 页
    expect(pageAtScrollOffset(offsets, 790, 0)).toBe(1);
    expect(pageAtScrollOffset(offsets, 800, 0)).toBe(2);
  });

  it('没有页时返回 1，而不是 0', () => {
    expect(pageAtScrollOffset([], 500)).toBe(1);
  });

  it('滚进视野的位置留了顶部空白', () => {
    expect(scrollOffsetForPage(800)).toBe(792);
    // 第 1 页不能算出负数
    expect(scrollOffsetForPage(0)).toBe(0);
  });
});

describe('PDF 大纲拍平', () => {
  it('按层级拍平，depth 从 0 起', () => {
    const entries = flattenOutline([
      { title: '第一章', dest: ['ref1'], items: [{ title: '1.1', dest: ['ref2'] }] },
      { title: '第二章', dest: ['ref3'] }
    ]);

    expect(entries.map((entry) => [entry.title, entry.depth])).toEqual([
      ['第一章', 0],
      ['1.1', 1],
      ['第二章', 0]
    ]);
  });

  it('丢掉没有标题、或只有外链的条目', () => {
    const entries = flattenOutline([
      { title: '   ', dest: ['ref1'] },
      { title: '外链', url: 'https://example.com' },
      { title: '正常', dest: ['ref2'] }
    ]);

    expect(entries.map((entry) => entry.title)).toEqual(['正常']);
  });

  it('父节点被丢掉时子树仍然保留 —— 否则大纲会凭空少一段', () => {
    const entries = flattenOutline([
      { title: '', dest: null, items: [{ title: '子项', dest: ['ref1'] }] }
    ]);

    expect(entries).toEqual([{ title: '子项', depth: 1, dest: ['ref1'] }]);
  });

  it('深度超限的子树不再展开 —— 递归栈溢出会让「打开这份 PDF 就白屏」', () => {
    const deep = { title: '根', dest: ['r'], items: [] as unknown[] };
    let cursor = deep;
    for (let i = 0; i < 30; i += 1) {
      const child = { title: `第 ${i} 层`, dest: ['r'], items: [] as unknown[] };
      cursor.items.push(child);
      cursor = child;
    }

    const entries = flattenOutline([deep]);
    // 根 + 7 层，到上限就停
    expect(entries.length).toBeLessThanOrEqual(8);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('null / 非数组入参返回空表', () => {
    expect(flattenOutline(null)).toEqual([]);
    expect(flattenOutline(undefined)).toEqual([]);
    expect(flattenOutline([])).toEqual([]);
  });
});
