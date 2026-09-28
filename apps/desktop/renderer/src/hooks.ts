import { useState, useEffect, useCallback } from 'react';
import { themeIdForType } from '@nexus/theme';
import { applyThemeChoice, localeManager, themeManager } from './platform.js';

export function useTheme() {
  const [theme, setThemeState] = useState(themeManager.theme);

  useEffect(() => {
    return themeManager.subscribe(setThemeState);
  }, []);

  // 走 `applyThemeChoice` 而不是 `themeManager.setTheme`：前者同时落盘「选择」。
  const setTheme = useCallback(
    (type: 'light' | 'dark') => applyThemeChoice(themeIdForType(type)),
    []
  );
  return { theme, setTheme };
}

export function useLocale() {
  const [locale, setLocaleState] = useState(localeManager.locale);

  useEffect(() => {
    return localeManager.subscribe(setLocaleState);
  }, []);

  const setLocale = useCallback((l: string) => localeManager.setLocale(l), []);
  const t = useCallback((key: string, vars?: Record<string, string>) => localeManager.t(key, vars), []);

  return { 
    locale, 
    setLocale,
    t
  };
}
