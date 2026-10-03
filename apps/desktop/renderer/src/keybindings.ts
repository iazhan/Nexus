/**
 * 宿主命令的**默认快捷键**与**生效绑定**。这是快捷键的唯一真相源：
 * 命令注册、键盘分发、菜单标签、命令面板、设置页的可重映射表全部从这里取。
 *
 * 为什么要有一份静态动作表，而不是从 `commandRegistry` 里读：**设置窗口是独立的渲染进程**，
 * 它不渲染 `App`，所以那边的注册表是空的。而「哪些命令可重映射」是产品事实，不是运行期状态
 * —— 静态表在两个窗口里给出同一份答案。
 *
 * 覆盖项存在 `SettingsStore` 的 `keybindings.overrides` 里 —— 与其余偏好同一条路：
 * 落盘、跨窗口广播、设置窗口改完主窗口自动跟上，全都免费。
 */

import {
  UNBOUND,
  createKeybindingTable,
  isApplePlatform,
  normalizeShortcut,
  type KeybindingOverrides,
  type KeybindingTable
} from '@nexus/command';
import { settings } from './platform.js';

/** 一条可重映射的宿主命令。`labelKey` 复用命令自己的文案键，不另开一套。 */
export interface RemappableAction {
  id: string;
  labelKey: string;
  defaultSpec: string;
}

/**
 * 可重映射的动作。**顺序即设置页的显示顺序**，按使用频率排（保存 / 新建 / 打开在前）。
 *
 * 不在这里的命令就是**没有默认快捷键**的命令（`toggle-theme` / `toggle-locale` /
 * `open-in-workspace`）—— 它们能正常执行，只是初始没有绑定任何组合键。
 */
export const REMAPPABLE_ACTIONS: readonly RemappableAction[] = [
  { id: 'save', labelKey: 'cmd.save', defaultSpec: 'Mod-S' },
  { id: 'save-as', labelKey: 'cmd.saveAs', defaultSpec: 'Mod-Shift-S' },
  { id: 'new-file', labelKey: 'cmd.newFile', defaultSpec: 'Mod-N' },
  { id: 'open-file', labelKey: 'cmd.openFile', defaultSpec: 'Mod-O' },
  { id: 'palette.open', labelKey: 'cmd.palette', defaultSpec: 'Mod-K' },
  { id: 'quick-open', labelKey: 'quickopen.title', defaultSpec: 'Mod-P' },
  { id: 'find', labelKey: 'cmd.find', defaultSpec: 'Mod-F' },
  { id: 'replace', labelKey: 'cmd.replace', defaultSpec: 'Mod-H' },
  { id: 'toggle-surface', labelKey: 'cmd.toggleSurface', defaultSpec: 'Mod-M' },
  { id: 'settings.open', labelKey: 'cmd.openSettings', defaultSpec: 'Mod-,' },
  { id: 'window.close', labelKey: 'cmd.closeFile', defaultSpec: 'Mod-W' }
];

/** id → 默认规格串。命令注册时带的那份 `shortcut` 从这里取，两处不各写一个字面量。 */
export const DEFAULT_SHORTCUTS: Readonly<Record<string, string>> = Object.fromEntries(
  REMAPPABLE_ACTIONS.map((action) => [action.id, action.defaultSpec])
);

/**
 * 重做。**Apple 是 `Mod-Shift-Z`，其余平台是 `Mod-Y`** —— CodeMirror 的 `historyKeymap`
 * 就是这么分的（`{ key: 'Mod-y', mac: 'Mod-Shift-z' }`），菜单里那格原来写死 `Mod-Shift-Z`，
 * 在 Windows 上显示的是一个按下去不生效的组合键。
 */
export const REDO_SHORTCUT = isApplePlatform() ? 'Mod-Shift-Z' : 'Mod-Y';

