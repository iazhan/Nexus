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
import { ViewerRendererRegistry } from '../src/viewer/registry.js';
import { localeManager } from '../src/platform.js';
import { translate } from '@nexus/i18n';
import { VIEWER_DOCUMENT_TYPES } from '@nexus/core';

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

  /**
   * 来源标记（P2-6）。**规则是「默认不显示，例外才显示」** ——
   * 给每一行挂一枚「内置」是纯噪声，还会把「这一条不一样」这个信号稀释掉。
   *
   * 面板只用到注册表的 `listExtensions` / `listRenderers` 加订阅那两个口子，所以这里
   * 喂的是**字面量假注册表**（`capability-manifest.test.ts` 里也是这么做的）；
   * 类型那一侧不受影响 —— 判据落在 `data-plugin-source` 与标记节点上。
   */
  describe('来源标记', () => {
    const fakeHost = (ids: readonly string[]) => ({
      listExtensions: () => ids.map((id) => ({ id, state: 'idle' as const })),
      subscribe: () => () => {},
      revision: 0
    });
    const fakeViewers = (types: readonly string[]) => ({
      listRenderers: () =>
        types.map((type) => ({
          type,
          requested: false,
          loaded: false,
          failed: false,
          disabled: false
        })),
      subscribe: () => () => {},
      revision: 0
    });

    const sourceBadges = () =>
      Array.from(container.querySelectorAll('.nexus-plugin-source')).map(
        (node) => node.textContent
      );

    it('全是出厂能力时一枚标记都不画', async () => {
      await act(async () => {
        root.render(
          <PluginsPanel
            host={fakeHost([MATH_EXTENSION_ID]) as never}
            viewers={fakeViewers(VIEWER_DOCUMENT_TYPES) as never}
          />
        );
      });

      // 每一行都自报 builtin（测试锚点），但**标记节点一个都没有**
      const rows = Array.from(container.querySelectorAll('[data-plugin-source]'));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.getAttribute('data-plugin-source') === 'builtin')).toBe(true);
      expect(sourceBadges()).toEqual([]);
    });

    it('第三方能力画标记，且**只有它那一行**画 —— 不能把别的行一起标上', async () => {
      await act(async () => {
        root.render(
          <PluginsPanel
            host={fakeHost([MATH_EXTENSION_ID, 'community:epub-viewer']) as never}
            viewers={undefined}
          />
        );
      });

      // 名字回落成裸 id（名册里没有它），标记说明它从哪来
      expect(container.querySelector('[data-plugin-id="community:epub-viewer"]')).not.toBeNull();
      expect(sourceBadges()).toEqual([
        translate(localeManager.locale, 'plugins.source.community')
      ]);
      // 反面：出厂那一条仍然没有标记
      expect(
        container
          .querySelector(`[data-plugin-id="${MATH_EXTENSION_ID}"]`)
          ?.querySelector('.nexus-plugin-source')
      ).toBeNull();
    });
  });

  /**
   * 启停要在面板上看得见（P1-4a 的第三个消费者）。
   *
   * 注册表报的状态里有一档是 `disabled` —— `listExtensions()` / `listRenderers()` 都**现问**
   * 谓词，所以用户拨了开关之后它们报的东西立刻就变了。但 `revision` 不会自己跳：它只在
   * **加载态**跃迁时由 `LazyExtension` / `LazyViewerRenderer` 通知。
   *
   * 少了那条信号，面板会一直停在旧状态：`useSyncExternalStore` 的快照不变 ⇒ 不重渲染；
   * 就算因为别的原因重渲染了，`useMemo([host, viewers, revision])` 也照样返回**缓存**的清单。
   * 症状正是「在设置里禁用一个插件，左侧栏看到的还是『未加载』」。
   *
   * 所以这里用**真注册表 + 可变谓词**（不是字面量假表）—— 假表只能证明「喂进去 disabled
   * 会画成 disabled」，证明不了「拨开关时有没有人叫醒面板」。
   * 判据的关键同样是**中间不再 render 一次**。
   */
  describe('启停跟着变', () => {
    it('关掉一个扩展之后，面板自己从 idle 变 disabled；拨回来要能回来', async () => {
      let disabled = false;
      const host = new ExtensionHost((id) => !(disabled && id === MATH_EXTENSION_ID));
      host.registerLazy(loader);

      await act(async () => {
        root.render(<PluginsPanel host={host} viewers={undefined} />);
      });
      expect(statusOf(MATH_EXTENSION_ID)).toBe('idle');

      // 用户在设置里拨了开关。**刻意不再 render** —— 面板得靠注册表的通知自己醒过来。
      await act(async () => {
        disabled = true;
        host.notifyCapabilitiesChanged();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(statusOf(MATH_EXTENSION_ID)).toBe('disabled');

      // 反面：拨回去必须回到 idle。只钉「变 disabled」的话，一个把状态**缓存死**的实现
      // 也能过，而那种实现的表现是「重新打开插件之后面板还写着已禁用」。
      await act(async () => {
        disabled = false;
        host.notifyCapabilitiesChanged();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(statusOf(MATH_EXTENSION_ID)).toBe('idle');
    });

    it('关掉一个渲染器之后，面板自己变 disabled —— 另一张注册表同样要通知', async () => {
      let disabled = false;
      const viewers = new ViewerRendererRegistry((type) => !(disabled && type === 'pdf'));
      viewers.registerLazy({ type: 'pdf', load: async () => ({ default: () => null }) });

      await act(async () => {
        root.render(<PluginsPanel host={undefined} viewers={viewers} />);
      });
      expect(statusOf('pdf')).toBe('idle');

      await act(async () => {
        disabled = true;
        viewers.notifyCapabilitiesChanged();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(statusOf('pdf')).toBe('disabled');
    });
  });
});
