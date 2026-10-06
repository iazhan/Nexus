import React, { useCallback, useRef, useState } from 'react';
import type { BlockFormatState, EditorSurfaceKind } from '@nexus/editor';
import { useLocale } from '../hooks.js';
import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu.js';
import {
  CodeIcon,
  EyeIcon,
  FindIcon,
  MoreIcon,
  RedoIcon,
  UndoIcon
} from '../components/editor-icons.js';
import {
  BulletListIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  Heading4Icon,
  Heading5Icon,
  Heading6Icon,
  OrderedListIcon,
  ParagraphIcon,
  QuoteIcon,
  TaskListIcon
} from '../components/format-icons.js';
import {
  BLOCK_FORMAT_TOOLBAR,
  findBlockFormatSpec,
  isBlockFormatActionActive,
  isBlockFormatActionEnabled
} from './block-format-specs.js';

export interface EditorToolbarProps {
  surfaceKind: EditorSurfaceKind;
  /**
   * 文档只读。**降级而不是隐藏**：整条栏照画，只把**写**动作（`undo` / `redo` / 块级格式 /
   * `more`）禁用。`toggle-surface` 与 `find` 是视图 / 读动作，在只读下照样有效，不禁用。
   */
  readOnly: boolean;
  /**
   * 光标所在块的类型 / 是不是引用 / 能不能改型。块级按钮的**按下态与禁用都从它派生**，
   * 而它与「格式」菜单的 ✓ 出自同一个查询器 —— 两处的口径必须一致。
   */
  formatState: BlockFormatState;
  onUndo(): void;
  onRedo(): void;
  onToggleSurface(): void;
  onFind(): void;
  /**
   * 块级动作。**与「格式」菜单同一条命令**（宿主 `runCommand`），不是第二份实现 ——
   * 蓝图 `:394` 的「同一组命令」在工具栏这里是靠传同一个函数引用成立的。
   */
  onBlockFormat(id: string): void;
  /**
   * 「更多」下拉里的条目。**标签由调用方给** —— 它才知道这些条目对应哪条命令
   * （这里只负责画）。
   */
  moreItems: readonly ContextMenuItem[];
}

/**
 * 工具栏上块级动作的图标。**按 `BLOCK_FORMAT_TOOLBAR` 的 id 索引** ——
 * 表里加了一项而这里没配图标会渲染成空白按钮（有用例钉住「每一项都配了图标」）。
 */
const FORMAT_ICONS: Record<string, React.ReactNode> = {
  'format.paragraph': ParagraphIcon,
  'format.heading-1': Heading1Icon,
  'format.heading-2': Heading2Icon,
  'format.heading-3': Heading3Icon,
  'format.heading-4': Heading4Icon,
  'format.heading-5': Heading5Icon,
  'format.heading-6': Heading6Icon,
  'format.quote': QuoteIcon,
  'format.bullet-list': BulletListIcon,
  'format.ordered-list': OrderedListIcon,
  'format.task-list': TaskListIcon
};

/**
 * 拦掉「按下按钮会把焦点抢过去」这条默认行为。
 *
 * 必须是 `mousedown`：焦点在那一刻换手，拦在 `click` 上时编辑器早就失焦了。
 * 只拦主键 —— 右键要留给上下文菜单，中键要留给「新标签打开」。拦下默认行为
 * **不影响 `click`**，所以按钮的动作照常触发。
 *
 * 块级格式动作尤其依赖这条：它们读的是 `view.state.selection`，焦点一丢选区就没了，
 * 表现成「点了没反应」。
 */
const preserveEditorFocus = (event: React.MouseEvent) => {
  if (event.button !== 0) return;
  event.preventDefault();
};

/** 下拉锚点。量不到（还没排版）时返回 `null` —— 开在 (0,0) 闪一下比不开更糟。 */
function useDropdownAnchor(ref: React.RefObject<HTMLButtonElement | null>) {
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);

  const toggle = useCallback(() => {
    setAnchor((current) => {
      if (current) return null;
      const rect = ref.current?.getBoundingClientRect();
      return rect ? { left: rect.left, top: rect.bottom + 4 } : null;
    });
  }, [ref]);

  const close = useCallback(() => setAnchor(null), []);

  return { anchor, toggle, close };
}

