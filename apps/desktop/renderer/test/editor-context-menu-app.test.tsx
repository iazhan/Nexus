// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from '../src/App.js';
import type { EditorView } from '@nexus/editor';
import type { NexusBridge } from '../../preload/types.js';

/**
 * 编辑器正文右键菜单在 `App.tsx` 这一层的接线（2026-10-16，批 C）。
 *
 * 为什么要这一层：原语自己的子菜单行为在 `context-menu.test.tsx` 里钉住了，
 * 但「点『格式 → 粗体』之后正文里**真的**多了一对 `**`」只有把真编辑器接上才证得了 ——
 * 那正是蓝图 `:394` 那句「右键 / 快捷键 / 上下文 toolbar 用同一组命令」的落地判据。
 *
 * 这一组钉五件事：
 *
 * 1. **三段结构**：剪贴板 → 格式（二级）→ 插入链接 / 查找 / 替换。
 * 2. **行内格式只在有非空选区时进子菜单** —— 行内事务在 `anchor === head` 时返回 `null`，
 *    没有选区时给了就是一排按下去没反应的项。
 * 3. **动作真的落到正文上**（不是只画了个菜单）。
 * 4. **只读降级**：写动作灰着、读动作留着（选区上下文条是整条不画，理由不同）。
 * 5. **放过 CodeMirror 自己的浮层**：查找面板里的右键属于文本编辑，抢过来等于拿走它。
 *
 * 覆盖不到的一格：真机上菜单浮在 `overflow: auto` 的滚动容器之上（要真实排版）。
 */
const testWindow = window as Window & { nexusActiveView?: EditorView };

const SOURCE = 'Hello world';
/** `'world'` 在 `SOURCE` 里的区间。 */
const WORLD = { anchor: 6, head: 11 };

