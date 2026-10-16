// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { documentTypeForPath, type IndexedDocument } from '@nexus/core';
import { App } from '../src/App.js';
import { settings } from '../src/platform.js';
import { writeClipboard } from '../src/workspace/clipboard.js';
import type { NexusBridge } from '../../preload/types.js';
import type {
  CopyFileRequest,
  MoveFileRequest,
  RenameFileChange,
  TransferResult
} from '../../ipc/channels.js';

/**
 * 「复制 / 移动 / 粘贴 / 剪切」在 `App.tsx` 这一层的接线。
 *
 * 为什么要有这一层：真机用例（`file-transfer.test.ts`）能证「右键 → 搬完 → 树更新」，
 * 但一个文件只能跑一种形状，覆盖不到几条**写错了也不报错**的分支：
 *
 * - **剪切与复制走两条通道**：`cut` 必须落到 `moveFile`、`copy` 必须落到 `copyFile`。
 *   写成「都走复制」在真机上也看不出差别（结果一样有那个文件），用户那边却是
 *   「我剪了，原件还在」—— 而原件还在意味着他下次再打开的还是旧的。
 * - **取消对话框一次 IPC 都不发**：`chooseDirectory` 返回 `null` 时不能顺手按
 *   默认目录干下去。这一条与改名那两段式是同一条判据。
 * - **两段式**：移动要改别人的文档，所以先 `dryRun: true` 试算、用户点头才落盘。
 * - **剪贴板在搬运后清空**：不清的话再点一次「粘贴」会按「源不存在」报错，
 *   而那是我们自己的状态没跟上，不是用户的错。
 * - **失败要把 watcher 装回来**：搬运前先卸旧 watcher（不然我们自己的动作会被
 *   报成 `deleted`），失败时路径没变 —— 不装回来那篇文档从此没人监听。
 *
 * 判据取桥收到的**请求体**，不取「文件搬没搬成」：后者对多数分支都成立。
 */
const testWindow = window as Window & { nexus?: unknown };

