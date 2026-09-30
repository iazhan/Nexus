/**
 * 编辑器排版的取值域与磁盘键。**纯数据，不碰 DOM、不碰 store。**
 *
 * 为什么要有这个文件：一个数值项有三处需要它的范围 —— `store.ts` 的 `parse` 要夹取、
 * `registry.ts` 的控件要 `min` / `max` / `step` / `resetValue`、`platform.ts` 要写 CSS 变量。
 * 三处各写一遍，改范围时漏掉一处不会报错，只会让「输入框允许 20、存档夹到 18」这种
 * 半生效状态长期存在。`panel-width.ts` 是同一个形状的先例。
 *
 * **三条默认值一律等于本批次之前的实际观感**（字号 14 / 行高 1.6 / 段间距 0 / 宽度跟随窗口 /
 * 等宽字体）。加设置项不是改默认样式 —— 装上这一版就该和上一版长得一模一样。
 *
 * 段间距默认 **0** 而不是调研里写的 8：这里的空行本身就占一个行高（约 22px），再加 8px
 * 是**改变**所有既有文档的排版，而不是给它一个可调项。
 *
 * 变量前缀是 `--nx-` 不是 `--nexus-`：后者是主题 token 的命名空间（由 `ThemeManager` 注入，
 * 归审计脚本管），而排版是用户偏好 —— 换主题不该把字号重置回去。见 `App.css` 头部。
 */

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

export const EDITOR_CONTENT_WIDTH_STORAGE_KEY = 'nexus-editor-content-width';
export const EDITOR_FONT_FAMILY_STORAGE_KEY = 'nexus-editor-font-family';
export const AUTO_SAVE_STORAGE_KEY = 'nexus-auto-save';

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

/** 排版变量名。`App.css` 的 `:root` 给出与上表一致的默认值，渲染进程按设置覆盖。 */
export const EDITOR_CSS_VARS = {
  fontSize: '--nx-editor-font-size',
  fontFamily: '--nx-editor-font-family',
  lineHeight: '--nx-editor-line-height',
  paragraphSpacing: '--nx-editor-paragraph-spacing',
  contentWidth: '--nx-editor-content-width'
} as const;
