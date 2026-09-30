/**
 * 设置注册表：分组与字段的**唯一数据源**。设置页左栏、内容区、外观菜单（现名「首选项」）都读它 ——
 * 三处各列一遍必然漂移，而漂移已经发生过一次：手写的外观菜单漏掉了「跟随系统」。
 *
 * `availability` 落在数据上、不是组件里的 8 个 `if` —— 这是「全部分组都显示、未实现的走空态」的前提。
 *
 * **字段可以属于一个本期不做内容的分组**：`keybindings` / `plugins` / `sync` / `files` 四组仍是
 * `planned`，内容区是空态，但仍是菜单项。按分组过滤菜单会让它们消失，那是功能回退。
 */

import {
  BUILT_IN_PRESETS,
  THEME_MODES,
  choiceWithMode,
  formatSelection,
  isThemeMode,
  parseSelection,
  presetOfScheme,
  presetVariantsOf,
  userThemeName,
  type ThemeMode
} from '@nexus/theme';
import type React from 'react';
import {
  AppearanceIcon,
  DataIcon,
  EditorIcon,
  FilesIcon,
  GeneralIcon,
  KeybindingsIcon,
  PluginsIcon,
  SyncIcon
} from '../components/section-icons.js';
import { applyThemeChoice, localeManager, mermaidPreviewPreference, settings, themeManager } from '../platform.js';
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH
} from '../workspace/panel-width.js';
import {
  EDITOR_CONTENT_WIDTH_OPTIONS,
  EDITOR_FONT_FAMILIES,
  EDITOR_FONT_SIZE,
  EDITOR_LINE_HEIGHT,
  EDITOR_PARAGRAPH_SPACING
} from './editor-typography.js';
import type { MenuBarItem } from '../MenuBar.js';

export type SectionId =
  | 'general'
  | 'editor'
  | 'files'
  | 'appearance'
  | 'keybindings'
  | 'plugins'
  | 'sync'
  | 'data';

export interface SectionDef {
  id: SectionId;
  titleKey: string;
  /** 左栏图标。**图形在 `components/section-icons.tsx`** —— 颜色由左栏按三态给，图标不持色。 */
  icon: React.ReactNode;
  /** 左栏排序，从 1 起。 */
  order: number;
  /** `planned` = 出现在左栏、进得去但内容区只有空态。 */
  availability: 'available' | 'planned';
}

/**
 * 八个分组，**数组顺序即左栏顺序**。
 *
 * `files` 是后加的第八组：它管「文件落在哪、链接怎么写」，与 `editor` 同属「文档本身」，
 * 所以排在 `editor` 之后、`appearance` 这类界面项之前。
 *
 * `availability` 落在数据上而不是组件里的分支 —— 未实现的分组**可点、可进入**，内容区给空态。
 * 把它们从数组里删掉（每加一组都要改导航结构）或禁用（「点了没反应」）都更糟。
 */
