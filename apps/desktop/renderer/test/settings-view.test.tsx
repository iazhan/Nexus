// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILT_IN_PRESETS, BUILT_IN_SCHEMES, DEFAULT_THEME_CHOICE } from '@nexus/theme';
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
import {
  applySchemePatch,
  applyThemeChoice,
  applyUserTheme,
  duplicateTheme,
  localeManager,
  settings,
  themeManager
} from '../src/platform.js';

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
   * 「无保存 / 无恢复默认」的判据用**按钮的种类**而不是文案：页面里每个按钮都必须落进一份
   * 已知清单（导航项 / 模式段控 / 预设卡 / 复制 / 新建 / 开主题窗口 / 导入导出）。文案会随语言变，
   * 多一个按钮却是结构性的 —— 出现 `other` 就意味着有人往设置页里塞了提交类控件，必须显式解释。
   *
   * 「返回工作区」那一类**已随独立窗口一并删掉**：窗口自己有标题栏关闭键，Escape 也能关，
   * 再留一个页内返回键就是第三个关闭入口。编辑器那一整片控件（档位页签、取色器、预览）也**不在
   * 这里了** —— 它们跟着主题窗口一起搬走，清单里因此不再有 `tier` / `preview` 两类。
   */
  it('页面里没有保存 / 提交 / 恢复默认控件', () => {
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
  });

  /**
   * 七个分组各有图标，且**七个图形两两不同** —— 同一套里出现两枚一样的，用户就得回头读文字
   * 才能区分，那图标等于没加。
   *
   * 配色（默认 muted / 悬停 secondary / 选中 accent）是 CSS 的事，happy-dom 解不出自定义属性，
   * 所以这里只断言结构：每个分组都有一枚、尺寸一致、都是装饰性的（`aria-hidden`）。
   */
  it('七个分组各有图标，图形两两不同', () => {
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
