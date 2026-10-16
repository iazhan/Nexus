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
 *
 * ## `anchorRef`：下拉形态的锚点不算「外部」
 *
 * 工具栏的「更多」是一个**挂在按钮上的下拉**。点那个按钮时，`pointerdown` 先到、
 * 菜单被卸掉，紧接着按钮自己的 `click` 又把它开回来 —— 用户按了「关」，看到的是「没反应」。
 * 把锚点元素告诉菜单（`anchorRef`），锚点内的按下就不算外部，开关交给按钮自己的 `click`。
 * 右键菜单不需要它（没有「同一个按钮再按一次」这件事），所以这个参数是可选的。
 *
 * ## 焦点进出
 *
 * 菜单要拿焦点，键盘（方向键 / Enter / Escape）才有落点，所以打开时把焦点收进来。
 * 关掉时**还回打开前那个元素** —— 工具栏的「更多」是从编辑器里点出来的，不还的话
 * 编辑器就永久失焦，下一次按键没有落点（`Dialog` 是同一个道理，同一种写法）。
 *
 * 但**只在焦点还留在菜单里的时候**才还：菜单项的动作自己把焦点挪走的情况是存在的
 * （「替换」会打开搜索面板并聚焦它的输入框），抢回来等于把用户刚打开的输入框踢走。
 *
 * ## 菜单项的形状：命令项、勾选项、开关项、禁用项、分隔线
 *
 * - **命令项**（只有 `label` + `onSelect`）用 `role="menuitem"`。「替换」那种。
 * - **勾选项**（`active` 有值）用 `role="menuitemradio"` + `aria-checked`，并在左侧留一条
 *   固定宽度的勾选槽。块类型下拉是「一组互斥项里当前是哪个」，正是 radio 要表达的东西。
 *   `active: false` 与 `active: undefined` **不是一回事**：前者是「这项存在但没生效」，
 *   后者是「这个概念在这份菜单里不存在」—— 后者不占勾选槽。
 * - **开关项**（`checked` 有值）用 `role="menuitemcheckbox"`。与 `active` 是**两件事**：
 *   radio 的前提是「有一组」，而「显示图片」这种开关没有组。两者共用同一条勾选槽；
 *   真同时给时按 `active` 算 —— 一个 `aria-checked` 只能有一个来源。
 * - **禁用项**（`disabled`）画灰、不响应点击、上下键跳过它。存在的理由是
 *   「**禁用优先于隐藏**」：菜单项的位置忽有忽无，比灰着一格更难理解。禁用**不带原因**，
 *   原因进 `title` —— 与工具栏的灰按钮同一条约定。
 * - **分隔线**（`separator`）是 `role="separator"`，**不参与键盘导航**：
 *   上下键跳过它，回车落在它上面什么也不发生。
 * - **二级菜单**（`submenu`）带它自己的 `role="menu"`，**只支持两层** —— 里面的项再写
 *   `submenu` 不会被展开（与 `MenuBarItem.submenu` 同一条约定）。带它的项自己没有动作。
 *
 * 空 `items` **不渲染任何东西**：一个空框比不弹更难解释，而调用方（目录 `path` 为 `null`
 * 时一个动作都给不了）不必为此再写一遍判据。
 *
 * ## 高度上限与「菜单内部的滚动不算关闭」
 *
 * 菜单有 `max-height`（视口减两侧呼吸位）与 `overflow-y: auto` —— 编辑器那份菜单
 * 的「格式」子菜单有二十项，短窗口上不封顶会顶出屏幕。
 *
 * 但**加了滚动就必须改关闭判据**：下面的 `scroll` 监听是**捕获阶段挂在 window 上**的，
 * 菜单内部滚一下同样会经过它，于是「滚一下菜单看下面还有什么」会变成「菜单没了」。
 * 与 `pointerdown` 跳过菜单内部是同一条规矩：**菜单内部的交互不算外部**。
 *
 * `MenuBar` 也有这几个概念（`id` / `shortcut` / `disabled` / `active` / `separator` /
 * `submenu`），但它是**另一份实现**。两者形状部分重合、部分不重合（这里没有 `shortcut`），
 * 是因为菜单栏那份要显示快捷键、这份不要 —— 真要合并得先想清楚快捷键列在浮动菜单里
 * 该往哪儿放，不是顺手能合的。**改其中一个的项形状时，去看另一个。**
 *
 * 子菜单的**定位**是两份实现差别最大的一处：菜单栏的下拉是左对齐的常驻面板，二级一律
 * 往右开；这里的菜单贴着指针 `fixed` 出来，右边没地方要**往左翻** —— 不翻的话在窗口右缘
 * 右键会得到一份跑到屏幕外的子菜单，而「夹取到视口内」正是这个原语存在的理由。
 */

