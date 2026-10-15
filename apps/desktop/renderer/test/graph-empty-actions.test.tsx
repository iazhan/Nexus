// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';

/**
 * 图谱**真·空态**（工作区一篇文档都没有）里的两枚按钮。
 *
 * 这一层只能渲染整个 `App` —— 「新建文档」要走 `new-file` 的**同一条**处理函数、
 * 「打开搜索」要展开活动栏的搜索那一屏，两者都是宿主的动作，图谱面板自己不知道它们是什么
 * （面板只拿到两个回调，那一条在 `graph-panel.test.tsx` 里验）。
 *
 * 判据的重点是**同源**：从这个入口新建，必须与 Ctrl+N 得到一模一样的结果。
 * 两条入口各写一份实现的话，最常见的偏差是「这个入口新建的不落标签页 / 不进索引」——
 * 那种偏差单看任何一边都是对的。
 */

const nexusStub = {
  getLaunchContext: vi.fn(),
  openWorkspace: vi.fn(),
  listRecentWorkspaces: vi.fn().mockResolvedValue([]),
  openFile: vi.fn(),
  readFile: vi.fn().mockResolvedValue(''),
  writeFile: vi.fn().mockResolvedValue(undefined),
  setDirty: vi.fn(),
  watchFile: vi.fn(() => () => {}),
  onSaveAndCloseRequested: vi.fn().mockReturnValue(() => {}),
  readyToClose: vi.fn(),
  closeWindow: vi.fn(),
  minimizeWindow: vi.fn(),
  maximizeWindow: vi.fn(),
  getWindowState: vi.fn().mockResolvedValue({ maximized: false }),
  onWindowStateChanged: vi.fn().mockReturnValue(() => {}),
  rebuildIndex: vi.fn().mockResolvedValue({ errors: [] }),
  // 空工作区：图上一个节点都没有 → 走真·空态那一支
  listIndexedDocuments: vi.fn().mockResolvedValue([]),
  listWorkspaceDirectories: vi.fn().mockResolvedValue([]),
  getGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
  getGraphOrphans: vi.fn().mockResolvedValue([]),
  getGraphHubs: vi.fn().mockResolvedValue([]),
  getGraphDeadLinks: vi.fn().mockResolvedValue([])
};

/** 工作区模式、已经有根。 */
const WORKSPACE_LAUNCH = {
  mode: 'workspace',
  filePath: null,
  documentType: null,
  workspaceRoot: 'D:/vault',
  unsupportedPath: null
};

/** happy-dom 没有 ResizeObserver；图谱靠它量画布。 */
class StubResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

describe('图谱真·空态的动作', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function waitForSelector(selector: string, timeoutMs = 5000): Promise<HTMLElement> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = container.querySelector<HTMLElement>(selector);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`等待 ${selector} 超时`);
  }

  async function waitForGone(selector: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!container.querySelector(selector)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`等待 ${selector} 消失超时`);
  }

  /** 进入图谱视图（它是主区视图，不是侧栏里的一块）。 */
  async function openGraph(): Promise<void> {
    root.render(React.createElement(App));
    await waitForSelector('.nexus-workspace-sidebar[data-phase="ready"]');
    (await waitForSelector('.nexus-activity-icon[data-activity="graph"]')).click();
    await waitForSelector('.nexus-graph');
  }

  /** 「新建文档」的可观察结果：一个未命名的编辑标签页。 */
  const newDocumentShape = () => ({
    tabs: container.querySelectorAll('.nexus-tab').length,
    label: container.querySelector('.nexus-tab')?.textContent ?? '',
    hasEditor: container.querySelector('.cm-content') !== null
  });

  beforeEach(() => {
    // 每次 `render` 都是一次重启：上一条用例开过的标签页会写进会话快照，下一条恢复回来
    localStorage.clear();
    (window as unknown as { nexus: typeof nexusStub }).nexus = nexusStub;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    nexusStub.getLaunchContext.mockResolvedValue(WORKSPACE_LAUNCH);
    nexusStub.listRecentWorkspaces.mockResolvedValue([]);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    for (const spy of Object.values(nexusStub)) spy.mockClear();
  });

  it('点「新建文档」：与 Ctrl+N 得到同一个结果', async () => {
    /*
      先走快捷键，把「正确的结果」量出来；再换一个干净的 App 走空态里那枚按钮。
      不比较「调用了哪个函数」而比较**可观察状态** —— 那才是用户能看出差别的层面。
    */
    root.render(React.createElement(App));
    await waitForSelector('.nexus-workspace-sidebar[data-phase="ready"]');
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true })
    );
    await waitForSelector('.cm-content');
    const fromShortcut = newDocumentShape();
    expect(fromShortcut.tabs).toBe(1);
    expect(fromShortcut.label).toContain('Untitled');

    // 换一个干净的实例（上一次的标签页已经写进会话快照了）
    root.unmount();
    localStorage.clear();
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await openGraph();

    // 真·空态：不画画布，也不给「显示全部」（那是被筛空那档的出路）
    expect(container.querySelector('.nexus-graph-canvas')).toBeNull();
    expect(container.querySelector('[data-action="reset-filters"]')).toBeNull();

    const create = await waitForSelector('[data-action="new-document"]');
    create.click();

    // 图谱退场（主区要显示新建的那篇），编辑区回来
    await waitForGone('.nexus-graph');
    await waitForSelector('.cm-content');
    expect(newDocumentShape()).toEqual(fromShortcut);
  }, 20000);

  it('点「搜索」：活动栏展开搜索那一屏', async () => {
    await openGraph();

    const search = await waitForSelector('[data-action="open-search"]');
    search.click();

    // 图谱退场 —— 它是主区视图，而搜索在活动栏面板里，两者不能同时占位
    await waitForGone('.nexus-graph');
    expect(
      container
        .querySelector('.nexus-activity-icon[data-activity="search"]')
        ?.getAttribute('aria-pressed')
    ).toBe('true');
    // 面板真的展开了（不是「灯亮了但什么都没出来」）
    expect(
      container
        .querySelector('.nexus-activity-panel')
        ?.classList.contains('nexus-activity-panel-open')
    ).toBe(true);
    expect(container.querySelector('.nexus-search')).not.toBeNull();
  }, 20000);
});
