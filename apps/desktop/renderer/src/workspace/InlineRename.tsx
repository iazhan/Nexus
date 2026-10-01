import React, { useEffect, useRef, useState } from 'react';

export interface InlineRenameProps {
  /** 当前文件名（含扩展名）。输入框里显示的初值就是它。 */
  initialName: string;
  /** 提交新名字（**只含基名**，不含目录）。扩展名由调用方保持不变。 */
  onCommit: (newName: string) => void;
  onCancel: () => void;
}

/**
 * 树内联改名：一行就地变成输入框。
 *
 * ## 为什么不用 `window.prompt`
 *
 * **它在 Electron 里不可用**（Chromium 有、Electron 不实现），所以只能自己画。
 *
 * ## 三处刻意的取舍
 *
 * - **焦点进来时只选中「基名」**（`dma` 而不是 `dma.md`）：扩展名是固定的（改名不是
 *   格式转换），选中它只会让人以为能改，改完还会被拒。
 * - **Escape 要 `stopPropagation`**：全局快捷键（关面板、关快速打开）也监听 Escape，
 *   不拦下来的话「取消改名」会顺带把别的面板关掉。
 * - **失焦按取消处理**，不按提交。方向更安全：误点别处最多是「白改一次」，
 *   而误提交会真的去改磁盘上的文件名、还要走一遍引用回写。
 */
export const InlineRename: React.FC<InlineRenameProps> = ({
  initialName,
  onCommit,
  onCancel
}) => {
  const [draft, setDraft] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  // 每次挂载都重新取初值并选中基名。用 `useEffect` 而不是 `autoFocus`：
  // 选区要在元素已经拿到焦点之后才设得上，`autoFocus` 的时序不保证这一点。
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();

    const dot = initialName.lastIndexOf('.');
    const baseEnd = dot > 0 ? dot : initialName.length;
    input.setSelectionRange(0, baseEnd);
  }, [initialName]);

  const submit = (): void => {
    const next = draft.trim();
    // 空名字与没改过的名字都不提交 —— 两者都是「用户其实不想改」
    if (next.length === 0 || next === initialName) {
      onCancel();
      return;
    }
    onCommit(next);
  };

  return (
    <input
      ref={inputRef}
      type="text"
      className="nexus-tree-rename-input"
      value={draft}
      aria-label={initialName}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          submit();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
      // 失焦即取消：见组件说明。`mousedown` 也要拦，否则点一下输入框外的树行
      // 会先触发那一行的打开文件，再轮到 blur。
      onBlur={onCancel}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    />
  );
};
