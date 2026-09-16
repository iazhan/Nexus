// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest';
import {
  MarkdownDocumentSession,
  createSessionEditorView,
  readOnlyCompartment,
  EditorState
} from '../src/index.js';

// Polyfill PointerEvent and pointer capture in happy-dom if needed
if (typeof globalThis.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    public pointerId: number;
    public pointerType: string;
    public isPrimary: boolean;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 1;
      this.pointerType = params.pointerType ?? 'mouse';
      this.isPrimary = params.isPrimary ?? true;
    }
  }
  globalThis.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

export const capturedPointers = new Map<number, Element>();
Element.prototype.setPointerCapture = function (pointerId: number) {
  capturedPointers.set(pointerId, this);
};
Element.prototype.releasePointerCapture = function (pointerId: number) {
  capturedPointers.delete(pointerId);
};

describe('Block Drag Handle UI & PointerEvent Drag/Drop Integration', () => {
  let parent: HTMLDivElement;

  beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
    return () => {
      document.body.removeChild(parent);
    };
  });

  // 1. Visual Surface renders drag handles
  it('renders drag handles on Visual Surface with accessible attributes', () => {
    const source = '# Heading\n\nParagraph text\n\n- List item';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual-handles',
      surfaceKind: 'visual'
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    expect(handles.length).toBeGreaterThanOrEqual(3);

    for (const h of handles) {
      expect(h.getAttribute('aria-label')).toBe('Drag to reorder block');
      expect(h.getAttribute('role')).toBe('button');
      expect(h.getAttribute('title')).toBe('Drag to reorder block');
    }

    handle.destroy();
  });

  // 2. Non-visual (Source) Surface does NOT render drag handles
  it('does NOT render drag handles on Source Surface', () => {
    const source = '# Heading\n\nParagraph text';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-source-handles',
      surfaceKind: 'source'
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    expect(handles.length).toBe(0);

    handle.destroy();
  });

  // 3. readOnly mode: drag handle is disabled or cannot initiate drag
  it('disables drag handle and rejects drag initiation in readOnly mode', () => {
    const source = '# Heading\n\nParagraph text';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-readonly-handles',
      surfaceKind: 'visual',
      readOnly: true
    });

    const dragHandle = handle.view.dom.querySelector('.cm-visual-drag-handle') as HTMLElement | null;
    expect(dragHandle).not.toBeNull();

    const downEvent = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 1
    });
    dragHandle!.dispatchEvent(downEvent);

    expect(dragHandle!.classList.contains('is-dragging')).toBe(false);
    expect(session.getSnapshot().revision).toBe(0);

    handle.destroy();
  });

  // 4. pointerdown on handle establishes drag state and prevents default
  it('establishes drag state on pointerdown and calls preventDefault', () => {
    const source = '# Heading 1\n\n# Heading 2';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-pointerdown',
      surfaceKind: 'visual'
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    const firstHandle = handles[0] as HTMLElement;

    const downEvent = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 1
    });
    firstHandle.dispatchEvent(downEvent);

    expect(downEvent.defaultPrevented).toBe(true);
    expect(firstHandle.classList.contains('is-dragging')).toBe(true);

    handle.destroy();
  });

  // 5. pointermove does not modify source or revision
  it('does NOT modify canonical source or bump revision during pointermove', () => {
    const source = '# Heading 1\n\n# Heading 2';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-pointermove',
      surfaceKind: 'visual'
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    const firstHandle = handles[0] as HTMLElement;
    const secondHandle = handles[1] as HTMLElement;

    firstHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));

    const moveEvent = new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      pointerId: 1
    });
    secondHandle.dispatchEvent(moveEvent);

    expect(session.getSnapshot().source).toBe(source);
    expect(session.getSnapshot().revision).toBe(0);

    handle.destroy();
  });

  // 6. Root container: drag adjacent blocks swaps source correctly
  it('reorders adjacent blocks in root container on drop', () => {
    const source = 'Paragraph A\n\nParagraph B';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-adjacent-drop',
      surfaceKind: 'visual'
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    const handleA = handles[0] as HTMLElement;
    const handleB = handles[1] as HTMLElement;

    handleA.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    handleB.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }));
    handleB.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));

    expect(session.getSnapshot().source).toBe('Paragraph B\n\nParagraph A');
    expect(session.getSnapshot().revision).toBe(1);

    handle.destroy();
  });

  // 7. Root container: drag non-adjacent blocks reorders correctly
  it('reorders non-adjacent blocks in root container on drop', () => {
    const source = '# 1\n\n# 2\n\n# 3';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-nonadjacent-drop',
      surfaceKind: 'visual'
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    const handle1 = handles[0] as HTMLElement;
    const handle3 = handles[2] as HTMLElement;

    handle1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    handle3.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }));
    handle3.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));

    expect(session.getSnapshot().source).toBe('# 3\n\n# 2\n\n# 1');
    expect(session.getSnapshot().revision).toBe(1);

    handle.destroy();
  });

  // 8. Reordering inside blockquote container
  it('reorders blocks within blockquote container', () => {
    const source = '> Paragraph 1\n>\n> Paragraph 2';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-quote-drop',
      surfaceKind: 'visual'
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    expect(handles.length).toBeGreaterThanOrEqual(2);
    const handle1 = handles[0] as HTMLElement;
    const handle2 = handles[1] as HTMLElement;

    handle1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    handle2.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }));
    handle2.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));

    expect(session.getSnapshot().source).toBe('> Paragraph 2\n>\n> Paragraph 1');
    expect(session.getSnapshot().revision).toBe(1);

    handle.destroy();
  });

  // 9. Reordering list items within list container
  it('reorders list items within list container', () => {
    const source = '- Item 1\n- Item 2\n- Item 3';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-list-drop',
      surfaceKind: 'visual'
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    const handle1 = handles[0] as HTMLElement;
    const handle3 = handles[2] as HTMLElement;

    handle1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    handle3.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }));
    handle3.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));

    expect(session.getSnapshot().source).toBe('- Item 3\n- Item 2\n- Item 1');
    expect(session.getSnapshot().revision).toBe(1);

    handle.destroy();
  });

  // 10. Cross-container drag/drop is a no-op
  it('does NOT reorder and is a no-op when dragging across different containers', () => {
    const source = '# Heading\n\n> Quote paragraph';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-cross-container',
      surfaceKind: 'visual'
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    const headingHandle = handles[0] as HTMLElement;
    const quoteHandle = handles[1] as HTMLElement;

    headingHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    quoteHandle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }));
    quoteHandle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));

    expect(session.getSnapshot().source).toBe(source);
    expect(session.getSnapshot().revision).toBe(0);

    handle.destroy();
  });

  // 11. Drop on original position is a no-op
  it('is a no-op when dropping on original position', () => {
    const source = '# Heading 1\n\n# Heading 2';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-drop-self',
      surfaceKind: 'visual'
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    const handle1 = handles[0] as HTMLElement;

    handle1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    handle1.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }));
    handle1.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));

    expect(session.getSnapshot().source).toBe(source);
    expect(session.getSnapshot().revision).toBe(0);

    handle.destroy();
  });

  // 12. Drop on invalid position is a no-op
  it('is a no-op when dropping on invalid position or outside editor', () => {
    const source = '# Heading 1\n\n# Heading 2';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-drop-invalid',
      surfaceKind: 'visual'
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    const handle1 = handles[0] as HTMLElement;

    handle1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));

    expect(session.getSnapshot().source).toBe(source);
    expect(session.getSnapshot().revision).toBe(0);

    handle.destroy();
  });

  // 13. pointercancel and Escape cancels drag without modifying source
  it('cancels drag on pointercancel and Escape without modifying source', () => {
    const source = '# Heading 1\n\n# Heading 2';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-drag-cancel',
      surfaceKind: 'visual'
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    const handle1 = handles[0] as HTMLElement;
    const handle2 = handles[1] as HTMLElement;

    // 13a. pointercancel
    handle1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    handle2.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }));
    handle1.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, cancelable: true, pointerId: 1 }));

    expect(handle1.classList.contains('is-dragging')).toBe(false);
    expect(session.getSnapshot().source).toBe(source);
    expect(session.getSnapshot().revision).toBe(0);

    // 13b. Escape keydown
    handle1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    handle2.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));

    expect(handle1.classList.contains('is-dragging')).toBe(false);
    expect(session.getSnapshot().source).toBe(source);
    expect(session.getSnapshot().revision).toBe(0);

    handle.destroy();
  });

  // 14. readOnly during pointerdown/move/drop does not modify source or revision
  it('does NOT modify source or revision when attempting pointerdown/move/drop in readOnly mode', () => {
    const source = 'Para 1\n\nPara 2';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-readonly-full',
      surfaceKind: 'visual',
      readOnly: true
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    const h1 = handles[0] as HTMLElement;
    const h2 = handles[1] as HTMLElement;

    h1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    h2.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }));
    h2.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));

    expect(session.getSnapshot().source).toBe(source);
    expect(session.getSnapshot().revision).toBe(0);

    handle.destroy();
  });

  // 15, 16, 17. Single revision bump, undo/redo roundtrip across dual surfaces
  it('bumps revision by exactly 1 on drop and supports undo/redo across dual surfaces', () => {
    const source = 'First paragraph\n\nSecond paragraph';
    const session = new MarkdownDocumentSession(source);

    const sourceParent = document.createElement('div');
    document.body.appendChild(sourceParent);

    const sourceSurface = createSessionEditorView({
      parent: sourceParent,
      session,
      surfaceId: 'test-dual-source',
      surfaceKind: 'source'
    });

    const visualSurface = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-dual-visual',
      surfaceKind: 'visual'
    });

    const handles = visualSurface.view.dom.querySelectorAll('.cm-visual-drag-handle');
    const h1 = handles[0] as HTMLElement;
    const h2 = handles[1] as HTMLElement;

    h1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    h2.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }));
    h2.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));

    // Revision bumped by 1
    expect(session.getSnapshot().revision).toBe(1);
    expect(session.getSnapshot().source).toBe('Second paragraph\n\nFirst paragraph');

    // Dual-surface synchronization
    expect(sourceSurface.view.state.doc.toString()).toBe('Second paragraph\n\nFirst paragraph');
    expect(visualSurface.view.state.doc.toString()).toBe('Second paragraph\n\nFirst paragraph');

    // Single undo restores pre-drag source on both surfaces
    expect(session.canUndo).toBe(true);
    session.undo();
    expect(session.getSnapshot().source).toBe(source);
    expect(sourceSurface.view.state.doc.toString()).toBe(source);
    expect(visualSurface.view.state.doc.toString()).toBe(source);

    // Redo restores post-drag source on both surfaces
    expect(session.canRedo).toBe(true);
    session.redo();
    expect(session.getSnapshot().source).toBe('Second paragraph\n\nFirst paragraph');
    expect(sourceSurface.view.state.doc.toString()).toBe('Second paragraph\n\nFirst paragraph');
    expect(visualSurface.view.state.doc.toString()).toBe('Second paragraph\n\nFirst paragraph');

    sourceSurface.destroy();
    visualSurface.destroy();
    document.body.removeChild(sourceParent);
  });

  // 18. Preserves relative selection offset inside dragged block
  it('preserves relative selection offset inside dragged block', () => {
    const source = 'First paragraph\n\nSecond paragraph';
    const cursorInFirst = 6; // 'First |paragraph'
    const session = new MarkdownDocumentSession(source, { anchor: cursorInFirst, head: cursorInFirst });

    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-sel-offset',
      surfaceKind: 'visual'
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    const h1 = handles[0] as HTMLElement;
    const h2 = handles[1] as HTMLElement;

    h1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    h2.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }));
    h2.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));

    const expectedNewFrom = 'Second paragraph\n\n'.length;
    expect(session.getSnapshot().selection.head).toBe(expectedNewFrom + cursorInFirst);

    handle.destroy();
  });

  // 19. Preserves gap, trailing spaces, CRLF, EOF, CJK, Emoji
  it('preserves exact gaps, trailing spaces, CRLF, EOF, CJK, Emoji during pointer drag/drop', () => {
    const source = '段落一🌟  \r\n\r\n\r\n段落二🚀\r\n';
    const session = new MarkdownDocumentSession(source);

    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-fidelity-drag',
      surfaceKind: 'visual'
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    const h1 = handles[0] as HTMLElement;
    const h2 = handles[1] as HTMLElement;

    h1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    h2.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }));
    h2.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));

    expect(session.getSnapshot().source).toBe('段落二🚀\r\n\r\n\r\n段落一🌟  \r\n');

    handle.destroy();
  });

  // 20. Real Pointer Capture: event.target stays source handle, elementFromPoint resolves target handle
  it('resolves target handle via elementFromPoint when Pointer Capture keeps event.target on source handle', () => {
    const source = 'Paragraph A\n\nParagraph B';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-pointer-capture-real',
      surfaceKind: 'visual'
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    const handleA = handles[0] as HTMLElement;
    const handleB = handles[1] as HTMLElement;

    // pointerdown triggers setPointerCapture(1) on handleA
    handleA.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    expect(capturedPointers.get(1)).toBe(handleA);

    // Mock elementFromPoint to return handleB under cursor (100, 200)
    const originalElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = (x: number, y: number) => {
      if (x === 100 && y === 200) return handleB;
      return null;
    };

    try {
      // With pointer capture, pointermove is dispatched on handleA (event.target === handleA)
      handleA.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          clientX: 100,
          clientY: 200
        })
      );

      // pointerup also dispatched on handleA
      handleA.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          clientX: 100,
          clientY: 200
        })
      );

      expect(session.getSnapshot().source).toBe('Paragraph B\n\nParagraph A');
      expect(session.getSnapshot().revision).toBe(1);
    } finally {
      document.elementFromPoint = originalElementFromPoint;
      handle.destroy();
    }
  });

  // 21. Revision collision: cancels drag if session revision changed during drag
  it('cancels drag and does NOT submit transaction if session revision changes during drag', () => {
    const source = 'Paragraph 1\n\nParagraph 2';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-revision-collision',
      surfaceKind: 'visual'
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    const h1 = handles[0] as HTMLElement;
    const h2 = handles[1] as HTMLElement;

    h1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    h2.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }));

    // External edit increments session revision
    session.dispatch({
      changes: [{ from: 0, to: 0, insert: 'Prefix ' }],
      selection: { anchor: 0, head: 0 }
    });
    expect(session.getSnapshot().revision).toBe(1);

    // pointerup attempted after external edit
    h2.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));

    // Should NOT have reordered, revision remains 1
    expect(session.getSnapshot().revision).toBe(1);
    expect(session.getSnapshot().source).toBe('Prefix Paragraph 1\n\nParagraph 2');

    handle.destroy();
  });

  // 22. Same-length source change: cancels drag if source text changed even with identical length
  it('cancels drag if canonical source text changed during drag even with identical length', () => {
    const source = 'Paragraph 1\n\nParagraph 2';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-same-length-collision',
      surfaceKind: 'visual'
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    const h1 = handles[0] as HTMLElement;
    const h2 = handles[1] as HTMLElement;

    h1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    h2.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }));

    // Replace with identical length: 'Paragraph 1' -> 'Paragraph A'
    session.dispatch({
      changes: [{ from: 10, to: 11, insert: 'A' }]
    });

    h2.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));

    // Reorder should have been cancelled
    expect(session.getSnapshot().source).toBe('Paragraph A\n\nParagraph 2');

    handle.destroy();
  });

  // 23. Drop indicator lifecycle: appears on valid target, hides on gap/cross-container/self, clears on cancel
  it('manages drop indicator lifecycle across valid target, gap, and cancel/drop', () => {
    const source = 'Paragraph 1\n\nParagraph 2\n\n> Quote block';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-drop-indicator',
      surfaceKind: 'visual'
    });

    const handles = handle.view.dom.querySelectorAll('.cm-visual-drag-handle');
    const h1 = handles[0] as HTMLElement;
    const h2 = handles[1] as HTMLElement;
    const quoteHandle = handles[2] as HTMLElement;

    h1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));

    // Valid target (h2) shows drop indicator
    h2.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }));
    const indicatorEl = handle.view.dom.querySelector('.cm-visual-drop-target');
    expect(indicatorEl).not.toBeNull();

    // Cross-container target (quoteHandle) hides drop indicator
    quoteHandle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }));
    expect(handle.view.dom.querySelector('.cm-visual-drop-target')).toBeNull();

    // Self target (h1) hides drop indicator
    h1.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }));
    expect(handle.view.dom.querySelector('.cm-visual-drop-target')).toBeNull();

    // Back to valid target
    h2.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1 }));
    expect(handle.view.dom.querySelector('.cm-visual-drop-target')).not.toBeNull();

    // Escape clears indicator
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    expect(handle.view.dom.querySelector('.cm-visual-drop-target')).toBeNull();

    handle.destroy();
  });

  // 24. Dynamic readOnly: updates handle disabled class and cancels active drag
  it('updates drag handle disabled state and cancels active drag when readOnly is toggled dynamically', () => {
    const source = 'Paragraph 1\n\nParagraph 2';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-dynamic-readonly',
      surfaceKind: 'visual',
      readOnly: false
    });

    const h1 = handle.view.dom.querySelector('.cm-visual-drag-handle') as HTMLElement;
    expect(h1.classList.contains('disabled')).toBe(false);

    // Start drag
    h1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    expect(h1.classList.contains('is-dragging')).toBe(true);

    // Reconfigure readOnly dynamically via transaction
    handle.view.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(true))
    });

    expect(handle.view.state.readOnly).toBe(true);
    expect(h1.classList.contains('is-dragging')).toBe(false);

    // Decorations update with disabled class
    const updatedH1 = handle.view.dom.querySelector('.cm-visual-drag-handle') as HTMLElement;
    expect(updatedH1.classList.contains('disabled')).toBe(true);
    expect(updatedH1.getAttribute('aria-disabled')).toBe('true');

    // Destroy to verify clean state
    handle.destroy();
  });

  // 25. Dual Visual Surfaces independence: drag on surface A does not affect surface B
  it('maintains independent drag state across multiple concurrent visual surfaces', () => {
    const source = 'Block A\n\nBlock B';
    const sessionA = new MarkdownDocumentSession(source);
    const sessionB = new MarkdownDocumentSession(source);

    const parentB = document.createElement('div');
    document.body.appendChild(parentB);

    const surfaceA = createSessionEditorView({
      parent,
      session: sessionA,
      surfaceId: 'surf-A',
      surfaceKind: 'visual'
    });

    const surfaceB = createSessionEditorView({
      parent: parentB,
      session: sessionB,
      surfaceId: 'surf-B',
      surfaceKind: 'visual'
    });

    const handleA = surfaceA.view.dom.querySelector('.cm-visual-drag-handle') as HTMLElement;
    const handleB = surfaceB.view.dom.querySelector('.cm-visual-drag-handle') as HTMLElement;

    // Start drag on Surface A
    handleA.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    expect(handleA.classList.contains('is-dragging')).toBe(true);
    expect(handleB.classList.contains('is-dragging')).toBe(false);

    // Destroying Surface B should NOT abort Surface A's drag
    surfaceB.destroy();
    expect(handleA.classList.contains('is-dragging')).toBe(true);

    surfaceA.destroy();
    document.body.removeChild(parentB);
  });

  // 26. Zero innerHTML: SVG circles created using createElementNS
  it('creates drag handle SVG icon with 6 circle elements without innerHTML', () => {
    const source = 'Paragraph';
    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-zero-innerhtml',
      surfaceKind: 'visual'
    });

    const dragHandle = handle.view.dom.querySelector('.cm-visual-drag-handle') as HTMLElement;
    const svg = dragHandle.querySelector('svg');
    expect(svg).not.toBeNull();
    const circles = svg!.querySelectorAll('circle');
    expect(circles.length).toBe(6);

    handle.destroy();
  });
});
