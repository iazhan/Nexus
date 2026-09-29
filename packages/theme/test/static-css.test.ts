import { describe, it, expect } from 'vitest';
import { builtInThemes, nexusLight, themesToCss } from '../src/index.js';
import { SYSTEM_DEFAULTS, SYSTEM_THEME } from '../src/resolve.js';

const themes = builtInThemes();
const css = themesToCss(themes);

describe('themesToCss', () => {
  it('每套内置主题一个块，选择器用主题 id —— preload 写的也是 id', () => {
    for (const theme of themes) {
      expect(css).toContain(`html[data-theme='${theme.id}']`);
    }
    expect(css).not.toContain("data-theme='light'");
    expect(css).not.toContain("data-theme='dark'");
  });

  it('基线主题同时挂在 :root 上 —— 没有 data-theme 或 id 认不出时不至于一个变量都没有', () => {
    expect(SYSTEM_DEFAULTS.light).toBe(nexusLight.id);
    expect(css).toContain(`:root,\nhtml[data-theme='${nexusLight.id}']`);
  });

  it('每套主题的每条 token 都在，值与运行时一致 —— 防漂移的主断言', () => {
    for (const theme of themes) {
      for (const [token, value] of Object.entries(theme.tokens)) {
        expect(css).toContain(`  --nexus-${token}: ${value};`);
      }
    }
  });

  it('没有多余声明 —— 静态 CSS 的 token 集合与运行时完全一致', () => {
    const declared = [...css.matchAll(/^\s+--nexus-([a-z0-9-]+):/gm)].map((match) => match[1]);
    const expected = new Set(themes.flatMap((theme) => Object.keys(theme.tokens)));
    expect(new Set(declared)).toEqual(expected);
  });

  it('跟随系统的哨兵值不会出现在 CSS 里 —— 它是选择，不是主题', () => {
    expect(css).not.toContain(SYSTEM_THEME);
  });

  it('基线 id 不在 themes 里时直接报错，不静默生成一份没有基线的 CSS', () => {
    expect(() => themesToCss(themes, 'nope')).toThrow(/nope/);
  });
});
