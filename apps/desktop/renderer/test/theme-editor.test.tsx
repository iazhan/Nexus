// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_THEME_CHOICE, defaultTuning } from '@nexus/theme';
import { ThemeEditor } from '../src/settings/ThemeEditor.js';
import {
  ALL_EDITABLE_TOKENS,
  SEED_GROUPS,
  SLOT_ROLE_KEYS,
  TUNING_FIELDS,
  toColorInputValue
} from '../src/settings/theme-fields.js';
import { applyThemeChoice, settings, themeManager } from '../src/platform.js';

/**
 * 两档主题编辑器的渲染与写回（P4-05 / P4-06）。
 *
 * 为什么这一层要有用例：真机用例一个文件只能启动一次 Electron、只跑一种形状，覆盖不到
 * 「高级档才有覆盖项提示条」「不达标才标对比度」这些分支。这里用组件自己的状态属性做判据
 * （`data-*`、`aria-selected`），**不用文案节点**。
 *
 * 注意 `renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

/** React 的 `onChange` 挂在原生 `input` 事件上；直接改 `.value` 不触发它。 */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function el<T extends HTMLElement>(selector: string): T | null {
  return container.querySelector<T>(selector);
}

function all<T extends HTMLElement>(selector: string): T[] {
  return Array.from(container.querySelectorAll<T>(selector));
}

function renderEditor(): void {
  act(() => {
    root.render(<ThemeEditor />);
  });
}

/**
 * `themeManager` 与 `settings` 都是模块级单例，不还原会渗到同文件后面的用例。
 * 用户主题留在 `userThemes` 里无害 —— 选择回到默认预设后 `activeTheme` 就不是它了。
 */
function resetTheme(): void {
  settings.set('appearance.userTheme', null);
  applyThemeChoice(DEFAULT_THEME_CHOICE);
}

describe('主题编辑器 · 数据表', () => {
  it('43 个 token 不重不漏，且与主题实际的 token 集合一致', () => {
    expect(ALL_EDITABLE_TOKENS).toHaveLength(43);
    expect(new Set(ALL_EDITABLE_TOKENS).size).toBe(43);
    expect([...ALL_EDITABLE_TOKENS].sort()).toEqual(Object.keys(themeManager.theme.tokens).sort());
  });

  it('16 个种子分成灰阶与强调色两组，各 8 个且不重不漏', () => {
    const slots = SEED_GROUPS.flatMap((group) => group.slots);
    expect(slots).toHaveLength(16);
    expect(new Set(slots).size).toBe(16);
    expect(Object.keys(SLOT_ROLE_KEYS).sort()).toEqual([...slots].sort());
  });

  /** 滑块键与派生用的系数键必须同源 —— 少一个就等于有一个系数在界面上改不了。 */
  it('五个滑块的键与 defaultTuning() 的键一一对应', () => {
    const keys = TUNING_FIELDS.map((field) => field.key).sort();
    expect(keys).toEqual(Object.keys(defaultTuning('light')).sort());
  });
});

describe('主题编辑器 · toColorInputValue', () => {
  it('3 / 4 / 6 位十六进制都归一化到 #rrggbb', () => {
    expect(toColorInputValue('#abc')).toBe('#aabbcc');
    expect(toColorInputValue('#abcd')).toBe('#aabbcc');
    expect(toColorInputValue('#AABBCC')).toBe('#aabbcc');
  });

  /** 取色器没有透明度通道，8 位的 alpha 只能丢掉 —— 丢掉是显式的，用户看得见结果。 */
  it('8 位十六进制丢掉 alpha', () => {
    expect(toColorInputValue('#11223344')).toBe('#112233');
  });

  it('rgba() 只取三个通道，且夹到 0–255', () => {
    expect(toColorInputValue('rgba(17, 34, 51, 0.4)')).toBe('#112233');
    expect(toColorInputValue('rgb(300, -5, 51)')).toBe('#ff0033');
  });

  it('认不出的写法回落到兜底值，而不是把取色器留成黑色', () => {
    expect(toColorInputValue('hsl(200 50% 50%)')).toBe('#000000');
    expect(toColorInputValue('')).toBe('#000000');
  });
});

