// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from '../src/App.js';
import type { WorkspaceGraph } from '@nexus/core';

/**
 * 图谱视图：图谱占**主区**（编辑区的位置）。
 *
 * 这一层只能渲染整个 `App` 来测 —— 「图谱让编辑区让位」是 `App.tsx` 里
 * `graphViewActive` 一个派生值的事，图谱自己（`graph-panel.test.tsx`）与画布算法
 * （`graph-layout.test.ts`）都不知道主区的存在。
 *
 * 三条判据，对应这个功能的三个面：
 *
 * 1. **切进去**：点「图谱」图标 → 编辑区整块不画（连标签栏），主区换成图谱，
 *    侧栏**整块隐藏**（图要的是「一屏图」）。
 * 2. **打开文档就退场**：图谱视图里打开文档 → 编辑区与侧栏一起回来。漏了这条的症状是
 *    「点了文件、文档开了、界面却什么都没变」—— 而打开文档的路有七八条，
 *    所以判据是「活动文档换了」这一件事，不是某个回调。
 * 3. **再点一次图标就退场**：收起面板等于关掉图谱视图，编辑区回来。
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
  listIndexedDocuments: vi.fn().mockResolvedValue([]),
  listWorkspaceDirectories: vi.fn().mockResolvedValue([]),
  // 空图不画 canvas（见 `GraphPanel` 的空态分支），所以给两条节点让 `.nexus-graph-canvas` 在。
  getGraph: vi.fn().mockResolvedValue({
    nodes: [
      { kind: 'document', id: 1, path: 'D:/vault/a.md', relativePath: 'a.md', name: 'a.md', type: 'markdown', degree: 1 },
      { kind: 'document', id: 2, path: 'D:/vault/b.md', relativePath: 'b.md', name: 'b.md', type: 'markdown', degree: 1 }
    ],
    edges: [{ source: 1, target: 2 }]
  } as WorkspaceGraph)
};

/** 工作区模式、已经有根、有一篇根目录下的笔记。 */
const WORKSPACE_LAUNCH = {
  mode: 'workspace',
  filePath: null,
  documentType: null,
  workspaceRoot: 'D:/vault',
  unsupportedPath: null
};

const OPENED_DOC = { path: 'D:/vault/a.md', content: '# a', readOnly: false };

/** happy-dom 没有 ResizeObserver；图谱靠它量画布。 */
class StubResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

