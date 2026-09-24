import { type KeyBinding } from '@codemirror/view';
import { defaultKeymap, historyKeymap } from '@codemirror/commands';
import { searchKeymap, openSearchPanel, closeSearchPanel } from '@codemirror/search';
import { completionKeymap } from '@codemirror/autocomplete';

/**
 * `defaultKeymap` 里的 `Ctrl-m`（`toggleTabFocusMode`）会和宿主的「切换 surface」撞车。
 *
 * 宿主的全局快捷键挂在 `window` 上，开头是 `if (e.defaultPrevented) return;`；
 * 而 CM 的 keymap 挂在 `contentDOM` 上、先跑。于是编辑器**聚焦**时 Ctrl+M 被 CM
 * 吞掉（`preventDefault`），宿主收不到——表现为"这个快捷键只在编辑器没聚焦时有效"。
 *
 * 宿主已经把这个组合键当成自己的命令，这里就把它摘掉，让 Mod-M 在聚焦与否时行为一致。
 * （macOS 上该绑定是 `Shift-Alt-m`，本来就不与 Cmd-M 冲突；一并摘掉不损失可用功能。）
 *
 * 顺带记一笔核对结果：`defaultKeymap` 的其余绑定（`Mod-i`、`Mod-[`、`Shift-Mod-k`、
 * `Mod-/`、`Tab`…）与宿主注册的 Mod-N/O/S/Shift-S/M/F/H、Mod-K、Mod-W 都不重叠，
 * 所以这是唯一需要摘的一条。
 */
const defaultKeymapWithoutHostConflicts = defaultKeymap.filter(
  (binding) => binding.key !== 'Ctrl-m'
);

export const editorKeybindings: KeyBinding[] = [
  ...defaultKeymapWithoutHostConflicts,
  ...historyKeymap,
  ...searchKeymap,
  ...completionKeymap,
  { key: 'Mod-f', run: openSearchPanel, scope: 'editor' },
  { key: 'Mod-h', run: openSearchPanel, scope: 'editor' },
  { key: 'Mod-Shift-f', run: openSearchPanel, scope: 'editor' },
  { key: 'Escape', run: closeSearchPanel, scope: 'editor' }
];

export const visualEditorKeybindings: KeyBinding[] = [
  ...defaultKeymapWithoutHostConflicts.filter((b) => b.key !== 'Enter' && b.key !== 'Backspace'),
  ...historyKeymap,
  ...searchKeymap,
  ...completionKeymap,
  { key: 'Mod-f', run: openSearchPanel, scope: 'editor' },
  { key: 'Mod-h', run: openSearchPanel, scope: 'editor' },
  { key: 'Mod-Shift-f', run: openSearchPanel, scope: 'editor' },
  { key: 'Escape', run: closeSearchPanel, scope: 'editor' }
];

export { openSearchPanel, closeSearchPanel };