/**
 * 改不了的键。**只读清单，不是从代码里推出来的** —— 它的价值就是「诚实说明哪些动不了」，
 * 而「哪些动不了」取决于 CodeMirror 与操作系统的实现，不是本仓库的一张表能推出来的事实。
 *
 * 维护判据：某条组合键的行为**不经过宿主的 keydown 分发**时，它就该出现在这里。放进来比漏掉好：
 * 漏掉会让用户以为「改了没生效」是 bug，放进来最坏是「本来能改的没让改」。
 *
 * 每一条都对着实际装配的 keymap 核过（`defaultKeymap` / `historyKeymap` / `searchKeymap` /
 * `completionKeymap` + `keymaps.ts` 的过滤）—— 例如 `Tab` 不在其中，所以不列。
 */
export const FIXED_SHORTCUTS: ReadonlyArray<{ spec: string; labelKey: string }> = [
  // 编辑器内建：CodeMirror 的 keymap 直接消费，不冒泡到宿主。
  { spec: 'Mod-Z', labelKey: 'cmd.undo' },
  { spec: REDO_SHORTCUT, labelKey: 'cmd.redo' },
  { spec: 'Mod-A', labelKey: 'cmd.selectAll' },
  { spec: 'Mod-/', labelKey: 'settings.keybindings.fixed.comment' },
  { spec: 'Escape', labelKey: 'settings.keybindings.fixed.escape' },
  // 剪贴板：由操作系统 / Chromium 的原生行为提供，渲染进程收不到可拦截的事件。
  { spec: 'Mod-C', labelKey: 'cmd.copy' },
  { spec: 'Mod-X', labelKey: 'cmd.cut' },
  { spec: 'Mod-V', labelKey: 'cmd.paste' }
];

let cachedOverrides: KeybindingOverrides | null = null;
let cachedTable: KeybindingTable | null = null;

/**
 * 生效绑定表。按 `overrides` 的**引用**缓存 —— `SettingsStore.get()` 在值没变时返回同一个对象，
 * 所以这张表在一次改动内只建一次。菜单与命令面板每次渲染都要查它，不缓存就是每帧建一次。
 */
export function keybindingTable(): KeybindingTable {
  const overrides = settings.get('keybindings.overrides');
  if (!cachedTable || cachedOverrides !== overrides) {
    cachedOverrides = overrides;
    cachedTable = createKeybindingTable(DEFAULT_SHORTCUTS, overrides);
  }
  return cachedTable;
}

/** 某条命令当前生效的快捷键。`undefined` = 没有绑定（从未设过，或用户取消了）。 */
export function resolveShortcut(id: string): string | undefined {
  return keybindingTable().resolve(id);
}

/** 改一条绑定。`spec` 传 `null` 表示**取消绑定**（与「恢复默认」是两件事）。 */
export function setShortcutOverride(id: string, spec: string | null): void {
  const next: Record<string, string> = { ...settings.get('keybindings.overrides') };
  if (spec === null) {
    next[id] = UNBOUND;
  } else {
    const normalized = normalizeShortcut(spec);
    // 非法串（裸键 / 只有修饰键）不写盘。控件侧已经挡了一道，这里再挡一次 —— 写进去的话
    // 表现是「绑定看着改了、按下去什么都不发生」。
    if (!normalized) return;
    next[id] = normalized;
  }
  settings.set('keybindings.overrides', next);
}

/** 恢复某一条的默认绑定：把覆盖项**删掉**，不是写成默认值 —— 默认值将来会变，写死就再也跟不上。 */
export function resetShortcutOverride(id: string): void {
  const current = settings.get('keybindings.overrides');
  if (!(id in current)) return;
  const next: Record<string, string> = { ...current };
  delete next[id];
  settings.set('keybindings.overrides', next);
}

/** 清掉全部覆盖项。 */
export function resetAllShortcutOverrides(): void {
  settings.set('keybindings.overrides', {});
}

/** 有没有任何一条被改过。设置页据此决定「重置全部」画不画。 */
export function hasShortcutOverrides(): boolean {
  return Object.keys(settings.get('keybindings.overrides')).length > 0;
}