export const SECTIONS: readonly SectionDef[] = [
  {
    id: 'general',
    titleKey: 'settings.section.general',
    icon: GeneralIcon,
    order: 1,
    availability: 'available'
  },
  {
    id: 'editor',
    titleKey: 'settings.section.editor',
    icon: EditorIcon,
    order: 2,
    availability: 'available'
  },
  {
    id: 'files',
    titleKey: 'settings.section.files',
    icon: FilesIcon,
    order: 3,
    availability: 'planned'
  },
  {
    id: 'appearance',
    titleKey: 'settings.section.appearance',
    icon: AppearanceIcon,
    order: 4,
    availability: 'available'
  },
  {
    id: 'keybindings',
    titleKey: 'settings.section.keybindings',
    icon: KeybindingsIcon,
    order: 5,
    availability: 'planned'
  },
  {
    id: 'plugins',
    titleKey: 'settings.section.plugins',
    icon: PluginsIcon,
    order: 6,
    availability: 'planned'
  },
  {
    id: 'sync',
    titleKey: 'settings.section.sync',
    icon: SyncIcon,
    order: 7,
    availability: 'planned'
  },
  {
    id: 'data',
    titleKey: 'settings.section.data',
    icon: DataIcon,
    order: 8,
    availability: 'available'
  }
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
  /** 数值控件的取值域与步长。只在 `control: 'number'` 时有意义。 */
  min?: number;
  max?: number;
  step?: number;
  /** 数值控件的单位后缀（`px` / `%`）。纯展示，不参与解析 —— 值在 `accessor` 里是字符串。 */
  unit?: string;
  /**
   * 重置目标。**有它才画重置键** —— 判据是「重置的代价是否高于手动还原」：数值项被拖到 160
   * 之后再想回到 240 只能靠手感，给；枚举项再点一次原来那张卡就回来了，不给。
   */
  resetValue?: string;
  /**
   * 值访问器。**`control: 'action'` 的字段没有值，不填** —— 造一个「读恒为空串、写什么都不做」的
   * 空访问器会把「这个字段没有值」这件事从类型里抹掉，而菜单投影正是按它有无来决定能不能读。
   */
  accessor?: FieldAccessor;
  /** `action` 控件点击时执行。返回 Promise 时按钮在等待期间禁用，防连点。 */
  run?: () => void | Promise<void>;
  /**
   * `action` 控件的可用性探测：返回 `null` 表示可执行，否则返回**说明为什么不能**的字典键。
   *
   * 异步是必需的 —— 「当前有没有工作区」要问主进程。只在挂载时探一次：设置窗口是短命窗口，
   * 它开着的期间工作区不会变（换工作区要重开主窗口）。
   */
  probe?: () => Promise<string | null>;
  /** `action` 按钮的文案键。缺省用 `labelKey`。 */
  actionLabelKey?: string;
  /** 是否投影进菜单。投影的是**所有** `menu: true` 的字段，不按分组过滤。 */
  menu?: boolean;
}

/** 字段当前的选项表。渲染与菜单投影都走它，避免两处各判一次。 */
export function optionsOf(field: FieldDef, t: (key: string) => string): readonly FieldOption[] {
  return field.optionsOf?.(t) ?? field.options ?? [];
}

/**
 * 有值的字段。`accessor` 在 `FieldDef` 上是可选的（`action` 字段没有值），但**声明时**写成
 * 这个类型，用的人就不必每处再判一次 undefined。外观分组的专用组件直接读主题字段的访问器，
 * 正是靠它保持类型干净。
 */
export type ValueFieldDef = FieldDef & { accessor: FieldAccessor };

/**
 * 数值字段的写入口。**空串与非数字都不写**：`Number('')` 是 0，写进去会被夹成最小值 ——
 * 表现是「清空输入框就把这一项缩到底」。夹取归 `store` 的 `parse`，这里只挡非法输入。
 */
