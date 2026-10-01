import React, { useEffect, useRef, useState } from 'react';

export interface NewEntryInputProps {
  /** 输入框的初值（`未命名.md` / `新建文件夹`）。 */
  initialName: string;
  placeholder: string;
  /**
   * 焦点进来时只选中扩展名之前那一段。
   *
   * 文件要（`未命名` 而不是 `未命名.md` —— 用户敲的是名字，扩展名是主进程补的），
   * 文件夹不要（它没有扩展名，全选才是「直接覆盖」）。
   * 这与内联改名是同一条判据（`InlineRename`）。
   */
  selectBeforeExtension: boolean;
  /**
   * 这个名字在同级里是否已存在。
   *
   * **跟着输入实时判**，不是只在初值上判一次 —— 后者等于没判：初值永远是
   * `未命名.md`，而用户接下来敲的才是真正的名字。
   */
  isConflict: (name: string) => boolean;
  /** 冲突提示文案；参数是当前输入的名字。 */
  conflictLabel: (name: string) => string;
  hint: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

/**
 * 树上就地新建：在落点位置插一行输入框。
 *
 * ## 为什么与 `InlineRename` 是两个组件而不是一个带开关的
 *
 * 它们的**失败方向相反**。改名时「提交一个没改过的名字」等于没改，所以直接取消；
 * 新建时「提交一个和初值一样的名字」是完全正常的（用户就想叫 `未命名.md`）。
 * 一个组件里用布尔开关表达这种差别，读的人得先想清楚哪个分支对应哪种场景；
 * 拆开之后各自的 `submit` 只有三行，谁都看得懂。
 *
 * 另一处不同：新建有**同级重名**这个概念，改名没有（改名的目标是它自己）。
 *
 * ## 三条沿用 `InlineRename` 的约定
 *
 * - Escape 要 `stopPropagation`（全局快捷键也在听 Escape）；
 * - 失焦按取消处理（误点别处最多白建一次，误提交会真的往磁盘上写）；
 * - `onMouseDown` 拦一下，否则点树行会先触发那一行的打开文件再轮到 blur。
 */
export const NewEntryInput: React.FC<NewEntryInputProps> = ({
  initialName,
  placeholder,
  selectBeforeExtension,
  isConflict,
  conflictLabel,
  hint,
  onCommit,
  onCancel
}) => {
  const [draft, setDraft] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();

    const dot = selectBeforeExtension ? initialName.lastIndexOf('.') : -1;
    const end = dot > 0 ? dot : initialName.length;
    input.setSelectionRange(0, end);
  }, [initialName, selectBeforeExtension]);

  const trimmed = draft.trim();
  const conflict = trimmed.length > 0 && isConflict(trimmed);

  const submit = (): void => {
    if (trimmed.length === 0 || conflict) return;
    onCommit(trimmed);
  };

  return (
    <div className="nexus-tree-new" title={hint}>
      <input
        ref={inputRef}
        type="text"
        className={`nexus-tree-new-input${conflict ? ' nexus-tree-new-input-conflict' : ''}`}
        value={draft}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-invalid={conflict}
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
        onBlur={onCancel}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      />
      {conflict && <p className="nexus-tree-new-error">{conflictLabel(trimmed)}</p>}
    </div>
  );
};
