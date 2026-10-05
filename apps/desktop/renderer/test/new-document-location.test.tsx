// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from '../src/App.js';
import { commandRegistry, settings } from '../src/platform.js';
import type { NexusBridge } from '../../preload/types.js';

/**
 * 「新建文档默认位置」的**接线**用例。
 *
 * 为什么要有这一层：`paths.ts` 的 `newDocumentDirectory` 已经单测过判断本身，
 * `file-service.test.ts` 也钉住了「`defaultPath` 会透传给对话框」。但中间那一段
 * ——「设置值 + 工作区根 + 记住的目录 → 真的作为第二个参数传给了桥」—— 两边都盖不到。
 * 少了它，把 `saveAs(content, dir)` 写成 `saveAs(dir, content)` 也能全绿。
 *
 * 判据取 `saveAs` 收到的**第二个参数**，不取文件写到哪：保存对话框在真机里是原生窗口、
 * 在这里是打桩的，写盘路径由 mock 决定，与 defaultPath 无关。
 *
 * 覆盖不到的一格：工作区模式下**先打开某个文件再新建**。那条路要在真机上点工作区树，
 * 而这里的桥是打桩的、没有索引。`document` 档位在有/无记住目录两种情形各自被
 * 轻量模式与「工作区模式从未打开文件」覆盖，判断本身在 `paths.test.ts` 里补全。
 */
const testWindow = window as Window & {
  nexusActiveView?: unknown;
  nexusSession?: unknown;
};

/** 桥的打桩与另两个 App 级用例同形 —— 只补 App 启动时会碰到的那些方法。 */
function stubBridge(options: {
  launchContext: Record<string, unknown>;
  filePath: string;
  content: string;
  saveAs: NexusBridge['saveAs'];
}): void {
  testWindow.nexus = {
    getLaunchContext: vi.fn().mockResolvedValue(options.launchContext),
    openFile: vi.fn().mockResolvedValue({ path: options.filePath, content: options.content }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    saveAs: options.saveAs,
    readFile: vi.fn().mockResolvedValue(options.content),
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

/** 轮询到条件成立 —— `saveFile` 走的是 `enqueueSave` 的微任务链，一次 `setTimeout(0)` 不够。 */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待超时');
}

describe('新建文档默认位置 · 保存对话框的起点', () => {
  let container: HTMLDivElement;
  let root: Root;
  let saveAsSpy: ReturnType<typeof vi.fn>;
  let restoreSelectionDispatch: () => void;

  beforeEach(() => {
    // happy-dom 对 `selectionchange` 的同步派发会让 CodeMirror 抖；与另两个 App 级用例同样处理。
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
    settings.set('files.newDocumentLocation', 'document');

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    saveAsSpy = vi.fn().mockResolvedValue('D:/notes/untitled.md');
  });

  afterEach(() => {
    restoreSelectionDispatch?.();
    root.unmount();
    container.remove();
    delete testWindow.nexus;
    delete testWindow.nexusSession;
    delete testWindow.nexusActiveView;
    settings.set('files.newDocumentLocation', 'document');
  });

  /**
   * 启动 → 新建空文档 → 保存，返回 `saveAs` 收到的第二个参数。
   *
   * 等就绪不能等编辑器：**工作区模式下启动时没有文档**（`App.tsx` 明确不伪造空编辑器），
   * 所以先等命令注册好，再 `new-file` 让编辑器出现。
   */
  async function saveNewDocument(): Promise<string | null | undefined> {
    root.render(React.createElement(App));
    await waitFor(() => Boolean(commandRegistry.getCommand('new-file')));

    commandRegistry.executeCommand('new-file');
    await waitFor(() => Boolean(testWindow.nexusActiveView && testWindow.nexusSession));

    commandRegistry.executeCommand('save');
    await waitFor(() => saveAsSpy.mock.calls.length > 0);
    return saveAsSpy.mock.calls[0]?.[1] as string | null | undefined;
  }

  it('轻量模式默认档位：把「刚才那个文档的目录」交给对话框', async () => {
    stubBridge({
      launchContext: { mode: 'lightweight', filePath: 'D:/notes/current.md' },
      filePath: 'D:/notes/current.md',
      content: 'Hello world',
      saveAs: saveAsSpy
    });

    expect(await saveNewDocument()).toBe('D:/notes');
  });

  it('轻量模式选了「工作区根目录」但没有工作区：回落到刚才那个目录，而不是不给起点', async () => {
    settings.set('files.newDocumentLocation', 'workspace');
    stubBridge({
      launchContext: { mode: 'lightweight', filePath: 'D:/notes/current.md' },
      filePath: 'D:/notes/current.md',
      content: 'Hello world',
      saveAs: saveAsSpy
    });

    expect(await saveNewDocument()).toBe('D:/notes');
  });

  it('工作区模式选了「工作区根目录」：用它', async () => {
    settings.set('files.newDocumentLocation', 'workspace');
    stubBridge({
      launchContext: { mode: 'workspace', workspaceRoot: 'C:/vault' },
      filePath: 'C:/vault/notes/current.md',
      content: 'Hello world',
      saveAs: saveAsSpy
    });

    expect(await saveNewDocument()).toBe('C:/vault');
  });

  it('工作区模式默认档位、又从未打开过文件：传 null，让主进程走「不给 defaultPath」那条老路', async () => {
    stubBridge({
      launchContext: { mode: 'workspace', workspaceRoot: 'C:/vault' },
      filePath: 'C:/vault/notes/current.md',
      content: 'Hello world',
      saveAs: saveAsSpy
    });

    // 工作区模式下启动不打开任何文件 ⇒ 没有「当前文档目录」可记。`openFile` 在这条路径上
    // 根本不会被调用（那是轻量模式的入口），所以打桩里给的路径不会污染结果。
    expect(await saveNewDocument()).toBeNull();
  });
});
