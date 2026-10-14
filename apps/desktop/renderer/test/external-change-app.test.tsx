// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { translate } from '@nexus/i18n';
import { App } from '../src/App.js';
import { localeManager } from '../src/platform.js';
import { SESSION_TABS_STORAGE_KEY } from '../src/workspace/session-persistence.js';
import type { FileWatchEvent } from '@nexus/core';

/**
 * 「文件在外部被改了 / 被删了」在 `App.tsx` 这一层的接线。
 *
 * ## 为什么要有这一层
 *
 * 判据全在**事件与读盘结果的关系**上，而真机上这两样都由文件系统决定 ——
 * 想造出「事件说删了、文件其实还在」这一格，只能靠打桩的桥。这一格正是
 * issue #2 报的那个 bug：**富文本模式下拖一下块的位置**就弹
 * 「文件已被外部删除或移动」，因为保存走的原子替换（目标→备份→临时→目标）
 * 在目录层面报出一串 rename，旧代码把 rename 当成了删除。
 *
 * ## 四条不变量
 *
 * 1. **读盘说了算**：事件类型只决定「要不要去看一眼」，看的结果决定一切。
 * 2. **自己写出去的动静不算外部改动**：盘上内容与缓冲区一致时，一个横幅都不弹。
 * 3. **真没了才说没了**，并且要给得出出路（重新读取 / 写回原位置 / 另存为）。
 * 4. **干净文档仍然自动重载**（`general.externalChange === 'smart'` 的既有行为）。
 */

const DOC_PATH = 'D:/vault/notes/a.md';
const DOC_SOURCE = '# a\n\n正文一段。\n';

