// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from '../renderer/src/App.js';
import type { EditorView, MarkdownDocumentSession } from '@nexus/editor';
import type { NexusBridge } from '../preload/types.js';

/**
 * 编辑器工具栏在**真实 App + 真实 CodeMirror view** 上的两条契约
 * （P0-4 焦点保持 / P0-5 只读降级，2026-10-03）。
 *
 * 为什么不和 `renderer/test/editor-toolbar.test.tsx` 合并：那边是**组件自己**的分支
 * （属性怎么画、下拉怎么开关），造一个假的 editor 就够了；这里要证的是「按下去之后
 * **真的编辑器**有没有掉选区」—— 那必须有真的 `EditorView`，而真的 view 只在这条链上。
 * 两条合起来才算覆盖（同 P3-09 定下的分层口径）。
 *
 * ## 为什么 mousedown 要自己补一条默认动作
 *
 * happy-dom 不实现鼠标事件的默认动作：按钮不会因为 `mousedown` 而抢走焦点，于是
 * 「按下之后编辑器仍有焦点」在那里**恒真**，等于没测。这里把那条默认动作补上 ——
 * 没被 `preventDefault` 拦掉就把焦点给按钮。它正是被测的那条契约，而只读那两条
 * 反向用例证明这个模拟不是空转。
 *
 * ## 断的是选区，不是「有没有变」
 *
 * 焦点丢了 `view.state.selection` 未必立刻变，但**下一次按键**会打到按钮上而不是编辑器，
 * 所以两条都要断：焦点在不在编辑器里、选区是不是逐字段相同。
 *
 * `apps/desktop/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

const testWindow = window as Window & {
  nexusActiveView?: EditorView;
  nexusSession?: MarkdownDocumentSession;
};

const SOURCE = 'Hello world';

/** 索引里的一行。只有 `resolveWikiLink` / 面板会读的那几个字段是真的。 */
function indexedDocument(relativePath: string) {
  const name = relativePath.split('/').pop() ?? relativePath;
  return {
    id: 0,
    path: `D:/vault/${relativePath}`,
    relativePath,
    name,
    title: name.replace(/\.[^.]+$/, ''),
    type: 'markdown',
    sizeBytes: 1,
    modifiedAtMs: 1,
    contentHash: relativePath,
    extractionStatus: 'none'
  };
}

