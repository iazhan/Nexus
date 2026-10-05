// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from '../src/App.js';

/**
 * 「打开工作区」这条链的**渲染进程那一半**。
 *
 * 这一半只能在 happy-dom 里渲染整个 `App` 来测：那两条入口（欢迎态的「打开文件夹」、
 * 菜单里的「在工作区中打开」）都要弹**原生**目录选择框或走整条状态切换链，
 * 真机用例（CDP）点不到对话框，拿不到后面的状态。主进程那一半（授权 + 记回落目标）
 * 在 `workspace-mode.test.ts` 里从桥上调 `openWorkspace` 验。
 *
 * ## 为什么两半必须分开，不能只留一半
 *
 * 直接从桥上调 `openWorkspace` **不会**让界面切到工作区 —— 切状态发生在
 * `App.handleOpenWorkspace` 里（两条入口共用的那一层）。
 * 于是：只测桥会漏掉「点了没反应」，只测渲染会漏掉「没真的授权」。
 *
 * ## 「在工作区中打开」的两种状态
 *
 * 它现在的语义是「把当前文档放进工作区上下文，并在树里定位到它」：
 * - **还没有工作区** → 调桥，把文档**所在的目录**开成工作区（下面第一条）；
 * - **已经在工作区里** → **不调桥**（再按文档所在目录开一次会把根收窄到那个子目录），
 *   只做定位（下面第二条）。
 */

const nexusStub = {
  getLaunchContext: vi.fn(),
  openWorkspace: vi.fn(),
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
  // 侧栏挂载时会走一次索引；这几条只是让它别停在错误态，本文件不验索引本身。
  rebuildIndex: vi.fn().mockResolvedValue({ errors: [] }),
  listIndexedDocuments: vi.fn().mockResolvedValue([]),
  listWorkspaceDirectories: vi.fn().mockResolvedValue([])
};

/** 裸启动的形状：工作区模式、还没有目录 ⇒ 欢迎态。 */
const BARE_LAUNCH = {
  mode: 'workspace',
  filePath: null,
  documentType: null,
  workspaceRoot: null,
  unsupportedPath: null
};

/** 轻量模式打开一个文件：有文档、没有工作区。 */
const LIGHTWEIGHT_LAUNCH = {
  mode: 'lightweight',
  filePath: 'D:/notes/a.md',
  documentType: 'markdown',
  workspaceRoot: null,
  unsupportedPath: null
};

/** 工作区模式、已经有根：没有文档，文档要从树里挑。 */
const WORKSPACE_LAUNCH = {
  mode: 'workspace',
  filePath: null,
  documentType: null,
  workspaceRoot: 'D:/vault',
  unsupportedPath: null
};

const OPENED_DOC = { path: 'D:/notes/a.md', content: '# a', readOnly: false };

/** 编辑器就绪的接缝。`App` 挂上去（与冒烟测试同一套），比按 DOM 猜稳。 */
const testWindow = window as Window & { nexusActiveView?: unknown };

