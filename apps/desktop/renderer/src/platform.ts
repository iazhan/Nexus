import { CommandRegistry } from '@nexus/command';
import { LocaleManager } from '@nexus/i18n';
import { ThemeManager } from '@nexus/theme';

export const commandRegistry = new CommandRegistry();
export const localeManager = new LocaleManager();
export const themeManager = new ThemeManager();

// 暴露给冒烟测试与调试（与 App 里的 `window.nexusSession` 同一套接缝）
if (typeof window !== 'undefined') {
  (window as unknown as { nexusLocale?: LocaleManager }).nexusLocale = localeManager;
}

// Load initial preferences from localStorage
if (typeof localStorage !== 'undefined') {
  const savedTheme = localStorage.getItem('nexus-theme');
  if (savedTheme === 'dark' || savedTheme === 'light') {
    themeManager.setThemeByType(savedTheme);
  } else if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    themeManager.setThemeByType('dark');
  }

  const savedLocale = localStorage.getItem('nexus-locale');
  if (savedLocale === 'zh-CN' || savedLocale === 'en-US') {
    localeManager.setLocale(savedLocale);
  }
}

// Persist to localStorage on change
themeManager.subscribe((theme) => {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('nexus-theme', theme.type);
  }
});

localeManager.subscribe((locale) => {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('nexus-locale', locale);
  }
});

/**
 * Mermaid 块「点击预览即露出源码」偏好。
 *
 * 默认 **关**：进源码的默认路径是 header 上的按钮（显式动作、效果可预期）。
 * 打开后点图 = 瞥一眼源码，光标一离开就回到预览。
 *
 * 与主题/语言同一套：localStorage 持久化 + 订阅广播；编辑器包只认注入进来的
 * facet，不读 localStorage。
 */
const MERMAID_CLICK_TO_REVEAL_KEY = 'nexus-mermaid-click-to-reveal';
const mermaidPreviewListeners = new Set<(value: boolean) => void>();

let mermaidClickToReveal = false;
if (typeof localStorage !== 'undefined') {
  mermaidClickToReveal = localStorage.getItem(MERMAID_CLICK_TO_REVEAL_KEY) === 'true';
}

export const mermaidPreviewPreference = {
  get(): boolean {
    return mermaidClickToReveal;
  },
  set(value: boolean): void {
    mermaidClickToReveal = value;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MERMAID_CLICK_TO_REVEAL_KEY, String(value));
    }
    mermaidPreviewListeners.forEach((listener) => listener(value));
  },
  subscribe(listener: (value: boolean) => void): () => void {
    mermaidPreviewListeners.add(listener);
    return () => {
      mermaidPreviewListeners.delete(listener);
    };
  }
};
