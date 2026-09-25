// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../src/ErrorBoundary.js';
import { localeManager } from '../src/platform.js';

// React 18+ 要求显式声明当前处于 act 环境，否则会刷警告。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Boom(): React.ReactNode {
  throw new Error('projection exploded');
}

describe('ErrorBoundary', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // 错误边界捕获后 React 仍会把错误转发到 console.error，这里静音以免污染测试输出。
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders a visible error card instead of leaving the root empty', () => {
    act(() => {
      root.render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      );
    });

    // 白屏的判定标准就是这里为 0——错误边界必须保证它不为 0。
    expect(container.children.length).toBeGreaterThan(0);
    const card = container.querySelector('.nexus-error-card');
    expect(card).not.toBeNull();
    expect(card!.getAttribute('role')).toBe('alert');
    expect(container.textContent).toContain('projection exploded');
  });

  it('renders children untouched when nothing throws', () => {
    act(() => {
      root.render(
        <ErrorBoundary>
          <div className="ok">fine</div>
        </ErrorBoundary>
      );
    });

    expect(container.querySelector('.ok')).not.toBeNull();
    expect(container.querySelector('.nexus-error-card')).toBeNull();
  });

  it('clears the error when resetKey changes, so switching surface is a real recovery path', () => {
    act(() => {
      root.render(
        <ErrorBoundary resetKey="visual">
          <Boom />
        </ErrorBoundary>
      );
    });
    expect(container.querySelector('.nexus-error-card')).not.toBeNull();

    // 等价于用户按 Mod-M 切回 Source：resetKey 变了，边界必须放行新子树。
    act(() => {
      root.render(
        <ErrorBoundary resetKey="source">
          <div className="recovered">recovered</div>
        </ErrorBoundary>
      );
    });
    expect(container.querySelector('.nexus-error-card')).toBeNull();
    expect(container.querySelector('.recovered')).not.toBeNull();
  });

  it('keeps the error when resetKey is unchanged', () => {
    act(() => {
      root.render(
        <ErrorBoundary resetKey="visual">
          <Boom />
        </ErrorBoundary>
      );
    });
    expect(container.querySelector('.nexus-error-card')).not.toBeNull();

    act(() => {
      root.render(
        <ErrorBoundary resetKey="visual">
          <div className="recovered">recovered</div>
        </ErrorBoundary>
      );
    });
    // resetKey 未变 → 仍然显示错误卡片，不会被静默吞掉
    expect(container.querySelector('.nexus-error-card')).not.toBeNull();
  });

  it('recovers when the user presses Retry', () => {
    act(() => {
      root.render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      );
    });

    const retry = container.querySelector('.nexus-retry-btn') as HTMLButtonElement;
    expect(retry).not.toBeNull();

    act(() => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    // 子树仍然会再抛一次，边界要重新接住而不是把异常漏出去
    expect(container.querySelector('.nexus-error-card')).not.toBeNull();
    expect(container.children.length).toBeGreaterThan(0);
  });

  /**
   * 这个组件在 `main.tsx` 里包着 `<App />`，拿不到 `useLocale()`，
   * 所以「文案跟随语言」只能靠自己订阅 `localeManager`。
   * 之前它的标题、恢复提示和 Retry 全是硬编码英文，切到中文也不变。
   */
  it('follows locale changes in the fallback copy', () => {
    act(() => {
      root.render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      );
    });

    const title = () => container.querySelector('.error-title')?.textContent ?? '';
    const retry = () => container.querySelector('.nexus-retry-btn')?.textContent ?? '';

    // 单例默认 en-US（app 的 LocaleManager 与编辑器 facet 的 zh-CN 兜底不是一回事）
    act(() => {
      localeManager.setLocale('en-US');
    });
    expect(title()).toBe('Editor crashed');
    expect(retry()).toBe('Retry');

    act(() => {
      localeManager.setLocale('zh-CN');
    });
    expect(title()).toBe('编辑器已崩溃');
    expect(retry()).toBe('重试');

    // 还原单例，避免污染同进程里的其它用例
    act(() => {
      localeManager.setLocale('en-US');
    });
  });
});
