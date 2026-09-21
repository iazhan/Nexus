import { CommandRegistry } from '@nexus/command';
import { LocaleManager } from '@nexus/i18n';
import { ThemeManager } from '@nexus/theme';

export const commandRegistry = new CommandRegistry();
export const localeManager = new LocaleManager();
export const themeManager = new ThemeManager();

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