/** 菜单与视口边缘之间留的呼吸位。 */
const EDGE_GAP = 4;

/**
 * 一级项与二级面板之间留的缝。
 *
 * **不能是 0**：两个面板贴在一起时，指针从一级项移向二级的那一瞬间会落在缝上 ——
 * 缝里既不属于一级项也不属于二级面板，`mouseenter` 不触发，`mouseleave` 却会，
 * 于是子菜单在指针刚出发时就关掉。留 2px 再配合「移进子菜单不关」那条判据就够了。
 *
 * markra 在同样的位置放了一块透明的「桥」（`contextSubmenuBridgeStyle`）来盖住这条缝；
 * 这里用「谁触发的关闭」来判，不需要额外一个元素。
 */
const SUBMENU_GAP = 2;

/**
 * 二级面板相对一级项的纵向偏移。
 *
 * 与 `.nexus-menu-submenu` 的 `top: -5px` 同一条理由：让**第一项的文字**与一级项的文字
 * 对齐，而不是让两个面板的边框对齐。一级项的内边距 5 = 面板边框 1 + 面板内边距 4 +
 * 二级项内边距 5，所以面板要整体上移 5px。
 */
const SUBMENU_TOP_OFFSET = 5;

/**
 * 键盘的第一个落点。分隔线与禁用项都不是落点（与 `moveActive` 同一条判据）——
 * 落在禁用项上会画出「高亮着但点不动」的一格。
 *
 * 一个都落不下去时给 `-1`（整份菜单全禁用）：那样谁都不带高亮属性，
 * 比高亮第一格却按不动诚实。
 */
function firstSelectableIndex(items: readonly ContextMenuItem[]): number {
  return items.findIndex((item) => !item.separator && !item.disabled);
}

export interface ContextMenuItem {
  /** 测试锚点，同时用作 React key。 */
  id: string;
  label: string;
  /**
   * 危险动作（不可逆的那种）。只影响观感与屏幕阅读器 —— **确认与否由调用方决定**，
   * 因为「要不要确认」取决于这一项具体做什么，而菜单不知道。
   */
  danger?: boolean;
  /**
   * 当前生效项，画一个 ✓。**由调用方算好** —— 菜单不知道「这一项生效」是什么意思
   * （块类型看 AST，别的菜单可能是看设置值）。`undefined` 与 `false` 都不画 ✓：
   * 前者是「这个概念不存在」（如「替换」），后者是「存在但不生效」。
   *
   * 语义是 **radio**：一组互斥项里当前是哪个。独立的开关用 `checked`。
   */
  active?: boolean;
  /**
   * 独立的开关（「显示图片」那种）。与 `active` 共用勾选槽与 ✓，但 role 是
   * `menuitemcheckbox` —— 开关没有「组」这个概念。同时给时以 `active` 为准。
   */
  checked?: boolean;
  /**
   * 灰掉。点击不触发、键盘上下键跳过它。**不带原因** —— 原因进 `title`，
   * 与工具栏的灰按钮同一条约定（`workspace-toolbar.tsx` 的 `deleteHint`）。
   */
  disabled?: boolean;
  /**
   * 悬浮提示。**只在文案被截断 / 缩写时给**（如「最近的工作区」显示目录名、
   * 完整路径进 title）—— 与 `label` 重复的 title 只是噪声。
   */
  title?: string;
  /**
   * 分组分隔线。`id` / `label` / `onSelect` 在这类项上都不参与渲染。
   *
   * 与 `MenuBarItem` 的 `separator` 是同一个概念、同一种写法 —— 同一份块类型列表
   * 在菜单栏与工具栏下拉里都得有分组线，一边有一边没有就是两处不一致。
   */
  separator?: boolean;
  /**
   * 二级菜单。**只支持两层**：里面的项再写 `submenu` 不会被展开 —— 与 `MenuBarItem`
   * 同一条约定（这个应用没有三级菜单的用例，支持它要一套递归的定位与关闭规则）。
   *
   * 带它的项**自己没有动作**：点它 / 回车只展开收起，`onSelect` 不会被调用。
   * 「既展开又执行」会让用户没法只看看里面有什么。
   *
   * 与 `MenuBarItem.submenu` 的差别只在定位：那边一律往右开，这边右边没地方往左翻。
   */
  submenu?: readonly ContextMenuItem[];
  onSelect?(): void;
}

