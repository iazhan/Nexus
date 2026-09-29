// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILT_IN_PRESETS, DEFAULT_THEME_CHOICE } from '@nexus/theme';
import { translate } from '@nexus/i18n';
import { SettingsView } from '../src/settings/SettingsView.js';
import {
  FIELDS,
  SECTIONS,
  THEME_MODE_FIELD,
  optionLabel,
  projectMenuItems
} from '../src/settings/registry.js';
import { useSettingsSection, type SettingsSectionState } from '../src/settings/use-settings-section.js';
import { applyThemeChoice, localeManager, settings, themeManager } from '../src/platform.js';

/**
 * 设置本体与 Appearance 分组的渲染（P4-03 / P4-04）。
 *
 * 为什么这一层要有用例：真机用例一个文件只能启动一次 Electron、只跑一种形状，覆盖不到
 * 「空态 / 键盘 / 两轴选中 / 搜索过滤」这些分支。这里用组件自己的状态属性做判据（`data-*`、
 * `aria-checked`），**不用文案节点** —— 加载态与空态常共用同一个类名，文案还会随 locale 变。
 *
 * 外观分组现在是**两轴**：模式（浅色 / 自动 / 深色）× 预设（族）。两轴各有自己的选中态判据，
 * 所以「选中态看选择而不是解析结果」这条要**各测一次** —— 解析结果只有一个，两轴都可能与它不一致。
 *
 * 设置是独立窗口之后，**「关窗」「Escape」不在这里测** —— 那是 `SettingsWindow` 的事，
 * 见 `settings-window.test.tsx`。本文件只管 `SettingsView` 自己（导航 + 内容区）。
 *
 * 注意 `renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function renderSettings(section = 'appearance'): void {
  act(() => {
    root.render(<SettingsView section={section} onSelectSection={() => {}} />);
  });
}

function navItems(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.nexus-settings-nav [data-section]'));
}

/** 预设卡片。值是**预设 id**（族名），不是方案 id。 */
function presetOptions(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-theme-option]'));
}

function presetOption(value: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-theme-option="${value}"]`);
}

function modeOption(value: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-theme-mode="${value}"]`);
}

/** React 的 `onChange` 挂在原生 `input` 事件上；直接改 `.value` 不触发它。 */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('设置视图 · 左栏', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('七组全显示，六组标 planned、只有 appearance 可用', () => {
    renderSettings();

    expect(navItems()).toHaveLength(SECTIONS.length);
    expect(container.querySelectorAll('[data-availability="planned"]')).toHaveLength(6);

    const available = navItems().filter(
      (item) => item.dataset.availability === 'available'
    );
    expect(available.map((item) => item.dataset.section)).toEqual(['appearance']);
  });

  it('未实现的分组**可以点**（点不动比空态更糟），内容区给空态', () => {
    renderSettings('general');

    expect(container.querySelector('[data-availability="planned"]')).not.toBeNull();
    expect(container.querySelector('.nexus-settings-empty')).not.toBeNull();
    expect(container.querySelector('[data-theme-option]')).toBeNull();
  });

  it('选中的分组只有一个，判据是 aria-selected', () => {
    renderSettings('appearance');

    const selected = navItems().filter((item) => item.getAttribute('aria-selected') === 'true');
    expect(selected.map((item) => item.dataset.section)).toEqual(['appearance']);
  });
});

