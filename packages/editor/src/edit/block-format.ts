import { parseMarkdown, type MarkdownNode, type MarkdownRoot } from '@nexus/markdown';
import type { Text } from '@codemirror/state';
import { createMarkdownChangeSet, mapMarkdownSelection } from '../document-session.js';
import type { MarkdownChange, MarkdownEditTransaction, MarkdownSelection } from '../types.js';
import { getLineAt, isFenceClosed, parseLines } from './lookup.js';
import { detectEol } from './source-scan.js';

/**
 * 块级改型事务。
 *
 * ## 模型：叶块类型互斥，引用是容器
 *
 * 一行拆成 `[缩进][引用前缀][叶标记][正文]`。**叶块类型**（段落 / 标题 N / 无序 / 有序 / 任务）
 * 只有一个槽位，改型就是替换它 —— 与 Typora / Obsidian 的「块类型」菜单一致，也是 Markdown
 * 的语法事实（`- [ ] x` 里不可能同时是 `## x`）。**引用不是叶类型**：`> - x` 是合法且常见的
 * 「引用里的列表」，所以引用单独一层、加/减各一次、**可逆**。两者正交，`> ## 标题` 上
 * 「引用」与「标题 2」的两个 ✓ 会同时亮，这是有意的。
 *
 * ## 作用范围是**选中的行**，不是「AST 块」
 *
 * 空选区 = 光标所在行；多行选区 = 首行到末行。行是用户的单位（拖选三行按列表 = 三行都变列表），
 * 而「AST 块」在多行选区上是个没有答案的问题（选中的是段落 + 代码块，改型改谁？）。
 * 选区终点**正好落在下一行行首**时不算那一行 —— 那是「拖到行尾」，不是「选上下一行」。
 *
 * ## 不可改型的容器：只挡块级，不挡行内
 *
 * 代码块 / 块公式 / 表格 / `raw` 里改型会把容器本身切碎，一律拒绝。**行内原子
 * （行内代码 / 链接 / 公式 / 图片 / 转义）不挡** —— 段落里的 `` `x` `` 是内容不是容器，
 * 把它所在的段落变成 H2 是正常操作。所以判据取自 AST 的**块级**节点，而不是
 * `findAtomicRanges` 那张把行内节点也算进去的表。
 *
 * ## 空事务返回 `null`
 *
 * 与 `inline-format.ts` 的 `clear` 同一条判据：空事务会进 undo 栈，用户连按几次「正文」，
 * 撤销就要按同样多次才回得去。
 *
 * ## CRLF
 *
 * 行边界一律走 `parseLines`（它的 `text` / `to` 都不含 `\r`），插入的换行取 `detectEol`。
 * 按行加前缀的正则在 CRLF 上会整条失配，所以这里没有任何按行尾写的正则。
 *
 * ## 没有默认快捷键
 *
 * 入口是「格式」菜单（也照常出现在命令面板）。参考实现给标题配了 `Mod-Alt-1..6`、
 * 给列表配了 `Mod-Shift-7/8`，但那套数字键与「按序号切标签页」是同一个键位族，先不占。
 */

export type BlockFormatKind =
  | 'paragraph'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'heading-5'
  | 'heading-6'
  | 'quote'
  | 'bullet-list'
  | 'ordered-list'
  | 'task-list'
  | 'code-block'
  | 'table'
  | 'horizontal-rule';

interface SourceLine {
  text: string;
  from: number;
  to: number;
  number: number;
}

/** 叶块类型。与 `BlockFormatKind` 不是一回事：引用 / 代码块 / 表格 / 分割线不在这一列。 */
type LeafKind = 'paragraph' | 'heading' | 'bullet' | 'ordered' | 'task';

/** 行首缩进。 */
const INDENT_RE = /^[ \t]*/;
/** 引用前缀，可多层（`> ` / `>> ` / `> > `）。 */
const QUOTE_RE = /^(?:[ \t]*>[ \t]*)+/;
/** ATX 标题。缩进最多 3 格是 CommonMark 的规则；`##x`（缺空格）不是标题。 */
const HEADING_RE = /^(#{1,6})(?:[ \t]+|$)/;
/** 任务项。**要排在无序列表前面** —— `- [ ] x` 同时满足两个模式。 */
const TASK_RE = /^[-+*][ \t]+\[[ xX]\](?:[ \t]+|$)/;
const BULLET_RE = /^[-+*](?:[ \t]+|$)/;
const ORDERED_RE = /^(\d{1,9})[.)](?:[ \t]+|$)/;

