import { applyOverrides, seedsToTokens } from './derive.js';
import {
  DEFAULT_THEME_CHOICE,
  isAutoChoice,
  normalizeThemeChoice,
  resolveKnownThemeId
} from './resolve.js';
import {
  BUILT_IN_SCHEMES,
  nexusDarkSeeds,
  nexusLightSeeds,
  type Base16Slot,
  type NexusThemeScheme,
  type Tuning
} from './seeds.js';
import { isUserThemeId, newUserThemeId, type UserTheme } from './user-theme.js';

export {
  canChangeMode,
  choiceWithMode,
  DEFAULT_PRESET,
  DEFAULT_THEME_CHOICE,
  formatSelection,
  isAutoChoice,
  isThemeMode,
  normalizeThemeChoice,
  parseSelection,
  presetOfScheme,
  presetVariantsOf,
  resolveKnownThemeId,
  resolveThemeId,
  SYSTEM_DEFAULTS,
  SYSTEM_THEME,
  THEME_MODES,
  THEME_STORAGE_KEY,
  type ThemeMode,
  type ThemeSelection
} from './resolve.js';
export { themesToCss } from './static-css.js';
export {
  base16Slug,
  inferVariant,
  parseBase16,
  serializeBase16,
  type Base16Error,
  type Base16Format,
  type Base16ParseResult,
  type Base16Scheme
} from './base16.js';
export {
  applyOverrides,
  defaultTuning,
  seedsToTokens,
  seedsToTokensWithReport,
  type Correction,
  type DeriveReport
} from './derive.js';
export { measureTheme, type ContrastFailure, type ContrastReport } from './contrast.js';
export {
  BASE16_SLOTS,
  BUILT_IN_PRESETS,
  BUILT_IN_SCHEMES,
  type Base16Slot,
  type BuiltInPreset,
  type NexusThemeScheme,
  type Tuning
} from './seeds.js';
export {
  isUserThemeId,
  newUserThemeId,
  parseUserTheme,
  serializeUserTheme,
  USER_THEME_PREFIX,
  type UserTheme
} from './user-theme.js';

export interface ThemeDefinition {
  id: string;
  name: string;
  type: 'light' | 'dark';
  tokens: Record<string, string>;
}

/**
 * 种子 + 覆盖项 → 主题定义。**这是唯一的合成点** —— 内置主题与用户主题走同一条路，两处各写
 * 一遍「派生 + 盖覆盖」迟早漂移。
 *
 * `name` / `type` 也从种子取：`type` 与 `variant` 不一致会让派生方向反转（灰阶反了）。
 */
export function definitionOf(id: string, scheme: NexusThemeScheme): ThemeDefinition {
  return {
    id,
    name: scheme.name,
    type: scheme.variant,
    tokens: applyOverrides(seedsToTokens(scheme), scheme.overrides)
  };
}

/**
 * 内置主题的种子表：fork 用户主题时要拿**种子**，从 43 个 token 反推不回 16 色。
 *
 * **惰性**：这张表引用 `BUILT_IN_SCHEMES`（一百多套 × 16 个色值）。急切建表会让任何一个
 * 引到本模块的消费者都被迫带上那份调色板 —— preload 只需要 `resolve.ts` 那点逻辑，却因此
 * 从 ~23KB 涨到 ~97KB（2026-09-29 实测）。惰性之后 rollup 能把它整块摇掉。
 */
let builtInSchemes: ReadonlyMap<string, NexusThemeScheme> | null = null;

function builtInSchemeMap(): ReadonlyMap<string, NexusThemeScheme> {
  builtInSchemes ??= new Map(
    BUILT_IN_SCHEMES.map((entry): [string, NexusThemeScheme] => [entry.id, entry.scheme])
  );
  return builtInSchemes;
}

/** 内置主题。静态 CSS 生成器与 `ThemeManager` 的 presets 都读它。 */
let derivedBuiltIns: readonly ThemeDefinition[] | null = null;

