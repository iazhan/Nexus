/**
 * 设置存储：把四种各写一遍的偏好形状收敛成一个入口 —— 读值渲染选中态、写值、订阅变化。
 *
 * 三条硬约束：① `storageKey` 与磁盘格式**冻结**（preload 的 `theme-boot.ts` 自己读 `nexus-theme`
 * 定首帧主题，改格式会让首屏闪烁回归）；② 值是「**选择**」不是解析结果（主题存 `<preset>@<mode>`
 * 或裸方案 id，`<html data-theme>` 仍是解析结果、归 `ThemeManager`）；③ `parse` 是值域的唯一权威
 * —— 读初值与写入都过它一遍，内存态与磁盘不会分裂。
 */

import {
  DEFAULT_THEME_CHOICE,
  normalizeThemeChoice,
  parseUserThemes,
  serializeUserThemes,
  THEME_STORAGE_KEY,
  type UserTheme
} from '@nexus/theme';
import {
  parseKeybindingOverrides,
  serializeKeybindingOverrides,
  type KeybindingOverrides
} from '@nexus/command';
import { normalizeAttachmentDirectory } from '@nexus/core';
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_WIDTH_STORAGE_KEY,
  clampPanelWidth
} from '../workspace/panel-width.js';
import {
  ATTACHMENT_DIRECTORY_DEFAULT,
  ATTACHMENT_DIRECTORY_STORAGE_KEY,
  ATTACHMENT_LOCATION_DEFAULT,
  ATTACHMENT_LOCATION_OPTIONS,
  ATTACHMENT_LOCATION_STORAGE_KEY,
  ATTACHMENT_NAME_TEMPLATE_DEFAULT,
  ATTACHMENT_NAME_TEMPLATE_STORAGE_KEY,
  AUTO_SAVE_DELAY,
  AUTO_SAVE_STORAGE_KEY,
  CODE_BLOCK_LINE_NUMBERS_STORAGE_KEY,
  CHROME_VISIBILITY,
  STATUS_BAR_METRICS,
  EDITOR_CONTENT_WIDTH_DEFAULT,
  EDITOR_CONTENT_WIDTH_OPTIONS,
  EDITOR_CONTENT_WIDTH_STORAGE_KEY,
  EDITOR_FONT_FAMILIES,
  EDITOR_FONT_FAMILY_DEFAULT,
  EDITOR_FONT_FAMILY_STORAGE_KEY,
  EDITOR_FONT_SIZE,
  EDITOR_LINE_HEIGHT,
  EDITOR_PARAGRAPH_SPACING,
  EDITOR_TABLE_LAYOUT_DEFAULT,
  EDITOR_TABLE_LAYOUT_OPTIONS,
  EDITOR_TABLE_LAYOUT_STORAGE_KEY,
  EDITOR_LINE_NUMBERS_STORAGE_KEY,
  EDITOR_WORD_COUNT_STORAGE_KEY,
  EXTERNAL_CHANGE_DEFAULT,
  EXTERNAL_CHANGE_OPTIONS,
  EXTERNAL_CHANGE_STORAGE_KEY,
  IGNORE_RULES_DEFAULT,
  IGNORE_RULES_STORAGE_KEY,
  HISTORY_RETENTION_DEFAULT,
  HISTORY_RETENTION_OPTIONS,
  HISTORY_RETENTION_STORAGE_KEY,
  NEW_DOCUMENT_LOCATION_DEFAULT,
  NEW_DOCUMENT_LOCATION_OPTIONS,
  NEW_DOCUMENT_LOCATION_STORAGE_KEY,
  RESTORE_LAST_WORKSPACE_STORAGE_KEY,
  parseGroupSetting,
  parseNumberSetting,
  serializeNumberSetting,
  UI_ZOOM_DEFAULT,
  UI_ZOOM_OPTIONS,
  UI_ZOOM_STORAGE_KEY,
  type GroupSettingSpec,
  type NumberSettingSpec
} from './preference-specs.js';

