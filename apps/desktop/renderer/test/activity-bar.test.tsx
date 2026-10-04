// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityBar } from '../src/shell/ActivityBar.js';
import type { ActivityId } from '../src/shell/activity-bar-state.js';
import { localeManager } from '../src/platform.js';

/**
 * 活动栏图标的**高亮**，以及底部那枚主题按钮。
 *
 * 为什么要有这一层：`activity-bar-state.test.ts` 验的是 reducer（`activeId` 收起来之后
 * 留不留），`apps/desktop/test/activity-bar.test.ts` 验的是真机上的宽度与交互 ——
 * 两者都验不了「**类名与 `aria-pressed` 说的是不是同一件事**」。
 *
 * 而那个 bug 恰恰就是这样：类名只看 `activeId`，`aria-pressed` 看 `activeId && panelOpen`。
 * 收起面板后视觉上还亮着、屏幕阅读器读到「未按下」，而没有任何用例守着它。
 *
 * 主题按钮那条还多守一件事：它**不共用 `nexus-activity-icon` 类名** —— 真机那边按那个
 * 类名列出全部活动入口，混进去会让清单多一个不是入口的东西。
 *
 * `apps/desktop/renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('活动栏图标高亮', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSelect: ReturnType<typeof vi.fn>;
  let onOpenSettings: ReturnType<typeof vi.fn>;
  let onToggleTheme: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onSelect = vi.fn();
    onOpenSettings = vi.fn();
    onToggleTheme = vi.fn();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    // 单例：本文件改过 locale 的用例必须还原，否则同进程里后面的用例会跟着变
    act(() => {
      localeManager.setLocale('en-US');
    });
    vi.restoreAllMocks();
  });

  const render = (
    activeId: ActivityId,
    panelOpen: boolean,
    theme: { type: 'light' | 'dark'; switchable: boolean } = { type: 'light', switchable: true }
  ) => {
    act(() => {
      root.render(
        <ActivityBar
          activeId={activeId}
          panelOpen={panelOpen}
          onSelect={onSelect}
          onOpenSettings={onOpenSettings}
          themeType={theme.type}
          themeSwitchable={theme.switchable}
          onToggleTheme={onToggleTheme}
        />
      );
    });
  };

  const button = (id: string) =>
    container.querySelector<HTMLButtonElement>(`.nexus-activity-icon[data-activity="${id}"]`)!;
  const highlighted = () =>
    Array.from(container.querySelectorAll<HTMLElement>('.nexus-activity-icon-active')).map((el) =>
      el.getAttribute('data-activity')
    );
  const pressed = () =>
    Array.from(container.querySelectorAll<HTMLElement>('.nexus-activity-icon'))
      .filter((el) => el.getAttribute('aria-pressed') === 'true')
      .map((el) => el.getAttribute('data-activity'));
  const themeButton = () => container.querySelector<HTMLButtonElement>('.nexus-activity-theme')!;

  it('面板开着时，选中的那个图标高亮且 aria-pressed 为真', () => {
    render('search', true);

    expect(highlighted()).toEqual(['search']);
    expect(pressed()).toEqual(['search']);
  });

  it('面板收起后**没有任何**图标高亮', () => {
    render('search', false);

    // 高亮表达的是「现在看的这一屏就是它」，面板收起来了这句话就不成立
    expect(highlighted()).toEqual([]);
    expect(pressed()).toEqual([]);
  });

  it('类名与 aria-pressed 永远说的是同一件事', () => {
    /*
      这条是**不变量**，不是某个具体场景：两处各写一遍必然漂，
      而漂了之后视觉与读屏各说各话，谁也不会发现。
    */
    for (const activeId of ['workspace', 'graph', 'extensions'] as const) {
      for (const panelOpen of [true, false]) {
        render(activeId, panelOpen);
        expect(highlighted(), `activeId=${activeId} panelOpen=${panelOpen}`).toEqual(pressed());
      }
    }
  });

  it('点图标把 id 交给回调', () => {
    render('workspace', true);

    act(() => {
      button('graph').click();
    });
    expect(onSelect).toHaveBeenCalledWith('graph');
  });

  it('设置图标不参与高亮，走自己的回调', () => {
    render('settings' as ActivityId, true);

    // 设置是应用级入口，与上面那些文档级入口不属于同一组
    expect(highlighted()).toEqual([]);

    act(() => {
      button('settings').click();
    });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('主题按钮：画的是 SVG 而不是 emoji，走自己的回调', () => {
    render('workspace', true);

    expect(themeButton().querySelector('svg')).not.toBeNull();
    expect(themeButton().textContent).not.toContain('🌙');
    expect(themeButton().textContent).not.toContain('☀️');

    act(() => {
      themeButton().click();
    });
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('主题不是活动入口：既不共用图标类名，也不参与高亮', () => {
    render('workspace', true);

    // 真机那边按 `.nexus-activity-icon` 列出全部活动入口 —— 主题混进去清单就错了。
    expect(container.querySelector('.nexus-activity-icon[data-activity="theme"]')).toBeNull();
    expect(highlighted()).toEqual(['workspace']);
  });

  it('主题切不动（用户主题 / 单变体预设）时按钮禁用', () => {
    render('workspace', true, { type: 'light', switchable: false });

    expect(themeButton().disabled).toBe(true);

    // 反面：能切的时候不能顺手也禁掉 —— 否则「禁用」这条判据在两种情况下都成立
    render('workspace', true, { type: 'dark', switchable: true });
    expect(themeButton().disabled).toBe(false);
  });
});
