/**
 * 本机偏好的取值域与磁盘键。**纯数据，不碰 DOM、不碰 store。**
 *
 * 为什么要有这个文件：一个数值项有三处需要它的范围 —— `store.ts` 的 `parse` 要夹取、
 * `registry.ts` 的控件要 `min` / `max` / `step` / `resetValue`、`platform.ts` 要写 CSS 变量。
 * 三处各写一遍，改范围时漏掉一处不会报错，只会让「输入框允许 20、存档夹到 18」这种
 * 半生效状态长期存在。`panel-width.ts` 是同一个形状的先例。
 *
 * 覆盖面是**本机偏好**：编辑器外观（排版 / 代码块行号 / 表格列宽）、通用行为
 * （自动保存开关与延迟、外部修改时怎么处理）、文件落盘（附件放哪、叫什么）与界面缩放。
 * 主题与用户主题**不在这里** —— 那是 `@nexus/theme` 的领域，存档形状由 `parseUserThemes` 负责。
 *
 * **界面缩放是唯一一处把取值域留在别处的**：它要在首帧之前生效，那份口径必须放在 preload
 * 拿得到的地方（见 `preload/ui-zoom.ts` 的头注释），这里只转出并补上标签。
 *
 * **默认值一律等于加设置项之前的实际观感与行为**（字号 14 / 行高 1.6 / 段间距 0 / 宽度跟随窗口 /
 * 等宽字体 / 代码块行号开 / 表格列宽 auto / 自动保存开且延迟 800ms / 外部修改走 smart）。
 * 加设置项不是改默认行为 —— 装上这一版就该和上一版长得一样、行为一样。
 *
 * 两处刻意的例外，理由各自写在定义处：**段间距默认 0**（调研里写的 8 会改变所有既有文档的排版），
 * **字数统计默认开**（它是纯新增的展示项，不动任何已有元素）。
 *
 * 变量前缀是 `--nx-` 不是 `--nexus-`：后者是主题 token 的命名空间（由 `ThemeManager` 注入，
 * 归审计脚本管），而这些是用户偏好 —— 换主题不该把字号或行号重置回去。见 `App.css` 头部。
 */

import { DEFAULT_ATTACHMENT_DIRECTORY, DEFAULT_ATTACHMENT_NAME_TEMPLATE } from '@nexus/core';
import {
  UI_ZOOM_DEFAULT,
  UI_ZOOM_OPTIONS,
  UI_ZOOM_STORAGE_KEY
} from '../../../preload/ui-zoom.js';

/** 一个数值项的完整取值域。`step` 只给控件用，不参与夹取。 */
export interface NumberSettingSpec {
  storageKey: string;
  fallback: number;
  min: number;
  max: number;
  step: number;
}

export const EDITOR_FONT_SIZE: NumberSettingSpec = {
  storageKey: 'nexus-editor-font-size',
  fallback: 14,
  min: 12,
  max: 20,
  step: 1
};

/**
 * 行高。**步长 0.05** —— 0.1 的档位在 1.5–1.8 之间只给得出三档，而这段正是最常调的范围。
 * 浮点误差由 `serializeNumberSetting` 的 `String()` 原样带过（`1.65` 存成 `'1.65'`）。
 */
export const EDITOR_LINE_HEIGHT: NumberSettingSpec = {
  storageKey: 'nexus-editor-line-height',
  fallback: 1.6,
  min: 1.2,
  max: 2.4,
  step: 0.05
};

export const EDITOR_PARAGRAPH_SPACING: NumberSettingSpec = {
  storageKey: 'nexus-editor-paragraph-spacing',
  fallback: 0,
  min: 0,
  max: 32,
  step: 2
};

/**
 * 自动保存延迟（毫秒）。
 *
 * **它调的是 debounce 延迟，不是「每隔多久存一次」。** 落盘时机是「停止输入后等这么久」，
 * 所以调长 = 写盘更少、中间状态更容易丢；调短 = 写盘更频繁。文案必须说清这一点，
 * 否则用户会以为这是个周期快照间隔（那件事 Nexus 没做）。
 *
 * 上限 5000 是有意的：再长就不像「自动」了，那时该做的是关掉自动保存。
 */
export const AUTO_SAVE_DELAY: NumberSettingSpec = {
  storageKey: 'nexus-auto-save-delay',
  fallback: 800,
  min: 200,
  max: 5000,
  step: 100
};

