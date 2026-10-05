// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { documentTypeForPath, type IndexedDocument } from '@nexus/core';
import { App } from '../src/App.js';
import { settings } from '../src/platform.js';
import type { NexusBridge } from '../../preload/types.js';

/**
 * 「删除文件」在 `App.tsx` 这一层的接线。
 *
 * 为什么要有这一层：真机用例（`delete-file.test.ts`）能证「右键 → 删掉 → 树更新」这条
 * 主路，但覆盖不到两个**分支**，而它们恰恰是最容易写错、写错了也不报错的：
 *
 * - 永久删除的**确认门**：取消之后必须一次 IPC 都不发。写成「先删再问」在真机上
 *   看不出差别（测试里点的都是确定），用户那边却是「我点了取消，文件还是没了」。
 * - 失败**说出来**：删除失败时状态是 `ready`，而 `setErrorMessage` 只在
 *   `status === 'error'` 时渲染（那是「文档打不开」那一屏）—— 复用它等于什么都没显示。
 *
 * 判据取桥收到的**第二个参数**（`mode`），不取「文件删了没有」：后者对两条分支都成立。
 *
 * 覆盖不到的一格：真机上右键弹出的菜单（`position: fixed` 浮在 `overflow-y: auto` 的树容器
 * 之上）—— 那要靠真 DOM 排版，`context-menu.test.tsx` 与真机用例各管一半。
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
  scanned: 1,
  indexed: 1,
  skipped: 0,
  removed: 0,
  truncated: false,
  errors: [] as string[]
};

describe('删除文件 · App 接线', () => {
  let container: HTMLDivElement;
  let root: Root;
  let deleteFileSpy: ReturnType<typeof vi.fn>;
  let confirmSpy: ReturnType<typeof vi.fn>;
  let alertSpy: ReturnType<typeof vi.fn>;
  let restoreSelectionDispatch: () => void;
  let originalConfirm: typeof window.confirm;
  let originalAlert: typeof window.alert;

  beforeEach(() => {
    // happy-dom 对 `selectionchange` 的同步派发会让 CodeMirror 抖；与另三个 App 级用例同样处理。
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

    deleteFileSpy = vi.fn().mockResolvedValue(undefined);
    confirmSpy = vi.fn(() => true);
    alertSpy = vi.fn();
    // 直接赋值而不是 `spyOn`：`confirm` / `alert` 是原生实现，能不能被 spy 取决于
    // happy-dom 把它放在实例上还是原型上。存下原值手工还原，比赌一个内部布局稳。
    originalConfirm = window.confirm;
    originalAlert = window.alert;
    window.confirm = confirmSpy as unknown as typeof window.confirm;
    window.alert = alertSpy as unknown as typeof window.alert;

    testWindow.nexus = {
      getLaunchContext: vi.fn().mockResolvedValue({ mode: 'workspace', workspaceRoot: 'C:/vault' }),
      openFile: vi.fn().mockResolvedValue({ path: 'C:/vault/root.md', content: '# Root' }),
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
      listIndexedDocuments: vi.fn().mockResolvedValue([doc('root.md')]),
      deleteFile: deleteFileSpy
    } as unknown as NexusBridge;
  });

  afterEach(() => {
    restoreSelectionDispatch?.();
    root.unmount();
    container.remove();
    window.confirm = originalConfirm;
    window.alert = originalAlert;
    delete testWindow.nexus;
    settings.set('files.deleteBehavior', 'trash');
  });

  /**
   * 轮询到条件成立。
   *
   * 这一层不能假设「派发完 DOM 事件，React 就同步重渲染完了」：本文件没有把
   * `IS_REACT_ACT_ENVIRONMENT` 打开（另三个 App 级用例也没有），于是更新走的是
   * 调度器而不是 act 的同步刷新 —— 派发之后立刻断言会读到上一帧。
   */
  async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`等待超时：${what}`);
  }

  /** 渲染 App 并等侧栏树出现 —— 工作区模式下启动时没有文档，只能等树。 */
  async function renderTree(): Promise<void> {
    root.render(React.createElement(App));
    await waitFor(() => container.querySelector('.nexus-tree-file') !== null, '侧栏树出现', 8000);
  }

  /** 在树上的某一行右键，并等菜单出来。 */
  async function rightClickRow(name: string): Promise<void> {
    const row = Array.from(container.querySelectorAll('.nexus-tree-file')).find(
      (element) => element.querySelector('.nexus-tree-name')?.textContent === name
    );
    if (!row) throw new Error(`树上找不到 ${name}`);
    row.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 80 })
    );
    await waitFor(() => container.querySelector('[data-context-menu]') !== null, '右键菜单出现');
  }

  /** 点菜单里的某一项。 */
  async function clickMenuItem(id: string): Promise<void> {
    await waitFor(
      () => container.querySelector(`[data-context-menu-item="${id}"]`) !== null,
      `菜单项 ${id} 出现`
    );
    container.querySelector<HTMLElement>(`[data-context-menu-item="${id}"]`)!.click();
  }

  it('默认档位：右键 → 删除，桥收到绝对路径与 trash，且不弹确认', async () => {
    await renderTree();

    await rightClickRow('root.md');
    await clickMenuItem('delete');
    await waitFor(() => deleteFileSpy.mock.calls.length > 0, 'deleteFile 被调用');

    expect(deleteFileSpy).toHaveBeenCalledWith('C:/vault/root.md', 'trash');
    // 可逆的操作不该拿弹窗烦人 —— 回收站本身就是「后悔」的入口。
    expect(confirmSpy).not.toHaveBeenCalled();
    // 删完菜单自己关掉
    await waitFor(() => container.querySelector('[data-context-menu]') === null, '菜单关闭');
  });

  it('永久删除档位：先确认；取消则一次 IPC 都不发', async () => {
    settings.set('files.deleteBehavior', 'permanent');
    await renderTree();

    confirmSpy.mockReturnValue(false);
    await rightClickRow('root.md');
    await clickMenuItem('delete');
    await waitFor(() => confirmSpy.mock.calls.length > 0, '确认框出现');

    // 这一条是整组的重点：写成「先删再问」在这里就会露出来。
    expect(deleteFileSpy).not.toHaveBeenCalled();
  });

  it('永久删除档位：确认后把 permanent 交给桥', async () => {
    settings.set('files.deleteBehavior', 'permanent');
    await renderTree();

    confirmSpy.mockReturnValue(true);
    await rightClickRow('root.md');
    await clickMenuItem('delete');
    await waitFor(() => deleteFileSpy.mock.calls.length > 0, 'deleteFile 被调用');

    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(deleteFileSpy).toHaveBeenCalledWith('C:/vault/root.md', 'permanent');
  });

  /**
   * 失败必须**说出来**。不能用 `setErrorMessage`：那个只在 `status === 'error'` 时渲染
   * （「文档打不开」那一屏），而删除失败时状态是 `ready` —— 设了也没人看得见。
   */
  it('删除失败时弹一条消息，且不把界面打崩', async () => {
    deleteFileSpy.mockRejectedValueOnce(new Error('EBUSY: 文件被占用'));
    await renderTree();

    await rightClickRow('root.md');
    await clickMenuItem('delete');
    await waitFor(() => alertSpy.mock.calls.length > 0, '失败提示出现');

    expect(String(alertSpy.mock.calls[0]?.[0])).toContain('EBUSY: 文件被占用');
    // 界面上那一行还在（删失败就不该假装删掉了）
    expect(container.textContent).toContain('root.md');
  });
});
