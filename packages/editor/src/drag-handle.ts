import {
  StateField,
  RangeSetBuilder,
  type Extension,
  type Text,
  EditorSelection,
  StateEffect,
  Facet
} from '@codemirror/state';
import { translate } from '@nexus/i18n';
import { editorLocaleFacet } from './source-editor.js';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view';
import {
  parseMarkdown,
  type MarkdownBlockNode,
  type MarkdownListItem,
  type MarkdownRoot
} from '@nexus/markdown';
import {
  findDeepestBlockAtPos,
  getContentEnd,
  createReorderBlockToPositionTransaction,
  type DropSide
} from './edit-transactions.js';
import type { MarkdownDocumentSession } from './document-session.js';
import type { MarkdownSelection } from './types.js';

/**
 * Visual Surface 专属块拖拽手柄 Widget。
 *
 * 位于每个可编辑 block 的起始位置之前（side: -1），不占位、不污染正文。
 * 具备 aria-label、role="button"、title 等无障碍语义。
 * 纯 DOM 构建，严禁使用 innerHTML。
 */
export class DragHandleWidget extends WidgetType {
  public constructor(
    public readonly blockFrom: number,
    public readonly blockTo: number,
    public readonly isReadOnly: boolean,
    /** 文案依赖语言：进 eq() 才能让运行时切语言时重建 DOM，而不是留着旧文案。 */
    public readonly locale: string
  ) {
    super();
  }

