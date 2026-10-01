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
import { applyThemeChoice, applyUserTheme, settings, themeManager } from '../src/platform.js';

/**
 * 主题编辑器的渲染与写回（P4-05 / P4-06）。
 *
 * 为什么这一层要有用例：真机用例一个文件只能启动一次 Electron、只跑一种形状，覆盖不到
 * 「只读态」「高级档才有提示条」「不达标才标对比度」「token 搜索过滤」这些分支。这里用组件
 * 自己的状态属性做判据（`data-*`、`aria-selected`），**不用文案节点**。
 *
 * 编辑器是**主题窗口的根内容**（外壳在 `theme-window.test.tsx`），左栏控件、右栏结果。两栏的
 * 判据用 DOM 归属（谁在 `.nexus-theme-inputs` 里、谁在 `.nexus-theme-results` 里）—— 这正是
 * 它从设置页搬出来的原因，被折成一栏就等于没搬。
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

/**
 * React 的 `onBlur` 挂在原生 `focusout` 上，而 `focusout` 只对**当前聚焦**的元素派发 ——
 * 对没聚焦的输入框调 `blur()` 在 happy-dom 里是空操作。所以先 `focus()`。
 */
function blurInput(input: HTMLInputElement): void {
  input.focus();
  input.blur();
}

function el<T extends HTMLElement>(selector: string): T | null {
  return container.querySelector<T>(selector);
}

function all<T extends HTMLElement>(selector: string): T[] {
  return Array.from(container.querySelectorAll<T>(selector));
}

/** 挂上编辑器。**只读态是可编辑态之外的另一种真实形状**，所以这里不偷偷替调用方 fork。 */
function renderEditor(): void {
  act(() => {
    root.render(<ThemeEditor />);
  });
}

/** 可编辑态：先走真实的 fork 路径造一份用户主题，不开测试专用的后门。 */
function renderEditable(): void {
  if (!themeManager.isEditable) themeManager.forkActiveToUserTheme();
  renderEditor();
}

/**
 * `themeManager` 与 `settings` 都是模块级单例，不还原会渗到同文件后面的用例。
 * 用户主题留在 `userThemes` 里无害 —— 选择回到默认预设后 `activeTheme` 就不是它了。
 */
function resetTheme(): void {
  settings.set('appearance.userThemes', []);
  applyThemeChoice(DEFAULT_THEME_CHOICE);
}

/** 存档里**当前正在编辑**的那份用户主题。列表里可能有好几套，按 id 取而不是取第一份。 */
function activeSaved() {
  return settings
    .get('appearance.userThemes')
    .find((item) => item.id === themeManager.theme.id);
}

/**
 * 存档里**当前正在编辑那一版**的方案。用户主题明暗两版共用同一个 id，读哪一版要按当前变体取 ——
 * 直接写 `variants.light` 会在默认深色的环境下读错那一版。
 */
function savedScheme() {
  const theme = settings
    .get('appearance.userThemes')
    .find((item) => item.id === themeManager.theme.id);
  const variant = themeManager.activeScheme?.variant;
  return theme && variant ? theme.variants[variant] : undefined;
}

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
}

function unmount(): void {
  act(() => root.unmount());
  container.remove();
  resetTheme();
}