/** 一个设置项的定义。**不含 `path`** —— 表键就是它，两处各写一遍迟早对不上。 */
export interface SettingDef<T> {
  /** 磁盘键。冻结，见文件头约束 ①。 */
  readonly storageKey: string;
  /** 读不到 / 解析失败时的值。 */
  readonly fallback: T;
  /** 磁盘字符串 → 值。**值域校验与旧值迁移都在这里**。 */
  readonly parse: (raw: string | null) => T;
  /** 值 → 磁盘字符串。 */
  readonly serialize: (value: T) => string;
}

/**
 * 只做类型标注。直接用 `satisfies` 会把 `fallback` 收成字面量类型（`'system'` 而不是
 * `string`），`SettingValue` 跟着变窄，调用方传别的值就报错。
 */
function defineSetting<T>(def: SettingDef<T>): SettingDef<T> {
  return def;
}

/** 设置页默认落在哪个分组。值域归 P4-02 的 `SectionId` 校验，store 只保证「非空字符串」。 */
const DEFAULT_SECTION = 'appearance';

/**
 * 数值项的样板：夹取规则只在 `preference-specs.ts` 写一份，这里只负责接上。
 * 十来个外观 / 行为项里有四个是数值，各写一遍 parse 必然有一处漏夹。
 */
function numberSetting(spec: NumberSettingSpec) {
  return defineSetting<number>({
    storageKey: spec.storageKey,
    fallback: spec.fallback,
    parse: (raw) => parseNumberSetting(spec, raw),
    serialize: (value) => serializeNumberSetting(spec, value)
  });
}

/**
 * 开关项的样板。**只有显式的 `'false'` 算关** —— 空串、`null`、写坏的字符串一律当开。
 *
 * 这些开关的默认值全是「开」，而「读不懂就当关」会让存档里一个手滑的字符静默关掉一项能力，
 * 用户要过很久才发现（自动保存关掉会丢输入，行号关掉只是难看 —— 但判据一致比逐项解释便宜）。
 */
function toggleSetting(storageKey: string) {
  return defineSetting<boolean>({
    storageKey,
    fallback: true,
    parse: (raw) => raw !== 'false',
    serialize: (value) => String(value)
  });
}

/**
 * 开关项的样板（默认**关**）。与 `toggleSetting` 的差别不只是那个 `false`，
 * **认不出时的方向也相反**：那个是「读不懂就当开」，这个是「读不懂就当关」。
 *
 * 两条判据其实同一条 —— **回落到这项的默认值**。默认开的那几个（自动保存、行号）
 * 回落到开，因为静默关掉一项已有能力比留着它更糟；这一项默认就是关的，回落到关才自洽。
 * 而且它的后果更重：打开它意味着**下一次启动会对一个目录做授权**（写权限），
 * 存档里一个写坏的字符不该把用户送进某个工作区。
 */
function toggleSettingOff(storageKey: string) {
  return defineSetting<boolean>({
    storageKey,
    fallback: false,
    parse: (raw) => raw === 'true',
    serialize: (value) => String(value)
  });
}

/**
 * 枚举项的样板：**存档里有未知值就回落默认**。用户能改 localStorage，也能从旧版本升上来 ——
 * 读到不认识的档位时留着一个渲染不出来的值，表现是控件一个都不选中。
 */
function choiceSetting(
  storageKey: string,
  fallback: string,
  allowed: readonly string[]
) {
  return defineSetting<string>({
    storageKey,
    fallback,
    parse: (raw) => (raw !== null && allowed.includes(raw) ? raw : fallback),
    serialize: (value) => value
  });
}

/**
 * 开关组的样板：值是**被关掉的成员**（逗号分隔，空串 ＝ 全开）。
 *
 * 取值域与规范化都归 `preference-specs.ts`，这里只接上 —— 与 `numberSetting` 同一个理由：
 * 各写一遍必然有一处漏掉规范化，而漏掉的那处不会报错，只会让「值变了没有」误报。
 *
 * `parse` 与 `serialize` 是同一个函数，这是刻意的：这一项没有「另一种写法」，
 * 规范化（丢未知成员、去重、按 `options` 排序）就是它的全部语义。
 */
