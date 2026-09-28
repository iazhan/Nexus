
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

  export class ThemeManager {
    private activeTheme: ThemeDefinition = nexusLight;
    private listeners: Set<Listener> = new Set();
    
    // Available presets
    private presets: Map<string, ThemeDefinition> = new Map([
      [nexusLight.id, nexusLight],
      [nexusDark.id, nexusDark]
    ]);
  
    constructor() {
      // Apply initial theme on load
      this.applyToDOM(this.activeTheme);
    }
  
    get theme(): ThemeDefinition {
    return this.activeTheme;
  }
  
  // For backwards compatibility in short term
  get type(): 'light' | 'dark' {
    return this.activeTheme.type;
  }

  setTheme(themeId: string): void {
    const theme =
      this.presets.get(themeId) ||
      (themeId === 'dark' ? this.presets.get('nexus-dark') : themeId === 'light' ? this.presets.get('nexus-light') : undefined);
    if (!theme) return;
    
    if (this.activeTheme.id !== theme.id) {
      this.activeTheme = theme;
      this.applyToDOM(theme);
      this.notify();
    }
  }

  // Backwards compat
  setThemeByType(type: 'light' | 'dark'): void {
    this.setTheme(type === 'dark' ? 'nexus-dark' : 'nexus-light');
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
  
  private applyToDOM(theme: ThemeDefinition) {
    if (typeof window === 'undefined') return;
    
    const root = document.documentElement;
    root.style.colorScheme = theme.type;
    root.dataset.theme = theme.type;
    
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

