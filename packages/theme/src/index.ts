import { applyOverrides, seedsToTokens } from './derive.js';
import {
  DEFAULT_THEME_CHOICE,
  formatSelection,
  isAutoChoice,
  normalizeThemeChoice,
  parseSelection,
  presetNameOf,
  presetOfScheme,
  presetVariantsOf,
  resolveKnownThemeId,
  type ThemeMode
} from './resolve.js';
import {
  BUILT_IN_SCHEMES,
  nexusDarkSeeds,
  nexusLightSeeds,
  type Base16Slot,
  type NexusThemeScheme,
  type Tuning
} from './seeds.js';
import {
  isUserThemeId,
  newUserThemeId,
  userThemeVariants,
  type ThemeVariant,
  type UserTheme
} from './user-theme.js';

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
  presetNameOf,
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
  mergeUserThemes,
  newUserThemeId,
  parseUserTheme,
  parseUserThemes,
  serializeUserTheme,
  serializeUserThemes,
  userThemeBaseName,
  userThemeMergeTarget,
  userThemeName,
  userThemeVariants,
  USER_THEME_PREFIX,
  type ThemeVariant,
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
 * 内置主题的种子表：fork 用户主题时要拿**种子**，从 44 个 token 反推不回 16 色。
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
 * 浅拷：**`palette` 必须独立**。fork 出来的副本要能单独改，共享那个对象会让源主题跟着一起变
 * （`patchScheme` 是 `{ ...scheme.palette, ...patch.palette }`，新对象，所以只在 fork 这一处漏）。
 */
function cloneScheme(scheme: NexusThemeScheme): NexusThemeScheme {
  return { ...scheme, palette: { ...scheme.palette } };
}

function cloneVariants(variants: UserTheme['variants']): UserTheme['variants'] {
  return {
    ...(variants.light ? { light: cloneScheme(variants.light) } : {}),
    ...(variants.dark ? { dark: cloneScheme(variants.dark) } : {})
  };
}

/**
 * 名字是**两版共用**的（`userThemeName` 取明版优先，两边应当相等）。改名要一次改两边 ——
 * 只改当前那一版的话，切到另一边名字会跳回去。
 */
