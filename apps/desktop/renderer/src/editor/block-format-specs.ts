import type { BlockFormatKind, BlockFormatState } from '@nexus/editor';
import type { MenuBarItem } from '../MenuBar.js';
import type { ContextMenuItem } from '../components/ContextMenu.js';

/**
 * 块级改型的动作表（§3.1 下表）。
 *
 * **这是那一张表的唯一出处**：命令注册、「格式」菜单、`/` 面板、常驻工具栏都从这里取，
 * 四处不各写一份 —— 各写一份的结果是加了一项而另外三处不知道。
 * 测试直接钉这张表（正反两面：每一项都在，且不存在的项查无此物）。
 *
 * 四个入口是**同一张表的四种排布**，不是四张表：
 * - 「格式」菜单 = 全部 14 项，按 `group` 分组（`blockFormatMenuItems`）；
 * - `/` 面板 = 全部 14 项，匹配用 `tokens`（`slash-commands.ts`）；
 * - 常驻工具栏 = **高频子集**，见 `BLOCK_FORMAT_TOOLBAR`（代码块 / 表格 / 分割线不进）；
 * - 命令注册 = 按 `id` 逐条注册（`App.tsx`）。
 *
 * 与 `SELECTION_ACTION_SPECS` 的关系：那张是**行内**（选区上下文条），这张是**块级**
 * （无选区也能用）。两张表合起来才是工具栏的完整动作集，缺一项就是「顺手少做几个」。
 *
 * **没有 `highlight`。** Markra 的工具栏有它，但 Nexus 的 Markdown 模型里没有 ——
 * `MarkdownInlineNode` 里没有这个节点，全仓没有 `==` 的解析 / 序列化 / 投影。
 * 加它等于先给 markdown 包加一套新语法，与「给编辑器加工具栏」不是一件事。
 */

export interface BlockFormatSpec {
  /** 宿主命令 id。菜单项的 `onSelect`、命令注册、`/` 面板共用它，不各写一个字面量。 */
  id: string;
  kind: BlockFormatKind;
  labelKey: string;
  /**
   * 菜单分组。组与组之间画分隔线，组内不画。
   * 分组的依据是「用户想找什么」：改段落形态 / 定标题层级 / 包一层容器 / 列清单 / 插块。
   */
  group: 'text' | 'heading' | 'container' | 'list' | 'block';
  /**
   * `/` 面板的触发词，第一个是主词（显示在右侧）。
   *
   * **标签是译文，触发词必须是英文**：中文界面下标签是「标题 1」，`/h1` 一个字也匹配不上。
   * 给多个是因为两种人都存在 —— 顺手打 `h1` 的，与记得名字打 `heading` 的。
   */
  tokens: readonly string[];
}

export const BLOCK_FORMAT_SPECS: readonly BlockFormatSpec[] = [
  {
    id: 'format.paragraph',
    kind: 'paragraph',
    labelKey: 'cmd.paragraph',
    group: 'text',
    tokens: ['paragraph', 'text']
  },
  {
    id: 'format.heading-1',
    kind: 'heading-1',
    labelKey: 'cmd.heading1',
    group: 'heading',
    tokens: ['h1', 'heading 1']
  },
  {
    id: 'format.heading-2',
    kind: 'heading-2',
    labelKey: 'cmd.heading2',
    group: 'heading',
    tokens: ['h2', 'heading 2']
  },
  {
    id: 'format.heading-3',
    kind: 'heading-3',
    labelKey: 'cmd.heading3',
    group: 'heading',
    tokens: ['h3', 'heading 3']
  },
  {
    id: 'format.heading-4',
    kind: 'heading-4',
    labelKey: 'cmd.heading4',
    group: 'heading',
    tokens: ['h4', 'heading 4']
  },
  {
    id: 'format.heading-5',
    kind: 'heading-5',
    labelKey: 'cmd.heading5',
    group: 'heading',
    tokens: ['h5', 'heading 5']
  },
  {
    id: 'format.heading-6',
    kind: 'heading-6',
    labelKey: 'cmd.heading6',
    group: 'heading',
    tokens: ['h6', 'heading 6']
  },
  {
    id: 'format.quote',
    kind: 'quote',
    labelKey: 'cmd.quote',
    group: 'container',
    tokens: ['quote', 'blockquote']
  },
  {
    id: 'format.bullet-list',
    kind: 'bullet-list',
    labelKey: 'cmd.bulletList',
    group: 'list',
    tokens: ['ul', 'bullet']
  },
  {
    id: 'format.ordered-list',
    kind: 'ordered-list',
    labelKey: 'cmd.orderedList',
    group: 'list',
    tokens: ['ol', 'ordered', 'number']
  },
  {
    id: 'format.task-list',
    kind: 'task-list',
    labelKey: 'cmd.taskList',
    group: 'list',
    tokens: ['task', 'todo', 'checkbox']
  },
  {
    id: 'format.code-block',
    kind: 'code-block',
    labelKey: 'cmd.codeBlock',
    group: 'block',
    tokens: ['code', 'fence']
  },
  {
    id: 'format.table',
    kind: 'table',
    labelKey: 'cmd.table',
    group: 'block',
    tokens: ['table']
  },
  {
    id: 'format.divider',
    kind: 'horizontal-rule',
    labelKey: 'cmd.divider',
    group: 'block',
    tokens: ['divider', 'hr', 'rule']
  }
];

