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
 * `Mod-/`、`Tab`…）与宿主注册的组合键都不重叠，所以这里是唯一需要摘的一条。
 * 查找 / 替换那三条由下面的 `isHostOwnedFindKey` 处理。
 */
const defaultKeymapWithoutHostConflicts = defaultKeymap.filter(
  (binding) => binding.key !== 'Ctrl-m'
);

/**
 * 宿主拥有「查找 / 替换」这三条组合键，编辑器里不再留第二份。
 *
 * 原本两边各有一份：`searchKeymap` 带 `Mod-f`，下面又显式加了 `Mod-f` / `Mod-h` /
 * `Mod-Shift-f`。CM 的 keymap 挂在 `contentDOM` 上、先于宿主的 `window` 监听器跑，
 * 匹配上就 `preventDefault()` —— 于是**光标在编辑器里时改绑定不生效**：宿主收不到事件，
 * 生效的还是 CM 那份写死的键。
 *
 * 摘掉编辑器这份，宿主成为唯一权威。代价是搜索面板打开时 `Mod-f` 不再由 CM 重开面板，
 * 而是冒泡到宿主 —— 宿主那条命令做的是同一件事（`openSearchPanel(activeView)`），行为不变。
 *
 * `Escape` 留在编辑器里：它是搜索面板自己的关闭键（作用域 `editor search-panel`），
 * 面板没开时 CM 不消费它，与宿主的 Escape 不冲突。
 *
 * 判据写成函数而不是三个字面量：CM 的绑定里修饰键顺序不固定（`searchKeymap` 自己就写着
 * `Shift-Mod-g`），按字符串精确匹配会漏掉 `Shift-Mod-f` 这种写法。
 */
function isHostOwnedFindKey(bindingKey: string | undefined): boolean {
  // `KeyBinding` 允许只写 `mac` / `win` / `linux` 变体而不写 `key`，那些条目这里管不着。
  if (!bindingKey) return false;
  const parts = bindingKey.split('-').map((part) => part.toLowerCase());
  const key = parts.pop();
  if (key !== 'f' && key !== 'h') return false;
  if (!parts.includes('mod')) return false;
  // 只放行 `Mod-<key>` 与 `Mod-Shift-<key>` 两种形状，别的（`Mod-Alt-f` 之类）不是宿主占用的。
  return parts.every((part) => part === 'mod' || part === 'shift') && new Set(parts).size === parts.length;
}

export const editorKeybindings: KeyBinding[] = [
  ...defaultKeymapWithoutHostConflicts,
  ...historyKeymap,
  ...searchKeymap,
  ...completionKeymap
].filter((binding) => !isHostOwnedFindKey(binding.key)).concat([
  { key: 'Escape', run: closeSearchPanel, scope: 'editor' }
]);

export const visualEditorKeybindings: KeyBinding[] = [
  ...defaultKeymapWithoutHostConflicts.filter((b) => b.key !== 'Enter' && b.key !== 'Backspace'),
  ...historyKeymap,
  ...searchKeymap,
  ...completionKeymap
].filter((binding) => !isHostOwnedFindKey(binding.key)).concat([
  { key: 'Escape', run: closeSearchPanel, scope: 'editor' }
]);

export { openSearchPanel, closeSearchPanel };
