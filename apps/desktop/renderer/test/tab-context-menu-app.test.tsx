// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { documentTypeForPath, type IndexedDocument } from '@nexus/core';
import { App } from '../src/App.js';
import { settings } from '../src/platform.js';
import type { NexusBridge } from '../../preload/types.js';

/**
 * 标签页右键菜单在 `App.tsx` 这一层的接线（2026-10-16）。
 *
 * 为什么要有这一层：`tab-bar.test.tsx` 能证「右键上报了哪一条」，但覆盖不到菜单里那几条
 * 动作 —— 它们要文档 store（关闭其他 / 右侧）与工作区根（在树中定位），而这两样都在
 * `App` 手里。真机用例（`workspace-tabs.test.ts`）跑得动主路，但凑出「三条标签、右键中间
 * 那一条」这种形状比断言本身贵得多。
 *
 * 这一组钉四件事：
 *
 * 1. **项随选区裁剪**：最后一条上「关闭右侧」灰着，第一条上不灰 —— 禁用而不是隐藏
 *    （菜单项忽有忽无比灰着一格更难理解）。
 * 2. **批量关闭就是逐条关闭**：`closeTabs` 只是循环调用 `handleCloseTab`，所以「未保存的
 *    怎么办」那条规则不会分叉。这里验的是选区算得对。
 * 3. **「在树中定位」只在文件真的在工作区里时给**：未命名文档（`filePath` 为 `null`）
 *    一个动作都给不了，定位它会一直挂在 `revealRequest` 上。
 * 4. **定位要把树展开**：收着的目录不渲染子节点，只加高亮类那一行根本不在 DOM 里。
 *
 * 覆盖不到的一格：真机上菜单浮在 `overflow-x: auto` 的标签条之上（要真实排版）。
 */
const testWindow = window as Window & { nexus?: unknown };

/** 只关心路径与类型，其余给固定值。 */
function doc(relativePath: string): IndexedDocument {
  const name = relativePath.split('/').pop() ?? relativePath;
  return {
    id: 0,
    path: `C:/vault/${relativePath}`,
    relativePath,
    name,
    title: name.replace(/\.[^.]+$/, ''),
    type: documentTypeForPath(relativePath) ?? 'markdown',
    sizeBytes: 1,
    modifiedAtMs: 1,
    contentHash: 'x',
    extractionStatus: 'none'
  };
}

const OK_RESULT = {
  scanned: 3,
  indexed: 3,
  skipped: 0,
  removed: 0,
  truncated: false,
  errors: [] as string[]
};

