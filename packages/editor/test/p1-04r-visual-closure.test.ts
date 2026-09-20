// @vitest-environment happy-dom
import { EditorSelection } from '@codemirror/state';
import { assert, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MarkdownDocumentSession,
  createSessionEditorView,
  setEditorReadOnly,
  handleVisualModStrike,
  setDocumentDirectory,
  walkBlockNodes,
  tableTargetField,
  findDeepestBlockAtPos,
  collectDraggableBlocks
} from '../src/index.js';
import { parseMarkdown } from '@nexus/markdown';
import { createTableDeleteColumnTransaction, createTableDeleteRowTransaction, findTableAtPosition } from '../src/table-edit.js';
import { createReorderBlockToPositionTransaction, getContentEnd } from '../src/edit-transactions.js';

/** 挂载真实 session-backed Visual surface；调用方在 finally 中释放 DOM 和注册。 */
function mountVisual(source: string, surfaceId: string, readOnly = false) {
  const session = new MarkdownDocumentSession(source);
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = createSessionEditorView({
    session,
    surfaceId,
    surfaceKind: 'visual',
    parent,
    readOnly
  });

  return {
    session,
    parent,
    handle,
    cleanup: () => {
      handle.destroy();
      parent.remove();
    }
  };
}

/** 新操作入口的稳定标识；目标行列的选择行为由实施时的点击测试补齐。 */
const tableActions = ['delete-row', 'delete-column', 'align-left', 'align-center', 'align-right'];

/** 两个数据行用于避免将删除入口绑定到唯一数据行或表头。 */
const tableSource = '| A | B |\n| :--- | --- |\n| 1 | 2 |\n| 3 | 4 |';

/**
 * P1-04R 的 Visual surface 契约测试。
 *
 * 约定新增的交互控件使用 data-table-action，避免测试依赖按钮文案或本地化文本。
 */
