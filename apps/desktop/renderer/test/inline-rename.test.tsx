// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineRename } from '../src/workspace/InlineRename.js';

/**
 * 树内联改名输入框的**键盘矩阵**。
 *
 * 为什么单独一个文件：侧栏那边测的是「哪一行变成输入框、路径有没有传对」，
 * 而这里测的是「Enter / Escape / 失焦 / 空名字各走哪条路」—— 四条分支两两之间
 * 只差一个键，写在侧栏用例里会被那一堆渲染细节淹掉。
 *
 * 三条判据都对着**回调**而不是 DOM：这个组件的全部产出就是「提交了没有、提交了什么」。
 * `onCancel` 与「没调用 onCommit」不是一回事 —— 空名字必须显式取消，
 * 否则输入框会留在树上（父组件的 `renamingPath` 没人清）。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('内联改名输入框', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onCommit: ReturnType<typeof vi.fn>;
  let onCancel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onCommit = vi.fn();
    onCancel = vi.fn();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  /** 包一层父节点：树里这个输入框的上面就是「打开文件」那一行的点击区。 */
  let outer: ReturnType<typeof vi.fn>;

  function render(initialName = 'dma.md'): HTMLInputElement {
    outer = vi.fn();
    act(() => {
      root.render(
        <div onMouseDown={outer} onClick={outer}>
          <InlineRename
            initialName={initialName}
            onCommit={onCommit}
            onCancel={onCancel}
          />
        </div>
      );
    });
    const input = container.querySelector<HTMLInputElement>('.nexus-tree-rename-input');
    if (!input) throw new Error('输入框没渲染出来');
    return input;
  }

  /** 改值再敲一个键。`change` 走 React 的受控路径，不派发它 `value` 不会更新。 */
  function type(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function press(input: HTMLInputElement, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    act(() => {
      input.dispatchEvent(event);
    });
    return event;
  }

  it('挂载即聚焦，并只选中基名（扩展名不该被改）', () => {
    const input = render('dma.md');

    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('dma.md');
    // `dma` 三个字符。选中整个 `dma.md` 会让人以为扩展名也能改，改完还会被主进程拒。
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(3);
  });

  it('Enter 提交新名字（只含基名，由调用方补目录）', () => {
    const input = render('dma.md');

    type(input, 'dma-2.md');
    const event = press(input, 'Enter');

    expect(onCommit).toHaveBeenCalledWith('dma-2.md');
    expect(onCancel).not.toHaveBeenCalled();
    // 不 `stopPropagation` 的话，这一次 Enter 会顺带触发宿主的全局快捷键。
    expect(event.defaultPrevented).toBe(true);
  });

  it('Escape 取消，一个字都不提交', () => {
    const input = render('dma.md');

    type(input, 'dma-2.md');
    const event = press(input, 'Escape');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('名字没改就回车 ＝ 取消，不发一次空改名的 IPC', () => {
    const input = render('dma.md');

    press(input, 'Enter');

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('空名字（或只有空白）也当取消 —— 否则输入框会留在树上', () => {
    const input = render('dma.md');

    type(input, '   ');
    press(input, 'Enter');

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('失焦按取消处理，不按提交', () => {
    const input = render('dma.md');

    type(input, 'dma-2.md');
    // React 的 `onBlur` 挂的是原生 **`focusout`**（React 17 起），派发 `blur` 打不到它。
    act(() => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    // 方向更安全：误点别处最多白改一次；误提交会真的去改盘、还要走一遍引用回写。
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('输入框自己的按下与点击不冒泡 —— 否则会先触发下面那一行的「打开文件」', () => {
    const input = render('dma.md');

    act(() => {
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    act(() => {
      input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(outer).not.toHaveBeenCalled();
  });
});