describe('标签页右键菜单 · App 接线', () => {
  let container: HTMLDivElement;
  let root: Root;
  let restoreSelectionDispatch: () => void;

  beforeEach(() => {
    // happy-dom 对 `selectionchange` 的同步派发会让 CodeMirror 抖；与另几个 App 级用例同样处理。
    const dispatchEvent = document.dispatchEvent.bind(document);
    const pending = new Set<ReturnType<typeof setTimeout>>();
    const dispatch = vi.spyOn(document, 'dispatchEvent').mockImplementation((event) => {
      if (event.type !== 'selectionchange') return dispatchEvent(event);
      const timer = setTimeout(() => {
        pending.delete(timer);
        dispatchEvent(event);
      }, 0);
      pending.add(timer);
      return true;
    });
    restoreSelectionDispatch = () => {
      for (const timer of pending) clearTimeout(timer);
      dispatch.mockRestore();
    };

    localStorage.clear();
    settings.set('files.deleteBehavior', 'trash');

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    testWindow.nexus = {
      getLaunchContext: vi.fn().mockResolvedValue({ mode: 'workspace', workspaceRoot: 'C:/vault' }),
      // 内容按路径回，不然每一条标签都会打开同一份文档。
      openFile: vi.fn(async (path: string) => ({ path, content: `# ${path}` })),
      writeFile: vi.fn().mockResolvedValue(undefined),
      saveAs: vi.fn().mockResolvedValue('C:/vault/untitled.md'),
      readFile: vi.fn().mockResolvedValue('# Root'),
      setDirty: vi.fn(),
      watchFile: vi.fn(() => () => {}),
      onSaveAndCloseRequested: vi.fn().mockReturnValue(() => {}),
      readyToClose: vi.fn(),
      closeWindow: vi.fn(),
      minimizeWindow: vi.fn(),
      maximizeWindow: vi.fn(),
      getWindowState: vi.fn().mockResolvedValue({ maximized: false }),
      onWindowStateChanged: vi.fn().mockReturnValue(() => {}),
      rebuildIndex: vi.fn().mockResolvedValue(OK_RESULT),
      listIndexedDocuments: vi
        .fn()
        .mockResolvedValue([doc('a.md'), doc('b.md'), doc('c.md'), doc('notes/deep/a.md')]),
      listWorkspaceDirectories: vi
        .fn()
        .mockResolvedValue([
          { path: 'C:/vault/notes', relativePath: 'notes', name: 'notes' },
          { path: 'C:/vault/notes/deep', relativePath: 'notes/deep', name: 'deep' }
        ])
    } as unknown as NexusBridge;
  });

  afterEach(() => {
    restoreSelectionDispatch?.();
    root.unmount();
    container.remove();
    delete testWindow.nexus;
    settings.set('files.deleteBehavior', 'trash');
  });

  /**
   * 轮询到条件成立。
   *
   * 这一层不能假设「派发完 DOM 事件，React 就同步重渲染完了」：本文件没有把
   * `IS_REACT_ACT_ENVIRONMENT` 打开（其余 App 级用例也没有），于是更新走的是调度器
   * 而不是 act 的同步刷新 —— 派发之后立刻断言会读到上一帧。
   */
  async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`等待超时：${what}`);
  }

  const tabs = () => Array.from(container.querySelectorAll<HTMLElement>('.nexus-tab'));

  const tabNames = () => tabs().map((tab) => tab.querySelector('.nexus-tab-name')?.textContent);

  /** 渲染 App 并等侧栏树出现。 */
  async function renderApp(): Promise<void> {
    root.render(React.createElement(App));
    await waitFor(() => container.querySelector('.nexus-tree-file') !== null, '侧栏树出现', 8000);
  }

  /**
   * 点树上的某一行把它开成标签页。
   *
   * **按 `data-relative-path` 找，不按显示名找**：`notes/deep/a.md` 的显示名就是 `a.md`，
   * 与根级那个 `a.md` 撞名，按名字找会挑中错的那一行。
   *
   * 祖先目录默认折叠，要逐层点开。点完必须等**下一层真的出现在 DOM 里**才能往下走 ——
   * 这里不能写 `waitFor(() => true, …)`：条件恒真时它在第一轮就返回，一次都不 yield，
   * 于是会在 React 重渲染之前就去找更深的节点。
   */
  async function openFromTree(relativePath: string): Promise<void> {
    const segments = relativePath.split('/');
    const name = segments[segments.length - 1] ?? relativePath;

    for (let depth = 1; depth < segments.length; depth += 1) {
      const directory = segments.slice(0, depth).join('/');
      const row = container.querySelector<HTMLElement>(`[data-relative-path="${directory}"]`);
      if (row && row.getAttribute('aria-expanded') === 'false') row.click();
      const child = segments.slice(0, depth + 1).join('/');
      await waitFor(
        () => container.querySelector(`[data-relative-path="${child}"]`) !== null,
        `展开 ${directory}`
      );
    }

    const row = container.querySelector<HTMLElement>(`[data-relative-path="${relativePath}"]`);
    if (!row) throw new Error(`树上找不到 ${relativePath}`);
    row.click();
    await waitFor(() => tabNames().includes(name), `标签页 ${name} 出现`);
  }

  /** 在某一条标签上右键，并等菜单出来。 */
  async function rightClickTab(name: string): Promise<void> {
    const tab = tabs().find(
      (element) => element.querySelector('.nexus-tab-name')?.textContent === name
    );
    if (!tab) throw new Error(`标签栏上找不到 ${name}`);
    tab.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 80 })
    );
    await waitFor(() => container.querySelector('[data-context-menu]') !== null, '右键菜单出现');
  }

  const menuItemIds = () =>
    Array.from(container.querySelectorAll<HTMLElement>('[data-context-menu-item]')).map((el) =>
      el.getAttribute('data-context-menu-item')
    );

  const menuItem = (id: string) =>
    container.querySelector<HTMLElement>(`[data-context-menu-item="${id}"]`);

  /** 点菜单里的某一项，并等菜单收掉。 */
  async function clickMenuItem(id: string): Promise<void> {
    await waitFor(() => menuItem(id) !== null, `菜单项 ${id} 出现`);
    menuItem(id)!.click();
    await waitFor(() => container.querySelector('[data-context-menu]') === null, '菜单关闭');
  }

  it('右键标签弹出菜单，「关闭右侧」在**最后一条**上灰着、在第一条上可用', async () => {
    await renderApp();
    await openFromTree('a.md');
    await openFromTree('b.md');
    await openFromTree('c.md');

    expect(tabNames()).toEqual(['a.md', 'b.md', 'c.md']);

    // 最后一条：右边没东西了。`close-right` **还在，只是灰着** —— 禁用而不是隐藏。
    await rightClickTab('c.md');
    expect(menuItemIds()).toEqual([
      'close',
      'close-others',
      'close-right',
      'close-all',
      'reveal-in-tree'
    ]);
    expect(menuItem('close-right')?.hasAttribute('disabled')).toBe(true);
    // 工作区开着、这一篇也在树里 ⇒ 给定位
    expect(menuItem('reveal-in-tree')).not.toBeNull();

    // 第一条：右边有两条，两项都可用
    await rightClickTab('a.md');
    expect(menuItem('close-right')?.hasAttribute('disabled')).toBe(false);
    expect(menuItem('close-others')?.hasAttribute('disabled')).toBe(false);
  });

  it('「关闭其他」只留被右键的那一条', async () => {
    await renderApp();
    await openFromTree('a.md');
    await openFromTree('b.md');
    await openFromTree('c.md');

    await rightClickTab('b.md');
    await clickMenuItem('close-others');

    await waitFor(() => tabs().length === 1, '只剩一条标签');
    expect(tabNames()).toEqual(['b.md']);
  });

  it('「关闭右侧」只关右边那些', async () => {
    await renderApp();
    await openFromTree('a.md');
    await openFromTree('b.md');
    await openFromTree('c.md');

    await rightClickTab('b.md');
    await clickMenuItem('close-right');

    await waitFor(() => tabs().length === 2, '只剩两条标签');
    expect(tabNames()).toEqual(['a.md', 'b.md']);
  });

  /**
   * 未命名文档（`filePath` 为 `null`）**没有**定位这一项。
   *
   * 它一个动作都给不了：`revealRequest` 按路径找节点，找不到就保持挂起 —— 那是刻意的设计
   * （索引还没跑完时重试），但菜单里给一个按下去没反应的项比不给更糟。
   */
  it('未命名文档不给「在树中定位」', async () => {
    await renderApp();
    await openFromTree('a.md');

    container.querySelector<HTMLElement>('.nexus-tab-new')!.click();
    await waitFor(() => tabs().length === 2, '未命名标签出现');

    await rightClickTab('Untitled');
    expect(menuItemIds()).toEqual(['close', 'close-others', 'close-right', 'close-all']);
  });

  /**
   * 只有一条标签时，「关闭其他 / 关闭右侧」**都还在，只是灰着**。
   *
   * 这一格是「禁用优先于隐藏」最容易退化的地方：两项都不可用时最省事的写法是把它们
   * 从清单里摘掉，但那样菜单会长短不一 —— 用户看到的是「菜单变了」而不是「这两件事
   * 现在做不了」。`close-all` 相反：它恒可用，只有一条标签时等价于「关闭」。
   */
  it('只有一条标签时，「关闭其他 / 关闭右侧」灰着而「全部关闭」可用', async () => {
    await renderApp();
    await openFromTree('a.md');

    await rightClickTab('a.md');
    expect(menuItemIds()).toEqual([
      'close',
      'close-others',
      'close-right',
      'close-all',
      'reveal-in-tree'
    ]);
    expect(menuItem('close-others')?.hasAttribute('disabled')).toBe(true);
    expect(menuItem('close-right')?.hasAttribute('disabled')).toBe(true);
    expect(menuItem('close-all')?.hasAttribute('disabled')).toBe(false);
  });

  /**
   * 「全部关闭」走的是同一个 `closeTabs`，所以关掉最后一条时宿主补的那份空白文档
   * 照常出现 —— 与 `Ctrl+W` 关到最后一条时的落点一致，不是第二套语义。
   */
  it('「全部关闭」把标签都关掉，只剩宿主补的空白文档', async () => {
    await renderApp();
    await openFromTree('a.md');
    await openFromTree('b.md');
    await openFromTree('c.md');

    await rightClickTab('b.md');
    await clickMenuItem('close-all');

    await waitFor(() => tabNames().join() === 'Untitled', '只剩空白文档');
    expect(tabNames()).toEqual(['Untitled']);
  });

  /**
   * 定位要把**每一层祖先**展开：收着的目录根本不渲染子节点，只加高亮类那一行不在 DOM 里。
   * 与「在工作区中打开」共用同一个 `workspaceReveal` 请求。
   */
  it('「在树中定位」展开祖先、选中那一行', async () => {
    await renderApp();
    await openFromTree('notes/deep/a.md');

    // 先把它收起来，模拟「用户已经在别的目录上了」
    container.querySelector<HTMLElement>('[data-relative-path="notes"]')!.click();
    await waitFor(
      () => container.querySelector('[data-relative-path="notes/deep/a.md"]') === null,
      '树收起来了'
    );

    await rightClickTab('a.md');
    await clickMenuItem('reveal-in-tree');

    await waitFor(
      () => container.querySelector('[data-relative-path="notes/deep/a.md"]') !== null,
      '目标行回到 DOM'
    );
    expect(
      container
        .querySelector('[data-relative-path="notes/deep/a.md"]')
        ?.getAttribute('data-selected')
    ).toBe('true');
    expect(
      container.querySelector('[data-relative-path="notes"]')?.getAttribute('aria-expanded')
    ).toBe('true');
  });
});
