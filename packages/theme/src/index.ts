import { seedsToTokens } from './derive.js';
import { normalizeThemeChoice, resolveKnownThemeId, SYSTEM_THEME } from './resolve.js';
import { nexusDarkSeeds, nexusLightSeeds } from './seeds.js';

export {
  normalizeThemeChoice,
  resolveKnownThemeId,
  resolveThemeId,
  SYSTEM_DEFAULTS,
  SYSTEM_THEME,
  THEME_STORAGE_KEY,
  themeIdForType
} from './resolve.js';
export { themesToCss } from './static-css.js';

export interface ThemeDefinition {
  id: string;
  name: string;
  type: 'light' | 'dark';
  tokens: Record<string, string>;
}

/**
 * 内置主题的 token 全部由 16 色种子派生（`seedsToTokens()`）—— 改配色只改 `seeds.ts`。
 * 不要在这里写死值：手写值与派生值会漂移，而漂移只有肉眼能发现。
 *
 * `name` / `type` 也从种子取：`type` 与 `variant` 不一致会让派生方向反转（灰阶反了），
 * 两处各写一遍迟早对不上。
 */
export const nexusLight: ThemeDefinition = {
  id: 'nexus-light',
  name: nexusLightSeeds.name,
  type: nexusLightSeeds.variant,
  tokens: seedsToTokens(nexusLightSeeds)
};

export const nexusDark: ThemeDefinition = {
  id: 'nexus-dark',
  name: nexusDarkSeeds.name,
  type: nexusDarkSeeds.variant,
  tokens: seedsToTokens(nexusDarkSeeds)
};

type Listener = (theme: ThemeDefinition) => void;

/** 内置主题。静态 CSS 生成器与 `ThemeManager` 的 presets 都读它 —— 两处各列一遍必然漂移。 */
export const BUILT_IN_THEMES: readonly ThemeDefinition[] = [nexusLight, nexusDark];

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

  private presets: Map<string, ThemeDefinition> = new Map(
    BUILT_IN_THEMES.map((theme): [string, ThemeDefinition] => [theme.id, theme])
  );

  // 存档里该存的值：`system` 或主题 id。与 `activeTheme.id` 不同 —— 后者是解析结果。
  private choice: string;

  private readonly system: SystemThemeSource;

  /**
   * 选择由构造参数传入，而不是构造完再 `setTheme()`：preload 已经按同一个规则写过 `data-theme`
   * （见 `preload/theme-boot.ts`），这里若先落一个默认主题再改，就多出一次 DOM 写入 ——
   * 只要这两次落在不同任务里就会闪一帧。一次解析到位，两边得到同一个值。
   */
  constructor(choice: string = SYSTEM_THEME, system: SystemThemeSource = matchMediaSystemTheme) {
    this.choice = normalizeThemeChoice(choice);
    this.system = system;
    this.applyResolved();
    // 跟随系统时系统偏好一变就要重解析。监听常驻（只在选择是 system 时生效）——
    // 装上再拆会引入「什么时候装」的第二个状态。
    system.subscribe(() => {
      if (this.choice === SYSTEM_THEME) this.applyResolved();
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

  setTheme(choiceOrId: string): void {
    this.choice = normalizeThemeChoice(choiceOrId);
    this.applyResolved();
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
   * 认不出的 id 显式回落成「跟随系统」，而不是静默保持原主题 —— 静默会让用户以为主题没保存。
   * `choice` 本身不动：主题文件回来了就自动恢复。回落规则与 preload 共用（`resolveKnownThemeId`），
   * 否则 preload 会写一个 renderer 不认的 id，静态 CSS 匹配不上，先按基线画一帧再跳。
   */
  private resolveChoice(): ThemeDefinition {
    const id = resolveKnownThemeId(this.choice, this.system.prefersDark(), (candidate) =>
      this.presets.has(candidate)
    );
    return this.presets.get(id) ?? nexusLight;
  }

  private applyResolved(): void {
    const theme = this.resolveChoice();
    const changed = this.activeTheme.id !== theme.id;

    this.activeTheme = theme;
    this.applyToDOM(theme);
    if (changed) this.notify();
  }

  private applyToDOM(theme: ThemeDefinition) {
    if (typeof window === 'undefined') return;

    const root = document.documentElement;
    // `data-theme` 取主题 **id** 而不是 type：它要能区分 5 套内置主题与用户主题。
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

  public overrideToken(key: string, value: string) {
    if (typeof window === 'undefined') return;
    document.documentElement.style.setProperty('--nexus-' + key, value);
  }
}

