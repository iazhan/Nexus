// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_PRESETS, BUILT_IN_SCHEMES, DEFAULT_THEME_CHOICE } from '@nexus/theme';
import { formatShortcut } from '@nexus/command';
import { translate } from '@nexus/i18n';
import type { DiagnosticsReport } from '../../ipc/channels.js';
import { SettingsView } from '../src/settings/SettingsView.js';
import { REMAPPABLE_ACTIONS, resolveShortcut } from '../src/keybindings.js';
import {
  FIELDS,
  SECTIONS,
  THEME_MODE_FIELD,
  optionLabel,
  projectMenuItems
} from '../src/settings/registry.js';
import { useSettingsSection, type SettingsSectionState } from '../src/settings/use-settings-section.js';
import {
  applySchemePatch,
  applyThemeChoice,
  applyUserTheme,
  duplicateTheme,
  localeManager,
  settings,
  themeManager
} from '../src/platform.js';
import { PANEL_DEFAULT_WIDTH, PANEL_MAX_WIDTH } from '../src/workspace/panel-width.js';

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

/** 缩略图里的小窗，一扇一个。自动模式两扇（先暗后亮），显式模式一扇。 */
function thumbnails(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.nexus-theme-mini'));
}

/** 某张模式卡片里的窗。 */
function modeThumbnails(value: string): HTMLElement[] {
  const card = modeOption(value);
  return card ? thumbnails(card) : [];
}

/** 一扇小窗的底色（`bg-canvas` = `base00`）。判「是不是这套预设的真实配色」靠它，比断言色值稳。 */
function windowBackground(window: HTMLElement | undefined): string {
  return window?.style.backgroundColor ?? '';
}

/** 缩略图第一扇窗的底色。 */
function thumbnailBackground(value: string): string {
  return windowBackground(modeThumbnails(value)[0]);
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

  it('八组全显示，两组标 planned、其余可用', () => {
    renderSettings();

    expect(navItems()).toHaveLength(SECTIONS.length);
    expect(container.querySelectorAll('[data-availability="planned"]')).toHaveLength(2);

    const available = navItems().filter(
      (item) => item.dataset.availability === 'available'
    );
    expect(available.map((item) => item.dataset.section)).toEqual([
      'general',
      'editor',
      'files',
      'appearance',
      'keybindings',
      'data'
    ]);
  });

  it('未实现的分组**可以点**（点不动比空态更糟），内容区给空态', () => {
    renderSettings('sync');

    expect(container.querySelector('[data-availability="planned"]')).not.toBeNull();
    expect(container.querySelector('.nexus-settings-empty')).not.toBeNull();
    expect(container.querySelector('[data-field]')).toBeNull();
  });

  it('选中的分组只有一个，判据是 aria-selected', () => {
    renderSettings('appearance');

    const selected = navItems().filter((item) => item.getAttribute('aria-selected') === 'true');
    expect(selected.map((item) => item.dataset.section)).toEqual(['appearance']);
  });
});

describe('设置视图 · Appearance', () => {
  beforeEach(() => {
    settings.set('appearance.userThemes', []);
    applyThemeChoice(DEFAULT_THEME_CHOICE);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    settings.set('appearance.userThemes', []);
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
    settings.set('appearance.theme', 'nord@dark'); // 只改选择，不动 ThemeManager
    expect(themeManager.theme.id).toBe('nexus-light');

    renderSettings();

    expect(presetOption('nord')?.getAttribute('aria-checked')).toBe('true');
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
    settings.set('appearance.theme', 'nexus@light'); // 只改选择
    renderSettings();

    act(() => {
      presetOption('gruvbox')?.click();
    });

    expect(themeManager.theme.id).toBe('gruvbox-light');
    expect(settings.get('appearance.theme')).toBe('gruvbox@light');
    expect(localStorage.getItem('nexus-theme')).toBe('gruvbox@light');
    expect(presetOption('gruvbox')?.getAttribute('aria-checked')).toBe('true');
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
   * 内置预设**都是双变体** —— 生成器的白名单要求明暗两版齐全，缺一边就不让出厂。所以模式控件
   * 在内置预设上恒可用；「没有另一边可切」只剩用户主题那一种形状（见下面那条）。
   */
  it('内置预设都是双变体，模式控件可用', () => {
    renderSettings();

    const modes = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('[data-theme-mode]'));

    expect(modes()).toHaveLength(3);
    expect(modes().every((button) => !button.disabled)).toBe(true);
    expect(container.querySelector('[data-mode-locked]')).toBeNull();

    act(() => {
      settings.set('appearance.theme', 'gruvbox@dark');
    });

    expect(modes().every((button) => !button.disabled)).toBe(true);
    expect(container.querySelector('[data-mode-locked]')).toBeNull();
  });

  /**
   * 顺序是「跟随系统 / 浅色 / 深色」。**判据是 DOM 里的顺序**，不是注册表里的数组 ——
   * 顺序一旦被某处手抄一遍，菜单与卡片就会各说各话。
   */
  it('模式卡片按「跟随系统 / 浅色 / 深色」排列，每张都有图标', () => {
    renderSettings();

    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[data-theme-mode]')).map(
        (el) => el.dataset.themeMode
      )
    ).toEqual(['auto', 'light', 'dark']);

    // 三个模式是一根轴上的三个位置，没有图标就只剩三个词，读不出它们同属一组。
    for (const value of ['auto', 'light', 'dark']) {
      expect(modeOption(value)?.querySelector('.nexus-theme-mode-icon svg'), value).not.toBeNull();
    }
  });

  /**
   * 缩略图画的是**当前预设的真实种子**，不是一张给所有主题共用的示意图。
   *
   * 两条判据都不碰具体色值：亮卡与暗卡的底色必须不同（否则说明画的是一张共用图），换预设之后
   * 同一张卡的底色必须跟着变（否则说明种子没走到 DOM）。具体取哪几个槽位由
   * `theme-preview-schemes.test.ts` 守着。
   */
  it('缩略图取当前预设的种子，换预设跟着换', () => {
    renderSettings();

    const nexusLight = thumbnailBackground('light');
    expect(nexusLight).not.toBe('');
    expect(nexusLight).not.toBe(thumbnailBackground('dark'));

    act(() => {
      presetOption('nord')?.click();
    });

    expect(thumbnailBackground('light')).not.toBe(nexusLight);
  });

  /**
   * 自动模式两扇 = 两扇**完整**的主窗口并排，先暗后亮。不把一扇切成两半：那会读成「深色的壳
   * 配浅色的内容」—— 那是混搭，不是跟随系统。判据直接拿显式模式那两张卡的小窗底色来比，
   * 于是「自动 = 暗那扇 + 亮那扇」这件事被钉死，而不是只看扇数。
   */
  it('自动模式是两扇完整主窗口并排（先暗后亮），显式模式各一扇', () => {
    renderSettings();

    expect(modeThumbnails('auto')).toHaveLength(2);
    expect(modeThumbnails('light')).toHaveLength(1);
    expect(modeThumbnails('dark')).toHaveLength(1);

    const [first, second] = modeThumbnails('auto');
    expect(windowBackground(first)).toBe(windowBackground(modeThumbnails('dark')[0]));
    expect(windowBackground(second)).toBe(windowBackground(modeThumbnails('light')[0]));
    // 两扇底色必须真的不同，否则「先暗后亮」是空话。
    expect(windowBackground(first)).not.toBe(windowBackground(second));
  });

  /**
   * 缩略图要**像主窗口**，不是一块抽象的色块：标题栏 / 活动栏 / 侧栏 / 编辑区 / 状态栏五块
   * 缺一不可。真窗口那边对应 `.nexus-header-bar`、`.nexus-activity-bar`、`.nexus-activity-panel`、
   * `.nexus-main-content`、`.nexus-status-bar`。
   */
  it('每扇缩略图都是完整的主窗口：标题栏 / 活动栏 / 侧栏 / 编辑区 / 状态栏', () => {
    renderSettings();

    const parts = [
      'nexus-theme-mini-titlebar',
      'nexus-theme-mini-rail',
      'nexus-theme-mini-side',
      'nexus-theme-mini-editor',
      'nexus-theme-mini-status'
    ];

    for (const value of ['auto', 'light', 'dark']) {
      const windows = modeThumbnails(value);
      expect(windows.length, value).toBeGreaterThan(0);
      for (const window of windows) {
        for (const part of parts) {
          expect(window.querySelector(`.${part}`), `${value} / ${part}`).not.toBeNull();
        }
      }
    }
  });

  /** 单边主题只有一套种子，自动模式也就只有一扇窗 —— 「没得切」不用另画一个灰掉的占位。 */
  it('单边主题的自动卡片只有一扇窗', () => {
    applyUserTheme({
      id: 'user:single',
      variants: { light: BUILT_IN_SCHEMES.find((entry) => entry.id === 'gruvbox-light')!.scheme }
    });
    renderSettings();

    expect(modeThumbnails('auto')).toHaveLength(1);
  });

  /**
   * 选中勾是「选中」的第二条通道。只靠边框颜色区分的话，色觉障碍用户看不出选了哪一个 ——
   * 所以「有几枚勾」也是结构判据，不是装饰细节。
   */
  it('选中勾只画在选中的那张卡上', () => {
    settings.set('appearance.theme', 'nexus@dark');
    renderSettings();

    expect(modeOption('dark')?.querySelector('.nexus-theme-mode-check')).not.toBeNull();
    expect(modeOption('light')?.querySelector('.nexus-theme-mode-check')).toBeNull();
    expect(modeOption('auto')?.querySelector('.nexus-theme-mode-check')).toBeNull();
  });

  /**
   * 预设卡片与模式卡片**画同一种缩略图**：这张预设的主窗口长什么样。扫视着选靠的就是它 ——
   * 圆点加配色条只说得清「主色是什么」，说不清「打开一篇文档是什么感觉」。
   *
   * 扇数由变体数决定：自动模式下每套预设没有单一配色，画两扇（先暗后亮）；单变体预设只有
   * 一套，画一扇。判据同时要求每扇都是**完整的主窗口**，否则退化成一块色块也能过。
   */
  it('每张预设卡都画主窗口缩略图，扇数由变体数决定', () => {
    renderSettings();

    const cards = presetOptions();
    expect(cards).toHaveLength(BUILT_IN_PRESETS.length);

    for (const card of cards) {
      const id = card.dataset.themeOption ?? '';
      const preset = BUILT_IN_PRESETS.find((candidate) => candidate.id === id);
      const both = Boolean(preset?.variants.light && preset?.variants.dark);
      const windows = thumbnails(card);

      expect(windows.length, id).toBe(both ? 2 : 1);
      for (const window of windows) {
        expect(window.querySelector('.nexus-theme-mini-titlebar'), id).not.toBeNull();
        expect(window.querySelector('.nexus-theme-mini-status'), id).not.toBeNull();
      }
    }
  });

  /**
   * 同一套预设的「自动」在模式那一排与在预设网格里各画一次，**两处必须是同一张画**。
   * 顺序相反（一边先暗、一边先亮）在肉眼看来就是画错了，而各自单独断言都是绿的。
   */
  it('模式卡片与预设卡片画同一张缩略图', () => {
    renderSettings();

    const inGrid = thumbnails(presetOption('nexus')!);
    const inModes = modeThumbnails('auto');

    expect(inGrid.map(windowBackground)).toEqual(inModes.map(windowBackground));
  });

  /**
   * 描述只画**当前预设**那一条，不画在每张卡上 —— 逐卡画会让网格高度参差。所以判据是
   * 「有且只有一条，且与当前预设对得上」，而不是「每张卡都有」。
   */
  it('描述只画当前预设那一条，没有描述就不画', () => {
    renderSettings();

    const descriptions = container.querySelectorAll('[data-preset-description]');
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]?.textContent?.trim()).toBe(
      translate(localeManager.locale, 'theme.description.nexus')
    );

    // 存档里指着一个**已经不存在的预设**（出厂表被整理过就会这样）—— 这一行整个不出现，
    // 而不是漏出 `theme.description.dracula` 这种键名。`has()` 那道判断就是为它留的。
    act(() => {
      settings.set('appearance.theme', 'dracula@dark');
    });

    expect(container.querySelector('[data-preset-description]')).toBeNull();
  });

  it('搜索框按名字过滤预设，无匹配时给空态', () => {
    renderSettings();

    const input = container.querySelector<HTMLInputElement>('[data-theme-search]');
    expect(input).not.toBeNull();

    act(() => setInputValue(input!, 'Gruvbox'));
    expect(presetOptions().map((el) => el.dataset.themeOption)).toEqual(['gruvbox']);
    expect(container.querySelector('[data-theme-search-empty]')).toBeNull();

    act(() => setInputValue(input!, 'zzzz'));
    expect(presetOptions()).toHaveLength(0);
    expect(container.querySelector('[data-theme-search-empty]')).not.toBeNull();
  });

  /**
   * 判据用**按钮的种类**而不是文案：页面里每个按钮都必须落进一份已知清单（导航项 / 模式段控 /
   * 预设卡 / 复制 / 新建 / 开主题窗口 / 导入导出 / 字段重置）。文案会随语言变，多一个按钮却是
   * 结构性的 —— 出现 `other` 就意味着有人往设置页里塞了提交类控件，必须显式解释。
   *
   * 「返回工作区」那一类**已随独立窗口一并删掉**：窗口自己有标题栏关闭键，Escape 也能关，
   * 再留一个页内返回键就是第三个关闭入口。编辑器那一整片控件（档位页签、取色器、预览）也**不在
   * 这里了** —— 它们跟着主题窗口一起搬走，清单里因此不再有 `tier` / `preview` 两类。
   *
   * **逐项重置有，全局「恢复默认」没有。** 重置键只画在 `resetValue` 非空、且当前值已偏离它的
   * 字段上（见 `FieldRow.tsx`）；外观这一页的两个轴都是枚举，一个重置键都不该有 ——
   * 所以下面那条 0 是断言，不是省略。
   */
  it('页面里没有保存 / 提交 / 全局恢复默认控件', () => {
    // 先挂一个用户主题：它要出现在预设列表里，不这么做「每张卡一枚复制键」的条数就对不上。
    duplicateTheme('nexus-light');
    renderSettings();

    const kinds = Array.from(container.querySelectorAll('button')).map((button) => {
      if (button.dataset.section) return 'nav';
      if (button.dataset.themeMode) return 'mode';
      if (button.dataset.themeOption) return 'preset';
      if (button.dataset.themeCopy !== undefined) return 'copy';
      if (button.dataset.themeEdit !== undefined) return 'edit';
      if (button.dataset.themeDelete !== undefined) return 'delete';
      if (button.dataset.themeNew !== undefined) return 'new';
      if (button.dataset.themeOpenWindow !== undefined) return 'open';
      if (button.dataset.themePasteApply !== undefined || button.dataset.themePasteClear !== undefined) {
        return 'paste';
      }
      if (
        button.dataset.themeMergeConfirm !== undefined ||
        button.dataset.themeMergeDismiss !== undefined
      ) {
        return 'merge';
      }
      if (button.dataset.themeImportButton !== undefined || button.dataset.themeExport) {
        return 'transfer';
      }
      if (button.dataset.fieldReset !== undefined) return 'reset';
      if (button.dataset.fieldMember !== undefined) return 'group';
      return 'other';
    });

    expect(kinds).not.toContain('other');
    expect(kinds.filter((kind) => kind === 'nav')).toHaveLength(SECTIONS.length);
    expect(kinds.filter((kind) => kind === 'mode')).toHaveLength(3);
    expect(kinds.filter((kind) => kind === 'new')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'open')).toHaveLength(1);
    // 每张卡一枚：全部出厂预设 + 刚造出来那份用户主题。
    expect(kinds.filter((kind) => kind === 'copy')).toHaveLength(BUILT_IN_PRESETS.length + 1);
    // 删除键与编辑键**只在用户主题的卡片上** —— 内置主题删不掉也改不动（改要先复制），
    // 给一个按了没反应的键只会让人以为它坏了。
    expect(kinds.filter((kind) => kind === 'delete')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'edit')).toHaveLength(1);
    // 粘贴框的「应用」常驻、「清空」在文本框非空时才出现 —— 初始只有一枚。
    expect(kinds.filter((kind) => kind === 'paste')).toHaveLength(1);
    // 这一份用户主题是从两变体预设 fork 出来的，没有「同名互补」的另一套可合并。
    expect(kinds.filter((kind) => kind === 'merge')).toHaveLength(0);
    // 开关组的每个成员一枚开关：界面元素两项（状态栏 / 标签页）+ 状态栏读数三项。
    expect(kinds.filter((kind) => kind === 'group')).toHaveLength(5);
    // 外观这一页的值控件全是枚举（模式 / 预设 / 缩放）与开关组，一个重置键都不该有。
    expect(kinds.filter((kind) => kind === 'reset')).toHaveLength(0);
  });

  /**
   * 每个分组都有图标，且**图形两两不同** —— 同一套里出现两枚一样的，用户就得回头读文字
   * 才能区分，那图标等于没加。
   *
   * 配色（默认 muted / 悬停 secondary / 选中 accent）是 CSS 的事，happy-dom 解不出自定义属性，
   * 所以这里只断言结构：每个分组都有一枚、尺寸一致、都是装饰性的（`aria-hidden`）。
   */
  it('八个分组各有图标，图形两两不同', () => {
    renderSettings();

    const items = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.nexus-settings-nav-item')
    );
    expect(items).toHaveLength(SECTIONS.length);

    const shapes = items.map((item) => {
      const svg = item.querySelector('.nexus-settings-nav-icon svg');
      expect(svg, item.dataset.section ?? '').not.toBeNull();
      expect(svg?.getAttribute('width'), item.dataset.section ?? '').toBe('16');
      // 图标是装饰：读屏念的是分组名，选中态由 `aria-selected` 表达。
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
      return svg?.innerHTML ?? '';
    });

    expect(new Set(shapes).size).toBe(SECTIONS.length);
  });
});