export const EDITOR_CONTENT_WIDTH_STORAGE_KEY = 'nexus-editor-content-width';
export const EDITOR_FONT_FAMILY_STORAGE_KEY = 'nexus-editor-font-family';
export const CODE_BLOCK_LINE_NUMBERS_STORAGE_KEY = 'nexus-editor-code-block-line-numbers';
export const EDITOR_TABLE_LAYOUT_STORAGE_KEY = 'nexus-editor-table-layout';
export const EDITOR_LINE_NUMBERS_STORAGE_KEY = 'nexus-editor-line-numbers';
export const EDITOR_WORD_COUNT_STORAGE_KEY = 'nexus-editor-word-count';
export const AUTO_SAVE_STORAGE_KEY = 'nexus-auto-save';
export const EXTERNAL_CHANGE_STORAGE_KEY = 'nexus-external-change';

/** 磁盘字符串 → 数值。空串与非数字**回落到默认值**，不是夹到最小值（`Number('')` 是 0）。 */
export function parseNumberSetting(spec: NumberSettingSpec, raw: string | null): number {
  if (raw === null || raw.trim() === '') return spec.fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return spec.fallback;
  return Math.min(spec.max, Math.max(spec.min, parsed));
}

export function serializeNumberSetting(spec: NumberSettingSpec, value: number): string {
  return String(Math.min(spec.max, Math.max(spec.min, value)));
}

/**
 * 内容宽度。**用档位而不是像素输入框**：`max-width` 要表达「不限」只能写 `none`，
 * 而数值控件给不出这个值 —— 要么编一个 `0 = 不限` 的哨兵（输入框里显示 `0 px`，读起来像「零宽」），
 * 要么就得为它单开一条 `none` 分支。档位把这件事变成选项本身，顺带省掉解析。
 *
 * `none` 是默认，也是改版前的行为：正文铺满可用宽度。
 *
 * 只有「跟随窗口」需要字典键，其余三项是数字 —— 翻译 `760 px` 只会让它变成别的东西。
 */
export const EDITOR_CONTENT_WIDTH_OPTIONS: ReadonlyArray<{
  value: string;
  label?: string;
  labelKey?: string;
}> = [
  { value: 'none', labelKey: 'settings.editor.contentWidth.none' },
  { value: '760px', label: '760 px' },
  { value: '880px', label: '880 px' },
  { value: '1040px', label: '1040 px' }
];

export const EDITOR_CONTENT_WIDTH_DEFAULT = 'none';

/**
 * 编辑器字体。值是**键**，栈在这里查表 —— 栈里含逗号与引号，直接当设置值存会让磁盘格式
 * 变成一段 CSS，将来想改栈就得迁移存档。
 *
 * `default` / `sans` 复用 `App.css` 已有的两个字体变量，不在这里抄第二份字体列表。
 */
export const EDITOR_FONT_FAMILIES: ReadonlyArray<{ value: string; stack: string }> = [
  { value: 'default', stack: 'var(--font-mono)' },
  { value: 'sans', stack: 'var(--font-family)' },
  { value: 'serif', stack: 'Georgia, "Times New Roman", "Songti SC", SimSun, serif' }
];

export const EDITOR_FONT_FAMILY_DEFAULT = 'default';

/** 设置值 → 真正写进 CSS 变量的字体栈。存档里有未知值时回落到默认档。 */
export function editorFontStack(value: string): string {
  return EDITOR_FONT_FAMILIES.find((family) => family.value === value)?.stack ?? 'var(--font-mono)';
}

/**
 * 表格列宽模式。值是**真的 `table-layout` 取值**，不是自造枚举 —— 存档里存的就是要写进
 * CSS 的那两个词，少一层映射也就少一处可能对不上的地方。
 *
 * `auto` 是默认，也是改版前的行为：列宽由内容决定（宽表格会撑出横向滚动）。
 * `fixed` 让各列等宽，列多的表在窄窗口里不再互相挤。
 */
export const EDITOR_TABLE_LAYOUT_OPTIONS: ReadonlyArray<{ value: string; labelKey: string }> = [
  { value: 'auto', labelKey: 'settings.editor.tableLayout.auto' },
  { value: 'fixed', labelKey: 'settings.editor.tableLayout.fixed' }
];

export const EDITOR_TABLE_LAYOUT_DEFAULT = 'auto';

/**
 * 外部修改文档时的处理方式。
 *
 * `smart`（默认）＝改版前的行为：**文档没有未保存改动**时自动重载，有改动才提示冲突。
 * 干净时还要问一句纯属打扰 —— 磁盘上那份就是用户想要的那份。
 *
 * `prompt` ＝ 一律提示，交给用户决定。适合「别人也可能在改这个文件」的场景：
 * 自动重载会把「刚才看到的内容变了」这件事藏起来。
 */
