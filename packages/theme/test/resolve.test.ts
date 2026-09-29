import { describe, it, expect } from 'vitest';
import {
  canChangeMode,
  choiceWithMode,
  DEFAULT_THEME_CHOICE,
  formatSelection,
  isAutoChoice,
  normalizeThemeChoice,
  parseSelection,
  presetOfScheme,
  presetVariantsOf,
  resolveThemeId,
  SYSTEM_DEFAULTS,
  SYSTEM_THEME,
} from '../src/resolve.js';
import { BUILT_IN_PRESETS } from '../src/seeds.js';

describe('normalizeThemeChoice：旧存档升成新格式', () => {
  it('没有存档 / `system` → 默认预设 + 自动', () => {
    expect(normalizeThemeChoice(null)).toBe(DEFAULT_THEME_CHOICE);
    expect(normalizeThemeChoice('')).toBe(DEFAULT_THEME_CHOICE);
    expect(normalizeThemeChoice(SYSTEM_THEME)).toBe(DEFAULT_THEME_CHOICE);
  });

  it('更早的存档存的是主题类型', () => {
    expect(normalizeThemeChoice('dark')).toBe('nexus@dark');
    expect(normalizeThemeChoice('light')).toBe('nexus@light');
  });

  it('裸方案 id 反查它属于哪个预设的哪一边', () => {
    expect(normalizeThemeChoice('nexus-dark')).toBe('nexus@dark');
    expect(normalizeThemeChoice('dracula')).toBe('dracula@dark');
    expect(normalizeThemeChoice('nord')).toBe('nord@dark');
    expect(normalizeThemeChoice('tokyo-night-light')).toBe('tokyo-night@light');
  });

  it('已经是新格式的透传；认不出的一律原样透传，回落交给 ThemeManager', () => {
    expect(normalizeThemeChoice('gruvbox@auto')).toBe('gruvbox@auto');
    expect(normalizeThemeChoice('user:abc')).toBe('user:abc');
    expect(normalizeThemeChoice('nope')).toBe('nope');
  });
});

describe('parseSelection', () => {
  it('`<预设>@<模式>` 解析成预设轴', () => {
    expect(parseSelection('gruvbox@dark')).toEqual({ preset: 'gruvbox', mode: 'dark' });
    expect(parseSelection('nexus@auto')).toEqual({ preset: 'nexus', mode: 'auto' });
  });

  it('裸 id 解析成方案轴 —— 用户主题没有模式可谈', () => {
    expect(parseSelection('user:abc')).toEqual({ id: 'user:abc' });
  });

  it('模式认不出时整条当方案 id —— 不去猜用户想说什么', () => {
    expect(parseSelection('nexus@bogus')).toEqual({ id: 'nexus@bogus' });
  });

  it('与 formatSelection 往返一致', () => {
    const selections = [
      { preset: 'gruvbox', mode: 'light' as const },
      { id: 'user:abc' },
    ];
    for (const selection of selections) {
      expect(parseSelection(formatSelection(selection))).toEqual(selection);
    }
  });
});

describe('resolveThemeId', () => {
  it('自动模式按系统偏好取预设的那一边', () => {
    expect(resolveThemeId('nexus@auto', true)).toBe('nexus-dark');
    expect(resolveThemeId('nexus@auto', false)).toBe('nexus-light');
    expect(resolveThemeId('gruvbox@auto', true)).toBe('gruvbox-dark');
    expect(resolveThemeId('gruvbox@auto', false)).toBe('gruvbox-light');
  });

  it('显式模式不受系统偏好影响', () => {
    expect(resolveThemeId('gruvbox@light', true)).toBe('gruvbox-light');
    expect(resolveThemeId('gruvbox@dark', false)).toBe('gruvbox-dark');
  });

  it('单变体预设三种模式都落在它有的那一版 —— 不掉到别的预设去', () => {
    expect(resolveThemeId('dracula@dark', false)).toBe('dracula');
    expect(resolveThemeId('dracula@light', false)).toBe('dracula');
    expect(resolveThemeId('dracula@auto', false)).toBe('dracula');
  });

  it('裸方案 id 直接用，不看系统偏好', () => {
    expect(resolveThemeId('user:abc', true)).toBe('user:abc');
    expect(resolveThemeId('nexus-light', true)).toBe('nexus-light');
  });

  it('认不出的预设回落到默认预设', () => {
    expect(resolveThemeId('nope@dark', true)).toBe('nexus-dark');
  });

  it('旧值在解析这一步就迁掉 —— preload 写进 data-theme 的必须是方案 id', () => {
    expect(resolveThemeId('dark', false)).toBe('nexus-dark');
    expect(resolveThemeId('light', true)).toBe('nexus-light');
    expect(resolveThemeId('dracula', false)).toBe('dracula');
  });
});

describe('isAutoChoice', () => {
  it('只有自动模式需要跟系统偏好重解析', () => {
    expect(isAutoChoice('nexus@auto')).toBe(true);
    expect(isAutoChoice('nexus@dark')).toBe(false);
    expect(isAutoChoice('user:abc')).toBe(false);
  });
});

describe('choiceWithMode', () => {
  it('换模式保留预设', () => {
    expect(choiceWithMode('gruvbox@dark', 'light')).toBe('gruvbox@light');
  });

  /**
   * 裸方案 id（用户主题）没有模式轴。**原样返回**而不是落到默认预设 —— 静默跳走等于把用户
   * 正在编辑的主题丢掉，而「按了没反应」至少是可解释的（界面上控件也是禁用的）。
   */
  it('裸方案 id 换不动模式，原样返回', () => {
    expect(choiceWithMode('user:abc', 'dark')).toBe('user:abc');
  });
});

describe('canChangeMode', () => {
  it('明暗两边都有的预设换得动', () => {
    expect(canChangeMode('nord@dark')).toBe(true);
    expect(canChangeMode('nexus@auto')).toBe(true);
  });

  it('单变体预设换不动 —— 换到另一边只会被 resolveThemeId 退回来', () => {
    // `dracula` 上游只有暗版，这是「单变体是合法形状」的样本。
    expect(presetVariantsOf('dracula')?.light).toBeUndefined();
    expect(canChangeMode('dracula@dark')).toBe(false);
  });

  it('裸方案 id 与认不出的预设都换不动', () => {
    expect(canChangeMode('user:abc')).toBe(false);
    expect(canChangeMode('no-such-preset@dark')).toBe(false);
  });

  /** `null` 是「没有存档」，归一后就是默认预设 + 自动 —— 它当然换得动。 */
  it('没有存档时按默认预设判', () => {
    expect(canChangeMode(null)).toBe(true);
  });
});

describe('预设表与方案表的一致性', () => {
  it('每个预设的每个变体都能反查回自己 —— 反查表与预设表不会各说一套', () => {
    for (const preset of BUILT_IN_PRESETS) {
      for (const mode of ['light', 'dark'] as const) {
        const schemeId = preset.variants[mode];
        if (!schemeId) continue;
        expect(presetOfScheme(schemeId), schemeId).toEqual({ preset: preset.id, mode });
        expect(presetVariantsOf(preset.id)?.[mode]).toBe(schemeId);
      }
    }
  });

  it('SYSTEM_DEFAULTS 就是默认预设的两个变体 —— 两处各写一遍迟早对不上', () => {
    expect(presetVariantsOf('nexus')).toEqual({
      light: SYSTEM_DEFAULTS.light,
      dark: SYSTEM_DEFAULTS.dark,
    });
  });
});