/** 叶块类型的候选顺序。`paragraph` 排最后：它是「以上都不是」的落点。 */
const LEAF_KINDS = [
  'heading-1',
  'heading-2',
  'heading-3',
  'heading-4',
  'heading-5',
  'heading-6',
  'bullet-list',
  'ordered-list',
  'task-list',
  'paragraph'
] as const satisfies readonly BlockFormatKind[];

const HEADING_DEPTH: Readonly<Record<string, number>> = {
  'heading-1': 1,
  'heading-2': 2,
  'heading-3': 3,
  'heading-4': 4,
  'heading-5': 5,
  'heading-6': 6
};

/** 表格骨架：两列，一个表头 + 一个空行。用户接着填。 */
const TABLE_SKELETON = ['|  |  |', '| --- | --- |', '|  |  |'];

const FENCE = '```';

interface LineBlock {
  line: SourceLine;
  /** 行首缩进文本。改型保留它 —— 缩进是列表的层级，不是块类型的一部分。 */
  indent: string;
  /** 引用前缀文本。 */
  quote: string;
  leaf: LeafKind;
  /** 标题层级；非标题为 0。 */
  level: number;
  /** 叶标记相对行首的 `[from, to)`。`from === to` 表示没有叶标记。 */
  leafFrom: number;
  leafTo: number;
}

interface OpaqueBlock {
  from: number;
  to: number;
  type: 'code-block' | 'block-math' | 'table' | 'raw';
}

/**
 * 当前行的块级状态。**菜单的 ✓ 与「点下去是改型还是回退」出自同一个表达式** ——
 * 分开写的话会出现「✓ 亮着、点击做的是另一件事」（同判据 36）。
 */
export interface BlockFormatState {
  /** 叶块类型。多行选区类型不一致、或落在不可改型的容器里时是 `null`（一个 ✓ 都不亮）。 */
  leaf: BlockFormatKind | null;
  /** 引用容器是否成立。与 `leaf` 正交，可能同时亮。 */
  quoted: boolean;
  /** 现在能不能改型。落在代码块 / 公式 / 表格 / `raw` 里时为 `false`。 */
  editable: boolean;
  /**
   * 光标落在**代码块**里。这时「代码块」这一项仍然是有效的 —— 它是拆围栏。
   * 其余块级动作与 `editable` 一样被拒。表格 / 公式 / `raw` 里连它也无效。
   */
  inCodeBlock: boolean;
}

export const EMPTY_BLOCK_FORMAT_STATE: BlockFormatState = {
  leaf: null,
  quoted: false,
  editable: false,
  inCodeBlock: false
};

function readLine(line: SourceLine): LineBlock {
  const indent = INDENT_RE.exec(line.text)![0];
  const rest = line.text.slice(indent.length);
  const quote = QUOTE_RE.exec(rest)?.[0] ?? '';
  const after = rest.slice(quote.length);
  const leafFrom = indent.length + quote.length;

  const heading = HEADING_RE.exec(after);
  if (heading) {
    return {
      line,
      indent,
      quote,
      leaf: 'heading',
      level: heading[1]!.length,
      leafFrom,
      leafTo: leafFrom + heading[0].length
    };
  }
  const task = TASK_RE.exec(after);
  if (task) {
    return { line, indent, quote, leaf: 'task', level: 0, leafFrom, leafTo: leafFrom + task[0].length };
  }
  const bullet = BULLET_RE.exec(after);
  if (bullet) {
    return { line, indent, quote, leaf: 'bullet', level: 0, leafFrom, leafTo: leafFrom + bullet[0].length };
  }
  const ordered = ORDERED_RE.exec(after);
  if (ordered) {
    return { line, indent, quote, leaf: 'ordered', level: 0, leafFrom, leafTo: leafFrom + ordered[0].length };
  }
  return { line, indent, quote, leaf: 'paragraph', level: 0, leafFrom, leafTo: leafFrom };
}

function leafMatches(block: LineBlock, kind: BlockFormatKind): boolean {
  const depth = HEADING_DEPTH[kind];
  if (depth !== undefined) return block.leaf === 'heading' && block.level === depth;
  switch (kind) {
    case 'bullet-list':
      return block.leaf === 'bullet';
    case 'ordered-list':
      return block.leaf === 'ordered';
    case 'task-list':
      return block.leaf === 'task';
    case 'paragraph':
      return block.leaf === 'paragraph';
    default:
      return false;
  }
}

