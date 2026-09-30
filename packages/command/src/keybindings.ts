/**
 * 快捷键覆盖表：把「默认绑定」与「用户改过的绑定」分开存，解析出一个**生效表**。
 *
 * 为什么覆盖表存**差量**而不是整表：默认绑定随版本变（新增命令、调整默认值），存整表会让
 * 老存档把新版本的默认值永久钉死在旧值上 —— 用户没改过的那几十条也得跟着迁移。
 * 差量只有一个方向：默认值升级时未覆盖的项自动跟上。
 *
 * 解析规则的三条判据：
 * 1. **坏项丢掉，不拒整份**。存档是用户能改的，一条写坏的绑定不该让其余全部失效。
 * 2. **值先规范化再存**。`Shift-Mod-s` 与 `Mod-S` 是同一个组合键，但字符串不相等 ——
 *    冲突检测靠字符串相等，不规范化就判不出来。
 * 3. **空串表示「显式取消绑定」**，与「这一项没被覆盖过」是两件事。用 `null` 表达会让 JSON
 *    存档里的 `null` 与「键不存在」混在一起分不开。
 */

import { normalizeShortcut } from './shortcut.js';

/** 命令 id → 规格串。值是 `UNBOUND` 时表示用户显式取消了这条绑定。 */
export type KeybindingOverrides = Readonly<Record<string, string>>;

/** 显式取消绑定。见文件头判据 ③。 */
export const UNBOUND = '';

/** 一条生效的绑定。 */
export interface KeybindingEntry {
  id: string;
  spec: string;
}

/**
 * 磁盘字符串 → 覆盖表。`null` / 空串 / 坏 JSON / 非对象一律回空表，不抛 —— 读初值抛错会白屏。
 */
export function parseKeybindingOverrides(raw: string | null): KeybindingOverrides {
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const result: Record<string, string> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!id || typeof value !== 'string') continue;
    if (value === UNBOUND) {
      result[id] = UNBOUND;
      continue;
    }
    const normalized = normalizeShortcut(value);
    if (normalized) result[id] = normalized;
  }
  return result;
}

/**
 * 覆盖表 → 磁盘字符串。空表写空串（与 `userThemes` 同一套：`set` 的落盘路径只有一条）。
 *
 * **键排序**：两个窗口各写一次同一个逻辑表时，`JSON.stringify` 的输出会因插入顺序不同而不同，
 * 而 `SettingsStore.reload()` 判「变没变」靠的是序列化后的字符串 —— 顺序不定就会白白多广播
 * 一轮。排序把这个不确定性去掉。
 */
export function serializeKeybindingOverrides(value: KeybindingOverrides): string {
  const ids = Object.keys(value).sort();
  if (ids.length === 0) return '';
  const ordered: Record<string, string> = {};
  for (const id of ids) ordered[id] = value[id]!;
  return JSON.stringify(ordered);
}

/**
 * 生效的快捷键表。
 *
 * `resolve` 的优先级：覆盖表里有这个 id（**哪怕值是空串**）就以它为准，否则回落到默认表。
 * 「覆盖表里有」与「值是空串」必须分开判 —— 合成一句 `overrides[id] || defaults[id]` 会让
 * 「取消绑定」被默认值悄悄顶回来，用户看到的是「点了取消，键还留着」。
 */
export interface KeybindingTable {
  resolve(id: string): string | undefined;
  /** 用户改过或取消过的 id。 */
  isOverridden(id: string): boolean;
  /** 生效的全量绑定，顺序取默认表的键序（菜单与设置页要稳定顺序）。 */
  entries(): KeybindingEntry[];
  /** 与 `spec` 用同一个组合键的**其它**命令 id。`spec` 非法时返回空数组。 */
  conflicts(spec: string, exceptId?: string): string[];
}

export function createKeybindingTable(
  defaults: Readonly<Record<string, string>>,
  overrides: KeybindingOverrides
): KeybindingTable {
  const resolve = (id: string): string | undefined => {
    const override = overrides[id];
    if (override !== undefined) return override === UNBOUND ? undefined : override;
    return defaults[id];
  };

  const entries = (): KeybindingEntry[] => {
    const ids = new Set([...Object.keys(defaults), ...Object.keys(overrides)]);
    const result: KeybindingEntry[] = [];
    for (const id of ids) {
      const spec = resolve(id);
      if (spec) result.push({ id, spec });
    }
    return result;
  };

  const conflicts = (spec: string, exceptId?: string): string[] => {
    const normalized = normalizeShortcut(spec);
    if (!normalized) return [];
    return entries()
      .filter((entry) => entry.id !== exceptId && normalizeShortcut(entry.spec) === normalized)
      .map((entry) => entry.id);
  };

  return {
    resolve,
    isOverridden: (id) => overrides[id] !== undefined,
    entries,
    conflicts
  };
}
