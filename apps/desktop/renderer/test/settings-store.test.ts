import { describe, it, expect, beforeEach } from 'vitest';
import { SYSTEM_THEME, THEME_STORAGE_KEY } from '@nexus/theme';
import { SETTING_DEFS, SettingsStore } from '../src/settings/store.js';
import { applyThemeChoice, settings, themeManager } from '../src/platform.js';

const LAST_SECTION_KEY = SETTING_DEFS['settings.lastSection'].storageKey;

describe('设置存储 · 读初值', () => {
  beforeEach(() => localStorage.clear());

  it('没有存档时用 fallback', () => {
    const store = new SettingsStore();
    expect(store.get('appearance.theme')).toBe(SYSTEM_THEME);
    expect(store.get('settings.lastSection')).toBe('appearance');
  });

  it('有存档时用存档', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'nexus-dark');
    localStorage.setItem(LAST_SECTION_KEY, 'editor');

    const store = new SettingsStore();
    expect(store.get('appearance.theme')).toBe('nexus-dark');
    expect(store.get('settings.lastSection')).toBe('editor');
  });

  it('旧存档存的是主题类型，迁移在 parse 里', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(new SettingsStore().get('appearance.theme')).toBe('nexus-dark');
  });

  it('空白字符串当作没有值', () => {
    localStorage.setItem(LAST_SECTION_KEY, '   ');
    expect(new SettingsStore().get('settings.lastSection')).toBe('appearance');
  });

  it('构造后不再看外部对磁盘的改动 —— store 是权威', () => {
    const store = new SettingsStore();
    localStorage.setItem(THEME_STORAGE_KEY, 'nexus-dark');
    expect(store.get('appearance.theme')).toBe(SYSTEM_THEME);
  });
});

describe('设置存储 · 写入', () => {
  beforeEach(() => localStorage.clear());

  it('落盘并更新内存态', () => {
    const store = new SettingsStore();
    store.set('appearance.theme', 'nexus-dark');

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('nexus-dark');
    expect(store.get('appearance.theme')).toBe('nexus-dark');
  });

  it('落盘的是规范化后的值 —— 传旧格式进去，磁盘上不留旧格式', () => {
    const store = new SettingsStore();
    store.set('appearance.theme', 'dark');

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('nexus-dark');
    expect(store.get('appearance.theme')).toBe('nexus-dark');
  });

  it('值没变也照样落盘 —— 磁盘可能被绕过 store 改过', () => {
    const store = new SettingsStore();
    store.set('appearance.theme', 'nexus-dark');
    localStorage.setItem(THEME_STORAGE_KEY, SYSTEM_THEME);

    store.set('appearance.theme', 'nexus-dark');

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('nexus-dark');
  });

  it('存储不可用时读 fallback、写不抛错', () => {
    const store = new SettingsStore(null);

    expect(store.get('appearance.theme')).toBe(SYSTEM_THEME);
    expect(() => store.set('appearance.theme', 'nexus-dark')).not.toThrow();
    expect(store.get('appearance.theme')).toBe('nexus-dark');
  });
});

describe('设置存储 · 广播', () => {
  beforeEach(() => localStorage.clear());

  it('值变化时通知订阅者', () => {
    const store = new SettingsStore();
    const seen: string[] = [];
    store.subscribe('appearance.theme', () => seen.push(store.get('appearance.theme')));

    store.set('appearance.theme', 'nexus-dark');
    store.set('appearance.theme', SYSTEM_THEME);

    expect(seen).toEqual(['nexus-dark', SYSTEM_THEME]);
  });

  it('值没变时不通知', () => {
    const store = new SettingsStore();
    store.set('appearance.theme', 'nexus-dark');

    let count = 0;
    store.subscribe('appearance.theme', () => {
      count += 1;
    });
    store.set('appearance.theme', 'nexus-dark');
    store.set('appearance.theme', 'dark'); // 规范化之后还是 nexus-dark

    expect(count).toBe(0);
  });

  it('只通知同一个 path 的订阅者', () => {
    const store = new SettingsStore();
    let themeHits = 0;
    let sectionHits = 0;
    store.subscribe('appearance.theme', () => {
      themeHits += 1;
    });
    store.subscribe('settings.lastSection', () => {
      sectionHits += 1;
    });

    store.set('settings.lastSection', 'editor');

    expect(themeHits).toBe(0);
    expect(sectionHits).toBe(1);
  });

  it('退订后不再收到通知', () => {
    const store = new SettingsStore();
    let count = 0;
    const unsubscribe = store.subscribe('appearance.theme', () => {
      count += 1;
    });

    store.set('appearance.theme', 'nexus-dark');
    unsubscribe();
    store.set('appearance.theme', SYSTEM_THEME);

    expect(count).toBe(1);
  });

  it('监听器里退订不会漏掉后面的监听器', () => {
    const store = new SettingsStore();
    const seen: string[] = [];
    let unsubscribeFirst = (): void => {};
    unsubscribeFirst = store.subscribe('appearance.theme', () => {
      seen.push('first');
      unsubscribeFirst();
    });
    store.subscribe('appearance.theme', () => seen.push('second'));

    store.set('appearance.theme', 'nexus-dark');

    expect(seen).toEqual(['first', 'second']);
  });
});

describe('设置存储 · 与主题的接线', () => {
  it('初值同源：store 与 ThemeManager 读到同一个选择', () => {
    expect(themeManager.themeChoice).toBe(settings.get('appearance.theme'));
  });

  /**
   * 这条是「选择」与「解析结果」两条通知分工的回归网 —— 见 `docs/phase-4-plan.md` §7 难点 1。
   * 把 store 的通知删掉、退回「只在 `ThemeManager` 的订阅里落盘」，这里会红。
   */
  it('选择变了而解析结果没变时，只有 store 发得出通知', () => {
    applyThemeChoice(SYSTEM_THEME); // 先归位到跟随系统
    const resolved = themeManager.theme.id;

    const fromStore: string[] = [];
    const fromManager: string[] = [];
    const offStore = settings.subscribe('appearance.theme', () =>
      fromStore.push(settings.get('appearance.theme'))
    );
    const offManager = themeManager.subscribe(() => fromManager.push(themeManager.theme.id));

    // 选一个「恰好等于当前解析结果」的主题：选择变了，解析结果没变。
    applyThemeChoice(resolved);
    offStore();
    offManager();

    expect(themeManager.theme.id).toBe(resolved);
    expect(themeManager.themeChoice).toBe(resolved);
    expect(fromStore).toEqual([resolved]);
    expect(fromManager).toEqual([]);
  });
});