/** 一组行的叶块类型。混合时 `null` —— 这时任何叶项都不该亮 ✓。 */
function activeLeaf(blocks: readonly LineBlock[]): BlockFormatKind | null {
  for (const kind of LEAF_KINDS) {
    if (blocks.every((block) => leafMatches(block, kind))) return kind;
  }
  return null;
}

/** 把位置落到它所在的行号。CRLF 下 `\r` 不属于任何一行，所以取「最后一个 `from <= pos`」。 */
function lineIndexAt(lines: readonly SourceLine[], pos: number): number {
  let index = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.from <= pos) index = i;
    else break;
  }
  return index;
}

function sliceLines(
  source: string,
  lines: readonly SourceLine[],
  selection: MarkdownSelection
): SourceLine[] {
  const from = Math.min(selection.anchor, selection.head);
  let to = Math.max(selection.anchor, selection.head);
  // 选区终点正好在下一行行首：用户拖到的是行尾，那一行不算被选中。
  if (to > from && to > 0 && source[to - 1] === '\n') to -= 1;
  return lines.slice(lineIndexAt(lines, from), lineIndexAt(lines, to) + 1);
}

function collectOpaqueBlocks(root: MarkdownRoot): OpaqueBlock[] {
  const found: OpaqueBlock[] = [];
  const visit = (node: MarkdownNode) => {
    if (
      node.type === 'code-block' ||
      node.type === 'block-math' ||
      node.type === 'table' ||
      node.type === 'raw'
    ) {
      found.push({ from: node.range.from, to: node.range.to, type: node.type });
      return;
    }
    // 只下潜容器。段落 / 标题里的行内节点不是容器，走不到这里也就不必判。
    if (node.type === 'blockquote') {
      for (const child of node.children) visit(child);
      return;
    }
    if (node.type === 'list') {
      for (const item of node.items) visit(item);
      return;
    }
    if (node.type === 'list-item') {
      for (const child of node.children) visit(child);
    }
  };
  for (const child of root.children) visit(child);
  return found;
}

/** 行与容器是否**有重叠**。空行也算一格，否则「光标停在代码块里的空行上」会漏判。 */
function lineHitsBlock(line: SourceLine, block: OpaqueBlock): boolean {
  const end = line.to > line.from ? line.to : line.from + 1;
  return line.from < block.to && end > block.from;
}

function finalize(
  source: string,
  selection: MarkdownSelection,
  changes: readonly MarkdownChange[],
  userEvent: string
): MarkdownEditTransaction | null {
  const effective = changes.filter((change) => change.from !== change.to || change.insert.length > 0);
  if (effective.length === 0) return null;
  const changeSet = createMarkdownChangeSet(source, effective);
  return {
    changes: effective,
    selection: mapMarkdownSelection(selection, changeSet),
    userEvent
  };
}

/** 一行末尾那个换行符的长度。行尾无换行（文档末尾）时为 0。 */
function eolLengthAfter(source: string, pos: number): number {
  if (pos >= source.length) return 0;
  return source[pos] === '\r' ? 2 : 1;
}

/** 一行开头那个换行符的长度。行首无换行（文档开头）时为 0。 */
function eolLengthBefore(source: string, pos: number): number {
  if (pos === 0) return 0;
  if (source[pos - 1] !== '\n') return 0;
  return source[pos - 2] === '\r' ? 2 : 1;
}

function quoteChanges(blocks: readonly LineBlock[]): MarkdownChange[] {
  const changes: MarkdownChange[] = [];
  const remove = blocks.every((block) => block.quote.length > 0);
  for (const block of blocks) {
    const start = block.line.from + block.indent.length;
    if (remove) {
      changes.push({ from: start, to: start + block.quote.length, insert: '' });
    } else if (block.quote.length === 0) {
      // 已经引用的行不重复加 —— 混选时结果是「全部引用」，不是「引用套引用」。
      changes.push({ from: start, to: start, insert: '> ' });
    }
  }
  return changes;
}

function leafMarker(kind: BlockFormatKind, index: number): string {
  const depth = HEADING_DEPTH[kind];
  if (depth !== undefined) return `${'#'.repeat(depth)} `;
  switch (kind) {
    case 'bullet-list':
      return '- ';
    case 'ordered-list':
      return `${index + 1}. `;
    case 'task-list':
      return '- [ ] ';
    default:
      return '';
  }
}

