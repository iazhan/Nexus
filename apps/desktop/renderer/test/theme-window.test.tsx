// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_THEME_CHOICE } from '@nexus/theme';
import { ThemeWindow } from '../src/settings/ThemeWindow.js';
import { readWindowRole } from '../src/window-role.js';
import { applyThemeChoice, settings, themeManager } from '../src/platform.js';

/**
 * 主题窗口：角色分派 + 窗口外壳。
 *
 * 分两层判据：
 *
 * - **角色**是纯函数（`readWindowRole`），直接喂查询串 —— 真机上它由主进程按 `?window=theme` 建窗。
 * - **外壳**用打桩的 `window.nexus` 验「关窗 / 最大化」走到了桥上，以及 Escape 的两个分支。
 *   真机那一层（窗口真的建出来、单例、编辑器链路）在 `apps/desktop/test/theme-editor.test.ts`。
 *
 * 编辑器本体的分支（只读态、两档、token 搜索、对比度体检）在 `theme-editor.test.tsx` 里，
 * 这里只证明**这个窗口装的是它**。
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
    root.render(<ThemeWindow />);
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
  it('带 ?window=theme 的查询串判为主题窗口', () => {
    expect(readWindowRole('?window=theme')).toBe('theme');
  });

  /** 三个角色互不误配 —— 认错一个就会把主题编辑器画进主窗口。 */
  it('三个角色各归各的', () => {
    expect(readWindowRole('?window=main')).toBe('main');
    expect(readWindowRole('?window=settings')).toBe('settings');
    expect(readWindowRole('?window=theme')).toBe('theme');
  });
});

describe('主题窗口外壳', () => {
  beforeEach(() => {
    settings.set('appearance.userThemes', []);
    applyThemeChoice(DEFAULT_THEME_CHOICE);
    stubBridge();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    settings.set('appearance.userThemes', []);
    applyThemeChoice(DEFAULT_THEME_CHOICE);
  });

  it('标记自己是主题窗口，并装上主题编辑器', () => {
    renderWindow();

    expect(container.querySelector('[data-window-role="theme"]')).not.toBeNull();
    expect(container.querySelector('[data-theme-editor]')).not.toBeNull();
  });

  /** 无边框窗口：标题栏里必须有自绘的关闭键，否则主题窗口只能靠 Escape 关。 */
  it('标题栏有自绘窗口按钮，关闭键走到桥上', () => {
    renderWindow();

    // 只看**窗口自己的**标题栏。预览里那扇假壳也挂 `.nexus-window-controls`（刻意的：
    // 预览用真类名，见 `ThemePreview`），在整棵 `container` 上查会数到 6 个。
    const header = container.querySelector(
      '.nexus-app-root[data-window-role="theme"] > .nexus-header-bar'
    );
    const buttons = header?.querySelectorAll('.nexus-window-controls .nexus-window-button') ?? [];
    expect(buttons).toHaveLength(3);

    act(() => {
      (buttons[2] as HTMLButtonElement).click();
    });
    expect(calls).toEqual(['close']);
  });

  /**
   * 窗口骨架里没有主窗口的菜单栏与活动栏 —— 但预览里**有**（那是画给人看的假壳）。
   * 所以先摘掉预览子树再断言，否则这条会把「预览画对了」误判成「窗口骨架装错了」。
   */
  it('窗口骨架里没有主窗口的菜单栏与活动栏', () => {
    renderWindow();

    const preview = container.querySelector('.nexus-theme-preview-shell');
    expect(preview).not.toBeNull();
    preview?.remove();

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
   * 少了这道判断，关弹层会顺带把整个窗口一起关掉。
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

  /** 主题窗口与设置窗口共用 `ThemeManager` 单例，跨窗口同步由 `platform.ts` 的广播负责。 */
  it('编辑器读的是同一份主题状态', () => {
    themeManager.forkActiveToUserTheme();
    renderWindow();

    expect(container.querySelector('[data-theme-tier-panel="basic"]')).not.toBeNull();
    expect(themeManager.isEditable).toBe(true);
  });
});