/**
 * 出厂主题的派生结果，**惰性记忆化**。
 *
 * 一百多套急切派生实测 74ms（单套 0.70ms），而首帧颜色由构建期生成的 `theme.css` 提供、
 * 不走这里 —— 启动路径上没有理由把没被选中的那 100 多套先算一遍。返回的是同一份数组，不要改。
 */
export function builtInThemes(): readonly ThemeDefinition[] {
  derivedBuiltIns ??= BUILT_IN_SCHEMES.map((entry) => definitionOf(entry.id, entry.scheme));
  return derivedBuiltIns;
}

/** 具名出口：`dump-themes.mjs` 与测试按名字读。直接从种子算，不依赖上面那份全量表。 */
export const nexusLight: ThemeDefinition = definitionOf('nexus-light', nexusLightSeeds);
export const nexusDark: ThemeDefinition = definitionOf('nexus-dark', nexusDarkSeeds);

type Listener = (theme: ThemeDefinition) => void;

const NO_OVERRIDES: Readonly<Record<string, string>> = {};

/**
 * 逐值比两套 token。**不能用对象引用比** —— `definitionOf()` 每次重算都造新对象，值没变也会
 * 判成「变了」；而只比 `theme.id` 又会漏掉「id 不变但种子/覆盖项改了」这一整类。
 */
