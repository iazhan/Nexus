// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexedDocument } from '@nexus/core';
import { WorkspaceSidebar } from '../src/workspace/WorkspaceSidebar.js';

/**
 * 侧栏头部的「切换工作区」下拉（2026-10-14）。
 *
 * 这一层单独建文件而不是并进 `workspace-sidebar-tree.test.tsx`：那个文件钉的是
 * **树与工具栏**，渲染参数是「一批文档 + 一批目录」；这里钉的是
 * 「菜单条目从哪来、点了调用谁」，只需要一个空工作区 + 三个回调。
 * 混在一起会让两个文件的 beforeEach 都要带上一堆用不着的桩。
 *
 * 与树那一层同一条理由用 happy-dom：菜单是**组件里的分支**（有没有最近列表、
 * 当前根在哪一项上），真机用例启动一次 Electron 只跑一种工作区形状，覆盖不到。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OK_RESULT = {
  scanned: 0,
  indexed: 0,
  skipped: 0,
  removed: 0,
  extracted: 0,
  truncated: false,
  errors: [] as string[]
};

describe('工作区侧栏：切换工作区菜单', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSwitchWorkspace: ReturnType<typeof vi.fn>;
  let onOpenRecentWorkspace: ReturnType<typeof vi.fn>;
  let currentRecent: readonly string[] | undefined;

  const switchButton = () =>
    container.querySelector<HTMLButtonElement>('button[data-action="switch-workspace"]');

  const menuItem = (id: string) =>
    container.querySelector<HTMLElement>(`[data-context-menu-item="${id}"]`);

  const renderElement = () => (
    <WorkspaceSidebar
      rootPath="/vault"
      activeFilePath={null}
      onOpenFile={vi.fn()}
      showImages
      onSwitchWorkspace={onSwitchWorkspace}
      onOpenRecentWorkspace={onOpenRecentWorkspace}
      recentWorkspaces={currentRecent}
      onShowImagesChange={vi.fn()}
      onCreateFile={vi.fn(async () => null)}
      onCreateFolder={vi.fn(async () => null)}
      onDeleteFile={vi.fn()}
      onRefresh={vi.fn(async () => [])}
    />
  );

  /** 渲染并等索引链跑完。判据同树那一层：`data-phase`，不猜 note。 */
  async function renderSidebar(recent?: readonly string[]): Promise<void> {
    currentRecent = recent;
    (window as unknown as { nexus: unknown }).nexus = {
      rebuildIndex: vi.fn(async () => ({ ...OK_RESULT })),
      listIndexedDocuments: vi.fn(async () => [] as IndexedDocument[]),
      listWorkspaceDirectories: vi.fn(async () => [])
    };

    await act(async () => {
      root.render(renderElement());
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const phase = container
        .querySelector('.nexus-workspace-sidebar')
        ?.getAttribute('data-phase');
      if (phase === 'ready' || phase === 'error') return;
      await act(async () => {
        await Promise.resolve();
      });
    }
    throw new Error(`侧栏没有进入 ready/error：${container.innerHTML}`);
  }

  const click = async (element: HTMLElement | null) => {
    await act(async () => {
      element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onSwitchWorkspace = vi.fn();
    onOpenRecentWorkspace = vi.fn();
    currentRecent = undefined;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    vi.restoreAllMocks();
  });

  it('头部有一枚切换按钮，且默认不带菜单', async () => {
    await renderSidebar();

    const button = switchButton();
    expect(button).not.toBeNull();
    expect(button?.getAttribute('title')).toBe('Switch workspace…');
    // 没点开时菜单不在 DOM 里 —— 常驻一个空菜单会让读屏软件念出一堆不可点的项
    expect(container.querySelector('.nexus-context-menu')).toBeNull();
  });

  it('点开是「切换工作区…」+ 最近列表；当前所在的根打 ✓', async () => {
    await renderSidebar(['/vault', '/data/notes', '/data/screenshots']);

    await click(switchButton());

    const items = Array.from(container.querySelectorAll<HTMLElement>('[data-context-menu-item]'));
    // 分隔线不产生按钮，所以是 1（切换）+ 3（最近）条
    expect(items.map((item) => item.dataset.contextMenuItem)).toEqual([
      'switch-workspace',
      'recent-/vault',
      'recent-/data/notes',
      'recent-/data/screenshots'
    ]);

    // 文案是**目录名**，完整路径进 title —— 一列绝对路径会把面板旁的下拉撑得很宽
    expect(menuItem('recent-/data/screenshots')?.textContent).toBe('screenshots');
    expect(menuItem('recent-/data/screenshots')?.getAttribute('title')).toBe('/data/screenshots');

    // 当前根就是 `/vault`：它是「生效项」，用 ✓ 与 accent 标出（同 ContextMenu 的判据）
    const current = menuItem('recent-/vault');
    expect(current?.getAttribute('aria-checked')).toBe('true');
    expect(current?.className).toContain('nexus-context-menu-item-checked');
    // 别的项是「存在但没生效」：`aria-checked="false"`，不画 ✓
    expect(menuItem('recent-/data/notes')?.getAttribute('aria-checked')).toBe('false');
  });

  it('点第一项走选择框（不传路径），点最近项直接切过去', async () => {
    await renderSidebar(['/vault', '/data/notes']);

    await click(switchButton());
    await click(menuItem('switch-workspace'));
    expect(onSwitchWorkspace).toHaveBeenCalledTimes(1);

    // 点完菜单自己关掉：留着的话下一次点按钮会看到「旧的菜单还在原地」
    expect(container.querySelector('.nexus-context-menu')).toBeNull();

    await click(switchButton());
    await click(menuItem('recent-/data/notes'));
    // 传的是**完整路径**—— 显示名被缩成了目录名，不能让调用方也只剩一个缩写的
    expect(onOpenRecentWorkspace).toHaveBeenCalledWith('/data/notes');
    expect(onSwitchWorkspace).toHaveBeenCalledTimes(1);
  });

  it('再按一次按钮关掉菜单（anchorRef 契约）', async () => {
    await renderSidebar(['/vault']);

    await click(switchButton());
    expect(container.querySelector('.nexus-context-menu')).not.toBeNull();

    await click(switchButton());
    expect(container.querySelector('.nexus-context-menu')).toBeNull();
  });

  it('没有最近工作区时只有「切换工作区…」一项，且没有分隔线', async () => {
    await renderSidebar([]);

    await click(switchButton());

    const items = Array.from(container.querySelectorAll('[data-context-menu-item]'));
    expect(items).toHaveLength(1);
    expect(container.querySelector('[role="separator"]')).toBeNull();
  });

  it('没接 `onSwitchWorkspace` 时整枚按钮不渲染', async () => {
    // 点开是一个空菜单，比没有按钮更难解释 —— 所以整个入口都不该出现
    currentRecent = ['/vault'];
    (window as unknown as { nexus: unknown }).nexus = {
      rebuildIndex: vi.fn(async () => ({ ...OK_RESULT })),
      listIndexedDocuments: vi.fn(async () => [] as IndexedDocument[]),
      listWorkspaceDirectories: vi.fn(async () => [])
    };
    await act(async () => {
      root.render(
        <WorkspaceSidebar
          rootPath="/vault"
          activeFilePath={null}
          onOpenFile={vi.fn()}
          showImages
          recentWorkspaces={currentRecent}
          onShowImagesChange={vi.fn()}
          onCreateFile={vi.fn(async () => null)}
          onCreateFolder={vi.fn(async () => null)}
          onDeleteFile={vi.fn()}
          onRefresh={vi.fn(async () => [])}
        />
      );
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const phase = container
        .querySelector('.nexus-workspace-sidebar')
        ?.getAttribute('data-phase');
      if (phase === 'ready' || phase === 'error') break;
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(switchButton()).toBeNull();
  });
});