describe('主题编辑器 · 基础档', () => {
  beforeEach(() => {
    resetTheme();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetTheme();
  });

  it('默认是基础档：16 个取色器 + 5 个滑块，没有 token 行', () => {
    renderEditor();

    expect(el('[data-theme-tier-panel="basic"]')).not.toBeNull();
    expect(all('[data-theme-seed]')).toHaveLength(16);
    expect(all('[data-theme-tuning]')).toHaveLength(5);
    expect(all('[data-theme-token]')).toHaveLength(0);
    expect(el('[data-theme-tier="basic"]')?.getAttribute('aria-selected')).toBe('true');
  });

  /**
   * 内置主题不可写，所以这一条同时覆盖三件事：改种子先 fork 成用户主题、派生重跑、两者一起落盘。
   * 判据用**派生出的 token 值**而不是「有没有调用过某函数」。
   */
  it('拖一个系数滑块：fork 出用户主题、token 跟着变、落盘', () => {
    renderEditor();
    const before = themeManager.theme.tokens['bg-surface-hover'];

    act(() => {
      setInputValue(el<HTMLInputElement>('[data-theme-tuning="surfaceHover"]')!, '0.4');
    });

    const saved = settings.get('appearance.userTheme');
    expect(saved?.id.startsWith('user:')).toBe(true);
    expect(saved?.scheme.tuning?.surfaceHover).toBe(0.4);
    expect(themeManager.themeChoice).toBe(saved?.id);
    expect(themeManager.theme.tokens['bg-surface-hover']).not.toBe(before);
  });

  it('改一个种子：只动那个槽位，其余 token 仍是派生值', () => {
    renderEditor();
    const before = { ...themeManager.theme.tokens };
    const otherSlot = themeManager.activeScheme?.palette.base01;

    act(() => {
      setInputValue(el<HTMLInputElement>('[data-theme-seed="base00"]')!, '#101010');
    });

    const saved = settings.get('appearance.userTheme');
    expect(saved?.scheme.palette.base00).toBe('#101010');
    expect(saved?.scheme.palette.base01).toBe(otherSlot);
    // base00 直喂 bg-canvas（不做混合），所以它等于种子本身。
    expect(themeManager.theme.tokens['bg-canvas']).toBe('#101010');
    // 不参与修正、也不吃 base00 的 token 一律不变 —— 改一个种子不等于换一套主题。
    // （语法色会随 `binding` 的对比度修正目标一起挪，不能拿来当判据。）
    expect(themeManager.theme.tokens['border-default']).toBe(before['border-default']);
    expect(themeManager.theme.tokens['bg-surface']).toBe(before['bg-surface']);
  });

  /** 高级档动过的项切回基础档不能静默消失 —— 提示条是它唯一的出口。 */
  it('切回基础档时覆盖项提示条还在，条数正确', () => {
    renderEditor();

    act(() => {
      el<HTMLButtonElement>('[data-theme-tier="advanced"]')!.click();
    });
    act(() => {
      setInputValue(el<HTMLInputElement>('[data-theme-token-input="bg-canvas"]')!, '#101010');
    });
    act(() => {
      el<HTMLButtonElement>('[data-theme-tier="basic"]')!.click();
    });

    expect(el('[data-theme-tier-panel="basic"]')).not.toBeNull();
    expect(el('[data-override-banner]')?.getAttribute('data-override-banner')).toBe('1');
  });
});

describe('主题编辑器 · 高级档', () => {
  beforeEach(() => {
    resetTheme();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetTheme();
  });

  function openAdvanced(): void {
    renderEditor();
    act(() => {
      el<HTMLButtonElement>('[data-theme-tier="advanced"]')!.click();
    });
  }

  it('切到高级档：43 个 token 行，种子与滑块消失', () => {
    openAdvanced();

    expect(el('[data-theme-tier-panel="advanced"]')).not.toBeNull();
    expect(all('[data-theme-token]')).toHaveLength(43);
    expect(all('[data-theme-seed]')).toHaveLength(0);
    expect(el('[data-theme-tier="advanced"]')?.getAttribute('aria-selected')).toBe('true');
  });

  it('改一个 token 就是覆盖项：标记、提示条、token 值三处同时变', () => {
    openAdvanced();

    act(() => {
      setInputValue(el<HTMLInputElement>('[data-theme-token-input="bg-canvas"]')!, '#101010');
    });

    expect(themeManager.theme.tokens['bg-canvas']).toBe('#101010');
    expect(el('[data-theme-token="bg-canvas"]')?.getAttribute('data-overridden')).toBe('true');
    expect(el('[data-override-banner]')).not.toBeNull();
  });

  it('覆盖项的重置按钮只出现在被覆盖的那一行，点完覆盖项消失', () => {
    openAdvanced();
    expect(el('[data-theme-token-reset="bg-canvas"]')).toBeNull();

    act(() => {
      setInputValue(el<HTMLInputElement>('[data-theme-token-input="bg-canvas"]')!, '#101010');
    });
    expect(all('[data-theme-token-reset]')).toHaveLength(1);

    act(() => {
      el<HTMLButtonElement>('[data-theme-token-reset="bg-canvas"]')!.click();
    });

    expect(themeManager.overrides['bg-canvas']).toBeUndefined();
    expect(el('[data-theme-token-reset="bg-canvas"]')).toBeNull();
    expect(el('[data-override-banner]')).toBeNull();
  });

  /** 只修正不说，用户不知道自己改的种子被动了；只说不修正，用户会存下一个不可读的主题。 */
  it('覆盖项不参与修正，不达标时标出实际比值', () => {
    openAdvanced();
    expect(el('[data-theme-token="text-primary"] [data-contrast="fail"]')).toBeNull();

    act(() => {
      setInputValue(el<HTMLInputElement>('[data-theme-token-input="text-primary"]')!, '#fefefe');
    });

    const marked = el('[data-theme-token="text-primary"] [data-contrast="fail"]');
    expect(marked).not.toBeNull();
    // 手写的值原样生效 —— 修正不越过覆盖项。
    expect(themeManager.theme.tokens['text-primary']).toBe('#fefefe');
  });

  it('预览区渲染的是真组件与真编辑器', () => {
    renderEditor();

    expect(el('[data-theme-preview]')).not.toBeNull();
    expect(el('[data-theme-preview-input]')).not.toBeNull();
    expect(el('.nexus-theme-preview .nexus-settings-option')).not.toBeNull();
    // 真 CodeMirror 视图（`createSourceEditorView`）会往宿主里塞 `.cm-editor`。
    expect(el('[data-theme-preview-code] .cm-editor')).not.toBeNull();
  });
});
