// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from '../src/App.js';
import type { EditorView, MarkdownDocumentSession } from '@nexus/editor';

const testWindow = window as Window & {
  nexusActiveView?: EditorView;
  nexusSession?: MarkdownDocumentSession;
};

describe('Desktop UI & Standards Review Fixes', () => {
  let container: HTMLDivElement;
  let root: Root;
  let restoreSelectionDispatch: () => void;
  let writeTextSpy: ReturnType<typeof vi.fn>;

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

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: writeTextSpy,
        readText: vi.fn().mockResolvedValue('pasted text')
      },
      configurable: true
    });

    testWindow.nexus = {
      getLaunchContext: vi.fn().mockResolvedValue({
        mode: 'lightweight',
        filePath: 'D:/test-doc.md'
      }),
      openFile: vi.fn().mockResolvedValue({
        path: 'D:/test-doc.md',
        content: 'Hello world'
      }),
      writeFile: vi.fn().mockResolvedValue(),
      saveAs: vi.fn().mockResolvedValue('D:/saved.md'),
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
    };
  });

  afterEach(() => {
    restoreSelectionDispatch?.();
    root.unmount();
    container.remove();
    delete testWindow.nexus;
    delete testWindow.nexusSession;
    delete testWindow.nexusActiveView;
  });

  async function waitForAppReady(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (testWindow.nexusActiveView && testWindow.nexusSession) {
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Timeout waiting for App to initialize');
  }

  it('verifies Command Palette opens on Mod-K and not on Mod-Shift-P', async () => {
    root.render(React.createElement(App));
    await waitForAppReady();

    // 1. Mod-Shift-P should NOT open palette
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        code: 'KeyP',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true
      })
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector('.nexus-command-palette')).toBeNull();

    // 2. Mod-K should open palette
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        code: 'KeyK',
        ctrlKey: true,
        bubbles: true
      })
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector('.nexus-command-palette')).not.toBeNull();
  });

  // 「主题按钮用 SVG 不用 emoji」那条已移走：按钮从标题栏搬到了活动栏，而活动栏只在
  // 工作区模式渲染，这里的 App 是轻量模式启动的。判据现在由 `renderer/test/activity-bar.test.tsx`
  // 直接渲染活动栏组件来守（顺带守住了「切不动时禁用」与「不混进活动入口清单」两件事）。

  /**
   * 「文件」菜单里那几项工作区入口的哨兵。
   *
   * 分两段断言：**有 `id` 的按 `data-menu-item` 找**，没有 `id` 的才按文案找。
   * 全文案匹配在这里已经不可靠了 —— 「打开最近的工作区」也含「工作区」三个字，
   * 按正则挑第一条会命中错的那一条（这条用例原先就是这么找的，加了新项之后必红）。
   */
  it('verifies MenuBar File menu includes workspace and folder actions', async () => {
    root.render(React.createElement(App));
    await waitForAppReady();

    // Click File menu
    const fileMenuTrigger = Array.from(
      container.querySelectorAll('.nexus-menu-bar-button')
    ).find((el) => el.textContent?.trim() === 'File' || el.textContent?.trim() === '文件') as HTMLButtonElement;
    expect(fileMenuTrigger).toBeDefined();
    fileMenuTrigger.click();
    await new Promise((r) => setTimeout(r, 50));

    const dropdown = container.querySelector('.nexus-menu-dropdown');
    expect(dropdown).not.toBeNull();

    const itemIds = Array.from(dropdown!.querySelectorAll('.nexus-menu-item')).map((el) =>
      el.getAttribute('data-menu-item')
    );
    // 三个「工作区」入口一个都不能少：打开文件夹、打开最近的工作区、在工作区中打开。
    expect(itemIds).toContain('open-folder');
    expect(itemIds).toContain('open-recent-workspace');
    expect(itemIds).toContain('open-in-workspace');

    // 下面两项还没有 `id`，仍按文案守 —— 文案本身也是这一条要盯的东西。
    const itemTexts = Array.from(dropdown!.querySelectorAll('.nexus-menu-item')).map((el) =>
      el.textContent?.trim()
    );
    expect(itemTexts.some((t) => t?.includes('Containing Folder') || t?.includes('所在文件夹'))).toBe(true);
    expect(itemTexts.some((t) => t?.includes('File Explorer') || t?.includes('文件管理器'))).toBe(true);
  });

  it('verifies copy and cut use session selection and clipboard API', async () => {
    root.render(React.createElement(App));
    await waitForAppReady();

    const session = testWindow.nexusSession!;
    // Set selection in session: 'world' (pos 6 to 11 in 'Hello world')
    session.dispatch({
      changes: [],
      selection: { anchor: 6, head: 11 }
    });

    // Click Edit menu
    const editMenuTrigger = Array.from(
      container.querySelectorAll('.nexus-menu-bar-button')
    ).find((el) => el.textContent?.trim() === 'Edit' || el.textContent?.trim() === '编辑') as HTMLButtonElement;
    expect(editMenuTrigger).toBeDefined();
    editMenuTrigger.click();
    await new Promise((r) => setTimeout(r, 50));

    // Find Copy item and click
    const copyItem = Array.from(
      container.querySelectorAll('.nexus-menu-item')
    ).find((el) => el.textContent?.includes('Copy') || el.textContent?.includes('复制')) as HTMLButtonElement;
    expect(copyItem).toBeDefined();
    copyItem.click();
    await new Promise((r) => setTimeout(r, 50));

    expect(writeTextSpy).toHaveBeenCalledWith('world');

    // Now test Cut: re-open Edit menu, click Cut
    editMenuTrigger.click();
    await new Promise((r) => setTimeout(r, 50));
    const cutItem = Array.from(
      container.querySelectorAll('.nexus-menu-item')
    ).find((el) => el.textContent?.includes('Cut') || el.textContent?.includes('剪切')) as HTMLButtonElement;
    expect(cutItem).toBeDefined();
    cutItem.click();
    await new Promise((r) => setTimeout(r, 50));

    expect(writeTextSpy).toHaveBeenCalledWith('world');
    // Session should now have 'world' deleted -> 'Hello '
    expect(session.getSnapshot().source).toBe('Hello ');
  });
});