describe('编辑器工具栏 · 真机接线（焦点保持 / 只读降级）', () => {
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
  });

  /** 装桥。`readOnly` 由 `openFile` 的返回值带进来 —— 那是唯一的只读来源。 */
  function installBridge(readOnly: boolean): void {
    const opened = { path: 'D:/test-doc.md', content: SOURCE, readOnly };
    testWindow.nexus = {
      getLaunchContext: vi.fn().mockResolvedValue({
        mode: 'lightweight',
        filePath: opened.path
      }),
      openFile: vi.fn().mockResolvedValue(opened),
      readFile: vi.fn().mockResolvedValue(SOURCE),
      writeFile: vi.fn().mockResolvedValue(undefined),
      saveAs: vi.fn().mockResolvedValue('D:/saved.md'),
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

  async function renderApp(readOnly = false): Promise<EditorView> {
    installBridge(readOnly);
    root.render(React.createElement(App));

    const start = Date.now();
    while (Date.now() - start < 5000) {
      const toolbar = container.querySelector('.nexus-editor-toolbar');
      if (testWindow.nexusActiveView && testWindow.nexusSession && toolbar) {
        return testWindow.nexusActiveView;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('等 App 起来超时（编辑器工具栏没出现）');
  }

  const toolbarButton = (action: string) =>
    container.querySelector<HTMLButtonElement>(
      `.nexus-editor-toolbar [data-action="${action}"]`
    );

  /** 编辑器是不是握着焦点。用 DOM 的 `activeElement` 判 —— 那正是 `mousedown` 会改的东西。 */
  const editorHasFocus = (view: EditorView) =>
    Boolean(document.activeElement && view.dom.contains(document.activeElement));

  /**
   * 按一次左键，并补上「按下按钮就把焦点抢过去」这条浏览器默认动作。
   * 返回事件本身，好断言 `defaultPrevented`。
   */
  const pressLeftButton = (action: string) => {
    const button = toolbarButton(action);
    if (!button) throw new Error(`工具栏里没有 ${action}`);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    button.dispatchEvent(down);
    if (!down.defaultPrevented) button.focus();
    return down;
  };

  it('按下工具栏按钮：编辑器不掉焦点、选区逐字段不变', async () => {
    const view = await renderApp();
    view.focus();
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    const before = view.state.selection;
    expect(editorHasFocus(view)).toBe(true);

    for (const action of ['undo', 'redo', 'toggle-surface', 'find', 'more']) {
      const down = pressLeftButton(action);
      // 拦在 `mousedown` 上，不是 `click` —— 焦点在按下那一刻就换手了。
      expect(down.defaultPrevented, `${action} 的 mousedown 该被拦下`).toBe(true);
      expect(editorHasFocus(view), `${action} 按下后编辑器丢了焦点`).toBe(true);
      expect(view.state.selection.eq(before), `${action} 按下后选区变了`).toBe(true);
    }
  });

  it('反面：右键不被拦 —— 上下文菜单要用它', async () => {
    const view = await renderApp();
    view.focus();

    const button = toolbarButton('undo')!;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });
    button.dispatchEvent(down);

    expect(down.defaultPrevented).toBe(false);
  });

  it('只读文档：工具栏仍在，写动作禁用、读 / 视图动作可用', async () => {
    await renderApp(true);

    // 反面在前：蓝图 §19 要的是「降级」，不是把整条栏收走。
    expect(container.querySelector('.nexus-editor-toolbar')).not.toBeNull();

    for (const action of ['undo', 'redo', 'more']) {
      expect(toolbarButton(action)!.disabled, `${action} 该被禁用`).toBe(true);
    }
    for (const action of ['toggle-surface', 'find']) {
      expect(toolbarButton(action)!.disabled, `${action} 不该被禁用`).toBe(false);
    }

    // 只读横幅也在（同一份 `saveState === 'readonly'` 派生），顺带确认没接错源。
    expect(container.querySelector('.nexus-warning-banner')).not.toBeNull();
  });
});

/**
 * 选区上下文条在**真实 App + 真实 CodeMirror view** 上的接线。
 *
 * 组件自己的分支（动作集、翻转、禁用、焦点）在 `renderer/test/selection-toolbar.test.tsx`
 * 里钉过了。这里只证两件组件测试证不了的事：
 *
 * 1. **锚点真的从 `view.state.selection` 量出来**，量出来之后整条才画。
 *    `renderer/test` 那边锚点是手喂的，喂错了也绿。
 * 2. **按钮点下去走的是宿主命令**：断言 `session` 里的 source 真的变了 ——
 *    只断言「回调被调用」的话，把 `onAction` 接到一个空函数上照样绿。
 *
 * ## 为什么要给 `coordsAtPos` 打桩
 *
 * happy-dom 没有排版引擎，`view.coordsAtPos()` **恒返回 `null`**（实测），于是
 * `useSelectionAnchor` 永远量不到锚点、整条永远不画 —— 这不是代码的毛病，
 * 是环境缺了「文字排在哪儿」这件事实。测试把那份事实补上（一条固定的矩形），
 * 被测的那条链（选区 → 锚点 → 出现 → 命令）就是真的。
 *
 * 桩打在**实例**上而不是原型上：`activeView` 是这条链上唯一那个 view，
 * 打在原型上会漏给同进程后面的用例。
 */
