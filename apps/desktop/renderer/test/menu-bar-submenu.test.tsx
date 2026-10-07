// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MenuBar, type MenuBarItem, type MenuBarMenu } from '../src/MenuBar.js';

/**
 * `MenuBar` 的二级菜单。
 *
 * 直接渲染组件而不是整个 `App`：这一层的行为（悬停展开、点父项收起、点叶子收场、
 * Escape / 点外部关闭）与「菜单里装的是什么」无关，拿一份最小 fixture 就测全了。
 * 「文件菜单里那两项接得对不对」由 `open-workspace-app.test.tsx` 与
 * `desktop-ui-standards.test.tsx` 从 `App` 那一侧盖。
 *
 * ## 悬停要派发 `pointerover`，不是 `pointerenter`
 *
 * React 的 `onPointerEnter` **不是**挂原生 `pointerenter` 的：它走 `pointerover` /
 * `pointerout` 的委托，再自己按 `relatedTarget` 算进出。所以直接派发 `pointerenter`
 * 一个监听者都碰不到，`onPointerEnter` 不会跑（表现是「悬停没反应」，
 * 而用例会以为是被测实现坏了）。派发 `pointerover` + `relatedTarget: null`
 * 就是 React 眼里的「从外面移进来」。
 *
 * 展开也**不是只靠悬停**：点父项同样能展开，所以下面几条用点击的那几条是可靠的，
 * 用悬停的那几条才是这条判据的守卫。
 */

const openFolder = vi.fn();
const openRecentA = vi.fn();
const openRecentB = vi.fn();

function fixture(): MenuBarMenu[] {
  return [
    {
      id: 'file',
      label: '文件',
      items: [
        { id: 'open-file', label: '打开文件', onSelect: openFolder },
        {
          id: 'open-recent',
          label: '打开最近的工作区',
          submenu: [
            { label: 'D:/notes/vault', title: 'D:/notes/vault', onSelect: openRecentA },
            { label: 'E:/notes/second', title: 'E:/notes/second', onSelect: openRecentB }
          ]
        },
        { label: '', separator: true },
        { id: 'close-file', label: '关闭文件', onSelect: vi.fn() }
      ]
    },
    { id: 'edit', label: '编辑', items: [{ id: 'undo', label: '撤销', onSelect: vi.fn() }] }
  ];
}

