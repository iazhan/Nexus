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

import {
  DEFAULT_ATTACHMENT_DIRECTORY,
  DEFAULT_ATTACHMENT_NAME_TEMPLATE,
  HISTORY_RETENTION_DEFAULT,
  HISTORY_RETENTION_OPTIONS
} from '@nexus/core';
import {
  UI_ZOOM_DEFAULT,
  UI_ZOOM_OPTIONS,
  UI_ZOOM_STORAGE_KEY
} from '../../../preload/ui-zoom.js';
import { DELETE_MODES, type DeleteMode } from '../../../ipc/channels.js';

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
/**
 * 编辑器手感的三个开关（拼写检查 / 打字机模式 / Vim 键位）。
 *
 * 三者**默认全关**，与「加这一项之前的观感一致」：CodeMirror 自己就在 `contentDOM` 上写死
 * `spellcheck="false"`，光标跟随与 vim 键位则都是纯新增的行为。所以三者在 store 里都用
 * `toggleSettingOff`（认不出的值当关），而不是 `toggleSetting`。
 */
export const EDITOR_SPELL_CHECK_STORAGE_KEY = 'nexus-editor-spell-check';
export const EDITOR_TYPEWRITER_MODE_STORAGE_KEY = 'nexus-editor-typewriter-mode';
export const EDITOR_VIM_KEYBINDINGS_STORAGE_KEY = 'nexus-editor-vim-keybindings';
export const EDITOR_WORD_COUNT_STORAGE_KEY = 'nexus-editor-word-count';
export const AUTO_SAVE_STORAGE_KEY = 'nexus-auto-save';
export const EXTERNAL_CHANGE_STORAGE_KEY = 'nexus-external-change';

/**
 * 启动时恢复上次打开的工作区。
 *
 * 磁盘键单独一个（不是别的键的子串），因为主进程会把它**落盘成一份给下次启动读的快照** ——
 * 见 `electron/recent-workspace.ts`。这一项是唯一一个「值要在第一个渲染进程存在之前
 * 就被读到」的设置，所以它的存档格式与别的不一样，改它要连主进程一起改。
 */
export const RESTORE_LAST_WORKSPACE_STORAGE_KEY = 'nexus-restore-last-workspace';

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
 * 一个开关组的取值域。
 *
 * 值是**被关掉的那些成员**，逗号分隔，空串表示全开。为什么存「关掉的」而不是「开着的」——
 * 两条都不是风格问题：
 *
 * 1. **默认值就是空串**，而空串也正是「存档缺失 / 写坏了 / 被清掉」解析出来的东西 ——
 *    失败方向因此天然安全：一个坏值不会把界面藏起来。反过来存「开着的那些」时，坏值解析成
 *    空集 ＝ 全关，而藏掉的恰恰是把它点回来的入口。
 * 2. **将来加一个新成员，它对已有用户是「开着」的。** 存「开着的那些」则相反 ——
 *    新加的 chrome 会在所有老用户那里默认消失。
 *
 * `options` 的顺序就是**存储顺序**：规范化后按它拼，所以同一组开关无论按什么顺序点，
 * 存档里都是同一个字符串 —— 否则「值变了没有」的判断会误报（用户主题那一课：只按 id 判
 * 会漏掉切模式）。
 */
export interface GroupSettingSpec {
  storageKey: string;
  /** 全部成员。顺序即存储顺序。 */
  options: readonly string[];
  /** 默认值 ＝ 被关掉的成员集合，空串表示全开。 */
  fallback: string;
}

/**
 * 值 → 被关掉的成员。丢掉不认识的与重复的。
 *
 * 返回顺序**跟随值里的出现顺序**，不一定是 `options` 的顺序 —— 要规范写法（同一集合只有一种
 * 字符串）请走 `serializeGroupMembers`。判「某个成员在不在里面」用 `includes`，顺序无所谓。
 *
 * 入参是 `options` 而不是整个 spec：控件（`FieldRow` 的 `GroupControl`）手里只有
 * `FieldDef.options`，拿不到 spec —— 而它同样需要「哪些成员、什么顺序」。
 */