/** id → spec。菜单、工具栏、`/` 面板都按 id 找项；找不到就是写错了 id（测试钉住）。 */
export function findBlockFormatSpec(id: string): BlockFormatSpec | undefined {
  return BLOCK_FORMAT_SPECS.find((spec) => spec.id === id);
}

/**
 * 这一项在当前块状态下能不能点。
 *
 * 禁用分两种：落在表格 / 公式 / `raw` 里时**全禁用**；落在代码块里时只留「代码块」——
 * 那一项在那里是**拆围栏**，不是「包成代码块」。
 *
 * **菜单与工具栏的禁用都走这里。** 两处各写一遍必然漂，而「一个入口灰、另一个亮」
 * 比两处都灰更难查：用户会以为其中一条路坏了。
 */
export function isBlockFormatActionEnabled(
  spec: BlockFormatSpec,
  state: BlockFormatState
): boolean {
  if (state.editable) return true;
  return spec.kind === 'code-block' && state.inCodeBlock;
}

/**
 * 这一项是不是「当前生效的」。
 *
 * 与事务层共用 `readLine` / `activeLeaf`，所以 ✓ 亮着的时候点下去一定是「回退」，
 * 不会出现「✓ 说已经是 H2、点下去又给它加一层 `## `」。工具栏按钮的按下态与菜单的 ✓
 * **必须出自这一个表达式** —— 两处各算一次就会漂（判据 36 的同类）。
 */
export function isBlockFormatActionActive(spec: BlockFormatSpec, state: BlockFormatState): boolean {
  if (spec.kind === 'quote') return state.quoted;
  if (spec.kind === 'code-block') return state.inCodeBlock;
  return state.leaf === spec.kind;
}

/**
 * 工具栏上的一块。**只铺高频，其余留「格式」菜单** —— 代码块 / 表格 / 分割线三项不进这里：
 * 蓝图 `:357`「常驻工具栏不堆叠完整编辑器按钮」，而这三项的使用频率抵不上标题一次。
 *
 * 每一项按 **id 引用 `BLOCK_FORMAT_SPECS`**，不重写标签 / 命令 id —— 「同源」在这里是
 * 结构性的：工具栏只是同一张表的另一种排布，不是第二张表。测试钉住两点：表里的每个 id
 * 都能在 specs 里找到；`button` 项的 `id` / `labelKey` 与它那条 spec 逐字相同。
 */
export interface BlockFormatToolbarEntry {
  kind: 'button' | 'menu';
  /** `data-action` 锚点。`button` 时就是那条命令的 id。 */
  id: string;
  /** 按钮的 `aria-label` / `title` 文案键。`button` 时与 spec 的 `labelKey` 相同。 */
  labelKey: string;
  /** 这一项触发的命令 id：`button` 恰好一项，`menu` 是下拉里的全部项（顺序即渲染顺序）。 */
  ids: readonly string[];
  /**
   * 哪些成员生效时把按钮点亮。省略 = 全部 `ids`。
   *
   * **标题那一组必须排除「正文」。** 正文是所有段落的常态，把它算进来等于按钮永远亮着
   * （任何可改型的块都命中它），而「亮」是这一栏唯一的「当前是什么」提示 —— 恒真等于没有。
   * 真机用例抓到的就是这个：光标停在普通段落上，标题按钮不该是按下态。
   */
  activeIds?: readonly string[];
}

