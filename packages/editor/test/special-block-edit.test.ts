// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { parseMarkdown, type MarkdownBlockNode } from '@nexus/markdown';
import {
  MarkdownDocumentSession,
  createSessionEditorView,
  setEditorReadOnly,
  parseBlockMathContext,
  createBlockMathEditTransaction,
  applyChangesToSource
} from '../src/index.js';

describe('P1-04E Special Block Edit (Block Math & Raw Fallbacks)', () => {
  describe('A. Block Math Editing', () => {
    const mathSource = [
      '# Math Document',
      '',
      '$$',
      '\\int_{0}^{\\infty} e^{-x} dx = 1',
      '$$',
      '',
      'Paragraph after math.'
    ].join('\n');

    it('extracts formula and indentation from block math node', () => {
      const parsed = parseMarkdown(mathSource);
      const mathNode = parsed.root.children.find((c) => c.type === 'block-math')!;
      expect(mathNode).toBeDefined();

      const context = parseBlockMathContext(mathSource, mathNode as Extract<MarkdownBlockNode, { type: 'block-math' }>);
      expect(context.formula.trim()).toBe('\\int_{0}^{\\infty} e^{-x} dx = 1');
      expect(context.indent).toBe('');
    });

    it('modifies block math formula and preserves delimiters and surrounding source', () => {
      const parsed = parseMarkdown(mathSource);
      const mathNode = parsed.root.children.find((c) => c.type === 'block-math')!;
      const context = parseBlockMathContext(mathSource, mathNode as Extract<MarkdownBlockNode, { type: 'block-math' }>);

      const tx = createBlockMathEditTransaction(mathSource, context, 'E = mc^2');
      expect(tx).not.toBeNull();
      expect(tx!.userEvent).toBe('block-math.edit');

      const next = applyChangesToSource(mathSource, tx!.changes);
      expect(next).toContain('$$\nE = mc^2\n$$');
      expect(next).toContain('Paragraph after math.');
    });

    it('preserves indentation for indented block math', () => {
      const indentedSource = '  $$\n  a^2 + b^2 = c^2\n  $$';
      const parsed = parseMarkdown(indentedSource);
      const mathNode = parsed.root.children.find((c) => c.type === 'block-math')!;
      const context = parseBlockMathContext(indentedSource, mathNode as Extract<MarkdownBlockNode, { type: 'block-math' }>);

      const tx = createBlockMathEditTransaction(indentedSource, context, 'x + y = z');
      expect(tx).not.toBeNull();

      const next = applyChangesToSource(indentedSource, tx!.changes);
      expect(next).toBe('  $$\n  x + y = z\n  $$');
    });

    it('edits block math nested inside blockquotes', () => {
      const nestedSource = [
        '> $$',
        '> \\alpha + \\beta = \\gamma',
        '> $$'
      ].join('\n');

      const parsed = parseMarkdown(nestedSource);
      const bq = parsed.root.children.find((c) => c.type === 'blockquote') as Extract<
        MarkdownBlockNode,
        { type: 'blockquote' }
      >;
      expect(bq).toBeDefined();
      const bqMath = bq.children.find((c) => c.type === 'block-math') as Extract<
        MarkdownBlockNode,
        { type: 'block-math' }
      >;
      expect(bqMath).toBeDefined();

      const bqCtx = parseBlockMathContext(nestedSource, bqMath);
      const bqTx = createBlockMathEditTransaction(nestedSource, bqCtx, '\\alpha = \\gamma - \\beta');
      expect(bqTx).not.toBeNull();
    });
  });

  describe('B. Raw HTML & Unknown Special Blocks Safe Strategy', () => {
    it('treats unknown raw HTML as unexecutable and does not inject into DOM directly', () => {
      const htmlSource = '<div class="custom-block"><script>alert(1)</script>Hello</div>';
      const parsed = parseMarkdown(htmlSource);
      const rawNode = parsed.root.children.find((c) => c.type === 'raw');
      expect(rawNode).toBeDefined();
      // Opaque raw block must be preserved without script execution
      expect(rawNode!.raw).toBe(htmlSource);
    });
  });

  describe('C. Visual Surface DOM Editing for Math & Raw Blocks', () => {
    it('enters block math formula editing on click and commits changes via transaction', () => {
      const mathSource = '$$\nE = mc^2\n$$\n\nAfter math.';
      const session = new MarkdownDocumentSession(mathSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'math-edit-vis',
        surfaceKind: 'visual',
        parent
      });

      const mathEl = handle.view.dom.querySelector('.cm-visual-block-math') as HTMLElement;
      expect(mathEl).not.toBeNull();

      // Click to enter edit mode
      mathEl.click();

      const textarea = handle.view.dom.querySelector('.cm-block-math-editor') as HTMLTextAreaElement | null;
      expect(textarea).not.toBeNull();
      expect(textarea!.value.trim()).toBe('E = mc^2');

      const initialRev = session.getSnapshot().revision;
      textarea!.value = 'E = \\frac{m c^2}{\\sqrt{1 - v^2/c^2}}';
      textarea!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));

      expect(session.getSnapshot().revision).toBe(initialRev + 1);
      expect(session.getSnapshot().source).toContain('E = \\frac{m c^2}{\\sqrt{1 - v^2/c^2}}');

      session.undo();
      expect(session.getSnapshot().source).toBe(mathSource);

      handle.destroy();
      parent.remove();
    });

    it('enters raw block source editing on click and commits changes via transaction', () => {
      const rawSource = '<div class="custom-widget">\n<span>Preview</span>\n</div>\n\nAfter raw.';
      const session = new MarkdownDocumentSession(rawSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'raw-edit-vis',
        surfaceKind: 'visual',
        parent
      });

      const rawEl = handle.view.dom.querySelector('.cm-visual-raw-block') as HTMLElement;
      expect(rawEl).not.toBeNull();

      rawEl.click();

      const textarea = handle.view.dom.querySelector('.cm-raw-block-editor') as HTMLTextAreaElement | null;
      expect(textarea).not.toBeNull();
      expect(textarea!.value).toBe('<div class="custom-widget">\n<span>Preview</span>\n</div>');

      const initialRev = session.getSnapshot().revision;
      textarea!.value = '<div class="custom-widget-v2">Updated</div>';
      textarea!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));

      expect(session.getSnapshot().revision).toBe(initialRev + 1);
      expect(session.getSnapshot().source).toContain('<div class="custom-widget-v2">Updated</div>');

      session.undo();
      expect(session.getSnapshot().source).toBe(rawSource);

      handle.destroy();
      parent.remove();
    });

    it('does not open math or raw editor when surface is readOnly', () => {
      const session = new MarkdownDocumentSession('$$\nx = 1\n$$\n\n<div class="test">raw</div>');
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'math-raw-ro',
        surfaceKind: 'visual',
        readOnly: true,
        parent
      });

      const mathEl = handle.view.dom.querySelector('.cm-visual-block-math') as HTMLElement;
      mathEl?.click();
      expect(handle.view.dom.querySelector('.cm-block-math-editor')).toBeNull();

      const rawEl = handle.view.dom.querySelector('.cm-visual-raw-block') as HTMLElement;
      rawEl?.click();
      expect(handle.view.dom.querySelector('.cm-raw-block-editor')).toBeNull();

      handle.destroy();
      parent.remove();
    });

    it('rejects candidate edit when newFormula is malformed or changes parsed formula unexpectedly', () => {
      const mathSource = '$$\nx = 1\n$$';
      const parsed = parseMarkdown(mathSource);
      const mathNode = parsed.root.children.find((c) => c.type === 'block-math') as Extract<
        MarkdownBlockNode,
        { type: 'block-math' }
      >;
      const ctx = parseBlockMathContext(mathSource, mathNode);

      // Malformed formula with premature $$ delimiter inside that splits or breaks parsing
      const brokenTx = createBlockMathEditTransaction(mathSource, ctx, 'x = 1\n$$\nnew paragraph\n$$');
      expect(brokenTx).toBeNull();
    });

    it('accepts valid formulas with escaped \\$\\$, single $, and multi-line formulas without premature closing', () => {
      const mathSource = '$$\nE = mc^2\n$$';
      const parsed = parseMarkdown(mathSource);
      const mathNode = parsed.root.children.find((c) => c.type === 'block-math') as Extract<
        MarkdownBlockNode,
        { type: 'block-math' }
      >;
      const ctx = parseBlockMathContext(mathSource, mathNode);

      // 1. Escaped \$\$
      const txEscaped = createBlockMathEditTransaction(mathSource, ctx, 'x \\$\\$ y');
      expect(txEscaped).not.toBeNull();
      const nextEscaped = applyChangesToSource(mathSource, txEscaped!.changes);
      expect(nextEscaped).toBe('$$\nx \\$\\$ y\n$$');

      // 2. Literal $$ within LaTeX text/command that does not break the block
      const txTextDollars = createBlockMathEditTransaction(mathSource, ctx, '\\text{$$}');
      expect(txTextDollars).not.toBeNull();

      // 3. Single ordinary dollar signs $
      const txDollar = createBlockMathEditTransaction(mathSource, ctx, 'cost = $100 + $200');
      expect(txDollar).not.toBeNull();

      // 3. Multi-line formula
      const txMulti = createBlockMathEditTransaction(mathSource, ctx, 'f(x) = x^2\ng(x) = y^2');
      expect(txMulti).not.toBeNull();
    });

    it('treats unclosed $$ as opaque paragraph in real parseMarkdown and Visual Surface, never synthesizing closing delimiter', () => {
      const unclosedSource = '$$\nx = 1\n';
      // 1. Real parseMarkdown must NOT classify this as block-math
      const parsed = parseMarkdown(unclosedSource);
      const mathNode = parsed.root.children.find((c) => c.type === 'block-math');
      expect(mathNode).toBeUndefined();
      const pNode = parsed.root.children.find((c) => c.type === 'paragraph');
      expect(pNode).toBeDefined();

      // 2. Real Visual Surface must NOT render .cm-visual-block-math widget
      const session = new MarkdownDocumentSession(unclosedSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'unclosed-math-visual',
        surfaceKind: 'visual',
        parent
      });

      expect(handle.view.dom.querySelector('.cm-visual-block-math')).toBeNull();
      expect(handle.view.dom.querySelector('.cm-block-math-editor')).toBeNull();
      // Real source remains untouched without synthetic closing delimiter
      expect(session.getSnapshot().source).toBe(unclosedSource);
      expect(handle.view.state.doc.toString()).toBe(unclosedSource);

      handle.destroy();
      parent.remove();
    });

    it('dynamically closes active .cm-block-math-editor and .cm-raw-block-editor when readOnly is toggled, rejecting stale Enter', () => {
      const docSource = '$$\nE = mc^2\n$$\n\n<div class="box">hello</div>';
      const session = new MarkdownDocumentSession(docSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-math-raw-ro-lifecycle',
        surfaceKind: 'visual',
        parent
      });

      // 1. Math editor
      const mathEl = handle.view.dom.querySelector('.cm-visual-block-math') as HTMLElement;
      expect(mathEl).not.toBeNull();
      mathEl.click();
      const mathTextarea = handle.view.dom.querySelector('.cm-block-math-editor') as HTMLTextAreaElement;
      expect(mathTextarea).not.toBeNull();
      mathTextarea.value = 'E = 0';

      // Toggle readOnly = true
      setEditorReadOnly(handle.view, true);
      expect(handle.view.dom.querySelector('.cm-block-math-editor')).toBeNull();

      // Stale Enter
      mathTextarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      expect(session.getSnapshot().source).not.toContain('E = 0');

      // 2. Raw block editor: toggle back to editable
      setEditorReadOnly(handle.view, false);
      const rawEl = handle.view.dom.querySelector('.cm-visual-raw-block') as HTMLElement;
      expect(rawEl).not.toBeNull();
      rawEl.click();
      const rawTextarea = handle.view.dom.querySelector('.cm-raw-block-editor') as HTMLTextAreaElement;
      expect(rawTextarea).not.toBeNull();
      rawTextarea.value = '<div class="box">modified</div>';

      // Toggle readOnly = true
      setEditorReadOnly(handle.view, true);
      expect(handle.view.dom.querySelector('.cm-raw-block-editor')).toBeNull();

      // Stale Enter
      rawTextarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      expect(session.getSnapshot().source).not.toContain('modified');

      handle.destroy();
      parent.remove();
    });

    it('supports multi-line block math with trailing EOF newline', () => {
      const eofMath = '$$\nx = 1\n$$\n';
      const parsed = parseMarkdown(eofMath);
      const node = parsed.root.children.find((c) => c.type === 'block-math') as Extract<MarkdownBlockNode, { type: 'block-math' }>;
      expect(node).toBeDefined();

      const ctx = parseBlockMathContext(eofMath, node);
      expect(ctx.hasClosing).toBe(true);

      const tx = createBlockMathEditTransaction(eofMath, ctx, 'x = 2');
      expect(tx).not.toBeNull();
      const next = applyChangesToSource(eofMath, tx!.changes);
      expect(next).toBe('$$\nx = 2\n$$\n');
    });

    it('supports single-line $$formula$$ and preserves single-line format upon edit', () => {
      // 1. Without trailing newline
      const singleSource = '$$x + y$$';
      const parsed1 = parseMarkdown(singleSource);
      const node1 = parsed1.root.children.find((c) => c.type === 'block-math') as Extract<MarkdownBlockNode, { type: 'block-math' }>;
      expect(node1).toBeDefined();

      const ctx1 = parseBlockMathContext(singleSource, node1);
      expect(ctx1.hasClosing).toBe(true);

      const tx1 = createBlockMathEditTransaction(singleSource, ctx1, 'a + b');
      expect(tx1).not.toBeNull();
      const next1 = applyChangesToSource(singleSource, tx1!.changes);
      expect(next1).toBe('$$a + b$$');

      // 2. With trailing newline
      const singleWithNl = '$$x + y$$\n';
      const parsed2 = parseMarkdown(singleWithNl);
      const node2 = parsed2.root.children.find((c) => c.type === 'block-math') as Extract<MarkdownBlockNode, { type: 'block-math' }>;
      const ctx2 = parseBlockMathContext(singleWithNl, node2);
      expect(ctx2.hasClosing).toBe(true);

      const tx2 = createBlockMathEditTransaction(singleWithNl, ctx2, 'c + d');
      expect(tx2).not.toBeNull();
      const next2 = applyChangesToSource(singleWithNl, tx2!.changes);
      expect(next2).toBe('$$c + d$$\n');
    });

    it('preserves formula with leading/trailing whitespace without false rejection', () => {
      const source = '$$\nx = 1\n$$';
      const parsed = parseMarkdown(source);
      const node = parsed.root.children.find((c) => c.type === 'block-math') as Extract<MarkdownBlockNode, { type: 'block-math' }>;
      const ctx = parseBlockMathContext(source, node);

      const tx = createBlockMathEditTransaction(source, ctx, '   \\alpha + \\beta   ');
      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('$$\n   \\alpha + \\beta   \n$$');
    });

    it('preserves single-line and multi-line formats in nested blockquotes with CRLF', () => {
      // 1. Single-line in blockquote with CRLF
      const bqSingle = '> $$x + y$$\r\n';
      const parsedBq1 = parseMarkdown(bqSingle);
      const bqNode1 = parsedBq1.root.children[0] as Extract<MarkdownBlockNode, { type: 'blockquote' }>;
      const mathChild1 = bqNode1.children.find((c) => c.type === 'block-math') as Extract<MarkdownBlockNode, { type: 'block-math' }>;
      expect(mathChild1).toBeDefined();

      const ctxBq1 = parseBlockMathContext(bqSingle, mathChild1);
      expect(ctxBq1.hasClosing).toBe(true);

      const txBq1 = createBlockMathEditTransaction(bqSingle, ctxBq1, 'p + q');
      expect(txBq1).not.toBeNull();
      const nextBq1 = applyChangesToSource(bqSingle, txBq1!.changes);
      expect(nextBq1).toBe('> $$p + q$$\r\n');

      // 2. Multi-line in blockquote with CRLF
      const bqMulti = '> $$\r\n> x + y\r\n> $$\r\n';
      const parsedBq2 = parseMarkdown(bqMulti);
      const bqNode2 = parsedBq2.root.children[0] as Extract<MarkdownBlockNode, { type: 'blockquote' }>;
      const mathChild2 = bqNode2.children.find((c) => c.type === 'block-math') as Extract<MarkdownBlockNode, { type: 'block-math' }>;
      expect(mathChild2).toBeDefined();

      const ctxBq2 = parseBlockMathContext(bqMulti, mathChild2);
      expect(ctxBq2.hasClosing).toBe(true);

      const txBq2 = createBlockMathEditTransaction(bqMulti, ctxBq2, 'm + n');
      expect(txBq2).not.toBeNull();
      const nextBq2 = applyChangesToSource(bqMulti, txBq2!.changes);
      expect(nextBq2).toBe('> $$\r\n> m + n\r\n> $$\r\n');
    });

    it('preserves single-line format when editing formula with leading/trailing whitespace', () => {
      const single = '$$x + y$$';
      const parsed = parseMarkdown(single);
      const node = parsed.root.children.find((c) => c.type === 'block-math') as Extract<MarkdownBlockNode, { type: 'block-math' }>;
      const ctx = parseBlockMathContext(single, node);
      expect(ctx.isSingleLine).toBe(true);

      const tx = createBlockMathEditTransaction(single, ctx, '  a + b  ');
      expect(tx).not.toBeNull();
      const next = applyChangesToSource(single, tx!.changes);
      // Must remain single-line without transforming into multi-line
      expect(next).toBe('$$  a + b  $$');
    });

    it('preserves original single-line formula whitespace when the value is unchanged', () => {
      const source = '$$  x + y  $$\n';
      const parsed = parseMarkdown(source);
      const node = parsed.root.children.find((c) => c.type === 'block-math') as Extract<MarkdownBlockNode, { type: 'block-math' }>;
      const ctx = parseBlockMathContext(source, node);

      const tx = createBlockMathEditTransaction(source, ctx, '  x + y  ');
      expect(tx).not.toBeNull();
      expect(applyChangesToSource(source, tx!.changes)).toBe(source);
    });

    it('preserves delimiter-line whitespace and CRLF when editing a multi-line formula', () => {
      const source = '$$  \r\nx = 1\r\n$$\t  \r\n';
      const parsed = parseMarkdown(source);
      const node = parsed.root.children.find((c) => c.type === 'block-math') as Extract<MarkdownBlockNode, { type: 'block-math' }>;
      const context = parseBlockMathContext(source, node);

      expect(context.openingLineRaw).toBe('$$  ');
      expect(context.closingLineRaw).toBe('$$\t  ');

      const tx = createBlockMathEditTransaction(source, context, 'x = 2');
      expect(tx).not.toBeNull();
      expect(applyChangesToSource(source, tx!.changes)).toBe('$$  \r\nx = 2\r\n$$\t  \r\n');
    });

    it('rejects candidate edit when formula splits into multiple math blocks or plain text', () => {
      const source = '$$\nx = 1\n$$';
      const parsed = parseMarkdown(source);
      const node = parsed.root.children.find((c) => c.type === 'block-math') as Extract<MarkdownBlockNode, { type: 'block-math' }>;
      const ctx = parseBlockMathContext(source, node);

      // Formula with unescaped closing delimiter followed by plain paragraph and another formula
      const splitFormula = 'x = 1\n$$\n\nThis is plain text\n\n$$\ny = 2';
      const tx = createBlockMathEditTransaction(source, ctx, splitFormula);
      expect(tx).toBeNull();

      // Formula with unescaped closing delimiter on its own line followed by plain text
      const prematureFormula = 'x = 1\n$$\nplain text';
      const txPremature = createBlockMathEditTransaction(source, ctx, prematureFormula);
      expect(txPremature).toBeNull();
    });

    it('returns null when attempting to edit an unclosed block math context', () => {
      const mockUnclosedCtx: BlockMathContext = {
        range: { from: 0, to: 10 },
        raw: '$$\nx = 1\n',
        source: '$$\nx = 1\n',
        formula: 'x = 1',
        indent: '',
        linePrefix: '',
        hasClosing: false,
        isSingleLine: false,
        newline: '\n'
      };

      const tx = createBlockMathEditTransaction(mockUnclosedCtx.source, mockUnclosedCtx, 'x = 2');
      expect(tx).toBeNull();
    });
  });
});