describe('主题编辑器 · 数据表', () => {
  it('44 个 token 不重不漏，且与主题实际的 token 集合一致', () => {
    expect(ALL_EDITABLE_TOKENS).toHaveLength(44);
    expect(new Set(ALL_EDITABLE_TOKENS).size).toBe(44);
    expect([...ALL_EDITABLE_TOKENS].sort()).toEqual(Object.keys(themeManager.theme.tokens).sort());
  });

  it('16 个种子分成灰阶与强调色两组，各 8 个且不重不漏', () => {
    const slots = SEED_GROUPS.flatMap((group) => group.slots);
    expect(slots).toHaveLength(16);
    expect(new Set(slots).size).toBe(16);
    expect(Object.keys(SLOT_ROLE_KEYS).sort()).toEqual([...slots].sort());
  });

  /** 滑块键与派生用的系数必须同源 —— 少一个就等于有一个系数在界面上改不了。 */
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

/**
 * 只读态。**这是常态不是异常** —— 默认主题就是内置的，打开窗口先看到它才对。
 * 反过来「一打开就替你造一份副本」会让看一眼编辑器都留下垃圾主题。
 */
describe('主题编辑器 · 只读态（内置主题）', () => {
  beforeEach(() => {
    resetTheme();
    mount();
  });
  afterEach(unmount);

  it('内置主题上只给说明与「复制并开始编辑」，一个控件都不画', () => {
    renderEditor();

    expect(themeManager.isEditable).toBe(false);
    expect(el('[data-theme-readonly]')).not.toBeNull();
    expect(el('[data-theme-fork]')).not.toBeNull();
    expect(all('[data-theme-seed]')).toHaveLength(0);
    expect(all('[data-theme-tier]')).toHaveLength(0);
    // 源条上的「再来一份」与只读态那个按钮是同一个动作，只读态下不重复画。
    expect(el('[data-theme-copy-current]')).toBeNull();
  });

  /** 只读态下预览与体检照画 —— 先看清这套长什么样，再决定要不要复制。 */
  it('只读态右栏照样有预览与对比度体检', () => {
    renderEditor();

    expect(el('.nexus-theme-results [data-theme-preview]')).not.toBeNull();
    expect(el('.nexus-theme-results [data-theme-contrast-panel]')).not.toBeNull();
  });

  it('点「复制并开始编辑」：变成可编辑、控件出现、当前主题是用户主题', () => {
    renderEditor();

    act(() => {
      el<HTMLButtonElement>('[data-theme-fork]')!.click();
    });

    expect(themeManager.isEditable).toBe(true);
    expect(themeManager.theme.id.startsWith('user:')).toBe(true);
    expect(el('[data-theme-readonly]')).toBeNull();
    expect(el('[data-theme-tier-panel="basic"]')).not.toBeNull();
    expect(all('[data-theme-seed]')).toHaveLength(16);
  });
});

describe('主题编辑器 · 主题名', () => {
  beforeEach(() => {
    resetTheme();
    mount();
  });
  afterEach(unmount);

  /** 内置主题没有「名字」这回事：只读态给纯文本，可编辑态才换成输入框。 */
  it('只读态是纯文本，没有输入框', () => {
    renderEditor();

    expect(el('[data-theme-source-name]')).not.toBeNull();
    expect(el('[data-theme-name-input]')).toBeNull();
  });

  it('可编辑态输入框里是当前名字，改完失焦写回主题', () => {
    renderEditable();

    const input = el<HTMLInputElement>('[data-theme-name-input]')!;
    expect(input.value).toBe(themeManager.activeScheme!.name);

    act(() => {
      setInputValue(input, '我的主题');
      blurInput(input);
    });

    expect(themeManager.activeScheme?.name).toBe('我的主题');
    expect(input.value).toBe('我的主题');
  });

  /**
   * 名字是**非受控提交**：打字期间只动草稿，blur / Enter 才写盘。
   * 每次按键都写的话，用户删光重打的那一瞬间就把主题写坏了。
   */
  it('打字期间不写盘', () => {
    renderEditable();
    const before = savedScheme()?.name;

    const input = el<HTMLInputElement>('[data-theme-name-input]')!;
    act(() => {
      setInputValue(input, '半');
    });
    act(() => {
      setInputValue(input, '半成品');
    });

    expect(savedScheme()?.name).toBe(before);
  });

  it('Escape 还原草稿，不写回', () => {
    renderEditable();
    const original = themeManager.activeScheme!.name;

    const input = el<HTMLInputElement>('[data-theme-name-input]')!;
    act(() => {
      setInputValue(input, '临时');
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(themeManager.activeScheme?.name).toBe(original);
    expect(input.value).toBe(original);
  });

  /**
   * 空名绝不能落盘：`parseUserTheme` 拒收空名，写进去的存档下次启动会被**整份丢掉** ——
   * 主题连同它的覆盖项一起消失，而用户只是删光了输入框。
   *
   * 分两步：先成功改一次名让存档里有东西，再清空 —— 否则「存档还是 null」也能让断言通过，
   * 测不到任何东西。
   */
  it('清空后失焦：还原上一个合法名字，不落盘', () => {
    renderEditable();
    const input = el<HTMLInputElement>('[data-theme-name-input]')!;

    act(() => {
      setInputValue(input, '深色实验');
      blurInput(input);
    });
    expect(savedScheme()?.name).toBe('深色实验');

    act(() => {
      setInputValue(input, '   ');
      blurInput(input);
    });

    expect(themeManager.activeScheme?.name).toBe('深色实验');
    expect(savedScheme()?.name).toBe('深色实验');
    expect(input.value).toBe('深色实验');
  });

  /** 改名是方案自身的一部分，要跟种子、覆盖项一起进存档。 */
  it('改名落进存档', () => {
    renderEditable();

    const input = el<HTMLInputElement>('[data-theme-name-input]')!;
    act(() => {
      setInputValue(input, '深色实验');
      blurInput(input);
    });

    expect(savedScheme()?.name).toBe('深色实验');
  });
});

describe('主题编辑器 · 明暗两版', () => {
  beforeEach(() => {
    resetTheme();
    mount();
  });
  afterEach(unmount);

  /** 从两变体预设复制来的用户主题两版都有，源条上出现明暗切换器。 */
  it('两版都有时画切换器，选中的是当前那一版', () => {
    applyThemeChoice('nexus@light');
    renderEditable();

    const options = all<HTMLButtonElement>('[data-theme-variant]');
    expect(options.map((button) => button.getAttribute('data-theme-variant'))).toEqual([
      'light',
      'dark'
    ]);
    expect(el('[data-theme-variant="light"]')?.getAttribute('aria-checked')).toBe('true');
    expect(el('[data-theme-variant="dark"]')?.getAttribute('aria-checked')).toBe('false');
  });

  /** 切到深色换的是**同一套主题的另一版**，不是另一套主题 —— id 必须不变。 */
  it('切到深色：id 不变、种子换成深色那一版', () => {
    applyThemeChoice('nexus@light');
    renderEditable();
    const themeId = themeManager.theme.id;
    const lightSeed = el<HTMLInputElement>('[data-theme-seed="base00"]')!.value;

    act(() => {
      el<HTMLButtonElement>('[data-theme-variant="dark"]')!.click();
    });

    expect(themeManager.theme.id).toBe(themeId);
    expect(themeManager.activeScheme?.variant).toBe('dark');
    expect(settings.get('appearance.theme')).toBe(`${themeId}@dark`);
    expect(el<HTMLInputElement>('[data-theme-seed="base00"]')!.value).not.toBe(lightSeed);
  });

  /** 两版是各自独立的快照：改深色不该动到浅色 —— 它们只共用 id 与名字。 */
  it('改深色不动浅色', () => {
    applyThemeChoice('nexus@light');
    renderEditable();
    const themeId = themeManager.theme.id;
    // 先记下浅色那一版的原值再切过去 —— 判据自包含，不依赖出厂种子的具体色值。
    const lightBase00 = themeManager.activeUserTheme!.variants.light!.palette.base00;

    act(() => {
      el<HTMLButtonElement>('[data-theme-variant="dark"]')!.click();
    });
    act(() => {
      setInputValue(el<HTMLInputElement>('[data-theme-seed="base00"]')!, '#101010');
    });

    const saved = activeSaved()!;
    expect(saved.id).toBe(themeId);
    expect(saved.variants.dark?.palette.base00).toBe('#101010');
    expect(saved.variants.light?.palette.base00).toBe(lightBase00);
    // 两版本来就不一样，否则上面那条等于没测。
    expect(lightBase00).not.toBe('#101010');
  });

  /** 改名两版共用：只改当前那一版的话，切到另一边名字会跳回去。 */
  it('改名写进两版', () => {
    applyThemeChoice('nexus@light');
    renderEditable();

    const input = el<HTMLInputElement>('[data-theme-name-input]')!;
    act(() => {
      setInputValue(input, '双色实验');
      blurInput(input);
    });

    const saved = activeSaved()!;
    expect(saved.variants.light?.name).toBe('双色实验');
    expect(saved.variants.dark?.name).toBe('双色实验');
  });

  /** 单边主题没有另一边可切，退回一行纯文本。内置预设都是双变体，所以只能用用户主题造。 */
  it('单边主题不画切换器，只有一行模式文本', () => {
    const forked = themeManager.forkSchemeToUserTheme('gruvbox-light', 'user:single')!;
    applyUserTheme({ id: forked.id, variants: { light: forked.variants.light! } });
    renderEditable();

    expect(all('[data-theme-variant]')).toHaveLength(0);
    expect(el('[data-theme-source-variant]')).not.toBeNull();
  });
});

describe('主题编辑器 · 基础档', () => {
  beforeEach(() => {
    resetTheme();
    mount();
  });
  afterEach(unmount);

  it('默认是基础档：16 个取色器 + 5 个滑块，没有 token 行', () => {
    renderEditable();

    expect(el('[data-theme-tier-panel="basic"]')).not.toBeNull();
    expect(all('[data-theme-seed]')).toHaveLength(16);
    expect(all('[data-theme-tuning]')).toHaveLength(5);
    expect(all('[data-theme-token]')).toHaveLength(0);
    expect(el('[data-theme-tier="basic"]')?.getAttribute('aria-selected')).toBe('true');
  });

  /** 两栏是这次搬家的理由：控件在左、结果在右，被折成一栏就等于没搬。 */
  it('控件在左栏、预览与体检在右栏', () => {
    renderEditable();

    expect(el('.nexus-theme-inputs [data-theme-seed-group="grayscale"]')).not.toBeNull();
    expect(el('.nexus-theme-results [data-theme-preview]')).not.toBeNull();
    expect(el('.nexus-theme-results [data-theme-contrast-panel]')).not.toBeNull();
  });

  /**
   * 挂载前那份用户主题只进了内存（fork 不落盘），所以这一条证明的是**改动本身落盘**：
   * 拖完滑块存档里有这份用户主题、值是拖到的那个、当前选择也指着它。判据用**派生出的 token 值**
   * 而不是「有没有调用过某函数」。
   */
  it('拖一个系数滑块：token 跟着变、改动落盘', () => {
    renderEditable();
    const before = themeManager.theme.tokens['bg-surface-hover'];

    act(() => {
      setInputValue(el<HTMLInputElement>('[data-theme-tuning="surfaceHover"]')!, '0.4');
    });

    const saved = activeSaved();
    expect(saved?.id.startsWith('user:')).toBe(true);
    expect(savedScheme()?.tuning?.surfaceHover).toBe(0.4);
    // 用户主题是一条预设，选择带模式轴 —— 比的是「预设那一半」。
    expect(themeManager.themeChoice.startsWith(`${saved?.id}@`)).toBe(true);
    expect(themeManager.theme.tokens['bg-surface-hover']).not.toBe(before);
  });

  it('改一个种子：只动那个槽位，其余 token 仍是派生值', () => {
    renderEditable();
    const before = { ...themeManager.theme.tokens };
    const otherSlot = themeManager.activeScheme?.palette.base01;

    act(() => {
      setInputValue(el<HTMLInputElement>('[data-theme-seed="base00"]')!, '#101010');
    });

    expect(savedScheme()?.palette.base00).toBe('#101010');
    expect(savedScheme()?.palette.base01).toBe(otherSlot);
    // base00 直喂 bg-canvas（不做混合），所以它等于种子本身。
    expect(themeManager.theme.tokens['bg-canvas']).toBe('#101010');
    // 不参与修正、也不吃 base00 的 token 一律不变 —— 改一个种子不等于换一套主题。
    // （语法色会随 `binding` 的对比度修正目标一起挪，不能拿来当判据。）
    expect(themeManager.theme.tokens['border-default']).toBe(before['border-default']);
    expect(themeManager.theme.tokens['bg-surface']).toBe(before['bg-surface']);
  });

  /** 高级档动过的项切回基础档不能静默消失 —— 提示条是它唯一的出口。 */
  it('切回基础档时覆盖项提示条还在，条数正确', () => {
    renderEditable();

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

  /**
   * 修正记录是**结果**，与预览同栏。把种子改成和底色一样，派生必须报出它被修正过 ——
   * 只修正不说，用户不知道自己改的种子被动了。
   */
  it('修正记录画在右栏的结果里', () => {
    renderEditable();

    act(() => {
      setInputValue(el<HTMLInputElement>('[data-theme-seed="base05"]')!, '#ffffff');
    });

    expect(el('.nexus-theme-inputs [data-corrections]')).toBeNull();
    expect(el('.nexus-theme-results [data-corrections]')).not.toBeNull();
    expect(all('.nexus-theme-results [data-correction]').length).toBeGreaterThan(0);
  });
});

describe('主题编辑器 · 高级档', () => {
  beforeEach(() => {
    resetTheme();
    mount();
  });
  afterEach(unmount);

  function openAdvanced(): void {
    renderEditable();
    act(() => {
      el<HTMLButtonElement>('[data-theme-tier="advanced"]')!.click();
    });
  }

  it('切到高级档：44 个 token 行，种子与滑块消失', () => {
    openAdvanced();

    expect(el('[data-theme-tier-panel="advanced"]')).not.toBeNull();
    expect(all('[data-theme-token]')).toHaveLength(44);
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

  /** 「派生 / 覆盖」要一眼分得开：改过的行左边有竖线，名字旁的标记也跟着换。 */
  it('token 行标出这个值是派生的还是自己写的', () => {
    openAdvanced();
    expect(
      el('[data-theme-token="bg-canvas"] [data-token-state]')?.getAttribute('data-token-state')
    ).toBe('derived');

    act(() => {
      setInputValue(el<HTMLInputElement>('[data-theme-token-input="bg-canvas"]')!, '#101010');
    });

    expect(
      el('[data-theme-token="bg-canvas"] [data-token-state]')?.getAttribute('data-token-state')
    ).toBe('overridden');
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

  /** 44 行分五组铺开，不搜就只能滚；空匹配要给空态，而不是一片空白。 */
  it('token 搜索过滤到子集，无匹配时给空态', () => {
    openAdvanced();
    const groupCount = all('[data-theme-token-group]').length;
    expect(groupCount).toBeGreaterThan(1);

    act(() => {
      setInputValue(el<HTMLInputElement>('[data-theme-token-search]')!, 'syntax-heading');
    });

    expect(all('[data-theme-token]')).toHaveLength(1);
    expect(el('[data-theme-token="syntax-heading"]')).not.toBeNull();

    act(() => {
      setInputValue(el<HTMLInputElement>('[data-theme-token-search]')!, 'zzzz');
    });

    expect(all('[data-theme-token]')).toHaveLength(0);
    expect(el('[data-theme-token-search-empty]')).not.toBeNull();
  });

  /** 搜索框只在高级档出现：基础档 21 个控件，分组标题够用。 */
  it('基础档没有 token 搜索框', () => {
    renderEditable();
    expect(el('[data-theme-token-search]')).toBeNull();
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

  /**
   * 对比度体检是右栏的「结论」，与左栏每行的 `data-contrast="fail"` 分工不同 ——
   * 那边说「这一项怎么办」，这边说「整套现在怎么样」。
   */
  it('体检面板：不达标时给出结论并列出配对', () => {
    openAdvanced();

    act(() => {
      setInputValue(el<HTMLInputElement>('[data-theme-token-input="text-primary"]')!, '#fefefe');
    });

    const panel = el('[data-theme-contrast-panel]')!;
    expect(Number(panel.getAttribute('data-theme-contrast-panel'))).toBeGreaterThan(0);
    expect(el('[data-contrast-verdict="fail"]')).not.toBeNull();
    expect(all('[data-contrast-pair]').length).toBeGreaterThan(0);
    expect(el('.nexus-theme-results [data-theme-contrast-panel]')).not.toBeNull();
  });

  /**
   * 预览必须画**全**外壳，不能只剩编辑区 —— 主题改的不只是正文：标题栏、活动栏选中态、
   * 侧栏的树、标签页激活态、状态栏的点与度量各吃一批不同的 token，少画哪一段，那一段就只能靠猜。
   * 逐段点名，漏掉任何一段（比如某次重构把状态栏删了）这里会红。
   */
  it('预览区画的是真外壳 + 真组件与真编辑器', () => {
    renderEditable();

    const shell = el('[data-theme-preview-shell]')!;
    expect(shell.getAttribute('aria-hidden')).toBe('true');

    expect(shell.querySelector('.nexus-header-bar')).not.toBeNull();
    expect(shell.querySelectorAll('.nexus-window-controls .nexus-window-button')).toHaveLength(3);
    expect(shell.querySelector('.nexus-activity-bar')).not.toBeNull();
    expect(shell.querySelectorAll('.nexus-activity-icon').length).toBeGreaterThanOrEqual(5);
    expect(shell.querySelector('.nexus-activity-icon-active')).not.toBeNull();
    expect(shell.querySelector('.nexus-activity-panel')).not.toBeNull();
    expect(shell.querySelectorAll('.nexus-tree-item').length).toBeGreaterThanOrEqual(4);
    expect(shell.querySelector('.nexus-tree-item-active')).not.toBeNull();
    expect(shell.querySelectorAll('.nexus-tab')).toHaveLength(2);
    expect(shell.querySelector('.nexus-tab-active')).not.toBeNull();
    expect(shell.querySelector('.nexus-status-bar .status-dot')).not.toBeNull();

    // 真 CodeMirror 视图（`createSourceEditorView`）会往宿主里塞 `.cm-editor`。
    expect(shell.querySelector('[data-theme-preview-code] .cm-editor')).not.toBeNull();

    // 外壳之外仍并列着控件样例：状态条、命令面板输入框、按钮两态、选中底色。
    expect(el('[data-theme-preview]')).not.toBeNull();
    expect(el('[data-theme-preview-input]')).not.toBeNull();
    expect(el('.nexus-theme-preview .nexus-settings-option')).not.toBeNull();
    expect(el('.nexus-theme-preview-status[data-status="warning"]')).not.toBeNull();
    expect(el('.nexus-theme-preview-status[data-status="error"]')).not.toBeNull();
    expect(el('.nexus-theme-preview-selection')).not.toBeNull();
  });
});
