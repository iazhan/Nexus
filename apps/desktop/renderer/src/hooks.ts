import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import { themeIdForType } from '@nexus/theme';
import { applyThemeChoice, localeManager, settings, themeManager } from './platform.js';
import type { SettingPath, SettingValue } from './settings/store.js';

/**
 * 读一个设置项并订阅它的变化。
 *
 * **写值不走这里** —— 主题改值要同时驱动 `ThemeManager`，所以写入口是 `applyThemeChoice` 这类
 * 具名函数，而不是裸的 `settings.set`。见 `settings/registry.ts` 的 `THEME_FIELD`。
 */
export function useSettingValue<P extends SettingPath>(path: P): SettingValue<P> {
  const subscribe = useCallback(
    (listener: () => void) => settings.subscribe(path, listener),
    [path]
  );
  const getSnapshot = useCallback(() => settings.get(path), [path]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** `useSettingValue` 加一个写入口。只在「改这个值不需要驱动别的东西」时用。 */
export function useSetting<P extends SettingPath>(
  path: P
): [SettingValue<P>, (value: SettingValue<P>) => void] {
  const value = useSettingValue(path);
  const setValue = useCallback((next: SettingValue<P>) => settings.set(path, next), [path]);
  return [value, setValue];
}

export function useTheme() {
  const [resolvedTheme, setThemeState] = useState(themeManager.theme);

  useEffect(() => {
    return themeManager.subscribe(setThemeState);
  }, []);

  // `resolvedTheme` 是**解析结果**（具体某套主题），`themeChoice` 是**选择**（可能是 `system`）。
  // 设置页的选中态与菜单的勾都必须看后者：系统浅色时选「跟随系统」，解析结果不变、
  // `themeManager` 不发通知 —— 只有 store 那条订阅发得出来（见 `applyThemeChoice`）。
  // 两个名字都必须带限定词：都叫「theme」时读代码分不清拿的是哪一个。
  const themeChoice = useSettingValue('appearance.theme');

  // 走 `applyThemeChoice` 而不是 `themeManager.setTheme`：前者同时落盘「选择」。
  const setTheme = useCallback(
    (type: 'light' | 'dark') => applyThemeChoice(themeIdForType(type)),
    []
  );
  return { resolvedTheme, themeChoice, setTheme };
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
