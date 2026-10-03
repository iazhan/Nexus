// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '@nexus/command';
import { CommandPalette } from '../src/CommandPalette.js';
import { commandRegistry, localeManager } from '../src/platform.js';

/**
 * 命令面板的**可用性**这一层。
 *
 * 为什么要有它：面板是「搜得到就能按」的地方，而有些命令只在特定状态下才有意义
 * （「在工作区中打开」要先开着文档）。从前这类命令在面板里只能装作一直可用 ——
 * 按下去毫无反应，用户只会以为自己按错了。现在可用性由命令自己的 `isEnabled` 声明，
 * 这一层负责把它变成三件可观察的事：**灰显、键盘跳过、点了不执行**。
 *
 * 三条缺一不可：
 * - 只灰显不跳键盘 ⇒「点了没反应」从鼠标挪到了键盘上；
 * - 只跳键盘不灰显 ⇒ 用户不知道为什么选不中；
 * - 灰显了却还能点 ⇒ 灰显是假的。
 *
 * 注册表是模块单例（`platform.js`），所以每条用例自己注册、自己注销，
 * 不依赖别的用例留下的状态。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('命令面板：不可用的命令', () => {
  let container: HTMLDivElement;
  let root: Root;
  let registered: Array<() => void>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    registered = [];
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    for (const unregister of registered) unregister();
    registered = [];
    // 单例：本文件若改过 locale 必须还原，否则同进程里后面的用例会跟着变。
    act(() => {
      localeManager.setLocale('en-US');
    });
  });

  /** 注册一条命令，`isEnabled` 缺省不声明（＝总是可用）。文案键取不到时 `t` 原样返回键名。 */
  function register(id: string, options: { enabled?: boolean; run?: () => void } = {}): void {
    const command: Command = {
      id,
      titleKey: `test.${id}`,
      execute: vi.fn(options.run),
      ...(options.enabled === undefined ? {} : { isEnabled: () => options.enabled! })
    };
    registered.push(commandRegistry.registerCommand(command));
  }

  async function render(): Promise<void> {
    await act(async () => {
      root.render(<CommandPalette isOpen onClose={() => {}} />);
    });
  }

  const row = (id: string) => container.querySelector<HTMLElement>(`[data-command-id="${id}"]`);
  const selectedIds = () =>
    Array.from(container.querySelectorAll<HTMLElement>('.nexus-command-palette-item.selected')).map(
      (element) => element.dataset.commandId
    );

  /** 往搜索框里按一个键。面板的键盘处理挂在输入框上（Escape 归 `Dialog`）。 */
  const press = async (key: string) => {
    await act(async () => {
      container
        .querySelector('.nexus-command-palette-input')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  };

  it('缺省声明即「总是可用」—— 没写 `isEnabled` 的命令不该被灰掉', async () => {
    register('always');
    await render();

    expect(row('always')?.getAttribute('data-disabled')).toBeNull();
    expect(row('always')?.getAttribute('aria-disabled')).toBeNull();
  });

  it('`isEnabled` 为假时灰显：`data-disabled` 与 `aria-disabled` **同源**', async () => {
    register('never', { enabled: false });
    await render();

    // 视觉与语义必须从同一个表达式派生 —— 只改一边就会出现「看着能点、读屏说不能点」。
    expect(row('never')?.getAttribute('data-disabled')).toBe('true');
    expect(row('never')?.getAttribute('aria-disabled')).toBe('true');
    expect(row('never')?.classList.contains('nexus-command-palette-item-disabled')).toBe(true);
    // 留在列表里 —— 藏掉会让人以为命令不存在
    expect(row('never')).not.toBeNull();
  });

  it('**点它不执行**', async () => {
    const run = vi.fn();
    register('never', { enabled: false, run });
    await render();

    await act(async () => {
      row('never')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(run).not.toHaveBeenCalled();
  });

  it('方向键**跳过**灰项，选中态落在下一个可用项上', async () => {
    register('a');
    register('b', { enabled: false });
    register('c');
    await render();

    // 起始选中第一项
    expect(selectedIds()).toEqual(['a']);

    await press('ArrowDown');

    // `b` 被跳过：选中态是「按回车会发生什么」的承诺，一个按下去没反应的项不配拥有它
    expect(selectedIds()).toEqual(['c']);
  });

  it('回车执行的是选中的可用项', async () => {
    const runA = vi.fn();
    const runB = vi.fn();
    register('a', { run: runA });
    register('b', { enabled: false, run: runB });
    await render();

    await press('ArrowDown');
    await press('Enter');

    // 只有一个可用项，绕一圈还是它；灰的那个始终没被执行
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).not.toHaveBeenCalled();
  });

  it('**一个可用的都没有**时回车不执行任何东西，也不抛', async () => {
    const run = vi.fn();
    register('a', { enabled: false, run });
    await render();

    await press('ArrowDown');
    await press('Enter');

    expect(run).not.toHaveBeenCalled();
    // 没有选中态可言 —— 选中一个灰项等于承诺一件不会发生的事
    expect(selectedIds()).toEqual([]);
  });
});
