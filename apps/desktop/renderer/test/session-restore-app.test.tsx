// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from '../src/App.js';
import { settings } from '../src/platform.js';
import { SESSION_TABS_STORAGE_KEY } from '../src/workspace/session-persistence.js';

/**
 * 「重启后接着上次的地方继续」的**渲染进程那一半**（2026-10-14）。
 *
 * 完整的一件事有三半：
 * - 主进程把**工作区根**接回来（`recent-workspace.test.ts`，纯函数）；
 * - 真机上第二次启动读到根、索引重建、树画出来（`workspace-mode.test.ts` 一类）；
 * - **这一半**：渲染进程把根里开着的**文档**接回来 —— 只能在 happy-dom 里渲染
 *   整个 `App` 来测，因为真机用例点不到 localStorage 预置的快照，
 *   而这条链的输入恰恰是「上次退出时写下的那份」。
 *
 * 所以这里的输入全部手工预置：`localStorage` 里放一份快照 + 一个工作区模式的
 * launchContext，然后断言 App 真的把文档开成了标签页。
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
  listWorkspaceDirectories: vi.fn().mockResolvedValue([])
};

/** 工作区模式、已经有根。 */
const WORKSPACE_LAUNCH = {
  mode: 'workspace',
  filePath: null,
  documentType: null,
  workspaceRoot: 'D:/vault',
  unsupportedPath: null
};

/** 上次开着的两个文档：一个 Markdown、一个 PDF（附件走另一条打开路径）。 */
const SNAPSHOT = {
  root: 'D:/vault',
  entries: [
    { path: 'D:/vault/notes/a.md', page: null },
    { path: 'D:/vault/manual.pdf', page: 7 }
  ],
  activePath: 'D:/vault/notes/a.md'
};

function seedSnapshot(snapshot: unknown): void {
  localStorage.setItem(SESSION_TABS_STORAGE_KEY, JSON.stringify(snapshot));
}

describe('启动时恢复上次打开的文档', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (window as unknown as { nexus: typeof nexusStub }).nexus = nexusStub;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.clear();

    nexusStub.getLaunchContext.mockResolvedValue(WORKSPACE_LAUNCH);
    // 回显调用方给的路径：真实主进程就是这么做的。
    nexusStub.openFile.mockImplementation(async (path: string) => ({
      path,
      content: `# ${path}`,
      readOnly: false
    }));
    // 树里得有这两个文件，否则「恢复后定位到那一行」断言无从谈起。
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

  afterEach(() => {
    root.unmount();
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    for (const spy of Object.values(nexusStub)) spy.mockClear();
  });

  async function waitForSelector(selector: string, timeoutMs = 5000): Promise<Element> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = container.querySelector(selector);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`等待 ${selector} 超时：${container.innerHTML.slice(0, 400)}`);
  }

  it('把快照里的文档开成标签页，Markdown 走 openFile、附件直接登记', async () => {
    seedSnapshot(SNAPSHOT);

    root.render(React.createElement(App));
    await waitForSelector('.nexus-tab-bar');

    // 两个标签页：顺序就是快照里的顺序
    const tabs = () => Array.from(container.querySelectorAll<HTMLElement>('.nexus-tab-name'));
    await waitForSelector('.nexus-tab');
    expect(tabs().map((tab) => tab.textContent)).toEqual(['a.md', 'manual.pdf']);

    // Markdown 走 IPC 读内容；PDF 不读（附件只登记路径，见 `openViewerDocumentAt`）
    expect(nexusStub.openFile).toHaveBeenCalledTimes(1);
    expect(nexusStub.openFile.mock.calls[0]?.[0]).toBe('D:/vault/notes/a.md');

    // 活动的是快照里那个 `activePath`
    const active = container.querySelector('.nexus-tab-active .nexus-tab-name');
    expect(active?.textContent).toBe('a.md');
  });

  it('恢复后把活动文档在树里定位出来（树默认是折叠的）', async () => {
    seedSnapshot(SNAPSHOT);

    root.render(React.createElement(App));
    // 那一行在 `notes/` 下面，而 `notes/` 此刻是折叠的 —— 能查到它就说明
    // 恢复流程替用户展开了祖先（否则「开着的文档在树里看不见」）。
    const row = await waitForSelector('[data-relative-path="notes/a.md"]');
    expect(row.getAttribute('data-selected')).toBe('true');
  });

  it('快照的根对不上时不恢复（那是另一个工作区的会话）', async () => {
    seedSnapshot({ ...SNAPSHOT, root: 'D:/other-vault' });

    root.render(React.createElement(App));
    await waitForSelector('.nexus-workspace-sidebar[data-phase="ready"]');
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(container.querySelector('.nexus-tab')).toBeNull();
    expect(nexusStub.openFile).not.toHaveBeenCalled();
  });

  it('关掉「恢复文档」时不恢复，存档也不留', async () => {
    // 走单例的 `set` 而不是直接写 localStorage：`settings.get()` 读的是构造时建起来的
    // 缓存，背后改盘对它不可见（这条坑 `settings-store.test.ts` 钉着）。
    settings.set('general.restoreTabs', false);
    seedSnapshot(SNAPSHOT);

    root.render(React.createElement(App));
    await waitForSelector('.nexus-workspace-sidebar[data-phase="ready"]');
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(container.querySelector('.nexus-tab')).toBeNull();
    // 存档被清掉：留着的话将来再打开，恢复出来的是关掉之前那一份
    expect(localStorage.getItem(SESSION_TABS_STORAGE_KEY)).toBeNull();
    // 复位，别漏到后面的用例（`beforeEach` 的 `localStorage.clear()` 擦不掉缓存）
    settings.set('general.restoreTabs', true);
  });

  it('恢复中某个文件已经不在了：跳过它，其余照常', async () => {
    seedSnapshot(SNAPSHOT);
    // PDF 被删了 —— 它不 IPC，但 Markdown 读不到要演示「坏条目不影响其余」。
    // 反过来更直接：让 Markdown 读不到，PDF 依旧登记。
    nexusStub.openFile.mockResolvedValue(null);

    root.render(React.createElement(App));
    await waitForSelector('.nexus-tab');

    expect(nexusStub.openFile).toHaveBeenCalledTimes(1);
    // 剩下的那一个照样开出来了；界面不因一条失败进错误态
    const names = Array.from(container.querySelectorAll<HTMLElement>('.nexus-tab-name')).map(
      (tab) => tab.textContent
    );
    expect(names).toEqual(['manual.pdf']);
  });

  it('本次会话对标签页的改动会写回快照（下次重启的输入）', async () => {
    seedSnapshot(SNAPSHOT);

    root.render(React.createElement(App));
    await waitForSelector('.nexus-tab');

    // 在树里再点开一个文件（索引里只有 a.md，就用它）→ 快照应反映出新的集合。
    // 直接关掉一个标签更干脆：点 manual.pdf 的关闭按钮。
    const closeButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.nexus-tab-close')
    ).find((button) => button.getAttribute('aria-label')?.includes('manual.pdf'));
    expect(closeButton).toBeDefined();
    closeButton!.click();
    await new Promise((resolve) => setTimeout(resolve, 120));

    const saved = JSON.parse(localStorage.getItem(SESSION_TABS_STORAGE_KEY) ?? 'null');
    expect(saved.root).toBe('D:/vault');
    expect(saved.entries.map((entry: { path: string }) => entry.path)).toEqual([
      'D:/vault/notes/a.md'
    ]);
  });
});
