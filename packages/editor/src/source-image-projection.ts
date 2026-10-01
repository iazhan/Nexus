/**
 * Source surface 的**图片投影**。
 *
 * Source 模式的契约是「Markdown 原文就是界面」，所以这里**只做一件事**：把图片引用
 * 换成真图。标题、粗体、表格、公式、列表标记一律保持源码原文 —— 那些是 Visual 模式的
 * 投影该管的，混进来就等于在 Source 模式里偷偷开了一个半成品 Visual 模式。
 *
 * ## 为什么不复用 `buildVisualProjection`
 *
 * 那个函数把「隐藏标记」与「渲染节点」编在同一棵 walk 里（heading 要隐藏 `#`、
 * 列表要换 marker、代码块要挂 header）。加个开关让它「只渲染图片」需要在十几个分支上
 * 各加一个 guard，任何一处漏掉都会在 Source 模式里冒出一块 Visual 模式的东西。
 * 独立 walker 的分支表本身就是这条边界的文档。
 *
 * ## 刻意不下钻的地方
 *
 * - **`code-block` / `raw` / `block-math`**：围栏里的 `![](x)` 是示例代码，不是引用。
 * - **`table`**：Source 模式下表格是原文，表格列靠字符对齐；在单元格里塞一张图会把
 *   整张表撑歪。Visual 模式有 `TableBlockWidget` 兜这件事，这里没有。
 * - **`link`**：`[![alt](img)](url)` 里只渲染内层图片，会在源码里留下半条链接
 *   （`[<img>](url)`）—— 渲染一半比完全不渲染更让人看不懂。整条保持原文。
 *
 * 其余（`bold` / `italic` / `strike` 这些**格式包装**）照常下钻：`**![](x)**` 里的图片
 * 是货真价实的引用。
 */
import { RangeSetBuilder, StateField, type EditorSelection, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import {
  parseMarkdown,
  type MarkdownBlockNode,
  type MarkdownInlineNode,
  type MarkdownListItem
} from '@nexus/markdown';
import { ImageWidget } from './inline-edit.js';
import { isEditorComposing, setComposingEffect } from './ime-composition.js';
import {
  EMPTY_WORKSPACE_ASSETS,
  documentDirectoryField,
  visualFocusField,
  visualFocusPlugin,
  workspaceAssetsField,
  type WorkspaceAssetEntry
} from './visual/state.js';
import {
  isEmbeddableImage,
  lineStartAt,
  obsidianEmbedStart,
  parseEmbedWidth,
  resolveDocumentAssetUrl,
  resolveWikiEmbedAssetUrl
} from './visual/source-analysis.js';

interface ProjectionRange {
  from: number;
  to: number;
  decoration: Decoration;
}

/** 会被下钻的块级容器。其余块类型（代码块 / 表格 / 原始块…）到此为止。 */
const CONTAINER_BLOCKS = new Set(['heading', 'paragraph', 'blockquote', 'list']);

/** 列表项里既不是容器、也不是行内节点的子项。它们各自都是不透明块。 */
const NON_INLINE_BLOCKS = new Set([
  'code-block',
  'table',
  'block-math',
  'raw',
  'horizontal-rule'
]);

/**
 * 构建 Source surface 的图片装饰集。
 *
 * 与 Visual 投影同一条揭示契约：光标**严格落在**图片节点范围内部时不替换，源文本
 * 原样可见可编辑（见 `isNodeRevealed` 的说明）。差别只在 Source 模式里没有别的投影，
 * 所以揭示态只加一层 mark 让人看出「这一段是图片引用」。
 */
export function buildSourceImageProjection(
  source: string,
  selection: EditorSelection | null = null,
  isFocused: boolean = false,
  documentDirectory: string | null = null,
  workspaceAssets: readonly WorkspaceAssetEntry[] = EMPTY_WORKSPACE_ASSETS
): DecorationSet {
  const ranges: ProjectionRange[] = [];
  const { root } = parseMarkdown(source);

  const selFrom = selection ? Math.min(selection.main.anchor, selection.main.head) : -1;
  const selTo = selection ? Math.max(selection.main.anchor, selection.main.head) : -1;

  function isNodeRevealed(from: number, to: number): boolean {
    if (!isFocused || !selection || selFrom === -1) return false;
    if (selFrom === selTo) return selFrom > from && selTo < to;
    return selFrom < to && selTo > from;
  }

  function pushImageSourceMark(from: number, to: number): void {
    ranges.push({
      from,
      to,
      decoration: Decoration.mark({ class: 'cm-visual-image-source' })
    });
  }

  function walkInline(inlineNode: MarkdownInlineNode): void {
    if (inlineNode.type === 'image') {
      const { from, to } = inlineNode.range;
      const raw = inlineNode.raw;
      const alt = inlineNode.alt;
      const safeSrc = inlineNode.safeSrc;
      const isBlocked = Boolean(inlineNode.isBlocked);
      const title = inlineNode.title;
      const displaySrc = isBlocked
        ? null
        : resolveDocumentAssetUrl(inlineNode.src, documentDirectory);
      const buildWidget = (alongsideSource: boolean) =>
        new ImageWidget({ from, to, raw, alt, safeSrc, isBlocked, title, displaySrc, alongsideSource });

      // 揭示态：源码是真实文本（`pushImageSourceMark` 只加底纹、不替换），
      // 图片另外插一份 —— 于是「图片 + 源码」同时在场，改地址时看得见效果。
      // 插在**行首**：插在节点原位的话，块级预览会把行中图片所在那一行劈成三行。
      if (isNodeRevealed(from, to)) {
        const previewPos = lineStartAt(source, from);
        ranges.push({
          from: previewPos,
          to: previewPos,
          decoration: Decoration.widget({ side: -1, widget: buildWidget(true) })
        });
        pushImageSourceMark(from, to);
        return;
      }
      ranges.push({
        from,
        to,
        decoration: Decoration.replace({ widget: buildWidget(false) })
      });
      return;
    }

    if (inlineNode.type === 'wikilink') {
      const embedStart = obsidianEmbedStart(source, inlineNode.range.from);
      if (embedStart === null || !isEmbeddableImage(inlineNode.target)) return;
      const embedTo = inlineNode.range.to;
      const embedTarget = inlineNode.target;
      const embedDisplaySrc = resolveWikiEmbedAssetUrl(
        embedTarget,
        documentDirectory,
        workspaceAssets
      );
      const embedWidth = parseEmbedWidth(inlineNode.alias);
      const buildEmbedWidget = (alongsideSource: boolean) =>
        new ImageWidget({
          from: inlineNode.range.from,
          to: embedTo,
          raw: source.slice(embedStart, embedTo),
          alt: embedTarget,
          safeSrc: null,
          // 与 Visual 面同一条规矩：嵌入走回退链（工作区根相对 → 文件名兜底 → 文档目录
          // 保底），`![](…)` 才是单档的文档目录相对。
          displaySrc: embedDisplaySrc,
          width: embedWidth,
          isEmbed: true,
          wikilinkTarget: embedTarget,
          alongsideSource
        });

      if (isNodeRevealed(inlineNode.range.from, embedTo)) {
        const previewPos = lineStartAt(source, embedStart);
        ranges.push({
          from: previewPos,
          to: previewPos,
          decoration: Decoration.widget({ side: -1, widget: buildEmbedWidget(true) })
        });
        pushImageSourceMark(embedStart, embedTo);
        return;
      }
      ranges.push({
        from: embedStart,
        to: embedTo,
        decoration: Decoration.replace({ widget: buildEmbedWidget(false) })
      });
      return;
    }

    if (
      inlineNode.type === 'bold' ||
      inlineNode.type === 'italic' ||
      inlineNode.type === 'strike'
    ) {
      for (const child of inlineNode.children) {
        walkInline(child);
      }
    }
  }

  function walkBlock(blockNode: MarkdownBlockNode): void {
    if (blockNode.type === 'heading' || blockNode.type === 'paragraph') {
      for (const child of blockNode.children) {
        walkInline(child);
      }
      return;
    }
    if (blockNode.type === 'blockquote') {
      for (const child of blockNode.children) {
        walkBlock(child);
      }
      return;
    }
    if (blockNode.type === 'list') {
      for (const item of blockNode.items) {
        walkListItem(item);
      }
    }
  }

  function walkListItem(item: MarkdownListItem): void {
    for (const child of item.children) {
      if (CONTAINER_BLOCKS.has(child.type)) {
        walkBlock(child as MarkdownBlockNode);
      } else if (!NON_INLINE_BLOCKS.has(child.type)) {
        walkInline(child as MarkdownInlineNode);
      }
    }
  }

  for (const block of root.children) {
    walkBlock(block);
  }

  // 与 Visual 投影同一条硬契约：RangeSetBuilder 要求 (from, startSide) 升序。
  // 同一 from 上 mark 的 startSide 大于 replace，所以 mark 必须排在 replace 之后。
  ranges.sort(
    (left, right) =>
      left.from - right.from || left.decoration.startSide - right.decoration.startSide
  );
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) {
    if (range.from <= range.to) {
      builder.add(range.from, range.to, range.decoration);
    }
  }
  return builder.finish();
}