function groupSetting(spec: GroupSettingSpec) {
  return defineSetting<string>({
    storageKey: spec.storageKey,
    fallback: spec.fallback,
    parse: (raw) => parseGroupSetting(spec, raw),
    serialize: (value) => parseGroupSetting(spec, value)
  });
}

/**
 * 全部设置项。**加一项只改这里** —— `registry.ts` 的 `FieldDef` 表引用这些 path，菜单投影也读它。
 *
 * `locale` 与 mermaid 偏好**不在这里**：它们各有自己的管理器（`localeManager` /
 * `mermaidPreviewPreference`），字段表的访问器是适配器。设置页不关心值存在哪里 ——
 * `FieldAccessor` 那三个动作就是为此而设的，所以「搬进 store」只是形状统一，是纯风险。
 */
export const SETTING_DEFS = {
  'appearance.theme': defineSetting<string>({
    storageKey: THEME_STORAGE_KEY,
    fallback: DEFAULT_THEME_CHOICE,
    // 旧存档存的是主题**类型**（`dark` / `light`）或裸方案 id，`normalizeThemeChoice` 接住它们。
    // 迁移必须留在这里：preload 与 renderer 共用同一份规则，各写一遍就会「先按 A 画一帧、起来再跳 B」。
    parse: normalizeThemeChoice,
    serialize: (value) => value
  }),
  // 纯新项、没有历史包袱，用它验证「非枚举、不需要迁移」的路径。
  'settings.lastSection': defineSetting<string>({
    storageKey: 'nexus-settings-section',
    fallback: DEFAULT_SECTION,
    parse: (raw) => (raw !== null && raw.trim() !== '' ? raw : DEFAULT_SECTION),
    serialize: (value) => value
  }),
  /**
   * 全部用户主题（各自含它的覆盖项）。**不给覆盖项单开一个键** —— 覆盖项是用户主题的一部分，
   * 两个键存同一份状态迟早对不上。清空时写空串而不是 `removeItem`：`set` 的落盘路径只有一条。
   *
   * 值是**列表**：用户可以同时拥有多套自定义主题。磁盘键仍是单数的 `nexus-user-theme`
   * （冻结，见文件头约束 ①）—— 迁移靠 `parseUserThemes` 同时接受单个对象与数组两种形状，
   * 改键名会让老存档读不回来。
   */
  'appearance.userThemes': defineSetting<UserTheme[]>({
    storageKey: 'nexus-user-theme',
    fallback: [],
    // 坏 JSON / 内置 id / 槽位不全一律回落，不抛 —— 存档是用户能改的，读初值抛错会白屏。
    // 坏**项**丢掉而不是拒整份：一份里坏了一条不该让其余几套主题一起消失。
    parse: parseUserThemes,
    serialize: (value) => (value.length === 0 ? '' : serializeUserThemes(value))
  }),
  /**
   * 侧栏面板宽度。**磁盘键沿用 `nexus-panel-width`** —— 这次只是换了读写入口，格式一个字没动，
   * 老存档照常读得回来（越界值由 `parse` 夹取）。
   *
   * 它是「数值项给逐项重置」的第一个消费者：拖窄之后手感找不回来时，设置页里那个重置键是
   * 唯一的救援入口 —— 双击把手也能恢复，但那个交互只有已经知道的人才会用。
   */
  'editor.panelWidth': defineSetting<number>({
    storageKey: PANEL_WIDTH_STORAGE_KEY,
    fallback: PANEL_DEFAULT_WIDTH,
    // 空串要单独判：`Number('')` 是 0，夹取后变成 160（最小值），而不是回落到默认的 240。
    parse: (raw) => {
      if (raw === null || raw.trim() === '') return PANEL_DEFAULT_WIDTH;
      return clampPanelWidth(Number(raw));
    },
    serialize: (value) => String(clampPanelWidth(value))
  }),

  /**
   * 自动保存。关掉之后**只有显式保存才落盘**，编辑器仍会把状态标成未保存。
   *
   * 落盘时机见 `general.autoSaveDelay`：那是 debounce 延迟，不是周期快照间隔。
   */
  'general.autoSave': toggleSetting(AUTO_SAVE_STORAGE_KEY),

  /**
   * 自动保存延迟（毫秒）。**只在自动保存开着时有意义**，但不禁用控件 ——
   * 关掉自动保存时这个值仍会被保留，再打开时接着用；禁用它反而要多解释一次「为什么点不动」。
   */
  'general.autoSaveDelay': numberSetting(AUTO_SAVE_DELAY),

  /**
   * 外部修改文档时怎么处理。`smart` 是改版前的行为（干净就自动重载、有改动才提示），
   * 所以默认值不动观感。
   */
  'general.externalChange': choiceSetting(
    EXTERNAL_CHANGE_STORAGE_KEY,
    EXTERNAL_CHANGE_DEFAULT,
    EXTERNAL_CHANGE_OPTIONS.map((option) => option.value)
  ),

  /**
   * 启动时恢复上次打开的工作区。**默认关** ＝ 与加这一项之前完全一致（空启动就是一个空窗口）。
   *
   * 值是这一项的权威，主进程只持有一份给下次启动读的快照 —— 这条链见
   * `electron/recent-workspace.ts` 的头注释。改动这一项要连主进程一起看。
   */
  'general.restoreLastWorkspace': toggleSettingOff(RESTORE_LAST_WORKSPACE_STORAGE_KEY),

  'editor.fontSize': numberSetting(EDITOR_FONT_SIZE),
  'editor.lineHeight': numberSetting(EDITOR_LINE_HEIGHT),
  'editor.paragraphSpacing': numberSetting(EDITOR_PARAGRAPH_SPACING),

  'editor.contentWidth': choiceSetting(
    EDITOR_CONTENT_WIDTH_STORAGE_KEY,
    EDITOR_CONTENT_WIDTH_DEFAULT,
    EDITOR_CONTENT_WIDTH_OPTIONS.map((option) => option.value)
  ),

  'editor.fontFamily': choiceSetting(
    EDITOR_FONT_FAMILY_STORAGE_KEY,
    EDITOR_FONT_FAMILY_DEFAULT,
    EDITOR_FONT_FAMILIES.map((family) => family.value)
  ),

  'editor.tableLayout': choiceSetting(
    EDITOR_TABLE_LAYOUT_STORAGE_KEY,
    EDITOR_TABLE_LAYOUT_DEFAULT,
    EDITOR_TABLE_LAYOUT_OPTIONS.map((option) => option.value)
  ),

  /**
   * 行号槽。默认开 —— 这个设置项出现之前行号一直显示着，**关掉才是新行为**。
   *
   * 与 `editor.codeBlockLineNumbers` 是两件事：这个是**编辑器 gutter 的文档行号**
   * （源码模式与编辑态都在），那个是**代码块内部的正文行号**。
   */
  'editor.lineNumbers': toggleSetting(EDITOR_LINE_NUMBERS_STORAGE_KEY),

  /**
   * 状态栏字数。默认开：它是纯新增的展示项，不动任何已有元素 ——
   * 「默认等于改版前」在这里意味着「可以有」。
   */
  'editor.wordCount': toggleSetting(EDITOR_WORD_COUNT_STORAGE_KEY),

  'editor.codeBlockLineNumbers': toggleSetting(CODE_BLOCK_LINE_NUMBERS_STORAGE_KEY),

  /**
   * 快捷键覆盖表：命令 id → 规格串，值是空串表示**显式取消绑定**。
   *
   * 存**差量**而不是整表：默认绑定随版本变（新增命令、调整默认值），存整表会让老存档把新版本
   * 的默认值永久钉死在旧值上。差量下未覆盖的项自动跟上默认值。
   *
   * 空表写空串（与 `appearance.userThemes` 同一套：`set` 的落盘路径只有一条）。
   * 解析与序列化都在 `@nexus/command` —— 那层不认识 localStorage，只认字符串。
   */
  'keybindings.overrides': defineSetting<KeybindingOverrides>({
    storageKey: 'nexus-keybindings',
    fallback: {},
    // 坏 JSON / 坏项一律丢掉，不抛：存档是用户能改的，读初值抛错会白屏。
    parse: parseKeybindingOverrides,
    serialize: serializeKeybindingOverrides
  }),

  /**
   * 界面缩放。**档位字符串**（`'100'` / `'125'`…），不是倍率 —— 倍率在写进 `webFrame`
   * 那一刻才算（`ui-zoom.ts` 的 `uiZoomFactor`），存档里存的是用户看到的那个数。
   *
   * 与 `editor.fontSize` 的区别是刻意的：那个只改文档正文，这个把整个窗口一起缩放。
   */
  'appearance.uiZoom': choiceSetting(
    UI_ZOOM_STORAGE_KEY,
    UI_ZOOM_DEFAULT,
    UI_ZOOM_OPTIONS
  ),

  /**
   * 附件存放位置。**这一项与下面两项是「先有功能、再有设置项」的顺序** —— 粘贴图片落盘
   * 本身是同一批做的，设置项只是把已经写死的规则暴露出来。
   */
  'files.attachmentLocation': choiceSetting(
    ATTACHMENT_LOCATION_STORAGE_KEY,
    ATTACHMENT_LOCATION_DEFAULT,
    ATTACHMENT_LOCATION_OPTIONS.map((option) => option.value)
  ),

  /**
   * 附件子目录名。**归一化在 `@nexus/core`，这里不重写规则** —— 落盘路径也走同一个函数，
   * 两处各判一次的话「设置页显示 `assets`、实际写到别处」这种错误不会报错。
   *
   * 空串不会被存进来：`normalizeAttachmentDirectory` 把它落回 `assets`。空串的语义是
   * 「与文档同目录」，那和 `files.attachmentLocation` 选的「子目录」直接矛盾 ——
   * 一个设置项不该被另一个设置项的内容反向推翻。
   */
  'files.attachmentDirectory': defineSetting<string>({
    storageKey: ATTACHMENT_DIRECTORY_STORAGE_KEY,
    fallback: ATTACHMENT_DIRECTORY_DEFAULT,
    parse: (raw) => normalizeAttachmentDirectory(raw),
    serialize: (value) => value
  }),

  /**
   * 附件命名模板（**不含扩展名**）。扩展名来自实际内容，让用户填是给他一个必然填错的机会。
   *
   * 清空回落默认而不是存空串：空串存进来之后，落盘时还得再判一次「空的话用默认」——
   * 那等于把同一条规则写两遍，而两遍迟早只改一处。展开与净化仍归 `expandAttachmentName`：
   * 模板里写 `{date}` 这类占位符的替换发生在粘贴那一刻，不是写入设置那一刻。
   */
  'files.attachmentNameTemplate': defineSetting<string>({
    storageKey: ATTACHMENT_NAME_TEMPLATE_STORAGE_KEY,
    fallback: ATTACHMENT_NAME_TEMPLATE_DEFAULT,
    parse: (raw) =>
      raw === null || raw.trim() === '' ? ATTACHMENT_NAME_TEMPLATE_DEFAULT : raw,
    serialize: (value) => value
  }),

  /**
   * 新建文档的默认位置。**它只决定保存对话框的起点**，不决定文件写到哪 ——
   * 新建出来的仍是内存里的未命名文档，落盘时机还是用户按保存那一刻。
   *
   * 之所以做成设置项而不是写死「与当前文档同目录」：从轻量模式（只开了一个文件）新建时，
   * 「当前文档同目录」与「工作区根」是**两个都说得通、但用户偏好不同**的答案 ——
   * 有人希望草稿就近放，有人希望全进工作区。写死哪一个都会让另一半人不顺手。
   */
  'files.newDocumentLocation': choiceSetting(
    NEW_DOCUMENT_LOCATION_STORAGE_KEY,
    NEW_DOCUMENT_LOCATION_DEFAULT,
    NEW_DOCUMENT_LOCATION_OPTIONS.map((option) => option.value)
  ),

  /**
   * 扫描时忽略的目录规则。**原样存，不归一化** —— 理由见 `preference-specs.ts` 里
   * `IGNORE_RULES_DEFAULT` 的注释（自由文本，归一化是有损的，而损失的正是用户刚打的排版）。
   *
   * 空串是合法值（＝只有内置规则），所以这里没有「清空回落默认」那一步 ——
   * 默认值本身就是空串，回落与不回落的区别不存在。
   */
  'files.ignoreRules': defineSetting<string>({
    storageKey: IGNORE_RULES_STORAGE_KEY,
    fallback: IGNORE_RULES_DEFAULT,
    parse: (raw) => raw ?? IGNORE_RULES_DEFAULT,
    serialize: (value) => value
  }),

  /**
   * 版本历史每个文档保留几份。**`data` 组第一个带值的设置项** ——
   * 同组另外三项都是 `action`（重建索引 / 打开历史目录 / 打开索引目录），没有值。
   *
   * 用 `choiceSetting` 而不是数值输入：这一项会**删数据**，一个手滑填进去的 `5`
   * 比一个必须主动选中的档位危险得多。回落规则也因此跟着枚举走（未知值 → 默认档），
   * 而 `parseHistoryRetention` 那一层是**第二道**保险（未知值 → 不清理），
   * 两道方向不同是刻意的：这里保证界面显示得出东西，那里保证不误删。
   */
  'data.historyRetention': choiceSetting(
    HISTORY_RETENTION_STORAGE_KEY,
    HISTORY_RETENTION_DEFAULT,
    HISTORY_RETENTION_OPTIONS
  ),

  /**
   * 界面元素显隐。**值是「被藏起来的那些」**，空串 ＝ 全显示 ——
   * 为什么是「藏起来的」而不是「显示着的」，见 `GroupSettingSpec` 的两条理由。
   */
  'appearance.chromeVisibility': groupSetting(CHROME_VISIBILITY),

  /** 状态栏右侧显示项。同上，值是「被藏起来的那些」。 */
  'appearance.statusBarMetrics': groupSetting(STATUS_BAR_METRICS)
};

