// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeadLinkEntry, HubEntry, IndexedDocument, OrphanMode } from '@nexus/core';
import { DeadLinksList, HubsList, OrphansList } from '../src/workspace/GraphLists.js';
import { localeManager } from '../src/platform.js';

/**
 * 图谱的两个清单视图：孤儿与枢纽。
 *
 * 为什么要有这一层：`index-store.test.ts` 验的是「谁在名单里、谁不在」，
 * 验不了「三种模式的空态文案是不是各自的」「计数有没有画出来」「点了会不会打开对的文档」。
 * 这里用打桩的 `window.nexus` 换掉 IPC，只验渲染。
 *
 * `apps/desktop/renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const documentOf = (relativePath: string, id: number): IndexedDocument => ({
  id,
  path: `/vault/${relativePath}`,
  relativePath,
  name: relativePath.split('/').pop() ?? relativePath,
  title: relativePath,
  type: 'markdown',
  sizeBytes: 1,
  modifiedAtMs: 1,
  contentHash: relativePath,
  extractionStatus: 'none'
});

describe('图谱清单视图', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onOpenFile: ReturnType<typeof vi.fn>;
  let getGraphOrphans: ReturnType<typeof vi.fn>;
  let getGraphHubs: ReturnType<typeof vi.fn>;
  let getGraphDeadLinks: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onOpenFile = vi.fn();

    /*
      桩按**模式**返回不同结果 —— 否则「切模式之后列表变了」这条断言对
      「根本没把模式传下去」同样成立。
    */
    getGraphOrphans = vi.fn(async (mode: OrphanMode) => {
      if (mode === 'incoming') return [documentOf('a.md', 1), documentOf('b.md', 2)];
      if (mode === 'outgoing') return [documentOf('hub.md', 3)];
      return [];
    });
    getGraphHubs = vi.fn(
      async (): Promise<HubEntry[]> => [
        { document: documentOf('hub.md', 3), count: 7 },
        { document: documentOf('b.md', 2), count: 2 }
      ]
    );

    getGraphDeadLinks = vi.fn(async (): Promise<DeadLinkEntry[]> => []);

    (window as unknown as { nexus: unknown }).nexus = {
      getGraphOrphans,
      getGraphHubs,
      getGraphDeadLinks
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    act(() => {
      localeManager.setLocale('en-US');
    });
    vi.restoreAllMocks();
  });

  const render = async (element: React.ReactElement) => {
    await act(async () => {
      root.render(element);
    });
    // 查询是异步的，再让微任务跑一轮
    await act(async () => {});
  };

  const items = () =>
    Array.from(container.querySelectorAll<HTMLElement>('.nexus-backlink-item'));
  const chip = (selector: string) => container.querySelector<HTMLElement>(selector);
  const note = () => container.querySelector('.nexus-sidebar-note')?.textContent ?? null;

  describe('孤儿', () => {
    it('默认列出「两者都缺」，并给出三个模式开关', async () => {
      await render(<OrphansList revision={1} onOpenFile={onOpenFile} />);

      expect(getGraphOrphans).toHaveBeenCalledWith('both');
      expect(
        ['incoming', 'outgoing', 'both'].map(
          (mode) => chip(`[data-orphan-mode="${mode}"]`)?.getAttribute('aria-pressed')
        )
      ).toEqual(['false', 'false', 'true']);
      // 夹具里 both 是空的，所以走空态
      expect(items()).toHaveLength(0);
    });

    it('切模式会重查，并把那一模式的结果列出来', async () => {
      await render(<OrphansList revision={1} onOpenFile={onOpenFile} />);

      await act(async () => {
        chip('[data-orphan-mode="incoming"]')!.click();
      });
      await act(async () => {});

      expect(getGraphOrphans).toHaveBeenLastCalledWith('incoming');
      expect(items().map((el) => el.textContent)).toEqual(['a.md', 'b.md']);
    });

    it('每种模式的空态说的是各自的空法', async () => {
      // 共用一句话的话，用户看到的会是「没有孤儿」，而他明明刚筛掉了另一类
      await render(<OrphansList revision={1} onOpenFile={onOpenFile} />);
      expect(note()).toContain('disconnected');

      await act(async () => {
        chip('[data-orphan-mode="incoming"]')!.click();
      });
      await act(async () => {});
      expect(note()).toBeNull();

      await act(async () => {
        chip('[data-orphan-mode="outgoing"]')!.click();
      });
      await act(async () => {});
      expect(items()).toHaveLength(1);
    });

    it('点条目打开对应文档', async () => {
      await render(<OrphansList revision={1} onOpenFile={onOpenFile} />);
      await act(async () => {
        chip('[data-orphan-mode="incoming"]')!.click();
      });
      await act(async () => {});

      act(() => {
        items()[1]!.click();
      });
      expect(onOpenFile).toHaveBeenCalledWith('/vault/b.md');
    });

    it('三档空态文案两两不同，而且各自解释了「这一屏列的是什么」', async () => {
      /*
        三档共用一句话的话，用户看到的会是「没有孤儿」，而他明明刚筛掉了另一类。
        光说「没有」还不够 —— 原来的文案没解释「孤立」的定义，用户分不清是
        「没人引用」还是「不引用别人」。所以每条都要说清「什么才会出现在这里」。
      */
      getGraphOrphans.mockImplementation(async () => []);
      await render(<OrphansList revision={1} onOpenFile={onOpenFile} />);
      const both = note()!;

      await act(async () => {
        chip('[data-orphan-mode="incoming"]')!.click();
      });
      await act(async () => {});
      const incoming = note()!;

      await act(async () => {
        chip('[data-orphan-mode="outgoing"]')!.click();
      });
      await act(async () => {});
      const outgoing = note()!;

      expect(new Set([both, incoming, outgoing]).size).toBe(3);
      // 三档都得说清「这一屏列的是什么」，而不是只留一句「空的」——
      // 光看空态分不出自己切到了哪一档（`appears`/`appear` 两种单复数都收）
      for (const text of [both, incoming, outgoing]) {
        expect(text).toMatch(/appears? here/);
      }
    });
  });

  describe('枢纽', () => {
    it('列出文档与入链计数', async () => {
      await render(<HubsList revision={1} onOpenFile={onOpenFile} />);

      expect(items().map((el) => el.textContent)).toEqual([
        'hub.md7 incoming',
        'b.md2 incoming'
      ]);
    });

    it('点条目打开对应文档', async () => {
      await render(<HubsList revision={1} onOpenFile={onOpenFile} />);

      act(() => {
        items()[0]!.click();
      });
      expect(onOpenFile).toHaveBeenCalledWith('/vault/hub.md');
    });

    it('没有任何链接时是空态，并说清这一屏是按什么排的', async () => {
      getGraphHubs.mockImplementation(async () => []);
      await render(<HubsList revision={1} onOpenFile={onOpenFile} />);

      expect(items()).toHaveLength(0);
      expect(note()).toContain('Nothing is linked');
      // 「枢纽」这个词本身不解释任何东西 —— 得说清它是按被引用次数排的
      expect(note()).toContain('ranks documents');
    });
  });

  describe('断链', () => {
    const deadEntry = (target: string, sources: string[]): DeadLinkEntry => ({
      target,
      sources: sources.map((relativePath, index) => documentOf(relativePath, index + 100)),
      count: sources.length
    });

    const targets = () =>
      Array.from(container.querySelectorAll('[data-dead-link]')).map((el) =>
        el.getAttribute('data-dead-link')
      );

    it('列出目标、次数与来源，点来源打开那一篇', async () => {
      getGraphDeadLinks.mockImplementation(async () => [
        deadEntry('dma', ['notes/a.md', 'notes/b.md']),
        deadEntry('未建', ['c.md'])
      ]);
      await render(<DeadLinksList revision={1} onOpenFile={onOpenFile} />);

      expect(targets()).toEqual(['dma', '未建']);
      expect(
        container.querySelector('[data-dead-link="dma"] .nexus-graph-list-count')!.textContent
      ).toBe('2 refs');

      const sources = Array.from(
        container.querySelectorAll<HTMLElement>('[data-dead-link="dma"] .nexus-backlink-item')
      );
      expect(sources.map((el) => el.textContent)).toEqual(['notes/a.md', 'notes/b.md']);

      act(() => {
        sources[1]!.click();
      });
      expect(onOpenFile).toHaveBeenCalledWith('/vault/notes/b.md');
    });

    it('按主进程给的顺序渲染，不在渲染层重排', async () => {
      /*
        全序由 `getDeadLinks` 保证（来源数降序、同数按目标名）。渲染层再排一次，
        等于把「顺序的口径」抄成两份，迟早不一致 —— 所以夹具故意给一个**看着不对**的顺序：
        一个来源的 `zzz` 排在两个来源的 `aaa` 前面。
      */
      getGraphDeadLinks.mockImplementation(async () => [
        deadEntry('zzz', ['a.md']),
        deadEntry('aaa', ['a.md', 'b.md'])
      ]);
      await render(<DeadLinksList revision={1} onOpenFile={onOpenFile} />);

      expect(targets()).toEqual(['zzz', 'aaa']);
    });

    it('目标名本身不可点 —— 它没有文档可打开', async () => {
      // 做成按钮会让人点了没反应，而「点了没反应」比「不可点」更难懂
      getGraphDeadLinks.mockImplementation(async () => [deadEntry('dma', ['a.md'])]);
      await render(<DeadLinksList revision={1} onOpenFile={onOpenFile} />);

      const target = container.querySelector<HTMLElement>('.nexus-graph-dead-target')!;
      expect(target.tagName).not.toBe('BUTTON');
      act(() => {
        target.click();
      });
      expect(onOpenFile).not.toHaveBeenCalled();
    });

    it('没有断链时是空态，不是错误', async () => {
      getGraphDeadLinks.mockImplementation(async () => []);
      await render(<DeadLinksList revision={1} onOpenFile={onOpenFile} />);

      expect(container.querySelector('.nexus-graph-list')!.getAttribute('data-phase')).toBe('ready');
      expect(container.querySelector('.nexus-graph-note[data-error]')).toBeNull();
      expect(note()).toContain('Every link points at');
    });

    it('取数失败时走错误态，而不是渲染成空态', async () => {
      getGraphDeadLinks.mockRejectedValue(new Error('IPC exploded'));
      await render(<DeadLinksList revision={1} onOpenFile={onOpenFile} />);

      expect(container.querySelector('.nexus-graph-list')!.getAttribute('data-phase')).toBe('error');
      expect(note()).toBeNull();
    });
  });

  /**
   * 四态**互斥且顺序固定**：错误 → 加载中 → 空 → 列表。
   *
   * 前一半是正例（失败必须看得见），后一半是反例（正常的空与加载不能被渲染成失败）。
   * 只写正例的话，「不管什么情况都显示错误条」照样能过。
   *
   * `data-phase` 是就绪判据，不是文案 —— 加载态与空态共用 `.nexus-sidebar-note`，
   * 靠「某个文案出现了」判会互相串。
   */
  describe('四态互斥', () => {
    const phase = () => container.querySelector('.nexus-graph-list')!.getAttribute('data-phase');
    /** 错误条专有的 `data-error`（把原始错误信息带出来，方便定位是 IPC 还是桥）。 */
    const errorNote = () => container.querySelector('.nexus-graph-note[data-error]');

    it('孤儿取数失败时走错误态，而不是渲染成空态', async () => {
      getGraphOrphans.mockRejectedValue(new Error('IPC exploded'));

      await render(<OrphansList revision={1} onOpenFile={onOpenFile} />);

      expect(phase()).toBe('error');
      expect(errorNote()?.textContent).toBe('Could not load the graph.');
      // 关键：不能退化成空态文案 —— 这两句话在屏幕上长得一模一样
      expect(note()).toBeNull();
    });

    it('桥没就绪（preload 挂了）同样走错误态', async () => {
      // 原来这里是 `window.nexus?.getGraphOrphans?.(…)` —— 桥不存在时连 catch 都不进、
      // 一行日志都没有，直接渲染成「没有完全孤立的文档」
      delete (window as unknown as { nexus?: unknown }).nexus;

      await render(<OrphansList revision={1} onOpenFile={onOpenFile} />);

      expect(phase()).toBe('error');
      expect(errorNote()).not.toBeNull();
    });

    it('真的没有孤儿时不出现错误条', async () => {
      await render(<OrphansList revision={1} onOpenFile={onOpenFile} />);

      expect(phase()).toBe('ready');
      expect(errorNote()).toBeNull();
      expect(note()).toContain('disconnected');
    });

    it('第一次取数还没回来时是加载态，不显示空态文案', async () => {
      getGraphOrphans.mockReturnValue(new Promise(() => {}));

      await render(<OrphansList revision={1} onOpenFile={onOpenFile} />);

      expect(phase()).toBe('loading');
      expect(errorNote()).toBeNull();
      expect(note()).toContain('Loading the graph');
      expect(note()).not.toContain('disconnected');
    });

    it('失败之后重新取数成功，上一次的错误条必须消失', async () => {
      getGraphOrphans.mockRejectedValue(new Error('IPC exploded'));
      await render(<OrphansList revision={1} onOpenFile={onOpenFile} />);
      expect(errorNote()).not.toBeNull();

      getGraphOrphans.mockImplementation(async () => [documentOf('a.md', 1)]);
      await act(async () => {
        root.render(<OrphansList revision={2} onOpenFile={onOpenFile} />);
      });
      await act(async () => {});

      expect(phase()).toBe('ready');
      expect(errorNote()).toBeNull();
      expect(items()).toHaveLength(1);
    });

    it('换模式回到加载态（旧答案对新问题不成立）', async () => {
      await render(<OrphansList revision={1} onOpenFile={onOpenFile} />);
      await act(async () => {
        chip('[data-orphan-mode="outgoing"]')!.click();
      });
      await act(async () => {});
      expect(items()).toHaveLength(1);

      getGraphOrphans.mockReturnValue(new Promise(() => {}));
      await act(async () => {
        chip('[data-orphan-mode="incoming"]')!.click();
      });

      expect(phase()).toBe('loading');
      expect(items()).toHaveLength(0);
    });

    it('只换 revision 不回加载态（同一个问题重取，不闪）', async () => {
      await render(<OrphansList revision={1} onOpenFile={onOpenFile} />);
      await act(async () => {
        chip('[data-orphan-mode="incoming"]')!.click();
      });
      await act(async () => {});
      expect(items()).toHaveLength(2);

      getGraphOrphans.mockReturnValue(new Promise(() => {}));
      await act(async () => {
        root.render(<OrphansList revision={2} onOpenFile={onOpenFile} />);
      });

      expect(phase()).toBe('ready');
      expect(items()).toHaveLength(2);
    });

    it('枢纽取数失败时走错误态，而不是渲染成空态', async () => {
      getGraphHubs.mockRejectedValue(new Error('IPC exploded'));

      await render(<HubsList revision={1} onOpenFile={onOpenFile} />);

      expect(phase()).toBe('error');
      expect(errorNote()?.textContent).toBe('Could not load the graph.');
      expect(note()).toBeNull();
    });

    it('枢纽真的为空时不出现错误条', async () => {
      getGraphHubs.mockImplementation(async () => []);

      await render(<HubsList revision={1} onOpenFile={onOpenFile} />);

      expect(phase()).toBe('ready');
      expect(errorNote()).toBeNull();
      expect(note()).toContain('Nothing is linked');
    });
  });
});