function leafChanges(
  blocks: readonly LineBlock[],
  kind: BlockFormatKind,
  strip: boolean
): MarkdownChange[] {
  const changes: MarkdownChange[] = [];
  blocks.forEach((block, index) => {
    const marker = strip ? '' : leafMarker(kind, index);
    // 本来就是段落、目标又是段落：这一行没有前缀可去，也不该插一个空串。
    if (marker.length === 0 && block.leaf === 'paragraph') return;
    changes.push({
      from: block.line.from + block.leafFrom,
      to: block.line.from + block.leafTo,
      insert: marker
    });
  });
  return changes;
}

/**
 * 拆掉一个代码块的围栏，留下内容。
 *
 * 开栏行连**它后面那个换行**一起删、闭栏行连**它前面那个换行**一起删 ——
 * 否则会在文档里留下一个空行。空代码块（` ```\n``` `）两个区间会重叠，那时整段删掉。
 */
function unwrapFence(
  source: string,
  selection: MarkdownSelection,
  block: OpaqueBlock
): MarkdownEditTransaction | null {
  const openLine = getLineAt(source, block.from);
  const closeLine = getLineAt(source, Math.max(block.from, block.to - 1));
  if (closeLine.from <= openLine.from) return null;

  const openEnd = openLine.to + eolLengthAfter(source, openLine.to);
  const closeStart = closeLine.from - eolLengthBefore(source, closeLine.from);

  const changes: MarkdownChange[] =
    closeStart <= openEnd
      ? [{ from: openLine.from, to: closeLine.to, insert: '' }]
      : [
          { from: openLine.from, to: openEnd, insert: '' },
          { from: closeStart, to: closeLine.to, insert: '' }
        ];

  return finalize(source, selection, changes, 'format.block');
}

function toggleCodeBlock(
  source: string,
  selection: MarkdownSelection,
  lines: readonly SourceLine[],
  opaque: readonly OpaqueBlock[]
): MarkdownEditTransaction | null {
  // 表格 / 公式 / raw 里不给包 —— 包成代码块会把那些结构退化成字面文本。
  if (
    lines.some((line) =>
      opaque.some((block) => block.type !== 'code-block' && lineHitsBlock(line, block))
    )
  ) {
    return null;
  }

  const first = lines[0]!;
  const container = opaque.find(
    (block) => block.type === 'code-block' && first.from >= block.from && first.from < block.to
  );
  if (container) {
    // 未闭合的围栏拆不掉：找不到哪里算结束，删错就是把正文吃进去。
    if (!isFenceClosed(source.slice(container.from, container.to))) return null;
    return unwrapFence(source, selection, container);
  }

  const eol = detectEol(source);
  const last = lines[lines.length - 1]!;
  if (first.from === last.to) {
    // 空行：两个插入点重合，分开插会在围栏里多出一个空行。
    //
    // 光标**显式落在开栏行末尾**，不走 `finalize` 的映射：那个映射用 assoc=1，
    // 会把位置推到插入内容的**末尾**（闭栏行之后），而这里两行围栏是一次插入的。
    // 包一个空行的人下一步就要敲代码，光标必须在围栏**里面** —— `/` 面板打
    // 「代码块」走的正是这条路，落错地方就等于每次都要先按一次上箭头。
    const fence = `${FENCE}${eol}${FENCE}`;
    return {
      changes: [{ from: first.from, to: first.from, insert: fence }],
      selection: { anchor: first.from + FENCE.length, head: first.from + FENCE.length },
      userEvent: 'format.block'
    };
  }

  // 插在 `line.to`（行尾**换行符之前**）：行尾那个换行自动成了新行的结束符。
  return finalize(
    source,
    selection,
    [
      { from: first.from, to: first.from, insert: FENCE + eol },
      { from: last.to, to: last.to, insert: eol + FENCE }
    ],
    'format.block'
  );
}

/**
 * 插入动作（表格 / 分割线）。
 *
 * 落在**当前行之后**，光标跟着走进插入内容里。不落在光标处是因为那会切开行内文本
 * （`he|llo` 插一条分割线 → `he\n---\nllo`）—— 这两个动作是「加一个新块」，
 * 没有理由动用户已有的字。
 *
 * 当前行是空行时不补前置换行：空行自己后面那个换行已经足够分隔。
 */