function writeNumber(
  path: 'editor.fontSize' | 'editor.lineHeight' | 'editor.paragraphSpacing' | 'editor.panelWidth',
  value: string
): void {
  if (value.trim() === '') return;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return;
  settings.set(path, parsed);
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
 *
 * 用户主题也是预设，但它的变体表只有 `ThemeManager` 知道 —— 所以两级查询。
 */
function clampMode(presetId: string, mode: ThemeMode): ThemeMode {
  const variants = presetVariantsOf(presetId) ?? themeManager.userVariantsOf(presetId);
  if (!variants) return mode;
  if (mode === 'auto') {
    return variants.light && variants.dark ? 'auto' : variants.dark ? 'dark' : 'light';
  }
  return variants[mode] ? mode : variants.light ? 'light' : 'dark';
}

/** 模式轴的标签。**顺序不在这里** —— 它由 `THEME_MODES` 定（跟随系统在最左），与界面一致。 */
const MODE_LABEL_KEYS: Record<ThemeMode, string> = {
  light: 'theme.mode.light',
  auto: 'theme.mode.auto',
  dark: 'theme.mode.dark'
};

/** 模式轴。**进菜单**：只有三项，是「现在想亮一点」这种即时动作。 */
export const THEME_MODE_FIELD: ValueFieldDef = {
  id: 'appearance.themeMode',
  section: 'appearance',
  labelKey: 'settings.appearance.themeMode',
  control: 'radio',
  options: THEME_MODES.map((mode): FieldOption => ({ value: mode, labelKey: MODE_LABEL_KEYS[mode] })),
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
export const THEME_PRESET_FIELD: ValueFieldDef = {
  id: 'appearance.themePreset',
  section: 'appearance',
  labelKey: 'settings.appearance.themePreset',
  control: 'preset',
  /**
   * 当前用户主题要**出现在列表里**，否则编辑完种子之后（编辑会 fork 出一个用户主题）一个预设
   * 都不勾选，用户看到的是「一个主题都没选」。文案带一个「自定义」后缀与同名的出厂预设区分开。
   *
   * 取的是**存档里那一份**，不是「当前解析到的那份」：切到内置预设后 `activeUserTheme` 变成
   * `null`，按它列会让用户主题从列表里消失 —— 而它还在存档里（`ThemeManager` 构造时照样注册），
   * 只是没被选中。那等于「切走一次就再也回不来」。
   */
  optionsOf: (t) => {
    const userThemes = settings.get('appearance.userThemes');
    return [
      ...BUILT_IN_PRESETS.map((preset) => ({ value: preset.id, label: preset.name })),
      ...userThemes.map((theme) => ({
        value: theme.id,
        label: `${userThemeName(theme)} · ${t('theme.custom')}`
      }))
    ];
  },
  accessor: {
    read: () => {
      const selection = parseSelection(settings.get('appearance.theme'));
      return 'preset' in selection ? selection.preset : selection.id;
    },
    write: (value) => {
      // 用户主题也是**预设**（明暗两版共用它做 id），所以照样带模式轴 —— 切走再切回来时
      // 「我在编辑自定义主题」这件事不该丢。模式沿用当前那条选择里已有的，并夹到目标预设
      // 支持的范围内（单变体预设上停在一个它没有的模式，控件与渲染会对不上）。
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

/**
 * 侧栏面板宽度。**目前唯一一个数值项**，也是「逐项重置」的第一个消费者。
 *
 * 写入口是裸的 `settings.set`（不像主题那样要一个具名函数）：这个值不驱动别的东西 ——
 * 主窗口订阅了 `editor.panelWidth`，改完自己会跟上。
 */
export const PANEL_WIDTH_FIELD: FieldDef = {
  id: 'editor.panelWidth',
  section: 'editor',
  labelKey: 'settings.editor.panelWidth',
  descriptionKey: 'settings.editor.panelWidthDescription',
  control: 'number',
  min: PANEL_MIN_WIDTH,
  max: PANEL_MAX_WIDTH,
  step: 10,
  unit: 'px',
  resetValue: String(PANEL_DEFAULT_WIDTH),
  accessor: {
    read: () => String(settings.get('editor.panelWidth')),
    write: (value) => writeNumber('editor.panelWidth', value),
    subscribe: (listener) => settings.subscribe('editor.panelWidth', listener)
  },
  menu: false
};

/**
 * 自动保存。**开关只门控「改完自动落盘」，不门控保存本身** —— 关掉之后 `Cmd+S` 与
 * 关闭窗口前的那次保存照常工作，状态栏也照常显示未保存。关掉自动保存不等于关掉保存能力。
 */
export const AUTO_SAVE_FIELD: FieldDef = {
  id: 'general.autoSave',
  section: 'general',
  labelKey: 'settings.general.autoSave',
  descriptionKey: 'settings.general.autoSaveDescription',
  control: 'toggle',
  accessor: {
    read: () => String(settings.get('general.autoSave')),
    write: (value) => settings.set('general.autoSave', value === 'true'),
    subscribe: (listener) => settings.subscribe('general.autoSave', listener)
  },
  menu: false
};

/**
 * 排版四项。**每一项的 `resetValue` 都等于改版前的实际观感** —— 重置不是「回到某个新设计的默认」，
 * 而是「回到我改之前的样子」。
 *
 * 三项数值 + 两项枚举：枚举项**不给重置键**（再点一次原来的档位就回来了），数值项给 ——
 * 判据见 `FieldDef.resetValue`。
 */
export const FONT_SIZE_FIELD: FieldDef = {
  id: 'editor.fontSize',
  section: 'editor',
  labelKey: 'settings.editor.fontSize',
  descriptionKey: 'settings.editor.fontSizeDescription',
  control: 'number',
  min: EDITOR_FONT_SIZE.min,
  max: EDITOR_FONT_SIZE.max,
  step: EDITOR_FONT_SIZE.step,
  unit: 'px',
  resetValue: String(EDITOR_FONT_SIZE.fallback),
  accessor: {
    read: () => String(settings.get('editor.fontSize')),
    write: (value) => writeNumber('editor.fontSize', value),
    subscribe: (listener) => settings.subscribe('editor.fontSize', listener)
  },
  menu: false
};

export const LINE_HEIGHT_FIELD: FieldDef = {
  id: 'editor.lineHeight',
  section: 'editor',
  labelKey: 'settings.editor.lineHeight',
  descriptionKey: 'settings.editor.lineHeightDescription',
  control: 'number',
  min: EDITOR_LINE_HEIGHT.min,
  max: EDITOR_LINE_HEIGHT.max,
  step: EDITOR_LINE_HEIGHT.step,
  resetValue: String(EDITOR_LINE_HEIGHT.fallback),
  accessor: {
    read: () => String(settings.get('editor.lineHeight')),
    write: (value) => writeNumber('editor.lineHeight', value),
    subscribe: (listener) => settings.subscribe('editor.lineHeight', listener)
  },
  menu: false
};

export const PARAGRAPH_SPACING_FIELD: FieldDef = {
  id: 'editor.paragraphSpacing',
  section: 'editor',
  labelKey: 'settings.editor.paragraphSpacing',
  descriptionKey: 'settings.editor.paragraphSpacingDescription',
  control: 'number',
  min: EDITOR_PARAGRAPH_SPACING.min,
  max: EDITOR_PARAGRAPH_SPACING.max,
  step: EDITOR_PARAGRAPH_SPACING.step,
  unit: 'px',
  resetValue: String(EDITOR_PARAGRAPH_SPACING.fallback),
  accessor: {
    read: () => String(settings.get('editor.paragraphSpacing')),
    write: (value) => writeNumber('editor.paragraphSpacing', value),
    subscribe: (listener) => settings.subscribe('editor.paragraphSpacing', listener)
  },
  menu: false
};

export const CONTENT_WIDTH_FIELD: FieldDef = {
  id: 'editor.contentWidth',
  section: 'editor',
  labelKey: 'settings.editor.contentWidth',
  descriptionKey: 'settings.editor.contentWidthDescription',
  control: 'select',
  options: EDITOR_CONTENT_WIDTH_OPTIONS,
  accessor: {
    read: () => settings.get('editor.contentWidth'),
    write: (value) => settings.set('editor.contentWidth', value),
    subscribe: (listener) => settings.subscribe('editor.contentWidth', listener)
  },
  menu: false
};

export const FONT_FAMILY_FIELD: FieldDef = {
  id: 'editor.fontFamily',
  section: 'editor',
  labelKey: 'settings.editor.fontFamily',
  descriptionKey: 'settings.editor.fontFamilyDescription',
  control: 'select',
  options: EDITOR_FONT_FAMILIES.map((family): FieldOption => ({
    value: family.value,
    labelKey: `settings.editor.fontFamily.${family.value}`
  })),
  accessor: {
    read: () => settings.get('editor.fontFamily'),
    write: (value) => settings.set('editor.fontFamily', value),
    subscribe: (listener) => settings.subscribe('editor.fontFamily', listener)
  },
  menu: false
};

/**
 * 当前工作区根。轻量模式（只打开了一个文件）下没有工作区，`data` 组里依赖它的动作据此禁用 ——
 * 让按钮点得动、点了什么都不发生，比禁用加一行原因更糟。
 */
async function currentWorkspaceRoot(): Promise<string | null> {
  const roots = await window.nexus?.getWorkspaceRoots();
  return roots?.[0] ?? null;
}

async function workspaceProbe(): Promise<string | null> {
  return (await currentWorkspaceRoot()) ? null : 'settings.data.needsWorkspace';
}

/**
 * 重建索引。**入口放在设置页而不是侧栏**：侧栏那次是进入工作区时的自动预热，而这里是
 * 「索引看起来不对」时的手动修复 —— 两件事的触发时机不同，不该共用同一个入口。
 */
export const REBUILD_INDEX_FIELD: FieldDef = {
  id: 'data.rebuildIndex',
  section: 'data',
  labelKey: 'settings.data.rebuildIndex',
  descriptionKey: 'settings.data.rebuildIndexDescription',
  control: 'action',
  actionLabelKey: 'settings.data.rebuildIndexAction',
  probe: workspaceProbe,
  run: async () => {
    const root = await currentWorkspaceRoot();
    if (!root) return;
    await window.nexus?.rebuildIndex(root);
  },
  menu: false
};

/**
 * 打开版本历史目录。历史在 `<workspace>/.nexus/history/`，用户想自己备份或翻旧版本时，
 * 这里比「在资源管理器里一层层点进去」快 —— 而 `.nexus` 是隐藏目录，很多人根本不知道它在。
 */
export const OPEN_HISTORY_DIR_FIELD: FieldDef = {
  id: 'data.openHistoryDirectory',
  section: 'data',
  labelKey: 'settings.data.openHistoryDirectory',
  descriptionKey: 'settings.data.openHistoryDirectoryDescription',
  control: 'action',
  actionLabelKey: 'settings.data.openHistoryDirectoryAction',
  probe: workspaceProbe,
  run: async () => {
    const root = await currentWorkspaceRoot();
    if (!root) return;
    await window.nexus?.openHistoryDirectory(root);
  },
  menu: false
};

/** 全部字段。**加一项只改这里** —— 菜单投影与设置页内容区都从它派生。 */
export const FIELDS: readonly FieldDef[] = [
  THEME_MODE_FIELD,
  THEME_PRESET_FIELD,
  LOCALE_FIELD,
  MERMAID_FIELD,
  AUTO_SAVE_FIELD,
  FONT_FAMILY_FIELD,
  FONT_SIZE_FIELD,
  LINE_HEIGHT_FIELD,
  PARAGRAPH_SPACING_FIELD,
  CONTENT_WIDTH_FIELD,
  PANEL_WIDTH_FIELD,
  REBUILD_INDEX_FIELD,
  OPEN_HISTORY_DIR_FIELD
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
    // `action` 字段没有值可读 —— 菜单只投影「有当前值」的字段（枚举选中态、开关的开关态）。
    // 提成局部常量是必需的：闭包里读 `field.accessor` 会丢掉上面那次收窄。
    const accessor = field.accessor;
    if (!accessor) continue;
    if (items.length > 0) items.push(SEPARATOR);

    const current = accessor.read();
    if (field.control === 'toggle') {
      items.push({
        label: t(field.labelKey),
        active: current === 'true',
        onSelect: () => accessor.write(current === 'true' ? 'false' : 'true')
      });
      continue;
    }

    for (const option of optionsOf(field, t)) {
      items.push({
        label: optionLabel(option, t),
        active: current === option.value,
        onSelect: () => accessor.write(option.value)
      });
    }
  }

  items.push(SEPARATOR, { label: t('cmd.openSettings'), onSelect: onOpenSettings });
  return items;
}