export type SettingPath = keyof typeof SETTING_DEFS;

/** path → 值类型。`get` / `set` 靠它收窄，调用方不用手写泛型。 */
export type SettingValue<P extends SettingPath> = (typeof SETTING_DEFS)[P]['fallback'];

type Listener = () => void;

function defaultStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/** 读初值。存储不可用（隐私模式、被 CSP 禁掉）不抛错 —— 读不到就是默认值。 */
function readSetting(path: SettingPath, storage: Storage | null): unknown {
  const def = SETTING_DEFS[path];
  if (!storage) return def.fallback;
  try {
    return def.parse(storage.getItem(def.storageKey));
  } catch {
    return def.fallback;
  }
}

export class SettingsStore {
  private readonly storage: Storage | null;

  /**
   * 构造时快照。之后 store 就是权威，**读路径不再碰 `localStorage`** —— 每次 `get` 都读磁盘
   * 会让读路径带上 IO 与 try/catch。
   *
   * 设置是独立窗口之后，「外部改动」确实存在了（另一个窗口写的）。它不是靠每次读盘解决的，
   * 而是靠 `storage` 事件驱动的 `reload()`：写入口仍然只有 `set()`，读入口仍然只有内存。
   */
  private readonly values = new Map<SettingPath, unknown>();