  public toDOM(): HTMLElement {
    const label = translate(this.locale, 'editor.dragHandle');
    const handle = document.createElement('span');
    handle.className = 'cm-visual-drag-handle';
    if (this.isReadOnly) {
      handle.classList.add('disabled');
      handle.setAttribute('aria-disabled', 'true');
    }
    handle.setAttribute('role', 'button');
    handle.setAttribute('aria-label', label);
    handle.setAttribute('title', label);
    handle.setAttribute('tabindex', '-1');
    handle.dataset.blockFrom = String(this.blockFrom);
    handle.dataset.blockTo = String(this.blockTo);

    // SVG 6 点抓取图标 (grip-vertical) - 严格使用 createElementNS，零 innerHTML
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 10 16');
    icon.setAttribute('width', '10');
    icon.setAttribute('height', '16');
    icon.setAttribute('fill', 'currentColor');
    icon.setAttribute('aria-hidden', 'true');

    const circles = [
      [2, 3],
      [2, 8],
      [2, 13],
      [7, 3],
      [7, 8],
      [7, 13]
    ];
    for (const [cx, cy] of circles) {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', '1.5');
      icon.appendChild(circle);
    }
    handle.appendChild(icon);

    return handle;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof DragHandleWidget &&
      other.blockFrom === this.blockFrom &&
      other.blockTo === this.blockTo &&
      other.isReadOnly === this.isReadOnly &&
      other.locale === this.locale
    );
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

interface DraggableBlock {
  from: number;
  to: number;
}

function isBlockNode(node: unknown): node is MarkdownBlockNode {
  if (!node || typeof node !== 'object') return false;
  const t = (node as { type?: string }).type;
  return (
    t === 'paragraph' ||
    t === 'heading' ||
    t === 'blockquote' ||
    t === 'list' ||
    t === 'code-block' ||
    t === 'table' ||
    t === 'block-math' ||
    t === 'raw' ||
    t === 'horizontal-rule'
  );
}

/**
 * 遍历 Markdown AST，提取所有最深层可编辑 block 及 list item 的位置范围。
 */
export function collectDraggableBlocks(root: MarkdownRoot, source: string): DraggableBlock[] {
  const blocks: DraggableBlock[] = [];

  function walk(node: MarkdownBlockNode | MarkdownListItem) {
    if (node.type === 'blockquote') {
      for (const child of node.children) {
        walk(child);
      }
      return;
    }

    if (node.type === 'list') {
      for (const item of node.items) {
        walk(item);
      }
      return;
    }

    if (node.type === 'list-item') {
      const childBlocks = node.children.filter(isBlockNode);
      if (childBlocks.length > 0) {
        for (const cb of childBlocks) {
          walk(cb);
        }
      } else {
        const lastChild = node.children[node.children.length - 1];
        const to = lastChild ? getContentEnd(source, lastChild.range) : getContentEnd(source, node.range);
        blocks.push({
          from: node.range.from,
          to
        });
      }
      return;
    }

    // 叶子块（paragraph, heading, code-block, table, block-math, raw 等）
    if (node.type === 'code-block') {
      const lineStart = source.lastIndexOf('\n', node.range.from - 1) + 1;
      const isQuote = /^[ \t]*(?:>[ \t]*)+$/.test(source.slice(lineStart, node.range.from));
      blocks.push({
        from: isQuote ? lineStart : node.range.from,
        to: getContentEnd(source, node.range)
      });
      return;
    }

    blocks.push({
      from: node.range.from,
      to: getContentEnd(source, node.range)
    });
  }

  for (const child of root.children) {
    walk(child);
  }

  return blocks;
}

/**
 * 构建 Visual Surface 的拖拽手柄 DecorationSet。
 */
export function buildDragHandleDecorations(
  source: string,
  isReadOnly: boolean,
  locale: string
): DecorationSet {
  const { root } = parseMarkdown(source);
  const blocks = collectDraggableBlocks(root, source);
  blocks.sort((a, b) => a.from - b.from || a.to - b.to);

  const builder = new RangeSetBuilder<Decoration>();
  for (const b of blocks) {
    builder.add(
      b.from,
      b.from,
      Decoration.widget({
        widget: new DragHandleWidget(b.from, b.to, isReadOnly, locale),
        side: -1
      })
    );
  }

  return builder.finish();
}

/**
 * 拖拽手柄的 StateField：自动随文档变更及 readOnly 状态变更更新手柄 decorations。
 */
export const visualDragHandleField = StateField.define<DecorationSet>({
  create(state) {
    return buildDragHandleDecorations(
      state.doc.toString(),
      state.readOnly,
      state.facet(editorLocaleFacet)
    );
  },
  update(decorations, transaction) {
    const prevReadOnly = transaction.startState.readOnly;
    const nextReadOnly = transaction.state.readOnly;
    // 语言变了也要重建：手柄的 aria-label / title 走 i18n
    const locale = transaction.state.facet(editorLocaleFacet);
    const localeChanged = locale !== transaction.startState.facet(editorLocaleFacet);
    if (!transaction.docChanged && prevReadOnly === nextReadOnly && !localeChanged) {
      return decorations;
    }
    return buildDragHandleDecorations(
      transaction.state.doc.toString(),
      nextReadOnly,
      locale
    );
  },
  provide: (field) => EditorView.decorations.from(field)
});

/**
 * 放置指示器的载荷：目标块的首末位置 + 落在它的哪一侧。
 *
 * 传**块**而不是一个位置，是因为指示线要落在「块与块之间的边界」上，而那条边界可能
 * 落在块顶、块底、或者紧邻的那条空行里 —— 由 `resolveDropIndicatorLine` 统一算出来。
 */
export interface DropIndicator {
  blockFrom: number;
  blockTo: number;
  side: DropSide;
}

export const setDropIndicatorEffect = StateEffect.define<DropIndicator | null>();

/** 指示线装饰哪一行，以及画在这一行的哪个方位。 */
type DropIndicatorPlacement = { pos: number; where: 'top' | 'bottom' | 'mid' };

/**
 * 把「目标块 + 侧别」解析成「装饰哪一行、画在什么方位」。
 *
 * 边界两侧都是块正文时线贴边画（`before` 画目标块首行顶边、`after` 画末行底边）；
 * **有一侧是空行时一律画在那条空行的正中**。后半条不是美化：`after 块 A` 与 `before 块 B`
 * 在 A、B 之间有空行时是**同一个插入位**（移动语义下结果完全相同），若各自贴边画，
 * 线会在两行之间跳 20 多像素，看起来像两个不同的落点。
 */
function resolveDropIndicatorLine(doc: Text, target: DropIndicator): DropIndicatorPlacement {
  const firstLine = doc.lineAt(target.blockFrom);
  // `blockTo` 是**内容末尾之后**那一位（`getContentEnd` 剥掉了尾随换行），所以它可能正好落在
  // 换行符上 —— 而那个位置归属哪一行是有歧义的。往回一位取最后一个内容字符，落点就确定了。
  const lastLine = doc.lineAt(Math.max(target.blockFrom, target.blockTo - 1));

  if (target.side === 'before') {
    if (firstLine.number > 1) {
      const previous = doc.line(firstLine.number - 1);
      if (previous.text.trim() === '') {
        return { pos: previous.from, where: 'mid' };
      }
    }
    return { pos: firstLine.from, where: 'top' };
  }

  if (lastLine.number < doc.lines) {
    const next = doc.line(lastLine.number + 1);
    if (next.text.trim() === '') {
      return { pos: next.from, where: 'mid' };
    }
  }
  return { pos: lastLine.from, where: 'bottom' };
}

/**
 * 放置指示器 StateField，在边界那一行画 `.cm-visual-drop-target` 蓝线。
 *
 * 方位类名三个：`-top` / `-bottom` / `-mid`（判据见 `resolveDropIndicatorLine`）。
 * 逐行 `Decoration.line` 而不是跨行 mark —— 同源块高亮那条理由。
 */
export const visualDropIndicatorField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDropIndicatorEffect)) {
        if (effect.value === null) {
          return Decoration.none;
        }
        const placement = resolveDropIndicatorLine(tr.state.doc, effect.value);
        return Decoration.set([
          Decoration.line({
            class: `cm-visual-drop-target cm-visual-drop-target-${placement.where}`
          }).range(placement.pos)
        ]);
      }
    }
    if (tr.docChanged || tr.state.readOnly) {
      return Decoration.none;
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

/**
 * 设置/清除「正在拖动的源块」范围的状态效果。
 */
export const setDragSourceEffect = StateEffect.define<{ from: number; to: number } | null>();

/**
 * 源块高亮 StateField：拖动期间给源块覆盖的**每一行**加 `.cm-visual-drag-source`。
 *
 * 只负责「源块自己长什么样」—— 它是被拿起来的那个，所以整体压暗；
 * 落到哪里由 `visualDropIndicatorField` 画。
 *
 * 逐行 `Decoration.line` 而不是一个跨行 `Decoration.mark`：跨行 mark 只给**有字符的行**
 * 生成 span，块内的空行拿不到，高亮会断成几截（同 `.cm-marker-block-math-band` 那条）。
 */
export const visualDragSourceField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDragSourceEffect)) {
        if (effect.value === null) {
          return Decoration.none;
        }
        const { from, to } = effect.value;
        const builder = new RangeSetBuilder<Decoration>();
        let pos = from;
        for (;;) {
          const line = tr.state.doc.lineAt(pos);
          builder.add(line.from, line.from, Decoration.line({ class: 'cm-visual-drag-source' }));
          if (line.to >= to) break;
          pos = line.to + 1;
        }
        return builder.finish();
      }
    }
    // 文档一变或转只读，源块范围就失效了（与放置指示器同一条兜底）。
    if (tr.docChanged || tr.state.readOnly) {
      return Decoration.none;
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

/**
 * 传递 MarkdownDocumentSession 到 CodeMirror State 的 Facet。
 */
export const sessionFacet = Facet.define<MarkdownDocumentSession, MarkdownDocumentSession | null>({
  combine: (values) => values[0] ?? null
});

export interface DragTarget {
  pos: number;
  targetFrom: number;
  targetTo: number;
  side: DropSide;
}

/**
 * 指针落在目标块的哪一半 —— 上半 = `before`（插到它前面），下半 = `after`（插到它后面）。
 *
 * 分界取**整块**的垂直中点（首行 top 与末行 bottom 的中间），不是某一行的中点：
 * 多行块（代码块、松列表项）里指针在行间上下移时，用行中点会让 side 来回抖。
 *
 * 量不出几何时（块没被布局过）取 `after`。这个兜底只在拿不到布局的场合生效 ——
 * 目标块能被指针命中就说明它在视口里，正常浏览器里 `coordsAtPos` 不会失败。
 * 取 `after` 而不是 `before`：**「拖到某一块上 ⇒ 落到它下面」这个方向必须能成事**，
 * 兜底成 `before` 会把它悄悄变成空操作（源块本来就在目标块前面）。
 */
function resolveDropSide(
  view: EditorView,
  event: PointerEvent,
  from: number,
  to: number
): DropSide {
  const head = view.coordsAtPos(from);
  const tail = view.coordsAtPos(to);
  if (!head || !tail) return 'after';
  return event.clientY < (head.top + tail.bottom) / 2 ? 'before' : 'after';
}

/**
 * 真实 Pointer Capture / 非捕获场景下的拖拽放置目标解析 Helper。
 *
 * 解析优先级：
 * 1. 非 Pointer Capture 场景：如果 event.target 是非源手柄的 .cm-visual-drag-handle，读取其 blockFrom；
 * 2. Pointer Capture 场景：使用 document.elementFromPoint(clientX, clientY) 查找指针物理位置下的元素；
 *    - 如果该元素或其祖先是 .cm-visual-drag-handle 且不是源手柄，读取其 blockFrom；
 * 3. 使用 view.posAtCoords({ x: clientX, y: clientY }) 解析坐标处的文档偏移；
 * 4. 将候选位置交由 AST findDeepestBlockAtPos 进行语义判定；
 * 5. 校验目标块有效性：必须存在、必须落在实质块内容上（不得落在 gap/空行/边界）、必须与源块同属一个直接父容器且不能是源块自身；
 * 6. 校验通过返回目标信息，否则返回 null。严禁全文正则或文本匹配。
 */
export function resolveDragTarget(
  view: EditorView,
  event: PointerEvent,
  sourcePos: number,
  sourceHandle: HTMLElement | null,
  source: string
): DragTarget | null {
  const { root } = parseMarkdown(source);
  const sourceCtx = findDeepestBlockAtPos(root, sourcePos, source);
  if (!sourceCtx) return null;

  let candidatePos: number | null = null;

  // 1. 若 event.target 是除源手柄以外的 drag handle
  const directTargetEl = (event.target as HTMLElement | null)?.closest?.(
    '.cm-visual-drag-handle'
  ) as HTMLElement | null;
  if (directTargetEl && directTargetEl !== sourceHandle && directTargetEl.dataset.blockFrom !== undefined) {
    candidatePos = Number(directTargetEl.dataset.blockFrom);
  }

  // 2. 否则使用 document.elementFromPoint
  if (candidatePos === null && typeof document !== 'undefined' && typeof document.elementFromPoint === 'function') {
    const elUnderPointer = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    if (elUnderPointer) {
      const handleUnder = elUnderPointer.closest?.('.cm-visual-drag-handle') as HTMLElement | null;
      if (handleUnder && handleUnder !== sourceHandle && handleUnder.dataset.blockFrom !== undefined) {
        candidatePos = Number(handleUnder.dataset.blockFrom);
      }
    }
  }

  // 3. 否则使用 view.posAtCoords
  if (candidatePos === null) {
    const coordsPos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (coordsPos !== null) {
      candidatePos = coordsPos;
    }
  }

  if (candidatePos === null) return null;

  // 4. 将候选位置交由 AST 判定
  const targetCtx = findDeepestBlockAtPos(root, candidatePos, source);
  if (!targetCtx) return null;

  // 5. 校验容器与自身（同一直接父容器，且不是同一块）
  if (targetCtx.parent !== sourceCtx.parent) return null;
  if (targetCtx.node === sourceCtx.node || targetCtx.index === sourceCtx.index) return null;

  const targetFrom = targetCtx.node.range.from;
  const targetTo = getContentEnd(source, targetCtx.node.range);

  return {
    pos: candidatePos,
    targetFrom,
    targetTo,
    side: resolveDropSide(view, event, targetFrom, targetTo)
  };
}

interface ActiveDragSession {
  pointerId: number;
  handleElement: HTMLElement;
  sourcePos: number;
  sourceRange: { from: number; to: number };
  startedRevision: number;
  startedSource: string;
  startedSelection: MarkdownSelection;
  target: DragTarget | null;
  view: EditorView;
}

/**
 * PointerEvent 拖拽生命周期 ViewPlugin。
 *
 * 实例级隔离：每个 Visual Surface 独立维护自身的拖拽会话与监听器。
 */
class VisualDragPluginValue {
  readonly cleanups: (() => void)[] = [];
  windowCleanup: (() => void) | null = null;
  public activeSession: ActiveDragSession | null = null;

  public constructor(public readonly view: EditorView) {
    const onPointerDown = (event: PointerEvent) => {
      if (this.view.state.readOnly) return;
      const handleEl = (event.target as HTMLElement | null)?.closest?.(
        '.cm-visual-drag-handle'
      ) as HTMLElement | null;
      if (!handleEl) return;

      const session = this.session;
      if (!session) return;

      event.preventDefault();
      if (typeof handleEl.setPointerCapture === 'function') {
        try {
          handleEl.setPointerCapture(event.pointerId);
        } catch {
          // Ignore
        }
      }

      const from = Number(handleEl.dataset.blockFrom);
      const snapshot = session.getSnapshot();
      const source = snapshot.source;
      const { root } = parseMarkdown(source);
      const sourceCtx = findDeepestBlockAtPos(root, from, source);
      if (!sourceCtx) return;

      handleEl.classList.add('is-dragging');

      const sourceRange = {
        from: sourceCtx.node.range.from,
        to: getContentEnd(source, sourceCtx.node.range)
      };

      this.activeSession = {
        pointerId: event.pointerId,
        handleElement: handleEl,
        sourcePos: from,
        sourceRange,
        startedRevision: snapshot.revision,
        startedSource: snapshot.source,
        startedSelection: snapshot.selection,
        target: null,
        view: this.view
      };

      // 源块高亮**只在这里设一次** —— 它不随指针移动而变，放进 pointermove 是白跑。
      this.view.dispatch({
        effects: setDragSourceEffect.of({ from: sourceRange.from, to: sourceRange.to })
      });

      this.setupWindowListeners();
    };

    this.view.dom.addEventListener('pointerdown', onPointerDown);
    this.cleanups.push(() => {
      this.view.dom.removeEventListener('pointerdown', onPointerDown);
    });
  }

  private get session(): MarkdownDocumentSession | null {
    return this.view.state.facet(sessionFacet);
  }

  private validateDragSession(dragSession: ActiveDragSession): boolean {
    if (!this.session) return false;
    if (this.view.state.readOnly) return false;

    const currentSnapshot = this.session.getSnapshot();
    if (currentSnapshot.revision !== dragSession.startedRevision) {
      return false;
    }
    if (currentSnapshot.source !== dragSession.startedSource) {
      return false;
    }

    const { root } = parseMarkdown(currentSnapshot.source);
    const currentSourceCtx = findDeepestBlockAtPos(root, dragSession.sourcePos, currentSnapshot.source);
    if (!currentSourceCtx) {
      return false;
    }
    const currentEnd = getContentEnd(currentSnapshot.source, currentSourceCtx.node.range);
    if (
      currentSourceCtx.node.range.from !== dragSession.sourceRange.from ||
      currentEnd !== dragSession.sourceRange.to
    ) {
      return false;
    }

    return true;
  }

  setupWindowListeners() {
    const onPointerMove = (event: PointerEvent) => {
      const session = this.activeSession;
      if (!session || session.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();

      if (!this.validateDragSession(session)) {
        this.cleanupDragSession();
        return;
      }

      const source = this.session!.getSnapshot().source;
      const target = resolveDragTarget(this.view, event, session.sourcePos, session.handleElement, source);

      session.target = target;
      this.view.dispatch({
        effects: setDropIndicatorEffect.of(
          target
            ? { blockFrom: target.targetFrom, blockTo: target.targetTo, side: target.side }
            : null
        )
      });
    };

    const onPointerUp = (event: PointerEvent) => {
      const session = this.activeSession;
      if (!session || session.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();

      const valid = this.validateDragSession(session);
      const savedSession = session;
      this.cleanupDragSession();

      if (!valid || this.view.state.readOnly) {
        return;
      }

      const source = this.session!.getSnapshot().source;
      let target = savedSession.target;

      if (target === null) {
        target = resolveDragTarget(
          this.view,
          event,
          savedSession.sourcePos,
          savedSession.handleElement,
          source
        );
      }

      if (target === null || target.targetFrom === savedSession.sourcePos) {
        return;
      }

      const tx = createReorderBlockToPositionTransaction(
        source,
        savedSession.sourcePos,
        target.targetFrom,
        target.side,
        savedSession.startedSelection
      );

      if (!tx) return;

      this.view.dispatch({
        changes: tx.changes,
        selection: tx.selection
          ? EditorSelection.single(tx.selection.anchor, tx.selection.head)
          : undefined,
        userEvent: tx.userEvent ?? 'block.reorder'
      });
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (this.activeSession && this.activeSession.pointerId === event.pointerId) {
        this.cleanupDragSession();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.cleanupDragSession();
      }
    };

    const onBlur = () => {
      this.cleanupDragSession();
    };

    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur, true);

    this.windowCleanup = () => {
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerCancel, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur, true);
    };
  }

  cleanupDragSession(dispatchEffect = true) {
    if (this.activeSession) {
      const session = this.activeSession;
      if (typeof session.handleElement.releasePointerCapture === 'function') {
        try {
          session.handleElement.releasePointerCapture(session.pointerId);
        } catch {
          // Ignore
        }
      }
      session.handleElement.classList.remove('is-dragging');
      this.activeSession = null;
    }
    if (this.windowCleanup) {
      this.windowCleanup();
      this.windowCleanup = null;
    }
    if (dispatchEffect) {
      // 两个一起清：源块高亮与放置指示器是同一次拖动的两端，留一个下来就是幽灵状态。
      this.view.dispatch({
        effects: [setDropIndicatorEffect.of(null), setDragSourceEffect.of(null)]
      });
    }
  }

  public update(update: ViewUpdate) {
    if (
      this.activeSession &&
      (update.view.state.readOnly || update.docChanged)
    ) {
      this.cleanupDragSession(false);
    }
  }

  public destroy() {
    this.cleanupDragSession(false);
    for (const cleanup of this.cleanups) {
      cleanup();
    }
  }
}

/**
 * PointerEvent 拖拽生命周期 ViewPlugin。
 *
 * 管理 pointerdown、pointermove、pointerup、pointercancel 及 Escape 取消流程。
 */
export const visualDragPlugin = ViewPlugin.fromClass(VisualDragPluginValue);

/**
 * 构建 Visual Surface 专属块拖拽与指示器扩展。
 */
export function createVisualDragExtension(session?: MarkdownDocumentSession): Extension {
  return [
    visualDragHandleField,
    visualDropIndicatorField,
    visualDragSourceField,
    session ? sessionFacet.of(session) : [],
    visualDragPlugin
  ];
}

/**
 * Visual Surface 专属块拖拽手柄与 PointerEvent 扩展常量（默认无 session 绑定）。
 */
export const visualDragExtension: Extension = createVisualDragExtension();