export const BLOCK_FORMAT_TOOLBAR: readonly BlockFormatToolbarEntry[] = [
  {
    kind: 'menu',
    id: 'format.heading',
    labelKey: 'cmd.heading',
    ids: [
      'format.paragraph',
      'format.heading-1',
      'format.heading-2',
      'format.heading-3',
      'format.heading-4',
      'format.heading-5',
      'format.heading-6'
    ],
    // 正文不算：它是常态，算进来按钮在任何段落上都亮着（见 `activeIds` 的说明）。
    activeIds: [
      'format.heading-1',
      'format.heading-2',
      'format.heading-3',
      'format.heading-4',
      'format.heading-5',
      'format.heading-6'
    ]
  },
  { kind: 'button', id: 'format.quote', labelKey: 'cmd.quote', ids: ['format.quote'] },
  {
    kind: 'button',
    id: 'format.bullet-list',
    labelKey: 'cmd.bulletList',
    ids: ['format.bullet-list']
  },
  {
    kind: 'button',
    id: 'format.ordered-list',
    labelKey: 'cmd.orderedList',
    ids: ['format.ordered-list']
  },
  { kind: 'button', id: 'format.task-list', labelKey: 'cmd.taskList', ids: ['format.task-list'] }
];

/** 一组动作整体的按下态：`activeIds`（省略即 `ids`）里**任意一项**生效就算按下。 */
export function isBlockFormatEntryActive(
  entry: BlockFormatToolbarEntry,
  state: BlockFormatState
): boolean {
  return (entry.activeIds ?? entry.ids).some((id) => {
    const spec = findBlockFormatSpec(id);
    return spec ? isBlockFormatActionActive(spec, state) : false;
  });
}

/** 一组动作整体的可点性：**任意一项可点就算可点**（代码块里那一组会整体变灰）。 */
export function isBlockFormatEntryEnabled(
  entry: BlockFormatToolbarEntry,
  state: BlockFormatState
): boolean {
  return entry.ids.some((id) => {
    const spec = findBlockFormatSpec(id);
    return spec ? isBlockFormatActionEnabled(spec, state) : false;
  });
}

/**
 * 把工具栏下拉（现在只有标题那一组）的 id 投影成下拉项。**分组线口径与
 * `blockFormatMenuItems` 相同**（组变了就插一条）—— 同一份列表在菜单栏与工具栏下拉里
 * 分组结构必须一致，一边有一边没有会让用户以为少了几项。
 *
 * **不设 `disabled`。** 下拉能打开就说明这一组里至少有一项可点，而当前这一组的成员
 * （正文 + 标题 1–6）**可点性完全一致** —— 它们都不是 `code-block`，所以要么全可点
 * （`state.editable`）、要么全不可点（代码块 / 表格 / 公式 / `raw` 里，那时按钮本身就是灰的、
 * 下拉根本打不开）。将来若往某一组里放进 `code-block` 这类**可点性不同**的成员，
 * 这里就要补上逐项的禁用，并且给 `ContextMenuItem` 加 `disabled`。
 */
export function blockFormatDropdownItems(
  ids: readonly string[],
  state: BlockFormatState,
  label: (key: string) => string,
  run: (id: string) => void
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  let group: BlockFormatSpec['group'] | null = null;

  for (const id of ids) {
    const spec = findBlockFormatSpec(id);
    if (!spec) continue;
    if (group !== null && spec.group !== group) {
      // 分隔线的 `id` / `label` 不参与渲染（`key` 用的是下标），留空是约定。
      items.push({ id: '', label: '', separator: true });
    }
    group = spec.group;
    items.push({
      id: spec.id,
      label: label(spec.labelKey),
      active: isBlockFormatActionActive(spec, state),
      onSelect: () => run(spec.id)
    });
  }

  return items;
}

/**
 * 把动作表投影成菜单项。`active` / `disabled` 出自上面那两个函数，与工具栏按钮同源。
 */
export function blockFormatMenuItems(
  state: BlockFormatState,
  label: (key: string) => string,
  run: (id: string) => void
): MenuBarItem[] {
  const items: MenuBarItem[] = [];
  let group: BlockFormatSpec['group'] | null = null;

  for (const spec of BLOCK_FORMAT_SPECS) {
    if (group !== null && spec.group !== group) items.push({ label: '', separator: true });
    group = spec.group;

    items.push({
      // 命令 id 同时当菜单项的锚点：真机用例按它找项，不按文案 —— 文案会跟着语言变。
      id: spec.id,
      label: label(spec.labelKey),
      active: isBlockFormatActionActive(spec, state),
      disabled: !isBlockFormatActionEnabled(spec, state),
      onSelect: () => run(spec.id)
    });
  }

  return items;
}
