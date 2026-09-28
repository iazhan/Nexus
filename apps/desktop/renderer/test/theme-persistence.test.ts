import { describe, it, expect, beforeEach } from 'vitest';
import { SYSTEM_THEME, THEME_STORAGE_KEY } from '@nexus/theme';
import { applyThemeChoice, themeManager } from '../src/platform.js';

describe('主题选择的落盘', () => {
  beforeEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
  });

  it('落盘的是主题 id', () => {
    applyThemeChoice('nexus-dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('nexus-dark');
  });

  it('选择「跟随系统」时存档写哨兵值 —— 写解析结果等于退出跟随', () => {
    applyThemeChoice('nexus-dark');
    applyThemeChoice(SYSTEM_THEME);

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(SYSTEM_THEME);
    expect(themeManager.themeChoice).toBe(SYSTEM_THEME);
  });

  it('选择变了而解析结果没变时也要落盘', () => {
    // 系统偏好不确定，取当前解析结果对应的那套内置主题当作「恰好等于当前」的选择。
    const current = themeManager.theme.id;
    localStorage.setItem(THEME_STORAGE_KEY, SYSTEM_THEME);

    applyThemeChoice(current);

    expect(themeManager.theme.id).toBe(current);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(current);
  });
});