function renameVariants(variants: UserTheme['variants'], name: string): UserTheme['variants'] {
  return {
    ...(variants.light ? { light: { ...variants.light, name } } : {}),
    ...(variants.dark ? { dark: { ...variants.dark, name } } : {})
  };
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

  /**
   * 当前解析到的是用户主题的**哪一版**。落在内置主题上时是 `null`。
   *
   * 用户主题的明暗两版共用同一个 `id`（它是一条预设），所以「现在编辑的是哪一版」这件事
   * 不在 id 里，只能单独记 —— `activeScheme` / 各条写入口都要它。
   */
  private activeUserVariant: ThemeVariant | null = null;

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
    this.system = system;
    for (const theme of userThemes) this.registerUserTheme(theme);
    // 迁移必须在注册之后：`adoptChoice` 要查 `userThemes` 才知道一条裸 id 是不是用户主题。
    this.choice = this.adoptChoice(choice);
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
    return this.activeScheme?.overrides ?? NO_OVERRIDES;
  }

  /** 当前主题是否可写（只有用户主题能承载覆盖项）。 */
  get isEditable(): boolean {
    return this.userThemes.has(this.activeTheme.id);
  }

  /** 当前主题对应的用户主题；落在内置主题上时为 `null`。 */
  get activeUserTheme(): UserTheme | null {
    return this.userThemes.get(this.activeTheme.id) ?? null;
  }

  /** 用户主题的变体表。`canChangeMode` 用它 —— 内置预设走 `presetVariants`，用户主题只有运行时才知道。 */
  readonly userVariantsOf = (presetId: string): UserTheme['variants'] | null =>
    this.userThemes.get(presetId)?.variants ?? null;

  /**
   * **正在编辑**的那一版方案的种子（16 色 + 系数 + 覆盖项）。基础档编辑器要它 —— 它改的是种子，
   * 不是 44 个 token。
   *
   * 用户主题返回的是当前**变体**那一份：明暗两版各自有种子，编辑器里看到哪一版就改哪一版。
   * 内置主题返回的就是它自己的种子（`schemes` 是解析与派生的唯一输入）。
   */
  get activeScheme(): NexusThemeScheme | null {
    const user = this.activeUserTheme;
    if (!user) return this.schemes.get(this.activeTheme.id) ?? null;
    return this.activeUserVariant ? (user.variants[this.activeUserVariant] ?? null) : null;
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
    // 两版都没有的「主题」等于没有主题：登记进去只会让列表多一张空卡片。
    if (userThemeVariants(theme).length === 0) return false;
    this.userThemes.set(theme.id, theme);
    this.invalidateDerived(theme.id);
    return true;
  }

  /**
   * 用一份表**替换**整个用户主题注册表。
   *
   * 替换而不是合并：删掉一套主题之后合并会让它继续留在内存里 —— 它的 id 还能被选择引用，
   * 于是「删了却还能切回去」。存档是这份表的唯一权威。
   */
  setUserThemes(themes: readonly UserTheme[]): void {
    this.userThemes = new Map();
    for (const theme of themes) this.registerUserTheme(theme);
  }

  /**
   * 把**任意**一套主题另存成用户主题并切过去。`sourceId` 不必是当前主题 —— 「复制某一套」
   * 要的就是这个：源是那张卡片，不是现在渲染着的那套。
   *
   * 复制出来的是**完整快照**（`forkActiveToUserTheme` 与它同一条纪律）：内置配色日后改了，
   * 已经复制出来的用户主题不跟着变，否则用户改了半天回头发现底色变了。
   */
  forkSchemeToUserTheme(sourceId: string, id: string = newUserThemeId()): UserTheme | null {
    const variants = this.sourceVariantsOf(sourceId);
    if (!variants) return null;

    const forked: UserTheme = { id, variants: this.nameVariants(variants, sourceId) };
    if (!this.registerUserTheme(forked)) return null;

    // 落在**源那一版**上：用户点的是某一张卡片，落地就该是那一版。
    const wanted = this.schemes.get(sourceId)?.variant ?? userThemeVariants(forked)[0];
    const landed = wanted && forked.variants[wanted] ? wanted : userThemeVariants(forked)[0];
    this.setTheme(formatSelection({ preset: id, mode: landed ?? 'light' }));
    return forked;
  }

  /**
   * 给副本一个**两版共用**的名字。
   *
   * 不归一的话，两版会各带各的原名（`Nexus Light` / `Nexus Dark`）—— 而设置页列表读明版、
   * 编辑器读当前版，同一套主题在两处会显示两个不同的名字。
   *
   * 源是内置预设时用**族名**（`Nexus`，而不是 `Nexus Light`）：用户复制的是那张叫 Nexus 的卡片。
   * 源本身是用户主题时保持原样 —— 它的名字本来就是共用的。
   */
  private nameVariants(variants: UserTheme['variants'], sourceId: string): UserTheme['variants'] {
    if (this.userThemes.has(sourceId)) return variants;
    const owner = presetOfScheme(sourceId);
    const name = owner ? presetNameOf(owner.preset) : null;
    return name ? renameVariants(variants, name) : variants;
  }

  /**
   * 源 → 要拷进用户主题的那几版。
   *
   * 内置方案先反查它属于哪个预设，**两版一起拷** —— 「复制 Nexus」得到的该是「明暗都像 Nexus
   * 的自定义主题」，而不是一个只有浅色的半套；上游只有一版的族（dracula）自然只拷到一边。
   *
   * 源本身就是用户主题时直接拷它的变体表 —— 那是「再复制一份我的主题」。
   */
  private sourceVariantsOf(sourceId: string): UserTheme['variants'] | null {
    const existing = this.userThemes.get(sourceId);
    if (existing) return cloneVariants(existing.variants);

    const scheme = this.schemes.get(sourceId);
    if (!scheme) return null;

    const owner = presetOfScheme(sourceId);
    const table = owner ? presetVariantsOf(owner.preset) : undefined;
    if (!table) return { [scheme.variant]: cloneScheme(scheme) };

    const out: UserTheme['variants'] = {};
    for (const variant of ['light', 'dark'] as const) {
      const source = table[variant] ? this.schemes.get(table[variant]!) : undefined;
      if (source) out[variant] = cloneScheme(source);
    }
    return out.light || out.dark ? out : { [scheme.variant]: cloneScheme(scheme) };
  }

  /**
   * 把当前主题另存成用户主题（可写副本）并切过去 —— 改内置主题前的必经一步。
   * 已经在自己的用户主题上时直接返回它，不重复 fork。
   */
  forkActiveToUserTheme(id: string = newUserThemeId()): UserTheme | null {
    const existing = this.activeUserTheme;
    if (existing) return existing;
    return this.forkSchemeToUserTheme(this.activeTheme.id, id);
  }

  setTheme(choiceOrId: string): void {
    this.choice = this.adoptChoice(choiceOrId);
    this.applyResolved();
  }

  /**
   * 裸的用户主题 id 升成 `<id>@auto`。
   *
   * 旧存档里用户主题是**裸方案 id**（那时它只有一版、没有模式轴）。不升的话 `choiceWithMode`
   * 对它恒等 —— 设置页的模式卡片按下去没反应；升成 `@auto` 之后它和内置预设走同一条路，
   * 模式切换与模式锁定判定都不用特判。
   */
  private adoptChoice(raw: string): string {
    const normalized = normalizeThemeChoice(raw);
    const selection = parseSelection(normalized);
    if ('id' in selection && this.userThemes.has(selection.id)) {
      return formatSelection({ preset: selection.id, mode: 'auto' });
    }
    return normalized;
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
    const scheme = this.activeScheme;
    if (!this.activeUserTheme || !scheme) return false;
    return this.replaceActiveScheme({ ...scheme, overrides: {} });
  }

  /** 批量写覆盖项，`null` 表示删掉该项。一次重算、一次广播 —— 逐项调会广播 N 次。 */
  patchOverrides(patch: Readonly<Record<string, string | null>>): boolean {
    const scheme = this.activeScheme;
    if (!this.activeUserTheme || !scheme) return false;

    const next: Record<string, string> = { ...scheme.overrides };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    return this.replaceActiveScheme({ ...scheme, overrides: next });
  }

  /**
   * 改当前用户主题**正在编辑那一版**的名字与种子。基础档走这条路 —— 它改 16 色与系数，让派生
   * 重新跑一遍；而 `patchOverrides()` 改的是派生结果之上的 44 个 token。两条路都只对用户主题生效。
   *
   * `name` 是**空串或纯空白时一律忽略**（保留原名），不写进去：`parseUserTheme` 拒收空名，
   * 写进去的存档下次启动会被整份丢掉 —— 用户改完名字重启，主题连同覆盖项一起消失。
   * 这个判据只能放在这里：它是唯一写 name 的地方，与 `registerUserTheme` 校验 id 同一条纪律。
   *
   * 名字是**两版共用**的，改一次要写两边 —— 否则切到另一版名字会跳回去。
   */
  patchScheme(patch: {
    name?: string;
    palette?: Partial<Record<Base16Slot, string>>;
    tuning?: Partial<Tuning>;
  }): boolean {
    const theme = this.activeUserTheme;
    const scheme = this.activeScheme;
    if (!theme || !scheme) return false;

    const name = patch.name?.trim();
    const next: NexusThemeScheme = {
      ...scheme,
      ...(name ? { name } : {}),
      palette: { ...scheme.palette, ...patch.palette },
      ...(patch.tuning ? { tuning: { ...scheme.tuning, ...patch.tuning } } : {})
    };

    const variants = { ...theme.variants, [scheme.variant]: next };
    return this.commitVariants(theme, name ? renameVariants(variants, name) : variants);
  }

  /**
   * 把改过的方案写回**当前变体**那一格。只动被编辑的那一边 —— 明暗两版是各自独立的快照，
   * 它们共用的只是 id 与名字。
   */
  private replaceActiveScheme(scheme: NexusThemeScheme): boolean {
    const theme = this.activeUserTheme;
    if (!theme) return false;
    return this.commitVariants(theme, { ...theme.variants, [scheme.variant]: scheme });
  }

  private commitVariants(theme: UserTheme, variants: UserTheme['variants']): boolean {
    this.userThemes.set(theme.id, { ...theme, variants });
    this.invalidateDerived(theme.id);
    this.applyResolved();
    return true;
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
  private resolveChoice(): { theme: ThemeDefinition; userVariant: ThemeVariant | null } {
    const selection = parseSelection(this.choice);

    // 用户主题是一条**预设**：id 在 `userThemes` 里，明暗两版都在内存里。它不走
    // `resolveKnownThemeId` —— 那条路的 `isKnown` 只认内置方案 id。
    const user =
      'preset' in selection
        ? this.userThemes.get(selection.preset)
        : this.userThemes.get(selection.id);
    if (user) {
      const mode: ThemeMode = 'preset' in selection ? selection.mode : 'auto';
      const wanted: ThemeVariant =
        mode === 'auto' ? (this.system.prefersDark() ? 'dark' : 'light') : mode;
      // 单边主题（上游只有一版的族 fork 出来的）退到它有的那一边，而不是掉到别的主题。
      const variant = user.variants[wanted] ? wanted : (userThemeVariants(user)[0] ?? null);
      const scheme = variant ? user.variants[variant] : undefined;
      if (scheme) return { theme: this.definitionOfScheme(user.id, scheme), userVariant: variant };
    }

    const id = resolveKnownThemeId(this.choice, this.system.prefersDark(), (candidate) =>
      this.schemes.has(candidate)
    );
    return { theme: this.definitionFor(id) ?? nexusLight, userVariant: null };
  }

  /** 按方案 id 派生并记忆化。认不出的 id 回 `null`，回落由调用方决定。 */
  private definitionFor(id: string): ThemeDefinition | null {
    const scheme = this.schemes.get(id);
    return scheme ? this.definitionOfScheme(id, scheme) : null;
  }

  /**
   * 缓存键**带上变体**：用户主题的明暗两版共用同一个 id，只用 id 会让后解析的那版覆盖前一版
   * ——切模式时界面纹丝不动。内置方案的 id 本来就唯一，带上变体只是让它走同一条路。
   */
  private definitionOfScheme(id: string, scheme: NexusThemeScheme): ThemeDefinition {
    const key = `${id}@${scheme.variant}`;
    const cached = this.derived.get(key);
    if (cached) return cached;
    const theme = definitionOf(id, scheme);
    this.derived.set(key, theme);
    return theme;
  }

  private invalidateDerived(id: string): void {
    this.derived.delete(`${id}@light`);
    this.derived.delete(`${id}@dark`);
  }

  private applyResolved(): void {
    const { theme, userVariant } = this.resolveChoice();
    // 比 id **和** token 值：只比 id 的话，覆盖项或种子改了不广播 —— 编辑器里拖了滑块没反应。
    // 用户主题切变体时 id 也不变（明暗两版共用 id），同样靠 token 值才发得出来。
    const changed =
      this.activeTheme.id !== theme.id || !sameTokens(this.activeTheme.tokens, theme.tokens);

    this.activeTheme = theme;
    // 必须在 `notify()` 之前落定：监听者（React）一被叫醒就会读 `activeScheme`。
    this.activeUserVariant = userVariant;
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