function insertBlock(
  source: string,
  selection: MarkdownSelection,
  kind: 'table' | 'horizontal-rule'
): MarkdownEditTransaction | null {
  const lines = sliceLines(source, parseLines(source), selection);
  const anchor = lines.at(-1);
  if (!anchor) return null;

  const eol = detectEol(source);
  const body = kind === 'table' ? TABLE_SKELETON.join(eol) : '---';
  const lead = anchor.text.length === 0 ? '' : eol;
  // 表格落在第一个表头格子里（`| ` 之后），分割线落在它自己的行首。
  const caret = anchor.to + lead.length + (kind === 'table' ? 2 : 0);

  return {
    changes: [{ from: anchor.to, to: anchor.to, insert: lead + body }],
    selection: { anchor: caret, head: caret },
    userEvent: 'format.block'
  };
}

/**
 * 把选中行的块类型改成 `kind`。返回 `null` 表示「这个选区上什么也不该发生」——
 * 不可改型的容器、或（去前缀时）本来就没有前缀。
 *
 * 已经是目标类型时**回退到段落**（H2 再点 H2 变正文），与参考实现一致：
 * 一个只能「设」不能「撤」的块类型菜单，用户想取消一个标题就只能手删 `## `。
 */
export function createBlockFormatTransaction(
  source: string,
  selection: MarkdownSelection,
  kind: BlockFormatKind
): MarkdownEditTransaction | null {
  const lines = sliceLines(source, parseLines(source), selection);
  if (lines.length === 0) return null;
  const blocks = lines.map(readLine);

  if (kind === 'table' || kind === 'horizontal-rule') return insertBlock(source, selection, kind);

  const opaque = collectOpaqueBlocks(parseMarkdown(source).root);
  if (kind === 'code-block') return toggleCodeBlock(source, selection, lines, opaque);

  if (lines.some((line) => opaque.some((block) => lineHitsBlock(line, block)))) return null;

  if (kind === 'quote') return finalize(source, selection, quoteChanges(blocks), 'format.block');

  const strip = activeLeaf(blocks) === kind;
  return finalize(source, selection, leafChanges(blocks, kind, strip), 'format.block');
}

function stateOf(lines: readonly SourceLine[], opaque: readonly OpaqueBlock[]): BlockFormatState {
  if (lines.length === 0) return EMPTY_BLOCK_FORMAT_STATE;

  const hit = (block: OpaqueBlock) => lines.some((line) => lineHitsBlock(line, block));
  const inCodeBlock = opaque.some((block) => block.type === 'code-block' && hit(block));
  if (inCodeBlock || opaque.some((block) => block.type !== 'code-block' && hit(block))) {
    return { leaf: null, quoted: false, editable: false, inCodeBlock };
  }

  const blocks = lines.map(readLine);
  return {
    leaf: activeLeaf(blocks),
    quoted: blocks.every((block) => block.quote.length > 0),
    editable: true,
    inCodeBlock: false
  };
}

/** 菜单的 ✓ / 禁用依据。与 `createBlockFormatTransaction` 共用 `readLine` 与 `activeLeaf`。 */
export function readBlockFormatState(
  source: string,
  selection: MarkdownSelection
): BlockFormatState {
  return stateOf(
    sliceLines(source, parseLines(source), selection),
    collectOpaqueBlocks(parseMarkdown(source).root)
  );
}

/**
 * 块级状态查询器。**按 `Text` 对象标识缓存解析结果** —— 与 `createFormattingAnalyzer` 同一条
 * 性能契约：连续移动光标（文档没变）时不做字符串化、不解析、不扫全篇，只切片。
 * 调用方必须**跨渲染持有**这一个实例，每次渲染新建一个的话缓存永远命中不了。
 *
 * 输入取 `view.state.doc` 而不是 `session.getSnapshot().source`：CRLF 文档里后者带 `\r`，
 * 与视图的偏移量对不上。
 */
export function createBlockFormatAnalyzer(): (
  doc: Text,
  selection: MarkdownSelection
) => BlockFormatState {
  let cachedDoc: Text | null = null;
  let cachedSource = '';
  let cachedLines: SourceLine[] = [];
  let cachedOpaque: OpaqueBlock[] = [];

  return (doc, selection) => {
    if (doc !== cachedDoc) {
      cachedDoc = doc;
      cachedSource = doc.toString();
      cachedLines = parseLines(cachedSource);
      cachedOpaque = collectOpaqueBlocks(parseMarkdown(cachedSource).root);
    }
    return stateOf(sliceLines(cachedSource, cachedLines, selection), cachedOpaque);
  };
}