/**
 * 编辑器常驻工具栏：`Undo · Redo | Source/WYSIWYG | ¶ · H1–H6 · Quote · Bullet ·
 * Numbered · Task | Find … More`。
 *
 * ## 为什么是一行「占位」而不是浮层
 *
 * 参考实现 OpenKnowledge 把它做成 `absolute` 覆盖在正文上（所以它需要一份
 * `editor-toolbar-overlap.ts` 专门处理遮挡）。Nexus **不抄这一层**：这一栏插在
 * 标签栏**上方**、按正常流占一行 —— 遮挡问题从根上不存在，也就不需要那份补丁。
 * 与它并排的标签栏、状态栏都是正常流，只有这一栏浮着反而不一致。
 *
 * 代价是正文少一行高度。这是**有意付的**：常驻栏的意义就是「一直在」，
 * 而浮层在正文滚到顶部时会压住第一行。
 *
 * ## 块级动作常驻，行内格式不进这里
 *
 * 蓝图 `:346` 的默认工具栏是 `Undo · Redo · Source/WYSIWYG · Format · Insert · Find · More`。
 * 落到 Nexus 是「**块级**动作上常驻栏，**行内**动作留在选区上下文条」——分界线是
 * **无选区时还有没有意义**：
 *
 * - 块级动作（标题 / 引用 / 列表）无选区时作用于**光标所在行**，按钮永远有效；
 * - 行内动作（加粗 / 斜体 / 删除线 / 行内代码）在 `createInlineFormatTransaction` 里
 *   对空选区**直接返回 `null`**，常驻就是一排点了没反应的死按钮。
 *
 * 这也是两个参考实现共同的选择：Markra 的行内格式只在**选中文本时**浮出。
 *
 * 蓝图 `:357`「常驻工具栏不堆叠完整编辑器按钮」并没有被违反：这里铺的仍是**子集**，
 * 代码块 / 表格 / 分割线仍只在「格式」菜单里。标题铺满六级是**有意的** —— 下拉把
 * 「当前是哪一级」藏在一次点击后面，而这一栏的按下态就是「当前是什么」的唯一提示，
 * 六级各占一格才能一眼看出光标停在哪一级。
 *
 * ## 纯展示 + 回调，不读 store
 *
 * 与 `WorkspaceToolbar` 同一条约定。动作**不在这里定义**：调用方把它们接到宿主命令上
 * （`toggle-surface` / `find` / `replace` / `format.*`），于是工具栏按钮与快捷键、菜单
 * 指向同一份实现（蓝图 `:394`）。这样也让这个组件能在 happy-dom 里单独渲染测试，
 * 不必造整个 App。
 *
 * ## 按下就拦，别等 `click`（焦点保持）
 *
 * 焦点是在 `mousedown` 那一刻换手的：按钮拿走焦点 → 编辑器失焦 → 命令读到的选区是空的，
 * 表现成「点了没反应」。所以在 `mousedown` 上 `preventDefault`，让按钮**不参与**焦点竞争。
 * 拦在 `click` 上没用 —— 那时已经换过手了。折叠三角那条是同一个坑。
 *
 * 「更多」那个下拉是这条的例外：菜单本身得拿焦点，键盘才走得动，所以它开的时候编辑器
 * 确实会失焦 —— 靠 `ContextMenu` 关闭时把焦点**还回来**（`Dialog` 也是这么做的）。
 *
 * ## 只读：降级，不是隐藏
 *
 * 蓝图 §19「Read-only → 工具栏控件降级」。整条栏照画，只把**写**动作禁用；
 * `toggle-surface` 是视图动作、`find` 是读动作，在只读下照样有效 —— 禁掉它们不是降级，
 * 是把「看」也一起收了（CM 的搜索面板自己会把替换那一半收起来，外面不必再拦一道）。
 * 禁用时 `title` 换成**原因**，不叠两个说法（同 `WorkspaceToolbar` 的
 * `canDelete` / `deleteHint`）。
 */
