// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, type ContextMenuItem } from '../src/components/ContextMenu.js';

/**
 * 上下文菜单原语（全仓第一个）。
 *
 * 这一层只管**组件自己的行为**：渲染哪些项、高亮怎么走、四种关闭来源、键盘、焦点进出。
 * 「谁在什么时候打开它」是 `App.tsx` 的事，归接线用例；真机上能不能弹出来归真机用例。
 *
 * 末尾那五条覆盖菜单项形状的两处扩展（2026-10-04）：**勾选项**（`active` → ✓ +
 * `menuitemradio` + `aria-checked`，左侧留固定宽度的勾选槽）与**分隔线**（`role="separator"`，
 * 不参与键盘导航）。工具栏的标题下拉要的正是这两样 —— 同一份块类型列表在菜单栏里
 * 有分组线和 ✓，在下拉里没有的话，两处就是两个样子。
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

/** 渲染一份自定义项。勾选项 / 分隔线那几条用例要自己控制菜单里有什么。 */
function renderItems(list: ContextMenuItem[]): void {
  act(() => {
    root.render(<ContextMenu x={10} y={10} items={list} onClose={onClose} label="Block type" />);
  });
}

/** 正文 + 分隔线 + 标题 1 —— 工具栏标题下拉的最小复现。 */
function checkableItems(): ContextMenuItem[] {
  return [
    { id: 'paragraph', label: 'Paragraph', active: true, onSelect: onSelectRename },
    { id: '', label: '', separator: true },
    { id: 'h1', label: 'Heading 1', active: false, onSelect: onSelectDelete }
  ];
}

/**
 * 受控开关的宿主：菜单自己只调 `onClose`，**真正卸不卸由调用方决定**（同真实用法）。
 * 「关闭时归还焦点」发生在卸载那一刻，所以必须有个东西真的把它卸掉。
 */
function Harness({
  menuItems,
  onClose: close
}: {
  menuItems: ContextMenuItem[];
  onClose?: () => void;
}): React.ReactElement | null {
  const [open, setOpen] = React.useState(true);
  if (!open) return null;
  return (
    <ContextMenu
      x={10}
      y={10}
      items={menuItems}
      onClose={() => {
        setOpen(false);
        close?.();
      }}
      label="File actions"
    />
  );
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

  /**
   * 焦点归还。菜单要拿焦点键盘才走得动，所以打开时把焦点收进来；关掉时得**还回去** ——
   * 工具栏的「更多」是从编辑器里点出来的，不还的话编辑器就永久失焦，下一次按键没有落点
   * （症状是「点了没反应」）。`Dialog` 是同一种写法。
   */
  it('关闭时把焦点还给打开之前那个元素', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    await act(async () => {
      root.render(<Harness menuItems={items()} />);
    });
    // 打开时焦点进菜单 —— 否则方向键 / Enter / Escape 都没有落点
    expect(document.activeElement).toBe(menu());

    await act(async () => {
      menu()?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });

    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(opener);

    opener.remove();
  });

  /**
   * 反面：**只在焦点还留在菜单里的时候**才归还。菜单项的动作自己把焦点挪走是存在的
   * ——「替换」会打开 CM 的搜索面板并聚焦它的输入框 —— 抢回来等于把用户刚打开的输入框
   * 又踢走，而且这个 bug 只在「从工具栏的更多里点替换」这一条路上出现。
   */
  it('反面：动作自己把焦点挪走了就不抢回来', async () => {
    const opener = document.createElement('button');
    const elsewhere = document.createElement('input');
    document.body.appendChild(opener);
    document.body.appendChild(elsewhere);
    opener.focus();

    const movingItems: ContextMenuItem[] = [
      { id: 'replace', label: 'Replace', onSelect: () => elsewhere.focus() }
    ];

    await act(async () => {
      root.render(<Harness menuItems={movingItems} />);
    });
    expect(document.activeElement).toBe(menu());

    await act(async () => {
      menuItems()[0]?.click();
    });

    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);

    opener.remove();
    elsewhere.remove();
  });

  // ---- 勾选项与分隔线（2026-10-04，工具栏的标题下拉要用） ----

  it('勾选项：✓ 与 aria-checked 同源，role 是 menuitemradio', () => {
    renderItems([
      { id: 'paragraph', label: 'Paragraph', active: true, onSelect: onSelectRename },
      { id: 'h1', label: 'Heading 1', active: false, onSelect: onSelectDelete }
    ]);

    const [paragraph, h1] = menuItems();
    for (const item of [paragraph!, h1!]) {
      expect(item.getAttribute('role')).toBe('menuitemradio');
    }
    expect(paragraph!.getAttribute('aria-checked')).toBe('true');
    expect(h1!.getAttribute('aria-checked')).toBe('false');

    // ✓ 与 `aria-checked` 出自同一个 `active`（判据 36）—— 两处各判一次就会漂
    expect(paragraph!.textContent).toContain('✓');
    expect(h1!.textContent).not.toContain('✓');

    // 勾选槽**恒占位**：未选中的那项也有一个空 span，否则整组文字左沿参差不齐
    expect(h1!.querySelector('.nexus-context-menu-check')).not.toBeNull();
    expect(h1!.querySelector('.nexus-context-menu-check')!.textContent).toBe('');
  });

  it('反面：没有 active 的项不占勾选槽，role 仍是 menuitem', () => {
    renderItems([{ id: 'replace', label: 'Replace', onSelect: onSelectRename }]);

    const item = menuItems()[0]!;
    expect(item.getAttribute('role')).toBe('menuitem');
    expect(item.getAttribute('aria-checked')).toBeNull();
    expect(item.querySelector('.nexus-context-menu-check')).toBeNull();
    expect(item.textContent).toBe('Replace');
  });

  it('分隔线：role=separator，不是菜单项', () => {
    renderItems(checkableItems());

    expect(menuItems().map((el) => el.dataset.contextMenuItem)).toEqual(['paragraph', 'h1']);
    const separators = container.querySelectorAll('.nexus-context-menu-separator');
    expect(separators).toHaveLength(1);
    expect(separators[0]!.getAttribute('role')).toBe('separator');
  });

  it('分隔线：上下键跳过它 —— 否则按一下看起来像「没动」', () => {
    renderItems(checkableItems());

    expect(activeItem()?.dataset.contextMenuItem).toBe('paragraph');
    pressKey('ArrowDown');
    expect(activeItem()?.dataset.contextMenuItem).toBe('h1');
    pressKey('ArrowUp');
    expect(activeItem()?.dataset.contextMenuItem).toBe('paragraph');
  });

  it('分隔线：回车只触发当前高亮项，不会落到线上', () => {
    renderItems(checkableItems());

    pressKey('Enter');
    expect(onSelectRename).toHaveBeenCalledOnce();
    expect(onSelectDelete).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
