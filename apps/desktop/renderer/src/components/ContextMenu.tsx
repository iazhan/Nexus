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
 *
 * 空 `items` **不渲染任何东西**：一个空框比不弹更难解释，而调用方（目录 `path` 为 `null`
 * 时一个动作都给不了）不必为此再写一遍判据。
 *
 * `MenuBar` 也有这几个概念（`id` / `shortcut` / `disabled` / `active` / `separator`），
 * 但它是**另一份实现**。两者形状部分重合、部分不重合（这里没有 `shortcut`），
 * 是因为菜单栏那份要显示快捷键、这份不要 —— 真要合并得先想清楚快捷键列在浮动菜单里
 * 该往哪儿放，不是顺手能合的。**改其中一个的项形状时，去看另一个。**
 */

/** 菜单与视口边缘之间留的呼吸位。 */
const EDGE_GAP = 4;

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
    const close = () => onClose();
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      if (anchorRef?.current?.contains(event.target as Node)) return;
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
  }, [onClose, anchorRef]);

  const activate = (index: number) => {
    const item = items[index];
    // 分隔线不是动作，回车落在它上面什么也不该发生（也不该关菜单）。
    // 禁用项同理 —— 但它**也不关菜单**：关掉等于假装执行过了。
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
  const moveActive = (delta: number) => {
    setActiveIndex((current) => {
      let next = current;
      for (let step = 0; step < items.length; step += 1) {
        next = (next + delta + items.length) % items.length;
        const candidate = items[next];
        if (candidate && !candidate.separator && !candidate.disabled) return next;
      }
      return current;
    });
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
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
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
      aria-activedescendant={
        items[activeIndex] && !items[activeIndex]!.separator
          ? `ctx-${items[activeIndex]!.id}`
          : undefined
      }
      onKeyDown={handleKeyDown}
      // 在菜单上再按右键不该叠出第二个菜单
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => {
        if (item.separator) {
          return (
            <div
              key={`separator-${index}`}
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
        return (
          <button
            key={item.id}
            id={`ctx-${item.id}`}
            type="button"
            role={role}
            {...(checkable ? { 'aria-checked': ticked } : {})}
            tabIndex={-1}
            title={item.title}
            disabled={item.disabled}
            className={`nexus-context-menu-item${item.danger ? ' nexus-context-menu-item-danger' : ''}${
              ticked ? ' nexus-context-menu-item-checked' : ''
            }`}
            data-context-menu-item={item.id}
            {...(checkable ? { 'data-context-menu-checkable': '' } : {})}
            {...(index === activeIndex ? { 'data-context-menu-active': '' } : {})}
            // 用 `mouseenter` 而不是 `mouseover`：后者会在子节点之间反复触发。
            // 禁用项**不接管高亮**：接管了的话键盘落点会跟着鼠标跳到一个点不动的项上。
            onMouseEnter={() => {
              if (!item.disabled) setActiveIndex(index);
            }}
            onClick={() => activate(index)}
          >
            {/* 勾选槽**恒渲染**（未选中时是空的）—— 它是网格的第一列，
                只在选中时才画的话未选中的项会掉进那一列，整组文字左沿参差不齐。 */}
            {checkable && (
              <span className="nexus-context-menu-check" aria-hidden="true">
                {ticked ? '✓' : ''}
              </span>
            )}
            {item.label}
          </button>
        );
      })}
    </div>
  );
};
