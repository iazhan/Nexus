// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import {
  UI_ZOOM_DEFAULT,
  UI_ZOOM_OPTIONS,
  UI_ZOOM_STORAGE_KEY,
  applyStoredUiZoom,
  parseUiZoom,
  readStoredUiZoom,
  uiZoomFactor
} from '../../preload/ui-zoom.js';

/**
 * 界面缩放的取值口径（`preload/ui-zoom.ts`）。
 *
 * 这一层为什么要单测：那份规则**有两个消费者**（preload 在首帧之前应用、renderer 渲染设置页），
 * 而它的失败模式不是「报错」而是「窗口变成没法操作的样子」—— 存档里一个 `1000` 就是 10 倍缩放，
 * 用户连设置窗口都看不清，也就改不回来。所以「认不出的值一律回落」这条要有判据。
 */

/** 只用到 `localStorage` 的假窗口。`getItem` 抛错的那一种用来模拟存储被禁用。 */
function windowWith(getItem: () => string | null): Window {
  return { localStorage: { getItem } } as unknown as Window;
}

describe('parseUiZoom', () => {
  it('档位原样返回', () => {
    for (const value of UI_ZOOM_OPTIONS) {
      expect(parseUiZoom(value)).toBe(value);
    }
  });

  it('两侧空白也认', () => {
    expect(parseUiZoom(' 125 ')).toBe('125');
  });

  it('空、缺、越界、乱码一律回落到默认档位', () => {
    // `1000` 是这里唯一真正危险的输入：放过去就是 10 倍缩放，窗口没法用了。
    for (const raw of ['', '   ', null, undefined, '1000', '0', '-100', '125.5', 'auto', 'abc']) {
      expect(parseUiZoom(raw)).toBe(UI_ZOOM_DEFAULT);
    }
  });
});

describe('uiZoomFactor', () => {
  it('百分数换成倍率', () => {
    expect(uiZoomFactor('100')).toBe(1);
    expect(uiZoomFactor('125')).toBe(1.25);
    expect(uiZoomFactor('80')).toBe(0.8);
  });

  it('越界值先回落再换算，不会算出 10 倍', () => {
    expect(uiZoomFactor('1000')).toBe(1);
  });
});

describe('readStoredUiZoom', () => {
  it('读得到就用存档里的档位', () => {
    expect(readStoredUiZoom(windowWith(() => '150'))).toBe('150');
  });

  it('存储不可用（隐私模式 / CSP）按默认值走，不抛', () => {
    // 首帧之前抛错会让整个窗口起不来 —— 缩放读不到就按 100% 画，是唯一可接受的结果。
    const throwing = windowWith(() => {
      throw new Error('denied');
    });
    expect(readStoredUiZoom(throwing)).toBe(UI_ZOOM_DEFAULT);
  });
});

describe('applyStoredUiZoom', () => {
  it('把存档里的档位换算成倍率交给注入的 applier', () => {
    const setZoomFactor = vi.fn();
    applyStoredUiZoom(windowWith(() => '125'), setZoomFactor);

    expect(setZoomFactor).toHaveBeenCalledTimes(1);
    expect(setZoomFactor).toHaveBeenCalledWith(1.25);
  });

  it('存档是坏值时应用默认倍率', () => {
    const setZoomFactor = vi.fn();
    applyStoredUiZoom(windowWith(() => '1000'), setZoomFactor);

    expect(setZoomFactor).toHaveBeenCalledWith(1);
  });
});

describe('存档键', () => {
  it('与设置页读写的是同一个键', () => {
    // 这条是「两个消费者共用一份口径」的最小判据：键名对不上时，preload 读的是空值，
    // 表现为「设置页显示 125%，窗口却是 100%」。
    expect(UI_ZOOM_STORAGE_KEY).toBe('nexus-ui-zoom');
  });
});
