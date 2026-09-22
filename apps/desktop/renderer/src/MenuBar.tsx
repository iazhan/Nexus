import React, { useEffect, useRef, useState } from 'react';

export interface MenuBarItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  /** 当前生效项，用于菜单内标记选中状态。 */
  active?: boolean;
  /** 分组分隔线，仅渲染样式，不响应点击。 */
  separator?: boolean;
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
 * 标题栏下拉菜单：点击展开、悬停切换、点击外部或 Escape 关闭。
 * 菜单项执行后焦点交还给调用方（编辑类动作会主动聚焦编辑器）。
 */
export const MenuBar: React.FC<MenuBarProps> = ({ menus }) => {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openMenuId) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpenMenuId(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenuId(null);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenuId]);

  return (
    <div className="nexus-menu-bar" ref={rootRef}>
      {menus.map((menu) => {
        const isOpen = openMenuId === menu.id;
        return (
          <div className="nexus-menu" key={menu.id}>
            <button
              type="button"
              className={`nexus-menu-bar-button${isOpen ? ' active' : ''}`}
              aria-haspopup="menu"
              aria-expanded={isOpen}
              onClick={() => setOpenMenuId(isOpen ? null : menu.id)}
              onPointerEnter={() => {
                if (openMenuId && openMenuId !== menu.id) setOpenMenuId(menu.id);
              }}
            >
              {menu.label}
            </button>

            {isOpen && (
              <div className="nexus-menu-dropdown" role="menu" aria-label={menu.label}>
                {menu.items.map((item, index) =>
                  item.separator ? (
                    <div
                      key={`separator-${index}`}
                      className="nexus-menu-separator"
                      role="separator"
                    />
                  ) : (
                    <button
                      key={item.label}
                      type="button"
                      role="menuitem"
                      className={`nexus-menu-item${item.active ? ' active' : ''}`}
                      disabled={item.disabled}
                      onClick={() => {
                        setOpenMenuId(null);
                        item.onSelect?.();
                      }}
                    >
                      <span className="nexus-menu-item-label">
                        {item.active && <span aria-hidden="true">✓ </span>}
                        {item.label}
                      </span>
                      {item.shortcut && (
                        <span className="nexus-menu-item-shortcut">{item.shortcut}</span>
                      )}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
