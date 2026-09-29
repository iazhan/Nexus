import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_THEME_CHOICE, THEME_STORAGE_KEY } from '@nexus/theme';
import { applyThemeChoice, themeManager } from '../src/platform.js';

describe('主题选择的落盘', () => {
  beforeEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
  });

  it('落盘的是「选择」而不是解析结果 —— 预设与模式两轴都留下', () => {
    applyThemeChoice('nexus-dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('nexus@dark');
  });

  it('换模式保留预设 —— 落盘的还是同一个预设', () => {
    applyThemeChoice('nord@light');
    applyThemeChoice('nord@dark');

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('nord@dark');
  });

  it('选择「自动」时存档写自动 —— 写解析结果等于退出自动', () => {
    applyThemeChoice('nexus@dark');
    applyThemeChoice(DEFAULT_THEME_CHOICE);

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(DEFAULT_THEME_CHOICE);
    expect(themeManager.themeChoice).toBe(DEFAULT_THEME_CHOICE);
  });

  it('选择变了而解析结果没变时也要落盘', () => {
    // `nexus@auto`（系统恰好是浅色）与 `nexus@light` 解析出**同一个** id。只按「解析结果变了没」
    // 决定要不要落盘的话，这一步会被跳过 —— 表现是「选了浅色，重启后又回到自动」。
    applyThemeChoice(DEFAULT_THEME_CHOICE);
    const resolved = themeManager.theme.id;
    // 环境前提：happy-dom 的 `prefers-color-scheme: dark` 是 false。变了就让这条红，别静默失效。
    expect(resolved).toBe('nexus-light');

    applyThemeChoice('nexus@light');

    expect(themeManager.theme.id).toBe(resolved);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('nexus@light');
  });
});