describe('选区上下文条 · 真机接线', () => {
  let container: HTMLDivElement;
  let root: Root;
  let restoreSelectionDispatch: () => void;

  beforeEach(() => {
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
  });

  function installBridge(): void {
    const opened = { path: 'D:/test-doc.md', content: SOURCE };
    testWindow.nexus = {
      getLaunchContext: vi.fn().mockResolvedValue({
        mode: 'lightweight',
        filePath: opened.path
      }),
      openFile: vi.fn().mockResolvedValue(opened),
      readFile: vi.fn().mockResolvedValue(SOURCE),
      writeFile: vi.fn().mockResolvedValue(undefined),
      saveAs: vi.fn().mockResolvedValue('D:/saved.md'),
      setDirty: vi.fn(),
      watchFile: vi.fn(() => () => {}),
      onSaveAndCloseRequested: vi.fn().mockReturnValue(() => {}),
      readyToClose: vi.fn(),
      closeWindow: vi.fn(),
      minimizeWindow: vi.fn(),
      maximizeWindow: vi.fn(),
      getWindowState: vi.fn().mockResolvedValue({ maximized: false }),
      onWindowStateChanged: vi.fn().mockReturnValue(() => {}),
      // 「插入链接」的面板要的候选表。放两篇，好让「挑中的是这一篇」有意义 ——
      // 只有一篇时「挑对了」与「随便挑一个」是同一条断言。
      listIndexedDocuments: vi.fn().mockResolvedValue([
        indexedDocument('notes/dma.md'),
        indexedDocument('notes/ethercat.md')
      ])
    } as unknown as NexusBridge;
  }

  async function renderApp(): Promise<EditorView> {
    installBridge();
    root.render(React.createElement(App));

    const start = Date.now();
    while (Date.now() - start < 5000) {
      const toolbar = container.querySelector('.nexus-editor-toolbar');
      if (testWindow.nexusActiveView && testWindow.nexusSession && toolbar) {
        return testWindow.nexusActiveView;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('等 App 起来超时（编辑器工具栏没出现）');
  }

  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`等待超时：${label}`);
  }

  const bar = () => container.querySelector<HTMLElement>('[data-selection-toolbar]');

  const selectionButton = (action: string) =>
    container.querySelector<HTMLButtonElement>(`[data-selection-toolbar] [data-action="${action}"]`);

  /** 给这个 view 补上 happy-dom 缺的那份「排版」：任何位置都落在同一条矩形上。 */
  const stubLayout = (view: EditorView) =>
    vi.spyOn(view, 'coordsAtPos').mockImplementation(() => ({
      top: 100,
      bottom: 120,
      left: 40,
      right: 90
    }));

  /** 派一次 click，并给 React 一轮刷新的机会（本文件没开 `IS_REACT_ACT_ENVIRONMENT`）。 */
  const clickInBar = async (action: string) => {
    selectionButton(action)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('选中文字后浮出，按钮按 §3.1 的顺序排开', async () => {
    const view = await renderApp();
    stubLayout(view);
    view.focus();
    view.dispatch({ selection: { anchor: 6, head: 11 } }); // 'world'

    await waitFor(() => bar() !== null, '选区上下文条出现');

    expect(
      Array.from(bar()!.querySelectorAll('[data-action]')).map((el) => el.getAttribute('data-action'))
    ).toEqual([
      'format.bold',
      'format.italic',
      'format.strike',
      'format.inline-code',
      'format.insert-link',
      'format.clear-formatting'
    ]);
  });

  it('反面：空选区时不出现（光标移动不该弹出工具条）', async () => {
    const view = await renderApp();
    stubLayout(view);
    view.focus();
    view.dispatch({ selection: { anchor: 3, head: 3 } });
    // 给足两轮 React 更新的时间，避免「还没渲染出来」被误判成「不会出现」
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(bar()).toBeNull();
  });

  it('点加粗按钮：走宿主命令，session 里的 source 真的变了', async () => {
    const view = await renderApp();
    stubLayout(view);
    view.focus();
    view.dispatch({ selection: { anchor: 6, head: 11 } });
    await waitFor(() => bar() !== null, '选区上下文条出现');

    await clickInBar('format.bold');

    expect(testWindow.nexusSession!.getSnapshot().source).toBe('Hello **world**');
  });

  it('点清除格式按钮：同样走宿主命令', async () => {
    const view = await renderApp();
    stubLayout(view);
    view.focus();
    // 先把 world 加粗，再选中它，然后清除
    view.dispatch({ selection: { anchor: 6, head: 11 } });
    await waitFor(() => bar() !== null, '选区上下文条出现');
    await clickInBar('format.bold');
    expect(testWindow.nexusSession!.getSnapshot().source).toBe('Hello **world**');

    view.dispatch({ selection: { anchor: 8, head: 13 } });
    await waitFor(() => bar() !== null, '选中加粗内容后条仍在');
    await clickInBar('format.clear-formatting');

    expect(testWindow.nexusSession!.getSnapshot().source).toBe('Hello world');
  });

  it('点外部关闭，且选区没变时不自己回来', async () => {
    const view = await renderApp();
    stubLayout(view);
    view.focus();
    view.dispatch({ selection: { anchor: 6, head: 11 } });
    await waitFor(() => bar() !== null, '选区上下文条出现');

    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    outside.remove();

    await waitFor(() => bar() === null, '点外部后条关掉');

    // 选区变了就该重新浮出来 —— 抑制只在「同一次选区」内有效
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    await waitFor(() => bar() !== null, '换一段选区后条重新出现');
  });

  /**
   * 插入链接（P1-2）在这一层的两条契约。
   *
   * 组件自己的分支（过滤、上下键、空态、点遮罩）在
   * `renderer/test/insert-link-palette.test.tsx` 里钉过了；写出来的字符串长什么样
   * 在 `packages/editor/test/insert-text.test.ts`。这里只证**接起来**的那一段：
   * 按钮 → 面板 → 挑一篇 → `session` 里的 source 真的多了一条链接，
   * 而且链接文字是**选中的那一段**（不是目标文档的标题）。
   */
  const palette = () => container.querySelector<HTMLElement>('[data-insert-link-palette]');

  const clickInPalette = async (relativePath: string) => {
    container
      .querySelector(`[data-insert-link-item="${relativePath}"]`)!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('点插入链接按钮：面板浮出并列出索引里的文档', async () => {
    const view = await renderApp();
    stubLayout(view);
    view.focus();
    view.dispatch({ selection: { anchor: 6, head: 11 } });
    await waitFor(() => bar() !== null, '选区上下文条出现');

    // 反面在前：没点之前它不该在
    expect(palette()).toBeNull();

    await clickInBar('format.insert-link');
    await waitFor(() => palette() !== null, '插入链接面板出现');

    expect(
      Array.from(container.querySelectorAll('[data-insert-link-item]')).map((el) =>
        el.getAttribute('data-insert-link-item')
      )
    ).toEqual(['notes/dma.md', 'notes/ethercat.md']);
  });

  it('挑一篇：写进 source 的是链接，链接文字是**选中的那一段**', async () => {
    const view = await renderApp();
    stubLayout(view);
    view.focus();
    view.dispatch({ selection: { anchor: 6, head: 11 } }); // 'world'
    await waitFor(() => bar() !== null, '选区上下文条出现');

    await clickInBar('format.insert-link');
    await waitFor(() => palette() !== null, '插入链接面板出现');
    await clickInPalette('notes/dma.md');

    // 默认档是 wikilink：选中文字进别名，选中的那段文字**没有被吞掉**
    expect(testWindow.nexusSession!.getSnapshot().source).toBe('Hello [[dma|world]]');
    // 插完面板自己关掉
    await waitFor(() => palette() === null, '插入后面板关掉');
  });

  it('反面：挑另一篇写出来的是另一篇 —— 防止「挑谁都写第一篇」', async () => {
    const view = await renderApp();
    stubLayout(view);
    view.focus();
    view.dispatch({ selection: { anchor: 6, head: 11 } });
    await waitFor(() => bar() !== null, '选区上下文条出现');

    await clickInBar('format.insert-link');
    await waitFor(() => palette() !== null, '插入链接面板出现');
    await clickInPalette('notes/ethercat.md');

    expect(testWindow.nexusSession!.getSnapshot().source).toBe('Hello [[ethercat|world]]');
  });
});
