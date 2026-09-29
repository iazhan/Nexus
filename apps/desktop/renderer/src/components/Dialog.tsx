import React, { useEffect, useRef } from 'react';

/**
 * 弹层原语：`role="dialog"` + `aria-modal` + 焦点陷阱 + Escape 关闭 + 关闭后焦点归还。
 *
 * 三处容易写错的：
 *
 * - Escape 挂在**面板**上，不挂 `window`。React 的合成事件在根容器处派发，早于 window 上的监听器，
 *   所以 `preventDefault()` 能被外层（设置页那个 window 级 Escape）看见并跳过。挂 window 就会
 *   两层一起关。
 * - 焦点归还必须记**打开前**的 `document.activeElement`。焦点陷阱把焦点吃进来，不还回去键盘用户
 *   就丢了位置。
 * - `Tab` 的循环判据要包含「焦点已经跑到面板外」这一种：此时按 `Shift+Tab` 得回到最后一项，
 *   否则焦点会漏到背后的界面上。
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

function focusableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

export interface DialogProps {
  open: boolean;
  onClose(): void;
  /** `aria-label` 的文案。调用方已经拿着 `t`，这里不再依赖 i18n。 */
  label: string;
  children: React.ReactNode;
  /** 面板对齐方式：`top` 给命令面板（贴顶，不遮住光标附近的内容），`center` 给确认类弹窗。 */
  placement?: 'top' | 'center';
  panelClassName?: string;
  /** 打开时优先聚焦的选择器；缺省聚焦面板里第一个可聚焦元素。 */
  initialFocusSelector?: string;
  /** 测试锚点。 */
  panelId?: string;
}

export const Dialog: React.FC<DialogProps> = ({
  open,
  onClose,
  label,
  children,
  placement = 'center',
  panelClassName,
  initialFocusSelector,
  panelId
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement;
    return () => {
      const target = restoreRef.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const target = initialFocusSelector
      ? panel.querySelector<HTMLElement>(initialFocusSelector)
      : focusableIn(panel)[0];
    (target ?? panel).focus();
  }, [open, initialFocusSelector]);

  if (!open) return null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const items = focusableIn(panelRef.current);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }

    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    const active = document.activeElement;
    const inside = panelRef.current?.contains(active) ?? false;

    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className={`nexus-dialog-backdrop nexus-dialog-backdrop-${placement}`}
      data-dialog-backdrop=""
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`nexus-dialog${panelClassName ? ` ${panelClassName}` : ''}`}
        data-dialog=""
        data-dialog-placement={placement}
        {...(panelId ? { id: panelId } : {})}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </div>
  );
};
