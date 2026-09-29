import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_THEME_CHOICE,
  ThemeManager,
  nexusDark,
  nexusLight,
  type SystemThemeSource,
  type UserTheme
} from '../src/index.js';
import { resolveThemeId } from '../src/resolve.js';
import { nexusDarkSeeds, nexusLightSeeds, type NexusThemeScheme } from '../src/seeds.js';

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

const managerWith = (
  system: ReturnType<typeof fakeSystem>,
  choice: string = DEFAULT_THEME_CHOICE
): ThemeManager => new ThemeManager(choice, system.source);

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

describe('ThemeManager 的自动模式', () => {
  it('构造时就按系统偏好解析到位 —— 不等外部再调一次 setTheme', () => {
    const dark = managerWith(fakeSystem(true));
    expect(dark.theme.id).toBe('nexus-dark');
    expect(dark.themeChoice).toBe(DEFAULT_THEME_CHOICE);

    const light = managerWith(fakeSystem(false));
    expect(light.theme.id).toBe('nexus-light');
  });

  it('构造时传入显式模式则直接用它，与系统偏好无关', () => {
    const manager = managerWith(fakeSystem(true), 'nexus@light');
    expect(manager.theme.id).toBe('nexus-light');
    expect(manager.themeChoice).toBe('nexus@light');
  });

  it('自动模式下系统偏好一变就跟着换', () => {
    const system = fakeSystem(false);
    const manager = managerWith(system);
    const listener = vi.fn();
    manager.subscribe(listener);

    expect(manager.theme.id).toBe('nexus-light');

    system.setDark(true);
    expect(manager.theme.id).toBe('nexus-dark');
    expect(manager.themeChoice).toBe(DEFAULT_THEME_CHOICE);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('显式模式与裸方案 id 都忽略系统偏好变化', () => {
    const system = fakeSystem(false);
    const manager = managerWith(system, 'nexus@dark');

    system.setDark(false);
    expect(manager.theme.id).toBe('nexus-dark');
    expect(manager.themeChoice).toBe('nexus@dark');

    const user = managerWith(system, 'user:a');
    system.setDark(true);
    expect(user.themeChoice).toBe('user:a');
  });

  it('认不出的 id 显式回落成默认预设，但选择本身不改', () => {
    const manager = managerWith(fakeSystem(true), 'nope');

    expect(manager.theme.id).toBe('nexus-dark');
    expect(manager.themeChoice).toBe('nope');
  });

  it('落盘用的是选择 —— 旧值要先归一成新格式', () => {
    const manager = managerWith(fakeSystem(false));

    manager.setTheme('dark');
    expect(manager.themeChoice).toBe('nexus@dark');

    manager.setTheme('dracula');
    expect(manager.themeChoice).toBe('dracula@dark');
  });

  it('与 resolveThemeId 对旧值的解读一致 —— 两处映射漂移会让迁移半途而废', () => {
    for (const legacy of ['dark', 'light', 'dracula', 'nord']) {
      const manager = managerWith(fakeSystem(false));
      manager.setTheme(legacy);
      expect(manager.theme.id).toBe(resolveThemeId(legacy, false));
    }
  });
});

const clone = (scheme: NexusThemeScheme): NexusThemeScheme => ({
  ...scheme,
  palette: { ...scheme.palette },
});

const userTheme = (id: string, overrides?: Record<string, string>): UserTheme => ({
  id,
  scheme: { ...clone(nexusDarkSeeds), ...(overrides ? { overrides } : {}) },
});

/** 已 fork 出 `user:a` 的 manager，覆盖项为空。 */
const forked = (choice = 'nexus-light'): ThemeManager => {
  const manager = managerWith(fakeSystem(false), choice);
  manager.forkActiveToUserTheme('user:a');
  return manager;
};

describe('ThemeManager 的用户主题与覆盖项', () => {
  it('内置主题上写覆盖项被拒 —— 改内置主题必须先 fork', () => {
    const manager = managerWith(fakeSystem(false), 'nexus-light');

    expect(manager.isEditable).toBe(false);
    expect(manager.activeUserTheme).toBeNull();
    expect(manager.overrides).toEqual({});
    expect(manager.overrideToken('bg-canvas', '#101010')).toBe(false);
    expect(manager.theme.tokens['bg-canvas']).toBe(nexusLight.tokens['bg-canvas']);
  });

  it('拒绝把内置 id 登记成用户主题 —— 否则切回去得到的是改过的 Nexus Light', () => {
    const manager = managerWith(fakeSystem(false));
    expect(manager.registerUserTheme({ id: 'nexus-light', scheme: clone(nexusLightSeeds) })).toBe(false);
    expect(manager.registerUserTheme({ id: 'user:', scheme: clone(nexusLightSeeds) })).toBe(false);
  });

  it('fork 出可写副本并切过去，副本的种子与基底一致', () => {
    const manager = managerWith(fakeSystem(false), 'nexus-dark');
    const theme = manager.forkActiveToUserTheme('user:a');

    expect(theme?.id).toBe('user:a');
    expect(theme?.scheme.palette).toEqual(nexusDarkSeeds.palette);
    expect(manager.theme.id).toBe('user:a');
    expect(manager.isEditable).toBe(true);
    expect(manager.theme.tokens).toEqual(nexusDark.tokens);
  });

  it('已经在自己的用户主题上时 fork 返回它本身，不新建', () => {
    const manager = forked();
    const second = manager.forkActiveToUserTheme('user:b');

    expect(second?.id).toBe('user:a');
    expect(manager.theme.id).toBe('user:a');
  });

  it('写覆盖项后 token 立刻变，且广播一次', () => {
    const manager = forked();
    const listener = vi.fn();
    manager.subscribe(listener);

    expect(manager.overrideToken('bg-canvas', '#101010')).toBe(true);

    expect(manager.theme.tokens['bg-canvas']).toBe('#101010');
    expect(manager.overrides).toEqual({ 'bg-canvas': '#101010' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  /**
   * `changed` 判据只比主题 id 的话这条会红 —— 覆盖项变化时 id 不变，订阅者收不到通知，
   * 滑块拖了没反应。见 `applyResolved()`。
   */
  it('只改覆盖项、主题 id 不变时也要广播', () => {
    const manager = forked();
    const listener = vi.fn();
    manager.subscribe(listener);

    manager.overrideToken('bg-canvas', '#101010');

    expect(manager.theme.id).toBe('user:a');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('覆盖项值没变时不广播', () => {
    const manager = forked();
    manager.overrideToken('bg-canvas', '#101010');

    const listener = vi.fn();
    manager.subscribe(listener);
    manager.overrideToken('bg-canvas', '#101010');

    expect(listener).not.toHaveBeenCalled();
  });

  it('一次 patch 多项只广播一次', () => {
    const manager = forked();
    const listener = vi.fn();
    manager.subscribe(listener);

    manager.patchOverrides({ 'bg-canvas': '#101010', 'bg-surface': '#202020' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(manager.overrides).toEqual({ 'bg-canvas': '#101010', 'bg-surface': '#202020' });
  });

  it('清掉覆盖项后回到派生值', () => {
    const manager = forked();
    const derived = manager.theme.tokens['bg-canvas'];
    manager.overrideToken('bg-canvas', '#101010');

    expect(manager.clearOverride('bg-canvas')).toBe(true);
    expect(manager.theme.tokens['bg-canvas']).toBe(derived);
    expect(manager.overrides).toEqual({});
  });

  it('clearAllOverrides 一次清空', () => {
    const manager = forked();
    manager.patchOverrides({ 'bg-canvas': '#101010', 'bg-surface': '#202020' });

    expect(manager.clearAllOverrides()).toBe(true);
    expect(manager.overrides).toEqual({});
  });

  it('覆盖项不污染内置主题 —— fork 出的是独立副本', () => {
    const before = nexusLight.tokens['bg-canvas'];
    const manager = forked();
    manager.overrideToken('bg-canvas', '#101010');

    expect(nexusLight.tokens['bg-canvas']).toBe(before);
    manager.setTheme('nexus-light');
    expect(manager.theme.tokens['bg-canvas']).toBe(before);
    expect(manager.overrides).toEqual({});
  });

  it('切走再切回来，覆盖项还在', () => {
    const manager = forked();
    manager.overrideToken('bg-canvas', '#101010');

    manager.setTheme('nexus-dark');
    expect(manager.overrides).toEqual({});

    manager.setTheme('user:a');
    expect(manager.overrides).toEqual({ 'bg-canvas': '#101010' });
    expect(manager.theme.tokens['bg-canvas']).toBe('#101010');
  });

  it('构造时登记用户主题 —— 选择是它就直接解析到它，不等外部再注册一次', () => {
    const manager = new ThemeManager('user:a', fakeSystem(false).source, [
      userTheme('user:a', { 'bg-canvas': '#101010' })
    ]);

    expect(manager.theme.id).toBe('user:a');
    expect(manager.theme.tokens['bg-canvas']).toBe('#101010');
    expect(manager.overrides).toEqual({ 'bg-canvas': '#101010' });
  });

  it('构造时给的用户主题 id 不合法则忽略，按认不出的 id 回落', () => {
    const manager = new ThemeManager('user:a', fakeSystem(false).source, [
      { id: 'nexus-light', scheme: clone(nexusLightSeeds) }
    ]);

    expect(manager.theme.id).toBe('nexus-light');
    expect(manager.themeChoice).toBe('user:a');
  });
});

describe('ThemeManager 的种子编辑（基础档的写入口）', () => {
  it('内置主题上改种子被拒 —— 与覆盖项同一条纪律', () => {
    const manager = managerWith(fakeSystem(false), 'nexus-light');

    expect(manager.patchScheme({ palette: { base00: '#101010' } })).toBe(false);
    expect(manager.theme.tokens['bg-canvas']).toBe(nexusLight.tokens['bg-canvas']);
  });

  it('改一个槽位：派生重跑、其余槽位不动、activeScheme 反映的是改过的种子', () => {
    const manager = forked();
    const beforeSurface = manager.theme.tokens['bg-surface'];

    expect(manager.patchScheme({ palette: { base00: '#101010' } })).toBe(true);

    expect(manager.activeScheme?.palette.base00).toBe('#101010');
    expect(manager.activeScheme?.palette.base01).toBe(nexusLightSeeds.palette.base01);
    expect(manager.theme.tokens['bg-canvas']).toBe('#101010');
    expect(manager.theme.tokens['bg-surface']).toBe(beforeSurface);
  });

  /** 合并而不是替换：只给一个系数，其余四个必须留着缺省值。 */
  it('改系数是合并：只给一个键，其余仍是缺省', () => {
    const manager = forked();

    manager.patchScheme({ tuning: { surfaceHover: 0.4 } });

    expect(manager.activeScheme?.tuning?.surfaceHover).toBe(0.4);
    expect(manager.activeScheme?.tuning?.surfaceActive).toBeUndefined();
    expect(manager.theme.tokens['bg-surface-hover']).not.toBe(nexusLight.tokens['bg-surface-hover']);
  });

  it('改种子会广播 —— 只比 id 的判据在这里会漏（id 没变）', () => {
    const manager = forked();
    const listener = vi.fn();
    manager.subscribe(listener);
    const idBefore = manager.theme.id;

    manager.patchScheme({ palette: { base00: '#101010' } });

    expect(manager.theme.id).toBe(idBefore);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('种子与覆盖项互不覆盖 —— 覆盖项盖在派生结果之上', () => {
    const manager = forked();
    manager.overrideToken('bg-canvas', '#abcdef');

    manager.patchScheme({ palette: { base00: '#101010' } });

    expect(manager.theme.tokens['bg-canvas']).toBe('#abcdef');
    expect(manager.activeScheme?.palette.base00).toBe('#101010');
  });

  it('内置主题的 activeScheme 就是内置种子本身', () => {
    const manager = managerWith(fakeSystem(false), 'nexus-dark');
    expect(manager.activeScheme?.palette).toEqual(nexusDarkSeeds.palette);
  });
});
