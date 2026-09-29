// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsWindow } from '../src/settings/SettingsWindow.js';
import { readWindowRole } from '../src/window-role.js';
import { settings } from '../src/platform.js';

/**
 * 设置窗口：角色分派 + 窗口外壳。
 *
 * 分两层判据：
 *
 * - **角色**是纯函数（`readWindowRole`），直接喂查询串 —— 真机上它由主进程按
 *   `?window=settings` 建窗，测这里就够了。
 * - **外壳**用打桩的 `window.nexus` 验「关窗 / 最大化」走到了桥上，以及 Escape 的两个分支。
 *   真机那一层（窗口真的建出来、单例、跨窗口同步）在 `apps/desktop/test/settings-window.test.ts`。
 *
 * 注意 `renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let calls: string[];

function stubBridge(): void {
  calls = [];
  (window as unknown as { nexus: unknown }).nexus = {
    closeWindow: () => calls.push('close'),
    minimizeWindow: () => calls.push('minimize'),
    maximizeWindow: () => calls.push('maximize'),
    getWindowState: () => Promise.resolve({ maximized: false }),
    onWindowStateChanged: () => () => {}
  };
}

function renderWindow(): void {
  act(() => {
    root.render(<SettingsWindow />);
  });
}

function pressEscape(preventDefault = false): void {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  if (preventDefault) event.preventDefault();
  act(() => {
    window.dispatchEvent(event);
  });
}

describe('窗口角色', () => {
  it('带 ?window=settings 的查询串判为设置窗口', () => {
    expect(readWindowRole('?window=settings')).toBe('settings');
  });

  it('主窗口是空查询串', () => {
    expect(readWindowRole('')).toBe('main');
  });

  /** 认不出的一律当主窗口：宁可多开一个主界面，也不要把用户丢进只有设置的窗口。 */
  it('参数认不出时回落到主窗口', () => {
    expect(readWindowRole('?window=')).toBe('main');
    expect(readWindowRole('?window=Settings')).toBe('main');
    expect(readWindowRole('?window=other')).toBe('main');
    expect(readWindowRole('?file=x.md')).toBe('main');
  });
});

describe('设置窗口外壳', () => {
  beforeEach(() => {
    settings.set('settings.lastSection', 'appearance');
    stubBridge();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    settings.set('settings.lastSection', 'appearance');
  });

  it('标记自己是设置窗口，并装上设置本体', () => {
    renderWindow();

    expect(container.querySelector('[data-window-role="settings"]')).not.toBeNull();
    expect(container.querySelector('.nexus-settings-view')).not.toBeNull();
  });

  /** 无边框窗口：标题栏里必须有自绘的关闭键，否则设置窗口只能靠 Escape 关。 */
  it('标题栏有自绘窗口按钮，关闭键走到桥上', () => {
    renderWindow();

    const buttons = container.querySelectorAll('.nexus-window-controls .nexus-window-button');
    expect(buttons).toHaveLength(3);

    act(() => {
      (buttons[2] as HTMLButtonElement).click();
    });
    expect(calls).toEqual(['close']);
  });

  it('标题栏里没有主窗口的菜单栏与活动栏', () => {
    renderWindow();

    expect(container.querySelector('.nexus-menu-bar')).toBeNull();
    expect(container.querySelector('.nexus-activity-bar')).toBeNull();
  });

  it('Escape 关窗', () => {
    renderWindow();
    pressEscape();
    expect(calls).toEqual(['close']);
  });

  /**
   * 覆盖项清单是个 `Dialog`，它的 Escape 挂在面板上并已 `preventDefault`。
   * 少了这道判断，关弹层会顺带把整个窗口一起关掉 —— 用户丢掉的是整个设置界面。
   */
  it('Escape 已被面板处理时不再关窗', () => {
    renderWindow();
    pressEscape(true);
    expect(calls).toEqual([]);
  });

  it('其他按键不关窗', () => {
    renderWindow();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    });

    expect(calls).toEqual([]);
  });
});