export function disabledMembers(options: readonly string[], value: string | null): string[] {
  if (value === null || value.trim() === '') return [];

  const seen = new Set<string>();
  const members: string[] = [];

  for (const piece of value.split(',')) {
    const member = piece.trim();
    if (member === '' || seen.has(member)) continue;
    // 不认识的成员丢掉而不是让整串失效：将来删掉一个成员时，老存档不该整份作废。
    if (!options.includes(member)) continue;
    seen.add(member);
    members.push(member);
  }

  return members;
}

/** 成员集合 → 值。按 `options` 的顺序拼，所以同一个集合只有一种写法。 */
export function serializeGroupMembers(
  options: readonly string[],
  members: readonly string[]
): string {
  const wanted = new Set(members);
  return options.filter((option) => wanted.has(option)).join(',');
}

/** 存档 → 值。整串都认不出时得到空串 ＝ 全开（见 `GroupSettingSpec`）。 */
export function parseGroupSetting(spec: GroupSettingSpec, raw: string | null): string {
  if (raw === null) return spec.fallback;
  return serializeGroupMembers(spec.options, disabledMembers(spec.options, raw));
}

/** 把一个成员拨到相反状态。控件的写入口 —— 认不出的成员是空操作，不会写进存档。 */
export function toggleGroupMember(
  options: readonly string[],
  value: string,
  member: string
): string {
  const members = disabledMembers(options, value);
  const next = members.includes(member)
    ? members.filter((item) => item !== member)
    : [...members, member];

  return serializeGroupMembers(options, next);
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
 * 编辑器字体的三档**预设**。值是**键**，栈在这里查表 —— 栈里含逗号与引号，直接当设置值存
 * 会让磁盘格式变成一段 CSS，将来想改栈就得迁移存档。
 *
 * `default` / `sans` 复用 `App.css` 已有的两个字体变量，不在这里抄第二份字体列表。
 *
 * **它们不是值域的全部**（2026-10-01 起）：这一项同时接受**任意字体家族名**。三档能表达的
 * 只有「界面那两套 + 一个衬线兜底」，而用户装了什么字体只有他自己知道 —— 想用楷体时三档里
 * 没有可选项，等于把这件事判成做不到。三档因此降级为**预设**：它们仍是存档里最稳的值
 * （不随系统字体增减而失效），其余值按家族名原样存。
 */
export const EDITOR_FONT_FAMILIES: ReadonlyArray<{ value: string; stack: string }> = [
  { value: 'default', stack: 'var(--font-mono)' },
  { value: 'sans', stack: 'var(--font-family)' },
  { value: 'serif', stack: 'Georgia, "Times New Roman", "Songti SC", SimSun, serif' }
];

export const EDITOR_FONT_FAMILY_DEFAULT = 'default';

/**
 * 候选字体家族名 —— 设置页那个下拉的**静态**部分。
 *
 * 它是**打底**不是全部：这台机器真装了什么由 `queryLocalFonts()` 现问
 * （`settings/system-fonts.ts`），两者合并成候选表。所以这里只列跨平台常见的那些；
 * 列了没装的不会出错（字体栈会往后回退），但列一堆本机没有的只会把下拉撑长。
 *
 * 中文名与英文名**各列一条**：Windows 上 `Microsoft YaHei` 与 `微软雅黑` 指向同一个家族，
 * 而 `queryLocalFonts()` 报的是英文名 —— 用户脑子里记的往往是中文名。
 */
export const EDITOR_FONT_CANDIDATES: readonly string[] = [
  'Microsoft YaHei',
  '微软雅黑',
  'PingFang SC',
  'Noto Sans SC',
  'Source Han Sans SC',
  'SimSun',
  '宋体',
  'SimHei',
  '黑体',
  'KaiTi',
  '楷体',
  'FangSong',
  '仿宋',
  'DengXian',
  '等线',
  'Inter',
  'Georgia',
  'Times New Roman',
  'Cambria',
  'Arial',
  'Helvetica',
  'Verdana',
  'JetBrains Mono',
  'Fira Code',
  'Cascadia Code',
  'Consolas',
  'Menlo',
  'Monaco'
];

/**
 * 家族名 → 能安全写进 CSS 的家族名。
 *
 * **这是必需的，不是洁癖。** 这个值来自一个自由输入框，最终会被 `editorFontStack`
 * **用双引号包起来**拼进 `--nx-editor-font-family`。值里的 `"` 或 `\` 会提前闭合那对引号，
 * 于是后面的 `var(--font-family)` 变成同一个家族名的一部分 —— 表现是「选了字体却没生效」，
 * 而且不报错。
 *
 * 所以规则是**去掉能改变字符串边界的字符**（引号、反斜杠）、**能开始一段新声明或新块的
 * 字符**（分号、花括号、圆括号）、逗号（家族名里不会有逗号，留着它等于让一个输入框同时
 * 表达两个家族）与控制字符（CSS 字符串里不许有裸换行）。
 *
 * 长度截到 64：家族名没有这么长的，截断只影响粘贴进来的垃圾。
 */
export function sanitizeFontFamily(raw: string): string {
  return Array.from(raw)
    // 控制字符（含换行与制表）先摘掉：CSS 字符串里不许有裸换行，而它们在家族名里也没用。
    // 按码点过滤而不是写一个 `\u0000-\u001f` 的字符组 —— 后者会被 `no-control-regex` 拦下。
    .filter((char) => char.charCodeAt(0) > 0x1f && char.charCodeAt(0) !== 0x7f)
    .join('')
    .replace(/["'\\;,{}()]/g, '')
    .trim()
    .slice(0, 64);
}

/**
 * 设置值 → 真正写进 CSS 变量的字体栈。
 *
 * 三档预设查表；其余按**家族名**处理，并在后面接 `var(--font-family)` 兜底 ——
 * 用户挑的字体常常只有拉丁字形（打包的 Inter / JetBrains Mono 就是），后面那截负责让没被
 * 覆盖到的字符落到界面那套栈上（它自带中文回退），否则中文会掉到浏览器默认的衬线字体。
 *
 * 空串与清洗后为空一律回落等宽档 —— 那正是 `default` 的栈，与「没有值」的语义一致。
 */
export function editorFontStack(value: string): string {
  const preset = EDITOR_FONT_FAMILIES.find((family) => family.value === value);
  if (preset) return preset.stack;

  const name = sanitizeFontFamily(value);
  if (name === '') return 'var(--font-mono)';
  return `"${name}", var(--font-family)`;
}

/**
 * 存档 → 值。**这是值域的唯一权威** —— `store` 的读初值与 `set` 都过它一遍。
 *
 * 它做的不是「校验合法性」而是**规范化**：这一项的值域是「三档预设 + 任意家族名」，
 * 所以只有两件事 —— 空串（含只剩清洗字符的）回落默认档，其余存清洗后的家族名。
 *
 * 归一化必须留在这一层：`store.set` / `reload` 判「值变了没有」比的是规范化后的结果，
 * 不在这里收口的话，输入框里多一个引号就会让同一个字体出现两种写法。
 */
export function parseEditorFontFamily(raw: string | null): string {
  if (raw === null) return EDITOR_FONT_FAMILY_DEFAULT;
  const trimmed = raw.trim();
  if (trimmed === '') return EDITOR_FONT_FAMILY_DEFAULT;
  if (EDITOR_FONT_FAMILIES.some((family) => family.value === trimmed)) return trimmed;
  const name = sanitizeFontFamily(trimmed);
  return name === '' ? EDITOR_FONT_FAMILY_DEFAULT : name;
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

export const NEW_DOCUMENT_LOCATION_STORAGE_KEY = 'nexus-new-document-location';

/**
 * 新建文档的默认位置。**它决定的是「第一次保存时对话框停在哪个目录」**，不是「文件立刻写到哪」——
 * 新建出来的是一份未命名文档，落盘时机仍然是用户按保存那一刻。
 *
 * 这个区别必须写在描述文案里：叫「默认位置」很容易被读成「新建即写盘」，
 * 那样用户会以为 `Ctrl+N` 之后磁盘上已经多了个文件（实际没有）。
 *
 * 两个选项而不是「任意目录」：任意目录要先有一个目录选择器（系统对话框），
 * 而它只服务这一项；`document` / `workspace` 覆盖了绝大多数情况，
 * 剩下的人按一次对话框里的「上一级」即可。
 */
/**
 * 两个取值提成常量：`newDocumentDirectory`（`renderer/src/paths.ts`）要按它分支，
 * 而分支里写裸字符串等于把同一个字面量写两遍 —— 改一处、另一处静默失效，
 * 症状是「选了工作区根目录，对话框还是停在文档旁边」。
 */
export const NEW_DOCUMENT_LOCATION_DOCUMENT = 'document';
export const NEW_DOCUMENT_LOCATION_WORKSPACE = 'workspace';

export const NEW_DOCUMENT_LOCATION_OPTIONS: ReadonlyArray<{ value: string; labelKey: string }> = [
  {
    value: NEW_DOCUMENT_LOCATION_DOCUMENT,
    labelKey: 'settings.files.newDocumentLocation.document'
  },
  {
    value: NEW_DOCUMENT_LOCATION_WORKSPACE,
    labelKey: 'settings.files.newDocumentLocation.workspace'
  }
];

/**
 * `document` 是默认，也是这一版之前的实际观感：那时对话框没有 `defaultPath`，由系统决定停在哪。
 * 「与当前文档同目录」是最保守的替代 —— 它至少是用户刚才在的地方，而不是一个随机目录。
 * 轻量模式下没有工作区，选 `workspace` 会回落到同一处。
 */
export const NEW_DOCUMENT_LOCATION_DEFAULT = NEW_DOCUMENT_LOCATION_DOCUMENT;

export const IGNORE_RULES_STORAGE_KEY = 'nexus-ignore-rules';

/**
 * 扫描时忽略的目录规则。默认空串 ＝ 只有内置规则 —— 与加这一项之前的行为一致。
 *
 * **这一项刻意不做 parse 归一化**，与 `files.attachmentDirectory` 相反。区别在于那个存的是
 * **一个路径**，归一化之后只剩一种写法，两处各判一次才会漂移；这个存的是**一段自由文本**，
 * 归一化是有损的：`parseIgnoreRules` 会把换行压成逗号、去掉空行 —— 用户一边敲一边被改写，
 * 而改写掉的正是他刚打的排版。
 *
 * 归一化因此只发生在**使用处**（`renderer/src/host-settings.ts` 推给主进程那一刻），
 * 存档里留的就是用户写的样子。
 */
export const IGNORE_RULES_DEFAULT = '';

export const DELETE_BEHAVIOR_STORAGE_KEY = 'nexus-delete-behavior';

/**
 * 删除文件时走哪条路：系统回收站，还是永久删除。
 *
 * **加这一项之前根本没有删除功能**，所以「默认值必须等于加这一项之前的观感」这条判据
 * 在这里没有可继承的对象，只能退回到它的本意：**取最保守的那一档**。两个取值不是
 * 「方便 / 不方便」，而是「可逆 / 不可逆」，所以默认这一侧没有第二个候选。
 *
 * 两条分支的破坏性不同，这决定了它们各自的行为要自洽：
 * - 回收站 —— 文件还能找回来，所以它的**版本历史也留着**（恢复到同一路径时历史跟着回来）。
 * - 永久删除 —— 什么都不留，所以**版本历史一起没**，而且界面上必须先确认。
 *
 * 取值域的类型来自 `ipc/channels.ts` 的 `DeleteMode`：真正执行删除的是主进程，
 * 它认不出的值一律按 `trash` 处理。渲染进程这边走 `choiceSetting`，认不出回落默认档 ——
 * 两处方向一致，都是「失败就往可恢复的那一侧倒」。
 */
export const DELETE_BEHAVIOR_OPTIONS: ReadonlyArray<{ value: DeleteMode; labelKey: string }> = [
  { value: 'trash', labelKey: 'settings.files.deleteBehavior.trash' },
  { value: 'permanent', labelKey: 'settings.files.deleteBehavior.permanent' }
];

export const DELETE_BEHAVIOR_DEFAULT: DeleteMode = 'trash';

/**
 * 把存档里读出来的字符串收窄成 `DeleteMode`，认不出的一律给「回收站」。
 *
 * `choiceSetting` 的 `parse` 已经保证读出来只会是上面表里那两个之一，所以这个函数在
 * **正常路径上永远走不到兜底分支**。它存在是为了类型：存档是字符串，而桥收的是
 * `DeleteMode`；与其在调用点写一个 `as`，不如把收窄摆在一处，顺带让「认不出就选
 * 可恢复的那一侧」这条规则在这条链路上也看得见（与主进程那一侧同一条）。
 */
export function parseDeleteMode(raw: string | null | undefined): DeleteMode {
  return DELETE_MODES.includes(raw as DeleteMode)
    ? (raw as DeleteMode)
    : DELETE_BEHAVIOR_DEFAULT;
}

export const HISTORY_RETENTION_STORAGE_KEY = 'nexus-history-retention';

/**
 * 每个文档保留多少份历史快照。
 *
 * **取值域（档位表、默认档、解析规则）在 `@nexus/core` 的 `history/retention.ts`**，
 * 这里只转出 —— 主进程也要用同一份口径（它才是真正删文件的那一侧），
 * 两处各写一份的话「设置页显示保留 20 份、主进程按 100 份删」不会报错。
 *
 * 与 `files.ignoreRules` 一样，这一项**跨进程**：值住在渲染进程的存储里，而干活的是主进程。
 * 区别在于它不是自由文本 —— 档位是有限的，所以走 `choiceSetting`，
 * 存档里出现未知值时回落默认档，而不是像忽略规则那样原样保留。
 */
export { HISTORY_RETENTION_OPTIONS, HISTORY_RETENTION_DEFAULT };

export const CHROME_VISIBILITY_STORAGE_KEY = 'nexus-chrome-hidden';

/**
 * 界面元素显隐 —— 值是**被藏起来的那些**。
 *
 * 只有两项，因为 Nexus 真实的 chrome 里「藏了还能用」的就这两个：
 *
 * - `statusBar` 底部状态栏
 * - `tabBar` 多标签页栏（只在开了两个以上文档时出现）
 *
 * **刻意没有的三项都不是遗漏**：
 *
 * - **活动栏**：它是切换右侧面板的唯一入口，藏了就没有地方点回来。顺带记一笔 ——
 *   调研表里写的「活动栏标签」在 Nexus **不存在**：`shell/ActivityBar.tsx` 是纯图标的
 *   （只有 `aria-label` 与 `title`），那一格是从 Markra 的对照表抄过来的空项。
 * - **顶栏**：它是无边框窗口的拖动区，还挂着窗口按钮（最小化 / 最大化 / 关闭）。
 * - **侧栏面板**：它已经能收起（点活动栏图标），再加一个开关是同一件事的第二条路。
 */
export const CHROME_VISIBILITY: GroupSettingSpec = {
  storageKey: CHROME_VISIBILITY_STORAGE_KEY,
  options: ['statusBar', 'tabBar'],
  // 全显示 ＝ 加这一项之前的观感。
  fallback: ''
};

export const STATUS_BAR_METRICS_STORAGE_KEY = 'nexus-status-bar-hidden';

/**
 * 状态栏右侧显示哪几项 —— 值同样是**被藏起来的那些**。
 *
 * 三项都在 `App.tsx` 的 `.status-bar-right` 里：
 *
 * - `lineColumn` 光标行列
 * - `selection` 选中字符数（只在有选区时出现）
 * - `format` 当前文档格式（Markdown / PDF / DOCX …）
 *
 * **左侧那半不在这个组里，也不该进来**：状态点与保存态是状态栏上唯一「据以行动」的东西 ——
 * 保存失败只在那里说，藏掉它等于把「这次保存没成功」藏起来。**字数也不在这里**：
 * 它已经有自己的开关（`editor.wordCount`），同一个东西给两个开关，两个都会显得不可信。
 */
export const STATUS_BAR_METRICS: GroupSettingSpec = {
  storageKey: STATUS_BAR_METRICS_STORAGE_KEY,
  options: ['lineColumn', 'selection', 'format'],
  fallback: ''
};

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