describe('P1-04R Visual semantic closure', () => {
  beforeEach(() => {
    // happy-dom 20 同步通知选区变化；浏览器将此事件排入任务队列。
    // 只适配 DOM 边界的通知时序，保留真实选区、EditorView、session 和投影逻辑。
    const dispatchEvent = document.dispatchEvent.bind(document);
    const pending = new Set<ReturnType<typeof setTimeout>>();
    const dispatch = vi.spyOn(document, 'dispatchEvent').mockImplementation((event) => {
      if (event.type !== 'selectionchange') return dispatchEvent(event);
      const timer = setTimeout(() => {
        pending.delete(timer);
        dispatchEvent(event);
      }, 0);
      pending.add(timer);
      return true;
    });

    return () => {
      // 每个用例已释放 surface；取消其排队通知，防止访问下个用例的 DOM。
      for (const timer of pending) clearTimeout(timer);
      dispatch.mockRestore();
    };
  });

  it('projects strikethrough delimiters while keeping canonical source unchanged', () => {
    const source = 'Before ~~deleted~~ after.';
    const mounted = mountVisual(source, 'p1-04r-strike');

    try {
      const delimiters = mounted.parent.querySelectorAll('.cm-visual-hidden-delimiter');
      expect(delimiters).toHaveLength(2);
      expect(mounted.session.getSnapshot().source).toBe(source);
      expect(mounted.handle.view.state.doc.toString()).toBe(source);
    } finally {
      mounted.cleanup();
    }
  });

  it.each(['---', '***', '___'])('projects %s as a horizontal rule block widget', (marker) => {
    const source = `Before\n\n${marker}\n\nAfter`;
    const mounted = mountVisual(source, 'p1-04r-horizontal-rule');

    try {
      expect(mounted.parent.querySelector('.cm-visual-horizontal-rule')).not.toBeNull();
      expect(mounted.parent.querySelector('.cm-visual-raw-block')).toBeNull();
      expect(mounted.session.getSnapshot().source).toBe(source);
    } finally {
      mounted.cleanup();
    }
  });

  it.each(['**', '__', '*', '_', '~~'])('reveals and hides %s delimiters as the caret enters and leaves only that span', (delimiter) => {
    const source = `Before ${delimiter}target${delimiter} after **other**.`;
    const mounted = mountVisual(source, 'p1-04r-reveal');

    try {
      mounted.handle.view.focus();
      expect(mounted.parent.querySelectorAll('.cm-visual-delimiter-revealed')).toHaveLength(0);
      // 初始光标在普通文字中，避免把「恰好位于 delimiter 起点」混入显隐契约。
      mounted.handle.view.dispatch({
        selection: EditorSelection.single(source.indexOf('target') + 1)
      });

      const revealed = mounted.parent.querySelectorAll('.cm-visual-delimiter-revealed');
      expect(revealed).toHaveLength(2);
      expect(Array.from(revealed, (element) => element.textContent).join('')).toBe(delimiter + delimiter);
      // 相邻、未进入的粗体仍保持投影，不能按整篇文档一并展开。
      expect(mounted.parent.querySelectorAll('.cm-visual-hidden-delimiter')).toHaveLength(2);

      mounted.handle.view.dispatch({ selection: EditorSelection.single(0) });

      expect(mounted.parent.querySelectorAll('.cm-visual-delimiter-revealed')).toHaveLength(0);
      expect(mounted.parent.querySelectorAll('.cm-visual-hidden-delimiter')).toHaveLength(4);
      expect(mounted.session.getSnapshot()).toMatchObject({ source, revision: 0 });
      expect(mounted.session.canUndo).toBe(false);
    } finally {
      mounted.cleanup();
    }
  });

  it('reveals delimiters for a reversed nonempty selection without changing its source offsets', () => {
    const source = 'Before **bold** after.';
    const mounted = mountVisual(source, 'p1-04r-selection');

    try {
      mounted.handle.view.focus();
      mounted.handle.view.dispatch({ selection: EditorSelection.single(13, 9) });

      expect(mounted.parent.querySelectorAll('.cm-visual-delimiter-revealed')).toHaveLength(2);
      expect(mounted.session.getSnapshot()).toEqual({ source, revision: 0, selection: { anchor: 13, head: 9 } });
    } finally {
      mounted.cleanup();
    }
  });

  it.each([
    { label: 'link', markup: '[target](https://nexus.dev)', marker: '[' },
    { label: 'list', markup: '- target', marker: '-' },
    { label: 'blockquote', markup: '> target', marker: '>' }
  ])('reveals and restores the relevant $label marker', ({ markup, marker }) => {
    const source = `Before\n\n${markup}\n\nAfter`;
    const mounted = mountVisual(source, 'p1-04r-marker');

    try {
      mounted.handle.view.focus();
      mounted.handle.view.dispatch({ selection: EditorSelection.single(source.indexOf('target') + 1) });

      const revealed = mounted.parent.querySelectorAll('.cm-visual-delimiter-revealed');
      expect(revealed.length).toBeGreaterThan(0);
      expect(Array.from(revealed, (element) => element.textContent).join('')).toContain(marker);

      mounted.handle.view.dispatch({ selection: EditorSelection.single(0) });

      expect(mounted.parent.querySelectorAll('.cm-visual-delimiter-revealed')).toHaveLength(0);
      expect(mounted.session.getSnapshot()).toMatchObject({ source, revision: 0 });
      expect(mounted.session.canUndo).toBe(false);
    } finally {
      mounted.cleanup();
    }
  });

  it('preserves a pending redo and both surface documents during selection-only reveal', () => {
    const source = 'Before **bold** after.';
    const mounted = mountVisual(source, 'p1-04r-history-visual');
    const sourceParent = document.createElement('div');
    document.body.appendChild(sourceParent);
    const sourceHandle = createSessionEditorView({
      session: mounted.session,
      surfaceId: 'p1-04r-history-source',
      surfaceKind: 'source',
      parent: sourceParent
    });

    try {
      // 先建立真实 redo 项；仅检查空 history 无法发现 reveal 错误清空 redo 的回归。
      mounted.session.dispatch({ changes: [{ from: source.length, to: source.length, insert: '!' }] });
      mounted.session.undo();
      const revision = mounted.session.getSnapshot().revision;
      expect(mounted.session.canRedo).toBe(true);

      mounted.handle.view.focus();
      mounted.handle.view.dispatch({ selection: EditorSelection.single(10) });
      expect(mounted.parent.querySelectorAll('.cm-visual-delimiter-revealed')).toHaveLength(2);
      mounted.handle.view.dispatch({ selection: EditorSelection.single(0) });

      expect(mounted.session.getSnapshot()).toMatchObject({ source, revision });
      expect(mounted.handle.view.state.doc.toString()).toBe(source);
      expect(sourceHandle.view.state.doc.toString()).toBe(source);
      expect(mounted.session.canUndo).toBe(false);
      expect(mounted.session.canRedo).toBe(true);

      mounted.session.redo();
      expect(mounted.session.getSnapshot().source).toBe('Before **bold** after.!');
      expect(mounted.handle.view.state.doc.toString()).toBe('Before **bold** after.!');
      expect(sourceHandle.view.state.doc.toString()).toBe('Before **bold** after.!');
    } finally {
      sourceHandle.destroy();
      sourceParent.remove();
      mounted.cleanup();
    }
  });

  it.each(tableActions)('exposes the table %s action without mutating source on mount', (action) => {
    const mounted = mountVisual(tableSource, 'p1-04r-table-actions');

    try {
      expect(mounted.parent.querySelector(`[data-table-action="${action}"]`)).not.toBeNull();
      expect(mounted.session.getSnapshot()).toMatchObject({ source: tableSource, revision: 0 });
    } finally {
      mounted.cleanup();
    }
  });

  it.each(tableActions)('disables the table %s action after a dynamic readOnly transition', (action) => {
    const mounted = mountVisual(tableSource, 'p1-04r-table-readonly');

    try {
      setEditorReadOnly(mounted.handle.view, true);
      const button = mounted.parent.querySelector(`[data-table-action="${action}"]`);
      assert(button instanceof HTMLButtonElement, `Missing table button: ${action}`);
      expect(button.disabled).toBe(true);
      button.click();
      // 即使事件被程序派发，处理器也不能绕过 readOnly 提交事务。
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(mounted.session.getSnapshot()).toMatchObject({ source: tableSource, revision: 0 });
      expect(mounted.session.canUndo).toBe(false);
    } finally {
      mounted.cleanup();
    }
  });

  it('keeps Unicode and CRLF byte-for-byte intact while mounting and destroying a Visual surface', () => {
    const source = '中文 🎉 ~~删除~~\r\n\r\n___\r\n';
    const mounted = mountVisual(source, 'p1-04r-crlf');

    try {
      expect(mounted.handle.view.state.doc.toString()).toBe(source);
      expect(mounted.session.getSnapshot()).toMatchObject({ source, revision: 0 });
      expect(mounted.session.canUndo).toBe(false);
    } finally {
      mounted.cleanup();
    }
    expect(mounted.session.getSnapshot()).toMatchObject({ source, revision: 0 });
  });

  it('toggles strike through the formatting command with one undo step and Source/Visual synchronization', () => {
    const initialSource = 'Hello world';
    const mounted = mountVisual(initialSource, 'p1-04r-strike-format');
    const sourceParent = document.createElement('div');
    document.body.appendChild(sourceParent);
    const sourceHandle = createSessionEditorView({
      session: mounted.session,
      surfaceId: 'p1-04r-strike-source',
      surfaceKind: 'source',
      parent: sourceParent
    });

    try {
      // 1. Select 'world' (from 6 to 11) in visual surface
      mounted.handle.view.focus();
      mounted.handle.view.dispatch({
        selection: EditorSelection.single(6, 11)
      });

      // 2. Execute Mod-Shift-s formatting command
      const handled = handleVisualModStrike(mounted.handle.view);
      expect(handled).toBe(true);

      const expectedFormatted = 'Hello ~~world~~';
      expect(mounted.session.getSnapshot().source).toBe(expectedFormatted);
      expect(mounted.handle.view.state.doc.toString()).toBe(expectedFormatted);
      expect(sourceHandle.view.state.doc.toString()).toBe(expectedFormatted);
      expect(mounted.session.canUndo).toBe(true);

      // 3. Undo: single undo step restores original source and synchronizes both surfaces
      mounted.session.undo();
      expect(mounted.session.getSnapshot().source).toBe(initialSource);
      expect(mounted.handle.view.state.doc.toString()).toBe(initialSource);
      expect(sourceHandle.view.state.doc.toString()).toBe(initialSource);

      // 4. Redo: single redo step reapplies formatting
      mounted.session.redo();
      expect(mounted.session.getSnapshot().source).toBe(expectedFormatted);
      expect(mounted.handle.view.state.doc.toString()).toBe(expectedFormatted);
      expect(sourceHandle.view.state.doc.toString()).toBe(expectedFormatted);

      // 5. Toggle off strike on 'world'
      mounted.handle.view.dispatch({
        selection: EditorSelection.single(6, 15) // '~~world~~'
      });
      const unhandled = handleVisualModStrike(mounted.handle.view);
      expect(unhandled).toBe(true);
      expect(mounted.session.getSnapshot().source).toBe(initialSource);
      expect(mounted.handle.view.state.doc.toString()).toBe(initialSource);
      expect(sourceHandle.view.state.doc.toString()).toBe(initialSource);
    } finally {
      sourceHandle.destroy();
      sourceParent.remove();
      mounted.cleanup();
    }
  });

  it('deletes the chosen table row or column and aligns the chosen column through real clicks with undo/redo', () => {
    const source = '| A | B |\n| :--- | --- |\n| 1 | 2 |\n| 3 | 4 |';
    const mounted = mountVisual(source, 'p1-04r-table-interactions');

    try {
      // 1. Click row 1, col 0 (cell '3') to select that row/cell
      const cellRow1Col0 = mounted.parent.querySelector('.cm-visual-table td[data-row="1"][data-col="0"]') as HTMLElement;
      assert(cellRow1Col0, 'Missing cell row 1 col 0');
      cellRow1Col0.click();

      // 2. Click delete-row button
      const delRowBtn = mounted.parent.querySelector('[data-table-action="delete-row"]') as HTMLButtonElement;
      assert(delRowBtn, 'Missing delete-row button');
      delRowBtn.click();

      const afterDeleteRow = '| A | B |\n| :--- | --- |\n| 1 | 2 |';
      expect(mounted.session.getSnapshot().source).toBe(afterDeleteRow);
      expect(mounted.handle.view.state.doc.toString()).toBe(afterDeleteRow);

      // 3. Undo delete-row
      mounted.session.undo();
      expect(mounted.session.getSnapshot().source).toBe(source);
      expect(mounted.handle.view.state.doc.toString()).toBe(source);

      // 4. Redo delete-row
      mounted.session.redo();
      expect(mounted.session.getSnapshot().source).toBe(afterDeleteRow);

      // 5. Click header col 1 (cell 'B') to select column 1
      const headerCol1 = mounted.parent.querySelector('.cm-visual-table th[data-col="1"]') as HTMLElement;
      assert(headerCol1, 'Missing header col 1');
      headerCol1.click();

      // 6. Click align-center button
      const alignCenterBtn = mounted.parent.querySelector('[data-table-action="align-center"]') as HTMLButtonElement;
      assert(alignCenterBtn, 'Missing align-center button');
      alignCenterBtn.click();

      const afterAlignCenter = '| A | B |\n| :--- | :---: |\n| 1 | 2 |';
      expect(mounted.session.getSnapshot().source).toBe(afterAlignCenter);

      // 7. Click header col 1 again (since table re-projected) and delete column 1
      const headerCol1After = mounted.parent.querySelector('.cm-visual-table th[data-col="1"]') as HTMLElement;
      assert(headerCol1After, 'Missing header col 1 after align');
      headerCol1After.click();

      const delColBtn = mounted.parent.querySelector('[data-table-action="delete-column"]') as HTMLButtonElement;
      assert(delColBtn, 'Missing delete-column button');
      delColBtn.click();

      const afterDeleteCol = '| A |\n| :--- |\n| 1 |';
      expect(mounted.session.getSnapshot().source).toBe(afterDeleteCol);

      // 8. Undo delete-column and align-center
      mounted.session.undo();
      expect(mounted.session.getSnapshot().source).toBe(afterAlignCenter);
      mounted.session.undo();
      expect(mounted.session.getSnapshot().source).toBe(afterDeleteRow);
    } finally {
      mounted.cleanup();
    }
  });

  it('resolves a relative image source against the Markdown document directory', () => {
    // 1. With documentDirectory set: relative image resolves to file:/// URL
    const source1 = 'Before ![Logo](./assets/logo.png) after.';
    const session1 = new MarkdownDocumentSession(source1);
    const parent1 = document.createElement('div');
    document.body.appendChild(parent1);
    const handle1 = createSessionEditorView({
      session: session1,
      surfaceId: 'p1-04r-img-docdir',
      surfaceKind: 'visual',
      parent: parent1,
      documentDirectory: 'D:/Projects/Codex/Nexus/docs'
    });

    try {
      const img = parent1.querySelector('.cm-visual-image img') as HTMLImageElement;
      assert(img, 'Missing img element');
      expect(img.src).toBe('file:///D:/Projects/Codex/Nexus/docs/assets/logo.png');
      expect(img.alt).toBe('Logo');
    } finally {
      handle1.destroy();
      parent1.remove();
    }

    // 2. With Chinese and spaces in directory and image path
    const source2 = '![图表](<./资源/架构 图.png>)';
    const session2 = new MarkdownDocumentSession(source2);
    const parent2 = document.createElement('div');
    document.body.appendChild(parent2);
    const handle2 = createSessionEditorView({
      session: session2,
      surfaceId: 'p1-04r-img-chinese',
      surfaceKind: 'visual',
      parent: parent2,
      documentDirectory: 'D:/项目 目录/子文档'
    });

    try {
      const img = parent2.querySelector('.cm-visual-image img') as HTMLImageElement;
      assert(img, 'Missing img element for Chinese path');
      expect(img.src).toBe('file:///D:/%E9%A1%B9%E7%9B%AE%20%E7%9B%AE%E5%BD%95/%E5%AD%90%E6%96%87%E6%A1%A3/%E8%B5%84%E6%BA%90/%E6%9E%B6%E6%9E%84%20%E5%9B%BE.png');
    } finally {
      handle2.destroy();
      parent2.remove();
    }

    // 3. Without documentDirectory: relative image does NOT resolve to renderer page directory, renders placeholder
    const source3 = '![Diagram](./assets/diagram.png)';
    const mountedNoDir = mountVisual(source3, 'p1-04r-img-nodir');
    try {
      expect(mountedNoDir.parent.querySelector('.cm-visual-image img')).toBeNull();
      const placeholder = mountedNoDir.parent.querySelector('.cm-visual-image-placeholder');
      expect(placeholder).not.toBeNull();
      expect(placeholder?.textContent).toContain('Diagram');
    } finally {
      mountedNoDir.cleanup();
    }

    // 4. Raw file:/// protocol in markdown remains blocked by sanitizeUrl
    const source4 = '![Unsafe](file:///C:/Windows/System32/cmd.exe)';
    const mountedUnsafe = mountVisual(source4, 'p1-04r-img-unsafe');
    try {
      expect(mountedUnsafe.parent.querySelector('.cm-visual-image img')).toBeNull();
      const blocked = mountedUnsafe.parent.querySelector('.cm-visual-image-blocked');
      expect(blocked).not.toBeNull();
    } finally {
      mountedUnsafe.cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // R1: Single-tilde strikethrough unwrap, range, and reverse selection
  // ---------------------------------------------------------------------------
  it.each([
    { source: 'A ~word~ B', innerSel: [3, 7] as [number, number], fullSel: [2, 8] as [number, number], expected: 'A word B' },
    { source: 'A ~~word~~ B', innerSel: [4, 8] as [number, number], fullSel: [2, 10] as [number, number], expected: 'A word B' }
  ])('unwraps strike cleanly for inner and full selection on %s', ({ source, innerSel, fullSel, expected }) => {
    // 1. Test inner selection unwrap
    const mounted1 = mountVisual(source, 'p1-04r-r1-inner');
    try {
      mounted1.handle.view.focus();
      mounted1.handle.view.dispatch({ selection: EditorSelection.single(innerSel[0], innerSel[1]) });
      const handled1 = handleVisualModStrike(mounted1.handle.view);
      expect(handled1).toBe(true);
      expect(mounted1.session.getSnapshot().source).toBe(expected);
      expect(mounted1.session.getSnapshot().selection).toEqual({ anchor: 2, head: 6 });
      mounted1.session.undo();
      expect(mounted1.session.getSnapshot().source).toBe(source);
    } finally {
      mounted1.cleanup();
    }

    // 2. Test full selection unwrap
    const mounted2 = mountVisual(source, 'p1-04r-r1-full');
    try {
      mounted2.handle.view.focus();
      mounted2.handle.view.dispatch({ selection: EditorSelection.single(fullSel[0], fullSel[1]) });
      const handled2 = handleVisualModStrike(mounted2.handle.view);
      expect(handled2).toBe(true);
      expect(mounted2.session.getSnapshot().source).toBe(expected);
      expect(mounted2.session.getSnapshot().selection).toEqual({ anchor: 2, head: 6 });
      mounted2.session.undo();
      expect(mounted2.session.getSnapshot().source).toBe(source);
    } finally {
      mounted2.cleanup();
    }

    // 3. Test reversed selection unwrap
    const mounted3 = mountVisual(source, 'p1-04r-r1-rev');
    try {
      mounted3.handle.view.focus();
      mounted3.handle.view.dispatch({ selection: EditorSelection.single(fullSel[1], fullSel[0]) });
      const handled3 = handleVisualModStrike(mounted3.handle.view);
      expect(handled3).toBe(true);
      expect(mounted3.session.getSnapshot().source).toBe(expected);
      // Verify selection is reversed
      const snapshot = mounted3.session.getSnapshot();
      assert(snapshot.selection);
      expect(snapshot.selection).toEqual({ anchor: 6, head: 2 });
    } finally {
      mounted3.cleanup();
    }
  });

  it('projects single-tilde strike without hiding first or last character', () => {
    const source = 'A ~word~ B';
    const mounted = mountVisual(source, 'p1-04r-r1-project');
    try {
      const delimiters = mounted.parent.querySelectorAll('.cm-visual-hidden-delimiter');
      expect(delimiters).toHaveLength(2);
      expect(delimiters[0]?.getAttribute('data-delimiter')).toBe('~');
      expect(delimiters[1]?.getAttribute('data-delimiter')).toBe('~');

      const strikeMark = mounted.parent.querySelector('.cm-visual-strike');
      assert(strikeMark);
      expect(strikeMark.textContent).toBe('word');
    } finally {
      mounted.cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // R2: Table target persistence, alignment, and deletion
  // ---------------------------------------------------------------------------
  it('retains table column target across alignment and deletes column without re-clicking', () => {
    const source = '| A | B |\n| :--- | --- |\n| 1 | 2 |\n| 3 | 4 |';
    const mounted = mountVisual(source, 'p1-04r-r2-persist');

    try {
      // 1. Click header col 1 ('B') to activate column 1
      const headerCol1 = mounted.parent.querySelector('.cm-visual-table th[data-col="1"]') as HTMLElement;
      assert(headerCol1);
      headerCol1.click();

      // 2. Click align-center
      const alignCenterBtn = mounted.parent.querySelector('[data-table-action="align-center"]') as HTMLButtonElement;
      assert(alignCenterBtn);
      alignCenterBtn.click();

      const afterAlign = '| A | B |\n| :--- | :---: |\n| 1 | 2 |\n| 3 | 4 |';
      expect(mounted.session.getSnapshot().source).toBe(afterAlign);

      // 3. Immediately click delete-column WITHOUT re-clicking any cell or header
      const delColBtn = mounted.parent.querySelector('[data-table-action="delete-column"]') as HTMLButtonElement;
      assert(delColBtn);
      expect(delColBtn.disabled).toBe(false);
      delColBtn.click();

      // Col 1 must be deleted, Col A must be preserved!
      const afterDelCol = '| A |\n| :--- |\n| 1 |\n| 3 |';
      expect(mounted.session.getSnapshot().source).toBe(afterDelCol);
    } finally {
      mounted.cleanup();
    }
  });

  it('does not delete data row when header is clicked or when no cell is activated', () => {
    const source = '| A | B |\n| :--- | --- |\n| 1 | 2 |\n| 3 | 4 |';
    const mounted = mountVisual(source, 'p1-04r-r2-header-guard');

    try {
      // 1. Initial state: no cell activated -> delete buttons must be disabled
      const delRowBtn = mounted.parent.querySelector('[data-table-action="delete-row"]') as HTMLButtonElement;
      const delColBtn = mounted.parent.querySelector('[data-table-action="delete-column"]') as HTMLButtonElement;
      assert(delRowBtn && delColBtn);
      expect(delRowBtn.disabled).toBe(true);
      expect(delColBtn.disabled).toBe(true);

      // Clicking disabled button should not mutate source
      delRowBtn.click();
      expect(mounted.session.getSnapshot().source).toBe(source);

      // 2. Click header th[data-col="0"] -> activeRow is -1
      const th0 = mounted.parent.querySelector('.cm-visual-table th[data-col="0"]') as HTMLElement;
      assert(th0);
      th0.click();

      // Header is selected -> delete-row must be disabled / no-op
      expect(delRowBtn.disabled).toBe(true);
      delRowBtn.click();
      expect(mounted.session.getSnapshot().source).toBe(source);
    } finally {
      mounted.cleanup();
    }
  });

  it('applies left, center, and right alignments from different initial alignments with independent undo/redo', () => {
    // Initial: col 0 has left (:---), col 1 has right (---:), col 2 has none (---)
    const source = '| A | B | C |\n| :--- | ---: | --- |\n| 1 | 2 | 3 |';
    const mounted = mountVisual(source, 'p1-04r-r2-all-alignments');

    try {
      // 1. Select col 1 (which starts right aligned '---:') and align it center
      const th1 = mounted.parent.querySelector('.cm-visual-table th[data-col="1"]') as HTMLElement;
      assert(th1);
      th1.click();

      const alignCenterBtn = mounted.parent.querySelector('[data-table-action="align-center"]') as HTMLButtonElement;
      assert(alignCenterBtn);
      alignCenterBtn.click();

      const afterCenter = '| A | B | C |\n| :--- | :---: | --- |\n| 1 | 2 | 3 |';
      expect(mounted.session.getSnapshot().source).toBe(afterCenter);

      // 2. Select col 0 (which starts left aligned ':---') and align it right
      const th0 = mounted.parent.querySelector('.cm-visual-table th[data-col="0"]') as HTMLElement;
      assert(th0);
      th0.click();

      const alignRightBtn = mounted.parent.querySelector('[data-table-action="align-right"]') as HTMLButtonElement;
      assert(alignRightBtn);
      alignRightBtn.click();

      const afterRight = '| A | B | C |\n| ---: | :---: | --- |\n| 1 | 2 | 3 |';
      expect(mounted.session.getSnapshot().source).toBe(afterRight);

      // 3. Select col 1 (now center aligned) and align it left
      const th1Again = mounted.parent.querySelector('.cm-visual-table th[data-col="1"]') as HTMLElement;
      assert(th1Again);
      th1Again.click();

      const alignLeftBtn = mounted.parent.querySelector('[data-table-action="align-left"]') as HTMLButtonElement;
      assert(alignLeftBtn);
      alignLeftBtn.click();

      const afterLeft = '| A | B | C |\n| ---: | :--- | --- |\n| 1 | 2 | 3 |';
      expect(mounted.session.getSnapshot().source).toBe(afterLeft);

      // 4. Undo step by step
      mounted.session.undo();
      expect(mounted.session.getSnapshot().source).toBe(afterRight);

      mounted.session.undo();
      expect(mounted.session.getSnapshot().source).toBe(afterCenter);

      mounted.session.undo();
      expect(mounted.session.getSnapshot().source).toBe(source);
      for (const expected of [afterCenter, afterRight, afterLeft]) {
        expect(mounted.session.redo()).toBe(true);
        expect(mounted.session.getSnapshot().source).toBe(expected);
      }
    } finally {
      mounted.cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // R3: Strikethrough shortcut Mod-Shift-x vs Mod-Shift-s
  // ---------------------------------------------------------------------------
  it('binds strikethrough to Mod-Shift-x and ensures Mod-Shift-s does not trigger strike', () => {
    const source = 'Hello world';
    const mounted = mountVisual(source, 'p1-04r-r3-keymap');

    try {
      mounted.handle.view.focus();
      mounted.handle.view.dispatch({ selection: EditorSelection.single(6, 11) });

      // 1. Send Mod-Shift-s keydown -> should NOT format strikethrough
      const modShiftSEvent = new KeyboardEvent('keydown', {
        key: 's',
        code: 'KeyS',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      });
      mounted.handle.view.contentDOM.dispatchEvent(modShiftSEvent);
      expect(mounted.session.getSnapshot().source).toBe(source);

      // 2. Send Mod-Shift-x keydown -> should format strikethrough
      const modShiftXEvent = new KeyboardEvent('keydown', {
        key: 'x',
        code: 'KeyX',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      });
      mounted.handle.view.contentDOM.dispatchEvent(modShiftXEvent);
      expect(mounted.session.getSnapshot().source).toBe('Hello ~~world~~');

      // 3. Send Mod-Shift-x again -> should unwrap strikethrough
      const modShiftXEvent2 = new KeyboardEvent('keydown', {
        key: 'x',
        code: 'KeyX',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      });
      mounted.handle.view.contentDOM.dispatchEvent(modShiftXEvent2);
      expect(mounted.session.getSnapshot().source).toBe(source);
    } finally {
      mounted.cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // R4: Horizontal rule interactive editing and AST walker
  // ---------------------------------------------------------------------------
  it('provides interactive edit entry for horizontal rule via mouse and Enter commit', () => {
    const source = 'Before\n\n---\n\nAfter';
    const mounted = mountVisual(source, 'p1-04r-r4-hr');

    try {
      // 1. Click horizontal rule container to enter edit mode
      const hrContainer = mounted.parent.querySelector('.cm-visual-hr-container') as HTMLElement;
      assert(hrContainer, 'Missing cm-visual-hr-container');
      hrContainer.click();

      // Editor input should appear
      const input = hrContainer.querySelector('.cm-hr-editor') as HTMLInputElement;
      assert(input, 'Missing cm-hr-editor input');
      expect(input.value).toBe('---');

      // Edit value and press Enter to commit
      input.value = '***';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

      const expectedSource = 'Before\n\n***\n\nAfter';
      expect(mounted.session.getSnapshot().source).toBe(expectedSource);

      // Undo restores original
      mounted.session.undo();
      expect(mounted.session.getSnapshot().source).toBe(source);
    } finally {
      mounted.cleanup();
    }
  });

  it('locates horizontal rule inside list item through AST walker', () => {
    const source = '- item\n\n  ---\n';
    const parsed = parseMarkdown(source);
    const visitedTypes: string[] = [];
    walkBlockNodes(parsed.root.children, (block) => {
      visitedTypes.push(block.type);
    });

    expect(visitedTypes).toContain('horizontal-rule');
  });

  // ---------------------------------------------------------------------------
  // R5: Dynamic documentDirectory and real focus/blur
  // ---------------------------------------------------------------------------
  it('dynamically updates relative image URL when setDocumentDirectory is called on mounted view', () => {
    const source = '![Logo](./assets/logo.png)';
    const mounted = mountVisual(source, 'p1-04r-r5-dynamic-dir');

    try {
      // 构造待重做的正文编辑，目录变化不得清空已有 history。
      mounted.session.dispatch({ changes: [{ from: source.length, to: source.length, insert: '\n\nTail' }] });
      expect(mounted.session.undo()).toBe(true);
      const beforeDirectoryChange = mounted.session.getSnapshot();
      // 1. Initial without directory -> placeholder
      expect(mounted.parent.querySelector('.cm-visual-image img')).toBeNull();

      // 2. Set directory A
      setDocumentDirectory(mounted.handle.view, 'D:/dirA');
      const imgA = mounted.parent.querySelector('.cm-visual-image img') as HTMLImageElement;
      assert(imgA);
      expect(imgA.src).toBe('file:///D:/dirA/assets/logo.png');
      expect(mounted.session.getSnapshot()).toEqual(beforeDirectoryChange);
      expect(mounted.session.canRedo).toBe(true);

      // 3. Switch to directory B on the SAME mounted view
      setDocumentDirectory(mounted.handle.view, 'D:/dirB');
      const imgB = mounted.parent.querySelector('.cm-visual-image img') as HTMLImageElement;
      assert(imgB);
      expect(imgB.src).toBe('file:///D:/dirB/assets/logo.png');
      expect(mounted.session.getSnapshot()).toEqual(beforeDirectoryChange);
      expect(mounted.session.canRedo).toBe(true);

      // 4. Remove directory (null) -> reverts to placeholder
      setDocumentDirectory(mounted.handle.view, null);
      expect(mounted.parent.querySelector('.cm-visual-image img')).toBeNull();
      expect(mounted.parent.querySelector('.cm-visual-image-placeholder')).not.toBeNull();
      expect(mounted.session.getSnapshot()).toEqual(beforeDirectoryChange);
      expect(mounted.session.redo()).toBe(true);
      expect(mounted.session.getSnapshot().source).toBe(source + '\n\nTail');
    } finally {
      mounted.cleanup();
    }
  });

  it('hides delimiters on real blur to outside element and reveals on refocus', () => {
    const source = 'Before **bold** after.';
    const mounted = mountVisual(source, 'p1-04r-r5-blur');
    const outsideBtn = document.createElement('button');
    document.body.appendChild(outsideBtn);

    try {
      mounted.handle.view.focus();
      mounted.handle.view.dispatch({ selection: EditorSelection.single(10) });

      // Delimiters revealed when focused
      expect(mounted.parent.querySelectorAll('.cm-visual-delimiter-revealed')).toHaveLength(2);

      // Blur editor by focusing external button
      outsideBtn.focus();
      mounted.handle.view.contentDOM.dispatchEvent(new FocusEvent('blur', { bubbles: true, relatedTarget: outsideBtn }));

      // Delimiters must be hidden on blur
      expect(mounted.parent.querySelectorAll('.cm-visual-delimiter-revealed')).toHaveLength(0);
      expect(mounted.parent.querySelectorAll('.cm-visual-hidden-delimiter')).toHaveLength(2);
      expect(mounted.session.getSnapshot().source).toBe(source);
      expect(mounted.session.getSnapshot().revision).toBe(0);

      // Refocus editor -> delimiters revealed again
      mounted.handle.view.focus();
      mounted.handle.view.contentDOM.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      expect(mounted.parent.querySelectorAll('.cm-visual-delimiter-revealed')).toHaveLength(2);
    } finally {
      outsideBtn.remove();
      mounted.cleanup();
    }
  });

  it('resolves relative image path containing parent directory traversal (../) against document directory', () => {
    const source = '![Parent Image](../shared/assets/icon.png)';
    const mounted = mountVisual(source, 'p1-04r-r5-parent-dir');

    try {
      setDocumentDirectory(mounted.handle.view, 'D:/Projects/Codex/Nexus/sub');
      const img = mounted.parent.querySelector('.cm-visual-image img') as HTMLImageElement;
      assert(img);
      expect(img.src).toBe('file:///D:/Projects/Codex/Nexus/shared/assets/icon.png');
      expect(mounted.session.getSnapshot().source).toBe(source);
      expect(mounted.session.getSnapshot().revision).toBe(0);
      expect(mounted.session.canUndo).toBe(false);
    } finally {
      mounted.cleanup();
    }
  });

  it('closes a cell editor when its toolbar alignment transaction refreshes the table', () => {
    const source = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const mounted = mountVisual(source, 'p1-04r-r5-cell-focus');

    try {
      // Click cell (0, 0) to start cell edit
      const td00 = mounted.parent.querySelector('.cm-visual-table td[data-row="0"][data-col="0"]') as HTMLElement;
      assert(td00);
      td00.click();

      const cellInput = td00.querySelector('input');
      assert(cellInput, 'Expected cell input editor');

      // Click toolbar button
      const alignCenterBtn = mounted.parent.querySelector('[data-table-action="align-center"]') as HTMLButtonElement;
      assert(alignCenterBtn);
      alignCenterBtn.click();

      // Cell input was closed, align-center committed
      expect(td00.querySelector('input')).toBeNull();
      expect(mounted.session.getSnapshot().source).toBe('| A | B |\n| :---: | --- |\n| 1 | 2 |');
    } finally {
      mounted.cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // F1: External structural changes to table target mapping & button synchronization
  // ---------------------------------------------------------------------------
  it.each(['column', 'row'] as const)('invalidates a deleted %s even when an identical sibling survives', (kind) => {
    const initial = kind === 'column'
      ? '| A | B | B |\n| --- | --- | --- |\n| 1 | 2 | 3 |'
      : '| A | B |\n| --- | --- |\n| same | row |\n| same | row |\n| last | row |';
    const mounted = mountVisual(initial, `deleted-duplicate-${kind}`);
    try {
      const selector = kind === 'column' ? 'th[data-col="1"]' : 'td[data-row="0"][data-col="0"]';
      mounted.parent.querySelector<HTMLElement>(selector)!.click();
      const context = findTableAtPosition(initial, 0);
      assert(context);
      const transaction = kind === 'column'
        ? createTableDeleteColumnTransaction(initial, context, 1)
        : createTableDeleteRowTransaction(initial, context, 0);
      assert(transaction);
      // 外部事务只提供源码变更，不替 Visual 清理目标字段。
      mounted.session.dispatch(transaction);
      const target = mounted.handle.view.state.field(tableTargetField);
      expect(kind === 'column' ? target?.activeCol ?? null : target?.activeRow ?? null).toBeNull();
      const button = mounted.parent.querySelector<HTMLButtonElement>(`[data-table-action="delete-${kind}"]`)!;
      expect(button.disabled).toBe(true);
      const before = mounted.session.getSnapshot();
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(mounted.session.getSnapshot()).toEqual(before);
    } finally {
      mounted.cleanup();
    }
  });

  it('invalidates the target on whole-table replacement even when headers and rows match', () => {
    const initial = '| A | B |\n| --- | --- |\n| same | row |';
    const replacement = '| A | B |\n| --- | --- |\n| same | row |\n| new | row |';
    const mounted = mountVisual(initial, 'replacement-identity');
    try {
      mounted.parent.querySelector<HTMLElement>('td[data-row="0"][data-col="1"]')!.click();
      mounted.session.dispatch({ changes: [{ from: 0, to: initial.length, insert: replacement }] });
      expect(mounted.handle.view.state.field(tableTargetField)).toBeNull();
      for (const action of tableActions) {
        expect(mounted.parent.querySelector<HTMLButtonElement>(`[data-table-action="${action}"]`)!.disabled).toBe(true);
      }
      expect(mounted.session.getSnapshot().source).toBe(replacement);
    } finally {
      mounted.cleanup();
    }
  });

  it('keeps unavailable table actions disabled after returning from readOnly', () => {
    const mounted = mountVisual(tableSource, 'readonly-target-restoration');
    try {
      setEditorReadOnly(mounted.handle.view, true);
      setEditorReadOnly(mounted.handle.view, false);
      for (const action of tableActions) {
        expect(mounted.parent.querySelector<HTMLButtonElement>(`[data-table-action="${action}"]`)!.disabled).toBe(true);
      }
      // 表头恢复后只允许列操作，不能隐式选中首数据行。
      mounted.parent.querySelector<HTMLElement>('th[data-col="1"]')!.click();
      setEditorReadOnly(mounted.handle.view, true);
      setEditorReadOnly(mounted.handle.view, false);
      expect(mounted.parent.querySelector<HTMLButtonElement>('[data-table-action="delete-row"]')!.disabled).toBe(true);
      expect(mounted.parent.querySelector<HTMLButtonElement>('[data-table-action="delete-column"]')!.disabled).toBe(false);
      expect(mounted.parent.querySelector('th[data-col="1"]')!.textContent).toBe('B');
      expect(mounted.session.getSnapshot().source).toBe(tableSource);
      expect(mounted.session.canUndo).toBe(false);
    } finally {
      mounted.cleanup();
    }
  });

  it('preserves the table target after inserting text before it', () => {
    const mounted = mountVisual(tableSource, 'table-prefix-insertion');
    try {
      mounted.parent.querySelector<HTMLElement>('th[data-col="1"]')!.click();
      mounted.session.dispatch({ changes: [{ from: 0, to: 0, insert: 'Before\n\n' }] });
      mounted.parent.querySelector<HTMLButtonElement>('[data-table-action="delete-column"]')!.click();
      expect(mounted.session.getSnapshot().source).toBe('Before\n\n| A |\n| :--- |\n| 1 |\n| 3 |');
    } finally {
      mounted.cleanup();
    }
  });

  it('maps column target correctly when previous column is deleted externally via Source surface', () => {
    const initial = '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |';
    const mounted = mountVisual(initial, 'p1-04r-f1-col-map');
    const sourceParent = document.createElement('div');
    document.body.appendChild(sourceParent);
    const sourceHandle = createSessionEditorView({
      session: mounted.session,
      surfaceId: 'p1-04r-f1-col-source',
      surfaceKind: 'source',
      parent: sourceParent
    });

    try {
      // 1. In Visual surface, click header col 1 ('B') to activate column 1
      const thB = mounted.parent.querySelector('.cm-visual-table th[data-col="1"]') as HTMLElement;
      assert(thB, 'Missing th B');
      thB.click();

      let target = mounted.handle.view.state.field(tableTargetField, false);
      expect(target?.activeCol).toBe(1);

      // 2. Via Source surface, delete column A
      const context = findTableAtPosition(initial, 0);
      assert(context);
      const deletion = createTableDeleteColumnTransaction(initial, context, 0);
      assert(deletion);
      sourceHandle.view.dispatch({ changes: deletion.changes, userEvent: deletion.userEvent });

      // Target activeCol must be mapped to 0 (pointing to B)!
      target = mounted.handle.view.state.field(tableTargetField, false);
      expect(target?.activeCol).toBe(0);

      // 3. Directly click delete-column button in Visual surface
      const delColBtn = mounted.parent.querySelector('[data-table-action="delete-column"]') as HTMLButtonElement;
      assert(delColBtn, 'Missing delete-column button');
      expect(delColBtn.disabled).toBe(false);
      delColBtn.click();

      // Must delete B, leaving C! Must NOT delete C!
      const finalSource = mounted.session.getSnapshot().source;
      expect(finalSource).toContain('C');
      expect(finalSource).not.toContain('B');
      expect(finalSource).toBe('| C |\n| --- |\n| 3 |');
    } finally {
      sourceHandle.destroy();
      sourceParent.remove();
      mounted.cleanup();
    }
  });

  it('maps row target correctly when previous row is deleted externally via session', () => {
    const initial = '| A |\n| --- |\n| R0 |\n| R1 |\n| R2 |';
    const mounted = mountVisual(initial, 'p1-04r-f1-row-map');
    try {
      // 1. In Visual surface, click data row 1 (cell 'R1')
      const tdR1 = mounted.parent.querySelector('.cm-visual-table td[data-row="1"][data-col="0"]') as HTMLElement;
      assert(tdR1, 'Missing td R1');
      tdR1.click();

      let target = mounted.handle.view.state.field(tableTargetField, false);
      expect(target?.activeRow).toBe(1);

      // 2. Via session, delete row 0 ('R0')
      const context = findTableAtPosition(initial, 0);
      assert(context);
      const deletion = createTableDeleteRowTransaction(initial, context, 0);
      assert(deletion);
      mounted.session.dispatch(deletion);

      // Target activeRow must be mapped to 0 (pointing to R1)!
      target = mounted.handle.view.state.field(tableTargetField, false);
      expect(target?.activeRow).toBe(0);

      // 3. Directly click delete-row button in Visual surface
      const delRowBtn = mounted.parent.querySelector('[data-table-action="delete-row"]') as HTMLButtonElement;
      assert(delRowBtn, 'Missing delete-row button');
      expect(delRowBtn.disabled).toBe(false);
      delRowBtn.click();

      // Must delete R1, leaving R2! Must NOT delete R2!
      const finalSource = mounted.session.getSnapshot().source;
      expect(finalSource).toContain('R2');
      expect(finalSource).not.toContain('R1');
      expect(finalSource).toBe('| A |\n| --- |\n| R2 |');
    } finally {
      mounted.cleanup();
    }
  });

  it('clears target and disables buttons when target column/row or whole table is deleted externally', () => {
    const initial = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const mounted = mountVisual(initial, 'p1-04r-f1-invalidation');
    try {
      // Activate col 1
      const thB = mounted.parent.querySelector('.cm-visual-table th[data-col="1"]') as HTMLElement;
      assert(thB);
      thB.click();

      let target = mounted.handle.view.state.field(tableTargetField, false);
      expect(target?.activeCol).toBe(1);

      // Delete column B externally
      const afterDelB = '| A |\n| --- |\n| 1 |';
      mounted.session.dispatch({
        changes: [{ from: 0, to: initial.length, insert: afterDelB }]
      });

      // Target must be cleared (null or activeCol null)
      target = mounted.handle.view.state.field(tableTargetField, false);
      expect(target?.activeCol ?? null).toBeNull();

      const delColBtn = mounted.parent.querySelector('[data-table-action="delete-column"]') as HTMLButtonElement;
      assert(delColBtn);
      expect(delColBtn.disabled).toBe(true);

      // Replace whole table with paragraph
      mounted.session.dispatch({
        changes: [{ from: 0, to: afterDelB.length, insert: 'Just a paragraph' }]
      });

      target = mounted.handle.view.state.field(tableTargetField, false);
      expect(target).toBeNull();
    } finally {
      mounted.cleanup();
    }
  });

  it('switches target between two tables and updates button disabled states accordingly', () => {
    const source = '| T1A | T1B |\n| --- | --- |\n| 1 | 2 |\n\n| T2A | T2B |\n| --- | --- |\n| 3 | 4 |';
    const mounted = mountVisual(source, 'p1-04r-f1-two-tables');
    try {
      const tables = mounted.parent.querySelectorAll('.cm-visual-table');
      expect(tables).toHaveLength(2);

      const t1 = tables[0]!;
      const t2 = tables[1]!;

      const t1DelCol = t1.closest('.cm-visual-table-container')?.querySelector('[data-table-action="delete-column"]') as HTMLButtonElement;
      const t2DelCol = t2.closest('.cm-visual-table-container')?.querySelector('[data-table-action="delete-column"]') as HTMLButtonElement;
      assert(t1DelCol && t2DelCol);

      expect(t1DelCol.disabled).toBe(true);
      expect(t2DelCol.disabled).toBe(true);

      // Click cell in Table 1
      const t1Th = t1.querySelector('th[data-col="1"]') as HTMLElement;
      t1Th.click();

      expect(t1DelCol.disabled).toBe(false);
      expect(t2DelCol.disabled).toBe(true);

      // Click cell in Table 2
      const t2Th = t2.querySelector('th[data-col="0"]') as HTMLElement;
      t2Th.click();

      expect(t1DelCol.disabled).toBe(true);
      expect(t2DelCol.disabled).toBe(false);
    } finally {
      mounted.cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // F2: Horizontal rule input box handles Space without parent intercepting
  // ---------------------------------------------------------------------------
  it('allows space keydown in horizontal rule editor without being prevented by container', () => {
    const source = 'Before\n\n---\n\nAfter';
    const mounted = mountVisual(source, 'p1-04r-f2-hr-space');
    try {
      const hrContainer = mounted.parent.querySelector('.cm-visual-hr-container') as HTMLElement;
      assert(hrContainer);

      // Activate via Enter key on container
      const enterOnContainer = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      hrContainer.dispatchEvent(enterOnContainer);
      expect(enterOnContainer.defaultPrevented).toBe(true);

      const input = hrContainer.querySelector('.cm-hr-editor') as HTMLInputElement;
      assert(input);

      // Dispatch Space keydown on input
      const spaceOnInput = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
      input.dispatchEvent(spaceOnInput);

      // Space on input MUST NOT be preventDefaulted!
      expect(spaceOnInput.defaultPrevented).toBe(false);

      // Edit to '* * *' and commit
      input.value = '* * *';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

      expect(mounted.session.getSnapshot().source).toBe('Before\n\n* * *\n\nAfter');
      expect(mounted.parent.querySelector('.cm-hr-editor')).toBeNull();
    } finally {
      mounted.cleanup();
    }
  });

  it('cancels hr edit on Escape or readOnly switch without adding history steps, restoring focus to container', () => {
    const source = 'Before\n\n---\n\nAfter';
    const mounted = mountVisual(source, 'p1-04r-f2-hr-cancel');
    try {
      const hrContainer = mounted.parent.querySelector('.cm-visual-hr-container') as HTMLElement;
      assert(hrContainer);
      hrContainer.click();

      const input = hrContainer.querySelector('.cm-hr-editor') as HTMLInputElement;
      assert(input);
      input.value = '*** changed ***';

      // Press Escape
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

      expect(mounted.session.getSnapshot().source).toBe(source);
      expect(mounted.session.canUndo).toBe(false);
      expect(mounted.parent.querySelector('.cm-hr-editor')).toBeNull();
      expect(document.activeElement).toBe(hrContainer);

      // Now enter edit again and switch readOnly
      hrContainer.click();
      const input2 = hrContainer.querySelector('.cm-hr-editor') as HTMLInputElement;
      assert(input2);
      // 未改动直接提交不应增加历史。
      input2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      expect(mounted.session.canUndo).toBe(false);
      hrContainer.click();

      setEditorReadOnly(mounted.handle.view, true);
      // 已处于只读时，鼠标与键盘入口都保持关闭。
      hrContainer.click();
      hrContainer.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));

      expect(mounted.parent.querySelector('.cm-hr-editor')).toBeNull();
      expect(mounted.session.getSnapshot().source).toBe(source);
      expect(mounted.session.canUndo).toBe(false);
    } finally {
      mounted.cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // F3: Horizontal rule in blockquote & list item for findDeepestBlockAtPos and collectDraggableBlocks
  // ---------------------------------------------------------------------------
  it('finds deepest block for horizontal rule in root, blockquote, and list item, distinguishing setext heading', () => {
    const source = [
      '---',
      '',
      '> ---',
      '',
      '- item 1',
      '',
      '  ---',
      '',
      'Setext Title',
      '---'
    ].join('\n');

    const parsed = parseMarkdown(source);

    // 1. Top-level hr at pos 0
    const topBlock = findDeepestBlockAtPos(parsed.root, 0, source);
    assert(topBlock);
    expect(topBlock.node.type).toBe('horizontal-rule');
    expect(topBlock.node.range.from).toBe(0);

    // 2. Blockquote hr at pos source.indexOf('> ---') + 2
    const bqHrPos = source.indexOf('> ---') + 2;
    const bqBlock = findDeepestBlockAtPos(parsed.root, bqHrPos, source);
    assert(bqBlock);
    expect(bqBlock.node.type).toBe('horizontal-rule');

    // 3. List item hr at pos source.indexOf('  ---') + 2
    const listHrPos = source.indexOf('  ---') + 2;
    const listBlock = findDeepestBlockAtPos(parsed.root, listHrPos, source);
    assert(listBlock, 'Expected to find hr inside list item');
    expect(listBlock.node.type).toBe('horizontal-rule');

    // 4. Setext heading at pos source.indexOf('Setext Title') should NOT be identified as horizontal-rule
    const setextPos = source.indexOf('Setext Title');
    const setextBlock = findDeepestBlockAtPos(parsed.root, setextPos, source);
    assert(setextBlock);
    expect(setextBlock.node.type).toBe('heading');

    // 5. collectDraggableBlocks should include list item's horizontal-rule
    const draggable = collectDraggableBlocks(parsed.root, source);
    // 逐一匹配真正的水平线范围，setext heading 不能凑足候选数量。
    for (const block of [topBlock, bqBlock, listBlock]) {
      expect(draggable).toContainEqual({ from: block.node.range.from, to: getContentEnd(source, block.node.range) });
      expect(source.slice(block.node.range.from, block.node.range.to)).toBe(block.node.raw);
    }
  });

  it.each([
    { label: 'root LF', source: 'Before\n\n  ---  \n\nAfter', expected: 'Before\n\n  * * *  \n\nAfter' },
    { label: 'blockquote CRLF', source: '> Before\r\n>\r\n> ---  \r\n>\r\n> After', expected: '> Before\r\n>\r\n> * * *  \r\n>\r\n> After' },
    { label: 'list CRLF', source: '- item\r\n\r\n  ---  \r\n\r\n  After', expected: '- item\r\n\r\n  * * *  \r\n\r\n  After' }
  ])('edits $label horizontal rule preserving whitespace and both surfaces through undo/redo', ({ source, expected }) => {
    const mounted = mountVisual(source, 'hr-source-preservation');
    const sourceParent = document.createElement('div');
    document.body.appendChild(sourceParent);
    const sourceHandle = createSessionEditorView({ session: mounted.session, surfaceId: 'hr-source-peer', surfaceKind: 'source', parent: sourceParent });
    try {
      const container = mounted.parent.querySelector<HTMLElement>('.cm-visual-hr-container');
      assert(container);
      container.focus();
      container.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
      const input = container.querySelector<HTMLInputElement>('.cm-hr-editor');
      assert(input);
      input.value = '* * *';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      expect(mounted.session.getSnapshot().source).toBe(expected);
      expect(mounted.session.getSnapshot().revision).toBe(1);
      expect(sourceHandle.view.state.doc.toString()).toBe(expected);
      expect(mounted.session.undo()).toBe(true);
      expect(mounted.session.getSnapshot().source).toBe(source);
      expect(mounted.handle.view.state.doc.toString()).toBe(source);
      expect(sourceHandle.view.state.doc.toString()).toBe(source);
      expect(mounted.session.redo()).toBe(true);
      expect(mounted.session.getSnapshot().source).toBe(expected);
      expect(mounted.handle.view.state.doc.toString()).toBe(expected);
      expect(sourceHandle.view.state.doc.toString()).toBe(expected);
    } finally {
      sourceHandle.destroy();
      sourceParent.remove();
      mounted.cleanup();
    }
  });

  it('reorders a nested horizontal rule through the block transaction and restores both surfaces', () => {
    const source = '- item\n\n  ***\n\n  ### After';
    const expected = '- item\n\n  ### After\n\n  ***';
    const mounted = mountVisual(source, 'hr-reorder');
    const sourceParent = document.createElement('div');
    const sourceHandle = createSessionEditorView({ session: mounted.session, surfaceId: 'hr-reorder-source', surfaceKind: 'source', parent: sourceParent });
    try {
      const transaction = createReorderBlockToPositionTransaction(source, source.indexOf('***'), source.indexOf('After'));
      assert(transaction);
      mounted.session.dispatch(transaction);
      expect(mounted.session.getSnapshot().source).toBe(expected);
      expect(sourceHandle.view.state.doc.toString()).toBe(expected);
      expect(mounted.session.undo()).toBe(true);
      expect(mounted.handle.view.state.doc.toString()).toBe(source);
      expect(sourceHandle.view.state.doc.toString()).toBe(source);
      expect(mounted.session.redo()).toBe(true);
      expect(mounted.handle.view.state.doc.toString()).toBe(expected);
      expect(sourceHandle.view.state.doc.toString()).toBe(expected);
    } finally {
      sourceHandle.destroy();
      mounted.cleanup();
    }
  });
});