export const EXTERNAL_CHANGE_OPTIONS: ReadonlyArray<{ value: string; labelKey: string }> = [
  { value: 'smart', labelKey: 'settings.general.externalChange.smart' },
  { value: 'prompt', labelKey: 'settings.general.externalChange.prompt' }
];

export const EXTERNAL_CHANGE_DEFAULT = 'smart';

export const ATTACHMENT_LOCATION_STORAGE_KEY = 'nexus-attachment-location';
export const ATTACHMENT_DIRECTORY_STORAGE_KEY = 'nexus-attachment-directory';
export const ATTACHMENT_NAME_TEMPLATE_STORAGE_KEY = 'nexus-attachment-name-template';

/**
 * 附件存放位置。**两个选项就够，不提供「绝对路径」** —— 附件路径要写进文档正文（相对引用），
 * 绝对路径的引用换个机器就断，而它自己又没法表达「相对谁」。
 *
 * `document` 是默认，也是这一版之前的观感：那时根本没有落盘功能，所以「与文档同目录」是
 * 最保守的起点 —— 装上这一版不该让粘贴行为先落在用户没指定的地方。
 */
export const ATTACHMENT_LOCATION_OPTIONS: ReadonlyArray<{ value: string; labelKey: string }> = [
  { value: 'document', labelKey: 'settings.files.attachmentLocation.document' },
  { value: 'directory', labelKey: 'settings.files.attachmentLocation.directory' }
];

export const ATTACHMENT_LOCATION_DEFAULT = 'document';

/**
 * 子目录名与命名模板的默认值**从 `@nexus/core` 取，不在这里抄第二份** —— 那两个常量是
 * 「算名字」这件事的一部分（`normalizeAttachmentDirectory` 落空时也是回落到它），
 * 抄一份的后果是设置页显示 `assets`、实际落盘到别的目录。
 */
export const ATTACHMENT_DIRECTORY_DEFAULT = DEFAULT_ATTACHMENT_DIRECTORY;
export const ATTACHMENT_NAME_TEMPLATE_DEFAULT = DEFAULT_ATTACHMENT_NAME_TEMPLATE;

/**
 * UI 缩放。**取值口径（磁盘键 / 档位 / 解析）住在 `preload/ui-zoom.ts`** —— 那个文件
 * 要在首帧之前把缩放应用上去，所以它才是那份规则的所在地；这里只补一件它不需要的东西：
 * 给档位配标签（`100%` 是给人看的，不是存档格式）。
 *
 * 与「编辑器 → 正文字号」是两件事：那个只改文档正文，这个把整个窗口一起缩放（面板、菜单、
 * 编辑器）。两条路都要有 —— 高分屏上想把整个界面放大的人不该被迫只放大正文。
 */
export { UI_ZOOM_STORAGE_KEY, UI_ZOOM_OPTIONS, UI_ZOOM_DEFAULT };

export const UI_ZOOM_OPTIONS_LABELLED: ReadonlyArray<{ value: string; label: string }> =
  UI_ZOOM_OPTIONS.map((value) => ({ value, label: `${value}%` }));

/**
 * 代码块行号的开关值。
 *
 * 写的是 `display` 而不是 `content`：行号是 `::before` 的生成内容，`content` 里要做
 * 「显示数字 / 不显示」只能靠 `attr()` 与 `var()` 嵌套，取值来自伪元素上的属性，
 * 这条路不保证解析。`display` 是普通属性，`none` 直接让整个伪元素盒子不生成 ——
 * 顺带把左侧那截留白（`minWidth` + `marginRight` + `paddingRight`）一起收掉，
 * 正文自然贴回左边框，不会留一条空槽。
 */
export function codeLineNumbersDisplay(visible: boolean): string {
  return visible ? 'inline-block' : 'none';
}

/** 外观变量名。`App.css` 的 `:root` 给出与上表一致的默认值，渲染进程按设置覆盖。 */
export const EDITOR_CSS_VARS = {
  fontSize: '--nx-editor-font-size',
  fontFamily: '--nx-editor-font-family',
  lineHeight: '--nx-editor-line-height',
  paragraphSpacing: '--nx-editor-paragraph-spacing',
  contentWidth: '--nx-editor-content-width',
  codeLineNumbers: '--nx-editor-code-line-numbers',
  tableLayout: '--nx-editor-table-layout'
} as const;
