import type { BlockFormatKind, BlockFormatState } from '@nexus/editor';
import type { MenuBarItem } from '../MenuBar.js';

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
 * **`highlight` 不在这张表里。** 它作用于选区、无选区时无意义，所以归行内那张
 * （`SELECTION_ACTION_SPECS`）；这张表只放**块级**动作（无选区也能用的）。
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
 * 常驻工具栏铺哪几项。**高频子集**，其余留「格式」菜单 —— 代码块 / 表格 / 分割线不进：
 * 蓝图 `:357`「常驻工具栏不堆叠完整编辑器按钮」，而这三项的使用频率抵不上标题一次。
 *
 * 每一项按 **id 引用 `BLOCK_FORMAT_SPECS`**，不重写标签 / 命令 id —— 「同源」在这里是
 * 结构性的：工具栏只是同一张表的另一种排布，不是第二张表。测试钉住：每个 id 都能在 specs
 * 里找到，且标签与命令 id 与那条 spec 逐字相同。
 *
 * **标题是七枚平铺的按钮**（正文 + 标题 1–6），不是一个下拉。下拉要把「当前是哪一级」
 * 藏在一次点击后面，而这一栏的按下态本来就是「当前是什么」的唯一提示。
 */
export const BLOCK_FORMAT_TOOLBAR: readonly string[] = [
  'format.paragraph',
  'format.heading-1',
  'format.heading-2',
  'format.heading-3',
  'format.heading-4',
  'format.heading-5',
  'format.heading-6',
  'format.quote',
  'format.bullet-list',
  'format.ordered-list',
  'format.task-list'
];

/**
 * 把动作表投影成菜单项。`active` / `disabled` 与工具栏按钮同源 —— 同一对
 * `isBlockFormatActionActive` / `isBlockFormatActionEnabled`。
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