  private readonly listeners = new Map<SettingPath, Set<Listener>>();

  /**
   * 本地写盘之后的钩子。跨窗口广播挂这里。
   *
   * **不能挂在 `subscribe` 上**：`subscribe` 在 `reload()`（同步进来的变化）时也会触发，
   * 那样每个窗口一收到变化就再广播一次，两个窗口来回一轮就是死循环。写入口只有 `set()`，
   * 钩子也只从 `set()` 发 —— 「谁改的谁广播」。
   */
  private writeListener: (() => void) | null = null;

  constructor(storage: Storage | null = defaultStorage()) {
    this.storage = storage;
    for (const path of Object.keys(SETTING_DEFS) as SettingPath[]) {
      this.values.set(path, readSetting(path, storage));
    }
  }

  get<P extends SettingPath>(path: P): SettingValue<P> {
    return this.values.get(path) as SettingValue<P>;
  }

  /**
   * 写值：规范化 → 落盘 → 值变化时广播。
   *
   * 落盘取**规范化后**的结果（传 `'dark'` 进去，磁盘上留 `'nexus-dark'`），否则会出现「本次
   * 会话读到 `dark`、重启后读到 `nexus-dark`」。值没变也照样写（磁盘可能被绕过 store 改过，
   * 幂等写廉价），但**广播**只在值真变了时发。落盘失败静默：内存态已变，UI 该跟着变。
   */
  set<P extends SettingPath>(path: P, value: SettingValue<P>): void {
    const def = SETTING_DEFS[path] as SettingDef<SettingValue<P>>;
    const normalized = def.parse(def.serialize(value));
    const changed = this.values.get(path) !== normalized;
    this.values.set(path, normalized);

    if (this.storage) {
      try {
        this.storage.setItem(def.storageKey, def.serialize(normalized));
      } catch {
        // 静默：持久化不是交互的必要条件
      }
    }

    if (changed) this.notify(path);
    // 值没变也通知：磁盘可能被绕过 store 改过，而写盘是幂等的。多广播一次的代价是
    // 另一个窗口做一轮「重读 + 比对」，比对出来没变就不会重渲染。
    this.writeListener?.();
  }

