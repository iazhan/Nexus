// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ThemeManager, type UserTheme } from '@nexus/theme';
import { themeBootPayload } from '../electron/theme-boot-payload.js';

/**
 * 首帧载荷的派生。**这是「用户主题首屏不再闪」那一半的判据** —— 从前静态 CSS 只覆盖内置
 * 主题，用户主题要等 renderer 起来再注入，首帧一定是别的主题。
 *
 * 不启动 Electron 也能测全：模块收的是「选了什么 + 系统偏好 + 有哪些用户主题」，没有 IO。
 * 主进程那边只负责把那三样凑齐（见 `index.ts` 的 `resolveThemeBoot`）。
 */

const AYU: UserTheme = {
  id: 'user:ayu',
  variants: {
    dark: {
      name: 'Ayu Dark',
      variant: 'dark',
      palette: {
        base00: '#0b0e14',
        base01: '#11151c',
        base02: '#1f2430',
        base03: '#3d4759',
        base04: '#6c7688',
        base05: '#bfbdb6',
        base06: '#e6e1cf',
        base07: '#f8f8f2',
        base08: '#f07178',
        base09: '#ff8f40',
        base0A: '#ffb454',
        base0B: '#aad94c',
        base0C: '#95e6cb',
        base0D: '#59c2ff',
        base0E: '#d2a6ff',
        base0F: '#e6b673'
      }
    }
  }
};

describe('themeBootPayload', () => {
  it('内置主题返回空 CSS —— 它有构建期静态 CSS，再注入一份只是多一个变量来源', () => {
    expect(themeBootPayload('nexus-dark', false, [])).toEqual({
      themeId: 'nexus-dark',
      cssText: ''
    });
    expect(themeBootPayload('ayu@dark', false, [])).toEqual({ themeId: 'ayu-dark', cssText: '' });
  });

  it('用户主题注入它自己那份变量 —— 这正是首帧不再闪的那一步', () => {
    const { themeId, cssText } = themeBootPayload('user:ayu@dark', false, [AYU]);
    expect(themeId).toBe('user:ayu');
    expect(cssText).not.toBe('');

    // 与 `ThemeManager.applyToDOM` 写出去的那段**逐字同形**：同一个选择器、同一份声明顺序。
    // 形状不同的话首帧与第二帧会有细微差异，而那种差异只在覆盖发生的那一瞬间看得见。
    const manager = new ThemeManager('user:ayu@dark', undefined, [AYU]);
    const expected = `:root {\n${Object.entries(manager.theme.tokens)
      .map(([key, value]) => `  --nexus-${key}: ${value};\n`)
      .join('')}}\n`;
    expect(cssText).toBe(expected);
  });

  it('认不出的选择退回默认预设，按系统偏好那一版 —— 与 renderer 的回落是同一条规则', () => {
    expect(themeBootPayload('no-such-theme', true, []).themeId).toBe('nexus-dark');
    expect(themeBootPayload('no-such-theme', false, []).themeId).toBe('nexus-light');
  });

  it('没有存档（choice 是 null）时同样走默认预设', () => {
    expect(themeBootPayload(null, true, []).themeId).toBe('nexus-dark');
  });

  it('选择指向一套**不在列表里**的用户主题时退回默认预设，不写一个没有变量的 id', () => {
    const boot = themeBootPayload('user:gone@dark', true, [AYU]);
    expect(boot.themeId).toBe('nexus-dark');
    expect(boot.cssText).toBe('');
  });

  it('单边用户主题按它有的那一版走（选的是另一版也不落空）', () => {
    expect(themeBootPayload('user:ayu@light', true, [AYU]).themeId).toBe('user:ayu');
  });
});
