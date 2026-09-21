import { useState, useEffect, useCallback } from 'react';
import { themeManager, localeManager } from './platform.js';

export function useTheme() {
  const [theme, setThemeState] = useState(themeManager.theme);

  useEffect(() => {
    return themeManager.subscribe(setThemeState);
  }, []);

  const setTheme = useCallback((t: 'light' | 'dark') => themeManager.setThemeByType(t), []);
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
