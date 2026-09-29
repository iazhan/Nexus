/**
 * 设置注册表：分组与字段的**唯一数据源**。设置页左栏、内容区、外观菜单（现名「首选项」）都读它 ——
 * 三处各列一遍必然漂移，而漂移已经发生过一次：手写的外观菜单漏掉了「跟随系统」。
 *
 * `availability` 落在数据上、不是组件里的 6 个 `if` —— 这是「七组全显示、未实现的走空态」的前提。
 *
 * **字段可以属于一个本期不做内容的分组**（语言属 General、mermaid 属 Editor，两组都还是 `planned`）：
 * 它们的内容区是空态，但仍是菜单项。按分组过滤菜单会让语言与 mermaid 消失，那是功能回退。
 */

import {
  BUILT_IN_PRESETS,
  choiceWithMode,
  formatSelection,
  isThemeMode,
  isUserThemeId,
  parseSelection,
  presetOfScheme,
  presetVariantsOf,
  type ThemeMode
} from '@nexus/theme';
import { applyThemeChoice, localeManager, mermaidPreviewPreference, settings, themeManager } from '../platform.js';
import type { MenuBarItem } from '../MenuBar.js';

export type SectionId =
  | 'general'
  | 'editor'
  | 'appearance'
  | 'keybindings'
  | 'plugins'
  | 'sync'
  | 'data';

export interface SectionDef {
  id: SectionId;
  titleKey: string;
  /** 左栏排序，从 1 起。 */
  order: number;
  /** `planned` = 出现在左栏、进得去但内容区只有空态。 */
  availability: 'available' | 'planned';
}

/**
 * 七个分组，顺序与 `nexus-ui-ux-blueprint.md` §14.1 一致。本期只有 `appearance` 是 `available`。
 * **不要把未做的分组从数组里删掉** —— 左栏是导航结构，缺项应该是空态而不是消失。
 */
export const SECTIONS: readonly SectionDef[] = [
  { id: 'general', titleKey: 'settings.section.general', order: 1, availability: 'planned' },
  { id: 'editor', titleKey: 'settings.section.editor', order: 2, availability: 'planned' },
  { id: 'appearance', titleKey: 'settings.section.appearance', order: 3, availability: 'available' },
  { id: 'keybindings', titleKey: 'settings.section.keybindings', order: 4, availability: 'planned' },
  { id: 'plugins', titleKey: 'settings.section.plugins', order: 5, availability: 'planned' },
  { id: 'sync', titleKey: 'settings.section.sync', order: 6, availability: 'planned' },
  { id: 'data', titleKey: 'settings.section.data', order: 7, availability: 'planned' }
];

/** 默认落点，也是 `settings.lastSection` 存档不可解读时的回落值。 */
export const DEFAULT_SECTION_ID: SectionId = 'appearance';

export function sectionById(id: SectionId): SectionDef | undefined {
  return SECTIONS.find((section) => section.id === id);
}

/** 存档里可能是旧的分组 id，用它校验成员资格 —— 不校验 `availability`，那六组也进得去（看空态）。 */
export function isSectionId(id: string): id is SectionId {
  return SECTIONS.some((section) => section.id === id);
}

export type FieldControl = 'radio' | 'select' | 'toggle' | 'number' | 'text' | 'action' | 'preset';

export interface FieldOption {
  value: string;
  /** 字典键。与 `label` 二选一。 */
  labelKey?: string;
  /** 直接给出的文案 —— 用户主题名这类**运行期才知道**的值没有字典键。 */
  label?: string;
}

/** 选项文案。两者都缺时回落到 `value`，不会渲染出空白。 */
export function optionLabel(option: FieldOption, t: (key: string) => string): string {
  if (option.label !== undefined) return option.label;
  return option.labelKey ? t(option.labelKey) : option.value;
}

/** 字段的值访问器。设置页与菜单只认这三个动作，不关心值存在哪里。 */
export interface FieldAccessor {
  read(): string;
  write(value: string): void;
  subscribe(listener: () => void): () => void;
}

