// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from '../renderer/src/App.js';
import { setEditorReadOnly, type EditorView, type MarkdownDocumentSession } from '@nexus/editor';
import type { NexusBridge } from '../preload/types.js';

/** 桌面开发入口提供的真实编辑器观测接口。 */
const testWindow = window as Window & {
  nexusActiveView?: EditorView;
  nexusSession?: MarkdownDocumentSession;
};

describe('Desktop Shortcut Dispatch & Conflict Resolution (P1-04R / R3)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let writeFileSpy = vi.fn<NexusBridge['writeFile']>();
  let saveAsSpy = vi.fn<NexusBridge['saveAs']>();
  let restoreSelectionDispatch: () => void;

  beforeEach(() => {
    // happy-dom 20 synchronous selectionchange deferral
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

    writeFileSpy = vi.fn<NexusBridge['writeFile']>().mockResolvedValue();
    saveAsSpy = vi.fn<NexusBridge['saveAs']>().mockResolvedValue('D:/saved-file.md');

    testWindow.nexus = {
      getLaunchContext: vi.fn().mockResolvedValue({
        mode: 'lightweight',
        filePath: 'D:/test-doc.md'
      }),
      openFile: vi.fn().mockResolvedValue({
        path: 'D:/test-doc.md',
        content: 'Hello world'
      }),
      writeFile: writeFileSpy,
      saveAs: saveAsSpy,
      readFile: vi.fn().mockResolvedValue('Hello world'),
      setDirty: vi.fn(),
      watchFile: vi.fn(() => () => {}),
      onSaveAndCloseRequested: vi.fn().mockReturnValue(() => {}),
      readyToClose: vi.fn(),
      closeWindow: vi.fn()
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

  it('verifies Mod-Shift-x toggles strikethrough with 0 save/saveAs calls, and Mod-s/Mod-Shift-s do not format', async () => {
    root.render(React.createElement(App));
    await waitForAppReady();

    const session = testWindow.nexusSession!;

    expect(session.getSnapshot().source).toBe('Hello world');

    // 1. Switch to Visual mode
    const visualBtn = container.querySelector('.nexus-surface-switcher button:last-child') as HTMLButtonElement;
    visualBtn.click();
    await new Promise((r) => setTimeout(r, 100));

    const visualView = testWindow.nexusActiveView!;
    visualView.focus();
    visualView.dispatch({ selection: { anchor: 6, head: 11 } }); // 'world'

    // 2. Dispatch Mod-Shift-x on the view
    const modShiftX = new KeyboardEvent('keydown', {
      key: 'x',
      code: 'KeyX',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    visualView.contentDOM.dispatchEvent(modShiftX);

    // Assert strikethrough applied
    expect(session.getSnapshot().source).toBe('Hello ~~world~~');
    // Assert writeFile / saveAs call counts are strictly 0!
    expect(writeFileSpy).toHaveBeenCalledTimes(0);
    expect(saveAsSpy).toHaveBeenCalledTimes(0);

    // 3. Dispatch Mod-Shift-x again to toggle off
    visualView.dispatch({ selection: { anchor: 6, head: 15 } }); // '~~world~~'
    const modShiftX2 = new KeyboardEvent('keydown', {
      key: 'x',
      code: 'KeyX',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    visualView.contentDOM.dispatchEvent(modShiftX2);

    expect(session.getSnapshot().source).toBe('Hello world');
    expect(writeFileSpy).toHaveBeenCalledTimes(0);
    expect(saveAsSpy).toHaveBeenCalledTimes(0);

    // 从编辑器派发保存事件，覆盖 CodeMirror 到 App 的真实冒泡路径。
    const modS = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    });
    visualView.contentDOM.dispatchEvent(modS);
    await new Promise((r) => setTimeout(r, 50));

    // Verify writeFile was called (filePath is present) and text is NOT formatted
    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    expect(saveAsSpy).toHaveBeenCalledTimes(0);
    expect(session.getSnapshot().source).toBe('Hello world');

    // 另存为经过同一事件链路，不能被编辑器格式化命令消费。
    const modShiftS = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    visualView.contentDOM.dispatchEvent(modShiftS);
    await new Promise((r) => setTimeout(r, 50));

    // Assert saveAs was called
    expect(saveAsSpy).toHaveBeenCalledTimes(1);
    // Text remains unformatted
    expect(session.getSnapshot().source).toBe('Hello world');
  });

  it.each([
    { label: 'empty selection', readOnly: false, anchor: 0, head: 0 },
    { label: 'readOnly nonempty selection', readOnly: true, anchor: 6, head: 11 }
  ])('does not format or save with $label', async ({ readOnly, anchor, head }) => {
    root.render(React.createElement(App));
    await waitForAppReady();

    const session = testWindow.nexusSession!;
    const visualBtn = container.querySelector('.nexus-surface-switcher button:last-child') as HTMLButtonElement;
    visualBtn.click();
    await new Promise((r) => setTimeout(r, 100));

    const visualView = testWindow.nexusActiveView!;
    visualView.focus();
    visualView.dispatch({ selection: { anchor, head } });
    setEditorReadOnly(visualView, readOnly);
    expect(visualView.state.readOnly).toBe(readOnly);
    const before = session.getSnapshot();

    // Dispatch Mod-Shift-x with empty selection -> no change
    const modShiftX = new KeyboardEvent('keydown', {
      key: 'x',
      code: 'KeyX',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    visualView.contentDOM.dispatchEvent(modShiftX);

    expect(session.getSnapshot().source).toBe('Hello world');
    expect(session.getSnapshot()).toEqual(before);
    expect(writeFileSpy).toHaveBeenCalledTimes(0);
    expect(saveAsSpy).toHaveBeenCalledTimes(0);
  });
});