const nexusStub = {
  getLaunchContext: vi.fn(),
  openWorkspace: vi.fn(),
  listRecentWorkspaces: vi.fn().mockResolvedValue([]),
  openFile: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  setDirty: vi.fn(),
  watchFile: vi.fn(),
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

const WORKSPACE_LAUNCH = {
  mode: 'workspace',
  filePath: null,
  documentType: null,
  workspaceRoot: 'D:/vault',
  unsupportedPath: null
};

const SNAPSHOT = {
  root: 'D:/vault',
  entries: [{ path: DOC_PATH, page: null }],
  activePath: DOC_PATH
};

describe('外部改动与外部删除 · App 接线', () => {
  let container: HTMLDivElement;
  let root: Root;
  /** 最近一次装上的 watcher 回调 —— 测试用它冒充文件系统。 */
  let fireWatch: (event: FileWatchEvent) => void;
  /** 盘上现在是什么。测试直接改它来冒充「外部工具写了盘」。 */
  let disk: string;
  let originalAlert: typeof window.alert;

  beforeEach(() => {
    (window as unknown as { nexus: typeof nexusStub }).nexus = nexusStub;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.clear();
    localStorage.setItem(SESSION_TABS_STORAGE_KEY, JSON.stringify(SNAPSHOT));

    // `readFile` 每次调用都回显当前盘上的内容 —— 测试改 `disk` 就等于改盘。
    nexusStub.readFile.mockImplementation(async () => disk);
    nexusStub.openFile.mockImplementation(async (path: string) => ({
      path,
      content: DOC_SOURCE,
      readOnly: false
    }));
    nexusStub.watchFile.mockImplementation(
      (_path: string, listener: (event: FileWatchEvent) => void) => {
        fireWatch = listener;
        return () => {};
      }
    );
    nexusStub.getLaunchContext.mockResolvedValue(WORKSPACE_LAUNCH);
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
    disk = DOC_SOURCE;
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    window.alert = originalAlert;
    delete (window as unknown as { nexus?: unknown }).nexus;
    for (const spy of Object.values(nexusStub)) spy.mockClear();
  });

  async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`等待超时：${what}`);
  }

  /** 渲染 App 并等那一份文档真的开起来、watcher 装上。 */
  async function renderDocument(): Promise<void> {
    root.render(React.createElement(App));
    await waitFor(() => container.querySelector('.cm-content') !== null, '编辑器出现');
    await waitFor(() => typeof fireWatch === 'function', 'watcher 装上');
  }

  function bannerText(): string {
    return container.querySelector('.nexus-conflict-banner')?.textContent ?? '';
  }

  function banner(): Element | null {
    return container.querySelector('.nexus-conflict-banner');
  }

  function button(label: string): HTMLElement | null {
    return (
      Array.from(container.querySelectorAll<HTMLElement>('.nexus-conflict-actions button')).find(
        (element) => element.textContent === label
      ) ?? null
    );
  }

  const deletedText = (): string => translate(localeManager.locale, 'banner.deleted');
  const rereadText = (): string => translate(localeManager.locale, 'banner.deletedReread');
  const writeBackText = (): string => translate(localeManager.locale, 'banner.deletedWriteBack');
  const saveAsText = (): string => translate(localeManager.locale, 'cmd.saveAs');

  it('盘上内容与缓冲区一致的事件一个横幅都不弹 —— 自己的保存就是这样响的', async () => {
    await renderDocument();

    fireWatch({ type: 'changed', path: DOC_PATH });
    // 负向断言：给足时间确认「确实没弹」
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(banner()).toBeNull();
  });

  it('事件说「删了」但文件还在、内容也没变 —— 不弹删除横幅（issue #2 的回归判据）', async () => {
    await renderDocument();

    // 原子替换在目录层面留下的就是这种事件：类型像「改名/删除」，但路径上还有文件。
    fireWatch({ type: 'deleted', path: DOC_PATH });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(banner()).toBeNull();
  });

  it('文件真的读不到才弹删除横幅，并给出三条出路', async () => {
    await renderDocument();

    nexusStub.readFile.mockRejectedValue(new Error('ENOENT'));
    fireWatch({ type: 'deleted', path: DOC_PATH });
    await waitFor(() => banner() !== null, '删除横幅出现');

    expect(bannerText()).toContain(deletedText());
    expect(button(rereadText())).not.toBeNull();
    expect(button(writeBackText())).not.toBeNull();
    expect(button(saveAsText())).not.toBeNull();
  });

  it('「写回原位置」把缓冲区的内容写回原来的路径', async () => {
    await renderDocument();

    nexusStub.readFile.mockRejectedValue(new Error('ENOENT'));
    fireWatch({ type: 'deleted', path: DOC_PATH });
    await waitFor(() => banner() !== null, '删除横幅出现');

    button(writeBackText())!.click();
    await waitFor(
      () => nexusStub.writeFile.mock.calls.length > 0,
      'writeFile 被调用'
    );

    expect(nexusStub.writeFile.mock.calls[0]?.[0]).toBe(DOC_PATH);
    expect(nexusStub.writeFile.mock.calls[0]?.[1]).toBe(DOC_SOURCE);
    // 写回成功之后横幅该收起来
    await waitFor(() => banner() === null, '横幅收起');
  });

  it('「重新读取」：文件回来了且内容不同 —— 转成冲突横幅，而不是假装没事', async () => {
    await renderDocument();

    nexusStub.readFile.mockRejectedValue(new Error('ENOENT'));
    fireWatch({ type: 'deleted', path: DOC_PATH });
    await waitFor(() => banner() !== null, '删除横幅出现');

    // 用户把文件放回来了，但内容不是原来那份
    disk = '# a\n\n外部改过的正文。\n';
    nexusStub.readFile.mockImplementation(async () => disk);

    button(rereadText())!.click();
    await waitFor(
      () => bannerText().includes(translate(localeManager.locale, 'banner.conflict')),
      '冲突横幅出现'
    );
  });

  it('干净文档遇到真外部改动仍然自动重载（smart 档的既有行为）', async () => {
    await renderDocument();

    disk = '# a\n\n别人改的。\n';
    fireWatch({ type: 'changed', path: DOC_PATH });

    await waitFor(
      () => (container.querySelector('.cm-content')?.textContent ?? '').includes('别人改的。'),
      '正文换成盘上那份'
    );
    expect(banner()).toBeNull();
  });
});