describe('打开工作区：渲染进程那一半', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (window as unknown as { nexus: typeof nexusStub }).nexus = nexusStub;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    nexusStub.getLaunchContext.mockResolvedValue(BARE_LAUNCH);
    nexusStub.openWorkspace.mockResolvedValue('D:/picked');
    // 回显调用方给的路径：真实主进程就是这么做的，写死一个会让「用的是哪条路径」
    // 这件事在断言里失去意义。
    nexusStub.openFile.mockImplementation(async (path: string) => ({
      ...OPENED_DOC,
      path
    }));
    nexusStub.listIndexedDocuments.mockResolvedValue([]);
    nexusStub.listWorkspaceDirectories.mockResolvedValue([]);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    delete testWindow.nexusActiveView;
    for (const spy of Object.values(nexusStub)) spy.mockClear();
  });

  async function waitForSelector(selector: string, timeoutMs = 5000): Promise<Element> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = container.querySelector(selector);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`等待 ${selector} 超时`);
  }

  /**
   * 等编辑器真的挂上。
   *
   * **不能拿「根节点在不在」当判据** —— `.nexus-app-root` 在 `getLaunchContext` 还没
   * resolve 时就已经在那儿了。等一个立刻成立的条件，等于什么都没等，后面的点击会
   * 打在一个还没打开文档的界面上（菜单项此时是禁用的），表现成「功能没生效」。
   */
  async function waitForEditor(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (testWindow.nexusActiveView) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('等待编辑器就绪超时');
  }

  /**
   * 点菜单里的某一项。
   *
   * 菜单项**没有 `data-*` 锚点**，只能按文案找 —— 所以两种语言都试一遍：
   * 断言英文文案会让用例在中文机器上红，反过来也一样。
   */
  async function clickMenuItem(pattern: RegExp): Promise<void> {
    const trigger = Array.from(container.querySelectorAll<HTMLButtonElement>('.nexus-menu-bar-button')).find(
      (element) => /^(File|文件)$/.test(element.textContent?.trim() ?? '')
    );
    if (!trigger) throw new Error(`找不到「文件」菜单：${container.innerHTML}`);
    trigger.click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const item = Array.from(container.querySelectorAll<HTMLButtonElement>('.nexus-menu-item')).find(
      (element) => pattern.test(element.textContent?.trim() ?? '')
    );
    if (!item) throw new Error(`找不到菜单项 ${pattern}`);
    item.click();
  }

  describe('欢迎态：点「打开文件夹」', () => {
    it('点一下：调桥（不带路径，让主进程弹框）、拿到目录后外壳挂起来', async () => {
      root.render(React.createElement(App));

      const button = (await waitForSelector('[data-workspace-open-folder]')) as HTMLButtonElement;
      // 前置条件：欢迎态那一屏在，且还没有外壳。
      expect(container.querySelector('.nexus-activity-bar')).toBeNull();

      button.click();

      await waitForSelector('.nexus-activity-bar');

      expect(nexusStub.openWorkspace).toHaveBeenCalledTimes(1);
      // **不带路径** —— 目录由主进程的目录选择框给，渲染进程不猜一个。
      expect(nexusStub.openWorkspace.mock.calls[0]?.[0]).toBeUndefined();
      // 拿到目录之后欢迎态退场。
      expect(container.querySelector('[data-workspace-open-folder]')).toBeNull();
    });

    it('用户取消（桥返回 null）时留在欢迎态，不挂外壳', async () => {
      nexusStub.openWorkspace.mockResolvedValue(null);

      root.render(React.createElement(App));

      const button = (await waitForSelector('[data-workspace-open-folder]')) as HTMLButtonElement;
      button.click();

      // 状态更新留一拍。取消是正常结局，什么都不该发生。
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(container.querySelector('[data-workspace-open-folder]')).not.toBeNull();
      expect(container.querySelector('.nexus-activity-bar')).toBeNull();
    });
  });

  describe('轻量模式：菜单里的「在工作区中打开」', () => {
    it('把文档**所在的目录**交给桥（不是文件路径），拿到根之后外壳挂起来', async () => {
      nexusStub.getLaunchContext.mockResolvedValue(LIGHTWEIGHT_LAUNCH);
      nexusStub.openWorkspace.mockResolvedValue('D:/notes');

      root.render(React.createElement(App));
      await waitForEditor();

      await clickMenuItem(/Workspace|工作区/);

      await waitForSelector('.nexus-activity-bar');

      expect(nexusStub.openWorkspace).toHaveBeenCalledTimes(1);
      // 传的是**目录**：`D:/notes/a.md` → `D:/notes`。
      // 传文件路径的话主进程会把一个文件当工作区根，索引 walker 直接走空。
      expect(nexusStub.openWorkspace.mock.calls[0]?.[0]).toBe('D:/notes');
    });

    it('桥返回 null（用户取消了目录授权）时留在原状，不挂外壳', async () => {
      nexusStub.getLaunchContext.mockResolvedValue(LIGHTWEIGHT_LAUNCH);
      nexusStub.openWorkspace.mockResolvedValue(null);

      root.render(React.createElement(App));
      await waitForEditor();

      await clickMenuItem(/Workspace|工作区/);
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(nexusStub.openWorkspace).toHaveBeenCalledTimes(1);
      expect(container.querySelector('.nexus-activity-bar')).toBeNull();
    });
  });

  describe('已在工作区里：菜单里的「在工作区中打开」', () => {
    beforeEach(() => {
      nexusStub.getLaunchContext.mockResolvedValue(WORKSPACE_LAUNCH);
      nexusStub.listIndexedDocuments.mockResolvedValue([
        {
          id: 0,
          path: 'D:/vault/notes/a.md',
          relativePath: 'notes/a.md',
          name: 'a.md',
          title: 'a',
          type: 'markdown',
          sizeBytes: 3,
          modifiedAtMs: 1,
          contentHash: 'x',
          extractionStatus: 'none'
        }
      ]);
      nexusStub.listWorkspaceDirectories.mockResolvedValue([
        { path: 'D:/vault/notes', relativePath: 'notes', name: 'notes' }
      ]);
    });

    it('**不再调桥**（那会把工作区收窄到文档所在的子目录），只在树里定位到它', async () => {
      root.render(React.createElement(App));
      await waitForSelector('.nexus-workspace-sidebar[data-phase="ready"]');

      // 先打开树里那个文档，才有「当前文档」可言
      const row = (await waitForSelector('[data-relative-path="notes/a.md"]')) as HTMLElement;
      row.click();
      await waitForEditor();

      // 菜单项此刻必须是**可用的**：从前它在工作区里被禁用，而那时恰恰是用户最想问
      // 「这个文件在工作区里哪儿」的时候。
      await clickMenuItem(/Workspace|工作区/);
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(nexusStub.openWorkspace).not.toHaveBeenCalled();
      // 定位落地：那一行被选中（展开祖先 + 滚进视野由侧栏自己那批用例覆盖）
      expect(
        container.querySelector('[data-relative-path="notes/a.md"]')?.getAttribute('data-selected')
      ).toBe('true');
    });
  });
});
