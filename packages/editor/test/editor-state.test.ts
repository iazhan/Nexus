import { describe, it, expect } from 'vitest';
import { EditorSelection, Transaction } from '@codemirror/state';
import { undo, redo } from '@codemirror/commands';
import { CompletionContext } from '@codemirror/autocomplete';

import {
  createSourceEditorState,
  createMarkdownCompletionSource,
  getSelectionInfo,
  markdownSnippets,
  editorKeybindings,
  type EditorView
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
    /**
     * 一个假宿主。真清单由 renderer 从 `BLOCK_FORMAT_SPECS` 投影 ——
     * 编辑器这一层只认「宿主给了哪几条、`run` 收到什么」。
     */
    const hostEntries = [
      { commandId: 'format.heading-2', tokens: ['h2', 'heading 2'], label: '标题 2' },
      { commandId: 'format.code-block', tokens: ['code', 'fence'], label: '代码块' }
    ];

    function source(entries = hostEntries, run = () => {}) {
      return createMarkdownCompletionSource({ entries: () => entries, run });
    }

    it('片段表里只剩内容级模板 —— 块级结构由宿主注入，不再抄第二份', () => {
      const labels = markdownSnippets.map((s) => s.label);

      // 正面：五条没有命令对应的模板还在（两条链接模板是刻意留的）。
      expect(labels).toEqual([
        '$$ Block Math',
        '$ Inline Math',
        '[[ Wikilink',
        '[] Markdown Link',
        '![] Image'
      ]);
      // 反面：块级结构**不在**模板表里 —— 它们住在注册表里，抄一份就是两条会各自漂的清单。
      for (const gone of ['# Heading 1', '``` Code Block', '| Table', '- Bullet List']) {
        expect(labels).not.toContain(gone);
      }
    });

    it('returns completion options on explicit invocation', () => {
      const state = createSourceEditorState({ doc: '' });
      const context = new CompletionContext(state, 0, true);
      const result = createMarkdownCompletionSource()(context);

      expect(result).not.toBeNull();
      expect(result!.options.length).toBeGreaterThan(0);
    });

    it('命令级动作排在模板前面 —— 块级改型才是 `/` 面板的主要用途', () => {
      const state = createSourceEditorState({ doc: '/' });
      const context = new CompletionContext(state, 1, false);
      const result = source()(context);

      const labels = result!.options.map((o) => o.label);
      expect(labels.slice(0, 2)).toEqual(['标题 2', '代码块']);
      expect(labels).toContain('[[ Wikilink');
    });

    it('触发词是英文，与界面语言无关 —— 中文标签一个字也匹配不上 `/h2`', () => {
      const state = createSourceEditorState({ doc: '/h2' });
      const context = new CompletionContext(state, 3, false);
      const result = source()(context);

      expect(result!.options.map((o) => o.label)).toEqual(['标题 2']);
    });

    it('一个动作可以带多个触发词：`/code` 与 `/fence` 都命中代码块', () => {
      for (const doc of ['/code', '/fence']) {
        const state = createSourceEditorState({ doc });
        const context = new CompletionContext(state, doc.length, false);
        expect(source()(context)!.options.map((o) => o.label)).toEqual(['代码块']);
      }
    });

    it('标签也参与匹配 —— 英文界面下 `/head` 命中「Heading 2」', () => {
      // 触发词是 `h2`，`/head` 只可能靠标签命中。中文标签（「标题 2」）走不到这一支：
      // `matchBefore` 的字符组不含 CJK，`/标题` 连查询串都取不出来 —— 这也是触发词必须
      // 单独给一份的理由。
      const latin = [{ commandId: 'format.heading-2', tokens: ['h2'], label: 'Heading 2' }];
      const state = createSourceEditorState({ doc: '/head' });
      const context = new CompletionContext(state, 5, false);
      expect(source(latin)(context)!.options.map((o) => o.label)).toEqual(['Heading 2']);
    });

    it('宿主缺省时只剩模板 —— 面板不会因为没注入就整个空掉', () => {
      const state = createSourceEditorState({ doc: '/wiki' });
      const context = new CompletionContext(state, 5, false);
      const result = createMarkdownCompletionSource()(context);

      expect(result!.options.map((o) => o.label)).toEqual(['[[ Wikilink']);
    });

    it('选中一项 → 把命令 id 与 `/查询` 的范围原样交给宿主，编辑器自己不碰正文', () => {
      const calls: unknown[][] = [];
      const state = createSourceEditorState({ doc: '/h2' });
      const context = new CompletionContext(state, 3, false);
      const option = source(hostEntries, (...args: unknown[]) => calls.push(args))(context)!
        .options[0]!;

      const view = {} as unknown as EditorView;
      (option.apply as (v: unknown, c: unknown, from: number, to: number) => void)(
        view,
        option,
        0,
        3
      );

      expect(calls).toEqual([[view, 'format.heading-2', 0, 3]]);
    });

    it('stays closed for plain words and markdown symbols so Enter keeps its meaning', () => {
      // 输入正文单词（如 table / code）或 Markdown 符号（如 |、#）时不能弹窗，
      // 否则补全面板会抢走 Enter，用户想换行却插入整段模板。
      for (const doc of ['table', 'code', '|', '#', '>', '[[']) {
        const state = createSourceEditorState({ doc });
        const context = new CompletionContext(state, doc.length, false);
        expect(source()(context)).toBeNull();
      }
    });

    it('returns null for non-matching queries without explicit trigger', () => {
      const state = createSourceEditorState({ doc: 'xyz123randomnonexistent' });
      const context = new CompletionContext(state, 23, false);
      const result = source()(context);

      expect(result).toBeNull();
    });
  });
});
