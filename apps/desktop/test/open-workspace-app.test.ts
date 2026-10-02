// @vitest-environment happy-dom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from '../renderer/src/App.js';

/**
 * 欢迎态里「打开文件夹」那条链的**渲染进程那一半**。
 *
 * 这一半只能在 happy-dom 里渲染整个 `App` 来测：那个按钮弹的是**原生**目录选择框，
 * 真机用例（CDP）一点就卡在对话框上，拿不到后面的状态。主进程那一半（授权 + 记回落目标）
 * 在 `workspace-mode.test.ts` 里从桥上调 `openWorkspace` 验。
 *
 * ## 为什么两半必须分开，不能只留一半
 *
 * 直接从桥上调 `openWorkspace` **不会**让界面切到工作区 —— 切状态发生在
 * `App.handleOpenWorkspace` 里（按钮与「在工作区中打开」菜单项共用的那一层）。
 * 于是：只测桥会漏掉「点了没反应」，只测渲染会漏掉「没真的授权」。
 *
 * 这一条盯的就是那个中间层：**点一下 → 调桥（不带路径）→ 拿到目录 → 外壳挂起来**。
 */
describe('欢迎态：点「打开文件夹」', () => {
  let container: HTMLDivElement;
  let root: Root;

  const nexusStub = {
    // 裸启动的形状：工作区模式、还没有目录 ⇒ 欢迎态。
    getLaunchContext: vi.fn().mockResolvedValue({
      mode: 'workspace',
      filePath: null,
      documentType: null,
      workspaceRoot: null,
      unsupportedPath: null
    }),
    openWorkspace: vi.fn().mockResolvedValue('D:/picked'),
    readFile: vi.fn().mockResolvedValue(''),
    writeFile: vi.fn().mockResolvedValue(undefined),
    setDirty: vi.fn(),
    watchFile: vi.fn(() => () => {}),
    onSaveAndCloseRequested: vi.fn().mockReturnValue(() => {}),
    readyToClose: vi.fn(),
    closeWindow: vi.fn(),
    minimizeWindow: vi.fn(),
    maximizeWindow: vi.fn(),
    getWindowState: vi.fn().mockResolvedValue({ maximized: false }),
    onWindowStateChanged: vi.fn().mockReturnValue(() => {}),
    // 侧栏挂载时会走一次索引；这几条只是让它别停在错误态，本用例不验它。
    rebuildIndex: vi.fn().mockResolvedValue({ errors: [] }),
    listIndexedDocuments: vi.fn().mockResolvedValue([]),
    listWorkspaceDirectories: vi.fn().mockResolvedValue([])
  };

  beforeEach(() => {
    (window as unknown as { nexus: typeof nexusStub }).nexus = nexusStub;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    for (const spy of Object.values(nexusStub)) spy.mockClear();
    nexusStub.openWorkspace.mockResolvedValue('D:/picked');
    nexusStub.getLaunchContext.mockResolvedValue({
      mode: 'workspace',
      filePath: null,
      documentType: null,
      workspaceRoot: null,
      unsupportedPath: null
    });
  });

  async function waitForSelector(selector: string, timeoutMs = 5000): Promise<Element> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = container.querySelector(selector);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`等待 ${selector} 超时`);
  }

  it('点一下：调桥（不带路径，让主进程弹框）、拿到目录后外壳挂起来', async () => {
    root.render(React.createElement(App));

    const button = (await waitForSelector('[data-workspace-open-folder]')) as HTMLButtonElement;
    // 前置条件：欢迎态那一屏在，且还没有外壳。
    expect(container.querySelector('.nexus-activity-bar')).toBeNull();

    button.click();

    await waitForSelector('.nexus-activity-bar');

    expect(nexusStub.openWorkspace).toHaveBeenCalledTimes(1);
    // **不带路径** —— 目录由主进程的目录选择框给，渲染进程不猜一个。
    expect(nexusStub.openWorkspace.mock.calls[0]?.[0]).toBeUndefined();
    // 拿到目录之后欢迎态退场。
    expect(container.querySelector('[data-workspace-open-folder]')).toBeNull();
  });

  it('用户取消（桥返回 null）时留在欢迎态，不挂外壳', async () => {
    nexusStub.openWorkspace.mockResolvedValue(null);

    root.render(React.createElement(App));

    const button = (await waitForSelector('[data-workspace-open-folder]')) as HTMLButtonElement;
    button.click();

    // 状态更新留一拍。取消是正常结局，什么都不该发生。
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(container.querySelector('[data-workspace-open-folder]')).not.toBeNull();
    expect(container.querySelector('.nexus-activity-bar')).toBeNull();
  });
});