export interface ContextMenuProps {
  /** 鼠标位置（视口坐标，来自 `MouseEvent.clientX/clientY`）。 */
  x: number;
  y: number;
  items: readonly ContextMenuItem[];
  onClose(): void;
  /** `aria-label`。调用方拿着 `t`，这里不依赖 i18n。 */
  label: string;
  /**
   * 下拉形态的**锚点**（挂菜单的那个按钮）。锚点内的 `pointerdown` 不算「点外部」，
   * 否则「再按一次按钮关掉」会变成「关掉又立刻开回来」。见文件头的「关闭的四种来源」。
   */
  anchorRef?: React.RefObject<HTMLElement | null>;
}

/**
 * 空清单不画任何东西（理由见文件头）。
 *
 * 判据放在原语这一层而不是各调用方：调用方（目录 `path` 为 `null` 那种）本来就不知道该
 * 给什么动作，而「没有动作的菜单」是原语一眼能看出来的事。
 *
 * **必须是独立一层而不是在下面 `return null`**：`items` 为空时那几个 hook 一个都不该跑
 * —— 跑了会给一份不存在的菜单注册全局监听（下一次滚动就调 `onClose`），而 hook 又不能
 * 写在 return 后面。多这一层正是为了把「不渲染」与「不注册」绑在同一处。
 */
export const ContextMenu: React.FC<ContextMenuProps> = (props) =>
  props.items.length === 0 ? null : <ContextMenuSurface {...props} />;

/**
 * 二级面板。**与根菜单同一套「量完再定」**，只是翻转轴换成横向：
 * 优先贴着父项的右边开，右边放不下就翻到左边。
 *
 * 它自己不知道里面装什么 —— 项由父级渲染好传进来（`children`）。这样「怎么画一项」
 * 只有一份实现，两级不会各自漂。
 */
const ContextSubmenu: React.FC<{
  anchor: DOMRect;
  label: string;
  children: React.ReactNode;
}> = ({ anchor, label, children }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const { width, height } = panel.getBoundingClientRect();
    const toTheRight = anchor.right + SUBMENU_GAP;
    // 翻转判据用**未夹取**的位置算：夹取之后再问「放不放得下」永远是放得下。
    const toTheLeft = anchor.left - width - SUBMENU_GAP;
    const preferred =
      toTheRight + width + EDGE_GAP > window.innerWidth ? toTheLeft : toTheRight;

    setPosition({
      left: Math.max(EDGE_GAP, Math.min(preferred, window.innerWidth - width - EDGE_GAP)),
      top: Math.max(
        EDGE_GAP,
        Math.min(anchor.top - SUBMENU_TOP_OFFSET, window.innerHeight - height - EDGE_GAP)
      )
    });
    // 依赖**只有 `anchor`**：`anchor` 是打开那一刻存下来的 `DOMRect`，切到另一个父项时
    // 换的是它。**不能把 `children` 写进来** —— 它每次渲染都是新数组，而 effect 里会
    // `setPosition` 一个新对象，于是「渲染 → effect → 新 state → 渲染」转个不停。
  }, [anchor]);

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      className="nexus-context-menu nexus-context-submenu"
      // 与根菜单的 `data-context-menu` **刻意分开**：用例里「菜单还在不在」问的是根菜单，
      // 两级共用一个属性会让「子菜单开着」被当成「菜单开着」。
      data-context-submenu=""
      style={position ? { left: position.left, top: position.top } : { visibility: 'hidden' }}
    >
      {children}
    </div>
  );
};