describe('编辑器右键菜单 · App 接线', () => {
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
    delete testWindow.nexusActiveView;
  });

  /**
   * 装桥。走 **lightweight** 模式（单文件、无工作区）—— 这一组要的是「有一份真的
   * `EditorView`」，工作区那一整套索引 / 文件树与它无关。
   *
   * `readOnly` 由 `openFile` 的返回值带进来，那是只读态的唯一来源
   * （`store.ts` 把 `input.readOnly` 翻成 `saveState: 'readonly'`）。
   */
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

  /** 轮询到条件成立。这一层不能假设「派发完 DOM 事件 React 就同步重渲染完了」。 */
  async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`等待超时：${what}`);
  }

  /** 渲染 App 并等编辑区起来。返回真的 `EditorView`。 */
  async function renderApp(readOnly = false): Promise<EditorView> {
    installBridge(readOnly);
    root.render(React.createElement(App));

    const start = Date.now();
    while (Date.now() - start < 8000) {
      if (testWindow.nexusActiveView && container.querySelector('.nexus-source-editor')) {
        return testWindow.nexusActiveView;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('等 App 起来超时（编辑区没出现）');
  }

  const editor = () => container.querySelector<HTMLElement>('.nexus-source-editor');

  /**
   * 在编辑区上右键。
   *
   * 默认打在**外壳**上而不是 `.cm-content` 上 —— 那正是「正文下方那块空白」，
   * 也就是本轮决定要覆盖进去的地方（markra 覆盖整张纸，同一条理由）。
   */
  async function rightClickEditor(target?: Element): Promise<void> {
    const host = target ?? editor();
    if (!host) throw new Error('编辑区没渲染出来');
    host.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })
    );
    await waitFor(() => menu() !== null, '右键菜单出现');
  }

  const menu = () => container.querySelector<HTMLElement>('[data-context-menu]');

  /** 一级项。用**子代选择器**把二级面板里的项排除掉 —— 面板是菜单 div 的子节点。 */
  const rootItemIds = () =>
    Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-context-menu] > [data-context-menu-item]'
      )
    ).map((element) => element.dataset.contextMenuItem);

  const subItemIds = () =>
    Array.from(
      container.querySelectorAll<HTMLElement>('[data-context-submenu] [data-context-menu-item]')
    ).map((element) => element.dataset.contextMenuItem);

  const item = (id: string) =>
    container.querySelector<HTMLElement>(`[data-context-menu-item="${id}"]`);

  const isDisabled = (id: string) => item(id)?.hasAttribute('disabled') ?? null;

  /** 展开「格式」二级菜单。点父项只展开，不关菜单。 */
  async function openFormat(): Promise<void> {
    const parent = item('format');
    if (!parent) throw new Error('菜单里没有「格式」');
    parent.click();
    await waitFor(() => container.querySelector('[data-context-submenu]') !== null, '二级菜单展开');
  }

  /** 点一个动作项并等菜单收掉。 */
  async function clickAction(id: string): Promise<void> {
    const target = item(id);
    if (!target) throw new Error(`菜单里没有 ${id}`);
    target.click();
    await waitFor(() => menu() === null, '菜单关闭');
  }

  it('右键编辑区弹出三段式菜单：剪贴板 → 格式 → 插入链接 / 查找 / 替换', async () => {
    await renderApp();

    await rightClickEditor();

    expect(rootItemIds()).toEqual([
      'cut',
      'copy',
      'paste',
      'select-all',
      'format',
      'insert-link',
      'find',
      'replace'
    ]);
    // 文案来自既有键，不是新写的一套
    expect(item('format')?.textContent).toContain('Format');
    expect(item('find')?.textContent).toContain('Find');
    // 「格式」是展开入口，不是普通动作项
    expect(item('format')?.getAttribute('aria-haspopup')).toBe('menu');
  });

  /**
   * 没有非空选区时：剪切 / 复制灰着（`handleCopy` 内部本来就空转，灰着是把这个事实
   * 说出来），粘贴 / 全选照常；而**格式子菜单里没有行内那六项**。
   */
  it('没有选区：剪切 / 复制灰着，且格式子菜单里没有行内格式', async () => {
    await renderApp();

    await rightClickEditor();
    expect(isDisabled('cut')).toBe(true);
    expect(isDisabled('copy')).toBe(true);
    expect(isDisabled('paste')).toBe(false);
    expect(isDisabled('select-all')).toBe(false);

    await openFormat();

    const ids = subItemIds();
    // 行内那六项一个都不该有
    for (const inline of [
      'format.bold',
      'format.italic',
      'format.strike',
      'format.highlight',
      'format.inline-code',
      'format.clear-formatting'
    ]) {
      expect(ids, `${inline} 不该在没有选区时出现`).not.toContain(inline);
    }
    // 块级那一批照常（同源：就是「格式」菜单那张表）
    expect(ids).toContain('format.heading-1');
    expect(ids).toContain('format.quote');
    expect(ids).toContain('format.code-block');
  });

  it('有选区：剪切 / 复制可用，格式子菜单多出行内那六项', async () => {
    const view = await renderApp();
    view.dispatch({ selection: WORLD });
    // 选区要经 `EditorSurface` 的 updateListener 报回宿主，宿主再重渲染 —— 隔一拍。
    await new Promise((resolve) => setTimeout(resolve, 30));

    await rightClickEditor();
    expect(isDisabled('cut')).toBe(false);
    expect(isDisabled('copy')).toBe(false);

    await openFormat();

    const ids = subItemIds();
    for (const inline of [
      'format.bold',
      'format.italic',
      'format.strike',
      'format.highlight',
      'format.inline-code',
      'format.clear-formatting'
    ]) {
      expect(ids, `${inline} 该在有选区时出现`).toContain(inline);
    }
    // 行内在前、块级在后，中间一条分隔线
    expect(ids.indexOf('format.clear-formatting')).toBeLessThan(ids.indexOf('format.paragraph'));
  });

  /**
   * **动作真的落到正文上。** 这一条是整组的核心：它同时证了「菜单项接的是宿主命令」
   * 与「命令的 `execute` 指向同一个 `handleVisualModB`」—— 蓝图 `:394` 的落地判据。
   */
  it('「格式 → 粗体」真的把 `**` 写进正文', async () => {
    const view = await renderApp();
    view.dispatch({ selection: WORLD });
    await new Promise((resolve) => setTimeout(resolve, 30));

    await rightClickEditor();
    await openFormat();

    const bold = item('format.bold');
    expect(bold).not.toBeNull();
    expect(bold!.hasAttribute('disabled')).toBe(false);
    bold!.click();

    // 先断正文、再断菜单关闭 —— 两个都会在超时里挂住，分开写才知道是「动作没跑到」
    // 还是「动作跑了但菜单没关」。
    await waitFor(
      () => view.state.doc.toString().includes('**world**'),
      '正文里出现粗体标记',
      1500
    );
    await waitFor(() => menu() === null, '菜单关闭', 1500);
  });

  /**
   * 只读降级：写动作灰着，**读动作留着**。
   *
   * 与选区上下文条的处理刻意不同 —— 那一条上只有写动作，全灰等于浮一排死按钮，
   * 所以它整条不画；这份菜单还带着复制 / 查找这些读动作，该降级而不是消失。
   */
  it('只读文档：剪切 / 粘贴 / 格式灰着，复制与查找照常', async () => {
    const view = await renderApp(true);
    view.dispatch({ selection: WORLD });
    await new Promise((resolve) => setTimeout(resolve, 30));

    await rightClickEditor();

    expect(isDisabled('cut')).toBe(true);
    expect(isDisabled('paste')).toBe(true);
    expect(isDisabled('format')).toBe(true);
    expect(isDisabled('insert-link')).toBe(true);
    // 复制不写，所以有选区就可用
    expect(isDisabled('copy')).toBe(false);
    expect(isDisabled('find')).toBe(false);
    expect(isDisabled('replace')).toBe(false);
  });

  /**
   * **放过 CodeMirror 自己的浮层。** 查找面板里有输入框，用户在那里右键是要剪切 / 粘贴
   * 文本 —— 抢过来等于把文本编辑的右键整个拿走。与树空白区那条「输入框不算空白处」同源。
   */
  it('查找面板里的右键不弹我们的菜单', async () => {
    await renderApp();

    await rightClickEditor();
    await clickAction('find');
    await waitFor(() => container.querySelector('.cm-panels') !== null, '查找面板出现');

    const panel = container.querySelector('.cm-panels')!;
    panel.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
    );

    // 给 React 一点时间；如果它要弹，这时候已经弹了
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(menu()).toBeNull();
  });

  /** 「查找」接的是既有命令 —— 点完 CM 的查找面板真的开出来。 */
  it('「查找」打开的是 CodeMirror 的文档内查找面板', async () => {
    await renderApp();

    await rightClickEditor();
    await clickAction('find');

    await waitFor(() => container.querySelector('.cm-panels') !== null, '查找面板出现');
  });

  /**
   * 右键在**正文之外的空白**上也弹 —— 那块空白在视觉上就是「纸」。
   * 这里打在外壳元素本身（不是 `.cm-content`），正是那个位置。
   */
  it('正文下方那块空白也能右键', async () => {
    await renderApp();

    const host = editor();
    expect(host).not.toBeNull();
    // 外壳不等于内容区 —— 打在外壳上就是「没命中任何正文行」
    expect(host!.classList.contains('cm-content')).toBe(false);

    await rightClickEditor(host!);

    expect(menu()).not.toBeNull();
    expect(rootItemIds()).toContain('format');
  });
});