describe('MenuBar 二级菜单', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    openFolder.mockClear();
    openRecentA.mockClear();
    openRecentB.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = () => {
    act(() => {
      root.render(<MenuBar menus={fixture()} />);
    });
  };

  const byId = <T extends Element>(selector: string): T | null => container.querySelector<T>(selector);

  const click = (element: Element) => {
    act(() => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  /** 悬停：见文件头 —— 必须走 `pointerover` + `relatedTarget: null` 才落进 `onPointerEnter`。 */
  const pointerEnter = (element: Element) => {
    act(() => {
      element.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true, relatedTarget: null })
      );
    });
  };

  const keyDown = (key: string) => {
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  };

  const pointerDownOutside = () => {
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
  };

  const openFileMenu = () => {
    click(byId<HTMLButtonElement>('[data-menu="file"] .nexus-menu-bar-button')!);
  };

  const recentParent = () => byId<HTMLButtonElement>('[data-menu-item="open-recent"]')!;
  const submenu = () => byId<HTMLElement>('.nexus-menu-submenu');

  it('一开始没有二级菜单 —— 它只在悬停 / 点击父项之后才出现', () => {
    render();
    openFileMenu();

    expect(byId('.nexus-menu-dropdown')).not.toBeNull();
    expect(submenu()).toBeNull();
  });

  it('悬停父项展开二级，里面按顺序列出各项', () => {
    render();
    openFileMenu();
    pointerEnter(recentParent());

    const labels = Array.from(
      submenu()!.querySelectorAll<HTMLElement>('.nexus-menu-item-label')
    ).map((el) => el.textContent);
    expect(labels).toEqual(['D:/notes/vault', 'E:/notes/second']);
  });

  it('点父项是展开 / 收起，**不执行任何动作**', () => {
    render();
    openFileMenu();

    click(recentParent());
    expect(submenu()).not.toBeNull();

    click(recentParent());
    expect(submenu()).toBeNull();
    // 带二级的项自己没有动作可言，「既展开又执行」会让用户没法只看看里面有什么。
    expect(openRecentA).not.toHaveBeenCalled();
    expect(openRecentB).not.toHaveBeenCalled();
  });

  it('父项用箭头标出「还有下一层」，普通项没有', () => {
    render();
    openFileMenu();

    expect(recentParent().querySelector('.nexus-menu-item-arrow')).not.toBeNull();
    expect(byId('[data-menu-item="open-file"] .nexus-menu-item-arrow')).toBeNull();
  });

  it('点二级里的一项：执行它自己的动作，并把**整条菜单一起收掉**', () => {
    render();
    openFileMenu();
    pointerEnter(recentParent());

    const second = Array.from(
      submenu()!.querySelectorAll<HTMLButtonElement>('.nexus-menu-item')
    ).find((el) => el.textContent?.includes('E:/notes/second'))!;
    click(second);

    expect(openRecentB).toHaveBeenCalledTimes(1);
    // 只收二级而留着一级的话，执行完动作还悬着一个菜单挡在界面上。
    expect(openRecentA).not.toHaveBeenCalled();
    expect(submenu()).toBeNull();
    expect(byId('.nexus-menu-dropdown')).toBeNull();
  });

  it('二级项带 `title`，被 CSS 截断的路径能从提示里看全', () => {
    render();
    openFileMenu();
    pointerEnter(recentParent());

    const first = submenu()!.querySelector<HTMLButtonElement>('.nexus-menu-item')!;
    expect(first.getAttribute('title')).toBe('D:/notes/vault');
  });

  it('Escape 一次把二级与一级都关掉', () => {
    render();
    openFileMenu();
    pointerEnter(recentParent());
    expect(submenu()).not.toBeNull();

    keyDown('Escape');

    expect(submenu()).toBeNull();
    expect(byId('.nexus-menu-dropdown')).toBeNull();
  });

  it('点菜单外面同样两级一起关', () => {
    render();
    openFileMenu();
    pointerEnter(recentParent());

    pointerDownOutside();

    expect(submenu()).toBeNull();
    expect(byId('.nexus-menu-dropdown')).toBeNull();
  });

  /**
   * 二级菜单开着的时候切到另一个一级菜单。**这一条盯的是状态没清干净** ——
   * `openSubmenuIndex` 是个裸下标，不清的话下一个菜单会带着上一轮的下标展开自己
   * 那一格，症状是「换了个菜单，还没碰它就自己弹出一层」。
   */
  it('切换一级菜单时二级被清掉，不在新菜单里凭空展开', () => {
    render();
    openFileMenu();
    pointerEnter(recentParent());
    expect(submenu()).not.toBeNull();

    click(byId<HTMLButtonElement>('[data-menu="edit"] .nexus-menu-bar-button')!);

    expect(byId('[data-menu="edit"] .nexus-menu-dropdown')).not.toBeNull();
    expect(submenu()).toBeNull();
  });

  it('关掉一级再打开，二级不会自己回来', () => {
    render();
    openFileMenu();
    pointerEnter(recentParent());

    click(byId<HTMLButtonElement>('[data-menu="file"] .nexus-menu-bar-button')!);
    openFileMenu();

    expect(submenu()).toBeNull();
  });

  /**
   * `active` / `disabled` / `shortcut` 三件事一级与二级共用同一份渲染。
   * 分成两处写的话，这几条只会在一级生效 —— 而二级里同样可能有禁用项。
   */
  it('二级项与一级项共用同一套渲染：禁用与选中标记都生效', () => {
    act(() => {
      root.render(
        <MenuBar
          menus={[
            {
              id: 'file',
              label: '文件',
              items: [
                {
                  id: 'open-recent',
                  label: '最近',
                  submenu: [
                    { label: '当前这个', active: true, onSelect: vi.fn() },
                    { label: '不在了的那个', disabled: true, onSelect: vi.fn() }
                  ]
                }
              ]
            }
          ]}
        />
      );
    });
    openFileMenu();
    pointerEnter(recentParent());

    const items = Array.from(submenu()!.querySelectorAll<HTMLButtonElement>('.nexus-menu-item'));
    expect(items[0]?.textContent).toContain('✓');
    expect(items[0]?.classList.contains('active')).toBe(true);
    expect(items[1]?.disabled).toBe(true);
  });

  /**
   * 分隔线在二级里也认。`submenu` 里混进一条 `separator` 时不能渲染成一个空的可点项。
   */
  it('二级里的分隔线照常画，且不可点', () => {
    act(() => {
      root.render(
        <MenuBar
          menus={[
            {
              id: 'file',
              label: '文件',
              items: [
                {
                  id: 'open-recent',
                  label: '最近',
                  submenu: [
                    { label: 'D:/a', onSelect: vi.fn() },
                    { label: '', separator: true },
                    { label: 'D:/b', onSelect: vi.fn() }
                  ]
                }
              ]
            }
          ]}
        />
      );
    });
    openFileMenu();
    pointerEnter(recentParent());

    expect(submenu()!.querySelectorAll('.nexus-menu-separator')).toHaveLength(1);
    expect(submenu()!.querySelectorAll('.nexus-menu-item')).toHaveLength(2);
  });

  /**
   * 空 `submenu` 等于没有子菜单。渲染成一个点了不展开的箭头项是最糟的结果 ——
   * 「打开最近的工作区」在一个都没记过时就正是这个形状（主进程返回空数组）。
   */
  it('`submenu` 为空数组时按普通项渲染，不画箭头也不展开', () => {
    const onSelect = vi.fn();
    act(() => {
      root.render(
        <MenuBar
          menus={[
            { id: 'file', label: '文件', items: [{ id: 'open-recent', label: '最近', submenu: [], onSelect }] }
          ]}
        />
      );
    });
    openFileMenu();

    expect(recentParent().querySelector('.nexus-menu-item-arrow')).toBeNull();
    click(recentParent());
    expect(submenu()).toBeNull();
    // 空 submenu 是「没有子菜单」，不是「有子菜单但没内容」—— 所以它照常执行自己的动作。
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

/** 上面那批用例用的都是同一份 fixture，这里把它的形状也钉住。 */
describe('MenuBar fixture 自检', () => {
  it('fixture 里那一项确实带 submenu —— 否则上面整批用例都是假绿', () => {
    const items: MenuBarItem[] = fixture()[0]!.items;
    expect(items.find((item) => item.id === 'open-recent')?.submenu).toHaveLength(2);
  });
});