/**
 * 界面缩放。
 *
 * 它由 `AppearanceSection` 亲自渲染（外观分组是手写组件），但**判据仍然走通用字段行**的
 * `data-*` —— 控件本身是 `FieldRow`，只是挂在哪由分组决定。
 *
 * 「应用缩放」不在字段的 `write` 里，而是 `platform.ts` 的订阅；所以这里要断言的是
 * **桥被调到了**，而不只是存档写了。
 */
describe('设置视图 · 界面缩放', () => {
  let setUiZoom: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    settings.set('appearance.uiZoom', '100');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    setUiZoom = vi.fn();
    (window as unknown as { nexus: unknown }).nexus = { setUiZoom };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    settings.set('appearance.uiZoom', '100');
  });

  it('外观分组渲染出界面缩放，默认 100%', () => {
    renderSettings('appearance');

    const select = container.querySelector<HTMLSelectElement>(
      '[data-field-input="appearance.uiZoom"]'
    );
    expect(select).not.toBeNull();
    expect(select?.value).toBe('100');
    expect(settings.get('appearance.uiZoom')).toBe('100');
  });

  it('改档位写进存档，并把倍率交给桥', () => {
    renderSettings('appearance');

    const select = container.querySelector<HTMLSelectElement>(
      '[data-field-input="appearance.uiZoom"]'
    );
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select, '125');
      select?.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(settings.get('appearance.uiZoom')).toBe('125');
    // 桥收的是**档位字符串**，不是倍率 —— 换算那一步只有一份，在 `preload/ui-zoom.ts`
    // 里（renderer 侧的 `uiZoomFactor` 也是从那里转出来的）。
    expect(setUiZoom).toHaveBeenCalledWith('125');
  });

  it('存档里是认不出的档位时回落 100%', () => {
    // 存档是用户能改的：留一个渲染不出来的档位，表现是下拉框一个都不选中。
    localStorage.setItem('nexus-ui-zoom', '1000');
    settings.reload();

    expect(settings.get('appearance.uiZoom')).toBe('100');
    localStorage.removeItem('nexus-ui-zoom');
  });
});

/**
 * 开关组控件（`FieldRow.tsx` 的 `GroupControl`）—— `control: 'group'` 的第一个消费者。
 *
 * 这一层要盯的是**渲染方向**：取值域（`group-setting.test.ts`）只管「串 ↔ 集合」，
 * 它绿不代表控件把「勾上」画成了「显示」。判据取 `data-field-member` 与 `aria-checked`
 * —— 不取文案，文案随 locale 变。
 *
 * 接线（改了设置主窗口真的少一块）不在这一层，在 `apps/desktop/test/chrome-visibility.test.ts`。
 */
