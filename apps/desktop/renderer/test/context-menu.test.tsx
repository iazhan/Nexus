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
 * 菜单项的形状分两批长出来，各有来源：
 *
 * - **勾选项与分隔线**（2026-10-04，工具栏的标题下拉要用）—— `active` → ✓ +
 *   `menuitemradio` + `aria-checked`，左侧留一条固定宽度的勾选槽；`role="separator"`
 *   不参与键盘导航。同一份块类型列表在菜单栏里有分组线和 ✓，在下拉里没有的话，
 *   两处就是两个样子。
 * - **开关项、禁用项与空清单**（2026-10-16，树空白区菜单要用）—— `checked` →
 *   `menuitemcheckbox`（开关没有「组」，所以与 radio 分开，但共用同一条勾选槽）；
 *   `disabled` → 灰、点不动、键盘跳过它；`items` 为空时整份菜单不渲染。
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

  // ---- 开关项与禁用项（2026-10-16，树空白区菜单要用） ----

  /**
   * 开关与勾选项是**两件事**：radio 的前提是「有一组」，而「显示图片」这种开关没有组。
   * 两者共用同一条勾选槽，但 role 不同 —— 读屏器念出来的是「已勾选」还是「单选组里的
   * 第几个」，差别就在这里。
   */
  it('开关项：role 是 menuitemcheckbox，✓ 与 aria-checked 同源', () => {
    renderItems([
      { id: 'images', label: 'Show images', checked: true, onSelect: onSelectRename },
      { id: 'refresh', label: 'Rescan', checked: false, onSelect: onSelectDelete }
    ]);

    const [on, off] = menuItems();
    for (const item of [on!, off!]) {
      expect(item.getAttribute('role')).toBe('menuitemcheckbox');
    }
    expect(on!.getAttribute('aria-checked')).toBe('true');
    expect(off!.getAttribute('aria-checked')).toBe('false');
    expect(on!.textContent).toContain('✓');
    expect(off!.textContent).not.toContain('✓');
    // 与 `active` 共用同一条勾选槽
    expect(off!.querySelector('.nexus-context-menu-check')).not.toBeNull();
  });

  it('active 与 checked 同时给时按 active 算 —— 一个 aria-checked 只能有一个来源', () => {
    renderItems([{ id: 'x', label: 'X', active: false, checked: true, onSelect: onSelectRename }]);

    const item = menuItems()[0]!;
    expect(item.getAttribute('role')).toBe('menuitemradio');
    expect(item.getAttribute('aria-checked')).toBe('false');
    expect(item.textContent).not.toContain('✓');
  });

  it('禁用项：点不动、也不关菜单；回车落在**别的**项上', () => {
    renderItems([
      { id: 'refresh', label: 'Rescan', disabled: true, onSelect: onSelectRename },
      { id: 'new', label: 'New', onSelect: onSelectDelete }
    ]);

    const disabled = menuItems()[0]!;
    expect(disabled.hasAttribute('disabled')).toBe(true);

    act(() => {
      disabled.click();
    });
    expect(onSelectRename).not.toHaveBeenCalled();
    // 关掉菜单等于假装执行过了 —— 用户会以为动作生效了
    expect(onClose).not.toHaveBeenCalled();

    pressKey('Enter');
    expect(onSelectRename).not.toHaveBeenCalled();
    expect(onSelectDelete).toHaveBeenCalledOnce();
  });

  it('第一项就禁用时初始落点跳过它 —— 不然会画一格「高亮着但点不动」', () => {
    renderItems([
      { id: 'refresh', label: 'Rescan', disabled: true, onSelect: onSelectRename },
      { id: 'new', label: 'New', onSelect: onSelectDelete }
    ]);

    expect(activeItem()?.dataset.contextMenuItem).toBe('new');
  });

  it('整份菜单全禁用时没有落点，也不画高亮', () => {
    renderItems([{ id: 'refresh', label: 'Rescan', disabled: true, onSelect: onSelectRename }]);

    expect(activeItem()).toBeNull();

    pressKey('Enter');
    expect(onSelectRename).not.toHaveBeenCalled();
  });

  /**
   * 空清单不画任何东西。调用方（目录 `path` 为 `null` 时一个动作都给不了）不必为此
   * 再写一遍判据 —— 一个空框比不弹更难解释。
   */
  it('空清单不渲染任何东西', () => {
    renderItems([]);

    expect(menu()).toBeNull();
    expect(menuItems()).toEqual([]);
  });

  // ---- 两级子菜单（2026-10-16，编辑器右键菜单的「格式」要用） ----

  /**
   * 一级项 + 一个二级面板。二级里放三项，其中一项是勾选项 ——
   * 「两级共用同一份渲染」要能被这条钉住。
   */
  function submenuItems(): ContextMenuItem[] {
    return [
      { id: 'link', label: 'Insert link', onSelect: onSelectRename },
      {
        id: 'format',
        label: 'Format',
        submenu: [
          { id: 'bold', label: 'Bold', active: true, onSelect: onSelectDelete },
          { id: '', label: '', separator: true },
          { id: 'italic', label: 'Italic', onSelect: onSelectRename }
        ]
      }
    ];
  }

  function submenu(): HTMLElement | null {
    return container.querySelector<HTMLElement>('[data-context-submenu]');
  }

  /** 二级面板里的项。一级的 `data-context-menu-active` 会与二级同时存在（父项保持高亮），
      所以这个查询必须**限定在面板内**。 */
  function subItems(): HTMLElement[] {
    return Array.from(
      submenu()?.querySelectorAll<HTMLElement>('[data-context-menu-item]') ?? []
    );
  }

  function activeSubItem(): HTMLElement | null {
    return submenu()?.querySelector<HTMLElement>('[data-context-menu-active]') ?? null;
  }

  /**
   * 展开子菜单：点那个带子菜单的父项（点它只展开，不执行动作）。
   *
   * **按 `aria-haspopup` 找而不是写下标**：二级展开后 `menuItems()` 会把子项也算进来，
   * 下标就不再稳定；而且各条用例的一级项数不一样。
   */
  function openSubmenuByClick(): void {
    const parent = menuItems().find((item) => item.getAttribute('aria-haspopup') === 'menu');
    if (!parent) throw new Error('这份菜单里没有带子菜单的项');
    act(() => parent.click());
  }

  it('带 submenu 的项：aria-haspopup=menu，点它只展开、不执行 onSelect', () => {
    renderItems(submenuItems());

    const parent = menuItems()[1]!;
    expect(parent.getAttribute('aria-haspopup')).toBe('menu');
    expect(parent.getAttribute('aria-expanded')).toBe('false');
    // 它是「展开子菜单的入口」，不是 radio / checkbox —— role 不能被二级的存在带跑
    expect(parent.getAttribute('role')).toBe('menuitem');
    expect(submenu()).toBeNull();

    openSubmenuByClick();

    // 点它**不执行任何动作**：「既展开又执行」会让用户没法只看看里面有什么
    expect(onSelectRename).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(parent.getAttribute('aria-expanded')).toBe('true');
    expect(subItems().map((item) => item.dataset.contextMenuItem)).toEqual([
      'bold',
      'italic'
    ]);
  });

  it('子菜单：再点一次父项收起', () => {
    renderItems(submenuItems());
    openSubmenuByClick();
    expect(submenu()).not.toBeNull();

    openSubmenuByClick();

    expect(submenu()).toBeNull();
    expect(menuItems()[1]!.getAttribute('aria-expanded')).toBe('false');
  });

  /**
   * 两级共用同一份渲染 —— 勾选槽、禁用、分隔线在二级里必须与一级逐字一致，
   * 各写一遍的结果是「一级有 ✓、二级没有」这种只在一处生效的漂移。
   */
  it('子菜单里的项走同一份渲染：勾选槽与分隔线都在', () => {
    renderItems(submenuItems());
    openSubmenuByClick();

    const [bold, italic] = subItems();
    expect(bold!.getAttribute('role')).toBe('menuitemradio');
    expect(bold!.getAttribute('aria-checked')).toBe('true');
    expect(bold!.textContent).toContain('✓');
    expect(italic!.getAttribute('role')).toBe('menuitem');
    expect(submenu()!.querySelectorAll('.nexus-context-menu-separator')).toHaveLength(1);
  });

  it('方向键进出子菜单：ArrowRight 展开、ArrowLeft 收起', () => {
    renderItems(submenuItems());

    pressKey('ArrowDown'); // 落到 Format
    expect(activeItem()?.dataset.contextMenuItem).toBe('format');

    pressKey('ArrowRight');
    expect(submenu()).not.toBeNull();
    // 键盘进去之后方向键**在二级里走**
    expect(activeSubItem()?.dataset.contextMenuItem).toBe('bold');

    pressKey('ArrowDown');
    expect(activeSubItem()?.dataset.contextMenuItem).toBe('italic');

    pressKey('ArrowLeft');
    expect(submenu()).toBeNull();
    // 收子菜单**不等于关菜单** —— 用户要还能在一级里挑别的
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ArrowRight 落在没有子菜单的项上什么都不发生', () => {
    renderItems(submenuItems());

    pressKey('ArrowRight'); // 高亮还在 Insert link 上

    expect(submenu()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  /**
   * Escape **先收子菜单再关菜单**。一次把两层都关掉的话，用户按错了就再也回不到一级
   * —— 得重新右键一趟。
   */
  it('Escape 先收子菜单，再按一次才关菜单', () => {
    renderItems(submenuItems());
    openSubmenuByClick();

    pressKey('Escape');
    expect(submenu()).toBeNull();
    expect(menu()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    pressKey('Escape');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('回车落在父项上只展开；落到二级项上才执行并关菜单', () => {
    renderItems(submenuItems());

    pressKey('ArrowDown'); // Format
    pressKey('Enter'); // 只展开
    expect(submenu()).not.toBeNull();
    expect(onSelectRename).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    pressKey('Enter'); // 二级的第一项：Bold
    expect(onSelectDelete).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('点子菜单项执行并关菜单', () => {
    renderItems(submenuItems());
    openSubmenuByClick();

    act(() => {
      subItems()[0]?.click();
    });

    expect(onSelectDelete).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  /**
   * 子菜单里的一项被禁用时，方向键跳过它 —— 与一级同一条判据（共用 `step`）。
   */
  it('子菜单里方向键跳过禁用项', () => {
    renderItems([
      {
        id: 'format',
        label: 'Format',
        submenu: [
          { id: 'bold', label: 'Bold', disabled: true, onSelect: onSelectRename },
          { id: 'italic', label: 'Italic', onSelect: onSelectDelete }
        ]
      }
    ]);

    openSubmenuByClick();

    // 初始落点就要跳过禁用的第一项
    expect(activeSubItem()?.dataset.contextMenuItem).toBe('italic');

    pressKey('ArrowUp');
    expect(activeSubItem()?.dataset.contextMenuItem).toBe('italic');

    pressKey('Enter');
    expect(onSelectRename).not.toHaveBeenCalled();
    expect(onSelectDelete).toHaveBeenCalledOnce();
  });

  /**
   * **菜单内部的滚动不算关闭。** 这个监听是捕获阶段挂在 `window` 上的，菜单自己滚一下
   * 同样会经过它 —— 不加判据的话，「滚一滚看子菜单下面还有什么」会变成「菜单没了」。
   * 这一条是给菜单加 `max-height` + 内部滚动时**必须**一起做的，否则新加的能力立刻是坏的。
   */
  it('菜单内部滚动不关闭；菜单外面滚动照关', () => {
    renderItems(submenuItems());
    openSubmenuByClick();

    act(() => {
      menu()?.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      submenu()?.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  /** 二级面板自己也是 `role="menu"`，且**不共用**根菜单的 `data-context-menu` 锚点 ——
      两级共用一个属性会让「子菜单开着」被当成「菜单开着」。 */
  it('子菜单面板是独立的 role=menu，且不与根菜单共用锚点', () => {
    renderItems(submenuItems());
    openSubmenuByClick();

    expect(submenu()!.getAttribute('role')).toBe('menu');
    expect(submenu()!.getAttribute('aria-label')).toBe('Format');
    // 根菜单仍然只有一个
    expect(container.querySelectorAll('[data-context-menu]')).toHaveLength(1);
  });
});
