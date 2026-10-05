// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from '../src/App.js';
import { commandRegistry, settings } from '../src/platform.js';
import type { NexusBridge } from '../../preload/types.js';

/**
 * 「界面元素显隐」与「状态栏显示项」的**接线**用例。
 *
 * 为什么要有这一层：取值域（`group-setting.test.ts`）与控件（`settings-view.test.tsx`）各自
 * 都绿，也证明不了「改了设置界面真的少一块」—— 中间那段是 `App.tsx` 里几个 `&&`，
 * 而把 `showStatusBar` 写成 `!showStatusBar`、或者读错另一个字段，两边都盖不到。
 *
 * 判据取**真实渲染出来的节点**（`.nexus-status-bar` / `[data-status-metric]` /
 * `.nexus-editor-toolbar`），不取设置值 —— 取设置值等于把「我写进去了」当成「它生效了」。
 *
 * 覆盖不到的一格：标签页那一格需要开两个文档，而这里的工作区是打桩的。它在本文件里靠
 * 连开两次 `new-file` 造出来；真机上「打开两个文件」那条路在 `settings-window.test.ts` 里。
 */
const testWindow = window as Window & {
  nexusActiveView?: unknown;
  nexusSession?: unknown;
};

/** 桥的打桩与另几个 App 级用例同形 —— 只补 App 启动时会碰到的那些方法。 */
function stubBridge(): void {
  testWindow.nexus = {
    getLaunchContext: vi.fn().mockResolvedValue({ mode: 'lightweight', filePath: 'D:/notes/a.md' }),
    openFile: vi.fn().mockResolvedValue({ path: 'D:/notes/a.md', content: 'Hello world' }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    saveAs: vi.fn().mockResolvedValue('D:/notes/a.md'),
    readFile: vi.fn().mockResolvedValue('Hello world'),
    setDirty: vi.fn(),
    watchFile: vi.fn(() => () => {}),
    onSaveAndCloseRequested: vi.fn().mockReturnValue(() => {}),
    readyToClose: vi.fn(),
    closeWindow: vi.fn(),
    minimizeWindow: vi.fn(),
    maximizeWindow: vi.fn(),
    getWindowState: vi.fn().mockResolvedValue({ maximized: false }),
    onWindowStateChanged: vi.fn().mockReturnValue(() => {})
  } as unknown as NexusBridge;
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待超时');
}

describe('界面元素显隐 · 接线', () => {
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
    settings.set('appearance.chromeVisibility', '');
    settings.set('appearance.statusBarMetrics', '');

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    restoreSelectionDispatch?.();
    root.unmount();
    container.remove();
    delete testWindow.nexus;
    delete testWindow.nexusSession;
    delete testWindow.nexusActiveView;
    settings.set('appearance.chromeVisibility', '');
    settings.set('appearance.statusBarMetrics', '');
  });

  /** 启动并等到状态栏出现 —— 它不依赖文档，所以不必等编辑器。 */
  async function launch(): Promise<void> {
    stubBridge();
    root.render(React.createElement(App));
    await waitFor(() => document.querySelector('.nexus-status-bar') !== null);
  }

  /**
   * 改设置，并给 React 一轮宏任务把这次外部 store 变更渲染出去。
   *
   * **不用 `act`**：这个文件没开 `IS_REACT_ACT_ENVIRONMENT`（开了之后 `root.render` 那一句
   * 也得包进 `act`，而那会改变整条启动路径的时序），而外部 store 的变更本来就不是 React
   * 事件 —— 本仓库几个 App 级用例一律用轮询等结果。
   */
  async function setSetting(
    path: 'appearance.chromeVisibility' | 'appearance.statusBarMetrics',
    value: string
  ): Promise<void> {
    settings.set(path, value);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('默认（空串 ＝ 全开）时状态栏与三项读数都在', async () => {
    await launch();

    expect(document.querySelector('.nexus-status-bar')).not.toBeNull();
    expect(document.querySelector('[data-status-metric="line-column"]')).not.toBeNull();
    expect(document.querySelector('[data-status-metric="format"]')).not.toBeNull();
  });

  it('藏起状态栏：整条消失', async () => {
    await launch();

    await setSetting('appearance.chromeVisibility', 'statusBar');

    expect(document.querySelector('.nexus-status-bar')).toBeNull();
  });

  it('藏起单项读数：只少那一项，状态栏本身还在', async () => {
    await launch();

    await setSetting('appearance.statusBarMetrics', 'lineColumn,format');

    expect(document.querySelector('[data-status-metric="line-column"]')).toBeNull();
    expect(document.querySelector('[data-status-metric="format"]')).toBeNull();
    // 状态栏还在 —— 这一条把「单项开关」与「整条开关」分开，两者读的是两个不同的设置。
    expect(document.querySelector('.nexus-status-bar')).not.toBeNull();
    // 字数不受这一组影响：它有自己的开关（`editor.wordCount`，默认开）。
    expect(document.querySelector('[data-status-metric="character-count"]')).not.toBeNull();
  });

  it('**保存态永远在** —— 藏起状态栏之外的一切也不该把它藏掉', async () => {
    await launch();

    await setSetting('appearance.statusBarMetrics', 'lineColumn,selection,format');

    // 右侧三项全没了，左侧那半仍在：保存失败只在那里说。
    expect(document.querySelectorAll('.status-bar-right [data-status-metric]')).toHaveLength(1);
    expect(document.querySelector('.status-bar-left .status-text')).not.toBeNull();
  });

  it('取消隐藏能还原 —— 空串就是「全开」', async () => {
    await launch();

    await setSetting('appearance.chromeVisibility', 'statusBar');
    expect(document.querySelector('.nexus-status-bar')).toBeNull();

    await setSetting('appearance.chromeVisibility', '');
    expect(document.querySelector('.nexus-status-bar')).not.toBeNull();
  });

  it('藏起标签页：两个文档都还开着，只是那条栏不画', async () => {
    await launch();
    await waitFor(() => Boolean(commandRegistry.getCommand('new-file')));

    // 轻量模式启动时**已经有一个文档**（打开的是 `a.md`），所以这里只再开一个 ——
    // 判据写成「多于一」而不是具体数字：这一条测的是「藏起来不关文档」，
    // 不测启动时恰好开着几个，写死数字会让无关的启动行为变化把这条用例弄红。
    commandRegistry.executeCommand('new-file');
    await waitFor(() => document.querySelectorAll('.nexus-tab').length > 1);

    const opened = document.querySelectorAll('.nexus-tab').length;

    await setSetting('appearance.chromeVisibility', 'tabBar');
    expect(document.querySelector('.nexus-tab-bar')).toBeNull();

    // 关键：文档**没有被关掉**，只是那条栏不画。少了这一条，一个「藏起来顺手把文档也关了」
    // 的实现也能让上面那句通过。
    await setSetting('appearance.chromeVisibility', '');
    expect(document.querySelectorAll('.nexus-tab')).toHaveLength(opened);
  });

  /**
   * 工具栏这一格的判据与标签页**方向相反**，这正是它需要单独一条的理由。
   *
   * 标签页那条证的是「藏了不关东西」，所以还原之后要数文档还在；工具栏这条证的是
   * 「藏的是捷径不是能力」，所以还原不是重点 —— 重点是**藏起来的那一刻，动作仍然到得了**。
   * 只断言 `.nexus-editor-toolbar` 变 null 是不够的：一个「藏工具栏时顺手把块级动作也藏了」
   * 的实现同样能让那句通过，而那正是这一项准入判据（「藏了还能用」）要排除的情况。
   */
  it('藏起编辑器工具栏：那条栏消失，而「格式」菜单仍在', async () => {
    await launch();
    await waitFor(() => document.querySelector('.nexus-editor-toolbar') !== null);

    await setSetting('appearance.chromeVisibility', 'editorToolbar');
    expect(document.querySelector('.nexus-editor-toolbar')).toBeNull();
    // 栏上五个动作各有第二条路，块级那批走菜单栏的「格式」菜单 —— 它必须还在。
    expect(document.querySelector('[data-menu="format"]')).not.toBeNull();

    await setSetting('appearance.chromeVisibility', '');
    expect(document.querySelector('.nexus-editor-toolbar')).not.toBeNull();
  });
});