describe('设置视图 · 开关组（界面元素显隐 / 状态栏显示项）', () => {
  beforeEach(() => {
    settings.set('appearance.chromeVisibility', '');
    settings.set('appearance.statusBarMetrics', '');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    settings.set('appearance.chromeVisibility', '');
    settings.set('appearance.statusBarMetrics', '');
  });

  /** 一个开关组里的全部开关。 */
  function members(fieldId: string): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(`[data-field-member^="${fieldId}:"]`)
    );
  }

  function member(fieldId: string, name: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-field-member="${fieldId}:${name}"]`);
  }

  function isOn(el: HTMLElement | null): boolean {
    return el?.getAttribute('aria-checked') === 'true';
  }

  it('外观分组渲染出两组开关，成员数与取值域一致', () => {
    renderSettings('appearance');

    expect(members('appearance.chromeVisibility').map((el) => el.dataset.fieldMember)).toEqual([
      'appearance.chromeVisibility:statusBar',
      'appearance.chromeVisibility:tabBar'
    ]);
    expect(members('appearance.statusBarMetrics').map((el) => el.dataset.fieldMember)).toEqual([
      'appearance.statusBarMetrics:lineColumn',
      'appearance.statusBarMetrics:selection',
      'appearance.statusBarMetrics:format'
    ]);
  });

  it('默认（空串）全开：每个开关都是勾上的', () => {
    renderSettings('appearance');

    for (const el of members('appearance.statusBarMetrics')) {
      expect(isOn(el)).toBe(true);
    }
  });

  it('点一下开关写进存档的是「**被关掉的**」，不是「开着的」', () => {
    renderSettings('appearance');

    act(() => member('appearance.statusBarMetrics', 'selection')?.click());

    // 存档里只有被关掉的那一个 —— 存「开着的」会让空串变成「全关」，
    // 而空串是这一组的默认值。
    expect(settings.get('appearance.statusBarMetrics')).toBe('selection');
    expect(isOn(member('appearance.statusBarMetrics', 'selection'))).toBe(false);
    expect(isOn(member('appearance.statusBarMetrics', 'lineColumn'))).toBe(true);
  });

  it('再点一下打开，回到空串', () => {
    renderSettings('appearance');

    act(() => member('appearance.statusBarMetrics', 'format')?.click());
    expect(settings.get('appearance.statusBarMetrics')).toBe('format');

    act(() => member('appearance.statusBarMetrics', 'format')?.click());
    expect(settings.get('appearance.statusBarMetrics')).toBe('');
  });

  it('存档里已有隐藏项时开关跟着灭（另一个窗口改的也算）', () => {
    renderSettings('appearance');

    act(() => settings.set('appearance.chromeVisibility', 'tabBar'));

    expect(isOn(member('appearance.chromeVisibility', 'tabBar'))).toBe(false);
    expect(isOn(member('appearance.chromeVisibility', 'statusBar'))).toBe(true);
  });

  /**
   * 失败方向：整串认不出时**全开**，不是全关。这条在视图层也要有一份 ——
   * 取值域那份证明了 `parse` 返回空串，这一份证明控件不会把坏值画成「全都关掉」
   * （那是一个用户再也点不回来的界面）。
   */
  it('存档里是认不出的成员时按「显示」处理', () => {
    act(() => settings.set('appearance.statusBarMetrics', 'garbage'));

    renderSettings('appearance');

    expect(settings.get('appearance.statusBarMetrics')).toBe('');
    for (const el of members('appearance.statusBarMetrics')) {
      expect(isOn(el)).toBe(true);
    }
  });

  /**
   * 不给重置键，判据与枚举项同一条（见 `FieldDef.resetValue`）：**重置的代价是否高于手动还原**。
   * 谁被关掉了就画在旁边那个开关上，点回来即可 —— 代价不比点一次重置高。
   *
   * 这条同时钉住「别顺手给组加个 `resetValue: ''`」：加了之后每组都会多一枚「恢复显示全部」，
   * 而那正是 `FieldDef.resetValue` 那条规矩要避免的噪音。
   */
  it('开关组不画重置键 —— 被关掉的成员就画在旁边，点回来即可', () => {
    act(() => settings.set('appearance.chromeVisibility', 'statusBar'));

    renderSettings('appearance');

    expect(container.querySelector('[data-field-reset="appearance.chromeVisibility"]')).toBeNull();
    expect(container.querySelector('[data-field-reset="appearance.statusBarMetrics"]')).toBeNull();
  });
});

/**
 * 通用字段行（`FieldRow.tsx`）。
 *
 * 分组内容由 `FIELDS` 派生，不再是每个分组一份手写 JSX —— 这条链路里，面板宽度是第一个
 * 消费者，也是「数值项给逐项重置」的第一个样本。
 */
describe('设置视图 · Editor', () => {
  /**
   * 外观项会被写进 `documentElement` 的样式，而那是**跨用例共享**的全局状态 ——
   * 不还原的话「改了字号」这条会污染后面所有读变量的用例。
   */
  function resetEditorAppearance(): void {
    settings.set('editor.panelWidth', PANEL_DEFAULT_WIDTH);
    settings.set('editor.fontSize', 14);
    settings.set('editor.lineHeight', 1.6);
    settings.set('editor.paragraphSpacing', 0);
    settings.set('editor.contentWidth', 'none');
    settings.set('editor.fontFamily', 'default');
    settings.set('editor.codeBlockLineNumbers', true);
    settings.set('editor.tableLayout', 'auto');
    settings.set('editor.lineNumbers', true);
    settings.set('editor.wordCount', true);
    settings.set('editor.typewriterMode', false);
    settings.set('editor.vimKeybindings', false);
    settings.set('editor.spellCheck', false);
    settings.set('general.autoSaveDelay', 800);
    settings.set('general.externalChange', 'smart');
  }

  beforeEach(() => {
    resetEditorAppearance();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetEditorAppearance();
  });

  it('编辑器分组渲染字段表里的字段（mermaid 开关 + 排版 + 面板宽度）', () => {
    renderSettings('editor');

    expect(container.querySelector('[data-field="editor.mermaidClickToReveal"]')).not.toBeNull();
    expect(container.querySelector('[data-field="editor.codeBlockLineNumbers"]')).not.toBeNull();
    expect(container.querySelector('[data-field="editor.panelWidth"]')).not.toBeNull();
    expect(container.querySelector('[data-field="editor.tableLayout"]')).not.toBeNull();
    expect(container.querySelector('[data-field="editor.lineNumbers"]')).not.toBeNull();
    expect(container.querySelector('[data-field="editor.wordCount"]')).not.toBeNull();
  });

  it('改面板宽度立刻写进存档 —— 主窗口据此跟随，没有保存按钮', () => {
    renderSettings('editor');

    const input = container.querySelector<HTMLInputElement>('[data-field-input="editor.panelWidth"]');
    act(() => setInputValue(input as HTMLInputElement, '320'));

    expect(settings.get('editor.panelWidth')).toBe(320);
  });

  it('输入越界值被夹住，输入框跟着显示夹取后的值', () => {
    renderSettings('editor');

    const input = container.querySelector<HTMLInputElement>('[data-field-input="editor.panelWidth"]');
    act(() => setInputValue(input as HTMLInputElement, '9999'));

    expect(settings.get('editor.panelWidth')).toBe(PANEL_MAX_WIDTH);
    expect(input?.value).toBe(String(PANEL_MAX_WIDTH));
  });

  it('值就是默认值时不画重置键 —— 重置一个已经是默认值的项没有意义', () => {
    renderSettings('editor');

    expect(container.querySelector('[data-field-reset="editor.panelWidth"]')).toBeNull();
  });

  it('值偏离默认值时画重置键，点它回到默认值', () => {
    settings.set('editor.panelWidth', 360);
    renderSettings('editor');

    const reset = container.querySelector<HTMLButtonElement>('[data-field-reset="editor.panelWidth"]');
    expect(reset).not.toBeNull();

    act(() => reset?.click());

    expect(settings.get('editor.panelWidth')).toBe(PANEL_DEFAULT_WIDTH);
    expect(container.querySelector('[data-field-reset="editor.panelWidth"]')).toBeNull();
  });

  it('枚举项不画重置键 —— 再点一次原来那一项就回去了', () => {
    renderSettings('general');

    expect(container.querySelector('[data-field="general.locale"]')).not.toBeNull();
    expect(container.querySelector('[data-field-reset="general.locale"]')).toBeNull();
  });

  /**
   * 排版四项的**默认值必须等于改版前的观感** —— 这一批只加设置项，不该顺手改默认样式。
   * 判据取注册表里的 `resetValue`，因为重置键就是照它画的：两者不一致时，
   * 「重置」会把人送回一个从未存在过的样子。
   */
  it('外观项的默认值就是改版前的观感（14 / 1.6 / 0 / 跟随窗口 / 等宽 / 行号开）', () => {
    const byId = new Map(FIELDS.map((field) => [field.id, field]));

    expect(byId.get('editor.fontSize')?.resetValue).toBe('14');
    expect(byId.get('editor.lineHeight')?.resetValue).toBe('1.6');
    expect(byId.get('editor.paragraphSpacing')?.resetValue).toBe('0');
    expect(settings.get('editor.fontSize')).toBe(14);
    expect(settings.get('editor.lineHeight')).toBe(1.6);
    expect(settings.get('editor.paragraphSpacing')).toBe(0);
    expect(settings.get('editor.contentWidth')).toBe('none');
    expect(settings.get('editor.fontFamily')).toBe('default');
    expect(settings.get('editor.codeBlockLineNumbers')).toBe(true);
    expect(settings.get('general.autoSave')).toBe(true);
    expect(settings.get('editor.lineNumbers')).toBe(true);
    expect(settings.get('editor.tableLayout')).toBe('auto');
    expect(settings.get('general.autoSaveDelay')).toBe(800);
    expect(settings.get('general.externalChange')).toBe('smart');
    expect(byId.get('general.autoSaveDelay')?.resetValue).toBe('800');
  });

  it('改正文字号立刻写进存档，并把变量写到 documentElement 上', () => {
    renderSettings('editor');

    const input = container.querySelector<HTMLInputElement>('[data-field-input="editor.fontSize"]');
    act(() => setInputValue(input as HTMLInputElement, '18'));

    expect(settings.get('editor.fontSize')).toBe(18);
    // 编辑器主题只认这个变量，所以「改了没反应」与「变量没写」是同一件事。
    expect(document.documentElement.style.getPropertyValue('--nx-editor-font-size')).toBe('18px');
  });

  it('字号越界被夹住，输入框显示夹取后的值', () => {
    renderSettings('editor');

    const input = container.querySelector<HTMLInputElement>('[data-field-input="editor.fontSize"]');
    act(() => setInputValue(input as HTMLInputElement, '99'));

    expect(settings.get('editor.fontSize')).toBe(20);
    expect(input?.value).toBe('20');
  });

  /**
   * 清空输入框是「正在改」的中间态，不是「要 0」。少了这道守卫，`Number('')` 是 0，
   * 夹取后落到最小值 —— 表现是「删光字符，字号自己跳到 12」。
   */
  it('清空数值输入框不写盘，也不把值夹到最小值', () => {
    settings.set('editor.fontSize', 18);
    renderSettings('editor');

    const input = container.querySelector<HTMLInputElement>('[data-field-input="editor.fontSize"]');
    act(() => setInputValue(input as HTMLInputElement, ''));

    expect(settings.get('editor.fontSize')).toBe(18);
  });

  it('内容宽度是枚举，选中项写进存档', () => {
    renderSettings('editor');

    const select = container.querySelector<HTMLSelectElement>(
      '[data-field-input="editor.contentWidth"]'
    );
    expect(select?.value).toBe('none');

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value'
      )?.set;
      setter?.call(select, '880px');
      select?.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(settings.get('editor.contentWidth')).toBe('880px');
    expect(document.documentElement.style.getPropertyValue('--nx-editor-content-width')).toBe(
      '880px'
    );
  });

  /**
   * 代码块行号是**唯一一个没有 DOM 落点的外观项**：数字由 `packages/editor` 的 `::before`
   * 用 `attr(data-code-line-number)` 画，设置只能切那个伪元素的 `display`。所以「改了没反应」
   * 与「变量没写对」在这里是同一件事 —— 断言取变量值，不取开关的选中态。
   */
  it('关掉代码块行号写进存档，并把 display 变量切成 none', () => {
    renderSettings('editor');

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-field-input="editor.codeBlockLineNumbers"]'
    );
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
    expect(
      document.documentElement.style.getPropertyValue('--nx-editor-code-line-numbers')
    ).toBe('inline-block');

    act(() => toggle?.click());

    expect(settings.get('editor.codeBlockLineNumbers')).toBe(false);
    // `none` 让整个 `::before` 盒子不生成 —— 左侧留白一起收掉，正文贴回边框。
    expect(document.documentElement.style.getPropertyValue('--nx-editor-code-line-numbers')).toBe(
      'none'
    );
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
  });

  /**
   * 表格列宽。和代码块行号同属「能力一直在、只是关不掉」那一类：`table-layout` 由主题
   * 的 CSS 变量读，设置只切变量。
   */
  it('表格列宽是枚举，默认 auto，改 fixed 写进存档与变量', () => {
    renderSettings('editor');

    const select = container.querySelector<HTMLSelectElement>(
      '[data-field-input="editor.tableLayout"]'
    );
    expect(select?.value).toBe('auto');
    expect(document.documentElement.style.getPropertyValue('--nx-editor-table-layout')).toBe('auto');

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select, 'fixed');
      select?.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(settings.get('editor.tableLayout')).toBe('fixed');
    expect(document.documentElement.style.getPropertyValue('--nx-editor-table-layout')).toBe('fixed');
  });

  /**
   * 编辑器行号槽是这一组里**唯一没有 CSS 变量落点**的字段 —— 它走 CodeMirror 的 compartment，
   * 由 `SourceEditor.tsx` 订阅后重配。所以这里只断言存档；DOM 侧的真判据在 `packages/editor`
   * 的 `editor-line-numbers.test.ts` 与 desktop 真机用例里。
   */
  it('行号槽开关默认开，点一下写进存档', () => {
    renderSettings('editor');

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-field-input="editor.lineNumbers"]'
    );
    expect(toggle?.getAttribute('aria-checked')).toBe('true');

    act(() => toggle?.click());

    expect(settings.get('editor.lineNumbers')).toBe(false);
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
  });

  it('状态栏字数开关默认开，点一下写进存档', () => {
    renderSettings('editor');

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-field-input="editor.wordCount"]'
    );
    expect(toggle?.getAttribute('aria-checked')).toBe('true');

    act(() => toggle?.click());

    expect(settings.get('editor.wordCount')).toBe(false);
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
  });

  /**
   * 编辑器三项新开关（打字机模式 / Vim 键位 / 拼写检查）。
   *
   * 三项**默认全关**，方向与「行号 / 字数」相反：后者是「本来就有、给个关掉的开关」，
   * 这三项是「本来没有、给个打开的开关」。所以这里除断言存档，还要钉住
   * 「存档里是认不出的值 ⇒ 回落关」——那是默认关的开关唯一会出人命的地方
   * （写坏的字符不该把 Vim 装上）。
   *
   * DOM 侧的真判据在别处：拼写检查与打字机在 `packages/editor/test/`，
   * vim 在 `packages/editor/test/vim.test.ts`，三项的接线在 `SourceEditor.tsx`。
   */
  describe('三项默认关的开关', () => {
    const cases = [
      { label: '打字机模式', id: 'editor.typewriterMode', storageKey: 'nexus-editor-typewriter-mode' },
      { label: 'Vim 键位', id: 'editor.vimKeybindings', storageKey: 'nexus-editor-vim-keybindings' },
      { label: '拼写检查', id: 'editor.spellCheck', storageKey: 'nexus-editor-spell-check' }
    ];

    function toggle(id: string): HTMLElement | null {
      return container.querySelector<HTMLElement>(`[data-field-input="${id}"]`);
    }

    it.each(cases)('$label 渲染出来且默认关', ({ id }) => {
      renderSettings('editor');

      expect(container.querySelector(`[data-field="${id}"]`)).not.toBeNull();
      expect(toggle(id)?.getAttribute('aria-checked')).toBe('false');
    });

    it.each(cases)('$label 点一下写进存档，再点一下关回去', ({ id }) => {
      renderSettings('editor');

      act(() => toggle(id)?.click());
      expect(toggle(id)?.getAttribute('aria-checked')).toBe('true');

      act(() => toggle(id)?.click());
      expect(toggle(id)?.getAttribute('aria-checked')).toBe('false');
    });

    it.each(cases)('$label 存档里是认不出的值时回落「关」', ({ id, storageKey }) => {
      localStorage.setItem(storageKey, 'garbage');
      settings.reload();

      expect(settings.get(id)).toBe(false);
      localStorage.removeItem(storageKey);
      settings.reload();
    });

    it.each(cases)('$label 不给重置键 —— 再点一次就回去了', ({ id }) => {
      renderSettings('editor');

      expect(container.querySelector(`[data-field-reset="${id}"]`)).toBeNull();
    });
  });
});

/**
 * 通用分组新增的两项：自动保存延迟、外部修改时。
 *
 * 两者都不产生任何 DOM 落点 —— 一个被 `App.tsx` 的 setTimeout 读，一个被外部修改分支读 ——
 * 所以组件层只断言「值写对了」，行为判据在真机用例里。
 */
describe('设置视图 · 通用（自动保存延迟 / 外部修改 / 启动恢复）', () => {
  beforeEach(() => {
    settings.set('general.autoSaveDelay', 800);
    settings.set('general.externalChange', 'smart');
    settings.set('general.restoreLastWorkspace', false);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    settings.set('general.autoSaveDelay', 800);
    settings.set('general.externalChange', 'smart');
    settings.set('general.restoreLastWorkspace', false);
  });

  it('通用分组渲染自动保存延迟与外部修改两项', () => {
    renderSettings('general');

    expect(container.querySelector('[data-field="general.autoSaveDelay"]')).not.toBeNull();
    expect(container.querySelector('[data-field="general.externalChange"]')).not.toBeNull();
  });

  it('自动保存延迟默认 800，改值立刻写进存档', () => {
    renderSettings('general');

    const input = container.querySelector<HTMLInputElement>(
      '[data-field-input="general.autoSaveDelay"]'
    );
    expect(input?.value).toBe('800');

    act(() => setInputValue(input as HTMLInputElement, '1500'));

    expect(settings.get('general.autoSaveDelay')).toBe(1500);
  });

  it('自动保存延迟越界被夹住', () => {
    renderSettings('general');

    const input = container.querySelector<HTMLInputElement>(
      '[data-field-input="general.autoSaveDelay"]'
    );
    act(() => setInputValue(input as HTMLInputElement, '99999'));

    expect(settings.get('general.autoSaveDelay')).toBe(5000);
    expect(input?.value).toBe('5000');
  });

  it('外部修改默认 smart，改 prompt 写进存档', () => {
    renderSettings('general');

    const select = container.querySelector<HTMLSelectElement>(
      '[data-field-input="general.externalChange"]'
    );
    expect(select?.value).toBe('smart');

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select, 'prompt');
      select?.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(settings.get('general.externalChange')).toBe('prompt');
  });

  /**
   * 启动时恢复上次工作区。
   *
   * 这一层只管「开关画对了、点了写进存档」—— 它**改的是下一次启动的行为**，
   * 所以「真的恢复了没有」只有真机用例（`restore-last-workspace.test.ts`）验得到，
   * 「值送没送到主进程」在 `host-settings.test.ts` 里验。
   */
  describe('启动时恢复上次工作区', () => {
    function toggle(): HTMLElement | null {
      return container.querySelector<HTMLElement>('[data-field-input="general.restoreLastWorkspace"]');
    }

    it('默认关 —— 与加这一项之前一致（空启动就是一个空窗口）', () => {
      renderSettings('general');

      expect(toggle()?.getAttribute('aria-checked')).toBe('false');
      expect(settings.get('general.restoreLastWorkspace')).toBe(false);
    });

    it('点一下写进存档，开关跟着变', () => {
      renderSettings('general');

      act(() => toggle()?.click());

      expect(settings.get('general.restoreLastWorkspace')).toBe(true);
      expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    });

    it('再点一下关回去', () => {
      settings.set('general.restoreLastWorkspace', true);
      renderSettings('general');

      act(() => toggle()?.click());

      expect(settings.get('general.restoreLastWorkspace')).toBe(false);
    });

    /**
     * 与 `general.autoSave` 那组默认开的开关**方向相反**：那组「只有显式 false 算关」，
     * 这一项「只有显式 true 算开」。存档里一个写坏的字符不该让应用下次启动
     * 直接进入某个工作区（那是给一个目录发写权限）。
     */
    it('存档里是认不出的值时回落「关」', () => {
      localStorage.setItem('nexus-restore-last-workspace', 'garbage');
      settings.reload();

      expect(settings.get('general.restoreLastWorkspace')).toBe(false);
      localStorage.removeItem('nexus-restore-last-workspace');
    });

    it('开关不给重置键 —— 再点一次就回去了（与同分组的开关一致）', () => {
      settings.set('general.restoreLastWorkspace', true);
      renderSettings('general');

      expect(container.querySelector('[data-field-reset="general.restoreLastWorkspace"]')).toBeNull();
    });
  });

  /**
   * 当前版本。**没有可改的东西** —— 它是 `control: 'readonly'`，只画一行文本。
   *
   * 两条判据都要有：画出来的必须是**桥给的那一串**（渲染进程自己拼一个 `0.43.0` 也是「看起来对」），
   * 以及**取不到时不画**（主进程还没接上这条通道、或某个窗口没透出它时，
   * 不能留一个空行或一个假版本号）。
   */
  describe('当前版本', () => {
    const originalBridge = (window as unknown as { nexus?: unknown }).nexus;

    async function settle(): Promise<void> {
      await act(async () => {
        for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
      });
    }

    afterEach(() => {
      (window as unknown as { nexus?: unknown }).nexus = originalBridge;
    });

    it('显示主进程报的版本号', async () => {
      // 故意用一个**与 package.json 不一致**的值：渲染进程要是自己去读版本，这条会红。
      (window as unknown as { nexus: unknown }).nexus = {
        getAppVersion: () => Promise.resolve('9.9.9-probe')
      };
      renderSettings('general');
      await settle();

      expect(
        container.querySelector('[data-field-readonly="general.version"]')?.textContent
      ).toBe('9.9.9-probe');
    });

    it('只读值是文本，不是控件', async () => {
      (window as unknown as { nexus: unknown }).nexus = {
        getAppVersion: () => Promise.resolve('1.2.3')
      };
      renderSettings('general');
      await settle();

      expect(container.querySelector('[data-field-input="general.version"]')).toBeNull();
      expect(container.querySelector('[data-field-readonly="general.version"]')?.tagName).toBe('P');
    });

    it('取不到版本时不画那一行（而不是画个空的）', async () => {
      (window as unknown as { nexus: unknown }).nexus = {};
      renderSettings('general');
      await settle();

      expect(container.querySelector('[data-field="general.version"]')).not.toBeNull();
      expect(container.querySelector('[data-field-readonly="general.version"]')).toBeNull();
    });

    it('不给重置键 —— 没有可重置的值', async () => {
      (window as unknown as { nexus: unknown }).nexus = {
        getAppVersion: () => Promise.resolve('1.2.3')
      };
      renderSettings('general');
      await settle();

      expect(container.querySelector('[data-field-reset="general.version"]')).toBeNull();
    });
  });
});

/**
 * 文件与链接分组（本批只做附件那三项 + 新建文档默认位置）。
 *
 * 这一组的判据不只是「渲染出来了」：**默认值必须等于加设置项之前的行为**（与文档同目录），
 * 而两个文本框的空串会被 `parse` 落回默认值 —— 那条只有真敲一遍才看得出。
 */
describe('设置视图 · 文件与链接', () => {
  beforeEach(() => {
    settings.set('files.ignoreRules', '');
    settings.set('files.attachmentLocation', 'document');
    settings.set('files.attachmentDirectory', 'assets');
    settings.set('files.attachmentNameTemplate', 'pasted-{timestamp}');
    settings.set('files.newDocumentLocation', 'document');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    settings.set('files.ignoreRules', '');
    settings.set('files.attachmentLocation', 'document');
    settings.set('files.attachmentDirectory', 'assets');
    settings.set('files.attachmentNameTemplate', 'pasted-{timestamp}');
    settings.set('files.newDocumentLocation', 'document');
  });

  it('五项都渲染出来，默认值是「空规则 / 与文档同目录 / assets / pasted-{timestamp} / 与当前文档同目录」', () => {
    renderSettings('files');

    expect(container.querySelector('[data-field="files.ignoreRules"]')).not.toBeNull();
    expect(container.querySelector('[data-field="files.attachmentLocation"]')).not.toBeNull();
    expect(container.querySelector('[data-field="files.attachmentDirectory"]')).not.toBeNull();
    expect(container.querySelector('[data-field="files.attachmentNameTemplate"]')).not.toBeNull();
    expect(container.querySelector('[data-field="files.newDocumentLocation"]')).not.toBeNull();

    expect(settings.get('files.ignoreRules')).toBe('');
    expect(settings.get('files.attachmentLocation')).toBe('document');
    expect(settings.get('files.attachmentDirectory')).toBe('assets');
    expect(settings.get('files.attachmentNameTemplate')).toBe('pasted-{timestamp}');
    expect(settings.get('files.newDocumentLocation')).toBe('document');
  });

  /**
   * 忽略规则**原样存**，与同组的子目录名相反（那个归一化后才进存档）。
   * 区别在于是自由文本还是有损归一化：把换行压成逗号会一边敲一边改写用户的排版。
   */
  it('忽略规则原样进存档，归一化留给使用处', () => {
    renderSettings('files');

    const input = container.querySelector<HTMLInputElement>(
      '[data-field-input="files.ignoreRules"]'
    );
    act(() => setInputValue(input as HTMLInputElement, 'Drafts, notes\\private'));

    expect(settings.get('files.ignoreRules')).toBe('Drafts, notes\\private');
  });

  it('改新建文档默认位置写进存档', () => {
    renderSettings('files');

    act(() => {
      container
        .querySelector<HTMLElement>('[data-field-option="files.newDocumentLocation:workspace"]')
        ?.click();
    });
    expect(settings.get('files.newDocumentLocation')).toBe('workspace');

    // 枚举项不画重置键，与同组的附件存放位置一致。
    expect(
      container.querySelector('[data-field-reset="files.newDocumentLocation"]')
    ).toBeNull();
  });

  it('改存放位置写进存档（枚举项不画重置键）', () => {
    renderSettings('files');

    act(() => {
      container
        .querySelector<HTMLElement>('[data-field-option="files.attachmentLocation:directory"]')
        ?.click();
    });

    expect(settings.get('files.attachmentLocation')).toBe('directory');
    expect(
      container.querySelector('[data-field-reset="files.attachmentLocation"]')
    ).toBeNull();
  });

  it('子目录名归一化后才进存档（盘符前缀丢掉、非法字符换成 -）', () => {
    renderSettings('files');

    const input = container.querySelector<HTMLInputElement>(
      '[data-field-input="files.attachmentDirectory"]'
    );
    act(() => setInputValue(input as HTMLInputElement, 'D:/Note/att:ach'));

    expect(settings.get('files.attachmentDirectory')).toBe('Note/att-ach');
  });

  it('文本框清空后回落到默认值，而不是留一个空串', () => {
    settings.set('files.attachmentNameTemplate', '图-{date}');
    renderSettings('files');

    const input = container.querySelector<HTMLInputElement>(
      '[data-field-input="files.attachmentNameTemplate"]'
    );
    expect(input?.value).toBe('图-{date}');

    act(() => setInputValue(input as HTMLInputElement, ''));

    expect(settings.get('files.attachmentNameTemplate')).toBe('pasted-{timestamp}');
  });

  it('偏离默认值时画重置键，点它回到默认值', () => {
    settings.set('files.attachmentDirectory', 'media');
    renderSettings('files');

    const reset = container.querySelector<HTMLButtonElement>(
      '[data-field-reset="files.attachmentDirectory"]'
    );
    expect(reset).not.toBeNull();

    act(() => reset?.click());

    expect(settings.get('files.attachmentDirectory')).toBe('assets');
  });
});

/**
 * 快捷键分组（`KeybindingsSection.tsx`）。它不是通用字段表 —— 一行一条动作，带捕获、
 * 取消绑定、恢复默认、跨行冲突检测 —— 所以判据也全是这张表自己的 `data-*`。
 *
 * 捕获走 `window` 的**捕获阶段**，所以这里必须把按键派发到 `window` 上（不是某个元素）。
 */
describe('设置视图 · 快捷键', () => {
  beforeEach(() => {
    settings.set('keybindings.overrides', {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    settings.set('keybindings.overrides', {});
  });

  /** 派发一次按键。捕获监听挂在 window 上，所以要派到 window。 */
  function pressKey(init: KeyboardEventInit): void {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    });
  }

  function captureButton(actionId: string): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(`[data-keybinding-input="${actionId}"]`);
  }

  it('渲染可重映射动作表与只读的固定键清单', () => {
    renderSettings('keybindings');

    expect(container.querySelectorAll('[data-keybinding]')).toHaveLength(REMAPPABLE_ACTIONS.length);
    expect(container.querySelector('[data-keybinding="save"]')).not.toBeNull();
    expect(container.querySelector('[data-keybinding-input="save"]')).not.toBeNull();
    // 固定键没有捕获入口 —— 画一个点了没反应的按钮比不画更糟。
    expect(container.querySelector('[data-keybinding-input="undo"]')).toBeNull();
    expect(container.querySelector('.nexus-settings-keybinding-fixed-list')).not.toBeNull();
  });

  it('未改过时显示默认组合键，且不画「恢复默认」', () => {
    renderSettings('keybindings');

    expect(captureButton('save')?.textContent).toBe(formatShortcut('Mod-S'));
    expect(container.querySelector('[data-keybinding-reset="save"]')).toBeNull();
    // 没有任何覆盖项时「全部重置」也不该出现。
    expect(container.querySelector('[data-keybinding-reset-all]')).toBeNull();
  });

  it('捕获新组合键写进存档，按钮与「恢复默认」跟着出现', () => {
    renderSettings('keybindings');

    act(() => captureButton('save')?.click());
    expect(captureButton('save')?.dataset.capturing).toBe('true');

    pressKey({ ctrlKey: true, shiftKey: true, key: 'K' });

    expect(settings.get('keybindings.overrides')).toEqual({ save: 'Mod-Shift-k' });
    expect(captureButton('save')?.dataset.capturing).toBe('false');
    expect(captureButton('save')?.textContent).toBe(formatShortcut('Mod-Shift-k'));
    expect(container.querySelector('[data-keybinding-reset="save"]')).not.toBeNull();
    expect(container.querySelector('[data-keybinding-reset-all]')).not.toBeNull();
  });

  it('Escape 取消捕获，不写盘', () => {
    renderSettings('keybindings');

    act(() => captureButton('save')?.click());
    pressKey({ key: 'Escape' });

    expect(settings.get('keybindings.overrides')).toEqual({});
    expect(captureButton('save')?.dataset.capturing).toBe('false');
  });

  it('只按修饰键不算一次输入，继续等真正的键', () => {
    renderSettings('keybindings');

    act(() => captureButton('save')?.click());
    pressKey({ ctrlKey: true, key: 'Control' });

    expect(captureButton('save')?.dataset.capturing).toBe('true');
    expect(settings.get('keybindings.overrides')).toEqual({});
  });

  it('与别的动作撞车时**拒绝**并就地说明被谁占用', () => {
    renderSettings('keybindings');

    act(() => captureButton('save')?.click());
    pressKey({ ctrlKey: true, key: 'N' });

    expect(settings.get('keybindings.overrides')).toEqual({});
    expect(captureButton('save')?.dataset.capturing).toBe('false');
    const conflict = container.querySelector('[data-keybinding-conflict="save"]');
    expect(conflict?.textContent).toContain(translate(localeManager.locale, 'cmd.newFile'));
  });

  it('取消绑定显示「未设置」，且生效表里查不到它', () => {
    renderSettings('keybindings');

    act(() => container.querySelector<HTMLButtonElement>('[data-keybinding-clear="save"]')?.click());

    expect(settings.get('keybindings.overrides')).toEqual({ save: '' });
    expect(resolveShortcut('save')).toBeUndefined();
    expect(captureButton('save')?.textContent).toBe(
      translate(localeManager.locale, 'settings.keybindings.unbound')
    );
  });

  it('恢复默认把覆盖项**删掉**，而不是写成当前默认值', () => {
    settings.set('keybindings.overrides', { save: 'Mod-Shift-k' });
    renderSettings('keybindings');

    act(() => container.querySelector<HTMLButtonElement>('[data-keybinding-reset="save"]')?.click());

    expect(settings.get('keybindings.overrides')).toEqual({});
    expect(resolveShortcut('save')).toBe('Mod-S');
  });

  it('全部重置一次清掉所有覆盖项', () => {
    settings.set('keybindings.overrides', { save: 'Mod-Shift-k', 'new-file': '' });
    renderSettings('keybindings');

    act(() => container.querySelector<HTMLButtonElement>('[data-keybinding-reset-all]')?.click());

    expect(settings.get('keybindings.overrides')).toEqual({});
  });
});

/**
 * 动作字段（`control: 'action'`）。它没有值，只有「能不能按」与「按完怎么了」两种状态 ——
 * 所以判据是 `disabled` 与两行回执，不是选中态。
 *
 * 索引那一项还多一条**只读值**（`FieldDef.readonlyValue`）：索引库落在 `userData` 下，
 * 路径只有主进程算得出，所以它是一个**异步取一次**的文本行。判据是「画出来的字符串
 * 就是桥给的那一个」—— 渲染进程自己拼一条看起来对的路径时，这一条会红。
 */
describe('设置视图 · 动作字段', () => {
  const originalBridge = (window as unknown as { nexus?: unknown }).nexus;

  /** 桥给回来的索引库路径。故意用一条**渲染进程推不出来**的值（真路径里含 userData）。 */
  const INDEX_PATH = 'C:/Users/tester/AppData/Roaming/Nexus/workspace-index/9f3a1c07b4e2d8a5.db';

  /**
   * `report` 默认 `null` ＝ **桥明确说「没有报告」**。诊断那一项自有一套用例
   * （`设置视图 · 诊断信息`），本组刻意让它不画那一行，好让「只读值计数」这个判据
   * 只反映索引那一项。**不要**靠「桥上没有 `getDiagnostics` 所以它抛异常」来达到这个效果 ——
   * 那样这条计数就是碰巧对的，将来谁给桥补上这条通道，本组会毫无理由地红。
   */
  function stubBridge(
    roots: string[],
    indexPath: string | null = INDEX_PATH,
    report: DiagnosticsReport | null = null
  ): {
    rebuilds: string[];
    opened: string[];
    openedIndex: string[];
    askedPaths: string[];
    copied: string[];
  } {
    const calls = {
      rebuilds: [] as string[],
      opened: [] as string[],
      openedIndex: [] as string[],
      askedPaths: [] as string[],
      copied: [] as string[]
    };
    (window as unknown as { nexus: unknown }).nexus = {
      getWorkspaceRoots: () => Promise.resolve(roots),
      rebuildIndex: (rootPath: string) => {
        calls.rebuilds.push(rootPath);
        return Promise.resolve({});
      },
      openHistoryDirectory: (rootPath: string) => {
        calls.opened.push(rootPath);
        return Promise.resolve(true);
      },
      openIndexDirectory: (rootPath: string) => {
        calls.openedIndex.push(rootPath);
        return Promise.resolve(true);
      },
      getIndexPath: (rootPath: string) => {
        calls.askedPaths.push(rootPath);
        return Promise.resolve(indexPath);
      },
      getDiagnostics: () => Promise.resolve(report),
      copyText: (text: string) => {
        calls.copied.push(text);
        return Promise.resolve(true);
      }
    };
    return calls;
  }

  /**
   * 探测与只读值都是异步的，要让它们的 Promise 链落地再断言。
   *
   * 三跳而不是一跳：只读值那条链是 `getWorkspaceRoots` → `getIndexPath` → `setState`，
   * 每 `await` 一次吃掉一个微任务。少给几跳的表现是「只读值偶尔画不出来」，
   * 而那种失败会随执行顺序变，最难查。
   */
  async function settle(): Promise<void> {
    await act(async () => {
      for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    (window as unknown as { nexus?: unknown }).nexus = originalBridge;
  });

  it('有工作区时两个动作都可按，点了把工作区根交给桥', async () => {
    const calls = stubBridge(['E:/notes']);
    renderSettings('data');
    await settle();

    const rebuild = container.querySelector<HTMLButtonElement>(
      '[data-field-action="data.rebuildIndex"]'
    );
    const openDir = container.querySelector<HTMLButtonElement>(
      '[data-field-action="data.openHistoryDirectory"]'
    );
    const openIndex = container.querySelector<HTMLButtonElement>(
      '[data-field-action="data.openIndexDirectory"]'
    );
    expect(rebuild?.disabled).toBe(false);
    expect(openDir?.disabled).toBe(false);
    expect(openIndex?.disabled).toBe(false);

    await act(async () => {
      rebuild?.click();
    });
    await act(async () => {
      openDir?.click();
    });
    await act(async () => {
      openIndex?.click();
    });

    expect(calls.rebuilds).toEqual(['E:/notes']);
    expect(calls.opened).toEqual(['E:/notes']);
    expect(calls.openedIndex).toEqual(['E:/notes']);
    // 效果落在别的窗口，所以当前窗口必须给一行回执，否则点了像没反应。
    expect(container.querySelector('[data-field-outcome="data.rebuildIndex"]')).not.toBeNull();
  });

  /**
   * 轻量模式（只打开一个文件）没有工作区。**禁用加一行原因**，而不是让按钮点得动、
   * 点了什么都不发生 —— 后者用户会反复点，然后以为是坏了。
   */
  it('没有工作区时禁用，并写明原因', async () => {
    stubBridge([]);
    renderSettings('data');
    await settle();

    const rebuild = container.querySelector<HTMLButtonElement>(
      '[data-field-action="data.rebuildIndex"]'
    );
    expect(rebuild?.disabled).toBe(true);
    expect(container.querySelector('[data-field-blocked="data.rebuildIndex"]')?.textContent).toBe(
      translate(localeManager.locale, 'settings.data.needsWorkspace')
    );
  });

  it('动作失败时给失败回执，不静默', async () => {
    (window as unknown as { nexus: unknown }).nexus = {
      getWorkspaceRoots: () => Promise.resolve(['E:/notes']),
      rebuildIndex: () => Promise.reject(new Error('boom'))
    };
    renderSettings('data');
    await settle();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-field-action="data.rebuildIndex"]')?.click();
    });

    expect(container.querySelector('[data-field-outcome="data.rebuildIndex"]')?.textContent).toBe(
      translate(localeManager.locale, 'settings.action.failed')
    );
  });

  /** `action` 字段没有值可读，因此**不画重置键** —— 没有「默认值」这个概念。 */
  it('动作字段不画重置键', async () => {
    stubBridge(['E:/notes']);
    renderSettings('data');
    await settle();

    expect(container.querySelector('[data-field-reset="data.rebuildIndex"]')).toBeNull();
    expect(container.querySelector('[data-field-reset="data.openHistoryDirectory"]')).toBeNull();
  });

  /**
   * 只读值。判据是「画出来的就是桥给的那一条」而不是「画出了一条路径」——
   * 渲染进程自己拼一条形似的路径（比如拿工作区根拼）时，只有前者会红。
   */
  it('索引那一项显示主进程给的库文件路径，并拿工作区根去问', async () => {
    const calls = stubBridge(['E:/notes']);
    renderSettings('data');
    await settle();

    const readonly = container.querySelector('[data-field-readonly="data.openIndexDirectory"]');
    expect(readonly?.textContent).toBe(INDEX_PATH);
    // 值不是渲染进程造的：它是拿当前工作区根问主进程要来的。
    expect(calls.askedPaths).toEqual(['E:/notes']);
  });

  /** 只读值是**文本**，不是一个控件 —— 没有输入框、没有可点的东西。 */
  it('只读值不画输入框，也不是按钮', async () => {
    stubBridge(['E:/notes']);
    renderSettings('data');
    await settle();

    expect(
      container.querySelector('[data-field-input="data.openIndexDirectory"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-field-readonly="data.openIndexDirectory"]')?.tagName
    ).toBe('P');
  });

  /**
   * 这一行只属于索引那一项。别的动作字段跟着多出一行路径时，是接线接错了。
   *
   * 计数写死 1 之所以还成立：本组给桥的是一份 **`null` 报告**，诊断那一项因此也不画。
   * 它的只读值是「主进程给的一段文本」，索引那一项是「主进程给的一条路径」—— 两者
   * 同形不同源，所以这一条只钉「谁有资格画」，不钉内容。
   */
  it('四个动作字段里只有索引那一项画只读值', async () => {
    stubBridge(['E:/notes']);
    renderSettings('data');
    await settle();

    expect(container.querySelectorAll('[data-field-readonly]')).toHaveLength(1);
    expect(container.querySelector('[data-field-readonly="data.rebuildIndex"]')).toBeNull();
    expect(container.querySelector('[data-field-readonly="data.openHistoryDirectory"]')).toBeNull();
    expect(container.querySelector('[data-field-readonly="data.diagnostics"]')).toBeNull();
  });

  /**
   * 没有工作区时连那一行也不画 —— 而不是画一个空框。
   *
   * 判据按字段 id 查，**不用 `[data-field-readonly]` 全查**：诊断那一项的文本里只有版本与
   * 平台，跟工作区无关，将来谁给它接上桥，这条就会因为「别人画了」而假红。
   */
  it('没有工作区时索引那一项不画只读值', async () => {
    stubBridge([]);
    renderSettings('data');
    await settle();

    expect(
      container.querySelector('[data-field-readonly="data.openIndexDirectory"]')
    ).toBeNull();
  });

  /**
   * 主进程说「这条路径我算不出来」时（返回 `null`）同样不画。
   * 画一行 `null` 或空串都会让用户以为索引坏了。
   */
  it('桥返回空时不画索引那一项的只读值', async () => {
    stubBridge(['E:/notes'], null);
    renderSettings('data');
    await settle();

    expect(
      container.querySelector('[data-field-readonly="data.openIndexDirectory"]')
    ).toBeNull();
  });

  /**
   * 取路径失败不该把整页拖垮：这一行是附加信息，没有它按钮照样能用。
   * 断言到「按钮还在且可按」这一层 —— 只断言「没抛异常」的话，React 把子树卸载掉也算过。
   */
  it('取路径失败时只丢那一行，按钮照常可用', async () => {
    (window as unknown as { nexus: unknown }).nexus = {
      getWorkspaceRoots: () => Promise.resolve(['E:/notes']),
      getIndexPath: () => Promise.reject(new Error('boom')),
      openIndexDirectory: () => Promise.resolve(true)
    };
    renderSettings('data');
    await settle();

    expect(
      container.querySelector('[data-field-readonly="data.openIndexDirectory"]')
    ).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('[data-field-action="data.openIndexDirectory"]')
        ?.disabled
    ).toBe(false);
  });
});

/**
 * 诊断信息（`control: 'action'` + `readonlyValue` 组合的第一处）。
 *
 * 它是设置页里**唯一**「既显示一段文本、又给一个按钮」的字段，两条通路必须指向同一份文本 ——
 * 判据是「点按钮交给剪贴板的那段，逐字符等于屏幕上那段」，而不是「两处各自拼了一遍、看起来差不多」。
 *
 * 主进程给的是**事实**（版本 / 平台 / 路径 / 文件大小），渲染进程拼成文本。所以这里打的桩
 * 只需要给一份报告，拼装规则由 `diagnostics-format.test.ts` 逐行钉住。
 */
describe('设置视图 · 诊断信息', () => {
  const originalBridge = (window as unknown as { nexus?: unknown }).nexus;

  const REPORT: DiagnosticsReport = {
    version: '0.44.0',
    platform: 'win32-x64',
    electron: '33.0.0',
    chromium: '130.0.0.0',
    node: '20.18.0',
    workspaceRoot: 'E:/notes',
    index: {
      path: 'C:/Users/tester/AppData/Roaming/Nexus/workspace-index/9f3a1c07b4e2d8a5.db',
      sizeBytes: 2412544,
      updatedAt: '2026-09-30T02:11:05.000Z'
    }
  };

  /** 桥报告 + 剪贴板。`copied` 收下每一次交给剪贴板的文本。 */
  function stubBridge(report: DiagnosticsReport | null): { copied: string[] } {
    const calls = { copied: [] as string[] };
    (window as unknown as { nexus: unknown }).nexus = {
      getWorkspaceRoots: () => Promise.resolve([]),
      getDiagnostics: () => Promise.resolve(report),
      copyText: (text: string) => {
        calls.copied.push(text);
        return Promise.resolve(true);
      }
    };
    return calls;
  }

  async function settle(): Promise<void> {
    await act(async () => {
      for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    (window as unknown as { nexus?: unknown }).nexus = originalBridge;
  });

  function readonly(): HTMLElement | null {
    return container.querySelector<HTMLElement>('[data-field-readonly="data.diagnostics"]');
  }

  /**
   * 判据是「画出来的就是桥给的那几个事实」—— 逐项比，不写死整段。
   * 写死整段会让拼装规则的任何调整都要求改两处，而拼装规则已经被另一条用例钉住了。
   */
  it('画的是主进程给的那几个事实，且排在最前面', async () => {
    stubBridge(REPORT);
    renderSettings('data');
    await settle();

    const text = readonly()?.textContent ?? '';
    expect(text.startsWith('version: 0.44.0')).toBe(true);
    expect(text).toContain('platform: win32-x64');
    expect(text).toContain('electron: 33.0.0');
    expect(text).toContain('chromium: 130.0.0.0');
    expect(text).toContain('node: 20.18.0');
    expect(text).toContain('workspace: E:/notes');
    expect(text).toContain(REPORT.index!.path);
    // 大小是**人类可读**的那一份，原始字节数跟在括号里 —— 两个都要有，用户贴出去时
    // 维护者看字节、用户看 MB。
    expect(text).toContain('2.3 MB (2412544 bytes)');
    expect(text).toContain('2026-09-30T02:11:05.000Z');
  });

  /**
   * **本组最重要的一条**：屏幕上那段与交给剪贴板的那段必须逐字符相等。
   * 两处各取一次数（`readonlyValue` 挂载时一次、按钮点击时一次），所以这条同时在钉
   * 「报告里没有时间戳」—— 有时间戳的话这两次取数永远不相等。
   */
  it('点按钮把屏幕上那一段原样交给剪贴板', async () => {
    const calls = stubBridge(REPORT);
    renderSettings('data');
    await settle();

    const onScreen = readonly()?.textContent ?? '';
    expect(onScreen).not.toBe('');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-field-action="data.diagnostics"]')?.click();
    });
    await settle();

    expect(calls.copied).toEqual([onScreen]);
  });

  /** 复制成功要有回执 —— 效果落在系统剪贴板里，当前窗口不给一行字就像没反应。 */
  it('复制成功后给一行回执', async () => {
    stubBridge(REPORT);
    renderSettings('data');
    await settle();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-field-action="data.diagnostics"]')?.click();
    });
    await settle();

    expect(
      container.querySelector('[data-field-outcome="data.diagnostics"]')?.textContent
    ).toBe(translate(localeManager.locale, 'settings.action.done'));
  });

  /**
   * `copyText` 返回 `false`（写剪贴板失败）时**必须翻成异常**。
   * 不翻的话按钮照样显示「已完成」，而这一项失败的唯一表现是「用户粘出来是空的」——
   * 一个不可能被发现的静默失败。
   */
  it('写剪贴板失败时给失败回执，不谎报成功', async () => {
    (window as unknown as { nexus: unknown }).nexus = {
      getWorkspaceRoots: () => Promise.resolve([]),
      getDiagnostics: () => Promise.resolve(REPORT),
      copyText: () => Promise.resolve(false)
    };
    renderSettings('data');
    await settle();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-field-action="data.diagnostics"]')?.click();
    });
    await settle();

    expect(
      container.querySelector('[data-field-outcome="data.diagnostics"]')?.textContent
    ).toBe(translate(localeManager.locale, 'settings.action.failed'));
  });

  /**
   * 桥说「没有报告」时不画那一行，但**按钮还在** —— 这一项没有工作区也能用
   * （版本与平台与工作区无关），所以它没有 `probe`、永远不禁用。
   */
  it('桥没有报告时不画文本行，按钮仍可按', async () => {
    stubBridge(null);
    renderSettings('data');
    await settle();

    expect(readonly()).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('[data-field-action="data.diagnostics"]')?.disabled
    ).toBe(false);
  });

  /** 只读值是文本不是控件；而这一项**多一个按钮** —— 与索引那一项（只有文本）的形状不同。 */
  it('不画输入框，且只读值与按钮同时在', async () => {
    stubBridge(REPORT);
    renderSettings('data');
    await settle();

    expect(container.querySelector('[data-field-input="data.diagnostics"]')).toBeNull();
    expect(readonly()?.tagName).toBe('P');
    expect(container.querySelector('[data-field-action="data.diagnostics"]')).not.toBeNull();
  });

  /** 没有值可读 ⇒ 没有「默认值」这个概念，因此不画重置键。 */
  it('不画重置键', async () => {
    stubBridge(REPORT);
    renderSettings('data');
    await settle();

    expect(container.querySelector('[data-field-reset="data.diagnostics"]')).toBeNull();
  });
});

/**
 * 新建与复制（2026-09-29）。
 *
 * 两个入口都只做一件事：造一份用户主题、切过去，然后**把主题窗口叫出来**。编辑器搬进了那个
 * 窗口，所以「点了入口才出现编辑器」这条语义还在，只是分成了两步 —— 这里用打桩的 `window.nexus`
 * 验第二步真的发出去了；窗口本身在 `theme-window.test.tsx`，真机链路在
 * `apps/desktop/test/theme-editor.test.ts`。
 */
describe('设置视图 · 新建与复制主题', () => {
  let opened: number;

  beforeEach(() => {
    settings.set('appearance.userThemes', []);
    applyThemeChoice(DEFAULT_THEME_CHOICE);
    opened = 0;
    (window as unknown as { nexus: unknown }).nexus = {
      openThemeWindow: () => {
        opened += 1;
        return Promise.resolve();
      }
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    settings.set('appearance.userThemes', []);
    applyThemeChoice(DEFAULT_THEME_CHOICE);
  });

  it('编辑器不再内嵌在设置页里', () => {
    renderSettings();

    expect(container.querySelector('[data-theme-editor]')).toBeNull();
    expect(container.querySelector('[data-theme-seed]')).toBeNull();
    expect(container.querySelector('[data-theme-preview]')).toBeNull();
  });

  it('入口行打开主题窗口', () => {
    renderSettings();

    const button = container.querySelector<HTMLButtonElement>('[data-theme-open-window]');
    expect(button).not.toBeNull();
    act(() => button!.click());

    expect(opened).toBe(1);
  });

  it('点「新建主题」：造出用户主题并请求打开主题窗口', () => {
    renderSettings();

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-theme-new]')?.click();
    });

    expect(themeManager.isEditable).toBe(true);
    expect(settings.get('appearance.theme')?.startsWith('user:')).toBe(true);
    expect(localStorage.getItem('nexus-user-theme')).not.toBe('');
    expect(opened).toBe(1);
  });

  /**
   * 「新建主题」不是一项选择。混进 `role="radiogroup"` 里读屏会把它当成第 N 个选项，
   * 而它永远 `aria-checked=false`。
   */
  it('「新建主题」在列表末尾，且不在单选组里', () => {
    renderSettings();

    const button = container.querySelector<HTMLElement>('[data-theme-new]');
    expect(button).not.toBeNull();
    expect(button?.previousElementSibling?.className).toContain('nexus-theme-cards');
    expect(button?.closest('[role="radiogroup"]')).toBeNull();
  });

  it('搜索无匹配时列表给空态，但「新建主题」还在（正是该新建的时候）', () => {
    renderSettings();

    act(() => {
      setInputValue(container.querySelector<HTMLInputElement>('[data-theme-search]')!, 'zzzz');
    });

    expect(container.querySelector('[data-theme-search-empty]')).not.toBeNull();
    expect(container.querySelector('[data-theme-new]')).not.toBeNull();
  });

  /**
   * 判据取**副本的 palette 与源那套逐值相等**，而不是「当前主题是用户主题」—— 后者用一次
   * fork 就能满足，证明不了复制的是哪一套。
   */
  it('复制一张卡：副本的种子等于那套、立刻切过去、请求打开主题窗口', () => {
    const source = BUILT_IN_SCHEMES.find((entry) => entry.id === 'gruvbox-light')!.scheme;
    renderSettings();

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-theme-copy="gruvbox"]')?.click();
    });

    const copy = themeManager.activeUserTheme;
    expect(copy).not.toBeNull();
    expect(copy?.id.startsWith('user:')).toBe(true);
    // 复制的是**一整个预设**：明暗两版一起拷，落在源那一版（`gruvbox-light`）上。
    expect(copy?.variants.light?.palette).toEqual(source.palette);
    // 名字按**族名**归一（`Gruvbox`，不是上游方案名 `Gruvbox Light`）—— 明暗两版共用一个名字。
    expect(copy?.variants.light?.name).toBe('Gruvbox');
    expect(copy?.variants.dark).toBeDefined();
    expect(themeManager.theme.id).toBe(copy?.id);
    expect(settings.get('appearance.theme')).toBe(`${copy?.id}@light`);
    expect(opened).toBe(1);
  });

  /**
   * 副本必须能独立改：palette 浅拷不到位的话，改副本会把出厂那套一起改掉。
   * 写入口用编辑器走的同一个（`applySchemePatch`）—— 设置页里已经没有取色器了。
   */
  it('改副本的种子不影响出厂那套', () => {
    const source = BUILT_IN_SCHEMES.find((entry) => entry.id === 'gruvbox-light')!.scheme;
    const original = source.palette.base00;
    renderSettings();

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-theme-copy="gruvbox"]')?.click();
    });
    act(() => {
      applySchemePatch({ palette: { base00: '#101010' } });
    });

    expect(themeManager.activeScheme?.palette.base00).toBe('#101010');
    expect(
      BUILT_IN_SCHEMES.find((entry) => entry.id === 'gruvbox-light')!.scheme.palette.base00
    ).toBe(original);
  });

  /**
   * 用户主题是**一个列表**，不是一格。这条直击「新建了第二套，第一套就没了」——
   * 存档只装得下一套时，第二次新建会把它顶掉。
   */
  it('连建两套：两套都在列表里，前一套没被顶掉', () => {
    renderSettings();

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-theme-new]')?.click();
    });
    const first = themeManager.activeUserTheme!.id;

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-theme-new]')?.click();
    });
    const second = themeManager.activeUserTheme!.id;

    expect(second).not.toBe(first);
    expect(settings.get('appearance.userThemes').map((theme) => theme.id)).toEqual([first, second]);
    expect(
      container.querySelectorAll('[data-theme-option^="user:"]').length
    ).toBe(2);
    // 两套都有卡片，也就都有各自的复制键与删除键。
    expect(container.querySelector(`[data-theme-delete="${first}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-theme-delete="${second}"]`)).not.toBeNull();
  });

  /** 删掉一套：列表少一套，**另一套不受影响**。删除键只出现在用户主题的卡片上。 */
  it('删掉一套用户主题，其余那套还在', () => {
    renderSettings();

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-theme-new]')?.click();
    });
    const first = themeManager.activeUserTheme!.id;
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-theme-new]')?.click();
    });
    const second = themeManager.activeUserTheme!.id;

    act(() => {
      container.querySelector<HTMLButtonElement>(`[data-theme-delete="${second}"]`)?.click();
    });

    expect(settings.get('appearance.userThemes').map((theme) => theme.id)).toEqual([first]);
    // 删的正落在它身上 → 选择回到默认预设，不能悬空指着一个不存在的预设。
    expect(settings.get('appearance.theme')).toBe(DEFAULT_THEME_CHOICE);
    expect(container.querySelector(`[data-theme-option="${second}"]`)).toBeNull();
  });

  it('内置预设的卡片上没有删除键 —— 删不掉，也不该给一个按了没反应的键', () => {
    renderSettings();

    expect(container.querySelector('[data-theme-delete="nexus"]')).toBeNull();
    expect(container.querySelector('[data-theme-delete="gruvbox"]')).toBeNull();
  });

  /**
   * 「编辑」键先**切过去**再开窗。编辑器改的永远是**当前主题**，所以不切的话开出来的是另一套 ——
   * 用户点的是这张卡上的键，期待改的就是这一套。
   */
  it('编辑一套用户主题：先切过去，再请求打开主题窗口', () => {
    renderSettings();

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-theme-new]')?.click();
    });
    const first = themeManager.activeUserTheme!.id;

    // 再建一套，于是当前主题变成第二套 —— 编辑第一套时才看得出「切过去」这一步。
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-theme-new]')?.click();
    });
    const second = themeManager.activeUserTheme!.id;
    expect(second).not.toBe(first);
    opened = 0;

    act(() => {
      container.querySelector<HTMLButtonElement>(`[data-theme-edit="${first}"]`)?.click();
    });

    expect(themeManager.theme.id).toBe(first);
    expect(settings.get('appearance.theme')).toContain(`${first}@`);
    expect(opened).toBe(1);
  });

  it('内置预设的卡片上没有编辑键 —— 内置主题不可写，改它要先复制', () => {
    renderSettings();

    expect(container.querySelector('[data-theme-edit="nexus"]')).toBeNull();
    expect(container.querySelector('[data-theme-edit="gruvbox"]')).toBeNull();
    // 但复制键在，它就是「改内置主题」的入口。
    expect(container.querySelector('[data-theme-copy="gruvbox"]')).not.toBeNull();
  });

  it('复制一份自定义主题：得到的是新的一份，不是同一份', () => {
    renderSettings();

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-theme-new]')?.click();
    });
    const first = themeManager.activeUserTheme!.id;

    act(() => {
      container.querySelector<HTMLButtonElement>(`[data-theme-copy="${first}"]`)?.click();
    });

    const second = themeManager.activeUserTheme!.id;
    expect(second).not.toBe(first);
    expect(second.startsWith('user:')).toBe(true);
  });

  /**
   * 切回内置预设再切回来。用户主题**仍留在列表里**（存档里那份没删），否则「切走一次就再也
   * 回不来」—— 那是列表改读 `activeUserTheme` 时踩过的坑。
   */
  it('切回内置预设后自定义主题仍在列表里，点回去又切回来', () => {
    renderSettings();

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-theme-new]')?.click();
    });
    const userThemeId = themeManager.activeUserTheme!.id;

    act(() => {
      presetOption('nord')?.click();
    });

    expect(themeManager.isEditable).toBe(false);
    expect(presetOption(userThemeId)).not.toBeNull();

    act(() => {
      presetOption(userThemeId)?.click();
    });
    expect(themeManager.theme.id).toBe(userThemeId);
    expect(themeManager.isEditable).toBe(true);
  });

  /** 自定义主题只有一版，模式控件禁用 —— 理由不能复用「上游只出了一版」那句。 */
  /**
   * 内置预设都是双变体了，单边只剩**用户主题**这一种形状 —— 所以这条自己造一套只有浅色的。
   * 它切到深色时控件禁用（按下去只会被退回原处），理由说的是「自定义主题」。
   */
  it('单边自定义主题下模式控件禁用，理由说的是自定义主题', () => {
    applyUserTheme({
      id: 'user:single',
      variants: { light: BUILT_IN_SCHEMES.find((entry) => entry.id === 'gruvbox-light')!.scheme }
    });
    renderSettings();

    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>('[data-theme-mode]')).every(
        (button) => button.disabled
      )
    ).toBe(true);
    // 逐字比字典，不写死文案 —— 测试语言随 `localeManager` 走，写死会在换语言时假红。
    expect(container.querySelector('[data-mode-locked]')?.textContent).toBe(
      translate(localeManager.locale, 'theme.modeUnavailable.custom')
    );
  });

  /**
   * 从**两变体**预设复制来的自定义主题两版都有，模式控件可用 —— 这是「自定义主题也能有明暗两版」
   * 的界面判据，也是这次改动最该守住的一条：切过去换的是**同一套主题的另一版**，不是另一套主题。
   */
  it('两边都有的自定义主题：模式控件可用，切换换的是同一套主题的另一版', () => {
    duplicateTheme('nexus-light');
    renderSettings();

    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>('[data-theme-mode]')).some(
        (button) => !button.disabled
      )
    ).toBe(true);

    const themeId = themeManager.theme.id;
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-theme-mode="dark"]')?.click();
    });

    expect(settings.get('appearance.theme')).toBe(`${themeId}@dark`);
    expect(themeManager.theme.id).toBe(themeId);
    expect(themeManager.theme.type).toBe('dark');
    expect(themeManager.activeScheme?.variant).toBe('dark');
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

  it('上下键在八项之间移动焦点', () => {
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
   *
   * 顺序与设置页同一份（`THEME_MODES`）：跟随系统在最前。菜单与卡片各抄一遍顺序必然漂移。
   */
  it('装所有 menu: true 的字段：模式三项 + 语言两项 + mermaid', () => {
    const labels = projectMenuItems({ t, onOpenSettings: () => {} })
      .filter((item) => !item.separator)
      .map((item) => item.label);

    expect(labels).toEqual([
      'theme.mode.auto',
      'theme.mode.light',
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

/**
 * 数据分组：历史快照上限。
 *
 * 这是这一组**第一个带值的设置项** —— 同组另外三项都是 `action`（重建索引 / 打开历史目录 /
 * 打开索引目录），没有值，所以「`data` 组全是按钮」这个假设从这一批起不再成立。
 *
 * 判据刻意不写死文案：**选项标签里嵌着数值**，而界面语言由 `localeManager` 决定。
 * 钉住的是那几条性质 —— 档位顺序、每个数字档的标签真的带上了那个数字、没有未替换的占位符、
 * 文案来自字典而不是原始键名。写死中文会让这条用例在换语言时假红。
 */
describe('设置视图 · 数据', () => {
  const label = (key: string, vars?: Record<string, string>): string =>
    translate(localeManager.locale, key, vars);

  beforeEach(() => {
    settings.set('data.historyRetention', '100');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    settings.set('data.historyRetention', '100');
  });

  function retentionSelect(): HTMLSelectElement {
    return container.querySelector<HTMLSelectElement>(
      '[data-field-input="data.historyRetention"]'
    ) as HTMLSelectElement;
  }

  it('上限项渲染成下拉，默认档是 100', () => {
    renderSettings('data');

    expect(retentionSelect()).not.toBeNull();
    expect(retentionSelect().value).toBe('100');
    // 默认档也是存档值 —— 「界面上写着 100、存档里是别的」这种错位不会报错，只会按另一个数删。
    expect(settings.get('data.historyRetention')).toBe('100');
  });

  it('档位顺序固定，「不清理」排在最前', () => {
    renderSettings('data');

    expect(Array.from(retentionSelect().options).map((option) => option.value)).toEqual([
      'unlimited',
      '20',
      '50',
      '100',
      '200'
    ]);
  });

  it('数字档的标签真的带上了那个数字，没有未替换的占位符', () => {
    renderSettings('data');

    const numeric = Array.from(retentionSelect().options).filter(
      (option) => option.value !== 'unlimited'
    );
    expect(numeric).toHaveLength(4);

    for (const option of numeric) {
      const text = option.textContent ?? '';
      expect(text).toContain(option.value);
      expect(text).not.toContain('{');
      // 字典里没有这个键时 `translate` 原样返回键名 —— 那会在界面上漏出 `settings.data.…`。
      expect(text).not.toContain('settings.');
    }
  });

  it('「不清理」的标签与数字档都不同 —— 它是独立的一条文案，不是拼出来的', () => {
    renderSettings('data');

    const [first, second] = Array.from(retentionSelect().options);
    const unlimited = first?.textContent ?? '';

    expect(unlimited).not.toContain('{');
    expect(unlimited).not.toContain('settings.');
    expect(unlimited).not.toBe(second?.textContent);
    expect(unlimited).toBe(label('settings.data.historyRetentionUnlimited'));
  });

  it('选「不清理」写进存档，枚举项不画重置键', () => {
    renderSettings('data');

    const select = retentionSelect();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value'
      )?.set;
      setter?.call(select, 'unlimited');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(settings.get('data.historyRetention')).toBe('unlimited');
    expect(container.querySelector('[data-field-reset="data.historyRetention"]')).toBeNull();
  });

  it('同组的四个动作仍在 —— 加一项带值的控件不该把按钮挤掉', () => {
    renderSettings('data');

    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[data-field-action]')).map(
        (el) => el.dataset.fieldAction
      )
    ).toEqual([
      'data.rebuildIndex',
      'data.openHistoryDirectory',
      'data.openIndexDirectory',
      'data.diagnostics'
    ]);
  });
});

/**
 * 可访问性与排版收口（2026-10-01 设置页审核）。
 *
 * 这一批改的全是「看不见、但会出事」的地方：读屏认不认得出这是标签页、页面有没有一个标题
 * 锚点、空态读起来像不像「坏了」、切分组之后用户落在哪、长路径在哪断行。
 *
 * 判据一律取结构与 ARIA 属性。配色、尺寸、字体继承、窄窗口断点**不在这里** ——
 * happy-dom 不排版也解不出自定义属性，那些只有真机量得出来（见
 * `.workbuddy-ai/skills/nexus-ui-audit`）。
 */
describe('设置视图 · 可访问性结构', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  /**
   * 左栏是**竖排标签页**。少了 `role`，读屏念到的是一串按钮 —— 听不出「这七个属于同一组、
   * 每次只有一个是当前的」，也听不出右边那一大片属于哪一个。
   *
   * 互指是双向的：tab 有 `id`，panel 的 `aria-labelledby` 指着它。只写一边等于没写。
   */
  it('左栏是竖排 tablist，tab 与 tabpanel 用 id 互指', () => {
    renderSettings('appearance');

    const nav = container.querySelector('.nexus-settings-nav');
    expect(nav?.getAttribute('role')).toBe('tablist');
    expect(nav?.getAttribute('aria-orientation')).toBe('vertical');
    // 标签页组本身也要有个名字，否则读屏只说「标签页」，不说这是「设置分组」。
    expect(nav?.getAttribute('aria-label')).toBe(
      translate(localeManager.locale, 'settings.navAria')
    );

    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(tabs).toHaveLength(SECTIONS.length);
    for (const tab of tabs) {
      const id = tab.dataset.section ?? '';
      expect(tab.id, id).not.toBe('');
      expect(tab.getAttribute('aria-selected'), id).not.toBeNull();
    }

    const panel = container.querySelector<HTMLElement>('[role="tabpanel"]');
    expect(panel).not.toBeNull();
    expect(panel?.id).not.toBe('');
    expect(panel?.getAttribute('aria-labelledby')).toBe(
      container.querySelector('[data-section="appearance"]')?.id
    );
    // 面板可聚焦：键盘用户按 Tab 进来之后要能直接滚内容，而不是先落在某个控件上。
    expect(panel?.getAttribute('tabindex')).toBe('0');
  });

  /**
   * 页面只有**一个** `h1`（设置窗口的标题），各分组标题是 `h2`。
   *
   * 空态也要有 `h2`：可用分组各有一个，只有空态没有的话，读屏按标题跳转是「进得来、出不去」——
   * 停在一个不知道自己属于哪一组的位置上。
   */
  it('页面一个 h1，可用分组与空态各有一个 h2', () => {
    renderSettings('editor');

    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('.nexus-settings-nav-title')?.tagName).toBe('H1');
    expect(container.querySelectorAll('.nexus-settings-section-title')).toHaveLength(1);
    expect(container.querySelector('.nexus-settings-section-title')?.tagName).toBe('H2');

    act(() => {
      root.render(<SettingsView section="sync" onSelectSection={() => {}} />);
    });

    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('.nexus-settings-empty-title')?.tagName).toBe('H2');
    // 空态的标题是**这一组**的名字，不是一句通用的「空」。
    expect(container.querySelector('.nexus-settings-empty-title')?.textContent).toBe(
      translate(
        localeManager.locale,
        SECTIONS.find((item) => item.id === 'sync')!.titleKey
      )
    );
  });

  /**
   * 空态要说清「这里还没做」，不是「这里坏了」—— 只给一句「尚未提供」，用户分不出这两种，
   * 于是会去查是不是自己弄坏了什么。
   *
   * 图标是**装饰**（`aria-hidden`）：读屏把方框图形念一遍没有任何信息量。
   */
  it('空态是「图标 + 标题 + 两行说明」，图标是装饰', () => {
    renderSettings('sync');

    const empty = container.querySelector('.nexus-settings-empty');
    expect(empty).not.toBeNull();
    expect(
      empty?.querySelector('.nexus-settings-empty-icon svg')?.getAttribute('aria-hidden')
    ).toBe('true');
    expect(empty?.querySelector('.nexus-settings-empty-text')?.textContent).toBe(
      translate(localeManager.locale, 'settings.planned')
    );
    // 这一句是这次新加的那一行 —— 它区分「这里坏了」与「这里还没做」。
    expect(empty?.querySelector('.nexus-settings-empty-hint')?.textContent).toBe(
      translate(localeManager.locale, 'settings.plannedHint')
    );
    expect(container.querySelector('[data-field]')).toBeNull();
  });

  /**
   * 导航项带 `title`。窄窗口（≤720px）下标签被**视觉隐藏**（不是 `display: none` ——
   * 那样可访问名一起没了），那一刻 `title` 是唯一能把分组名看全的地方。
   */
  it('导航项带 title，窄窗口收起标签后仍能看全分组名', () => {
    renderSettings();

    for (const item of navItems()) {
      const id = item.dataset.section ?? '';
      const section = SECTIONS.find((candidate) => candidate.id === id);
      expect(item.getAttribute('title'), id).toBe(
        translate(localeManager.locale, section!.titleKey)
      );
    }
  });

  /**
   * 切分组把内容区滚回顶部。不这么做会**保留上一个分组的滚动位置** —— 从长分组切到另一个
   * 长分组时用户落在半空中，看不到分组标题（真机实测：Editor 滚到 859，切到 Files 之后是 9，
   * 那还是被新内容高度夹过的结果）。
   *
   * 判据是「同一个 DOM 节点上收到了 `scrollTo({ top: 0 })`」—— 不是「组件重渲染了」。
   */
  it('切分组把内容区滚回顶部', () => {
    renderSettings('editor');

    const content = container.querySelector<HTMLElement>('.nexus-settings-content');
    expect(content).not.toBeNull();

    const scrollTo = vi.fn();
    content!.scrollTo = scrollTo as unknown as Element['scrollTo'];

    act(() => {
      root.render(<SettingsView section="files" onSelectSection={() => {}} />);
    });

    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
  });
});

