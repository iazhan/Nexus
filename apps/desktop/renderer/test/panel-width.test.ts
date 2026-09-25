import { describe, it, expect, beforeEach } from 'vitest';
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  clampPanelWidth,
  loadPanelWidth,
  savePanelWidth
} from '../src/workspace/panel-width.js';

/**
 * 侧栏宽度偏好。
 *
 * 重点是**降级**：localStorage 里可能是垃圾值、越界值，甚至写不进去（隐私模式）。
 * 这些情况都不该让面板宽度变成 `NaNpx` —— 那等于宽度 0，表现是「拖一下侧栏就消失了」。
 */
describe('侧栏宽度偏好', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('夹到合法范围', () => {
    expect(clampPanelWidth(100)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(9999)).toBe(PANEL_MAX_WIDTH);
    expect(clampPanelWidth(300)).toBe(300);
  });

  it('非有限数回落到默认值，而不是变成 NaN', () => {
    expect(clampPanelWidth(Number.NaN)).toBe(PANEL_DEFAULT_WIDTH);
    expect(clampPanelWidth(Number.POSITIVE_INFINITY)).toBe(PANEL_DEFAULT_WIDTH);
    expect(clampPanelWidth(Number.NEGATIVE_INFINITY)).toBe(PANEL_DEFAULT_WIDTH);
  });

  it('取整，避免出现小数像素', () => {
    expect(clampPanelWidth(240.6)).toBe(241);
    expect(clampPanelWidth(240.4)).toBe(240);
  });

  it('存进去再读出来是同一个值', () => {
    savePanelWidth(320);
    expect(loadPanelWidth()).toBe(320);
  });

  it('保存时也会夹取', () => {
    savePanelWidth(9999);
    expect(loadPanelWidth()).toBe(PANEL_MAX_WIDTH);
  });

  it('没有存量时返回默认值', () => {
    expect(loadPanelWidth()).toBe(PANEL_DEFAULT_WIDTH);
  });

  it('存量越界时读回被夹住', () => {
    localStorage.setItem('nexus-panel-width', '9999');
    expect(loadPanelWidth()).toBe(PANEL_MAX_WIDTH);
  });

  it('存量是垃圾值时回落到默认值', () => {
    localStorage.setItem('nexus-panel-width', 'not-a-number');
    expect(loadPanelWidth()).toBe(PANEL_DEFAULT_WIDTH);
  });
});
