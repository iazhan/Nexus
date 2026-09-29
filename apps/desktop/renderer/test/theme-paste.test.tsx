// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_THEME_CHOICE, parseBase16, type UserTheme } from '@nexus/theme';
import { translate } from '@nexus/i18n';
import { ThemeTransfer } from '../src/settings/ThemeTransfer.js';
import { applyThemeChoice, applyUserTheme, settings, themeManager } from '../src/platform.js';
import { localeManager } from '../src/platform.js';

/**
 * base16 粘贴框与「同名明暗两套合并」（2026-09-29）。
 *
 * 这一层必须有的理由：真机用例一个文件只能启动一次 Electron，覆盖不到「补一版 / 解析失败 /
 * 合并确认与取消」这些分支，而它们正是这次改动最容易做错的地方。
 *
 * 注意 `renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const schemeYaml = (name: string, variant: 'light' | 'dark'): string => `system: "base16"
name: "${name}"
author: "test"
variant: "${variant}"
palette:
  base00: "${variant === 'light' ? '#fafafa' : '#101010'}"
  base01: "${variant === 'light' ? '#f0f0f0' : '#1a1a1a'}"
  base02: "${variant === 'light' ? '#dcdcdc' : '#2a2a2a'}"
  base03: "${variant === 'light' ? '#a0a0a0' : '#505050'}"
  base04: "${variant === 'light' ? '#707070' : '#808080'}"
  base05: "${variant === 'light' ? '#303030' : '#e0e0e0'}"
  base06: "${variant === 'light' ? '#202020' : '#f0f0f0'}"
  base07: "${variant === 'light' ? '#101010' : '#ffffff'}"
  base08: "${variant === 'light' ? '#c03030' : '#e07070'}"
  base09: "${variant === 'light' ? '#b06000' : '#e0a060'}"
  base0A: "${variant === 'light' ? '#a08000' : '#e0d060'}"
  base0B: "${variant === 'light' ? '#308030' : '#70c070'}"
  base0C: "${variant === 'light' ? '#208090' : '#60c0d0'}"
  base0D: "${variant === 'light' ? '#2050b0' : '#7090e0'}"
  base0E: "${variant === 'light' ? '#8030a0' : '#c070e0'}"
  base0F: "${variant === 'light' ? '#704020' : '#b08060'}"
`;

const AYU_LIGHT = schemeYaml('Ayu Light', 'light');
const AYU_DARK = schemeYaml('Ayu Dark', 'dark');

let container: HTMLDivElement;
let root: Root;

function resetTheme(): void {
  settings.set('appearance.userThemes', []);
  applyThemeChoice(DEFAULT_THEME_CHOICE);
}

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
}

function unmount(): void {
  act(() => root.unmount());
  container.remove();
}

function renderTransfer(): void {
  act(() => {
    root.render(<ThemeTransfer />);
  });
}

const el = <T extends Element>(selector: string): T | null => container.querySelector<T>(selector);

function setTextarea(value: string): void {
  const area = el<HTMLTextAreaElement>('[data-theme-paste-input]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(area, value);
  area.dispatchEvent(new Event('input', { bubbles: true }));
}

function applyPaste(text: string): void {
  act(() => setTextarea(text));
  act(() => el<HTMLButtonElement>('[data-theme-paste-apply]')!.click());
}

/** 从一段 base16 造一套**单边**用户主题 —— 直接构造，不经过 fork（fork 会给两版）。 */
function singleVariantTheme(id: string, text: string): UserTheme {
  const parsed = parseBase16(text);
  if (!parsed.ok) throw new Error('夹具本身解析失败');
  return { id, variants: { [parsed.scheme.variant]: parsed.scheme } };
}

beforeEach(() => {
  resetTheme();
  mount();
});

afterEach(() => {
  unmount();
  resetTheme();
});

