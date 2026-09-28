import { describe, it, expect, vi } from 'vitest';
import { ThemeManager, SYSTEM_THEME, type SystemThemeSource } from '../src/index.js';
import { resolveThemeId } from '../src/resolve.js';

/** 假的系统偏好源：测试要造「系统偏好变化」，不该去改全局。 */
function fakeSystem(initialDark: boolean) {
  let prefersDark = initialDark;
  const listeners = new Set<() => void>();
  const source: SystemThemeSource = {
    prefersDark: () => prefersDark,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
  return {
    source,
    setDark(value: boolean): void {
      prefersDark = value;
      listeners.forEach((listener) => listener());
    }
  };
}

const managerWith = (system: ReturnType<typeof fakeSystem>, choice: string = SYSTEM_THEME): ThemeManager =>
  new ThemeManager(choice, system.source);

describe('ThemeManager', () => {
  it('initializes with light theme by default', () => {
    const manager = managerWith(fakeSystem(false));
    expect(manager.type).toBe('light');
    expect(manager.theme.id).toBe('nexus-light');
  });

  it('allows changing theme to dark', () => {
    const manager = managerWith(fakeSystem(false));
    manager.setTheme('dark');
    expect(manager.type).toBe('dark');
    expect(manager.theme.id).toBe('nexus-dark');
  });

  it('notifies subscribers when theme changes', () => {
    const manager = managerWith(fakeSystem(false));
    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);

    manager.setTheme('dark');
    expect(listener).toHaveBeenCalledWith(manager.theme);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    manager.setTheme('light');
    expect(listener).toHaveBeenCalledTimes(1); // Should not be called again
  });

  it('does not notify if theme is unchanged', () => {
    const manager = managerWith(fakeSystem(false));
    const listener = vi.fn();
    manager.subscribe(listener);

    manager.setTheme('light'); // default is already light
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('ThemeManager 的「跟随系统」', () => {
  it('构造时就按系统偏好解析到位 —— 不等外部再调一次 setTheme', () => {
    const dark = managerWith(fakeSystem(true));
    expect(dark.theme.id).toBe('nexus-dark');
    expect(dark.themeChoice).toBe(SYSTEM_THEME);

    const light = managerWith(fakeSystem(false));
    expect(light.theme.id).toBe('nexus-light');
  });

  it('构造时传入具体主题则直接用它，与系统偏好无关', () => {
    const manager = managerWith(fakeSystem(true), 'nexus-light');
    expect(manager.theme.id).toBe('nexus-light');
    expect(manager.themeChoice).toBe('nexus-light');
  });

  it('跟随系统时系统偏好一变就跟着换', () => {
    const system = fakeSystem(false);
    const manager = managerWith(system);
    const listener = vi.fn();
    manager.subscribe(listener);

    expect(manager.theme.id).toBe('nexus-light');

    system.setDark(true);
    expect(manager.theme.id).toBe('nexus-dark');
    expect(manager.themeChoice).toBe(SYSTEM_THEME);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('手选具体主题后系统偏好变化必须被忽略', () => {
    const system = fakeSystem(false);
    const manager = managerWith(system, 'nexus-dark');

    system.setDark(false);
    expect(manager.theme.id).toBe('nexus-dark');
    expect(manager.themeChoice).toBe('nexus-dark');
  });

  it('认不出的 id 显式回落成「跟随系统」，但选择本身不改', () => {
    const manager = managerWith(fakeSystem(true), 'dracula');

    expect(manager.theme.id).toBe('nexus-dark');
    expect(manager.themeChoice).toBe('dracula');
  });

  it('落盘用的是选择 —— 旧值要先归一成 id', () => {
    const manager = managerWith(fakeSystem(false));

    manager.setTheme('dark');
    expect(manager.themeChoice).toBe('nexus-dark');
  });

  it('与 resolveThemeId 对旧值的解读一致 —— 两处映射漂移会让迁移半途而废', () => {
    for (const legacy of ['dark', 'light']) {
      const manager = managerWith(fakeSystem(false));
      manager.setTheme(legacy);
      expect(manager.theme.id).toBe(resolveThemeId(legacy, false));
    }
  });
});
