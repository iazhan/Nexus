import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import { canChangeMode, choiceWithMode, type ThemeMode } from '@nexus/theme';
import { applyThemeChoice, localeManager, settings, themeManager } from './platform.js';
import type { SettingPath, SettingValue } from './settings/store.js';

/**
 * 读一个设置项并订阅它的变化。
 *
 * **写值不走这里** —— 主题改值要同时驱动 `ThemeManager`，所以写入口是 `applyThemeChoice` 这类
 * 具名函数，而不是裸的 `settings.set`。见 `settings/registry.ts` 的两个主题字段。
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

  // `resolvedTheme` 是**解析结果**（具体某套主题），`themeChoice` 是**选择**（`<预设>@<模式>`
  // 或裸方案 id）。设置页的选中态与菜单的勾都必须看后者：自动模式下系统偏好变了、解析结果跟着
  // 变，但「选了自动」这件事没变 —— 只有 store 那条订阅发得出来（见 `applyThemeChoice`）。
  // 两个名字都必须带限定词：都叫「theme」时读代码分不清拿的是哪一个。
  const themeChoice = useSettingValue('appearance.theme');

  // 走 `applyThemeChoice` 而不是 `themeManager.setTheme`：前者同时落盘「选择」。
  // 参数是**模式**（浅色 / 自动 / 深色），预设由 `choiceWithMode` 从当前选择里带过来。
  const setTheme = useCallback(
    (mode: ThemeMode) => applyThemeChoice(choiceWithMode(settings.get('appearance.theme'), mode)),
    []
  );

  // 用户主题的两版都在 `ThemeManager` 里（不在静态预设表里），所以要把查询注入进去 ——
  // 单边主题（如从 dracula fork 出来的）没有另一边可切，控件据此禁用。
  const modeSwitchable = canChangeMode(themeChoice, themeManager.userVariantsOf);

  return { resolvedTheme, themeChoice, setTheme, modeSwitchable };
}

export function useLocale() {
  const [locale, setLocaleState] = useState(localeManager.locale);

  useEffect(() => {
    return localeManager.subscribe(setLocaleState);
  }, []);

  const setLocale = useCallback((l: string) => localeManager.setLocale(l), []);
  const t = useCallback((key: string, vars?: Record<string, string>) => localeManager.t(key, vars), []);
  // 「这个键有译文吗」。缺键时 `t()` 会把键名原样返回，可选文案要靠它决定画不画。
  // 不把 `locale` 放进依赖：`t` / `has` 都在调用时读当前语言，而组件本来就因语言变化重渲染。
  const has = useCallback((key: string) => localeManager.has(key), []);

  return { 
    locale, 
    setLocale,
    t,
    has
  };
}
