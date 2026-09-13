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

    it('includes required keybindings for undo, redo, and search', () => {
      const keys = editorKeybindings.map((k) => k.key).filter(Boolean);

      expect(keys).toContain('Mod-z');
      expect(keys).toContain('Mod-f');
      expect(keys).toContain('Mod-h');
      expect(keys).toContain('Mod-Shift-f');
      expect(keys).toContain('Escape');
    });
  });

  describe('Selection info calculation', () => {
    it('calculates line 1, column 1 at document beginning', () => {
      const state = createSourceEditorState({ doc: 'Line 1\nLine 2\nLine 3' });
      const info = getSelectionInfo(state);

      expect(info).toEqual({
        line: 1,
        column: 1,
        selectedTextLength: 0
      });
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

    it('matches headings when user types #', () => {
      const state = createSourceEditorState({ doc: '#' });
      const context = new CompletionContext(state, 1, false);
      const result = markdownCompletionSource(context);

      expect(result).not.toBeNull();
      const labels = result!.options.map((o) => o.label);
      expect(labels.some((l) => l.includes('Heading'))).toBe(true);
    });

    it('matches code block when user types code', () => {
      const state = createSourceEditorState({ doc: 'code' });
      const context = new CompletionContext(state, 4, false);
      const result = markdownCompletionSource(context);

      expect(result).not.toBeNull();
      const labels = result!.options.map((o) => o.label);
      expect(labels.some((l) => l.includes('Code Block'))).toBe(true);
    });

    it('matches wikilink snippets when the user types [[', () => {
      const state = createSourceEditorState({ doc: '[[' });
      const context = new CompletionContext(state, 2, false);
      const result = markdownCompletionSource(context);

      expect(result).not.toBeNull();
      const labels = result!.options.map((o) => o.label);
      expect(labels.some((l) => l.includes('Wikilink'))).toBe(true);
    });

    it('returns null for non-matching queries without explicit trigger', () => {
      const state = createSourceEditorState({ doc: 'xyz123randomnonexistent' });
      const context = new CompletionContext(state, 23, false);
      const result = markdownCompletionSource(context);

      expect(result).toBeNull();
    });
  });
});