function sameTokens(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

/**
 * 「跟随系统」要读的两个能力。默认实现走 `matchMedia`，测试注入假实现 —— 否则为了造一次
 * 系统偏好变化得去改全局。
 */
export interface SystemThemeSource {
  prefersDark(): boolean;
  /** 系统偏好变化时回调；返回取消订阅。 */
  subscribe(listener: () => void): () => void;
}

const matchMediaSystemTheme: SystemThemeSource = {
  prefersDark: () =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  subscribe: (listener) => {
    if (typeof window === 'undefined') return () => {};
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }
};

export class ThemeManager {
  private activeTheme: ThemeDefinition = nexusLight;
  private listeners: Set<Listener> = new Set();

  private readonly schemes: Map<string, NexusThemeScheme> = new Map(builtInSchemeMap());

  /**
   * 派生结果按 id 记忆化。**改种子或覆盖项时必须删掉对应项**，否则界面改了没反应 ——
   * 这也是它不能和 `schemes` 合成一个 Map 的原因（那份存的是输入，这份存的是输出）。
   */
  private readonly derived = new Map<string, ThemeDefinition>();

  private userThemes: Map<string, UserTheme> = new Map();

  // 存档里该存的值：`<预设>@<模式>`，或一条裸方案 id。与 `activeTheme.id` 不同 —— 后者是解析结果。
  private choice: string;

  private readonly system: SystemThemeSource;

  /**
   * 选择与已持久化的用户主题都由构造参数传入，而不是构造完再 `setTheme()` / `registerUserTheme()`：
   * preload 已经按同一个规则写过 `data-theme`（见 `preload/theme-boot.ts`），这里若先落一个默认
   * 主题再改，就多出一次 DOM 写入 —— 只要这两次落在不同任务里就会闪一帧。
   */
  constructor(
    choice: string = DEFAULT_THEME_CHOICE,
    system: SystemThemeSource = matchMediaSystemTheme,
    userThemes: readonly UserTheme[] = []
  ) {
    this.choice = normalizeThemeChoice(choice);
    this.system = system;
    for (const theme of userThemes) this.registerUserTheme(theme);
    this.applyResolved();
    // 模式是「自动」时系统偏好一变就要重解析。监听常驻（只在自动模式下生效）——
    // 装上再拆会引入「什么时候装」的第二个状态。
    system.subscribe(() => {
      if (isAutoChoice(this.choice)) this.applyResolved();
    });
  }

  get theme(): ThemeDefinition {
    return this.activeTheme;
  }

  /** 存档里该存的值。`theme.id` 是解析结果，不能拿它回写存档。 */
  get themeChoice(): string {
    return this.choice;
  }

  // 短期内的向后兼容
  get type(): 'light' | 'dark' {
    return this.activeTheme.type;
  }

  /** 当前主题的覆盖项。内置主题恒为空 —— 它们不可写，见 `overrideToken()`。 */
  get overrides(): Readonly<Record<string, string>> {
    return this.userThemes.get(this.activeTheme.id)?.scheme.overrides ?? NO_OVERRIDES;
  }

  /** 当前主题是否可写（只有用户主题能承载覆盖项）。 */
  get isEditable(): boolean {
    return this.userThemes.has(this.activeTheme.id);
  }

  /** 当前主题对应的用户主题；落在内置主题上时为 `null`。 */
  get activeUserTheme(): UserTheme | null {
    return this.userThemes.get(this.activeTheme.id) ?? null;
  }

  /**
   * 当前主题的种子（16 色 + 系数）。基础档编辑器要它 —— 它改的是种子，不是 43 个 token。
   *
   * `schemes` 是解析与派生的**唯一输入**（`derived` 只是它的缓存），所以解析出的 id 一定在
   * `schemes` 里；返回 `null` 只可能是两处不同步的 bug。
   */
  get activeScheme(): NexusThemeScheme | null {
    return this.schemes.get(this.activeTheme.id) ?? null;
  }

  /**
   * 登记一个用户主题。**id 不是 `user:` 前缀的一律拒绝**：内置 id 被写成用户主题的话，
   * 「切回 Nexus Light」得到的是改过的 Nexus Light，用户没有退路。
   *
   * 不切主题、不广播 —— 调用方拿到 `true` 后自己 `setTheme()`。注册与选择是两件事，
   * 合成一件会让「导入后先注册再问用户要不要切」这种流程做不出来。
   */
  registerUserTheme(theme: UserTheme): boolean {
    if (!isUserThemeId(theme.id)) return false;
    this.userThemes.set(theme.id, theme);
    this.schemes.set(theme.id, theme.scheme);
    this.derived.delete(theme.id);
    return true;
  }

  /**
   * 把当前主题另存成用户主题（可写副本）并切过去 —— 改内置主题前的必经一步。
   * 已经在自己的用户主题上时直接返回它，不重复 fork。
   */
  forkActiveToUserTheme(id: string = newUserThemeId()): UserTheme | null {
    const existing = this.activeUserTheme;
    if (existing) return existing;

    const scheme = this.schemes.get(this.activeTheme.id);
    if (!scheme) return null;

    // 浅拷 palette：fork 出来的副本要能独立改，共享对象会让两个主题一起变。
    const forked: UserTheme = { id, scheme: { ...scheme, palette: { ...scheme.palette } } };
    if (!this.registerUserTheme(forked)) return null;
    this.setTheme(id);
    return forked;
  }

  setTheme(choiceOrId: string): void {
    this.choice = normalizeThemeChoice(choiceOrId);
    this.applyResolved();
  }

  /**
   * 写一个覆盖项。**只对用户主题生效** —— 落在内置主题上返回 `false`，调用方先
   * `forkActiveToUserTheme()`。覆盖项不参与对比度修正：用户要的就是这个值。
   */
  overrideToken(key: string, value: string): boolean {
    return this.patchOverrides({ [key]: value });
  }

  /** 删掉一个覆盖项。`null` 与「不存在」等价 —— 删不存在的项返回 `true`，无操作可做。 */
  clearOverride(key: string): boolean {
    return this.patchOverrides({ [key]: null });
  }

  clearAllOverrides(): boolean {
    const current = this.activeUserTheme;
    if (!current) return false;
    return this.writeOverrides(current, {});
  }

  /** 批量写覆盖项，`null` 表示删掉该项。一次重算、一次广播 —— 逐项调会广播 N 次。 */
  patchOverrides(patch: Readonly<Record<string, string | null>>): boolean {
    const current = this.activeUserTheme;
    if (!current) return false;

    const next: Record<string, string> = { ...current.scheme.overrides };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    return this.writeOverrides(current, next);
  }

  /**
   * 改当前用户主题的**种子**。基础档走这条路 —— 它改 16 色与系数，让派生重新跑一遍；而
   * `patchOverrides()` 改的是派生结果之上的 43 个 token。两条路都只对用户主题生效。
   */
  patchScheme(patch: {
    palette?: Partial<Record<Base16Slot, string>>;
    tuning?: Partial<Tuning>;
  }): boolean {
    const current = this.activeUserTheme;
    if (!current) return false;

    const scheme: NexusThemeScheme = {
      ...current.scheme,
      palette: { ...current.scheme.palette, ...patch.palette },
      ...(patch.tuning ? { tuning: { ...current.scheme.tuning, ...patch.tuning } } : {})
    };
    return this.replaceScheme(current, scheme);
  }

  private replaceScheme(theme: UserTheme, scheme: NexusThemeScheme): boolean {
    const updated: UserTheme = { ...theme, scheme };
    this.userThemes.set(updated.id, updated);
    this.schemes.set(updated.id, scheme);
    this.derived.delete(updated.id);
    this.applyResolved();
    return true;
  }

  private writeOverrides(theme: UserTheme, overrides: Record<string, string>): boolean {
    return this.replaceScheme(theme, { ...theme.scheme, overrides });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.activeTheme);
    }
  }

  /**
   * 认不出的 id 显式回落成默认预设（按系统偏好取一边），而不是静默保持原主题 —— 静默会让用户
   * 以为主题没保存。`choice` 本身不动：主题文件回来了就自动恢复。回落规则与 preload 共用
   * （`resolveKnownThemeId`），否则 preload 会写一个 renderer 不认的 id，静态 CSS 匹配不上，
   * 先按基线画一帧再跳。
   */
  private resolveChoice(): ThemeDefinition {
    const id = resolveKnownThemeId(this.choice, this.system.prefersDark(), (candidate) =>
      this.schemes.has(candidate)
    );
    return this.definitionFor(id) ?? nexusLight;
  }

  /** 按 id 派生并记忆化。认不出的 id 回 `null`，回落由调用方决定。 */
  private definitionFor(id: string): ThemeDefinition | null {
    const cached = this.derived.get(id);
    if (cached) return cached;
    const scheme = this.schemes.get(id);
    if (!scheme) return null;
    const theme = definitionOf(id, scheme);
    this.derived.set(id, theme);
    return theme;
  }

  private applyResolved(): void {
    const theme = this.resolveChoice();
    // 比 id **和** token 值：只比 id 的话，覆盖项或种子改了不广播 —— 编辑器里拖了滑块没反应。
    const changed =
      this.activeTheme.id !== theme.id || !sameTokens(this.activeTheme.tokens, theme.tokens);

    this.activeTheme = theme;
    this.applyToDOM(theme);
    if (changed) this.notify();
  }

  private applyToDOM(theme: ThemeDefinition) {
    if (typeof window === 'undefined') return;

    const root = document.documentElement;
    // `data-theme` 取主题 **id** 而不是 type：它要能区分多套内置主题与用户主题。
    // `colorScheme` 仍取 type —— 它只控制原生滚动条 / 表单控件的配色，是个二值。
    root.style.colorScheme = theme.type;
    root.dataset.theme = theme.id;

    let cssText = ':root {\n';
    for (const [key, value] of Object.entries(theme.tokens)) {
      cssText += '  --nexus-' + key + ': ' + value + ';\n';
    }
    cssText += '}\n';

    let styleEl = document.getElementById('nexus-theme-vars');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'nexus-theme-vars';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = cssText;
  }
}
