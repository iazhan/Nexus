// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from '../renderer/src/App.js';
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

  it('verifies theme toggle button uses SVG icons instead of emoji', async () => {
    root.render(React.createElement(App));
    await waitForAppReady();

    const themeToggle = container.querySelector('.nexus-theme-toggle') as HTMLButtonElement;
    expect(themeToggle).not.toBeNull();
    // Must NOT contain emoji literals 🌙 or ☀️
    expect(themeToggle.textContent).not.toContain('🌙');
    expect(themeToggle.textContent).not.toContain('☀️');
    // Must contain SVG element
    expect(themeToggle.querySelector('svg')).not.toBeNull();
  });

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
    const itemTexts = Array.from(dropdown!.querySelectorAll('.nexus-menu-item')).map((el) =>
      el.textContent?.trim()
    );

    expect(itemTexts.some((t) => t?.includes('Workspace') || t?.includes('工作区'))).toBe(true);
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
