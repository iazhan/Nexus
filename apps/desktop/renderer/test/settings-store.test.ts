import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_THEME_CHOICE, THEME_STORAGE_KEY, type UserTheme } from '@nexus/theme';
import { SETTING_DEFS, SettingsStore } from '../src/settings/store.js';
import { applyOverrides, applyThemeChoice, applyUserTheme, settings, themeManager } from '../src/platform.js';

const LAST_SECTION_KEY = SETTING_DEFS['settings.lastSection'].storageKey;
const USER_THEME_KEY = SETTING_DEFS['appearance.userTheme'].storageKey;

/** 默认预设的两个显式模式。存档里一律是 `<预设>@<模式>`。 */
const LIGHT = 'nexus@light';
const DARK = 'nexus@dark';

/**
 * 拿一份**真实的**用户主题：在内置主题上写一次覆盖项，`applyOverrides()` 会先 fork 出来。
 * 手写 16 个槽位不如让产线生成 —— 手写的那份一旦与产线脱节，测的就不是真东西。
 */
function forkedUserTheme(): UserTheme {
  applyThemeChoice(LIGHT);
  applyOverrides({ 'bg-canvas': '#101010' });
  const saved = settings.get('appearance.userTheme');
  if (!saved) throw new Error('fork 之后没有落盘');
  return saved;
}

/** 主题选择与存档归位 —— `themeManager` 是模块级单例，不还原会渗到同文件后面的用例。 */
function resetTheme(): void {
  settings.set('appearance.userTheme', null);
  applyThemeChoice(DEFAULT_THEME_CHOICE);
}

describe('设置存储 · 读初值', () => {
  beforeEach(() => localStorage.clear());

  it('没有存档时用 fallback', () => {
    const store = new SettingsStore();
    expect(store.get('appearance.theme')).toBe(DEFAULT_THEME_CHOICE);
    expect(store.get('settings.lastSection')).toBe('appearance');
  });

  it('有存档时用存档', () => {
    localStorage.setItem(THEME_STORAGE_KEY, DARK);
    localStorage.setItem(LAST_SECTION_KEY, 'editor');

    const store = new SettingsStore();
    expect(store.get('appearance.theme')).toBe(DARK);
    expect(store.get('settings.lastSection')).toBe('editor');
  });

  /**
   * 三种旧值都要接住，它们各自来自一个历史阶段：
   * - `dark` / `light` 是**主题类型**（最早只有明暗两套）；
   * - 裸方案 id 是上一版（预设即方案，没有模式轴）；
   * - `system` 是上一版的「跟随系统」哨兵值。
   */
  it('旧存档存的是主题类型，迁移在 parse 里', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(new SettingsStore().get('appearance.theme')).toBe(DARK);

    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    expect(new SettingsStore().get('appearance.theme')).toBe(LIGHT);
  });

  it('旧存档存的是裸方案 id，反查成它所属预设的那一边', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'nexus-dark');
    expect(new SettingsStore().get('appearance.theme')).toBe(DARK);

    // `dracula` 上游只有暗版，预设 id 与方案 id 同名 —— 反查表要能区分这两件事。
    localStorage.setItem(THEME_STORAGE_KEY, 'dracula');
    expect(new SettingsStore().get('appearance.theme')).toBe('dracula@dark');

    localStorage.setItem(THEME_STORAGE_KEY, 'nord-light');
    expect(new SettingsStore().get('appearance.theme')).toBe('nord@light');
  });

  it('旧存档的「跟随系统」哨兵值升成「默认预设 + 自动」', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'system');
    expect(new SettingsStore().get('appearance.theme')).toBe(DEFAULT_THEME_CHOICE);
  });

  it('认不出的值原样留着 —— 静默改掉会让用户以为选择丢了', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'no-such-theme');
    expect(new SettingsStore().get('appearance.theme')).toBe('no-such-theme');
  });

  it('空白字符串当作没有值', () => {
    localStorage.setItem(LAST_SECTION_KEY, '   ');
    expect(new SettingsStore().get('settings.lastSection')).toBe('appearance');
  });

  it('构造后不再看外部对磁盘的改动 —— store 是权威', () => {
    const store = new SettingsStore();
    localStorage.setItem(THEME_STORAGE_KEY, DARK);
    expect(store.get('appearance.theme')).toBe(DEFAULT_THEME_CHOICE);
  });
});