export interface FieldDef {
  /** 稳定标识，也是测试锚点。 */
  id: string;
  section: SectionId;
  labelKey: string;
  descriptionKey?: string;
  control: FieldControl;
  options?: readonly FieldOption[];
  /**
   * 运行期才定的选项。有它时**优先于** `options` —— 用户主题是编辑出来的，静态表列不出来；
   * 两者都写会让「静态表是唯一真相」这句话失效。
   */
  optionsOf?: (t: (key: string) => string) => readonly FieldOption[];
  accessor: FieldAccessor;
  /** 是否投影进菜单。投影的是**所有** `menu: true` 的字段，不按分组过滤。 */
  menu?: boolean;
}

/** 字段当前的选项表。渲染与菜单投影都走它，避免两处各判一次。 */
export function optionsOf(field: FieldDef, t: (key: string) => string): readonly FieldOption[] {
  return field.optionsOf?.(t) ?? field.options ?? [];
}

/**
 * 主题的写入口是 `applyThemeChoice` 而**不是** `settings.set`：后者只改存档，`ThemeManager` 不动，
 * 表现是「点了主题没反应、重启后才生效」。选择落 store、解析归 `ThemeManager`，两件事都要发生。
 *
 * 选择是两轴的，所以这里是**两个字段**：模式与预设各自可读可写，合成一个字段的话菜单投影与
 * 设置页都得各自解析一遍那个复合字符串。
 */

/** 当前选择的模式。裸方案 id（用户主题）没有模式轴，显示它自己的明暗即可 —— 控件是禁用的。 */
function currentMode(): ThemeMode {
  const selection = parseSelection(settings.get('appearance.theme'));
  if ('preset' in selection) return selection.mode;
  return presetOfScheme(selection.id)?.mode ?? themeManager.theme.type;
}

/**
 * 把模式夹到预设支持的范围。单变体预设上停在一个它没有的模式会让人看不懂：控件显示「浅色」、
 * 主题实际是深色。
 */
function clampMode(presetId: string, mode: ThemeMode): ThemeMode {
  const variants = presetVariantsOf(presetId);
  if (!variants) return mode;
  if (mode === 'auto') {
    return variants.light && variants.dark ? 'auto' : variants.dark ? 'dark' : 'light';
  }
  return variants[mode] ? mode : variants.light ? 'light' : 'dark';
}

/** 模式轴。**进菜单**：只有三项，是「现在想亮一点」这种即时动作。 */
export const THEME_MODE_FIELD: FieldDef = {
  id: 'appearance.themeMode',
  section: 'appearance',
  labelKey: 'settings.appearance.themeMode',
  control: 'radio',
  options: [
    { value: 'light', labelKey: 'theme.mode.light' },
    { value: 'auto', labelKey: 'theme.mode.auto' },
    { value: 'dark', labelKey: 'theme.mode.dark' }
  ],
  accessor: {
    read: currentMode,
    write: (value) => {
      if (!isThemeMode(value)) return;
      applyThemeChoice(choiceWithMode(settings.get('appearance.theme'), value));
    },
    subscribe: (listener) => settings.subscribe('appearance.theme', listener)
  },
  menu: true
};

/**
 * 预设轴。**不进菜单**：五十多个预设列进去等于把菜单变成浏览器，而菜单一次只装得下一屏。
 * 设置窗口里那条可搜索的列表才是它的入口，菜单里留一条「设置…」就够。
 *
 * 预设名直接用出厂表里的 `name`，不进字典 —— 主题名是数据，翻译它会让「Dracula」在中文界面
 * 变成别的东西。
 */
