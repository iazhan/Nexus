// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from '../src/App.js';

/**
 * 「打开 / 切换工作区」这条链的**渲染进程那一半**。
 *
 * 这一半只能在 happy-dom 里渲染整个 `App` 来测：那几条入口（欢迎态的「打开文件夹」、
 * 菜单里的「打开文件夹…」「打开最近的工作区 ▸」「在工作区中打开」）都要弹**原生**目录
 * 选择框或走整条状态切换链，真机用例（CDP）点不到对话框，拿不到后面的状态。
 * 主进程那一半（授权 + 记回落目标）在 `workspace-mode.test.ts` 里从桥上调 `openWorkspace` 验。
 *
 * ## 为什么两半必须分开，不能只留一半
 *
 * 直接从桥上调 `openWorkspace` **不会**让界面切到工作区 —— 切状态发生在
 * `App.handleOpenWorkspace` 里（所有入口共用的那一层）。
 * 于是：只测桥会漏掉「点了没反应」，只测渲染会漏掉「没真的授权」。
 *
 * ## 「在工作区中打开」的两种状态
 *
 * 它现在的语义是「把当前文档放进工作区上下文，并在树里定位到它」：
 * - **还没有工作区** → 调桥，把文档**所在的目录**开成工作区（下面第一条）；
 * - **已经在工作区里** → **不调桥**（再按文档所在目录开一次会把根收窄到那个子目录），
 *   只做定位（下面第二条）。
 *
 * ## 三个「开工作区」的入口，一个动作
 *
 * 欢迎态那枚按钮、菜单的「打开文件夹…」、命令面板的 `open-folder` 都走
 * `handleOpenWorkspace`（不给路径 = 弹框）。「打开最近的工作区 ▸」给它一个路径，
 * 是同一个函数的另一档。
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
    // 上面那些 `mockResolvedValue` 会跨用例残留（`mockClear` 只清调用记录），
    // 所以每一条都显式复位 —— 否则前一条设的「最近工作区」会漏到下一条里。
    nexusStub.listRecentWorkspaces.mockResolvedValue([]);
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
   * 展开「文件」菜单。找不到那个按钮时把 DOM 打出来 —— 比「点了个 null」好查得多。
   *
   * **已经开着就直接返回**：菜单是点一下开、再点一下关，无脑点第二遍会把它关掉，
   * 而调用方（比如「先等列表到位，再点子项」）并不知道它此刻是开是关。
   */
  async function openFileMenu(): Promise<void> {
    if (container.querySelector('[data-menu="file"] .nexus-menu-dropdown')) return;

    const trigger = Array.from(container.querySelectorAll<HTMLButtonElement>('.nexus-menu-bar-button')).find(
      (element) => /^(File|文件)$/.test(element.textContent?.trim() ?? '')
    );
    if (!trigger) throw new Error(`找不到「文件」菜单：${container.innerHTML}`);
    trigger.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  /**
   * 点「文件」菜单里的一项。
   *
   * **按 `data-menu-item` 找，不按文案**：文案跟着语言变（下面这批用例原本两种语言各试一遍），
   * 而「打开最近的工作区」里也含「工作区」三个字 —— 按正则找会命中错的那一条，
   * 表现成「点了没反应」。菜单项的 `id` 是为此加的锚点。
   */
  async function clickFileMenuItem(id: string): Promise<void> {
    await openFileMenu();
    const item = container.querySelector<HTMLButtonElement>(`.nexus-menu-item[data-menu-item="${id}"]`);
    if (!item) throw new Error(`找不到菜单项 ${id}：${container.innerHTML}`);
    item.click();
  }

  /**
   * 展开「文件 → 打开最近的工作区」那一层，返回二级里的项。
   *
   * 二级是**点父项**展开的（真机上是悬停，`pointerenter` 在这里不好派发，
   * 而点父项与悬停走的是同一个状态）。
   */
  async function openRecentSubmenu(): Promise<HTMLButtonElement[]> {
    await openFileMenu();
    const parent = container.querySelector<HTMLButtonElement>(
      '.nexus-menu-item[data-menu-item="open-recent-workspace"]'
    );
    if (!parent) throw new Error(`找不到「打开最近的工作区」：${container.innerHTML}`);
    parent.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    return Array.from(
      container.querySelectorAll<HTMLButtonElement>('.nexus-menu-submenu .nexus-menu-item')
    );
  }

  /**
   * 等「打开最近的工作区」那一项从禁用变成可用 —— **它就是「列表拉回来了」的信号**。
   *
   * 列表是挂载后异步拉的（菜单是同步渲染的，拿不到就只能禁用），所以点菜单之前要等它。
   * 用这一项自己的 `disabled` 而不是猜一个延时：延时是「看起来好了」，这个是真的好了。
   */
  async function waitForRecentReady(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const item = container.querySelector<HTMLButtonElement>(
        '.nexus-menu-item[data-menu-item="open-recent-workspace"]'
      );
      if (item && !item.disabled) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('等待最近工作区列表超时');
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

      await clickFileMenuItem('open-in-workspace');

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

      await clickFileMenuItem('open-in-workspace');
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
      await clickFileMenuItem('open-in-workspace');
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(nexusStub.openWorkspace).not.toHaveBeenCalled();
      // 定位落地：那一行被选中（展开祖先 + 滚进视野由侧栏自己那批用例覆盖）
      expect(
        container.querySelector('[data-relative-path="notes/a.md"]')?.getAttribute('data-selected')
      ).toBe('true');
    });
  });

  /**
   * 「打开 / 切换工作区」的两条菜单入口。
   *
   * 这一组是**渲染进程那一半**：真机用例点不到原生目录选择框，而「最近的工作区」那层
   * 子菜单的数据来自主进程（`listRecentWorkspaces`）—— 两边各测一半，合起来才算覆盖。
   *
   * 「打开文件夹」在工作区模式下**也留着**是重点：它从前只在欢迎态出现，于是已经在
   * 工作区里的人根本没有换一个的办法。所以这里用的是 `WORKSPACE_LAUNCH` 而不是裸启动。
   */
  describe('菜单：打开文件夹 / 打开最近的工作区', () => {
    beforeEach(() => {
      nexusStub.getLaunchContext.mockResolvedValue(WORKSPACE_LAUNCH);
    });

    it('「打开文件夹…」在工作区里也可点，且**不带路径**调桥（目录由主进程弹框给）', async () => {
      root.render(React.createElement(App));
      await waitForSelector('.nexus-workspace-sidebar[data-phase="ready"]');

      await clickFileMenuItem('open-folder');

      expect(nexusStub.openWorkspace).toHaveBeenCalledTimes(1);
      expect(nexusStub.openWorkspace.mock.calls[0]?.[0]).toBeUndefined();
    });

    it('一个都没记过时那一项**禁用**，而不是从菜单里消失', async () => {
      nexusStub.listRecentWorkspaces.mockResolvedValue([]);

      root.render(React.createElement(App));
      await waitForSelector('.nexus-workspace-sidebar[data-phase="ready"]');
      await openFileMenu();

      const item = container.querySelector<HTMLButtonElement>(
        '.nexus-menu-item[data-menu-item="open-recent-workspace"]'
      );
      // 位置忽有忽无比灰着一格更难理解 —— 用户下次找它得先猜它为什么不在。
      expect(item).not.toBeNull();
      expect(item?.disabled).toBe(true);
    });

    it('列出主进程给的那一列（顺序原样），点一条就带着那个路径开', async () => {
      nexusStub.listRecentWorkspaces.mockResolvedValue(['D:/notes', 'E:/second']);
      nexusStub.openWorkspace.mockResolvedValue('E:/second');

      root.render(React.createElement(App));
      await waitForSelector('.nexus-workspace-sidebar[data-phase="ready"]');
      await openFileMenu();
      await waitForRecentReady();

      const entries = await openRecentSubmenu();
      expect(entries.map((el) => el.textContent)).toEqual(['D:/notes', 'E:/second']);

      entries[1]!.click();
      await new Promise((resolve) => setTimeout(resolve, 80));

      // 带着**被点的那一条**去开，不是列表里的第一条。
      expect(nexusStub.openWorkspace).toHaveBeenCalledTimes(1);
      expect(nexusStub.openWorkspace.mock.calls[0]?.[0]).toBe('E:/second');
      // 开完菜单要收掉，不留一层展开的菜单挡在界面上。
      expect(container.querySelector('.nexus-menu-dropdown')).toBeNull();
    });

    it('开完之后重新拉一次列表 —— 刚开的那个要立刻出现在里面', async () => {
      nexusStub.listRecentWorkspaces.mockResolvedValue(['D:/notes']);
      nexusStub.openWorkspace.mockResolvedValue('E:/second');

      root.render(React.createElement(App));
      await waitForSelector('.nexus-workspace-sidebar[data-phase="ready"]');
      await openFileMenu();
      await waitForRecentReady();

      const before = nexusStub.listRecentWorkspaces.mock.calls.length;

      await clickFileMenuItem('open-folder');
      await new Promise((resolve) => setTimeout(resolve, 80));

      // 不刷新的话，这一次开的工作区要等下次启动才出现在「打开最近的工作区」里。
      expect(nexusStub.listRecentWorkspaces.mock.calls.length).toBeGreaterThan(before);
    });
  });
});
