// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceEmpty } from '../src/workspace/WorkspaceEmpty.js';
import { localeManager } from '../src/platform.js';

/**
 * 内容区空态的三种形态（`WorkspaceEmpty`）。
 *
 * 为什么这一层要有用例：三种形态是**组件里的分支**，而真机用例一个文件只能启动一次
 * Electron、只跑一种启动形状（要么带目录、要么带文件），覆盖不到「工作区模式但还没定目录」
 * 这一格 —— 而那一格正是裸启动，也就是「双击图标不该退化成空编辑器」这条的落点。
 *
 * 每个「画了什么」的断言都配一条「**没**画什么」：只有前者的话，把两个分支写成
 * 都渲染（或干脆都不渲染）照样能过。`data-workspace-open-folder` 是组件自己的锚点 ——
 * 不按 `.nexus-workspace-empty` 找，`ViewerPlaceholder` 复用同一套类名。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('工作区空态', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onOpenFolder: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localeManager.setLocale('en-US');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onOpenFolder = vi.fn();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    localeManager.setLocale('en-US');
  });

  function render(mode: 'lightweight' | 'viewer' | 'workspace' | null, rootPath: string | null) {
    act(() => {
      root.render(<WorkspaceEmpty mode={mode} rootPath={rootPath} onOpenFolder={onOpenFolder} />);
    });
  }

  const openFolderButton = () => container.querySelector('[data-workspace-open-folder]');

  it('工作区模式 + 还没定目录 → 欢迎态，给一个「打开文件夹」', () => {
    render('workspace', null);

    expect(openFolderButton()).not.toBeNull();
    expect(container.textContent).toContain('Open Folder');
    // 反面：这一格**不该**出现「从左侧挑一个文件」—— 那时左侧什么都没有。
    expect(container.textContent).not.toContain('Pick a file');
  });

  it('点「打开文件夹」上报一次', () => {
    render('workspace', null);

    act(() => {
      (openFolderButton() as HTMLElement).click();
    });

    expect(onOpenFolder).toHaveBeenCalledTimes(1);
  });

  it('工作区模式 + 有目录 → 画路径与「挑一个文件」，**不**画欢迎态', () => {
    render('workspace', 'D:\\notes\\vault');

    expect(container.querySelector('.nexus-workspace-empty-path')?.textContent).toBe(
      'D:\\notes\\vault'
    );
    expect(container.textContent).toContain('Pick a file');
    // 反面：已经进了工作区还留着「打开文件夹」会让人以为没打开成功。
    expect(openFolderButton()).toBeNull();
  });

  it('轻量模式（没有目录）→ 兜底文案，**不**画欢迎态', () => {
    render('lightweight', null);

    expect(openFolderButton()).toBeNull();
    expect(container.textContent).toContain('No document is open');
    expect(container.textContent).not.toContain('Pick a file');
  });

  /**
   * 启动上下文还没回来时 `mode` 是 `null`。这一格**必须**走兜底：首帧就画一个
   * 「打开文件夹」的话，等上下文回来发现是轻量模式，按钮会闪一下又消失。
   */
  it('mode 还没回来（null）→ 兜底，不画欢迎态', () => {
    render(null, null);

    expect(openFolderButton()).toBeNull();
    expect(container.textContent).toContain('No document is open');
  });

  it('viewer 模式（有文件路径）→ 不画欢迎态', () => {
    render('viewer', null);

    expect(openFolderButton()).toBeNull();
  });
});