describe('base16 粘贴框', () => {
  it('空文本框时「应用」禁用 —— 空串解析必然报错，按下去只会得到一条没用的红字', () => {
    renderTransfer();

    expect(el<HTMLButtonElement>('[data-theme-paste-apply]')?.disabled).toBe(true);
    act(() => setTextarea(AYU_LIGHT));
    expect(el<HTMLButtonElement>('[data-theme-paste-apply]')?.disabled).toBe(false);
  });

  it('解析失败：状态行报错，不写盘、不切主题', () => {
    renderTransfer();
    const before = themeManager.theme.id;

    applyPaste('这不是主题文件');

    expect(el('[data-theme-paste-status]')?.getAttribute('data-status')).toBe('error');
    expect(themeManager.theme.id).toBe(before);
    expect(settings.get('appearance.userThemes')).toEqual([]);
  });

  /**
   * 落点是**粘贴内容自己的 variant**，不是「当前正在编辑的那一版」。浅色配色写进深色那一版
   * 会让派生方向与配色相反，对比度当场崩掉。
   */
  it('粘贴浅色到内置主题：fork 出用户主题并落在浅色版上', () => {
    applyThemeChoice('nexus@light');
    renderTransfer();

    applyPaste(AYU_LIGHT);

    const saved = settings.get('appearance.userThemes');
    expect(saved).toHaveLength(1);
    // 名字沿用主题**已有的**那个（fork 自 nexus 所以是 `Nexus`）—— 粘贴改的是配色，不是标签。
    expect(saved[0].variants.light?.name).toBe('Nexus');
    expect(themeManager.activeScheme?.variant).toBe('light');
    expect(themeManager.theme.tokens['bg-canvas']).toBe('#fafafa');
  });

  /**
   * **补一版**：单边主题唯一的出路。不补的话切到另一边是死路（模式控件禁用 + 无路可走）。
   */
  it('粘贴深色到一套只有浅色的主题：补上深色版，两版并存', () => {
    applyUserTheme(singleVariantTheme('user:ayu', AYU_LIGHT));
    renderTransfer();

    applyPaste(AYU_DARK);

    const saved = settings.get('appearance.userThemes').find((t) => t.id === 'user:ayu')!;
    expect(Object.keys(saved.variants).sort()).toEqual(['dark', 'light']);
    // 名字两版共用，沿用主题已有的那个 —— 粘贴改的是配色，不是标签。
    expect(saved.variants.dark?.name).toBe('Ayu Light');
    expect(themeManager.activeScheme?.variant).toBe('dark');
    expect(themeManager.theme.tokens['bg-canvas']).toBe('#101010');
    expect(el('[data-theme-paste-status]')?.textContent).toContain(
      translate(localeManager.locale, 'theme.paste.appliedAdded', {
        name: 'Ayu Dark',
        variant: translate(localeManager.locale, 'theme.mode.dark')
      })
    );
  });

  it('覆盖已有的一版时状态行说的是「已应用」而不是「补上」', () => {
    applyThemeChoice('nexus@light');
    renderTransfer();

    applyPaste(AYU_LIGHT);

    expect(el('[data-theme-paste-status]')?.textContent).toContain(
      translate(localeManager.locale, 'theme.paste.applied', {
        name: 'Ayu Light',
        variant: translate(localeManager.locale, 'theme.mode.light')
      })
    );
  });

  it('「清空」把文本框与状态行一起归零', () => {
    applyThemeChoice('nexus@light');
    renderTransfer();
    applyPaste(AYU_LIGHT);

    act(() => el<HTMLButtonElement>('[data-theme-paste-clear]')!.click());

    expect(el<HTMLTextAreaElement>('[data-theme-paste-input]')?.value).toBe('');
    expect(el('[data-theme-paste-status]')).toBeNull();
  });
});

describe('同名明暗两套的合并', () => {
  /** 两套同名互补的单边主题 → 提示出现。 */
  it('同名互补时给出合并提示', () => {
    applyUserTheme(singleVariantTheme('user:dark', AYU_DARK));
    applyUserTheme(singleVariantTheme('user:light', AYU_LIGHT));
    renderTransfer();

    const prompt = el('[data-theme-merge]');
    expect(prompt).not.toBeNull();
    expect(prompt?.getAttribute('data-theme-merge-with')).toBe('user:dark');
  });

  it('确认合并：合成一套、被并掉的那套从列表消失，选择改指到留下的那套', () => {
    applyUserTheme(singleVariantTheme('user:dark', AYU_DARK));
    applyUserTheme(singleVariantTheme('user:light', AYU_LIGHT));
    renderTransfer();

    act(() => el<HTMLButtonElement>('[data-theme-merge-confirm]')!.click());

    const saved = settings.get('appearance.userThemes');
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe('user:light');
    expect(Object.keys(saved[0].variants).sort()).toEqual(['dark', 'light']);
    expect(themeManager.theme.id).toBe('user:light');
    // 注册表也跟着换一份 —— 留着被并掉的那套，「删了却还能切回去」。
    expect(themeManager.userVariantsOf('user:dark')).toBeNull();
  });

  it('「暂不合并」之后提示消失，两套都还在', () => {
    applyUserTheme(singleVariantTheme('user:dark', AYU_DARK));
    applyUserTheme(singleVariantTheme('user:light', AYU_LIGHT));
    renderTransfer();

    act(() => el<HTMLButtonElement>('[data-theme-merge-dismiss]')!.click());

    expect(el('[data-theme-merge]')).toBeNull();
    expect(settings.get('appearance.userThemes')).toHaveLength(2);
  });

  it('基名不同的两套不提示', () => {
    applyUserTheme(singleVariantTheme('user:nord', schemeYaml('Nord Dark', 'dark')));
    applyUserTheme(singleVariantTheme('user:ayu', AYU_LIGHT));
    renderTransfer();

    expect(el('[data-theme-merge]')).toBeNull();
  });

  it('只有一套时不提示', () => {
    applyUserTheme(singleVariantTheme('user:ayu', AYU_LIGHT));
    renderTransfer();

    expect(el('[data-theme-merge]')).toBeNull();
  });
});