/**
 * 活区（live region）。
 *
 * 三处效果都**不在当前窗口里发生**：动作按钮的效果落在别的窗口 / 资源管理器；快捷键捕获被拒
 * 只在那一行给一行字；主题导入导出的结果落进存档。读屏只在「**已经存在的** live region 内容
 * 变化」时播报 —— 动态插入一个带 `role="status"` 的元素是不响的。
 *
 * 所以判据是「**常驻容器**上有 `aria-live`」，不是「那行提示上有 `role`」。两处的区别正是
 * 这一批要修的东西，写成后者这条用例会假绿。
 */
describe('设置视图 · 活区', () => {
  const originalBridge = (window as unknown as { nexus?: unknown }).nexus;

  beforeEach(() => {
    (window as unknown as { nexus: unknown }).nexus = {
      getWorkspaceRoots: () => Promise.resolve([])
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    (window as unknown as { nexus?: unknown }).nexus = originalBridge;
  });

  /** 探测是异步的，让它落地再断言 —— 否则会在用例之外刷 `act(...)` 警告。 */
  async function settle(): Promise<void> {
    await act(async () => {
      for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    });
  }

  it('动作字段的容器是 polite 活区，「为什么不能按」与回执都靠它念出来', async () => {
    renderSettings('data');
    await settle();

    const actions = Array.from(container.querySelectorAll<HTMLElement>('[data-field-action]'));
    expect(actions.length).toBeGreaterThan(0);

    for (const button of actions) {
      const id = button.dataset.fieldAction ?? '';
      // 容器是按钮的**父节点**，且按钮自己不是活区 —— 活区必须常驻。
      expect(button.getAttribute('aria-live'), id).toBeNull();
      expect(button.parentElement?.getAttribute('aria-live'), id).toBe('polite');
    }
  });

  it('快捷键每一行是 assertive 活区 —— 捕获被拒要立刻知道，不是等这一句读完', () => {
    renderSettings('keybindings');

    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-keybinding]'));
    expect(rows).toHaveLength(REMAPPABLE_ACTIONS.length);
    for (const row of rows) {
      expect(row.getAttribute('aria-live'), row.dataset.keybinding ?? '').toBe('assertive');
    }
  });

  it('主题导入导出是 polite 活区', () => {
    renderSettings('appearance');

    expect(
      container.querySelector('[data-theme-transfer]')?.getAttribute('aria-live')
    ).toBe('polite');
  });
});