describe('设置视图 · Appearance', () => {
  beforeEach(() => {
    settings.set('appearance.userTheme', null);
    applyThemeChoice(DEFAULT_THEME_CHOICE);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    settings.set('appearance.userTheme', null);
    applyThemeChoice(DEFAULT_THEME_CHOICE);
  });

  it('预设列表 = 全部出厂预设，顺序与出厂表一致', () => {
    renderSettings();

    expect(presetOptions().map((el) => el.dataset.themeOption)).toEqual(
      BUILT_IN_PRESETS.map((preset) => preset.id)
    );
  });

  /**
   * 这条是难点 1 的组件级回归网：把选择改成与解析结果**不同**的预设，选中态必须落在选择上。
   * 若组件改回按 `themeManager.theme.id`（解析结果）判定，亮的会是 `nexus`，这里就红。
   */
  it('预设选中态看「选择」而不是解析结果', () => {
    settings.set('appearance.theme', 'dracula@dark'); // 只改选择，不动 ThemeManager
    expect(themeManager.theme.id).toBe('nexus-light');

    renderSettings();

    expect(presetOption('dracula')?.getAttribute('aria-checked')).toBe('true');
    expect(presetOption('nexus')?.getAttribute('aria-checked')).toBe('false');
  });

  /**
   * 模式轴同样要按选择判 —— `nexus@dark` 与解析出的 `nexus-light` 不一致时，
   * 按解析结果判会让「浅色」亮着而存档里写着深色。
   */
  it('模式选中态看「选择」而不是解析结果', () => {
    settings.set('appearance.theme', 'nexus@dark'); // 只改选择，不动 ThemeManager
    expect(themeManager.theme.id).toBe('nexus-light');

    renderSettings();

    expect(modeOption('dark')?.getAttribute('aria-checked')).toBe('true');
    expect(modeOption('light')?.getAttribute('aria-checked')).toBe('false');
    expect(modeOption('auto')?.getAttribute('aria-checked')).toBe('false');
  });

  it('点一个预设立刻生效并落盘（没有保存按钮）', () => {
    renderSettings();

    act(() => {
      presetOption('dracula')?.click();
    });

    // `dracula` 上游只有暗版，模式被夹到它有的那一边。
    expect(themeManager.theme.id).toBe('dracula');
    expect(settings.get('appearance.theme')).toBe('dracula@dark');
    expect(localStorage.getItem('nexus-theme')).toBe('dracula@dark');
    expect(presetOption('dracula')?.getAttribute('aria-checked')).toBe('true');
  });

  it('换预设保留当前模式 —— 两轴互不覆盖', () => {
    settings.set('appearance.theme', 'nexus@dark'); // 只改选择
    renderSettings();

    act(() => {
      presetOption('nord')?.click();
    });

    expect(settings.get('appearance.theme')).toBe('nord@dark');
    expect(themeManager.theme.id).toBe('nord');
  });

  it('点「自动」时存档写自动，而不是当时的解析结果', () => {
    settings.set('appearance.theme', 'nexus@dark');
    renderSettings();

    act(() => {
      modeOption('auto')?.click();
    });

    expect(settings.get('appearance.theme')).toBe(DEFAULT_THEME_CHOICE);
    expect(localStorage.getItem('nexus-theme')).toBe(DEFAULT_THEME_CHOICE);
    expect(modeOption('auto')?.getAttribute('aria-checked')).toBe('true');
  });

  /**
   * 单变体预设（上游只出一版）没有另一边可切。**禁用 + 说明原因**，而不是让它按下去跳到
   * 别的预设 —— 那等于把用户选的主题丢掉，而且看起来像「按钮坏了」。
   */
  it('单变体预设上模式控件禁用并给出原因，双变体预设上可用', () => {
    settings.set('appearance.theme', 'dracula@dark');
    renderSettings();

    const modes = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-theme-mode]'));
    expect(modes).toHaveLength(3);
    expect(modes.every((button) => button.disabled)).toBe(true);
    expect(container.querySelector('[data-mode-locked]')).not.toBeNull();

    act(() => {
      settings.set('appearance.theme', 'nexus@dark');
    });

    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>('[data-theme-mode]')).every(
        (button) => !button.disabled
      )
    ).toBe(true);
    expect(container.querySelector('[data-mode-locked]')).toBeNull();
  });

  /**
   * 卡片上要能**扫视着选**：圆点是这套主题的主色，配色条是它的背景 → 正文 → 主色跨度。
   * 自动模式下每套预设没有单一配色，圆点两半、条八段；单变体预设只有一套，一半、四段。
   * 这两个数字是刻意的，不是实现细节（改成一个实心圆点等于说它有确定的主色）。
   */
  it('每张预设卡都有圆点与配色条，段数由变体数决定', () => {
    renderSettings();

    const cards = presetOptions();
    expect(cards).toHaveLength(BUILT_IN_PRESETS.length);

    for (const card of cards) {
      const id = card.dataset.themeOption ?? '';
      const preset = BUILT_IN_PRESETS.find((candidate) => candidate.id === id);
      const both = Boolean(preset?.variants.light && preset?.variants.dark);
      expect(card.querySelectorAll('.nexus-theme-card-half').length, id).toBe(both ? 2 : 1);
      expect(card.querySelectorAll('.nexus-theme-card-segment').length, id).toBe(both ? 8 : 4);
    }
  });

  /**
   * 描述只画**当前预设**那一条，不画在每张卡上：五十多个预设里只有少数写了描述，逐卡画会让
   * 网格高度参差。所以判据是「有且只有一条，且与当前预设对得上」，而不是「每张卡都有」。
   */
  it('描述只画当前预设那一条，没有描述就不画', () => {
    renderSettings();

    const descriptions = container.querySelectorAll('[data-preset-description]');
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]?.textContent?.trim()).toBe(
      translate(localeManager.locale, 'theme.description.nexus')
    );

    // `atelier-cave` 没有描述键 —— 这一行整个不出现，而不是漏出键名。
    act(() => {
      presetOption('atelier-cave')?.click();
    });

    expect(container.querySelector('[data-preset-description]')).toBeNull();
  });

  it('搜索框按名字过滤预设，无匹配时给空态', () => {
    renderSettings();

    const input = container.querySelector<HTMLInputElement>('[data-theme-search]');
    expect(input).not.toBeNull();

    act(() => setInputValue(input!, 'Dracula'));
    expect(presetOptions().map((el) => el.dataset.themeOption)).toEqual(['dracula']);
    expect(container.querySelector('[data-theme-search-empty]')).toBeNull();

    act(() => setInputValue(input!, 'zzzz'));
    expect(presetOptions()).toHaveLength(0);
    expect(container.querySelector('[data-theme-search-empty]')).not.toBeNull();
  });

  /**
   * 「无保存 / 无恢复默认」的判据用**按钮的种类**而不是文案：页面里每个按钮都必须落进一份
   * 已知清单（导航项 / 模式段控 / 预设卡 / 档位页签 / 导入导出 / 预览区）。文案会随语言变，
   * 多一个按钮却是结构性的 —— 出现 `other` 就意味着有人往设置页里塞了提交类控件，必须显式解释。
   *
   * 「返回工作区」那一类**已随独立窗口一并删掉**：窗口自己有标题栏关闭键，Escape 也能关，
   * 再留一个页内返回键就是第三个关闭入口。
   */
  it('页面里没有保存 / 提交 / 恢复默认控件', () => {
    renderSettings();

    const kinds = Array.from(container.querySelectorAll('button')).map((button) => {
      if (button.dataset.section) return 'nav';
      if (button.dataset.themeMode) return 'mode';
      if (button.dataset.themeOption) return 'preset';
      if (button.dataset.themeTier) return 'tier';
      if (button.dataset.themeImportButton !== undefined || button.dataset.themeExport) {
        return 'transfer';
      }
      if (button.closest('[data-theme-preview]')) return 'preview';
      return 'other';
    });

    expect(kinds).not.toContain('other');
    expect(kinds.filter((kind) => kind === 'nav')).toHaveLength(SECTIONS.length);
    expect(kinds.filter((kind) => kind === 'mode')).toHaveLength(3);
    expect(kinds.filter((kind) => kind === 'tier')).toHaveLength(2);
  });
});