describe('设置存储 · 写入', () => {
  beforeEach(() => localStorage.clear());

  it('落盘并更新内存态', () => {
    const store = new SettingsStore();
    store.set('appearance.theme', DARK);

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(DARK);
    expect(store.get('appearance.theme')).toBe(DARK);
  });

  it('落盘的是规范化后的值 —— 传旧格式进去，磁盘上不留旧格式', () => {
    const store = new SettingsStore();
    store.set('appearance.theme', 'dark');

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(DARK);
    expect(store.get('appearance.theme')).toBe(DARK);
  });

  it('值没变也照样落盘 —— 磁盘可能被绕过 store 改过', () => {
    const store = new SettingsStore();
    store.set('appearance.theme', DARK);
    localStorage.setItem(THEME_STORAGE_KEY, DEFAULT_THEME_CHOICE);

    store.set('appearance.theme', DARK);

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(DARK);
  });

  it('存储不可用时读 fallback、写不抛错', () => {
    const store = new SettingsStore(null);

    expect(store.get('appearance.theme')).toBe(DEFAULT_THEME_CHOICE);
    expect(() => store.set('appearance.theme', DARK)).not.toThrow();
    expect(store.get('appearance.theme')).toBe(DARK);
  });
});

describe('设置存储 · 广播', () => {
  beforeEach(() => localStorage.clear());

  it('值变化时通知订阅者', () => {
    const store = new SettingsStore();
    const seen: string[] = [];
    store.subscribe('appearance.theme', () => seen.push(store.get('appearance.theme')));

    store.set('appearance.theme', DARK);
    store.set('appearance.theme', DEFAULT_THEME_CHOICE);

    expect(seen).toEqual([DARK, DEFAULT_THEME_CHOICE]);
  });

  it('值没变时不通知', () => {
    const store = new SettingsStore();
    store.set('appearance.theme', DARK);

    let count = 0;
    store.subscribe('appearance.theme', () => {
      count += 1;
    });
    store.set('appearance.theme', DARK);
    store.set('appearance.theme', 'nexus-dark'); // 规范化之后还是 nexus@dark
    store.set('appearance.theme', 'dark'); // 同上

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

    store.set('appearance.theme', DARK);
    unsubscribe();
    store.set('appearance.theme', DEFAULT_THEME_CHOICE);

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

    store.set('appearance.theme', DARK);

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
   *
   * 两轴模型下这条最容易漏：`nexus@light` 与 `nexus@auto`（系统恰好是浅色时）解析出**同一个**
   * id，选择变了、解析结果没变 —— 只有 store 那条订阅发得出来。
   */
  it('选择变了而解析结果没变时，只有 store 发得出通知', () => {
    applyThemeChoice(LIGHT);
    const resolved = themeManager.theme.id;
    expect(resolved).toBe('nexus-light');

    const fromStore: string[] = [];
    const fromManager: string[] = [];
    const offStore = settings.subscribe('appearance.theme', () =>
      fromStore.push(settings.get('appearance.theme'))
    );
    const offManager = themeManager.subscribe(() => fromManager.push(themeManager.theme.id));

    applyThemeChoice(DEFAULT_THEME_CHOICE);
    offStore();
    offManager();

    expect(themeManager.theme.id).toBe(resolved);
    expect(themeManager.themeChoice).toBe(DEFAULT_THEME_CHOICE);
    expect(fromStore).toEqual([DEFAULT_THEME_CHOICE]);
    expect(fromManager).toEqual([]);
  });

  /** 换模式保留预设 —— 两轴模型下「切深色」不该顺手把预设也换掉。 */
  it('换模式只动模式轴', () => {
    applyThemeChoice('nord@light');
    applyThemeChoice('nord@dark');

    expect(themeManager.themeChoice).toBe('nord@dark');
    expect(themeManager.theme.id).toBe('nord');

    resetTheme();
  });
});

describe('设置存储 · 用户主题', () => {
  beforeEach(() => localStorage.clear());

  it('没有存档时是 null', () => {
    expect(new SettingsStore().get('appearance.userTheme')).toBeNull();
  });

  it('坏 JSON 回落 null，不抛 —— 存档是用户能改的', () => {
    localStorage.setItem(USER_THEME_KEY, '{ not json');
    expect(new SettingsStore().get('appearance.userTheme')).toBeNull();
  });

  it('往返一致', () => {
    const theme = forkedUserTheme();
    const store = new SettingsStore();
    store.set('appearance.userTheme', theme);

    expect(new SettingsStore().get('appearance.userTheme')).toEqual(theme);
    resetTheme();
  });

  it('内置 id 被拒 —— 切回 Nexus Light 必须拿到没被改过的 Nexus Light', () => {
    const { scheme } = forkedUserTheme();
    localStorage.setItem(USER_THEME_KEY, JSON.stringify({ id: 'nexus-light', scheme }));

    expect(new SettingsStore().get('appearance.userTheme')).toBeNull();
    resetTheme();
  });

  it('清空时落空串而不是删键 —— 落盘路径只有一条', () => {
    const store = new SettingsStore();
    store.set('appearance.userTheme', forkedUserTheme());
    store.set('appearance.userTheme', null);

    expect(localStorage.getItem(USER_THEME_KEY)).toBe('');
    expect(store.get('appearance.userTheme')).toBeNull();
    resetTheme();
  });
});

describe('设置存储 · 注册用户主题', () => {
  it('applyUserTheme 注册、切换、落盘一次到位', () => {
    const theme = { ...forkedUserTheme(), id: 'user:imported' };
    resetTheme();

    applyUserTheme(theme);

    expect(themeManager.theme.id).toBe('user:imported');
    expect(settings.get('appearance.theme')).toBe('user:imported');
    expect(settings.get('appearance.userTheme')).toEqual(theme);
    resetTheme();
  });

  it('用户主题是裸 id，没有模式轴 —— 存档里不该被写成 `<id>@<模式>`', () => {
    const theme = { ...forkedUserTheme(), id: 'user:imported' };
    resetTheme();

    applyUserTheme(theme);

    expect(settings.get('appearance.theme')).not.toContain('@');
    expect(themeManager.themeChoice).toBe('user:imported');
    resetTheme();
  });

  it('applyUserTheme 拒绝内置 id —— 不落盘、不切换', () => {
    const { scheme } = forkedUserTheme();
    resetTheme();
    applyThemeChoice(LIGHT);

    applyUserTheme({ id: 'nexus-light', scheme });

    expect(settings.get('appearance.userTheme')).toBeNull();
    expect(themeManager.theme.id).toBe('nexus-light');
  });
});

describe('设置存储 · 覆盖项的接线', () => {
  /**
   * 内置主题不可写，所以这一条同时覆盖三件事：fork 出用户主题、覆盖项生效、两者一起落盘。
   * 少任何一件的表现都是「拖了滑块没反应，或者重启后没了」。
   */
  it('在内置主题上写覆盖项会先 fork 成用户主题，并把覆盖项一起落盘', () => {
    applyThemeChoice(LIGHT);
    const derivedSurface = themeManager.theme.tokens['bg-surface'];

    applyOverrides({ 'bg-canvas': '#101010' });

    const saved = settings.get('appearance.userTheme');
    expect(saved?.id.startsWith('user:')).toBe(true);
    expect(saved?.scheme.overrides).toEqual({ 'bg-canvas': '#101010' });
    expect(themeManager.theme.id).toBe(saved?.id);
    expect(themeManager.themeChoice).toBe(saved?.id);
    expect(themeManager.theme.tokens['bg-canvas']).toBe('#101010');
    // 只盖了给定的一项，其余仍是派生值。
    expect(themeManager.theme.tokens['bg-surface']).toBe(derivedSurface);

    resetTheme();
  });

  it('已经在用户主题上时不再 fork，覆盖项继续累积', () => {
    applyThemeChoice(LIGHT);
    applyOverrides({ 'bg-canvas': '#101010' });
    const firstId = settings.get('appearance.userTheme')?.id;

    applyOverrides({ 'bg-surface': '#202020' });

    expect(settings.get('appearance.userTheme')?.id).toBe(firstId);
    expect(settings.get('appearance.userTheme')?.scheme.overrides).toEqual({
      'bg-canvas': '#101010',
      'bg-surface': '#202020',
    });

    resetTheme();
  });
});
