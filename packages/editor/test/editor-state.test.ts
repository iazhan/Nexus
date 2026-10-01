import { describe, it, expect } from 'vitest';
import { EditorSelection, Transaction } from '@codemirror/state';
import { undo, redo } from '@codemirror/commands';
import { CompletionContext } from '@codemirror/autocomplete';

import {
  createSourceEditorState,
  getSelectionInfo,
  markdownCompletionSource,
  markdownSnippets,
  editorKeybindings
} from '../src/index.js';

describe('CodeMirror 6 Source Editor Core Logic', () => {
  describe('EditorState creation & Markdown loading', () => {
    it('creates an EditorState with initial Markdown content', () => {
      const doc = '# Welcome to Nexus\n\nThis is **Markdown** text.';
      const state = createSourceEditorState({ doc });

      expect(state.doc.toString()).toBe(doc);
      expect(state.doc.lines).toBe(3);
    });

    it('creates an empty EditorState when no doc is passed', () => {
      const state = createSourceEditorState({});
      expect(state.doc.toString()).toBe('');
      expect(state.doc.lines).toBe(1);
    });
  });

  describe('Document changes and transactions', () => {
    it('captures text insertions and updates document state', () => {
      let state = createSourceEditorState({ doc: 'Initial' });
      state = state.update({
        changes: { from: 7, insert: ' content' }
      }).state;

      expect(state.doc.toString()).toBe('Initial content');
    });

    it('captures deletions and replacements', () => {
      let state = createSourceEditorState({ doc: 'Hello World' });
      state = state.update({
        changes: { from: 6, to: 11, insert: 'Nexus' }
      }).state;

      expect(state.doc.toString()).toBe('Hello Nexus');
    });
  });

  describe('Undo / Redo History', () => {
    it('executes undo and redo transactions through history extension', () => {
      let state = createSourceEditorState({ doc: 'Step 1' });
      const dispatch = (tr: Transaction) => {
        state = tr.state;
      };

      // Step 2: insert text
      dispatch(state.update({ changes: { from: 6, insert: ' -> Step 2' } }));
      expect(state.doc.toString()).toBe('Step 1 -> Step 2');

      // Undo Step 2
      const undone = undo({ state, dispatch });
      expect(undone).toBe(true);
      expect(state.doc.toString()).toBe('Step 1');

      // Redo Step 2
      const redone = redo({ state, dispatch });
      expect(redone).toBe(true);
      expect(state.doc.toString()).toBe('Step 1 -> Step 2');
    });

    it('保留撤销 / 重做，把查找 / 替换让给宿主', () => {
      const keys = editorKeybindings.map((k) => k.key).filter(Boolean);

      expect(keys).toContain('Mod-z');
      expect(keys).toContain('Escape');
      // 查找 / 替换归宿主：编辑器里再留一份会让「在设置页改了绑定、光标在编辑器里时仍是旧键
      // 生效」—— CM 的 keymap 先跑并 `preventDefault()`，宿主收不到事件。
      expect(keys).not.toContain('Mod-f');
      expect(keys).not.toContain('Mod-h');
      expect(keys).not.toContain('Mod-Shift-f');
    });
  });

  describe('Selection info calculation', () => {
    it('calculates line 1, column 1 at document beginning', () => {
      const state = createSourceEditorState({ doc: 'Line 1\nLine 2\nLine 3' });
      const info = getSelectionInfo(state);

      expect(info).toEqual({
        line: 1,
        column: 1,
        selectedTextLength: 0,
        head: 0
      });
    });

    it('reports the caret offset alongside line and column', () => {
      // `head` 是给「和文档区间比大小」用的（大纲判当前在第几节），
      // 它必须和 line/column 说的是同一个位置
      const doc = 'Line 1\nLine 2\nLine 3';
      const state = createSourceEditorState({ doc }).update({
        selection: EditorSelection.cursor(12)
      }).state;

      const info = getSelectionInfo(state);
      expect(info.head).toBe(12);
      expect(doc.slice(0, info.head)).toBe('Line 1\nLine ');
    });

    it('calculates correct line and column on subsequent lines', () => {
      const doc = 'Line 1\nLine 2\nLine 3';
      let state = createSourceEditorState({ doc });

      // Move cursor to "Line 2", after "Line " (offset 7 + 5 = 12)
      // "Line 1\n" is 7 chars. Line 2 starts at 7. Offset 12 is after "Line "
      state = state.update({
        selection: EditorSelection.cursor(12)
      }).state;

      const info = getSelectionInfo(state);
      expect(info.line).toBe(2);
      expect(info.column).toBe(6);
      expect(info.selectedTextLength).toBe(0);
    });

    it('calculates selected text length for ranges', () => {
      const doc = 'The quick brown fox';
      let state = createSourceEditorState({ doc });

      // Select "quick brown" (from 4 to 15, length 11)
      state = state.update({
        selection: EditorSelection.range(4, 15)
      }).state;

      const info = getSelectionInfo(state);
      expect(info.line).toBe(1);
      expect(info.selectedTextLength).toBe(11);
    });
  });

  describe('Markdown Autocompletion Source', () => {
    it('provides predefined markdown snippet structures', () => {
      expect(markdownSnippets.length).toBeGreaterThan(5);
      const labels = markdownSnippets.map((s) => s.label);

      expect(labels).toContain('# Heading 1');
      expect(labels).toContain('``` Code Block');
      expect(labels).toContain('$$ Block Math');
      expect(labels).toContain('[[ Wikilink');
      expect(labels).toContain('| Table');
    });

    it('returns completion options on explicit invocation', () => {
      const state = createSourceEditorState({ doc: '' });
      const context = new CompletionContext(state, 0, true);
      const result = markdownCompletionSource(context);

      expect(result).not.toBeNull();
      expect(result!.options.length).toBeGreaterThan(0);
    });

    it('matches headings after the slash command prefix /head', () => {
      const state = createSourceEditorState({ doc: '/head' });
      const context = new CompletionContext(state, 5, false);
      const result = markdownCompletionSource(context);

      expect(result).not.toBeNull();
      const labels = result!.options.map((o) => o.label);
      expect(labels.some((l) => l.includes('Heading'))).toBe(true);
    });

    it('matches code block after the slash command prefix /code', () => {
      const state = createSourceEditorState({ doc: '/code' });
      const context = new CompletionContext(state, 5, false);
      const result = markdownCompletionSource(context);

      expect(result).not.toBeNull();
      const labels = result!.options.map((o) => o.label);
      expect(labels.some((l) => l.includes('Code Block'))).toBe(true);
    });

    it('matches wikilink snippets after the slash command prefix /wiki', () => {
      const state = createSourceEditorState({ doc: '/wiki' });
      const context = new CompletionContext(state, 5, false);
      const result = markdownCompletionSource(context);

      expect(result).not.toBeNull();
      const labels = result!.options.map((o) => o.label);
      expect(labels.some((l) => l.includes('Wikilink'))).toBe(true);
    });

    it('stays closed for plain words and markdown symbols so Enter keeps its meaning', () => {
      // 输入正文单词（如 table / code）或 Markdown 符号（如 |、#）时不能弹窗，
      // 否则补全面板会抢走 Enter，用户想换行却插入整段模板。
      for (const doc of ['table', 'code', '|', '#', '>', '[[']) {
        const state = createSourceEditorState({ doc });
        const context = new CompletionContext(state, doc.length, false);
        expect(markdownCompletionSource(context)).toBeNull();
      }
    });

    it('returns null for non-matching queries without explicit trigger', () => {
      const state = createSourceEditorState({ doc: 'xyz123randomnonexistent' });
      const context = new CompletionContext(state, 23, false);
      const result = markdownCompletionSource(context);

      expect(result).toBeNull();
    });
  });
});
