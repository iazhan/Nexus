// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarkdownDocumentSession, loadVimExtension } from '@nexus/editor';
import { EditorSurface } from '../src/editor/SourceEditor.js';
import { settings } from '../src/platform.js';

/**
 * `EditorSurface` 的三条「设置项 → 编辑器视图」接线。
 *
 * 为什么这一层必须有：设置项的**行为**在 `packages/editor/test/` 里验（扩展装上之后干什么），
 * 真机用例只验「注册表里加了项、窗口里画出来了」。中间那段 —— `SourceEditor.tsx` 里
 * 哪个 effect 在什么时候把哪个扩展装到视图上 —— 两边都覆盖不到，
 * 而它恰恰是最容易漏的地方：`[session, surfaceId, surfaceKind]` 少写一个依赖，
 * 切一次 surface 之后设置就静默失效，任何一层都看不见。
 *
 * 本文件是 `EditorSurface` 的第一个 renderer 级用例，所以脚手架写在这里：
 * 直接 `createRoot` 挂真组件 + 真 `MarkdownDocumentSession`，不经过 `App`。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function mountSurface(session: MarkdownDocumentSession): void {
  act(() => {
    root.render(<EditorSurface session={session} surfaceId="settings-wiring" />);
  });
}

function contentDom(): HTMLElement {
  const element = container.querySelector<HTMLElement>('.cm-content');
  if (!element) throw new Error('编辑器没挂上：找不到 .cm-content');
  return element;
}

function pressKey(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  contentDom().dispatchEvent(event);
  return event;
}

beforeEach(() => {
  settings.set('editor.spellCheck', false);
  settings.set('editor.typewriterMode', false);
  settings.set('editor.vimKeybindings', false);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  settings.set('editor.spellCheck', false);
  settings.set('editor.typewriterMode', false);
  settings.set('editor.vimKeybindings', false);
});

describe('EditorSurface · 编辑器设置接线', () => {
  /**
   * 拼写检查。它没有 compartment 之外的东西可观察 —— 判据就是 `contentDOM` 上那条属性，
   * 而那正好是浏览器真正读的那一条。
   */
  it('拼写检查：开关拨动时 contentDOM 上的 spellcheck 跟着变', async () => {
    const session = new MarkdownDocumentSession('hello');
    mountSurface(session);

    expect(contentDom().getAttribute('spellcheck')).toBe('false');

    act(() => settings.set('editor.spellCheck', true));
    expect(contentDom().getAttribute('spellcheck')).toBe('true');

    act(() => settings.set('editor.spellCheck', false));
    expect(contentDom().getAttribute('spellcheck')).toBe('false');
  });

  /** 挂载时就该按存档里的值装配，而不是等用户拨一次开关 —— 否则重启后设置「看起来没生效」。 */
  it('拼写检查：挂载时就按存档里的值装配', async () => {
    settings.set('editor.spellCheck', true);

    const session = new MarkdownDocumentSession('hello');
    mountSurface(session);

    expect(contentDom().getAttribute('spellcheck')).toBe('true');
  });

  /**
   * Vim 键位。它走的是**异步** `import()`，所以这条同时钉住两件事：
   * 设置一打开扩展就装上（不用重启），以及加载完之后装的是**当前**那个视图
   * （`applyVim` 里那两层竞态判据）。
   *
   * 与打字机模式共用一个 effect —— 这条过了，说明那个 effect 真的跑了。
   */
  it('Vim 键位：打开后不用重启，键位立刻生效；关掉后立刻失效', async () => {
    const session = new MarkdownDocumentSession('hello');
    mountSurface(session);

    act(() => settings.set('editor.vimKeybindings', true));

    // 等的是**同一个** promise：effect 里那条 `await` 的续体排在测试这条前面，
    // 所以这里一落地，扩展就已经装到视图上了。等固定跳数是不行的 ——
    // 动态 import 什么时候 settle 不归我们管。
    await act(async () => {
      await loadVimExtension();
      for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    });

    pressKey({ key: 'x', code: 'KeyX' });
    expect(session.getSnapshot().source).toBe('ello');

    act(() => settings.set('editor.vimKeybindings', false));

    // 再敲一个普通字符键：没有 vim 时它落回浏览器，文档不该动。
    pressKey({ key: 'x', code: 'KeyX' });
    expect(session.getSnapshot().source).toBe('ello');
  });
});
