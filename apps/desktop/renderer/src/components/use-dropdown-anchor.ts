import React, { useCallback, useState } from 'react';

/**
 * 「挂在按钮上的下拉」的锚点状态。
 *
 * ## 为什么值得抽成共享钩子
 *
 * 编辑器工具栏的「更多」与工作区侧栏的「切换工作区」是**同一种交互**（按钮 + 浮层菜单），
 * 而两处各写一份 `useState` + 两次 `getBoundingClientRect` 的话，
 * 「点第二次要关掉」这条判据迟早只在其中一处成立。抽出来之后
 * `ContextMenu` 的 `anchorRef` 契约也只有一处调用方需要理解。
 *
 * ## 开点算的是**按钮左下角**
 *
 * 菜单出现在按钮下方、与按钮左沿对齐，和一般应用的下拉一致。偏移 4px 来自调用方的
 * `top: rect.bottom + 4` —— 留一条缝，否则菜单会贴着按钮边缘长出来。
 *
 * ## 量不到时不开
 *
 * `getBoundingClientRect()` 全 0（还没排版、或元素已经不在文档里）时返回 `null`：
 * 开在 (0,0) 闪一下比不开更糟，而那之后的定位修正也救不了一个错误的初始位置。
 * 调用方因此必须 `anchor !== null` 才渲染 `ContextMenu`。
 */
export interface DropdownAnchor {
  /** 锚点坐标（视口坐标）。`null` ＝ 菜单关着。 */
  anchor: { left: number; top: number } | null;
  /** 开 / 关。由调用方挂在按钮的 `onClick` 上。 */
  toggle(): void;
  close(): void;
}

export function useDropdownAnchor(
  ref: React.RefObject<HTMLElement | null>
): DropdownAnchor {
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);

  const toggle = useCallback(() => {
    setAnchor((current) => {
      if (current) return null;
      const rect = ref.current?.getBoundingClientRect();
      return rect ? { left: rect.left, top: rect.bottom + 4 } : null;
    });
  }, [ref]);

  const close = useCallback(() => setAnchor(null), []);

  return { anchor, toggle, close };
}
