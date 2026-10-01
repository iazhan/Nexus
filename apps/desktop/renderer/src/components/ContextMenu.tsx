import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * 右键菜单原语。**全仓第一个上下文菜单**，所以这里定的几条规矩后面都要跟着走。
 *
 * ## 为什么是 `position: fixed` 而不是 portal
 *
 * 菜单的调用点在**工作区树里**，而那个容器是 `overflow-y: auto` —— 绝对定位的菜单会被
 * 裁掉（CSS 里一个轴设成 auto，另一个轴就跟着变成 auto，所以横向也跑不掉）。
 * `position: fixed` 的定位基准是视口，**不受祖先 overflow 裁剪**，
 * 于是不需要 `createPortal` 就能浮在树上面。`Dialog` 用的是同一条路。
 *
 * ## 定位要量完再定
 *
 * 「往右下展开会不会出界」只有拿到真实尺寸才知道，所以先按 (x, y) 画一帧、
 * 在 `useLayoutEffect` 里量、量完修正 —— 那个钩子跑在**绘制之前**，
 * 用户看不到它跳一下。（happy-dom 里 `getBoundingClientRect()` 全是 0，
 * 于是它退化成「就用 (x, y)」，测试因此不会因为没排版而抖动。）
 *
 * ## 关闭的四种来源
 *
 * 点菜单外、Escape、窗口失焦、**滚动**。最后一条容易漏：菜单是 fixed 的，不跟着内容走，
 * 留着就会浮在一个和它无关的位置上。
 *
 * 点外部用的是**捕获阶段**的 `pointerdown`：树上的行本身是 `<button>`，冒泡阶段收的话
 * 点另一行会先触发那个行的 `onClick`（打开了文件）、菜单才关 —— 顺序反了，
 * 用户看到的是「我点了菜单外面，结果文件被打开了」。同时要跳过菜单内部的按下，
 * 否则 `pointerdown` 先把菜单卸掉，菜单项自己的 `click` 就永远不会到。
 */

/** 菜单与视口边缘之间留的呼吸位。 */
const EDGE_GAP = 4;

export interface ContextMenuItem {
  /** 测试锚点，同时用作 React key。 */
  id: string;
  label: string;
  /**
   * 危险动作（不可逆的那种）。只影响观感与屏幕阅读器 —— **确认与否由调用方决定**，
   * 因为「要不要确认」取决于这一项具体做什么，而菜单不知道。
   */
  danger?: boolean;
  onSelect(): void;
}

export interface ContextMenuProps {
  /** 鼠标位置（视口坐标，来自 `MouseEvent.clientX/clientY`）。 */
  x: number;
  y: number;
  items: readonly ContextMenuItem[];
  onClose(): void;
  /** `aria-label`。调用方拿着 `t`，这里不依赖 i18n。 */
  label: string;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose, label }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const { width, height } = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(EDGE_GAP, Math.min(x, window.innerWidth - width - EDGE_GAP)),
      top: Math.max(EDGE_GAP, Math.min(y, window.innerHeight - height - EDGE_GAP))
    });
  }, [x, y, items.length]);

  useEffect(() => {
    // 焦点进菜单，键盘才有落点。`tabIndex={-1}` + 手动 focus 而不是让它进 Tab 序 ——
    // 菜单是一次性的浮层，不该被 Tab 撞见。
    menuRef.current?.focus();
  }, []);

  useEffect(() => {
    const close = () => onClose();
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [onClose]);

  const activate = (index: number) => {
    const item = items[index];
    if (!item) return;
    item.onSelect();
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      // 与 `Dialog` 一致：`preventDefault` 让外层 window 级监听器看得见「这层已经处理了」。
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => (current + delta + items.length) % items.length);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate(activeIndex);
    }
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      className="nexus-context-menu"
      data-context-menu=""
      // 未量出尺寸前不画，否则会在 (0,0) 闪一下。尺寸是同步量到的，
      // 所以这一帧与量完那一帧之间没有用户可见的间隔。
      style={position ? { left: position.left, top: position.top } : { visibility: 'hidden' }}
      aria-activedescendant={items[activeIndex] ? `ctx-${items[activeIndex]!.id}` : undefined}
      onKeyDown={handleKeyDown}
      // 在菜单上再按右键不该叠出第二个菜单
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          id={`ctx-${item.id}`}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={`nexus-context-menu-item${item.danger ? ' nexus-context-menu-item-danger' : ''}`}
          data-context-menu-item={item.id}
          {...(index === activeIndex ? { 'data-context-menu-active': '' } : {})}
          // 用 `mouseenter` 而不是 `mouseover`：后者会在子节点之间反复触发。
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => activate(index)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
};
