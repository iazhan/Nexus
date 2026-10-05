// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { documentTypeForPath, type IndexedDocument } from '@nexus/core';
import { translate } from '@nexus/i18n';
import { App } from '../src/App.js';
import { localeManager, settings } from '../src/platform.js';
import type { NexusBridge } from '../../preload/types.js';
import type {
  RenameFileChange,
  RenameFileRequest,
  RenameFileResult,
  RenameFileSkip
} from '../../ipc/channels.js';

/**
 * 「重命名文件」在 `App.tsx` 这一层的接线。
 *
 * 真机用例（`rename-file.test.ts`）证明的是「真的改了盘、索引跟着走」，跑一次要冷启动
 * Electron 且只能跑一种形状。这里用打桩的桥把四个**分支**钉住，它们写错了都不会报错：
 *
 * - **两段式**：先 `dryRun: true` 试算，用户点头才 `dryRun: false`。写成一步到位
 *   在真机上也看不出差别（测试里点的都是确认），用户那边却是「我没同意，文件已经被改了」。
 * - **零改动不弹窗**：没有引用要改时直接做完。写成「一律弹」，用户改个没被引用的名字
 *   也要点一次确认，而那一屏上什么内容都没有。
 * - **失败说出来**：改名失败时状态是 `ready`，`setErrorMessage` 只在「文档打不开」那一屏
 *   渲染 —— 复用它等于什么都没显示。
 * - **三处收尾**：标签页路径、树、watcher。少一处就出现「文件没了但树里还在」
 *   或者「界面显示文件被删除」—— 后者是最容易漏的：旧 watcher 会把我们自己的改名
 *   报成 `deleted`。
 *
 * 覆盖不到的一格：真机上弹出的菜单（`position: fixed` 浮在 `overflow-y: auto` 的树容器之上）
 * 与确认屏的实际排版 —— 那要靠真 DOM 排版，`context-menu.test.tsx` / `rename-preview.test.tsx`
 * 与真机用例各管一半。
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

describe('重命名文件 · App 接线', () => {
  let container: HTMLDivElement;
  let root: Root;
  let docs: IndexedDocument[];
  let planChanges: RenameFileChange[];
  let planSkips: RenameFileSkip[];
  let renameFileSpy: ReturnType<typeof vi.fn>;
  let watchFileSpy: ReturnType<typeof vi.fn>;
  /** 每次 `watchFile` 返回的取消订阅函数，按装上顺序。用来判「watcher 有没有被卸掉」。 */
  let unsubSpies: ReturnType<typeof vi.fn>[];
  let alertSpy: ReturnType<typeof vi.fn>;
  let restoreSelectionDispatch: () => void;
  let originalAlert: typeof window.alert;

  beforeEach(() => {
    // happy-dom 对 `selectionchange` 的同步派发会让 CodeMirror 抖；与另四个 App 级用例同样处理。
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
    settings.set('files.updateLinksOnRename', true);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    docs = [doc('root.md')];
    planChanges = [];
    planSkips = [];

    // 打桩的桥自己实现「改名」这件事：改盘 + 就地更新索引那一行。
    // 索引更新必须跟着做，否则树重读之后还是旧名字，断言就变成在测桩子。
    renameFileSpy = vi.fn(async (request: RenameFileRequest): Promise<RenameFileResult> => {
      const from = request.filePath;
      const to = from.replace(/[^/\\]+$/, request.newName);
      const toRelative = to.slice('C:/vault/'.length);

      if (!request.dryRun) {
        docs = docs.map((item) =>
          item.path === from
            ? {
                ...item,
                path: to,
                relativePath: toRelative,
                name: request.newName,
                title: request.newName.replace(/\.[^.]+$/, '')
              }
            : item
        );
      }

      return {
        renamed: request.dryRun ? null : { from, to, relativePath: toRelative },
        changes: planChanges,
        skipped: planSkips
      };
    });

    unsubSpies = [];
    watchFileSpy = vi.fn(() => {
      const unsub = vi.fn();
      unsubSpies.push(unsub);
      return unsub;
    });
    alertSpy = vi.fn();
    originalAlert = window.alert;
    window.alert = alertSpy as unknown as typeof window.alert;

    testWindow.nexus = {
      getLaunchContext: vi.fn().mockResolvedValue({ mode: 'workspace', workspaceRoot: 'C:/vault' }),
      openFile: vi.fn().mockResolvedValue({ path: 'C:/vault/root.md', content: '# Root' }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      saveAs: vi.fn().mockResolvedValue('C:/vault/untitled.md'),
      readFile: vi.fn().mockResolvedValue('# Root'),
      setDirty: vi.fn(),
      watchFile: watchFileSpy,
      onSaveAndCloseRequested: vi.fn().mockReturnValue(() => {}),
      readyToClose: vi.fn(),
      closeWindow: vi.fn(),
      minimizeWindow: vi.fn(),
      maximizeWindow: vi.fn(),
      getWindowState: vi.fn().mockResolvedValue({ maximized: false }),
      onWindowStateChanged: vi.fn().mockReturnValue(() => {}),
      rebuildIndex: vi.fn(async () => ({ ...OK_RESULT, scanned: docs.length })),
      listIndexedDocuments: vi.fn(async () => docs),
      renameFile: renameFileSpy
    } as unknown as NexusBridge;
  });

  afterEach(() => {
    restoreSelectionDispatch?.();
    root.unmount();
    container.remove();
    window.alert = originalAlert;
    delete testWindow.nexus;
    settings.set('files.updateLinksOnRename', true);
  });

  /**
   * 轮询到条件成立。
   *
   * 这一层不能假设「派发完 DOM 事件，React 就同步重渲染完了」：本文件没有把
   * `IS_REACT_ACT_ENVIRONMENT` 打开（另四个 App 级用例也没有），于是更新走的是
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

  function row(name: string): HTMLElement {
    const found = Array.from(container.querySelectorAll<HTMLElement>('.nexus-tree-file')).find(
      (element) => element.querySelector('.nexus-tree-name')?.textContent === name
    );
    if (!found) throw new Error(`树上找不到 ${name}`);
    return found;
  }

  /** 在树上的某一行右键，并等菜单出来。 */
  async function rightClickRow(name: string): Promise<void> {
    row(name).dispatchEvent(
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

  /** 右键 → 重命名 → 等输入框出现。 */
  async function startRename(name: string): Promise<HTMLInputElement> {
    await rightClickRow(name);
    await clickMenuItem('rename');
    await waitFor(
      () => container.querySelector('.nexus-tree-rename-input') !== null,
      '内联输入框出现'
    );
    return container.querySelector<HTMLInputElement>('.nexus-tree-rename-input')!;
  }

  /** 改值再敲 Enter —— 走的就是用户改完名字按回车的路径。 */
  async function commitRename(input: HTMLInputElement, newName: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, newName);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
  }

  /** 试算（`dryRun: true`）那一次调用的入参。 */
  function dryRunCall(): RenameFileRequest | undefined {
    return renameFileSpy.mock.calls
      .map((call) => call[0] as RenameFileRequest)
      .find((request) => request.dryRun);
  }

  /** 执行（`dryRun: false`）那一次调用的入参。 */
  function applyCall(): RenameFileRequest | undefined {
    return renameFileSpy.mock.calls
      .map((call) => call[0] as RenameFileRequest)
      .find((request) => !request.dryRun);
  }

  it('右键 → 重命名：那一行就地变成输入框，一次 IPC 都还没发', async () => {
    await renderTree();

    const input = await startRename('root.md');

    expect(input.value).toBe('root.md');
    // 试算要等用户按下回车才发生 —— 弹出输入框本身不该碰磁盘
    expect(renameFileSpy).not.toHaveBeenCalled();
  });

  it('回车提交：先试算（dryRun），带的是绝对路径与「要更新链接」', async () => {
    // 有计划才停在「已试算、没执行」这一步 —— 零改动会直接做完（另一条用例）。
    planChanges = [
      { path: 'C:/vault/other.md', relativePath: 'other.md', before: '[[root]]', after: '[[root-2]]' }
    ];
    await renderTree();

    const input = await startRename('root.md');
    await commitRename(input, 'root-2.md');
    await waitFor(() => dryRunCall() !== undefined, 'dryRun 试算发出');

    expect(dryRunCall()).toMatchObject({
      filePath: 'C:/vault/root.md',
      newName: 'root-2.md',
      updateLinks: true,
      dryRun: true
    });
    // 还没执行
    expect(applyCall()).toBeUndefined();
  });

  it('试算有改动：弹确认屏；取消之后一次都不执行', async () => {
    planChanges = [
      { path: 'C:/vault/other.md', relativePath: 'other.md', before: '[[root]]', after: '[[root-2]]' }
    ];
    await renderTree();

    const input = await startRename('root.md');
    await commitRename(input, 'root-2.md');
    await waitFor(
      () => container.querySelector('#nexus-rename-preview') !== null,
      '确认屏出现'
    );

    expect(container.textContent).toContain('other.md');

    // 点取消
    const cancel = Array.from(
      container.querySelectorAll<HTMLElement>('.nexus-rename-button')
    ).find((button) => button !== container.querySelector('[data-rename-confirm]'))!;
    cancel.click();

    await waitFor(
      () => container.querySelector('#nexus-rename-preview') === null,
      '确认屏关闭'
    );
    // 这一条是整组的重点：写成「先改再问」在这里就会露出来
    expect(applyCall()).toBeUndefined();
  });

  it('确认之后执行，并收掉三处痕迹：树、标签页路径、watcher', async () => {
    planChanges = [
      { path: 'C:/vault/other.md', relativePath: 'other.md', before: '[[root]]', after: '[[root-2]]' }
    ];
    await renderTree();

    // 先把被改名的文件打开，watcher 才会存在 —— 收尾里的第一条就是给它做的
    row('root.md').click();
    await waitFor(
      () => watchFileSpy.mock.calls.some((call) => call[0] === 'C:/vault/root.md'),
      '旧路径的 watcher 装上'
    );

    const input = await startRename('root.md');
    await commitRename(input, 'root-2.md');
    await waitFor(() => container.querySelector('#nexus-rename-preview') !== null, '确认屏出现');

    container.querySelector<HTMLElement>('[data-rename-confirm]')!.click();
    await waitFor(() => applyCall() !== undefined, 'dryRun: false 执行');

    // ① 树跟着走：新名字出现、旧名字消失（索引那一行由主进程就地 UPDATE）
    await waitFor(() => container.textContent?.includes('root-2.md') === true, '树显示新名字');
    expect(container.querySelector('.nexus-tree-file .nexus-tree-name')?.textContent).toBe(
      'root-2.md'
    );

    // ② 标签页/标题栏读的是 store 里的路径，它必须跟着换
    await waitFor(
      () => container.querySelector('.nexus-filepath-subtitle')?.textContent === 'C:/vault/root-2.md',
      '标题栏路径换成新路径'
    );

    // ③ watcher 用新路径重装 —— 不重装的话这篇文档从此不再被监听
    await waitFor(
      () => watchFileSpy.mock.calls.some((call) => call[0] === 'C:/vault/root-2.md'),
      '新路径的 watcher 装上'
    );

    // 收尾里最容易漏的一格：旧 watcher 会把我们自己的改名报成 deleted，
    // 界面于是显示「文件被删除」—— 而那只是我们自己改的名。
    expect(container.querySelector('.nexus-warning-banner')).toBeNull();
  });

  /**
   * 改名**没打开**的那一个时，绝不能碰当前文档的 watcher。
   *
   * `unwatchRef` 里装的是**活动文档**的 watcher，而被改名的是树上任意一行。无条件先卸的话，
   * 改一个没打开的文件的文件名会把当前那篇的 watcher 卸掉 —— 而它的路径没变、
   * watcher effect 不会重跑，那篇文档从此失联：外部改动再也不提示，也不自动重载。
   * 这一条在真机上几乎撞不到（要恰好开着 A、去改 B），所以必须在这里钉住。
   */
  it('改名一个没打开的文档，当前文档的 watcher 不受影响', async () => {
    docs = [doc('root.md'), doc('other.md')];
    planChanges = [];
    await renderTree();

    // 打开 root.md：它会装上 watcher，成为「当前正在监听的那一个」
    row('root.md').click();
    await waitFor(
      () => watchFileSpy.mock.calls.some((call) => call[0] === 'C:/vault/root.md'),
      'root.md 的 watcher 装上'
    );
    const watchedIndex = watchFileSpy.mock.calls.findIndex(
      (call) => call[0] === 'C:/vault/root.md'
    );
    const rootUnsub = unsubSpies[watchedIndex]!;

    // 改树上**另一行**的名字
    const input = await startRename('other.md');
    await commitRename(input, 'other-2.md');
    await waitFor(() => applyCall() !== undefined, 'dryRun: false 执行');
    await waitFor(() => container.textContent?.includes('other-2.md') === true, '树显示新名字');

    expect(rootUnsub).not.toHaveBeenCalled();
  });

  it('零改动不弹确认屏，直接做完', async () => {
    planChanges = [];
    await renderTree();

    const input = await startRename('root.md');
    await commitRename(input, 'root-2.md');
    await waitFor(() => applyCall() !== undefined, 'dryRun: false 执行');

    // 一屏「没有改动」的 diff 只是多一次点击
    expect(container.querySelector('#nexus-rename-preview')).toBeNull();
    await waitFor(() => container.textContent?.includes('root-2.md') === true, '树显示新名字');
  });

  it('关掉「重命名时更新链接」时也不弹确认屏，且把 false 交给主进程', async () => {
    settings.set('files.updateLinksOnRename', false);
    planChanges = [];
    await renderTree();

    const input = await startRename('root.md');
    await commitRename(input, 'root-2.md');
    await waitFor(() => applyCall() !== undefined, 'dryRun: false 执行');

    expect(dryRunCall()?.updateLinks).toBe(false);
    expect(applyCall()?.updateLinks).toBe(false);
    expect(container.querySelector('#nexus-rename-preview')).toBeNull();
  });

  /**
   * 失败必须**说出来**。不能用 `setErrorMessage`：那个只在 `status === 'error'` 时渲染
   * （「文档打不开」那一屏），而改名失败时状态是 `ready` —— 设了也没人看得见。
   */
  it('试算失败时弹一条消息，树保持原样', async () => {
    await renderTree();

    const input = await startRename('root.md');
    renameFileSpy.mockRejectedValueOnce(new Error('EEXIST: 目标已存在'));
    await commitRename(input, 'root-2.md');
    await waitFor(() => alertSpy.mock.calls.length > 0, '失败提示出现');

    expect(String(alertSpy.mock.calls[0]?.[0])).toContain('EEXIST: 目标已存在');
    // 改名没发生，树上那一行还是旧名字
    expect(container.querySelector('.nexus-tree-file .nexus-tree-name')?.textContent).toBe(
      'root.md'
    );
    expect(applyCall()).toBeUndefined();
  });

  /** 改完名之后的回执：没改到的那些必须如实说，静默跳过等于「链接自己断了」。 */
  it('执行后带回执：跳过项被如实说出来', async () => {
    planSkips = [
      { relativePath: 'busy.md', reason: 'dirty' },
      { relativePath: 'busy2.md', reason: 'dirty' }
    ];
    await renderTree();

    const input = await startRename('root.md');
    await commitRename(input, 'root-2.md');
    await waitFor(() => applyCall() !== undefined, 'dryRun: false 执行');
    await waitFor(() => alertSpy.mock.calls.length > 0, '回执出现');

    // 文案走字典，不写死中文 —— 语言可切，写死会在换语言时假红。
    const message = String(alertSpy.mock.calls[0]?.[0]);
    expect(message).toContain('root-2.md');
    expect(message).toContain(
      translate(localeManager.locale, 'workspace.renameSkipDirty', { count: '2' })
    );
  });
});