const ContextMenuSurface: React.FC<ContextMenuProps> = ({
  x,
  y,
  items,
  onClose,
  label,
  anchorRef
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(() => firstSelectableIndex(items));

  /**
   * 展开的是哪一项的二级菜单（`null` ＝ 没展开）。存**下标**而不是 id：同一份清单里
   * id 不重，但下标与「当前高亮到哪」是同一套坐标系。
   */
  const [openSubmenuIndex, setOpenSubmenuIndex] = useState<number | null>(null);
  /** 二级面板里的高亮。与 `activeIndex` 分开 —— 一个 `aria-activedescendant` 只有一个来源。 */
  const [submenuActiveIndex, setSubmenuActiveIndex] = useState(-1);
  /**
   * 二级面板的锚（父项那一刻的矩形）。**只在打开时取一次**：窗口一 resize 整个菜单就
   * 关掉了（下面的 `resize` 监听），所以不存在「锚过期」这件事。
   */
  const [submenuAnchor, setSubmenuAnchor] = useState<DOMRect | null>(null);

  /** 一级项的 DOM 句柄。只给**键盘**展开子菜单用 —— 鼠标那条路直接读 `currentTarget`。 */
  const itemRefs = useRef(new Map<number, HTMLButtonElement>());

  const submenuItems: readonly ContextMenuItem[] =
    openSubmenuIndex === null ? [] : (items[openSubmenuIndex]?.submenu ?? []);

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
    //
    // 关掉之后要**还回去**（同 `Dialog`）：从编辑器工具栏的「更多」进来一趟，不还的话
    // 编辑器就永久失焦了 —— 命令照样执行，但用户接下来的按键没有落点，看起来像「点了没反应」。
    // 记的是**打开之前**那个元素，因为焦点陷阱已经把焦点吃进来了。
    const opener = document.activeElement;
    const menu = menuRef.current;
    menu?.focus();
    return () => {
      const active = document.activeElement;
      // 只有「焦点还在我们手里」才归还：还在菜单里（或因为菜单被卸掉而掉回 `body`）。
      // 动作自己把焦点挪走了就别抢回来 —— 「替换」会打开搜索面板并聚焦输入框，
      // 抢回来等于把用户刚打开的输入框又踢走。
      const stillOurs = active === null || active === document.body || Boolean(menu?.contains(active));
      if (!stillOurs) return;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      // 二级面板是根菜单的 **DOM 后代**（只是 `fixed` 定位），所以这一句同时盖住两级。
      if (menuRef.current?.contains(event.target as Node)) return;
      if (anchorRef?.current?.contains(event.target as Node)) return;
      onClose();
    };
    /**
     * **滚动只在菜单外面才算关闭。** 这个监听是捕获阶段挂在 `window` 上的，菜单自己滚一下
     * 同样会经过它 —— 不加这一句，「滚一滚看子菜单下面还有什么」会变成「菜单没了」。
     * 与 `pointerdown` 跳过菜单内部是同一条规矩：**菜单内部的交互不算外部**。
     */
    const handleScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const close = () => onClose();

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [onClose, anchorRef]);

  const openSubmenu = (index: number, anchor: DOMRect) => {
    const submenu = items[index]?.submenu ?? [];
    if (submenu.length === 0) return;
    setOpenSubmenuIndex(index);
    setSubmenuActiveIndex(firstSelectableIndex(submenu));
    setSubmenuAnchor(anchor);
  };

  const closeSubmenu = () => {
    setOpenSubmenuIndex(null);
    setSubmenuActiveIndex(-1);
    setSubmenuAnchor(null);
  };

  const activate = (index: number) => {
    const item = items[index];
    // 分隔线不是动作，回车落在它上面什么也不该发生（也不该关菜单）。
    // 禁用项同理 —— 但它**也不关菜单**：关掉等于假装执行过了。
    if (!item || item.separator || item.disabled) return;
    item.onSelect?.();
    onClose();
  };

  const activateSubmenu = (index: number) => {
    const item = submenuItems[index];
    if (!item || item.separator || item.disabled) return;
    item.onSelect?.();
    onClose();
  };

  /**
   * 上下键的落点：**跳过分隔线与禁用项**，否则按一下箭头看起来像「没动」。
   *
   * 转一整圈都落不下去时停在原地（`return current`）—— 整份菜单全禁用时，
   * 绕回自己比跳到一个不可用的项上诚实。
   */
  const step = (
    list: readonly ContextMenuItem[],
    current: number,
    delta: number
  ): number => {
    let next = current;
    for (let index = 0; index < list.length; index += 1) {
      next = (next + delta + list.length) % list.length;
      const candidate = list[next];
      if (candidate && !candidate.separator && !candidate.disabled) return next;
    }
    return current;
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const submenuOpen = openSubmenuIndex !== null;

    if (event.key === 'Escape') {
      // 与 `Dialog` 一致：`preventDefault` 让外层 window 级监听器看得见「这层已经处理了」。
      event.preventDefault();
      // **先收子菜单再关菜单**：一次 Escape 把两层都关掉，用户就再也回不到一级。
      if (submenuOpen) closeSubmenu();
      else onClose();
      return;
    }

    if (event.key === 'ArrowLeft') {
      // 没展开子菜单时什么都不做 —— 一级菜单没有「上一层」可退。
      if (!submenuOpen) return;
      event.preventDefault();
      closeSubmenu();
      return;
    }

    if (event.key === 'ArrowRight') {
      if (submenuOpen) return;
      const element = itemRefs.current.get(activeIndex);
      if (!element) return;
      event.preventDefault();
      openSubmenu(activeIndex, element.getBoundingClientRect());
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      // 子菜单开着时方向键**在子菜单里走** —— 这是「进去之后能挑」的全部含义。
      if (submenuOpen) setSubmenuActiveIndex((current) => step(submenuItems, current, delta));
      else setActiveIndex((current) => step(items, current, delta));
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (submenuOpen) {
        activateSubmenu(submenuActiveIndex);
        return;
      }
      // 带二级菜单的父项**自己没有动作**：回车只展开，与点它一致。
      if ((items[activeIndex]?.submenu?.length ?? 0) > 0) {
        const element = itemRefs.current.get(activeIndex);
        if (element) openSubmenu(activeIndex, element.getBoundingClientRect());
        return;
      }
      activate(activeIndex);
    }
  };

  /**
   * 画一层菜单。**两级共用这一份** —— 勾选语义、禁用、危险色、子菜单箭头各写一遍
   * 迟早只在一处生效。差别只有三个：DOM id 前缀、是否登记 ref（只有一级需要）、
   * 以及高亮下标从哪来。
   */
  const renderItems = (
    list: readonly ContextMenuItem[],
    level: 'root' | 'sub',
    highlighted: number
  ): React.ReactNode[] =>
    list.map((item, index) => {
      if (item.separator) {
        return (
          <div
            key={`${level}-separator-${index}`}
            role="separator"
            className="nexus-context-menu-separator"
          />
        );
      }

      // 勾选语义与勾选槽共用同一个判据：`active` 是「一组互斥项里的一个」（radio），
      // `checked` 是「独立开关」（checkbox）。**一个 `aria-checked` 只能有一个来源** ——
      // 两者同时给时按 `active` 算，✓ 与 `aria-checked` 都从这同一个 `ticked` 出来
      // （两处各判一次就会漂，判据 36 的同类）。
      const radio = item.active !== undefined;
      const checkable = radio || item.checked !== undefined;
      const ticked = radio ? item.active === true : item.checked === true;
      const role = radio ? 'menuitemradio' : checkable ? 'menuitemcheckbox' : 'menuitem';
      const submenu = item.submenu ?? [];
      const hasSubmenu = submenu.length > 0;
      const expanded = level === 'root' && openSubmenuIndex === index;

      return (
        <button
          key={`${level}-${item.id}`}
          id={level === 'root' ? `ctx-${item.id}` : `ctx-sub-${item.id}`}
          {...(level === 'root'
            ? {
                ref: (element: HTMLButtonElement | null) => {
                  if (element) itemRefs.current.set(index, element);
                  else itemRefs.current.delete(index);
                }
              }
            : {})}
          type="button"
          role={role}
          {...(checkable ? { 'aria-checked': ticked } : {})}
          {...(hasSubmenu ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': expanded } : {})}
          tabIndex={-1}
          title={item.title}
          disabled={item.disabled}
          className={`nexus-context-menu-item${item.danger ? ' nexus-context-menu-item-danger' : ''}${
            ticked ? ' nexus-context-menu-item-checked' : ''
          }${hasSubmenu ? ' nexus-context-menu-item-has-submenu' : ''}`}
          data-context-menu-item={item.id}
          {...(checkable ? { 'data-context-menu-checkable': '' } : {})}
          {...(index === highlighted ? { 'data-context-menu-active': '' } : {})}
          // 用 `mouseenter` 而不是 `mouseover`：后者会在子节点之间反复触发。
          // 禁用项**不接管高亮**：接管了的话键盘落点会跟着鼠标跳到一个点不动的项上。
          onMouseEnter={(event) => {
            if (item.disabled) return;
            if (level === 'sub') {
              setSubmenuActiveIndex(index);
              return;
            }
            setActiveIndex(index);
            // 移到别的项上就收掉当前的子菜单；移到**自己**（正展开的那个）不收，
            // 否则从子菜单往回移会来回闪。
            if (hasSubmenu) openSubmenu(index, event.currentTarget.getBoundingClientRect());
            else if (openSubmenuIndex !== index) closeSubmenu();
          }}
          onClick={(event) => {
            if (level === 'sub') {
              activateSubmenu(index);
              return;
            }
            // 带二级菜单的项：点它只展开 / 收起，`onSelect` 不会被调用。
            if (hasSubmenu) {
              if (expanded) closeSubmenu();
              else openSubmenu(index, event.currentTarget.getBoundingClientRect());
              return;
            }
            activate(index);
          }}
        >
          {/* 勾选槽**恒渲染**（未选中时是空的）—— 它是网格的第一列，
              只在选中时才画的话未选中的项会掉进那一列，整组文字左沿参差不齐。 */}
          {checkable && (
            <span className="nexus-context-menu-check" aria-hidden="true">
              {ticked ? '✓' : ''}
            </span>
          )}
          {item.label}
          {/* 箭头是**纯装饰**：展开与否已经由 `aria-expanded` 说了，
              屏幕阅读器再念一遍「›」只是噪声。 */}
          {hasSubmenu && (
            <span className="nexus-context-menu-arrow" aria-hidden="true">
              ›
            </span>
          )}
        </button>
      );
    });

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
      // 子菜单开着时，高亮在二级里 —— 两级共用这一个属性，因为**焦点始终留在根菜单上**
      // （键盘模型只有一套）。二级面板是根菜单的 DOM 后代，所以这个引用是合法的。
      aria-activedescendant={
        openSubmenuIndex !== null
          ? submenuItems[submenuActiveIndex] && !submenuItems[submenuActiveIndex]!.separator
            ? `ctx-sub-${submenuItems[submenuActiveIndex]!.id}`
            : undefined
          : items[activeIndex] && !items[activeIndex]!.separator
            ? `ctx-${items[activeIndex]!.id}`
            : undefined
      }
      onKeyDown={handleKeyDown}
      // 在菜单上再按右键不该叠出第二个菜单
      onContextMenu={(event) => event.preventDefault()}
    >
      {renderItems(items, 'root', activeIndex)}
      {openSubmenuIndex !== null && submenuAnchor && (
        <ContextSubmenu anchor={submenuAnchor} label={items[openSubmenuIndex]?.label ?? ''}>
          {renderItems(submenuItems, 'sub', submenuActiveIndex)}
        </ContextSubmenu>
      )}
    </div>
  );
};
