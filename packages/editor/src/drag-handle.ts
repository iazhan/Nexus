import {
  StateField,
  RangeSetBuilder,
  type Extension,
  EditorSelection,
  StateEffect,
  Facet
} from '@codemirror/state';
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
  createReorderBlockToPositionTransaction
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
    public readonly isReadOnly: boolean
  ) {
    super();
  }

  public toDOM(): HTMLElement {
    const handle = document.createElement('span');
    handle.className = 'cm-visual-drag-handle';
    if (this.isReadOnly) {
      handle.classList.add('disabled');
      handle.setAttribute('aria-disabled', 'true');
    }
    handle.setAttribute('role', 'button');
    handle.setAttribute('aria-label', 'Drag to reorder block');
    handle.setAttribute('title', 'Drag to reorder block');
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
      other.isReadOnly === this.isReadOnly
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
  isReadOnly: boolean
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
        widget: new DragHandleWidget(b.from, b.to, isReadOnly),
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
    return buildDragHandleDecorations(state.doc.toString(), state.readOnly);
  },
  update(decorations, transaction) {
    const prevReadOnly = transaction.startState.readOnly;
    const nextReadOnly = transaction.state.readOnly;
    if (!transaction.docChanged && prevReadOnly === nextReadOnly) {
      return decorations;
    }
    return buildDragHandleDecorations(transaction.state.doc.toString(), nextReadOnly);
  },
  provide: (field) => EditorView.decorations.from(field)
});

/**
 * 设置/清除放置指示器位置的状态效果。
 */
export const setDropIndicatorEffect = StateEffect.define<number | null>();

/**
 * 放置指示器 StateField，在放置目标行显示 .cm-visual-drop-target 顶边蓝线。
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
        const line = tr.state.doc.lineAt(effect.value);
        return Decoration.set([
          Decoration.line({ class: 'cm-visual-drop-target' }).range(line.from)
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
 * 传递 MarkdownDocumentSession 到 CodeMirror State 的 Facet。
 */
export const sessionFacet = Facet.define<MarkdownDocumentSession, MarkdownDocumentSession | null>({
  combine: (values) => values[0] ?? null
});

export interface DragTarget {
  pos: number;
  targetFrom: number;
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

  return {
    pos: candidatePos,
    targetFrom: targetCtx.node.range.from
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
  targetPos: number | null;
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

      this.activeSession = {
        pointerId: event.pointerId,
        handleElement: handleEl,
        sourcePos: from,
        sourceRange: {
          from: sourceCtx.node.range.from,
          to: getContentEnd(source, sourceCtx.node.range)
        },
        startedRevision: snapshot.revision,
        startedSource: snapshot.source,
        startedSelection: snapshot.selection,
        targetPos: null,
        view: this.view
      };

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

      if (target !== null) {
        session.targetPos = target.targetFrom;
        this.view.dispatch({ effects: setDropIndicatorEffect.of(target.targetFrom) });
      } else {
        session.targetPos = null;
        this.view.dispatch({ effects: setDropIndicatorEffect.of(null) });
      }
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
      let dropTargetPos = savedSession.targetPos;

      if (dropTargetPos === null) {
        const resolved = resolveDragTarget(
          this.view,
          event,
          savedSession.sourcePos,
          savedSession.handleElement,
          source
        );
        if (resolved) {
          dropTargetPos = resolved.targetFrom;
        }
      }

      if (dropTargetPos === null || dropTargetPos === savedSession.sourcePos) {
        return;
      }

      const tx = createReorderBlockToPositionTransaction(
        source,
        savedSession.sourcePos,
        dropTargetPos,
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
      this.view.dispatch({ effects: setDropIndicatorEffect.of(null) });
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
    session ? sessionFacet.of(session) : [],
    visualDragPlugin
  ];
}

/**
 * Visual Surface 专属块拖拽手柄与 PointerEvent 扩展常量（默认无 session 绑定）。
 */
export const visualDragExtension: Extension = createVisualDragExtension();