/** Source surface 的图片投影字段。重算条件与 `visualProjectionField` 对齐。 */
export const sourceImageProjectionField = StateField.define<DecorationSet>({
  create(state) {
    return buildSourceImageProjection(
      state.doc.toString(),
      state.selection,
      state.field(visualFocusField, false) ?? false,
      state.field(documentDirectoryField, false) ?? null,
      state.field(workspaceAssetsField, false) ?? EMPTY_WORKSPACE_ASSETS
    );
  },
  update(decorations, transaction) {
    const isFocused = transaction.state.field(visualFocusField, false) ?? false;
    const docDir = transaction.state.field(documentDirectoryField, false) ?? null;
    const assets = transaction.state.field(workspaceAssetsField, false) ?? EMPTY_WORKSPACE_ASSETS;
    const prevFocused = transaction.startState.field(visualFocusField, false) ?? false;
    const prevDocDir = transaction.startState.field(documentDirectoryField, false) ?? null;
    const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
    // 清单在没变时返回同一个引用（`workspaceAssetsField` 只在注入时换值），身份比较就够。
    const assetsChanged =
      assets !== (transaction.startState.field(workspaceAssetsField, false) ?? EMPTY_WORKSPACE_ASSETS);

    if (
      transaction.docChanged ||
      isFocused !== prevFocused ||
      docDir !== prevDocDir ||
      assetsChanged ||
      selectionChanged ||
      transaction.effects.some((e) => e.is(setComposingEffect) && !e.value)
    ) {
      if (isEditorComposing(transaction.state)) {
        return decorations.map(transaction.changes);
      }
      return buildSourceImageProjection(
        transaction.state.doc.toString(),
        transaction.state.selection,
        isFocused,
        docDir,
        assets
      );
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

/**
 * Source surface 的图片投影扩展。
 *
 * 焦点字段与 Visual 模式共用：揭示判据要求「聚焦且光标在范围内部」，没有焦点字段
 * 就没法区分「光标停在图片里」与「窗口根本没聚焦」。
 */
export const sourceImageProjectionExtensions: Extension[] = [
  visualFocusField,
  visualFocusPlugin,
  documentDirectoryField,
  workspaceAssetsField,
  sourceImageProjectionField
];