  /** 挂本地写盘钩子。传 `null` 摘掉。见 `writeListener` 的注释。 */
  onWrite(listener: (() => void) | null): void {
    this.writeListener = listener;
  }

  private notify(path: SettingPath): void {
    const bucket = this.listeners.get(path);
    if (!bucket) return;
    // 复制再遍历：监听器里退订是常见写法，边遍历边改 Set 会漏掉后面的监听器。
    for (const listener of [...bucket]) listener();
  }

  /** 订阅某个 path。**回调不收值** —— 收到通知后自己 `get`，免得拿到的值已经过期。 */
  subscribe(path: SettingPath, listener: Listener): () => void {
    let bucket = this.listeners.get(path);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(path, bucket);
    }
    bucket.add(listener);
    return () => {
      bucket.delete(listener);
    };
  }

  /**
   * 磁盘被**别的窗口**改了：重读全部项，把变了的广播出去。
   *
   * 设置是独立窗口之后，同一份存档有两个写入方 —— 主窗口改了主题，设置窗口里那个单选态
   * 得跟着动；反之设置窗口拖了滑块，主窗口得立刻重绘。`storage` 事件是这条链路的上游
   * （见 `platform.ts` 的 `resyncFromStorage`）。
   *
   * **「变没变」比的是序列化后的字符串，不是 `!==`。** `appearance.userTheme` 是对象，
   * 每次 `parse` 都造一个新对象，`!==` 恒真 —— 那样每次同步都会广播一遍，而广播会触发
   * 重渲染，两个窗口来回一次就成了循环。字符串比较同时把「深相等」这件事一并解决。
   */
  reload(): void {
    for (const path of Object.keys(SETTING_DEFS) as SettingPath[]) {
      const def = SETTING_DEFS[path] as SettingDef<unknown>;
      const next = readSetting(path, this.storage);
      if (def.serialize(next) === def.serialize(this.values.get(path))) continue;
      this.values.set(path, next);
      this.notify(path);
    }
  }
}
