import { describe, it, expect } from 'vitest';
import {
  normalizeThemeChoice,
  resolveThemeId,
  SYSTEM_DEFAULTS,
  SYSTEM_THEME,
  themeIdForType
} from '../src/resolve.js';

describe('normalizeThemeChoice', () => {
  it('旧存档的主题类型映射成主题 id', () => {
    expect(normalizeThemeChoice('dark')).toBe('nexus-dark');
    expect(normalizeThemeChoice('light')).toBe('nexus-light');
  });

  it('没有存档时是「跟随系统」', () => {
    expect(normalizeThemeChoice(null)).toBe(SYSTEM_THEME);
    expect(normalizeThemeChoice('')).toBe(SYSTEM_THEME);
  });

  it('已经是 id 或哨兵值的选择原样透传', () => {
    expect(normalizeThemeChoice('nexus-dark')).toBe('nexus-dark');
    expect(normalizeThemeChoice('dracula')).toBe('dracula');
    expect(normalizeThemeChoice(SYSTEM_THEME)).toBe(SYSTEM_THEME);
  });
});

describe('resolveThemeId', () => {
  it('跟随系统时按系统偏好选内置主题', () => {
    expect(resolveThemeId(SYSTEM_THEME, true)).toBe('nexus-dark');
    expect(resolveThemeId(SYSTEM_THEME, false)).toBe('nexus-light');
  });

  it('没有存档等价于跟随系统 —— 旧行为就是「无存档时看系统偏好」', () => {
    expect(resolveThemeId(null, true)).toBe(resolveThemeId(SYSTEM_THEME, true));
    expect(resolveThemeId(null, false)).toBe(resolveThemeId(SYSTEM_THEME, false));
  });

  it('具体主题不受系统偏好影响', () => {
    expect(resolveThemeId('nexus-light', true)).toBe('nexus-light');
    expect(resolveThemeId('dracula', true)).toBe('dracula');
  });

  it('旧值在解析这一步就迁掉 —— preload 写进 data-theme 的必须是 id', () => {
    expect(resolveThemeId('dark', false)).toBe('nexus-dark');
    expect(resolveThemeId('light', true)).toBe('nexus-light');
  });
});

describe('themeIdForType', () => {
  it('与 SYSTEM_DEFAULTS 同源', () => {
    expect(themeIdForType('light')).toBe(SYSTEM_DEFAULTS.light);
    expect(themeIdForType('dark')).toBe(SYSTEM_DEFAULTS.dark);
  });
});