export const THEME_PRESET_FIELD: FieldDef = {
  id: 'appearance.themePreset',
  section: 'appearance',
  labelKey: 'settings.appearance.themePreset',
  control: 'preset',
  /**
   * 当前用户主题要**出现在列表里**，否则编辑完种子之后（编辑会 fork 出一个用户主题）一个预设
   * 都不勾选，用户看到的是「一个主题都没选」。文案带一个「自定义」后缀与同名的出厂预设区分开。
   */
  optionsOf: (t) => {
    const userTheme = themeManager.activeUserTheme;
    return [
      ...BUILT_IN_PRESETS.map((preset) => ({ value: preset.id, label: preset.name })),
      ...(userTheme
        ? [{ value: userTheme.id, label: `${userTheme.scheme.name} · ${t('theme.custom')}` }]
        : [])
    ];
  },
  accessor: {
    read: () => {
      const selection = parseSelection(settings.get('appearance.theme'));
      return 'preset' in selection ? selection.preset : selection.id;
    },
    write: (value) => {
      // 用户主题是一条**具体方案**，没有预设轴 —— 写成 `<id>@<模式>` 会让它绕一圈再回来。
      if (isUserThemeId(value)) {
        applyThemeChoice(value);
        return;
      }
      applyThemeChoice(formatSelection({ preset: value, mode: clampMode(value, currentMode()) }));
    },
    subscribe: (listener) => settings.subscribe('appearance.theme', listener)
  },
  menu: false
};

/**
 * 语言与 mermaid 偏好**本期不迁进 `SettingsStore`**（`docs/phase-4-plan.md` §5.1 约束 ③）：
 * 它们现在能用、迁移是纯风险，且所属分组本期不做内容。所以访问器是适配器，不是 store 的代理。
 */
export const LOCALE_FIELD: FieldDef = {
  id: 'general.locale',
  section: 'general',
  labelKey: 'settings.general.locale',
  control: 'radio',
  options: [
    { value: 'zh-CN', labelKey: 'lang.zhCN' },
    { value: 'en-US', labelKey: 'lang.enUS' }
  ],
  accessor: {
    read: () => localeManager.locale,
    write: (value) => localeManager.setLocale(value),
    subscribe: (listener) => localeManager.subscribe(listener)
  },
  menu: true
};

export const MERMAID_FIELD: FieldDef = {
  id: 'editor.mermaidClickToReveal',
  section: 'editor',
  labelKey: 'mermaid.clickToReveal',
  control: 'toggle',
  accessor: {
    read: () => String(mermaidPreviewPreference.get()),
    write: (value) => mermaidPreviewPreference.set(value === 'true'),
    subscribe: (listener) => mermaidPreviewPreference.subscribe(listener)
  },
  menu: true
};

/** 全部字段。**加一项只改这里** —— 菜单投影与设置页内容区都从它派生。 */
export const FIELDS: readonly FieldDef[] = [
  THEME_MODE_FIELD,
  THEME_PRESET_FIELD,
  LOCALE_FIELD,
  MERMAID_FIELD
];

export function fieldsOfSection(section: SectionId): readonly FieldDef[] {
  return FIELDS.filter((field) => field.section === section);
}

const SEPARATOR: MenuBarItem = { label: '', separator: true };

export interface MenuProjectionOptions {
  t: (key: string) => string;
  onOpenSettings(): void;
}

/**
 * 把 `menu: true` 的字段投影成菜单项：`radio` 展开成每个选项一项，`toggle` 是一项点击取反。
 * 字段之间插分隔线，末尾固定跟一条「设置…」。
 *
 * **active 取 `accessor.read()`** —— 主题的判据因此是**选择**（`system` / 主题 id）而不是解析结果，
 * 否则「跟随系统」会和亮色或暗色同时点亮。
 */
export function projectMenuItems({ t, onOpenSettings }: MenuProjectionOptions): MenuBarItem[] {
  const items: MenuBarItem[] = [];

  for (const field of FIELDS) {
    if (!field.menu) continue;
    if (items.length > 0) items.push(SEPARATOR);

    const current = field.accessor.read();
    if (field.control === 'toggle') {
      items.push({
        label: t(field.labelKey),
        active: current === 'true',
        onSelect: () => field.accessor.write(current === 'true' ? 'false' : 'true')
      });
      continue;
    }

    for (const option of optionsOf(field, t)) {
      items.push({
        label: optionLabel(option, t),
        active: current === option.value,
        onSelect: () => field.accessor.write(option.value)
      });
    }
  }

  items.push(SEPARATOR, { label: t('cmd.openSettings'), onSelect: onOpenSettings });
  return items;
}
