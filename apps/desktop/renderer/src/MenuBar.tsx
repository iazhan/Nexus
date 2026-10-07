import React, { useEffect, useRef, useState } from 'react';

export interface MenuBarItem {
  label: string;
  /**
   * 测试 / 自动化的锚点。**不参与渲染**，也不参与 React key ——
   * 菜单项的文案会跟着语言变，拿文字当锚点的用例在切语言时会集体失联。
   */
  id?: string;
  shortcut?: string;
  /**
   * 鼠标悬停时的原生提示。
   *
   * 存在的理由是**被截断的标签**：「最近的工作区」那一列显示的是完整路径，长了由 CSS
   * 截成省略号，而截掉的那一半只有这里能补回来。不给的项不挂 `title` ——
   * 全菜单都冒出提示框是另一种噪音。
   */
  title?: string;
  disabled?: boolean;
  /** 当前生效项，用于菜单内标记选中状态。 */
  active?: boolean;
  /** 分组分隔线，仅渲染样式，不响应点击。 */
  separator?: boolean;
  /**
   * 二级菜单。**只支持两层**：二级里的项再写 `submenu` 不会被展开 ——
   * 这个应用没有三级菜单的用例，而支持它要一套递归的定位与关闭规则，
   * 代价远大于收益。`label` 为空的项按分隔线处理，二级里同样成立。
   *
   * 带它的项**自己没有动作**：点它只展开 / 收起，`onSelect` 不会被调用。
   * 「既展开又执行」会让用户没法只看看里面有什么。
   */
  submenu?: MenuBarItem[];
  onSelect?: () => void;
}

export interface MenuBarMenu {
  id: string;
  label: string;
  items: MenuBarItem[];
}

export interface MenuBarProps {
  menus: MenuBarMenu[];
}

/**
 * 一个叶子项（可点击、会执行动作的那种）。一级与二级共用同一份渲染 ——
 * 分成两处写的话，「选中标记 / 快捷键 / 禁用态」三件事迟早只在一处生效。
 */
const MenuLeaf: React.FC<{ item: MenuBarItem; onSelect: () => void }> = ({ item, onSelect }) => (
  <button
    type="button"
    role="menuitem"
    className={`nexus-menu-item${item.active ? ' active' : ''}`}
    data-menu-item={item.id}
    title={item.title}
    disabled={item.disabled}
    onClick={onSelect}
  >
    <span className="nexus-menu-item-label">
      {item.active && <span aria-hidden="true">✓ </span>}
      {item.label}
    </span>
    {item.shortcut && <span className="nexus-menu-item-shortcut">{item.shortcut}</span>}
  </button>
);

/**
 * 标题栏下拉菜单：点击展开、悬停切换、点击外部或 Escape 关闭。
 * 菜单项执行后焦点交还给调用方（编辑类动作会主动聚焦编辑器）。
 *
 * ## 二级菜单（`MenuBarItem.submenu`）
 *
 * 悬停父项即展开，点父项是展开 / 收起，点里面的叶子项**执行动作并把整条菜单一起收掉** ——
 * 与点一级叶子项同一种收场，否则执行完动作还留着一个展开的菜单悬在那儿。
 *
 * 只支持一层：`openSubmenuIndex` 是**单个**下标，不是栈。加第三层时要把它改成一条路径，
 * 而当前没有任何用例需要。
 */
export const MenuBar: React.FC<MenuBarProps> = ({ menus }) => {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  /**
   * 展开着二级菜单的那一项在 `menu.items` 里的**下标**，不是 `id`：
   * `id` 是可选的（只有需要给用例当锚点的项才有），而下标在同一次渲染里总是稳定的。
   * 代价是换菜单、关菜单时必须显式清掉，否则下一次打开会带着上一轮的下标。
   */
  const [openSubmenuIndex, setOpenSubmenuIndex] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openMenuId) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpenMenuId(null);
        setOpenSubmenuIndex(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenuId(null);
        setOpenSubmenuIndex(null);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenuId]);

  const closeAll = (): void => {
    setOpenMenuId(null);
    setOpenSubmenuIndex(null);
  };

  return (
    <div className="nexus-menu-bar" ref={rootRef}>
      {menus.map((menu) => {
        const isOpen = openMenuId === menu.id;
        return (
          <div className="nexus-menu" key={menu.id} data-menu={menu.id}>
            <button
              type="button"
              className={`nexus-menu-bar-button${isOpen ? ' active' : ''}`}
              aria-haspopup="menu"
              aria-expanded={isOpen}
              onClick={() => {
                setOpenMenuId(isOpen ? null : menu.id);
                setOpenSubmenuIndex(null);
              }}
              onPointerEnter={() => {
                if (openMenuId && openMenuId !== menu.id) {
                  setOpenMenuId(menu.id);
                  setOpenSubmenuIndex(null);
                }
              }}
            >
              {menu.label}
            </button>

            {isOpen && (
              <div className="nexus-menu-dropdown" role="menu" aria-label={menu.label}>
                {menu.items.map((item, index) => {
                  if (item.separator) {
                    return (
                      <div
                        key={`separator-${index}`}
                        className="nexus-menu-separator"
                        role="separator"
                      />
                    );
                  }

                  const submenu = item.submenu ?? [];
                  if (submenu.length === 0) {
                    return (
                      <MenuLeaf
                        key={`${menu.id}-${index}`}
                        item={item}
                        onSelect={() => {
                          closeAll();
                          item.onSelect?.();
                        }}
                      />
                    );
                  }

                  const isSubmenuOpen = openSubmenuIndex === index;
                  return (
                    <div
                      key={`${menu.id}-${index}`}
                      className="nexus-menu-submenu-anchor"
                      onPointerEnter={() => setOpenSubmenuIndex(index)}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className="nexus-menu-item"
                        data-menu-item={item.id}
                        data-has-submenu="true"
                        disabled={item.disabled}
                        aria-haspopup="menu"
                        aria-expanded={isSubmenuOpen}
                        onClick={() => setOpenSubmenuIndex(isSubmenuOpen ? null : index)}
                      >
                        <span className="nexus-menu-item-label">{item.label}</span>
                        <span className="nexus-menu-item-arrow" aria-hidden="true">
                          ›
                        </span>
                      </button>

                      {isSubmenuOpen && (
                        <div
                          className="nexus-menu-submenu"
                          role="menu"
                          aria-label={item.label}
                          data-submenu={item.id}
                        >
                          {submenu.map((sub, subIndex) =>
                            sub.separator ? (
                              <div
                                key={`submenu-separator-${subIndex}`}
                                className="nexus-menu-separator"
                                role="separator"
                              />
                            ) : (
                              <MenuLeaf
                                key={`${item.id ?? index}-${subIndex}`}
                                item={sub}
                                onSelect={() => {
                                  closeAll();
                                  sub.onSelect?.();
                                }}
                              />
                            )
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
