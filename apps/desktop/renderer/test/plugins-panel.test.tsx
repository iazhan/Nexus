// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExtensionHost,
  MATH_EXTENSION_ID,
  isMathMarker,
  type EditorExtension,
  type ExtensionLoader
} from '@nexus/editor';
import { PluginsPanel } from '../src/workspace/PluginsPanel.js';
import { localeManager } from '../src/platform.js';

// React 18+ 要求显式声明当前处于 act 环境，否则会刷警告。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INLINE_MATH = { type: 'inline-math' as const, from: 0, to: 1 };

const inner: EditorExtension = {
  id: MATH_EXTENSION_ID,
  canHandle: isMathMarker,
  load: async () => {},
  activate: () => ({ update: () => {}, destroy: () => {} })
};

const loader: ExtensionLoader = {
  id: MATH_EXTENSION_ID,
  matches: isMathMarker,
  load: async () => inner
};

/**
 * 插件面板的**自刷新**。
 *
 * 这是这次改动的全部理由，所以必须有一条用例钉住它：面板显示的状态来自两个注册表，
 * 而注册表的状态是在用户看不见的时候变的（投影挂载、打开附件）。
 * 只靠 props 变化重读的话，「刚打开一个 PDF」到「下一次别的原因触发重渲染」之间，
 * 面板会一直停在旧状态 —— 而「加载完成的那一刻面板就变」正是这个面板要证明的事。
 *
 * 判据的关键是**用例中间不再 render 一次**：面板必须靠订阅自己醒过来。
 * 若把 `useSyncExternalStore` 那几行注释掉，这条会红（停在 `idle`）。
 *
 * 状态推导本身在 `capability-manifest.test.ts`，注册表订阅在
 * `viewer-registry.test.tsx`，扩展宿主订阅在 `packages/editor/test/extension-host.test.ts`。
 */
describe('PluginsPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      localeManager.setLocale('en-US');
    });
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

  /** 某一行上写的状态。取 `data-plugin-status` 而不是类名拼接 —— 那是面板给测试留的口子。 */
  const statusOf = (id: string) =>
    container.querySelector(`[data-plugin-id="${id}"]`)?.getAttribute('data-plugin-status');

  it('扩展加载完成后，面板在没有外部重渲染的情况下自己从 idle 变 loaded', async () => {
    const host = new ExtensionHost();
    host.registerLazy(loader);

    await act(async () => {
      root.render(<PluginsPanel host={host} viewers={undefined} />);
    });
    expect(statusOf(MATH_EXTENSION_ID)).toBe('idle');

    // 触发加载。**这里刻意不再 render 一次** —— 面板得靠订阅自己醒过来。
    await act(async () => {
      await host.getHandler(INLINE_MATH)!.load();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(statusOf(MATH_EXTENSION_ID)).toBe('loaded');
  });

  it('加载失败后停在 failed —— 反面：不能一直显示「加载中」', async () => {
    const host = new ExtensionHost();
    host.registerLazy({
      id: MATH_EXTENSION_ID,
      matches: isMathMarker,
      load: async () => {
        throw new Error('chunk 拉取失败');
      }
    });

    await act(async () => {
      root.render(<PluginsPanel host={host} viewers={undefined} />);
    });

    await act(async () => {
      await host.getHandler(INLINE_MATH)!.load().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(statusOf(MATH_EXTENSION_ID)).toBe('failed');
  });
});
