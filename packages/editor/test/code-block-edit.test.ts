// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { parseMarkdown, type MarkdownBlockNode } from '@nexus/markdown';
import {
  MarkdownDocumentSession,
  createSessionEditorView,
  setEditorReadOnly,
  parseCodeBlockContext,
  createCodeBlockValueTransaction,
  createCodeBlockLanguageTransaction,
  applyChangesToSource
} from '../src/index.js';

describe('P1-04E Code Block Edit Transactions & Preservation', () => {
  const sampleCodeSource = [
    '# Code Document',
    '',
    '```typescript',
    'const x = 1;',
    'console.log(x);',
    '```',
    '',
    'After code.'
  ].join('\n');

  describe('A. Code Block Context Parsing', () => {
    it('extracts fence character, length, language, and code value', () => {
      const parsed = parseMarkdown(sampleCodeSource);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block')!;
      expect(codeNode).toBeDefined();

      const context = parseCodeBlockContext(sampleCodeSource, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);
      expect(context.fenceChar).toBe('`');
      expect(context.fenceLength).toBe(3);
      expect(context.language).toBe('typescript');
      expect(context.value).toBe('const x = 1;\nconsole.log(x);');
      expect(context.hasClosingFence).toBe(true);
    });

    it('handles tilde fence ~~~ correctly', () => {
      const tildeSource = '~~~python\nprint("Hello")\n~~~';
      const parsed = parseMarkdown(tildeSource);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block')!;
      const context = parseCodeBlockContext(tildeSource, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);
      expect(context.fenceChar).toBe('~');
      expect(context.fenceLength).toBe(3);
      expect(context.language).toBe('python');
    });

    it('handles 4+ backtick fences', () => {
      const fourFenceSource = '````markdown\n```js\nvar a = 1;\n```\n````';
      const parsed = parseMarkdown(fourFenceSource);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block')!;
      const context = parseCodeBlockContext(fourFenceSource, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);
      expect(context.fenceChar).toBe('`');
      expect(context.fenceLength).toBe(4);
    });

    it('preserves closing fence when code block has a trailing EOF newline', () => {
      const eofSource = '```typescript\nconst x = 1;\n```\n';
      const parsed = parseMarkdown(eofSource);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block')!;
      const context = parseCodeBlockContext(eofSource, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);
      expect(context.hasClosingFence).toBe(true);

      const tx = createCodeBlockValueTransaction(eofSource, context, 'const x = 2;');
      expect(tx).not.toBeNull();
      const next = applyChangesToSource(eofSource, tx!.changes);
      expect(next).toBe('```typescript\nconst x = 2;\n```\n');

      const reparsed = parseMarkdown(next);
      const reparsedNode = reparsed.root.children.find((c) => c.type === 'code-block')!;
      expect(reparsedNode).toBeDefined();
      const reparsedCtx = parseCodeBlockContext(next, reparsedNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);
      expect(reparsedCtx.hasClosingFence).toBe(true);
    });

    it('preserves code block without trailing EOF newline', () => {
      const noEofNlSource = '```typescript\nconst x = 1;\n```';
      const parsed = parseMarkdown(noEofNlSource);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block')!;
      const context = parseCodeBlockContext(noEofNlSource, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);
      expect(context.hasClosingFence).toBe(true);
      expect(context.trailingNewline).toBeNull();

      const tx = createCodeBlockValueTransaction(noEofNlSource, context, 'const x = 2;');
      expect(tx).not.toBeNull();
      const next = applyChangesToSource(noEofNlSource, tx!.changes);
      expect(next).toBe('```typescript\nconst x = 2;\n```');
    });

    it('identifies unclosed code block with hasClosingFence === false and does not synthesize closing fence', () => {
      const unclosedSource = '```typescript\nconst x = 1;\n';
      const parsed = parseMarkdown(unclosedSource);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block')!;
      const context = parseCodeBlockContext(unclosedSource, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);
      expect(context.hasClosingFence).toBe(false);

      const tx = createCodeBlockValueTransaction(unclosedSource, context, 'const x = 2;');
      expect(tx).not.toBeNull();
      const next = applyChangesToSource(unclosedSource, tx!.changes);
      // Must not synthesize closing fence
      expect(next).toBe('```typescript\nconst x = 2;\n');
    });

    it('preserves asymmetric closing fence (opening 3, closing 4) without normalizing closing fence', () => {
      // Opening fence has 3 backticks, closing has 4 backticks
      const asymmetricSource = '```python\nx = 1\n````\n';
      const parsed = parseMarkdown(asymmetricSource);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block')!;
      const context = parseCodeBlockContext(asymmetricSource, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);
      expect(context.hasClosingFence).toBe(true);

      const tx = createCodeBlockValueTransaction(asymmetricSource, context, 'x = 2');
      expect(tx).not.toBeNull();
      const next = applyChangesToSource(asymmetricSource, tx!.changes);
      // Must preserve the 4-backtick closing fence exactly
      expect(next).toBe('```python\nx = 2\n````\n');
    });

    it('preserves asymmetric tilde closing fence (opening 3, closing 4)', () => {
      const asymmetricTilde = '~~~ruby\ny = 1\n~~~~\n';
      const parsed = parseMarkdown(asymmetricTilde);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block')!;
      const context = parseCodeBlockContext(asymmetricTilde, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);
      expect(context.hasClosingFence).toBe(true);

      const tx = createCodeBlockValueTransaction(asymmetricTilde, context, 'y = 2');
      expect(tx).not.toBeNull();
      const next = applyChangesToSource(asymmetricTilde, tx!.changes);
      expect(next).toBe('~~~ruby\ny = 2\n~~~~\n');
    });

    it('preserves closing fence trailing whitespace and Tab characters', () => {
      const trailingSpaceSource = '```js\na = 1\n```  \t\n';
      const parsed = parseMarkdown(trailingSpaceSource);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block')!;
      const context = parseCodeBlockContext(trailingSpaceSource, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);
      expect(context.hasClosingFence).toBe(true);

      const tx = createCodeBlockValueTransaction(trailingSpaceSource, context, 'a = 2');
      expect(tx).not.toBeNull();
      const next = applyChangesToSource(trailingSpaceSource, tx!.changes);
      expect(next).toBe('```js\na = 2\n```  \t\n');
    });

    it('preserves closing fence in CRLF and nested blockquotes', () => {
      const bqCrlf = '> ```ts\r\n> const v = 1;\r\n> ````  \r\n';
      const parsed = parseMarkdown(bqCrlf);
      const bq = parsed.root.children[0] as Extract<MarkdownBlockNode, { type: 'blockquote' }>;
      const codeNode = bq.children.find((c) => c.type === 'code-block')!;
      const context = parseCodeBlockContext(bqCrlf, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);
      expect(context.hasClosingFence).toBe(true);

      const tx = createCodeBlockValueTransaction(bqCrlf, context, 'const v = 2;');
      expect(tx).not.toBeNull();
      const next = applyChangesToSource(bqCrlf, tx!.changes);
      expect(next).toBe('> ```ts\r\n> const v = 2;\r\n> ````  \r\n');
    });

    it('only expands closing fence when new content requires longer fence than original closing fence', () => {
      // Opening 3, closing 4. New content contains 3 backticks, so original closing fence (4) is still valid!
      const source = '```ts\nx = 1\n````\n';
      const parsed = parseMarkdown(source);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block')!;
      const context = parseCodeBlockContext(source, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);

      // New content contains 3 backticks run
      const tx1 = createCodeBlockValueTransaction(source, context, '```inner```');
      expect(tx1).not.toBeNull();
      const next1 = applyChangesToSource(source, tx1!.changes);
      // Opening must expand to 4, and closing 4 is preserved!
      expect(next1).toBe('````ts\n```inner```\n````\n');

      // Now if new content contains 4 backticks run, closing fence must expand to 5!
      const tx2 = createCodeBlockValueTransaction(source, context, '````longer````');
      expect(tx2).not.toBeNull();
      const next2 = applyChangesToSource(source, tx2!.changes);
      expect(next2).toBe('`````ts\n````longer````\n`````\n');
    });

    it('preserves opening fence info-string spacing when editing only the body', () => {
      const source = '```  typescript  \nconst x = 1;\n```  \n';
      const parsed = parseMarkdown(source);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block')!;
      const context = parseCodeBlockContext(source, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);

      const tx = createCodeBlockValueTransaction(source, context, 'const x = 2;');
      expect(tx).not.toBeNull();
      expect(applyChangesToSource(source, tx!.changes)).toBe(
        '```  typescript  \nconst x = 2;\n```  \n'
      );
    });
  });

  describe('B. Code Content Editing & Fence Expansion', () => {
    it('modifies code content while preserving language and fence style', () => {
      const parsed = parseMarkdown(sampleCodeSource);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block')!;
      const context = parseCodeBlockContext(sampleCodeSource, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);

      const tx = createCodeBlockValueTransaction(sampleCodeSource, context, 'const y = 2;');
      expect(tx).not.toBeNull();
      expect(tx!.userEvent).toBe('code-block.value-edit');

      const next = applyChangesToSource(sampleCodeSource, tx!.changes);
      expect(next).toContain('```typescript\nconst y = 2;\n```');
      expect(next).toContain('After code.');
    });

    it('automatically expands fence length when new content contains backticks >= current fence length', () => {
      const parsed = parseMarkdown(sampleCodeSource);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block')!;
      const context = parseCodeBlockContext(sampleCodeSource, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);

      // New content contains ```js inner block
      const newCode = '```js\ninner code\n```';
      const tx = createCodeBlockValueTransaction(sampleCodeSource, context, newCode);
      expect(tx).not.toBeNull();

      const next = applyChangesToSource(sampleCodeSource, tx!.changes);
      // Fences must expand to at least 4 backticks
      expect(next).toContain('````typescript\n```js\ninner code\n```\n````');
    });

    it('preserves original fence length and does not downgrade if new content has fewer backticks', () => {
      const fourFenceSource = '````python\nx = 10\n````';
      const parsed = parseMarkdown(fourFenceSource);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block')!;
      const context = parseCodeBlockContext(fourFenceSource, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);

      const tx = createCodeBlockValueTransaction(fourFenceSource, context, 'x = 10');
      expect(tx).not.toBeNull();

      const next = applyChangesToSource(fourFenceSource, tx!.changes);
      // Must stay 4 backticks
      expect(next).toContain('````python\nx = 10\n````');
    });

    it('preserves indentation when code block is inside a blockquote or list', () => {
      const indentedSource = '  ```javascript\n  let a = 1;\n  ```';
      const parsed = parseMarkdown(indentedSource);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block')!;
      const context = parseCodeBlockContext(indentedSource, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);

      const tx = createCodeBlockValueTransaction(indentedSource, context, 'let b = 2;');
      expect(tx).not.toBeNull();

      const next = applyChangesToSource(indentedSource, tx!.changes);
      expect(next).toContain('  ```javascript\n  let b = 2;\n  ```');
    });

    it('preserves CRLF line endings in code block', () => {
      const crlfSource = sampleCodeSource.replace(/\n/g, '\r\n');
      const parsed = parseMarkdown(crlfSource);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block')!;
      const context = parseCodeBlockContext(crlfSource, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);

      const tx = createCodeBlockValueTransaction(crlfSource, context, 'const z = 3;');
      expect(tx).not.toBeNull();

      const next = applyChangesToSource(crlfSource, tx!.changes);
      expect(next).toContain('```typescript\r\nconst z = 3;\r\n```');
      expect(next.includes('\r\n')).toBe(true);
    });
  });

  describe('C. Code Language Editing', () => {
    it('modifies language without touching code content or fence style', () => {
      const parsed = parseMarkdown(sampleCodeSource);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block')!;
      const context = parseCodeBlockContext(sampleCodeSource, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);

      const tx = createCodeBlockLanguageTransaction(sampleCodeSource, context, 'rust');
      expect(tx).not.toBeNull();
      expect(tx!.userEvent).toBe('code-block.language-edit');

      const next = applyChangesToSource(sampleCodeSource, tx!.changes);
      expect(next).toContain('```rust\nconst x = 1;\nconsole.log(x);\n```');
    });

    it('allows clearing language tag to empty', () => {
      const parsed = parseMarkdown(sampleCodeSource);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block')!;
      const context = parseCodeBlockContext(sampleCodeSource, codeNode as Extract<MarkdownBlockNode, { type: 'code-block' }>);

      const tx = createCodeBlockLanguageTransaction(sampleCodeSource, context, '');
      expect(tx).not.toBeNull();

      const next = applyChangesToSource(sampleCodeSource, tx!.changes);
      expect(next).toContain('```\nconst x = 1;\nconsole.log(x);\n```');
    });
  });

  describe('D. Code Block Visual Surface Projection & Copying', () => {
    it('renders CodeBlockWidget with language badge and copy button', () => {
      const session = new MarkdownDocumentSession(sampleCodeSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'code-vis-1',
        surfaceKind: 'visual',
        parent
      });

      const headerWidget = handle.view.dom.querySelector('.cm-code-header-widget');
      expect(headerWidget).not.toBeNull();
      const langSelect = handle.view.dom.querySelector('.cm-code-language-select') as HTMLSelectElement | null;
      expect(langSelect?.value).toBe('typescript');
      const copyBtn = handle.view.dom.querySelector('.cm-code-copy-btn');
      expect(copyBtn).not.toBeNull();

      handle.destroy();
      parent.remove();
    });

    it('does NOT project special Markdown syntax inside code blocks as markdown widgets', () => {
      const specialCodeSource = '```markdown\n**bold** and $math$ and [[Wiki]] and <tag>\n```';
      const session = new MarkdownDocumentSession(specialCodeSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'code-vis-2',
        surfaceKind: 'visual',
        parent
      });

      // No bold widget delimiter or inline math widget inside code block
      const hiddenDelims = handle.view.dom.querySelectorAll('.cm-visual-hidden-delimiter');
      expect(hiddenDelims).toHaveLength(0);
      const mathWidgets = handle.view.dom.querySelectorAll('.cm-visual-inline-math');
      expect(mathWidgets).toHaveLength(0);
      const wikiWidgets = handle.view.dom.querySelectorAll('.cm-visual-wikilink');
      expect(wikiWidgets).toHaveLength(0);

      handle.destroy();
      parent.remove();
    });

    it('sets observable error state on copy button when clipboard write fails', async () => {
      const session = new MarkdownDocumentSession(sampleCodeSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      // Mock navigator.clipboard.writeText rejecting
      const originalClipboard = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: () => Promise.reject(new Error('Permission denied'))
        },
        configurable: true
      });

      const handle = createSessionEditorView({
        session,
        surfaceId: 'code-vis-err',
        surfaceKind: 'visual',
        parent
      });

      const copyBtn = handle.view.dom.querySelector('.cm-code-copy-btn') as HTMLButtonElement | null;
      expect(copyBtn).not.toBeNull();

      copyBtn!.click();
      // Wait for promise resolution/rejection
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(copyBtn!.dataset.copyState).toBe('error');
      expect(copyBtn!.textContent).toBe('Failed');

      // Restore clipboard
      Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
      handle.destroy();
      parent.remove();
    });

    it('copy button initial text is Copy and does not expose raw exception stack on error', async () => {
      const session = new MarkdownDocumentSession(sampleCodeSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const originalClipboard = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: () => Promise.reject(new Error('Sensitive path /var/secrets/key.pem: write error'))
        },
        configurable: true
      });

      const handle = createSessionEditorView({
        session,
        surfaceId: 'code-copy-sec',
        surfaceKind: 'visual',
        parent
      });

      const copyBtn = handle.view.dom.querySelector('.cm-code-copy-btn') as HTMLButtonElement | null;
      expect(copyBtn).not.toBeNull();
      expect(copyBtn!.textContent).toBe('Copy');

      copyBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(copyBtn!.textContent).toBe('Failed');
      // Must not leak sensitive error in title or text
      expect(copyBtn!.title).not.toContain('/var/secrets');

      Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
      handle.destroy();
      parent.remove();
    });

    it('enters code body editing natively in-place and commits changes via transaction', () => {
      const session = new MarkdownDocumentSession(sampleCodeSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'code-edit-body',
        surfaceKind: 'visual',
        parent
      });

      // No detached textarea in line-decorated code block
      expect(handle.view.dom.querySelector('.cm-code-editor')).toBeNull();

      // Native in-place editing: dispatch change directly to code block line
      const initialRev = session.getSnapshot().revision;
      const firstCodeLinePos = sampleCodeSource.indexOf('const x = 1;');
      handle.view.dispatch({
        changes: {
          from: firstCodeLinePos,
          to: firstCodeLinePos + 'const x = 1;'.length,
          insert: 'const x = 99;'
        }
      });

      expect(session.getSnapshot().revision).toBe(initialRev + 1);
      expect(session.getSnapshot().source).toContain('const x = 99;');

      // Session undo restores original code
      session.undo();
      expect(session.getSnapshot().source).toBe(sampleCodeSource);

      handle.destroy();
      parent.remove();
    });

    it('changes code block language via select dropdown and commits language change', () => {
      const session = new MarkdownDocumentSession(sampleCodeSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'code-edit-lang',
        surfaceKind: 'visual',
        parent
      });

      const langSelect = handle.view.dom.querySelector('.cm-code-language-select') as HTMLSelectElement | null;
      expect(langSelect).not.toBeNull();
      expect(langSelect!.value).toBe('typescript');

      const initialRev = session.getSnapshot().revision;
      langSelect!.value = 'python';
      langSelect!.dispatchEvent(new Event('change', { bubbles: true }));

      expect(session.getSnapshot().revision).toBe(initialRev + 1);
      expect(session.getSnapshot().source).toContain('```python\nconst x = 1;');

      handle.destroy();
      parent.remove();
    });

    it('renders Mermaid fenced code block with preview/source toggle and safe fallback preview', () => {
      const mermaidSource = [
        '```mermaid',
        'graph TD;',
        '  A-->B;',
        '```'
      ].join('\n');

      const session = new MarkdownDocumentSession(mermaidSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'code-vis-mermaid',
        surfaceKind: 'visual',
        parent
      });

      const mermaidBlock = handle.view.dom.querySelector('.cm-visual-code-block');
      expect(mermaidBlock).not.toBeNull();

      const toggleBtn = handle.view.dom.querySelector('.cm-mermaid-toggle') as HTMLButtonElement | null;
      expect(toggleBtn).not.toBeNull();

      const preview = handle.view.dom.querySelector('.cm-mermaid-preview');
      expect(preview).not.toBeNull();

      handle.destroy();
      parent.remove();
    });

    it('does not open code editor on click when surface is readOnly', () => {
      const session = new MarkdownDocumentSession(sampleCodeSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'code-ro',
        surfaceKind: 'visual',
        readOnly: true,
        parent
      });

      const langSelect = handle.view.dom.querySelector('.cm-code-language-select') as HTMLSelectElement | null;
      expect(langSelect?.disabled).toBe(true);
      expect(handle.view.dom.querySelector('.cm-code-editor')).toBeNull();

      handle.destroy();
      parent.remove();
    });
  });

  describe('E. Nested Code Block Validation', () => {
    it('creates value and language transactions for code blocks nested in blockquotes and lists', () => {
      const nestedSource = [
        '> Quote before',
        '> ```ts',
        '> const a = 1;',
        '> ```',
        '',
        '- List item',
        '  ```python',
        '  b = 2',
        '  ```'
      ].join('\n');

      const parsed = parseMarkdown(nestedSource);
      const bq = parsed.root.children.find((c) => c.type === 'blockquote') as Extract<
        MarkdownBlockNode,
        { type: 'blockquote' }
      >;
      expect(bq).toBeDefined();
      const bqCodeNode = bq.children.find((c) => c.type === 'code-block') as Extract<
        MarkdownBlockNode,
        { type: 'code-block' }
      >;
      expect(bqCodeNode).toBeDefined();

      const bqCtx = parseCodeBlockContext(nestedSource, bqCodeNode);
      const bqTx = createCodeBlockValueTransaction(nestedSource, bqCtx, 'const a = 2;');
      expect(bqTx).not.toBeNull();

      const listNode = parsed.root.children.find((c) => c.type === 'list') as Extract<
        MarkdownBlockNode,
        { type: 'list' }
      >;
      expect(listNode).toBeDefined();
      const itemCodeNode = listNode.items[0]!.children.find((c) => c.type === 'code-block') as Extract<
        MarkdownBlockNode,
        { type: 'code-block' }
      >;
      expect(itemCodeNode).toBeDefined();

      const listCtx = parseCodeBlockContext(nestedSource, itemCodeNode);
      const listTx = createCodeBlockLanguageTransaction(nestedSource, listCtx, 'ruby');
      expect(listTx).not.toBeNull();
    });

    it('does not mistake literal > or whitespace at line start as container prefix', () => {
      const nestedSource = [
        '> > ```ts',
        '> > const arrow = 1;',
        '> > ```'
      ].join('\n');

      const parsed = parseMarkdown(nestedSource);
      const bq1 = parsed.root.children.find(
        (c): c is Extract<MarkdownBlockNode, { type: 'blockquote' }> => c.type === 'blockquote'
      )!;
      const bq2 = bq1.children.find(
        (c): c is Extract<MarkdownBlockNode, { type: 'blockquote' }> => c.type === 'blockquote'
      )!;
      const codeNode = bq2.children.find(
        (c): c is Extract<MarkdownBlockNode, { type: 'code-block' }> => c.type === 'code-block'
      )!;

      const ctx = parseCodeBlockContext(nestedSource, codeNode);
      // Code content literally starts with '> '
      const tx = createCodeBlockValueTransaction(nestedSource, ctx, '> literal arrow\n  spaces');
      expect(tx).not.toBeNull();

      const next = applyChangesToSource(nestedSource, tx!.changes);
      // The container prefix (> > ) must be preserved, and the literal '> literal arrow' must not be stripped!
      expect(next).toContain('> > > literal arrow\n');
      expect(next).toContain('> >   spaces\n');

      const reparsed = parseMarkdown(next);
      const rBq1 = reparsed.root.children.find(
        (c): c is Extract<MarkdownBlockNode, { type: 'blockquote' }> => c.type === 'blockquote'
      )!;
      const rBq2 = rBq1.children.find(
        (c): c is Extract<MarkdownBlockNode, { type: 'blockquote' }> => c.type === 'blockquote'
      )!;
      const rCode = rBq2.children.find(
        (c): c is Extract<MarkdownBlockNode, { type: 'code-block' }> => c.type === 'code-block'
      )!;
      expect(rCode.value).toBe('> literal arrow\n  spaces');
    });

    it('modifies only the target code block when multiple identical code blocks exist', () => {
      const multiCodeDoc = [
        '# Doc',
        '',
        '```js',
        'console.log("hello");',
        '```',
        '',
        'Middle paragraph',
        '',
        '```js',
        'console.log("hello");',
        '```'
      ].join('\n');

      const parsed = parseMarkdown(multiCodeDoc);
      const codeBlocks = parsed.root.children.filter((c) => c.type === 'code-block') as Extract<
        MarkdownBlockNode,
        { type: 'code-block' }
      >[];
      expect(codeBlocks).toHaveLength(2);

      // Target second code block
      const ctx2 = parseCodeBlockContext(multiCodeDoc, codeBlocks[1]!);
      const tx = createCodeBlockValueTransaction(multiCodeDoc, ctx2, 'console.log("updated 2");');
      expect(tx).not.toBeNull();

      const next = applyChangesToSource(multiCodeDoc, tx!.changes);
      // First block must remain unchanged
      expect(next.indexOf('console.log("hello");')).toBe(multiCodeDoc.indexOf('console.log("hello");'));
      expect(next).toContain('console.log("updated 2");');
    });

    it('preserves unclosed fenced code without silently synthesizing closing fence', () => {
      const unclosedSource = '```typescript\nconst open = 1;';
      const parsed = parseMarkdown(unclosedSource);
      const codeNode = parsed.root.children.find((c) => c.type === 'code-block') as Extract<
        MarkdownBlockNode,
        { type: 'code-block' }
      >;
      expect(codeNode).toBeDefined();

      const ctx = parseCodeBlockContext(unclosedSource, codeNode);
      expect(ctx.hasClosingFence).toBe(false);

      const tx = createCodeBlockValueTransaction(unclosedSource, ctx, 'const updated = 2;');
      expect(tx).not.toBeNull();

      const next = applyChangesToSource(unclosedSource, tx!.changes);
      // Must NOT synthesize closing fence ```
      expect(next).toBe('```typescript\nconst updated = 2;');
      expect(next.endsWith('```')).toBe(false);
    });

    it('initializes Mermaid preview toggle button with next action "Source" and toggles correctly', () => {
      const mermaidSource = '```mermaid\ngraph TD;\n  A-->B;\n```';
      const session = new MarkdownDocumentSession(mermaidSource);
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-mermaid-btn',
        surfaceKind: 'visual',
        parent
      });

      const toggleBtn = handle.view.dom.querySelector('.cm-mermaid-toggle') as HTMLButtonElement;
      expect(toggleBtn).not.toBeNull();

      // Initial state: preview is visible, button text must indicate next action "Source"
      expect(toggleBtn.textContent).toBe('Source');
      const previewEl = handle.view.dom.querySelector('.cm-mermaid-preview') as HTMLElement;
      const codeBody = handle.view.dom.querySelector('.cm-code-body') as HTMLElement;
      expect(previewEl.style.display).not.toBe('none');
      expect(codeBody.style.display).toBe('none');

      // Click to toggle to source
      toggleBtn.click();
      expect(toggleBtn.textContent).toBe('Preview');
      expect(previewEl.style.display).toBe('none');
      expect(codeBody.style.display).not.toBe('none');

      // Click to toggle back to preview
      toggleBtn.click();
      expect(toggleBtn.textContent).toBe('Source');
      expect(previewEl.style.display).not.toBe('none');
      expect(codeBody.style.display).toBe('none');

      handle.destroy();
      parent.remove();
    });

    it('dynamically updates select disabled state when readOnly is toggled', () => {
      const session = new MarkdownDocumentSession('```js\nconsole.log(1);\n```');
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'visual-code-ro-lifecycle',
        surfaceKind: 'visual',
        parent
      });

      const langSelect = handle.view.dom.querySelector('.cm-code-language-select') as HTMLSelectElement;
      expect(langSelect).not.toBeNull();
      expect(langSelect.disabled).toBe(false);

      // Dynamically toggle readOnly = true
      setEditorReadOnly(handle.view, true);
      const roSelect = handle.view.dom.querySelector('.cm-code-language-select') as HTMLSelectElement;
      expect(roSelect.disabled).toBe(true);

      // Toggle back to editable
      setEditorReadOnly(handle.view, false);
      const editableSelect = handle.view.dom.querySelector('.cm-code-language-select') as HTMLSelectElement;
      expect(editableSelect.disabled).toBe(false);

      handle.destroy();
      parent.remove();
    });
  });
});
