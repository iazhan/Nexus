// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from '../src/App.js';
import { settings } from '../src/platform.js';
import { EDITOR_OPEN_MODE_DEFAULT } from '../src/settings/preference-specs.js';
import { SESSION_TABS_STORAGE_KEY } from '../src/workspace/session-persistence.js';

/**
 * 「打开 Markdown 时进哪个面」在 `App.tsx` 这一层的接线（issue #2 / #2 条）。
 *
 * 值域那些判据在 `editor-open-mode.test.ts`；这里只钉**接线**：初值从存档来、
 * 切面会写回、而「只在启动时生效」这条边界不被违反。
 *
 * 为什么必须在 happy-dom 里渲染整个 `App`：初值是 `useState` 的惰性求值，
 * 打桩快照、看着某个函数返回值都测不到「这一次启动真的用上了它」。
 */

const DOC_PATH = 'D:/vault/notes/a.md';

const nexusStub = {
  getLaunchContext: vi.fn(),
  openWorkspace: vi.fn(),
  listRecentWorkspaces: vi.fn().mockResolvedValue([]),
  openFile: vi.fn(),
  readFile: vi.fn().mockResolvedValue('# a\n\n正文。\n'),
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

const SNAPSHOT = {
  root: 'D:/vault',
  entries: [{ path: DOC_PATH, page: null }],
  activePath: DOC_PATH
};

describe('打开模式 · App 接线', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalAlert: typeof window.alert;

  beforeEach(() => {
    (window as unknown as { nexus: typeof nexusStub }).nexus = nexusStub;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.clear();
    localStorage.setItem(SESSION_TABS_STORAGE_KEY, JSON.stringify(SNAPSHOT));

    nexusStub.getLaunchContext.mockResolvedValue({
      mode: 'workspace',
      filePath: null,
      documentType: null,
      workspaceRoot: 'D:/vault',
      unsupportedPath: null
    });
    nexusStub.openFile.mockImplementation(async (path: string) => ({
      path,
      content: '# a\n\n正文。\n',
      readOnly: false
    }));
    nexusStub.listIndexedDocuments.mockResolvedValue([
      {
        id: 0,
        path: DOC_PATH,
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

    originalAlert = window.alert;
    window.alert = vi.fn() as unknown as typeof window.alert;

    // `settings` 是构造时快照的单例，`localStorage.clear()` 清不掉它 ——
    // 所以每个用例都按已知状态起手，否则上一个用例的档位会流到下一个里
    // （症状是「单跑绿、连着跑莫名其妙」）。
    settings.set('editor.openMode', EDITOR_OPEN_MODE_DEFAULT);
    settings.set('editor.surface', EDITOR_OPEN_MODE_DEFAULT);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    window.alert = originalAlert;
    delete (window as unknown as { nexus?: unknown }).nexus;
    for (const spy of Object.values(nexusStub)) spy.mockClear();
  });

  async function waitForSelector(selector: string, timeoutMs = 6000): Promise<Element> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = container.querySelector(selector);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`等待 ${selector} 超时：${container.innerHTML.slice(0, 400)}`);
  }

  function currentSurface(): string | null {
    return container.querySelector('[data-surface-kind]')?.getAttribute('data-surface-kind') ?? null;
  }

  it('默认进富文本面（无存档时的一次干净启动）', async () => {
    root.render(React.createElement(App));
    await waitForSelector('[data-surface-kind="visual"]');
    expect(currentSurface()).toBe('visual');
  });

  it('「始终源码」把一次干净启动按到源码面', async () => {
    settings.set('editor.openMode', 'source');
    root.render(React.createElement(App));
    await waitForSelector('[data-surface-kind="source"]');
    expect(currentSurface()).toBe('source');
  });

  it('「记住上次」跟着上次用的面走', async () => {
    settings.set('editor.openMode', 'remember');
    settings.set('editor.surface', 'source');
    root.render(React.createElement(App));
    await waitForSelector('[data-surface-kind="source"]');
    expect(currentSurface()).toBe('source');
  });

  it('「记住上次」一次都没记过时与默认档一致', async () => {
    settings.set('editor.openMode', 'remember');
    root.render(React.createElement(App));
    await waitForSelector('[data-surface-kind]');
    // 没记过就与「始终富文本」同一个起手 —— 用户不会因为换了档位而看到另一种默认。
    expect(currentSurface()).toBe('visual');
  });

  it('切面会写回「上次用的面」—— 否则「记住上次」永远记不住东西', async () => {
    root.render(React.createElement(App));
    await waitForSelector('[data-surface-kind="visual"]');

    await waitForSelector('[data-action="toggle-surface"]');
    container.querySelector<HTMLElement>('[data-action="toggle-surface"]')!.click();

    await waitForSelector('[data-surface-kind="source"]');
    expect(settings.get('editor.surface')).toBe('source');
  });
});
