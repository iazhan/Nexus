import { describe, it, expect, beforeEach } from 'vitest';
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  clampPanelWidth
} from '../src/workspace/panel-width.js';
import { SettingsStore } from '../src/settings/store.js';

/**
 * 侧栏宽度偏好。
 *
 * 取值域是纯函数（`clampPanelWidth`），持久化归 `SettingsStore` 的 `editor.panelWidth`。
 * 重点是**降级**：磁盘上可能是垃圾值、越界值，甚至读不到（隐私模式）。这些都不该让宽度变成
 * `NaNpx` —— 那等于宽度 0，表现是「拖一下侧栏就消失了」。
 *
 * 用真 `localStorage` 造 `SettingsStore`（happy-dom 提供），因为 `parse` / `serialize` 的
 * 往返正是这里要验的东西 —— 打桩存储就绕过了键名与格式。
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

  it('写进 store 再读出来是同一个值', () => {
    const store = new SettingsStore(localStorage);
    store.set('editor.panelWidth', 320);

    expect(store.get('editor.panelWidth')).toBe(320);
    // 换一个 store 实例读，验的是**磁盘**上那一份，不是内存。
    expect(new SettingsStore(localStorage).get('editor.panelWidth')).toBe(320);
  });

  it('写越界值时被夹住', () => {
    const store = new SettingsStore(localStorage);
    store.set('editor.panelWidth', 9999);

    expect(store.get('editor.panelWidth')).toBe(PANEL_MAX_WIDTH);
    expect(localStorage.getItem('nexus-panel-width')).toBe(String(PANEL_MAX_WIDTH));
  });

  it('没有存量时是默认值', () => {
    expect(new SettingsStore(localStorage).get('editor.panelWidth')).toBe(PANEL_DEFAULT_WIDTH);
  });

  it('存量越界时读回被夹住', () => {
    localStorage.setItem('nexus-panel-width', '9999');
    expect(new SettingsStore(localStorage).get('editor.panelWidth')).toBe(PANEL_MAX_WIDTH);
  });

  it('存量是垃圾值时回落到默认值', () => {
    localStorage.setItem('nexus-panel-width', 'not-a-number');
    expect(new SettingsStore(localStorage).get('editor.panelWidth')).toBe(PANEL_DEFAULT_WIDTH);
  });

  it('存量是空串时回落到默认值，而不是最小值', () => {
    // `Number('')` 是 0，夹取后变成 160 —— 那会让「清空输入框」把侧栏缩到最小。
    localStorage.setItem('nexus-panel-width', '');
    expect(new SettingsStore(localStorage).get('editor.panelWidth')).toBe(PANEL_DEFAULT_WIDTH);
  });
});
