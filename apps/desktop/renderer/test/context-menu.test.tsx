// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, type ContextMenuItem } from '../src/components/ContextMenu.js';

/**
 * 上下文菜单原语（全仓第一个）。
 *
 * 这一层只管**组件自己的行为**：渲染哪些项、高亮怎么走、四种关闭来源、键盘。
 * 「谁在什么时候打开它」是 `App.tsx` 的事，归接线用例；真机上能不能弹出来归真机用例。
 *
 * happy-dom 里 `getBoundingClientRect()` 全是 0，于是「量完再定」退化成「就用 (x, y)」——
 * 这是刻意的：位置夹取的正确性不该依赖排版引擎，而这里只需要钉住
 * 「量完之后 `left/top` 确实被写上了，而不是永远停在 `visibility: hidden`」。
 *
 * 注意 `renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let onClose: ReturnType<typeof vi.fn>;
let onSelectDelete: ReturnType<typeof vi.fn>;
let onSelectRename: ReturnType<typeof vi.fn>;

function items(): ContextMenuItem[] {
  return [
    { id: 'rename', label: 'Rename', onSelect: onSelectRename },
    { id: 'delete', label: 'Delete', danger: true, onSelect: onSelectDelete }
  ];
}

function renderMenu(x = 100, y = 120): void {
  act(() => {
    root.render(<ContextMenu x={x} y={y} items={items()} onClose={onClose} label="File actions" />);
  });
}

function menu(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-context-menu]');
}

function menuItems(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-context-menu-item]'));
}

/** 当前高亮那一项。判据是属性在不在，不是类名 —— 高亮同时服务鼠标与键盘。 */
function activeItem(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-context-menu-active]');
}

function pressKey(key: string): void {
  const target = menu();
  if (!target) throw new Error('菜单没有渲染出来');
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('上下文菜单原语', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onClose = vi.fn();
    onSelectDelete = vi.fn();
    onSelectRename = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('按 items 渲染，语义是 menu / menuitem，且带可断言的锚点', () => {
    renderMenu();

    const root_ = menu();
    expect(root_).not.toBeNull();
    expect(root_?.getAttribute('role')).toBe('menu');
    expect(root_?.getAttribute('aria-label')).toBe('File actions');

    const rendered = menuItems();
    expect(rendered.map((item) => item.dataset.contextMenuItem)).toEqual(['rename', 'delete']);
    expect(rendered.map((item) => item.textContent)).toEqual(['Rename', 'Delete']);
    for (const item of rendered) {
      expect(item.getAttribute('role')).toBe('menuitem');
    }
  });

  it('量完尺寸后才画，且位置来自 (x, y)', () => {
    renderMenu(100, 120);

    const style = menu()?.getAttribute('style') ?? '';
    // 未量出前是 `visibility: hidden`；量完之后必须落到具体的 left/top 上，
    // 否则菜单会永远隐身（症状是「右键之后什么都不出现」）。
    expect(style).not.toContain('hidden');
    expect(style).toContain('left: 100px');
    expect(style).toContain('top: 120px');
  });

  it('初始高亮第一项 —— 键盘一打开就有落点', () => {
    renderMenu();
    expect(activeItem()?.dataset.contextMenuItem).toBe('rename');
  });

  it('上下键移动高亮，并在两端循环', () => {
    renderMenu();

    pressKey('ArrowDown');
    expect(activeItem()?.dataset.contextMenuItem).toBe('delete');

    // 到底了再往下 → 回到第一项（不是卡住）
    pressKey('ArrowDown');
    expect(activeItem()?.dataset.contextMenuItem).toBe('rename');

    // 第一项再往上 → 绕到最后一项
    pressKey('ArrowUp');
    expect(activeItem()?.dataset.contextMenuItem).toBe('delete');
  });

  it('Enter 触发当前高亮项并关闭', () => {
    renderMenu();

    pressKey('ArrowDown');
    pressKey('Enter');

    expect(onSelectDelete).toHaveBeenCalledOnce();
    expect(onSelectRename).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Escape 关闭，且 preventDefault 让外层看得见「这层处理过了」', () => {
    renderMenu();

    const target = menu();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      target?.dispatchEvent(event);
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('点菜单项触发回调并关闭', () => {
    renderMenu();

    act(() => {
      menuItems()[1]?.click();
    });

    expect(onSelectDelete).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('危险项带 danger 类，普通项不带', () => {
    renderMenu();

    const [rename, remove] = menuItems();
    expect(rename?.className).not.toContain('nexus-context-menu-item-danger');
    expect(remove?.className).toContain('nexus-context-menu-item-danger');
  });

  /**
   * 鼠标移入换高亮 —— 与键盘走的是同一个状态。
   *
   * 派发的是 `mouseover` 而不是 `mouseenter`：React 的 `onMouseEnter` 是**合成**的，
   * 由 `mouseover` + `relatedTarget` 推出来，直接派发 `mouseenter` 它收不到。
   * （组件那边写 `onMouseEnter` 是对的 —— 那是 React 的 API，不是原生事件名。）
   */
  it('鼠标移入换高亮 —— 与键盘走的是同一个状态', () => {
    renderMenu();

    act(() => {
      menuItems()[1]?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })
      );
    });

    expect(activeItem()?.dataset.contextMenuItem).toBe('delete');
  });

  /**
   * 四种关闭来源里最容易漏的是「滚动」：菜单是 `fixed` 的，不跟着内容走，
   * 留着就会浮在一个和它无关的位置上。点外部用的是**捕获阶段** ——
   * 树上的行是 `<button>`，冒泡阶段收的话点另一行会先打开那个文件、菜单才关。
   */
  it('点菜单外部关闭（捕获阶段的 pointerdown）', () => {
    renderMenu();

    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('点菜单内部不关闭 —— 否则菜单项自己的 click 永远到不了', () => {
    renderMenu();

    act(() => {
      menuItems()[0]?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('滚动、窗口失焦、resize 都关闭', () => {
    renderMenu();

    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(onClose).toHaveBeenCalledTimes(2);

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('在菜单上再按右键不叠出第二个原生菜单', () => {
    renderMenu();

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => {
      menu()?.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
  });
});