export const EditorToolbar: React.FC<EditorToolbarProps> = ({
  surfaceKind,
  readOnly,
  formatState,
  onUndo,
  onRedo,
  onToggleSurface,
  onFind,
  onBlockFormat,
  moreItems
}) => {
  const { t } = useLocale();

  // 图标 / `aria-pressed` / 文案三件事必须一致（判据 36）：文案说的是「点了会变成什么」，
  // 图标画的是同一个方向，`aria-pressed` 判的是「现在是不是富文本」。
  const surfaceToVisual = surfaceKind === 'source';
  const surfaceLabel = t(surfaceToVisual ? 'surface.toVisual' : 'surface.toSource');

  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreMenu = useDropdownAnchor(moreButtonRef);

  /** 禁用时 `title` 换成原因 —— 灰按钮不带解释时用户只会反复点它。 */
  const titleFor = (label: string) => (readOnly ? t('editor.toolbar.readonly') : label);

  return (
    <div
      className="nexus-editor-toolbar"
      role="toolbar"
      aria-label={t('editor.toolbar.label')}
      onMouseDown={preserveEditorFocus}
    >
      <button
        type="button"
        className="nexus-toolbar-button"
        data-action="undo"
        title={titleFor(t('cmd.undo'))}
        aria-label={t('cmd.undo')}
        aria-disabled={readOnly}
        disabled={readOnly}
        onClick={onUndo}
      >
        {UndoIcon}
      </button>

      <button
        type="button"
        className="nexus-toolbar-button"
        data-action="redo"
        title={titleFor(t('cmd.redo'))}
        aria-label={t('cmd.redo')}
        aria-disabled={readOnly}
        disabled={readOnly}
        onClick={onRedo}
      >
        {RedoIcon}
      </button>

      <span className="nexus-editor-toolbar-separator" aria-hidden="true" />

      {/* 源码 / 富文本切换。**顶栏那枚已删，这是唯一的按钮入口**（另有快捷键与命令面板）。
          实现内联在这里而不是抽组件：只剩这一个调用方，抽象不再换来「两处一致」，
          只会多一个「谁在用」查不出来的文件。 */}
      <button
        type="button"
        className="nexus-toolbar-button"
        data-action="toggle-surface"
        title={surfaceLabel}
        aria-label={surfaceLabel}
        aria-pressed={!surfaceToVisual}
        onClick={onToggleSurface}
      >
        {surfaceToVisual ? CodeIcon : EyeIcon}
      </button>

      <span className="nexus-editor-toolbar-separator" aria-hidden="true" />

      {BLOCK_FORMAT_TOOLBAR.map((id) => {
        // 按下态与禁用都出自 `formatState`，与「格式」菜单的 ✓ / 灰出自同一对函数 ——
        // 视觉与 `aria-pressed` 也是同一个布尔的两个用法（判据 36）。
        const spec = findBlockFormatSpec(id);
        if (!spec) return null;
        const active = isBlockFormatActionActive(spec, formatState);
        const disabled = readOnly || !isBlockFormatActionEnabled(spec, formatState);
        const label = t(spec.labelKey);

        return (
          <button
            key={id}
            type="button"
            className={`nexus-toolbar-button${active ? ' nexus-toolbar-button-on' : ''}`}
            data-action={id}
            title={titleFor(label)}
            aria-label={label}
            aria-pressed={active}
            aria-disabled={disabled}
            disabled={disabled}
            onClick={() => onBlockFormat(id)}
          >
            {FORMAT_ICONS[id]}
          </button>
        );
      })}

      <span className="nexus-editor-toolbar-separator" aria-hidden="true" />

      <button
        type="button"
        className="nexus-toolbar-button"
        data-action="find"
        title={t('cmd.find')}
        aria-label={t('cmd.find')}
        onClick={onFind}
      >
        {FindIcon}
      </button>

      <span className="nexus-editor-toolbar-spacer" />

      <button
        ref={moreButtonRef}
        type="button"
        className="nexus-toolbar-button"
        data-action="more"
        title={titleFor(t('editor.toolbar.more'))}
        aria-label={t('editor.toolbar.more')}
        aria-haspopup="menu"
        aria-expanded={moreMenu.anchor !== null}
        aria-disabled={readOnly}
        disabled={readOnly}
        onClick={moreMenu.toggle}
      >
        {MoreIcon}
      </button>

      {moreMenu.anchor && (
        <ContextMenu
          x={moreMenu.anchor.left}
          y={moreMenu.anchor.top}
          items={moreItems}
          onClose={moreMenu.close}
          label={t('editor.toolbar.more')}
          anchorRef={moreButtonRef}
        />
      )}
    </div>
  );
};