/** 只关心路径与类型，其余给固定值。`id` 递增 —— 全给 0 会让 `updateDocument` 认错行。 */
let nextId = 0;
function doc(relativePath: string): IndexedDocument {
  const name = relativePath.split('/').pop() ?? relativePath;
  return {
    id: (nextId += 1),
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

describe('文件搬运 · App 接线', () => {
  let container: HTMLDivElement;
  let root: Root;
  let docs: IndexedDocument[];
  let planChanges: RenameFileChange[];
  let moveFileSpy: ReturnType<typeof vi.fn>;
  let copyFileSpy: ReturnType<typeof vi.fn>;
  let chooseDirectorySpy: ReturnType<typeof vi.fn>;
  let watchFileSpy: ReturnType<typeof vi.fn>;
  let alertSpy: ReturnType<typeof vi.fn>;
  let restoreSelectionDispatch: () => void;
  let originalAlert: typeof window.alert;

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
    settings.set('files.updateLinksOnRename', true);
    // 剪贴板是**模块级**的，同一个进程里跨用例留着 —— 不清的话下一条用例一上来就有东西。
    writeClipboard(null);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    nextId = 0;
    docs = [doc('root.md'), doc('other.md')];
    planChanges = [];

    /**
     * 打桩的桥自己实现「搬运」：算落点 + 改盘 + 就地更新索引那一行。
     *
     * 索引必须跟着改，否则树重读之后还是旧路径，断言就变成在测桩子。
     * 重名加序号那条规则**不在这里模拟**：它是主进程的（`file-service-transfer.test.ts`
     * 管那一段），这一层关心的是「落点由结果决定，不是这边猜的」。
     */
    moveFileSpy = vi.fn(async (request: MoveFileRequest): Promise<TransferResult> => {
      const from = request.entries[0]!.path;
      const name = from.slice(from.lastIndexOf('/') + 1);
      const to = `${request.targetDirectory}/${name}`;
      const fromRelative = from.slice('C:/vault/'.length);
      const toRelative = to.slice('C:/vault/'.length);

      if (!request.dryRun) {
        docs = docs.map((item) => (item.path === from ? { ...item, path: to, relativePath: toRelative } : item));
      }

      return {
        // 试算不改盘，所以不报「搬了哪些」
        transferred: request.dryRun
          ? []
          : [{ from, to, fromRelativePath: fromRelative, toRelativePath: toRelative }],
        target: to,
        changes: planChanges,
        skipped: []
      };
    });

    copyFileSpy = vi.fn(async (request: CopyFileRequest): Promise<TransferResult> => {
      const from = request.entries[0]!.path;
      const name = from.slice(from.lastIndexOf('/') + 1);
      const copyName = name.replace(/(\.[^.]+)?$/, (extension) => `-1${extension}`);
      const to = `${request.targetDirectory}/${copyName}`;

      if (!request.dryRun) {
        docs = [...docs, { ...doc(to.slice('C:/vault/'.length)), path: to }];
      }

      return {
        transferred: request.dryRun
          ? []
          : [
              {
                from,
                to,
                fromRelativePath: from.slice('C:/vault/'.length),
                toRelativePath: to.slice('C:/vault/'.length)
              }
            ],
        target: to,
        // 复制**不改别人的文档**，所以恒空 —— 这也是它不需要确认屏的理由
        changes: [],
        skipped: []
      };
    });

    chooseDirectorySpy = vi.fn(async () => 'C:/vault/notes');
    watchFileSpy = vi.fn(() => vi.fn());
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
      listWorkspaceDirectories: vi.fn(async () => [
        { path: 'C:/vault/notes', relativePath: 'notes', name: 'notes' }
      ]),
      moveFile: moveFileSpy,
      copyFile: copyFileSpy,
      chooseDirectory: chooseDirectorySpy
    } as unknown as NexusBridge;
  });

  afterEach(() => {
    restoreSelectionDispatch?.();
    root.unmount();
    container.remove();
    window.alert = originalAlert;
    delete testWindow.nexus;
    writeClipboard(null);
    settings.set('files.updateLinksOnRename', true);
  });

  /**
   * 轮询到条件成立。
   *
   * 这一层不能假设「派发完 DOM 事件，React 就同步重渲染完了」：本文件没有把
   * `IS_REACT_ACT_ENVIRONMENT` 打开（另几个 App 级用例也没有），于是更新走的是
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

  function row(relativePath: string): HTMLElement {
    const found = container.querySelector<HTMLElement>(`[data-relative-path="${relativePath}"]`);
    if (!found) throw new Error(`树上找不到 ${relativePath}`);
    return found;
  }

  /** 在树上的某一行右键，并等菜单出来。 */
  async function rightClickRow(relativePath: string): Promise<void> {
    row(relativePath).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 80 })
    );
    await waitFor(() => container.querySelector('[data-context-menu]') !== null, '右键菜单出现');
  }

  /** 点菜单里的某一项，并等菜单关掉 —— 不关掉的话下一次右键会读到上一份。 */
  async function clickMenuItem(id: string): Promise<void> {
    await waitFor(
      () => container.querySelector(`[data-context-menu-item="${id}"]`) !== null,
      `菜单项 ${id} 出现`
    );
    container.querySelector<HTMLElement>(`[data-context-menu-item="${id}"]`)!.click();
    await waitFor(() => container.querySelector('[data-context-menu]') === null, '菜单关闭');
  }

  /** 右键某一项时菜单里的条目 id（分隔符不带 `data-context-menu-item`）。 */
  async function menuIds(relativePath: string): Promise<(string | null)[]> {
    await rightClickRow(relativePath);
    const ids = Array.from(container.querySelectorAll<HTMLElement>('[data-context-menu-item]')).map(
      (el) => el.getAttribute('data-context-menu-item')
    );
    // 关掉，免得影响后面的用例。菜单监听的是 window 上的 `blur`（不是文档上的 Escape），
    // 所以照它认得的方式关。
    window.dispatchEvent(new Event('blur'));
    await waitFor(() => container.querySelector('[data-context-menu]') === null, '菜单关闭');
    return ids;
  }

  /** 底部那条回执（「已复制到 …」）。搬运完的落点只在这里看得见 —— 树上的目标目录是收着的。 */
  function noticeText(): string {
    return container.querySelector('[data-copy-link-notice]')?.textContent ?? '';
  }

  function moveCalls(dryRun: boolean): MoveFileRequest[] {
    return moveFileSpy.mock.calls
      .map((call) => call[0] as MoveFileRequest)
      .filter((request) => request.dryRun === dryRun);
  }

  it('文件菜单：复制 / 剪切 / 复制到 / 移动到在前，删除垫底', async () => {
    await renderTree();

    expect(await menuIds('root.md')).toEqual([
      'copy',
      'cut',
      'copy-to',
      'move-to',
      'rename',
      'copy-link',
      'delete'
    ]);
  });

  it('目录菜单：粘贴在最前，且剪贴板空着时是灰的（不是不出现）', async () => {
    await renderTree();

    expect(await menuIds('notes')).toEqual([
      'paste',
      'new-file',
      'new-folder',
      'copy',
      'cut',
      'copy-to',
      'move-to'
    ]);

    await rightClickRow('notes');
    expect(
      container.querySelector('[data-context-menu-item="paste"]')?.hasAttribute('disabled')
    ).toBe(true);
  });

  it('剪切 → 粘贴：走 moveFile，一次 copyFile 都不发', async () => {
    await renderTree();

    await rightClickRow('root.md');
    await clickMenuItem('cut');

    // 剪切唯一的可见反馈：源行灰掉
    await waitFor(() => row('root.md').getAttribute('data-cut') === 'true', '源行变灰');

    await rightClickRow('notes');
    await clickMenuItem('paste');
    await waitFor(() => moveCalls(false).length > 0, 'dryRun: false 执行');

    expect(moveCalls(false)[0]).toMatchObject({
      rootPath: 'C:/vault',
      targetDirectory: 'C:/vault/notes',
      entries: [{ path: 'C:/vault/root.md' }],
      updateLinks: true,
      dryRun: false
    });
    // 这一条是重点：写成「都走复制」在这里就会露出来
    expect(copyFileSpy).not.toHaveBeenCalled();
  });

  it('复制 → 粘贴：走 copyFile，一次 moveFile 都不发', async () => {
    await renderTree();

    await rightClickRow('root.md');
    await clickMenuItem('copy');

    // 复制不动原件，所以一行都不该灰
    expect(row('root.md').getAttribute('data-cut')).toBeNull();

    await rightClickRow('notes');
    await clickMenuItem('paste');
    await waitFor(() => copyFileSpy.mock.calls.length > 0, 'copyFile 被调用');

    expect(copyFileSpy.mock.calls[0]![0]).toMatchObject({
      rootPath: 'C:/vault',
      targetDirectory: 'C:/vault/notes',
      entries: [{ path: 'C:/vault/root.md' }]
    });
    expect(moveFileSpy).not.toHaveBeenCalled();
    // 副本进了索引（落点是主进程算的，这里由桩子代劳）—— 回执上那个名字就是它
    await waitFor(() => noticeText().includes('notes/root-1.md'), '回执报出落点');
  });

  it('「复制到…」：对话框取消时一次 IPC 都不发', async () => {
    await renderTree();
    chooseDirectorySpy.mockResolvedValueOnce(null);

    await rightClickRow('root.md');
    await clickMenuItem('copy-to');
    await waitFor(() => chooseDirectorySpy.mock.calls.length > 0, '对话框被打开');

    // 这一条是整组的重点：取消之后顺手按默认目录干下去，用户那边就是
    // 「我点了取消，文件还是被复制了」
    expect(copyFileSpy).not.toHaveBeenCalled();
    expect(moveFileSpy).not.toHaveBeenCalled();
  });

  it('「移动到…」：选中的目录就是落点，且对话框带默认起点', async () => {
    await renderTree();
    chooseDirectorySpy.mockResolvedValueOnce('C:/vault/notes');

    await rightClickRow('root.md');
    await clickMenuItem('move-to');
    await waitFor(() => moveCalls(false).length > 0, 'dryRun: false 执行');

    expect(chooseDirectorySpy.mock.calls[0]![0]).toMatchObject({ defaultPath: 'C:/vault' });
    expect(moveCalls(false)[0]).toMatchObject({ targetDirectory: 'C:/vault/notes' });
  });

  it('移动有引用要改时先弹确认屏；取消之后一次都不执行', async () => {
    planChanges = [
      { path: 'C:/vault/other.md', relativePath: 'other.md', before: '[[root]]', after: '[[notes/root]]' }
    ];
    await renderTree();

    await rightClickRow('root.md');
    await clickMenuItem('cut');
    await rightClickRow('notes');
    await clickMenuItem('paste');

    await waitFor(
      () => container.querySelector('#nexus-rename-preview') !== null,
      '确认屏出现'
    );
    // 屏上如实列出会被改的那一篇
    expect(container.textContent).toContain('other.md');
    // 文案换成「移动」那一套，不能沿用「重命名」的说法
    expect(container.querySelector('.nexus-rename-title')?.textContent).toContain('Move');

    // 点取消
    const cancel = Array.from(container.querySelectorAll<HTMLElement>('.nexus-rename-button')).find(
      (button) => button.getAttribute('data-rename-confirm') === null
    )!;
    cancel.click();

    await waitFor(() => container.querySelector('#nexus-rename-preview') === null, '确认屏关闭');
    // 写成「先搬再问」在这里就会露出来
    expect(moveCalls(false)).toHaveLength(0);
  });

  it('确认之后才真搬，并把剪贴板清掉 —— 不然再粘一次会按「源不存在」报错', async () => {
    planChanges = [
      { path: 'C:/vault/other.md', relativePath: 'other.md', before: '[[root]]', after: '[[notes/root]]' }
    ];
    await renderTree();

    await rightClickRow('root.md');
    await clickMenuItem('cut');
    await rightClickRow('notes');
    await clickMenuItem('paste');
    await waitFor(() => container.querySelector('#nexus-rename-preview') !== null, '确认屏出现');

    container.querySelector<HTMLElement>('[data-rename-confirm]')!.click();
    await waitFor(() => moveCalls(false).length > 0, 'dryRun: false 执行');

    // 落点由主进程算，不是这边猜的 —— 回执上那个相对路径就是它
    await waitFor(() => noticeText().includes('notes/root.md'), '回执报出落点');

    // 剪贴板空了：再右键目录，「粘贴」应该又灰回去
    await rightClickRow('notes');
    expect(
      container.querySelector('[data-context-menu-item="paste"]')?.hasAttribute('disabled')
    ).toBe(true);
  });

  /**
   * 搬运前先卸旧 watcher（不卸的话我们自己的动作会被报成 `deleted`，界面显示
   * 「文件被删除」），失败时路径没变 —— 必须装回来，否则那篇文档从此没人监听：
   * 外部改动不再提示，也不自动重载。
   */
  it('移动失败：弹一条消息，并把 watcher 装回来', async () => {
    // 试算成功（零改动 ⇒ 不进确认屏），真搬那一次失败
    moveFileSpy.mockImplementation(async (request: MoveFileRequest) => {
      if (!request.dryRun) throw new Error('EPERM: 目标目录只读');
      return { transferred: [], target: 'C:/vault/notes/root.md', changes: [], skipped: [] };
    });
    await renderTree();

    // 先把 root.md 打开，watcher 才会存在
    row('root.md').click();
    await waitFor(
      () => watchFileSpy.mock.calls.some((call) => call[0] === 'C:/vault/root.md'),
      'root.md 的 watcher 装上'
    );
    const installs = watchFileSpy.mock.calls.filter((call) => call[0] === 'C:/vault/root.md').length;

    await rightClickRow('root.md');
    await clickMenuItem('cut');
    await rightClickRow('notes');
    await clickMenuItem('paste');
    await waitFor(() => alertSpy.mock.calls.length > 0, '失败提示出现');

    expect(String(alertSpy.mock.calls[0]?.[0])).toContain('EPERM: 目标目录只读');
    // 路径没变，所以还是同一个路径重装 —— 装不回来的话这篇文档从此失联
    await waitFor(
      () => watchFileSpy.mock.calls.filter((call) => call[0] === 'C:/vault/root.md').length > installs,
      'watcher 重装'
    );
    // 搬运没成，树上那一行还在原处
    expect(container.textContent).toContain('root.md');
  });

  /** 复制失败只是「没复制成」，原件必须完好 —— 回滚的对象根本不该存在。 */
  it('复制失败：弹一条消息，原件与树都不动', async () => {
    copyFileSpy.mockRejectedValueOnce(new Error('EACCES: 拒绝访问'));
    await renderTree();

    await rightClickRow('root.md');
    await clickMenuItem('copy');
    await rightClickRow('notes');
    await clickMenuItem('paste');
    await waitFor(() => alertSpy.mock.calls.length > 0, '失败提示出现');

    expect(String(alertSpy.mock.calls[0]?.[0])).toContain('EACCES: 拒绝访问');
    expect(container.textContent).not.toContain('root-1.md');
  });
});
