/**
 * 设置存储：把四种各写一遍的偏好形状收敛成一个入口 —— 读值渲染选中态、写值、订阅变化。
 *
 * 三条硬约束：① `storageKey` 与磁盘格式**冻结**（preload 的 `theme-boot.ts` 自己读 `nexus-theme`
 * 定首帧主题，改格式会让首屏闪烁回归）；② 值是「**选择**」不是解析结果（主题存 `system` 或
 * 主题 id，`<html data-theme>` 仍是解析结果、归 `ThemeManager`）；③ `parse` 是值域的唯一权威
 * —— 读初值与写入都过它一遍，内存态与磁盘不会分裂。
 */

import {
  normalizeThemeChoice,
  parseUserTheme,
  serializeUserTheme,
  SYSTEM_THEME,
  THEME_STORAGE_KEY,
  type UserTheme
} from '@nexus/theme';

/** 一个设置项的定义。**不含 `path`** —— 表键就是它，两处各写一遍迟早对不上。 */
export interface SettingDef<T> {
  /** 磁盘键。冻结，见文件头约束 ①。 */
  readonly storageKey: string;
  /** 读不到 / 解析失败时的值。 */
  readonly fallback: T;
  /** 磁盘字符串 → 值。**值域校验与旧值迁移都在这里**。 */
  readonly parse: (raw: string | null) => T;
  /** 值 → 磁盘字符串。 */
  readonly serialize: (value: T) => string;
}

/**
 * 只做类型标注。直接用 `satisfies` 会把 `fallback` 收成字面量类型（`'system'` 而不是
 * `string`），`SettingValue` 跟着变窄，调用方传别的值就报错。
 */
function defineSetting<T>(def: SettingDef<T>): SettingDef<T> {
  return def;
}

/** 设置页默认落在哪个分组。值域归 P4-02 的 `SectionId` 校验，store 只保证「非空字符串」。 */
const DEFAULT_SECTION = 'appearance';

/**
 * 全部设置项。**加一项只改这里** —— P4-02 的 `FieldDef` 表引用这些 path，菜单投影也读它。
 * 本期只接主题（`locale` / mermaid 偏好 / 面板宽度都不迁，理由见 `docs/phase-4-plan.md` §5.1）。
 */
export const SETTING_DEFS = {
  'appearance.theme': defineSetting<string>({
    storageKey: THEME_STORAGE_KEY,
    fallback: SYSTEM_THEME,
    // 旧存档存的是主题**类型**（`dark` / `light`），`normalizeThemeChoice` 接住它。迁移必须留在
    // 这里：preload 与 renderer 共用同一份规则，各写一遍就会「先按 A 画一帧、起来再跳 B」。
    parse: normalizeThemeChoice,
    serialize: (value) => value
  }),
  // 纯新项、没有历史包袱，用它验证「非枚举、不需要迁移」的路径。
  'settings.lastSection': defineSetting<string>({
    storageKey: 'nexus-settings-section',
    fallback: DEFAULT_SECTION,
    parse: (raw) => (raw !== null && raw.trim() !== '' ? raw : DEFAULT_SECTION),
    serialize: (value) => value
  }),
  /**
   * 用户主题（含它的覆盖项）。**不给覆盖项单开一个键** —— 覆盖项是用户主题的一部分，两个键存
   * 同一份状态迟早对不上。清空时写空串而不是 `removeItem`：`set` 的落盘路径只有一条。
   */
  'appearance.userTheme': defineSetting<UserTheme | null>({
    storageKey: 'nexus-user-theme',
    fallback: null,
    // 坏 JSON / 内置 id / 槽位不全一律回落 `null`，不抛 —— 存档是用户能改的，读初值抛错会白屏。
    parse: parseUserTheme,
    serialize: (value) => (value === null ? '' : serializeUserTheme(value))
  })
};

export type SettingPath = keyof typeof SETTING_DEFS;

/** path → 值类型。`get` / `set` 靠它收窄，调用方不用手写泛型。 */
export type SettingValue<P extends SettingPath> = (typeof SETTING_DEFS)[P]['fallback'];

type Listener = () => void;

function defaultStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/** 读初值。存储不可用（隐私模式、被 CSP 禁掉）不抛错 —— 读不到就是默认值。 */
function readSetting(path: SettingPath, storage: Storage | null): unknown {
  const def = SETTING_DEFS[path];
  if (!storage) return def.fallback;
  try {
    return def.parse(storage.getItem(def.storageKey));
  } catch {
    return def.fallback;
  }
}

export class SettingsStore {
  private readonly storage: Storage | null;

  /**
   * 构造时快照。之后 store 就是权威，不再看外部对 `localStorage` 的改动 —— 单窗口应用没有
   * 外部改动，而「每次 get 都读磁盘」会让读路径带上 IO 与 try/catch。
   */
  private readonly values = new Map<SettingPath, unknown>();

  private readonly listeners = new Map<SettingPath, Set<Listener>>();

  constructor(storage: Storage | null = defaultStorage()) {
    this.storage = storage;
    for (const path of Object.keys(SETTING_DEFS) as SettingPath[]) {
      this.values.set(path, readSetting(path, storage));
    }
  }

  get<P extends SettingPath>(path: P): SettingValue<P> {
    return this.values.get(path) as SettingValue<P>;
  }

  /**
   * 写值：规范化 → 落盘 → 值变化时广播。
   *
   * 落盘取**规范化后**的结果（传 `'dark'` 进去，磁盘上留 `'nexus-dark'`），否则会出现「本次
   * 会话读到 `dark`、重启后读到 `nexus-dark`」。值没变也照样写（磁盘可能被绕过 store 改过，
   * 幂等写廉价），但**广播**只在值真变了时发。落盘失败静默：内存态已变，UI 该跟着变。
   */
  set<P extends SettingPath>(path: P, value: SettingValue<P>): void {
    const def = SETTING_DEFS[path] as SettingDef<SettingValue<P>>;
    const normalized = def.parse(def.serialize(value));
    const changed = this.values.get(path) !== normalized;
    this.values.set(path, normalized);

    if (this.storage) {
      try {
        this.storage.setItem(def.storageKey, def.serialize(normalized));
      } catch {
        // 静默：持久化不是交互的必要条件
      }
    }

    if (changed) this.notify(path);
  }

  /** 订阅某个 path。**回调不收值** —— 收到通知后自己 `get`，免得拿到的值已经过期。 */
  subscribe(path: SettingPath, listener: Listener): () => void {
    let bucket = this.listeners.get(path);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(path, bucket);
    }
    bucket.add(listener);
    return () => {
      bucket.delete(listener);
    };
  }

  private notify(path: SettingPath): void {
    const bucket = this.listeners.get(path);
    if (!bucket) return;
    // 复制再遍历：监听器里退订是常见写法，边遍历边改 Set 会漏掉后面的监听器。
    for (const listener of [...bucket]) listener();
  }
}
