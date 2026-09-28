import { normalizeThemeChoice, resolveKnownThemeId, SYSTEM_THEME } from './resolve.js';

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

export const nexusLight: ThemeDefinition = {
  id: 'nexus-light',
  name: 'Nexus Light',
  type: 'light',
  tokens: {
    'bg-canvas': '#ffffff',
    'bg-surface': '#f3f3f3',
    'bg-surface-hover': '#e8e8e8',
    'bg-surface-active': '#e0e0e0',
    'bg-quote': '#dbeafe',
    'border-subtle': '#eaeaea',
    'border-default': '#d4d4d4',
    'border-strong': '#8c8c8c',
    'text-primary': '#333333',
    'text-secondary': '#666666',
    'text-muted': '#999999',
    'accent-primary': '#007acc',
    'accent-hover': '#005c99',
    'accent-text': '#007acc',
    'accent-contrast': '#ffffff',
    'selection-bg': 'rgba(0, 122, 204, 0.2)',
    
    'syntax-heading': '#000000',
    'syntax-keyword': '#0000ff',
    'syntax-control': '#af00db',
    'syntax-module': '#af00db',
    'syntax-string': '#a31515',
    'syntax-comment': '#008000',
    'syntax-number': '#098658',
    'syntax-bool': '#0000ff',
    'syntax-function': '#795e26',
    'syntax-variable': '#001080',
    'syntax-property': '#001080',
    'syntax-type': '#267f99',
    'syntax-operator': '#000000',
    'syntax-punctuation': '#333333',
    'syntax-builtin': '#001080',
    'syntax-url': '#007acc',
    'syntax-inline-code-bg': 'rgba(27,31,35,0.05)',
    'syntax-inline-code-text': '#24292e',
    'status-success-text': '#065f46',
    'status-success-border': '#34d399',
    'status-warning-bg': '#fef3c7',
    'status-warning-text': '#92400e',
    'status-warning-border': '#fbbf24',
    'status-error-bg': '#fee2e2',
    'status-error-text': '#991b1b',
    'status-error-border': '#f87171'
  }
};

export const nexusDark: ThemeDefinition = {
  id: 'nexus-dark',
  name: 'Nexus Dark',
  type: 'dark',
  tokens: {
    'bg-canvas': '#1e1e1e',
    'bg-surface': '#252526',
    'bg-surface-hover': '#2a2d2e',
    'bg-surface-active': '#37373d',
    'bg-quote': 'rgba(30, 58, 138, 0.5)',
    'border-subtle': '#2b2b2b',
    'border-default': '#3c3c3c',
    'border-strong': '#555555',
    'text-primary': '#cccccc',
    'text-secondary': '#888888',
    'text-muted': '#666666',
    'accent-primary': '#007acc',
    'accent-hover': '#005c99',
    'accent-text': '#4daafc',
    'accent-contrast': '#ffffff',
    'selection-bg': 'rgba(0, 122, 204, 0.4)',
    
    'syntax-heading': '#ffffff',
    'syntax-keyword': '#569cd6',
    'syntax-control': '#c586c0',
    'syntax-module': '#c586c0',
    'syntax-string': '#ce9178',
    'syntax-comment': '#6a9955',
    'syntax-number': '#b5cea8',
    'syntax-bool': '#569cd6',
    'syntax-function': '#dcdcaa',
    'syntax-variable': '#9cdcfe',
    'syntax-property': '#9cdcfe',
    'syntax-type': '#4ec9b0',
    'syntax-operator': '#d4d4d4',
    'syntax-punctuation': '#d4d4d4',
    'syntax-builtin': '#4ec9b0',
    'syntax-url': '#4daafc',
    'syntax-inline-code-bg': 'rgba(240,246,252,0.15)',
    'syntax-inline-code-text': '#e1e4e8',
    'status-success-text': '#34d399',
    'status-success-border': 'rgba(5, 150, 105, 0.4)',
    'status-warning-bg': 'rgba(120, 53, 15, 0.5)',
    'status-warning-text': '#fbbf24',
    'status-warning-border': 'rgba(217, 119, 6, 0.4)',
    'status-error-bg': 'rgba(127, 29, 29, 0.5)',
    'status-error-text': '#f87171',
    'status-error-border': 'rgba(220, 38, 38, 0.4)'
  }
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