describe('设置视图 · 键盘', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('上下键在七项之间移动焦点', () => {
    renderSettings();
    const items = navItems();
    items[0]?.focus();

    act(() => {
      items[0]?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
      );
    });

    expect(document.activeElement).toBe(items[1]);
  });
});

describe('设置分组状态', () => {
  let latest: SettingsSectionState | null = null;

  const Probe: React.FC = () => {
    latest = useSettingsSection();
    return null;
  };

  beforeEach(() => {
    latest = null;
    settings.set('settings.lastSection', 'appearance');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<Probe />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    settings.set('settings.lastSection', 'appearance');
  });

  it('切分组写进 settings.lastSection', () => {
    act(() => latest?.selectSection('editor'));

    expect(latest?.section).toBe('editor');
    expect(settings.get('settings.lastSection')).toBe('editor');
    expect(localStorage.getItem('nexus-settings-section')).toBe('editor');
  });

  it('存档里是认不出的分组时回落到默认分组', () => {
    // 直接 set 会被 store 的订阅驱动重渲染 —— 放进 act 才不会刷更新警告。
    act(() => {
      settings.set('settings.lastSection', 'nonsense');
    });

    expect(latest?.section).toBe('appearance');
  });
});

describe('菜单投影', () => {
  const t = (key: string): string => key;

  /**
   * 菜单里只有**模式轴**（三项，是「现在想亮一点」这种即时动作）。五十多个预设列进去等于把
   * 菜单变成浏览器 —— 它的入口是设置窗口里那条可搜索的列表，菜单里留一条「设置…」就够。
   */
  it('装所有 menu: true 的字段：模式三项 + 语言两项 + mermaid', () => {
    const labels = projectMenuItems({ t, onOpenSettings: () => {} })
      .filter((item) => !item.separator)
      .map((item) => item.label);

    expect(labels).toEqual([
      'theme.mode.light',
      'theme.mode.auto',
      'theme.mode.dark',
      'lang.zhCN',
      'lang.enUS',
      'mermaid.clickToReveal',
      'cmd.openSettings'
    ]);
  });

  /** 项数与字段声明同源 —— 投影漏掉某个字段时这里会红，而不是静默少一项。 */
  it('项数等于所有 menu 字段声明的选项数之和', () => {
    const expected =
      FIELDS.filter((field) => field.menu).reduce(
        (count, field) =>
          count + (field.control === 'toggle' ? 1 : (field.options?.length ?? 0)),
        0
      ) + 1; // 末尾的「设置…」

    const actual = projectMenuItems({ t, onOpenSettings: () => {} }).filter(
      (item) => !item.separator
    ).length;

    expect(actual).toBe(expected);
  });

  /**
   * `active` 取 `accessor.read()` —— 也就是**选择**，不是解析结果。否则自动模式（系统浅色）下
   * 「浅色」会与「自动」同时点亮。
   */
  it('模式的 active 取「选择」而不是解析结果', () => {
    applyThemeChoice(DEFAULT_THEME_CHOICE); // 自动
    settings.set('appearance.theme', 'nexus@dark'); // 只改选择，不动 ThemeManager
    expect(themeManager.theme.id).toBe('nexus-light');

    try {
      const valueOf = new Map(
        (THEME_MODE_FIELD.options ?? []).map((option) => [optionLabel(option, t), option.value])
      );
      const active = projectMenuItems({ t, onOpenSettings: () => {} })
        .filter((item) => item.active && valueOf.has(item.label))
        .map((item) => valueOf.get(item.label));

      expect(active).toEqual(['dark']);
    } finally {
      applyThemeChoice(DEFAULT_THEME_CHOICE);
    }
  });

  it('末尾固定有「设置…」，点了会开设置页', () => {
    let opened = 0;
    const items = projectMenuItems({ t, onOpenSettings: () => { opened += 1; } });

    const last = items[items.length - 1];
    expect(last?.label).toBe('cmd.openSettings');
    last?.onSelect?.();
    expect(opened).toBe(1);
  });
});
