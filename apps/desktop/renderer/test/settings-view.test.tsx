// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILT_IN_THEMES, SYSTEM_THEME } from '@nexus/theme';
import { SettingsView } from '../src/settings/SettingsView.js';
import { FIELDS, SECTIONS, THEME_FIELD, optionLabel, projectMenuItems } from '../src/settings/registry.js';
import { useSettingsSection, type SettingsSectionState } from '../src/settings/use-settings-section.js';
import { settings, themeManager } from '../src/platform.js';

/**
 * 设置本体与 Appearance 分组的渲染（P4-03 / P4-04）。
 *
 * 为什么这一层要有用例：真机用例一个文件只能启动一次 Electron、只跑一种形状，覆盖不到
 * 「空态 / 键盘 / 三态选中」这些分支。这里用组件自己的状态属性做判据（`data-*`、`aria-checked`），
 * **不用文案节点** —— 加载态与空态常共用同一个类名，文案还会随 locale 变。
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

function themeOption(value: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-theme-option="${value}"]`);
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
    settings.set('appearance.theme', SYSTEM_THEME);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    settings.set('appearance.theme', SYSTEM_THEME);
  });

  it('主题选项 = 跟随系统 + 全部出厂主题，顺序与出厂表一致', () => {
    renderSettings();

    expect(
      Array.from(container.querySelectorAll('[data-theme-option]')).map((el) =>
        el.getAttribute('data-theme-option')
      )
    ).toEqual([SYSTEM_THEME, ...BUILT_IN_THEMES.map((theme) => theme.id)]);
  });

  /**
   * 这条是难点 1 的组件级回归网：把选择改成与解析结果**不同**的具体主题，选中态必须落在
   * 选择上。若组件改回按 `theme.type`（解析结果）判定，亮的会是另一项，这里就红。
   */
  it('选中态看「选择」而不是解析结果', () => {
    const resolved = themeManager.theme.id;
    const other = resolved === 'nexus-dark' ? 'nexus-light' : 'nexus-dark';

    settings.set('appearance.theme', other); // 只改选择，不动 ThemeManager
    expect(themeManager.theme.id).toBe(resolved);

    renderSettings();

    expect(themeOption(other)?.getAttribute('aria-checked')).toBe('true');
    expect(themeOption(resolved)?.getAttribute('aria-checked')).toBe('false');
  });

  it('点一个选项立刻生效并落盘（没有保存按钮）', () => {
    renderSettings();

    act(() => {
      themeOption('nexus-dark')?.click();
    });

    expect(themeManager.theme.id).toBe('nexus-dark');
    expect(settings.get('appearance.theme')).toBe('nexus-dark');
    expect(localStorage.getItem('nexus-theme')).toBe('nexus-dark');
    expect(themeOption('nexus-dark')?.getAttribute('aria-checked')).toBe('true');
  });

  it('选「跟随系统」时存档写哨兵值，而不是当时的解析结果', () => {
    renderSettings();
    act(() => {
      themeOption('nexus-dark')?.click();
    });
    act(() => {
      themeOption(SYSTEM_THEME)?.click();
    });

    expect(settings.get('appearance.theme')).toBe(SYSTEM_THEME);
    expect(localStorage.getItem('nexus-theme')).toBe(SYSTEM_THEME);
  });

  /**
   * 卡片上要能**扫视着选**：圆点是这套主题的主色，配色条是它的背景 → 正文 → 主色跨度。
   * 「跟随系统」没有单一主色，所以圆点两半、配色条八段 —— 这两个数字是刻意的，
   * 不是实现细节（改成一个实心圆点等于说它有确定的主色）。
   */
  it('每张主题卡都有圆点与配色条，跟随系统是两半 + 八段', () => {
    renderSettings();

    const cards = Array.from(container.querySelectorAll<HTMLElement>('[data-theme-option]'));
    expect(cards).toHaveLength(1 + BUILT_IN_THEMES.length);

    for (const card of cards) {
      const id = card.dataset.themeOption ?? '';
      const system = id === SYSTEM_THEME;
      expect(card.querySelectorAll('.nexus-theme-card-segment').length, id).toBe(system ? 8 : 4);
      expect(card.querySelectorAll('.nexus-theme-card-half').length, id).toBe(system ? 2 : 1);
    }
  });

  /**
   * 描述是**可选**的（缺字典键就不画这一行），所以「出厂主题一张都不缺」这件事得有用例守着 ——
   * 新增一套出厂主题却忘了写描述时，这里会红，而不是静默少一行文案。
   */
  it('每张主题卡都有非空的一句话描述', () => {
    renderSettings();

    const described = Array.from(
      container.querySelectorAll('[data-theme-option] .nexus-theme-card-description')
    ).map((el) => (el.textContent ?? '').trim());

    expect(described).toHaveLength(1 + BUILT_IN_THEMES.length);
    expect(described.every((text) => text.length > 0)).toBe(true);
  });

  /**
   * 「无保存 / 无恢复默认」的判据用**按钮的种类**而不是文案：页面里每个按钮都必须落进一份
   * 已知清单（导航项 / 主题选项 / 档位页签 / 导入导出 / 预览区）。文案会随语言变，多一个按钮
   * 却是结构性的 —— 出现 `other` 就意味着有人往设置页里塞了提交类控件，必须显式解释。
   *
   * 「返回工作区」那一类**已随独立窗口一并删掉**：窗口自己有标题栏关闭键，Escape 也能关，
   * 再留一个页内返回键就是第三个关闭入口。
   */
  it('页面里没有保存 / 提交 / 恢复默认控件', () => {
    renderSettings();

    const kinds = Array.from(container.querySelectorAll('button')).map((button) => {
      if (button.dataset.section) return 'nav';
      if (button.dataset.themeOption) return 'option';
      if (button.dataset.themeTier) return 'tier';
      if (button.dataset.themeImportButton !== undefined || button.dataset.themeExport) {
        return 'transfer';
      }
      if (button.closest('[data-theme-preview]')) return 'preview';
      return 'other';
    });

    expect(kinds).not.toContain('other');
    expect(kinds.filter((kind) => kind === 'nav')).toHaveLength(SECTIONS.length);
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

  it('装所有 menu: true 的字段，主题项 = 跟随系统 + 五套出厂主题', () => {
    const labels = projectMenuItems({ t, onOpenSettings: () => {} })
      .filter((item) => !item.separator)
      .map((item) => item.label);

    expect(labels).toEqual([
      'theme.option.system',
      ...BUILT_IN_THEMES.map((theme) => theme.name),
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
   * 判据不能按 `label.startsWith('theme.option.')` 过滤 —— 阶段 D 之后主题项显示的是主题
   * 自己的名字（`Dracula`），只有「跟随系统」还挂着字典键。改成按**字段声明的选项**反查。
   */
  it('主题的 active 取「选择」而不是解析结果', () => {
    const resolved = themeManager.theme.id;
    const other = resolved === 'nexus-dark' ? 'nexus-light' : 'nexus-dark';
    settings.set('appearance.theme', other); // 只改选择，不动 ThemeManager
    try {
      const valueOf = new Map(
        (THEME_FIELD.options ?? []).map((option) => [optionLabel(option, t), option.value])
      );
      const active = projectMenuItems({ t, onOpenSettings: () => {} })
        .filter((item) => item.active && valueOf.has(item.label))
        .map((item) => valueOf.get(item.label));

      expect(active).toEqual([other]);
    } finally {
      settings.set('appearance.theme', SYSTEM_THEME);
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