describe('图谱视图：图谱占编辑区', () => {
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

  /** 等某个选择器消失（图谱退场、编辑区回来都用它）。 */
  async function waitForGone(selector: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!container.querySelector(selector)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`等待 ${selector} 消失超时`);
  }

  beforeEach(() => {
    // 每次 `render` 都是一次**重启**：上一条用例开过的文档会写进会话快照
    // （`nexus-session-tabs`，见 `session-persistence.ts`），下一条启动时被恢复回来。
    // 不清掉的话，「退出图谱后主区回到空态」这条会读到上一条的文档。
    localStorage.clear();
    (window as unknown as { nexus: typeof nexusStub }).nexus = nexusStub;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    nexusStub.getLaunchContext.mockResolvedValue(WORKSPACE_LAUNCH);
    nexusStub.openFile.mockImplementation(async (path: string) => ({ ...OPENED_DOC, path }));
    nexusStub.listIndexedDocuments.mockResolvedValue([
      {
        id: 0,
        path: 'D:/vault/a.md',
        relativePath: 'a.md',
        name: 'a.md',
        title: 'a',
        type: 'markdown',
        sizeBytes: 3,
        modifiedAtMs: 1,
        contentHash: 'x',
        extractionStatus: 'none'
      }
    ]);
    nexusStub.listWorkspaceDirectories.mockResolvedValue([]);
    nexusStub.listRecentWorkspaces.mockResolvedValue([]);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    for (const spy of Object.values(nexusStub)) spy.mockClear();
  });

  it('点「图谱」图标：编辑区整块让位，主区换成图谱，侧栏整块隐藏', async () => {
    root.render(React.createElement(App));
    await waitForSelector('.nexus-workspace-sidebar[data-phase="ready"]');

    // 前置条件：现在还是编辑区（空态），树上有那一篇笔记
    await waitForSelector('[data-relative-path="a.md"]');

    (await waitForSelector('.nexus-activity-icon[data-activity="graph"]')).click();

    // 图谱进了主区
    const graph = await waitForSelector('.nexus-graph');
    expect(graph.getAttribute('data-variant')).toBe('main');
    await waitForSelector('.nexus-graph-canvas');

    // 编辑区整块不画 —— 连空态、标签栏、工具栏一起（图谱要的是「一屏图」）。
    // 不断 `.nexus-filename`：那个 span 在标题栏里，工作区模式下它显示的是根目录名，
    // 本来就不属于编辑区。
    expect(container.querySelector('.nexus-workspace-empty')).toBeNull();
    expect(container.querySelector('.nexus-tab')).toBeNull();
    expect(container.querySelector('.nexus-editor-toolbar')).toBeNull();
    expect(container.querySelector('.cm-content')).toBeNull();

    // 侧栏整块隐藏：slot 挂 hidden 类，可见性归 CSS。工作区侧栏**仍然挂载**
    // （保留挂载是刻意的：切回来不用重跑索引），只是不显示；侧栏里也没有第二份图谱。
    expect(container.querySelector('.nexus-activity-panel .nexus-workspace-sidebar')).not.toBeNull();
    expect(
      container
        .querySelector('.nexus-activity-panel .nexus-workspace-sidebar')
        ?.closest('.nexus-panel-slot')
        ?.classList.contains('nexus-panel-slot-hidden')
    ).toBe(true);
    expect(container.querySelector('.nexus-activity-panel .nexus-graph')).toBeNull();

    // 灯亮 ⇔ 图在主区（`aria-pressed` 由 `activeId && panelOpen` 派生）
    expect(
      container
        .querySelector('.nexus-activity-icon[data-activity="graph"]')
        ?.getAttribute('aria-pressed')
    ).toBe('true');
  }, 15000);

  it('图谱视图里打开文档：编辑区与侧栏一起回来，图谱退场', async () => {
    root.render(React.createElement(App));
    await waitForSelector('.nexus-workspace-sidebar[data-phase="ready"]');
    (await waitForSelector('.nexus-activity-icon[data-activity="graph"]')).click();
    await waitForSelector('.nexus-graph-canvas');

    // 在图谱视图里打开那一篇。树虽然被隐藏（`display: none`）但仍挂载着，
    // happy-dom 不应用 CSS，所以这一击照样走到打开链上；要验的正是这条退场路径。
    (await waitForSelector('[data-relative-path="a.md"]')).click();

    // 编辑区回来了，图谱整块卸载。
    // 不断 `.nexus-filename`：它在标题栏里，工作区模式下显示的是根目录名，
    // 图谱视图期间也「在」。用**树上的选中态**当「文档开了」的判据。
    await waitForGone('.nexus-graph');
    await waitForSelector('[data-relative-path="a.md"][data-selected="true"]');
    // 侧栏跟着回到「选中的是工作区」这一屏（既亮了灯，也去掉了 hidden）
    expect(
      container
        .querySelector('.nexus-activity-icon[data-activity="workspace"]')
        ?.getAttribute('aria-pressed')
    ).toBe('true');
    expect(
      container
        .querySelector('.nexus-activity-panel .nexus-workspace-sidebar')
        ?.closest('.nexus-panel-slot')
        ?.classList.contains('nexus-panel-slot-hidden')
    ).toBe(false);
  }, 15000);

  it('再点一次「图谱」图标：连侧栏一起回到文件树', async () => {
    root.render(React.createElement(App));
    await waitForSelector('.nexus-workspace-sidebar[data-phase="ready"]');
    (await waitForSelector('.nexus-activity-icon[data-activity="graph"]')).click();
    await waitForSelector('.nexus-graph-canvas');

    (await waitForSelector('.nexus-activity-icon[data-activity="graph"]')).click();

    await waitForGone('.nexus-graph');
    // 没有文档可显示，所以主区回到空态 —— 那正是图谱让位前的样子
    await waitForSelector('.nexus-workspace-empty');
    // 侧栏跟着回来：退出图谱的终点是文件树，不是「灯灭了、侧栏还不知道回哪」
    expect(
      container
        .querySelector('.nexus-activity-icon[data-activity="workspace"]')
        ?.getAttribute('aria-pressed')
    ).toBe('true');
    expect(
      container
        .querySelector('.nexus-activity-panel .nexus-workspace-sidebar')
        ?.closest('.nexus-panel-slot')
        ?.classList.contains('nexus-panel-slot-hidden')
    ).toBe(false);
  }, 15000);

  it('没进图谱视图时主区是编辑区（默认状态，防止派生值恒真）', async () => {
    root.render(React.createElement(App));
    await waitForSelector('.nexus-workspace-sidebar[data-phase="ready"]');
    // 空态也算编辑区那一屏：图谱不在
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector('.nexus-graph')).toBeNull();
  }, 15000);
});
