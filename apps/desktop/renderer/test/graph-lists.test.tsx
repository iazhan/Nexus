// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubEntry, IndexedDocument, OrphanMode } from '@nexus/core';
import { HubsList, OrphansList } from '../src/workspace/GraphLists.js';
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

    (window as unknown as { nexus: unknown }).nexus = { getGraphOrphans, getGraphHubs };
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

    it('没有任何链接时是空态', async () => {
      getGraphHubs.mockImplementation(async () => []);
      await render(<HubsList revision={1} onOpenFile={onOpenFile} />);

      expect(items()).toHaveLength(0);
      expect(note()).toContain('Nothing is linked');
    });
  });
});