/**
 * 长路径的断行点（`FieldRow.tsx` 的 `withBreakOpportunities`）。
 *
 * CSS 不认 `\` 与 `/` 是断行机会，所以长路径要么撑破容器，要么只能在任意字符处断开
 * （`word-break: break-all`）—— 断点落在目录名中间，用户没法按层级扫读。`<wbr>` 把断点挪到
 * 分隔符**之后**。
 *
 * 判据是 DOM 结构（`<wbr>` 的条数与文本内容），不是视觉 —— happy-dom 不排版。
 * 「文本内容一字不差」这条尤其重要：插元素最坏的结果是把用户要复制的路径改掉了。
 */
describe('设置视图 · 长路径断行', () => {
  const originalBridge = (window as unknown as { nexus?: unknown }).nexus;

  const INDEX_PATH = 'C:/Users/tester/AppData/Roaming/Nexus/workspace-index/9f3a1c07.db';

  function stubBridge(indexPath: string | null): void {
    (window as unknown as { nexus: unknown }).nexus = {
      getWorkspaceRoots: () => Promise.resolve(['E:/notes']),
      getIndexPath: () => Promise.resolve(indexPath),
      getDiagnostics: () => Promise.resolve(null)
    };
  }

  async function settle(): Promise<void> {
    await act(async () => {
      for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    (window as unknown as { nexus?: unknown }).nexus = originalBridge;
  });

  it('路径按分隔符切成多段，段间插 wbr，且文本一字不差', async () => {
    stubBridge(INDEX_PATH);
    renderSettings('data');
    await settle();

    const readonly = container.querySelector<HTMLElement>(
      '[data-field-readonly="data.openIndexDirectory"]'
    );
    expect(readonly).not.toBeNull();

    // 7 段（`C:/` `Users/` `tester/` `AppData/` `Roaming/` `Nexus/` `workspace-index/` `…db`）
    // 之间有 7 个断点。
    const breaks = readonly!.querySelectorAll('wbr');
    expect(breaks).toHaveLength(7);

    // 插元素不改内容：用户框选复制出来的还是同一条路径。
    expect(readonly!.textContent).toBe(INDEX_PATH);
  });

  it('没有分隔符的值原样输出，不插 wbr', async () => {
    stubBridge('9f3a1c07.db');
    renderSettings('data');
    await settle();

    const readonly = container.querySelector<HTMLElement>(
      '[data-field-readonly="data.openIndexDirectory"]'
    );
    expect(readonly?.textContent).toBe('9f3a1c07.db');
    expect(readonly?.querySelectorAll('wbr')).toHaveLength(0);
  });

  /**
   * 多行文本（诊断信息）自己带换行，`white-space: pre-wrap` 会处理 —— 再插 `<wbr>` 只会让
   * 每一行内部多出一堆无意义的断点。
   */
  it('多行文本原样输出，不插 wbr', async () => {
    (window as unknown as { nexus: unknown }).nexus = {
      getWorkspaceRoots: () => Promise.resolve([]),
      getDiagnostics: () =>
        Promise.resolve({
          version: '0.45.0',
          platform: 'win32-x64',
          electron: '33.0.0',
          chromium: '130.0.0.0',
          node: '20.18.0',
          workspaceRoot: 'E:/notes'
        })
    };
    renderSettings('data');
    await settle();

    const readonly = container.querySelector<HTMLElement>(
      '[data-field-readonly="data.diagnostics"]'
    );
    expect(readonly).not.toBeNull();
    expect(readonly!.textContent).toContain('\n');
    expect(readonly!.querySelectorAll('wbr')).toHaveLength(0);
  });
});
