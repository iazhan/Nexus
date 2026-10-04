import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { parseMarkdown } from '@nexus/markdown';
import {
  MarkdownDocumentSession,
  createParagraphOrHeadingSplitTransaction,
  createBlockMergeTransaction,
  createListIndentTransaction,
  createListOutdentTransaction,
  createTaskCheckboxToggleTransaction,
  createInlineFormatTransaction,
  createSelectBlockTransaction,
  createSelectBlockAtPositionTransaction,
  createSelectBlockAtIndexTransaction,
  createReorderBlockTransaction,
  createReorderBlockAtPositionTransaction,
  createReorderBlockToPositionTransaction,
  findDeepestBlockAtPos,
  getContentEnd,
  findListItemAtPos,
  findAtomicRanges,
  findFormattingSpans,
  scanFormatting,
  createFormattingAnalyzer,
  readInlineCodeFence,
  inlineCodeFenceFor,
  type MarkdownSelection
} from '../src/index.js';

describe('Edit Transactions: Enter (Paragraph, Heading, List Item, Blockquote Split)', () => {
  it('is a no-op (returns null) inside fenced code blocks, tables, block math, and raw blocks', () => {
    const codeSource = '```ts\nconst x = 10;\n```';
    const selCode: MarkdownSelection = { anchor: 10, head: 10 };
    expect(createParagraphOrHeadingSplitTransaction(codeSource, selCode)).toBeNull();

    const tableSource = '| Col1 | Col2 |\n| --- | --- |\n| Val1 | Val2 |';
    const selTable: MarkdownSelection = { anchor: 5, head: 5 };
    expect(createParagraphOrHeadingSplitTransaction(tableSource, selTable)).toBeNull();

    const mathSource = '$$\nx^2 + y^2 = z^2\n$$';
    const selMath: MarkdownSelection = { anchor: 5, head: 5 };
    expect(createParagraphOrHeadingSplitTransaction(mathSource, selMath)).toBeNull();

    const rawSource = '<div class="custom">\n<p>Hello</p>\n</div>';
    const selRaw: MarkdownSelection = { anchor: 10, head: 10 };
    expect(createParagraphOrHeadingSplitTransaction(rawSource, selRaw)).toBeNull();
  });
  it('splits a paragraph in the middle with a single newline (soft break)', () => {
    const source = 'First line content';
    const selection: MarkdownSelection = { anchor: 10, head: 10 }; // 'First line| content'
    const transaction = createParagraphOrHeadingSplitTransaction(source, selection);

    expect(transaction).not.toBeNull();
    expect(transaction?.changes).toHaveLength(1);

    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('First line\ncontent');
    expect(snapshot.selection).toEqual({ anchor: 11, head: 11 });
  });

  it('inserts a single newline when splitting at paragraph start', () => {
    const source = 'Paragraph text';
    const selection: MarkdownSelection = { anchor: 0, head: 0 };
    const transaction = createParagraphOrHeadingSplitTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('\nParagraph text');
    expect(snapshot.selection).toEqual({ anchor: 1, head: 1 });
  });

  it('inserts a single newline when splitting at paragraph end', () => {
    const source = 'Paragraph text';
    const selection: MarkdownSelection = { anchor: source.length, head: source.length };
    const transaction = createParagraphOrHeadingSplitTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('Paragraph text\n');
    expect(snapshot.selection).toEqual({ anchor: source.length + 1, head: source.length + 1 });
  });

  it('preserves CRLF line endings when splitting', () => {
    const source = 'First line\r\nSecond line';
    const selection: MarkdownSelection = { anchor: 12, head: 12 }; // after \r\n
    const transaction = createParagraphOrHeadingSplitTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source.includes('\r\n\r\n')).toBe(true);
  });

  it('preserves formatting continuity inside strong or emphasis text', () => {
    const source = 'Some **bold words** here';
    const selection: MarkdownSelection = { anchor: 11, head: 11 }; // 'Some **bold| words** here'
    const transaction = createParagraphOrHeadingSplitTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('Some **bold**\n**words** here');
    expect(snapshot.selection).toEqual({ anchor: 16, head: 16 });
  });

  it('does not cut through atomic inline nodes (inline code, inline math, wikilinks, links, images, raw HTML)', () => {
    const source = 'Code `hello_world` inside';
    // Position inside inline code: 'Code `hello|_world` inside' (pos 11)
    const selection: MarkdownSelection = { anchor: 11, head: 11 };
    const transaction = createParagraphOrHeadingSplitTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    // Should not slice `hello_world` in half; should split at the node boundary
    expect(snapshot.source).toBe('Code `hello_world`\ninside');
  });

  it('handles CJK characters and Emoji without offset corruption', () => {
    const source = '你好🌟世界，测试段落拆分';
    const selection: MarkdownSelection = { anchor: 6, head: 6 }; // '你好🌟世界|，测试段落拆分' (🌟 is 2 UTF-16 code units)
    const transaction = createParagraphOrHeadingSplitTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('你好🌟世界\n，测试段落拆分');
    expect(snapshot.selection).toEqual({ anchor: 7, head: 7 });
  });

  it('splits heading in the middle: keeps left as heading, right as paragraph', () => {
    const source = '# Major Heading Title';
    const selection: MarkdownSelection = { anchor: 15, head: 15 }; // '# Major Heading| Title'
    const transaction = createParagraphOrHeadingSplitTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('# Major Heading\nTitle');
    expect(snapshot.selection).toEqual({ anchor: 16, head: 16 });
  });

  it('splits heading at end: adds new paragraph below', () => {
    const source = '## Subtitle';
    const selection: MarkdownSelection = { anchor: source.length, head: source.length };
    const transaction = createParagraphOrHeadingSplitTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('## Subtitle\n');
    expect(snapshot.selection).toEqual({ anchor: source.length + 1, head: source.length + 1 });
  });

  it('preserves closing hashes and indentation in heading split', () => {
    const source = '### Heading with hashes ###';
    const selection: MarkdownSelection = { anchor: 16, head: 16 }; // '### Heading with| hashes ###'
    const transaction = createParagraphOrHeadingSplitTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('### Heading with ###\nhashes');
  });

  it('splits an unordered list item into two items with matching marker style', () => {
    const source = '- Item one\n- Item two';
    const selection: MarkdownSelection = { anchor: 6, head: 6 }; // '- Item| one'
    const transaction = createParagraphOrHeadingSplitTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('- Item\n- one\n- Item two');
    expect(snapshot.selection).toEqual({ anchor: 9, head: 9 });
  });

  it('creates a new list item when pressing Enter at the end of an unordered list item', () => {
    const source = '- First item';
    const selection: MarkdownSelection = { anchor: source.length, head: source.length };
    const transaction = createParagraphOrHeadingSplitTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('- First item\n- ');
    expect(snapshot.selection).toEqual({ anchor: 15, head: 15 });
  });

  it('splits an ordered list item and increments the number on the new item', () => {
    const source = '1. Step one\n2. Step two';
    const selection: MarkdownSelection = { anchor: 11, head: 11 }; // end of '1. Step one'
    const transaction = createParagraphOrHeadingSplitTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('1. Step one\n2. \n2. Step two');
    expect(snapshot.selection).toEqual({ anchor: 15, head: 15 });
  });

  it('splits a task list item creating a new uncompleted task item', () => {
    const source = '- [x] Completed task';
    const selection: MarkdownSelection = { anchor: source.length, head: source.length };
    const transaction = createParagraphOrHeadingSplitTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('- [x] Completed task\n- [ ] ');
    expect(snapshot.selection).toEqual({ anchor: 27, head: 27 });
  });

  it('exits list when pressing Enter on an empty list item (removes marker)', () => {
    const source = '- Item 1\n- \n- Item 2';
    const selection: MarkdownSelection = { anchor: 11, head: 11 }; // in '- '
    const transaction = createParagraphOrHeadingSplitTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('- Item 1\n\n- Item 2');
    expect(snapshot.selection).toEqual({ anchor: 9, head: 9 });
  });

  it('splits paragraph inside blockquote and continues blockquote prefix', () => {
    const source = '> First quote line\n> Second quote line';
    const selection: MarkdownSelection = { anchor: 8, head: 8 }; // '> First| quote line'
    const transaction = createParagraphOrHeadingSplitTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source.startsWith('> First')).toBe(true);
    expect(snapshot.source.includes('\n> quote line')).toBe(true);
  });

  it('exits blockquote when pressing Enter on an empty blockquote line', () => {
    const source = '> A quote\n> ';
    const selection: MarkdownSelection = { anchor: 12, head: 12 }; // in '> '
    const transaction = createParagraphOrHeadingSplitTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('> A quote\n');
    expect(snapshot.selection).toEqual({ anchor: 10, head: 10 });
  });
});

describe('Edit Transactions: Backspace (Block Merge)', () => {
  it('merges current paragraph with previous paragraph when cursor is at start', () => {
    const source = 'Paragraph one\n\nParagraph two';
    const selection: MarkdownSelection = { anchor: 15, head: 15 }; // at 'P' of Paragraph two
    const transaction = createBlockMergeTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('Paragraph oneParagraph two');
    expect(snapshot.selection).toEqual({ anchor: 13, head: 13 });

    // Single undo restores the merge
    expect(session.canUndo).toBe(true);
    session.undo();
    expect(session.getSnapshot().source).toBe(source);
    expect(session.getSnapshot().selection).toEqual(selection);
  });

  it('is a no-op when cursor is at the start of the first block in document', () => {
    const source = 'Paragraph one\n\nParagraph two';
    const selection: MarkdownSelection = { anchor: 0, head: 0 };
    const transaction = createBlockMergeTransaction(source, selection);

    expect(transaction).toBeNull();
  });

  it('merges paragraph into previous heading on Backspace at block start', () => {
    const source = '# Heading\n\nParagraph';
    const selection: MarkdownSelection = { anchor: 11, head: 11 }; // at 'P' of Paragraph
    const transaction = createBlockMergeTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('# HeadingParagraph');
    expect(snapshot.selection).toEqual({ anchor: 9, head: 9 });
  });

  it('unwraps list marker to plain paragraph on Backspace at start of list item content', () => {
    const source = '- List item content';
    const selection: MarkdownSelection = { anchor: 2, head: 2 }; // at 'L' of List
    const transaction = createBlockMergeTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('List item content');
    expect(snapshot.selection).toEqual({ anchor: 0, head: 0 });
  });

  it('unwraps blockquote prefix to plain paragraph on Backspace at start of quote content', () => {
    const source = '> Quote content';
    const selection: MarkdownSelection = { anchor: 2, head: 2 }; // at 'Q' of Quote
    const transaction = createBlockMergeTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('Quote content');
    expect(snapshot.selection).toEqual({ anchor: 0, head: 0 });
  });

  it('does not merge if previous block is a code block or table', () => {
    const sourceCode = '```ts\nconst a = 1;\n```\n\nParagraph';
    const selCode: MarkdownSelection = { anchor: sourceCode.indexOf('Paragraph'), head: sourceCode.indexOf('Paragraph') };
    expect(createBlockMergeTransaction(sourceCode, selCode)).toBeNull();

    const sourceTable = '| A | B |\n|---|---|\n| 1 | 2 |\n\nParagraph';
    const selTable: MarkdownSelection = { anchor: sourceTable.indexOf('Paragraph'), head: sourceTable.indexOf('Paragraph') };
    expect(createBlockMergeTransaction(sourceTable, selTable)).toBeNull();
  });

  it('unwraps task list marker and checkbox to plain paragraph on Backspace at start of task content', () => {
    const source = '- [ ] Task item content';
    const selection: MarkdownSelection = { anchor: 6, head: 6 };
    const transaction = createBlockMergeTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('Task item content');
    expect(snapshot.selection).toEqual({ anchor: 0, head: 0 });
  });

  it('unwraps task item within blockquote retaining quote prefix on Backspace', () => {
    const source = '> - [x] Done item';
    const selection: MarkdownSelection = { anchor: 8, head: 8 };
    const transaction = createBlockMergeTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('> Done item');
    expect(snapshot.selection).toEqual({ anchor: 2, head: 2 });
  });

  it('correctly handles CRLF and CJK/Emoji across merged blocks', () => {
    const source = '段落一🌟\r\n\r\n段落二🚀';
    const selection: MarkdownSelection = { anchor: source.indexOf('段落二'), head: source.indexOf('段落二') };
    const transaction = createBlockMergeTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('段落一🌟段落二🚀');
  });
});

describe('Edit Transactions: Tab / Shift-Tab (List Indentation)', () => {
  it('indents a list item when it has a preceding sibling (Tab)', () => {
    const source = '- Item 1\n- Item 2\n- Item 3';
    const selection: MarkdownSelection = { anchor: 11, head: 11 }; // inside 'Item 2'
    const transaction = createListIndentTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('- Item 1\n  - Item 2\n- Item 3');
  });

  it('does not indent the root first list item (no-op)', () => {
    const source = '- Item 1\n- Item 2';
    const selection: MarkdownSelection = { anchor: 3, head: 3 }; // inside 'Item 1'
    const transaction = createListIndentTransaction(source, selection);

    expect(transaction).toBeNull();
  });

  it('outdents a nested list item (Shift-Tab)', () => {
    const source = '- Item 1\n  - Item 2\n- Item 3';
    const selection: MarkdownSelection = { anchor: 15, head: 15 }; // inside 'Item 2'
    const transaction = createListOutdentTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('- Item 1\n- Item 2\n- Item 3');
  });

  it('does not produce negative indentation for root list items (Shift-Tab no-op)', () => {
    const source = '- Item 1\n- Item 2';
    const selection: MarkdownSelection = { anchor: 11, head: 11 }; // inside 'Item 2'
    const transaction = createListOutdentTransaction(source, selection);

    expect(transaction).toBeNull();
  });

  it('preserves ordered list markers, task checkboxes, and multi-line item contents', () => {
    const source = '1. [ ] Task 1\n2. [x] Task 2\n   Continuation line';
    const selection: MarkdownSelection = { anchor: 20, head: 20 }; // inside 'Task 2'
    const transaction = createListIndentTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('1. [ ] Task 1\n  2. [x] Task 2\n     Continuation line');
  });

  it('preserves parent blockquote prefixes when indenting inside blockquote', () => {
    const source = '> - Item 1\n> - Item 2';
    const selection: MarkdownSelection = { anchor: 15, head: 15 }; // inside 'Item 2'
    const transaction = createListIndentTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('> - Item 1\n>   - Item 2');
  });

  it('moves entire list item subtree including grandchildren when indenting (Tab)', () => {
    // Structure:
    // - Parent
    //   - Child 1
    //   - Child 2
    //     - Grandchild
    // - Sibling
    const source = '- Parent\n  - Child 1\n  - Child 2\n    - Grandchild\n- Sibling';
    // Position inside 'Child 2' (pos 25)
    const selection: MarkdownSelection = { anchor: 25, head: 25 };
    const transaction = createListIndentTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('- Parent\n  - Child 1\n    - Child 2\n      - Grandchild\n- Sibling');

    // Sibling must not be moved
    expect(snapshot.source.endsWith('- Sibling')).toBe(true);

    // Verify AST structure after re-parse
    const { root } = parseMarkdown(snapshot.source);
    expect(root.children).toHaveLength(1); // One top-level list
    const topList = root.children[0]!;
    expect(topList.type).toBe('list');
    if (topList.type === 'list') {
      expect(topList.items).toHaveLength(2); // Parent and Sibling
      expect(topList.items[1]?.raw.trim()).toBe('- Sibling');
    }
  });

  it('moves entire list item subtree including grandchildren when outdenting (Shift-Tab)', () => {
    const source = '- Parent\n  - Child\n    - Grandchild\n- Sibling';
    // Position inside 'Child' (pos 14)
    const selection: MarkdownSelection = { anchor: 14, head: 14 };
    const transaction = createListOutdentTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('- Parent\n- Child\n  - Grandchild\n- Sibling');

    // Sibling must not be moved
    expect(snapshot.source.endsWith('- Sibling')).toBe(true);

    // Verify AST structure after re-parse: Parent, Child, Sibling are all at top level
    const { root } = parseMarkdown(snapshot.source);
    const topList = root.children[0]!;
    expect(topList.type).toBe('list');
    if (topList.type === 'list') {
      expect(topList.items).toHaveLength(3); // Parent, Child, Sibling
      // Grandchild is a child of Child
      const childItem = topList.items[1]!;
      expect(childItem.children.some((c) => c.type === 'list')).toBe(true);
    }
  });

  it('moves list items containing fenced code blocks and blockquotes together as a subtree', () => {
    const source = '- Item 1\n- Item 2\n  ```ts\n  const a = 1;\n  ```\n  > quote inside item\n- Item 3';
    const selection: MarkdownSelection = { anchor: 12, head: 12 }; // inside Item 2
    const transaction = createListIndentTransaction(source, selection);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('- Item 1\n  - Item 2\n    ```ts\n    const a = 1;\n    ```\n    > quote inside item\n- Item 3');
    expect(snapshot.source.endsWith('- Item 3')).toBe(true);
  });
});

describe('Edit Transactions: Task Checkbox Toggle', () => {
  it('toggles [ ] to [x] using exact SourceRange without full-text search', () => {
    const source = '- [ ] Task A\n- [ ] Task B';
    // Range of second checkbox: from 15 to 18 ('[ ]')
    const range = { from: 15, to: 18 };
    const transaction = createTaskCheckboxToggleTransaction(source, range);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('- [ ] Task A\n- [x] Task B');

    // Undo toggles back
    session.undo();
    expect(session.getSnapshot().source).toBe(source);
  });

  it('toggles [x] or [X] back to [ ] preserving marker style', () => {
    const source = '* [X] Completed item';
    const range = { from: 2, to: 5 };
    const transaction = createTaskCheckboxToggleTransaction(source, range);

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('* [ ] Completed item');
  });
});

describe('Edit Transactions: Mod-B / Mod-I Formatting', () => {
  it('applies strong (**) to a plain text selection', () => {
    const source = 'Hello world here';
    const selection: MarkdownSelection = { anchor: 6, head: 11 }; // 'world'
    const transaction = createInlineFormatTransaction(source, selection, 'strong');

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('Hello **world** here');
    expect(snapshot.selection).toEqual({ anchor: 8, head: 13 });
  });

  it('unwraps strong (**) when selection is already inside strong', () => {
    const source = 'Hello **world** here';
    const selection: MarkdownSelection = { anchor: 8, head: 13 }; // 'world'
    const transaction = createInlineFormatTransaction(source, selection, 'strong');

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('Hello world here');
    expect(snapshot.selection).toEqual({ anchor: 6, head: 11 });
  });

  it('preserves alternative delimiter style __ when unwrapping', () => {
    const source = 'Hello __world__ here';
    const selection: MarkdownSelection = { anchor: 8, head: 13 }; // 'world'
    const transaction = createInlineFormatTransaction(source, selection, 'strong');

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('Hello world here');
  });

  it('applies emphasis (*) to a plain text selection', () => {
    const source = 'Alpha beta gamma';
    const selection: MarkdownSelection = { anchor: 6, head: 10 }; // 'beta'
    const transaction = createInlineFormatTransaction(source, selection, 'emphasis');

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('Alpha *beta* gamma');
  });

  it('does not format collapsed selections (no-op)', () => {
    const source = 'Hello world';
    const selection: MarkdownSelection = { anchor: 5, head: 5 };
    expect(createInlineFormatTransaction(source, selection, 'strong')).toBeNull();
    expect(createInlineFormatTransaction(source, selection, 'emphasis')).toBeNull();
  });

  it('does not format selections inside atomic inline nodes (code, math, wikilink, link, image, raw)', () => {
    const source = 'See `const val = 1;` here';
    const selection: MarkdownSelection = { anchor: 11, head: 14 }; // 'val' inside `...`
    expect(createInlineFormatTransaction(source, selection, 'strong')).toBeNull();

    const mathSource = 'Formula $x^2 + y^2 = z^2$ ok';
    const mathSel: MarkdownSelection = { anchor: 10, head: 13 };
    expect(createInlineFormatTransaction(mathSource, mathSel, 'strong')).toBeNull();
  });

  it('unwraps _italic_ by deleting _ delimiters instead of converting to *', () => {
    const source = 'Some _italic text_ here';
    const selection: MarkdownSelection = { anchor: 6, head: 17 }; // 'italic text'
    const transaction = createInlineFormatTransaction(source, selection, 'emphasis');

    expect(transaction).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(transaction!);

    expect(snapshot.source).toBe('Some italic text here');
    expect(snapshot.selection).toEqual({ anchor: 5, head: 16 });
  });

  it('does not unwrap or corrupt **bold** or __bold__ when toggling italic', () => {
    const boldAsterisk = 'Some **bold text** here';
    const selBoldAsterisk: MarkdownSelection = { anchor: 7, head: 16 };
    // Should wrap with *, not unwrap **
    const tx1 = createInlineFormatTransaction(boldAsterisk, selBoldAsterisk, 'emphasis');
    expect(tx1).not.toBeNull();
    const session1 = new MarkdownDocumentSession(boldAsterisk, selBoldAsterisk);
    const snap1 = session1.dispatch(tx1!);
    expect(snap1.source).toBe('Some ***bold text*** here');

    const boldUnderscore = 'Some __bold text__ here';
    const selBoldUnderscore: MarkdownSelection = { anchor: 7, head: 16 };
    const tx2 = createInlineFormatTransaction(boldUnderscore, selBoldUnderscore, 'emphasis');
    expect(tx2).not.toBeNull();
    const session2 = new MarkdownDocumentSession(boldUnderscore, selBoldUnderscore);
    const snap2 = session2.dispatch(tx2!);
    expect(snap2.source).toBe('Some _*bold text*_ here'.replace('_*bold text*_', '*__bold text__*'));
  });
});

describe('Edit Transactions: Tab / Shift-Tab Selection Mapping via ChangeSet', () => {
  it('maps selection accurately on item first line, continuation line, and nested grandchild', () => {
    const source = '- Item 1\n- Item 2\n  Continuation line\n  - Grandchild';
    // 1. Cursor on item first line inside 'Item 2' (pos 14)
    const sel1: MarkdownSelection = { anchor: 14, head: 14 };
    const tx1 = createListIndentTransaction(source, sel1);
    expect(tx1).not.toBeNull();
    const session1 = new MarkdownDocumentSession(source, sel1);
    const snap1 = session1.dispatch(tx1!);
    expect(snap1.source).toBe('- Item 1\n  - Item 2\n    Continuation line\n    - Grandchild');
    expect(snap1.selection.anchor).toBe(16);
    expect(snap1.selection.head).toBe(16);

    // 2. Cursor on continuation line inside 'Continuation' (pos 25 in original source)
    const contPos = source.indexOf('Continuation') + 4;
    const sel2: MarkdownSelection = { anchor: contPos, head: contPos };
    const tx2 = createListIndentTransaction(source, sel2);
    expect(tx2).not.toBeNull();
    const session2 = new MarkdownDocumentSession(source, sel2);
    const snap2 = session2.dispatch(tx2!);
    const expectedContPos = snap2.source.indexOf('Continuation') + 4;
    expect(snap2.selection.head).toBe(expectedContPos);

    // 3. Cursor on grandchild line inside 'Grandchild' (pos 42 in original source)
    const grandPos = source.indexOf('Grandchild') + 3;
    const sel3: MarkdownSelection = { anchor: grandPos, head: grandPos };
    const tx3 = createListIndentTransaction(source, sel3);
    expect(tx3).not.toBeNull();
    const session3 = new MarkdownDocumentSession(source, sel3);
    const snap3 = session3.dispatch(tx3!);
    const expectedGrandPos = snap3.source.indexOf('Grandchild') + 3;
    expect(snap3.selection.head).toBe(expectedGrandPos);
  });

  it('maps selection accurately across CJK, Emoji, and CRLF in indented list items', () => {
    const source = '- 列表项一🌟\r\n- 列表项二🚀\r\n  补充内容📝';
    const cursor = source.indexOf('🚀');
    const selection: MarkdownSelection = { anchor: cursor, head: cursor };
    const tx = createListIndentTransaction(source, selection);

    expect(tx).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(tx!);

    expect(snapshot.source).toBe('- 列表项一🌟\r\n  - 列表项二🚀\r\n    补充内容📝');
    const expectedCursor = snapshot.source.indexOf('🚀');
    expect(snapshot.selection.anchor).toBe(expectedCursor);
    expect(snapshot.selection.head).toBe(expectedCursor);
  });

  it('maps selection accurately inside nested code blocks and blockquotes during list indent', () => {
    const source = '- Item 1\n- Item 2\n  ```ts\n  const x = 42;\n  ```\n  > inner quote';
    const codeCursor = source.indexOf('const x = 42;');
    const selection: MarkdownSelection = { anchor: codeCursor, head: codeCursor };
    const tx = createListIndentTransaction(source, selection);

    expect(tx).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(tx!);

    const expectedPos = snapshot.source.indexOf('const x = 42;');
    expect(snapshot.selection.anchor).toBe(expectedPos);
    expect(snapshot.selection.head).toBe(expectedPos);
  });
});

describe('Edit Transactions: Multi-level Blockquote and List AST Traversal', () => {
  it('indents and outdents multi-level nested blockquote list items: > - parent > > - nested', () => {
    // Structure:
    // > - parent
    // >   > - nested 1
    // >   > - nested 2
    // >   >   - grandchild
    const source = '> - parent\n>   > - nested 1\n>   > - nested 2\n>   >   - grandchild';
    const nested2Pos = source.indexOf('nested 2');
    const selection: MarkdownSelection = { anchor: nested2Pos, head: nested2Pos };

    // Indent nested 2
    const indentTx = createListIndentTransaction(source, selection);
    expect(indentTx).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapIndent = session.dispatch(indentTx!);

    expect(snapIndent.source).toBe(
      '> - parent\n>   > - nested 1\n>   >   - nested 2\n>   >     - grandchild'
    );

    // Outdent back
    const outdentTx = createListOutdentTransaction(snapIndent.source, snapIndent.selection);
    expect(outdentTx).not.toBeNull();
    const snapOutdent = session.dispatch(outdentTx!);
    expect(snapOutdent.source).toBe(source);
  });

  it('indents and outdents list items enclosing blockquotes: - parent > quote - nested', () => {
    // Structure:
    // - parent
    //   > quote
    //   - child 1
    //   - child 2
    const source = '- parent\n  > quote\n  - child 1\n  - child 2';
    const child2Pos = source.indexOf('child 2');
    const selection: MarkdownSelection = { anchor: child2Pos, head: child2Pos };

    const indentTx = createListIndentTransaction(source, selection);
    expect(indentTx).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snap = session.dispatch(indentTx!);

    expect(snap.source).toBe('- parent\n  > quote\n  - child 1\n    - child 2');
  });

  it('supports varied quote prefix styles (> >, >   >, CRLF) without corrupting sibling items', () => {
    const source = '> > - Item A\r\n> > - Item B\r\n> > - Item C';
    const itemBPos = source.indexOf('Item B');
    const selection: MarkdownSelection = { anchor: itemBPos, head: itemBPos };

    const tx = createListIndentTransaction(source, selection);
    expect(tx).not.toBeNull();
    const session = new MarkdownDocumentSession(source, selection);
    const snapshot = session.dispatch(tx!);

    expect(snapshot.source).toBe('> > - Item A\r\n> >   - Item B\r\n> > - Item C');
  });
});

describe('Edit Transactions: AST-driven Atomic Ranges and Formatting Spans', () => {
  it('extracts atomic ranges from AST for code, math, wikilinks, links, images, HTML, and escapes', () => {
    const source = 'Code `foo_bar` and $x+y$ and [[WikiPage|Alias]] and [Link](https://example.com) and ![Img](pic.png) and <span class="tag">html</span> and \\*escaped\\* text';
    const ranges = findAtomicRanges(source);

    expect(ranges.length).toBeGreaterThanOrEqual(7);
    expect(ranges.some((r) => r.type === 'inline-code')).toBe(true);
    expect(ranges.some((r) => r.type === 'inline-math')).toBe(true);
    expect(ranges.some((r) => r.type === 'wikilink')).toBe(true);
    expect(ranges.some((r) => r.type === 'link')).toBe(true);
    expect(ranges.some((r) => r.type === 'image')).toBe(true);
    expect(ranges.some((r) => r.type === 'raw-html' || r.type === 'raw')).toBe(true);
    expect(ranges.some((r) => r.type === 'escape')).toBe(true);
  });

  it('extracts formatting spans from AST for bold and italic including alternative delimiters and nesting', () => {
    const source = '**bold** and __alt_bold__ and *italic* and _alt_italic_ and **bold *nested* text**';
    const spans = findFormattingSpans(source);

    expect(spans.length).toBeGreaterThanOrEqual(5);
    expect(spans.some((s) => s.type === 'strong' && s.open === '**')).toBe(true);
    expect(spans.some((s) => s.type === 'strong' && s.open === '__')).toBe(true);
    expect(spans.some((s) => s.type === 'emphasis' && s.open === '*')).toBe(true);
    expect(spans.some((s) => s.type === 'emphasis' && s.open === '_')).toBe(true);
  });
});

describe('Edit Transactions: Block Selection and Block Reorder', () => {
  it('selects a block by position or index using AST ranges', () => {
    const source = '# Heading 1\n\nParagraph text here\n\n- List item 1\n- List item 2';
    // Select block at pos 15 (inside paragraph)
    const tx = createSelectBlockTransaction(source, 15);
    expect(tx).not.toBeNull();
    expect(tx?.changes).toHaveLength(0);
    expect(tx?.selection).toEqual({
      anchor: source.indexOf('Paragraph text here'),
      head: source.indexOf('Paragraph text here') + 'Paragraph text here'.length
    });
    expect(tx?.userEvent).toBe('select.block');
  });

  it('reorders blocks by swapping their source ranges via a single Markdown transaction', () => {
    const source = '# Heading 1\n\nParagraph text\n\n- Item 1\n- Item 2';
    // Reorder block 0 (Heading) and block 1 (Paragraph)
    const tx = createReorderBlockTransaction(source, 0, 1);
    expect(tx).not.toBeNull();

    const session = new MarkdownDocumentSession(source);
    const snapshot = session.dispatch(tx!);

    expect(snapshot.source).toBe('Paragraph text\n\n# Heading 1\n\n- Item 1\n- Item 2');
    expect(snapshot.selection).toEqual({
      anchor: 0,
      head: 'Paragraph text'.length
    });
    expect(tx?.userEvent).toBe('block.reorder');

    // Single undo restores original block order
    expect(session.undo()).toBe(true);
    expect(session.getSnapshot().source).toBe(source);
  });

  it('preserves exact block slices, block trailing spaces, inter-block gap newlines, and EOF during block reorder', () => {
    // Block 0: Heading 1
    // Gap 0: \n\n (2 newlines)
    // Block 1: Paragraph text with 2 trailing spaces (hard break)
    // Gap 1: \n\n\n (3 newlines)
    // Block 2: Unordered list without trailing newline
    const source = '# Heading 1\n\nParagraph text  \n\n\n- Item 1\n- Item 2';
    // Reorder block 1 (Paragraph with trailing spaces) and block 2 (List)
    const tx = createReorderBlockTransaction(source, 1, 2);
    expect(tx).not.toBeNull();

    const session = new MarkdownDocumentSession(source);
    const snapshot = session.dispatch(tx!);

    // Must preserve 2 trailing spaces on Paragraph, 3 newlines in gap, and original EOF
    const expected = '# Heading 1\n\n- Item 1\n- Item 2\n\n\nParagraph text  ';
    expect(snapshot.source).toBe(expected);

    // Re-parsed AST must validate into 3 blocks: Heading, List, Paragraph
    const { root } = parseMarkdown(snapshot.source);
    expect(root.children).toHaveLength(3);
    expect(root.children[0]?.type).toBe('heading');
    expect(root.children[1]?.type).toBe('list');
    expect(root.children[2]?.type).toBe('paragraph');

    // Undo restores original document exactly byte-for-byte
    expect(session.undo()).toBe(true);
    expect(session.getSnapshot().source).toBe(source);
  });

  it('traverses nested blockquotes and lists to arbitrary depth in findListItemAtPos', () => {
    // 1. Triple-nested quote with list items:
    // > - parent
    // >   > - nested
    // >   >   > - grandchild
    const source1 = '> - parent\n>   > - nested\n>   >   > - grandchild';
    const { root: root1 } = parseMarkdown(source1);

    const grandchildPos = source1.indexOf('grandchild');
    const ctxGrandchild = findListItemAtPos(root1, grandchildPos);
    expect(ctxGrandchild).not.toBeNull();
    expect(ctxGrandchild?.item.raw).toContain('grandchild');
    expect(ctxGrandchild?.quoteDepth).toBe(3);
    expect(ctxGrandchild?.parentItem).not.toBeNull();

    // 2. List containing nested blockquotes containing nested lists:
    // - parent
    //   > quote
    //     > > - nested item
    const source2 = '- parent\n  > quote\n    > > - nested item';
    const { root: root2 } = parseMarkdown(source2);

    const nestedItemPos = source2.indexOf('nested item');
    const ctxNestedItem = findListItemAtPos(root2, nestedItemPos);
    expect(ctxNestedItem).not.toBeNull();
    expect(ctxNestedItem?.item.raw).toContain('nested item');
    expect(ctxNestedItem?.quoteDepth).toBe(2);
  });

  it('preserves non-collapsed selection ranges across multi-line list indent and outdent roundtrip', () => {
    const source = '- Parent\n  - Item 1\n  - Item 2\n    Continuation text';
    // Select across 'Item 2' (from 'I' to '2')
    const item2Start = source.indexOf('Item 2');
    const item2End = item2Start + 'Item 2'.length;
    const initialSelection: MarkdownSelection = { anchor: item2Start, head: item2End };

    const indentTx = createListIndentTransaction(source, initialSelection);
    expect(indentTx).not.toBeNull();

    const session = new MarkdownDocumentSession(source, initialSelection);
    const indentedSnapshot = session.dispatch(indentTx!);

    expect(indentedSnapshot.source).toBe('- Parent\n  - Item 1\n    - Item 2\n      Continuation text');
    // Selection should be shifted by 2 spaces (the indent inserted before Item 2)
    expect(indentedSnapshot.selection).toEqual({
      anchor: item2Start + 2,
      head: item2End + 2
    });

    // Outdent restores exact original source and mapped selection
    const outdentTx = createListOutdentTransaction(indentedSnapshot.source, indentedSnapshot.selection);
    expect(outdentTx).not.toBeNull();

    const outdentedSnapshot = session.dispatch(outdentTx!);
    expect(outdentedSnapshot.source).toBe(source);
    expect(outdentedSnapshot.selection).toEqual(initialSelection);
  });

  it('selects deepest editable block at position without selecting adjacent gap', () => {
    // 1. In blockquote: > Block 1\n>\n> Block 2
    const source1 = '> Block 1\n>\n> Block 2';
    const block1Pos = source1.indexOf('Block 1') + 2;
    const tx1 = createSelectBlockAtPositionTransaction(source1, block1Pos);
    expect(tx1).not.toBeNull();
    expect(tx1?.selection).toEqual({
      anchor: source1.indexOf('Block 1'),
      head: source1.indexOf('Block 1') + 'Block 1'.length
    });

    // 2. In nested blockquote: > > Deep 1\n> >\n> > Deep 2
    const source2 = '> > Deep 1\n> >\n> > Deep 2';
    const deep1Pos = source2.indexOf('Deep 1') + 2;
    const tx2 = createSelectBlockAtPositionTransaction(source2, deep1Pos);
    expect(tx2).not.toBeNull();
    expect(tx2?.selection).toEqual({
      anchor: source2.indexOf('Deep 1'),
      head: source2.indexOf('Deep 1') + 'Deep 1'.length
    });

    // 3. In list item containing blockquote: - Item 1\n  > Quote 1\n  >\n  > Quote 2
    const source3 = '- Item 1\n  > Quote 1\n  >\n  > Quote 2';
    const quote1Pos = source3.indexOf('Quote 1') + 2;
    const tx3 = createSelectBlockAtPositionTransaction(source3, quote1Pos);
    expect(tx3).not.toBeNull();
    expect(tx3?.selection).toEqual({
      anchor: source3.indexOf('Quote 1'),
      head: source3.indexOf('Quote 1') + 'Quote 1'.length
    });

    // 4. Index-based selection on root
    const txIndex = createSelectBlockAtIndexTransaction(source1, 0);
    expect(txIndex).not.toBeNull();
    expect(txIndex?.selection).toEqual({
      anchor: 0,
      head: source1.length
    });
  });

  it('reorders blocks within nested blockquotes without leaking across container boundary', () => {
    const source = '> Block 1\n>\n> Block 2';
    const block1Pos = source.indexOf('Block 1') + 2;
    const block2Pos = source.indexOf('Block 2') + 2;

    // Moving Block 1 UP inside blockquote must return null (cannot cross container boundary)
    const txUp = createReorderBlockAtPositionTransaction(source, block1Pos, 'up');
    expect(txUp).toBeNull();

    // Moving Block 2 DOWN inside blockquote must return null
    const txDownInvalid = createReorderBlockAtPositionTransaction(source, block2Pos, 'down');
    expect(txDownInvalid).toBeNull();

    // Moving Block 1 DOWN swaps Block 1 and Block 2 within blockquote
    const txDown = createReorderBlockAtPositionTransaction(source, block1Pos, 'down');
    expect(txDown).not.toBeNull();

    const session = new MarkdownDocumentSession(source);
    const snapshot = session.dispatch(txDown!);

    expect(snapshot.source).toBe('> Block 2\n>\n> Block 1');

    // Verify AST structure after re-parse
    const { root } = parseMarkdown(snapshot.source);
    expect(root.children).toHaveLength(1);
    expect(root.children[0]?.type).toBe('blockquote');
    const bq = root.children[0]!;
    if (bq.type === 'blockquote') {
      expect(bq.children).toHaveLength(2);
      expect(bq.children[0]?.type).toBe('paragraph');
      expect(bq.children[1]?.type).toBe('paragraph');
    }

    // Moving Block 1 UP in new document restores original
    const block1NewPos = snapshot.source.indexOf('Block 1') + 2;
    const txBack = createReorderBlockAtPositionTransaction(snapshot.source, block1NewPos, 'up');
    expect(txBack).not.toBeNull();
    const restored = session.dispatch(txBack!);
    expect(restored.source).toBe(source);
  });

  it('reorders blocks within nested blockquotes and list items across multiple levels', () => {
    // 1. Nested blockquote (> > Block 1\n> >\n> > Block 2)
    const source1 = '> > Block 1\n> >\n> > Block 2';
    const pos1 = source1.indexOf('Block 1') + 1;
    const tx1 = createReorderBlockAtPositionTransaction(source1, pos1, 'down');
    expect(tx1).not.toBeNull();

    const session1 = new MarkdownDocumentSession(source1);
    const snap1 = session1.dispatch(tx1!);
    expect(snap1.source).toBe('> > Block 2\n> >\n> > Block 1');

    // 2. List item containing child blockquote (- Item 1\n  > Quote 1\n  >\n  > Quote 2)
    const source2 = '- Item 1\n  > Quote 1\n  >\n  > Quote 2';
    const pos2 = source2.indexOf('Quote 1') + 1;
    const tx2 = createReorderBlockAtPositionTransaction(source2, pos2, 'down');
    expect(tx2).not.toBeNull();

    const session2 = new MarkdownDocumentSession(source2);
    const snap2 = session2.dispatch(tx2!);
    expect(snap2.source).toBe('- Item 1\n  > Quote 2\n  >\n  > Quote 1');
  });

  it('preserves exact source formatting across all specified boundary cases (gaps, trailing spaces, CRLF, EOF, CJK, Emoji)', () => {
    // Document specified in requirements:
    // # A  \n\n\nParagraph with two trailing spaces  \n\n\n- Item A
    const source = '# A  \n\n\nParagraph with two trailing spaces  \n\n\n- Item A';

    // 1. Adjacent move: swap block 0 (# A  ) and block 1 (Paragraph with two trailing spaces  )
    const txAdj = createReorderBlockTransaction(source, 0, 1);
    expect(txAdj).not.toBeNull();
    const sessionAdj = new MarkdownDocumentSession(source);
    const snapAdj = sessionAdj.dispatch(txAdj!);

    expect(snapAdj.source).toBe('Paragraph with two trailing spaces  \n\n\n# A  \n\n\n- Item A');

    // 2. Non-adjacent move: swap block 0 and block 2 across multiple gaps
    const txNonAdj = createReorderBlockTransaction(source, 0, 2);
    expect(txNonAdj).not.toBeNull();
    const sessionNonAdj = new MarkdownDocumentSession(source);
    const snapNonAdj = sessionNonAdj.dispatch(txNonAdj!);

    expect(snapNonAdj.source).toBe('- Item A\n\n\nParagraph with two trailing spaces  \n\n\n# A  ');

    // 3. CRLF support
    const sourceCRLF = '# A  \r\n\r\n\r\nParagraph with two trailing spaces  \r\n\r\n\r\n- Item A';
    const txCRLF = createReorderBlockTransaction(sourceCRLF, 0, 1);
    expect(txCRLF).not.toBeNull();
    const sessionCRLF = new MarkdownDocumentSession(sourceCRLF);
    const snapCRLF = sessionCRLF.dispatch(txCRLF!);

    expect(snapCRLF.source).toBe('Paragraph with two trailing spaces  \r\n\r\n\r\n# A  \r\n\r\n\r\n- Item A');

    // 4. EOF with trailing newline preserved
    const sourceWithEOF = source + '\n';
    const txEOF = createReorderBlockTransaction(sourceWithEOF, 0, 1);
    expect(txEOF).not.toBeNull();
    const sessionEOF = new MarkdownDocumentSession(sourceWithEOF);
    const snapEOF = sessionEOF.dispatch(txEOF!);

    expect(snapEOF.source.endsWith('\n')).toBe(true);
    expect(snapEOF.source).toBe('Paragraph with two trailing spaces  \n\n\n# A  \n\n\n- Item A\n');

    // 5. CJK & Emoji support
    const sourceCJK = '# 标题 A 🚀  \n\n\n段落内容 🌟  \n\n\n- 列表项 A';
    const txCJK = createReorderBlockTransaction(sourceCJK, 0, 1);
    expect(txCJK).not.toBeNull();
    const sessionCJK = new MarkdownDocumentSession(sourceCJK);
    const snapCJK = sessionCJK.dispatch(txCJK!);

    expect(snapCJK.source).toBe('段落内容 🌟  \n\n\n# 标题 A 🚀  \n\n\n- 列表项 A');

    // 6. Selection mapping: cursor in moved block body preserves relative offset
    const cursorInPara = source.indexOf('two trailing');
    const relOffsetInPara = cursorInPara - source.indexOf('Paragraph with');
    const txSel = createReorderBlockTransaction(source, 1, 0, { anchor: cursorInPara, head: cursorInPara });
    expect(txSel).not.toBeNull();
    const sessionSel = new MarkdownDocumentSession(source, { anchor: cursorInPara, head: cursorInPara });
    const snapSel = sessionSel.dispatch(txSel!);

    expect(snapSel.selection.head).toBe(relOffsetInPara);

    // 7. Selection mapping: cursor at end of moved block
    const paraEnd = source.indexOf('Paragraph with two trailing spaces  ') + 'Paragraph with two trailing spaces  '.length;
    const txSelEnd = createReorderBlockTransaction(source, 1, 0, { anchor: paraEnd, head: paraEnd });
    expect(txSelEnd).not.toBeNull();
    const sessionSelEnd = new MarkdownDocumentSession(source, { anchor: paraEnd, head: paraEnd });
    const snapSelEnd = sessionSelEnd.dispatch(txSelEnd!);
    expect(snapSelEnd.selection.head).toBe('Paragraph with two trailing spaces  '.length);

    // 8. Multi-block spanning selection maps without silent truncation
    const multiSel: MarkdownSelection = {
      anchor: source.indexOf('# A'),
      head: source.indexOf('spaces  ')
    };
    const txMultiSel = createReorderBlockTransaction(source, 0, 1, multiSel);
    expect(txMultiSel).not.toBeNull();
    const sessionMulti = new MarkdownDocumentSession(source, multiSel);
    const snapMulti = sessionMulti.dispatch(txMultiSel!);
    expect(snapMulti.selection.anchor).toBeGreaterThanOrEqual(0);
    expect(snapMulti.selection.head).toBeGreaterThanOrEqual(0);
    expect(snapMulti.selection.anchor).not.toBe(snapMulti.selection.head);
  });

  it('accurately resolves block content boundaries and deepest block context', () => {
    const source = '# Heading\n\n> Text in quote\n\n- [ ] Item 1\n  Nested text';
    const { root } = parseMarkdown(source);

    // getContentEnd: heading node range has trailing newline, getContentEnd excludes it
    const heading = root.children[0]!;
    expect(source.slice(heading.range.from, heading.range.to)).toContain('\n');
    const headingContentEnd = getContentEnd(source, heading.range);
    expect(source.slice(heading.range.from, headingContentEnd)).toBe('# Heading');

    // findDeepestBlockAtPos inside blockquote
    const quotePos = source.indexOf('Text in quote');
    const quoteCtx = findDeepestBlockAtPos(root, quotePos, source.length);
    expect(quoteCtx).not.toBeNull();
    expect(quoteCtx?.node.type).toBe('paragraph');
    expect(quoteCtx?.path.some((n) => n.type === 'blockquote')).toBe(true);

    // findDeepestBlockAtPos inside list
    const itemPos = source.indexOf('Item 1');
    const itemCtx = findDeepestBlockAtPos(root, itemPos, source.length);
    expect(itemCtx).not.toBeNull();
    expect(itemCtx?.node.type).toBe('list-item');
  });

  it('findDeepestBlockAtPos returns null on all blank gap positions (single empty line, multiple empty lines, CRLF, start gap, end gap, quote inner gap, list inner gap, nested mixed gap)', () => {
    // 1. Single empty line gap between two blocks
    const sourceSingle = 'Block 1\n\nBlock 2';
    const rootSingle = parseMarkdown(sourceSingle).root;
    const gapSingle = sourceSingle.indexOf('\n\n') + 1; // index 8, on the blank line
    expect(findDeepestBlockAtPos(rootSingle, gapSingle, sourceSingle)).toBeNull();

    // 2. Multiple consecutive empty lines gap
    const sourceMulti = 'Block 1\n\n\n\nBlock 2';
    const rootMulti = parseMarkdown(sourceMulti).root;
    const gapMulti1 = sourceMulti.indexOf('\n\n\n\n') + 1;
    const gapMulti2 = sourceMulti.indexOf('\n\n\n\n') + 2;
    expect(findDeepestBlockAtPos(rootMulti, gapMulti1, sourceMulti)).toBeNull();
    expect(findDeepestBlockAtPos(rootMulti, gapMulti2, sourceMulti)).toBeNull();

    // 3. CRLF empty line gap
    const sourceCRLF = 'Block 1\r\n\r\nBlock 2';
    const rootCRLF = parseMarkdown(sourceCRLF).root;
    const gapCRLF = sourceCRLF.indexOf('\r\n\r\n') + 2; // on the second CRLF
    expect(findDeepestBlockAtPos(rootCRLF, gapCRLF, sourceCRLF)).toBeNull();

    // 4. Document start gap
    const sourceStart = '\n\n# Heading';
    const rootStart = parseMarkdown(sourceStart).root;
    expect(findDeepestBlockAtPos(rootStart, 0, sourceStart)).toBeNull();
    expect(findDeepestBlockAtPos(rootStart, 1, sourceStart)).toBeNull();

    // 5. Document end gap
    const sourceEnd = '# Heading\n\n\n';
    const rootEnd = parseMarkdown(sourceEnd).root;
    const endGap1 = sourceEnd.length - 1;
    const endGap2 = sourceEnd.length - 2;
    expect(findDeepestBlockAtPos(rootEnd, endGap1, sourceEnd)).toBeNull();
    expect(findDeepestBlockAtPos(rootEnd, endGap2, sourceEnd)).toBeNull();

    // 6. Blockquote inner gap
    const sourceQuote = '> Block 1\n>\n> Block 2';
    const rootQuote = parseMarkdown(sourceQuote).root;
    const quoteGap = sourceQuote.indexOf('\n>\n') + 1; // at '>\n' empty line
    expect(findDeepestBlockAtPos(rootQuote, quoteGap, sourceQuote)).toBeNull();

    // 7. List item inner gap (loose list)
    const sourceList = '- Item 1\n\n- Item 2';
    const rootList = parseMarkdown(sourceList).root;
    const listGap = sourceList.indexOf('\n\n') + 1;
    expect(findDeepestBlockAtPos(rootList, listGap, sourceList)).toBeNull();

    // 8. Multi-level blockquote/list mixed nesting gap
    const sourceNested = '> - Item 1\n>\n> - Item 2';
    const rootNested = parseMarkdown(sourceNested).root;
    const nestedGap = sourceNested.indexOf('\n>\n') + 1;
    expect(findDeepestBlockAtPos(rootNested, nestedGap, sourceNested)).toBeNull();
  });

  it('findDeepestBlockAtPos returns null when pos is exactly at getContentEnd or EOF newline', () => {
    // 1. Document without EOF newline: pos === contentEnd === source.length
    const sourceNoEOF = 'Paragraph';
    const rootNoEOF = parseMarkdown(sourceNoEOF).root;
    const contentEndNoEOF = sourceNoEOF.length; // 9
    // Characters 0..8 are in block
    expect(findDeepestBlockAtPos(rootNoEOF, 0, sourceNoEOF)).not.toBeNull();
    expect(findDeepestBlockAtPos(rootNoEOF, 8, sourceNoEOF)).not.toBeNull();
    // pos === contentEnd (9) returns null
    expect(findDeepestBlockAtPos(rootNoEOF, contentEndNoEOF, sourceNoEOF)).toBeNull();
    // pos out of bounds (10) returns null
    expect(findDeepestBlockAtPos(rootNoEOF, contentEndNoEOF + 1, sourceNoEOF)).toBeNull();

    // 2. Document with EOF newline: pos === contentEnd is at the newline
    const sourceWithEOF = 'Paragraph\n';
    const rootWithEOF = parseMarkdown(sourceWithEOF).root;
    const contentEndWithEOF = 9; // 'Paragraph' end, '\n' is at index 9
    expect(findDeepestBlockAtPos(rootWithEOF, 8, sourceWithEOF)).not.toBeNull();
    expect(findDeepestBlockAtPos(rootWithEOF, contentEndWithEOF, sourceWithEOF)).toBeNull();
    expect(findDeepestBlockAtPos(rootWithEOF, sourceWithEOF.length, sourceWithEOF)).toBeNull();

    // 3. Document with CRLF EOF newline
    const sourceWithCRLF = 'Paragraph\r\n';
    const rootWithCRLF = parseMarkdown(sourceWithCRLF).root;
    const contentEndCRLF = 9;
    expect(findDeepestBlockAtPos(rootWithCRLF, 8, sourceWithCRLF)).not.toBeNull();
    expect(findDeepestBlockAtPos(rootWithCRLF, contentEndCRLF, sourceWithCRLF)).toBeNull(); // at \r
    expect(findDeepestBlockAtPos(rootWithCRLF, contentEndCRLF + 1, sourceWithCRLF)).toBeNull(); // at \n
    expect(findDeepestBlockAtPos(rootWithCRLF, sourceWithCRLF.length, sourceWithCRLF)).toBeNull(); // at EOF
  });

  describe('createReorderBlockToPositionTransaction', () => {
    it('reorders adjacent blocks in root container', () => {
      const source = '# Block 1\n\n# Block 2';
      const p1 = source.indexOf('# Block 1');
      const p2 = source.indexOf('# Block 2');
      const tx = createReorderBlockToPositionTransaction(source, p1, p2);
      expect(tx).not.toBeNull();
      const session = new MarkdownDocumentSession(source);
      const snap = session.dispatch(tx!);
      expect(snap.source).toBe('# Block 2\n\n# Block 1');
    });

    it('reorders non-adjacent blocks in root container', () => {
      const source = '# A\n\n# B\n\n# C';
      const pA = source.indexOf('# A');
      const pC = source.indexOf('# C');
      const tx = createReorderBlockToPositionTransaction(source, pA, pC);
      expect(tx).not.toBeNull();
      const session = new MarkdownDocumentSession(source);
      const snap = session.dispatch(tx!);
      expect(snap.source).toBe('# C\n\n# B\n\n# A');
    });

    it('reorders blocks within blockquote container', () => {
      const source = '> Paragraph 1\n>\n> Paragraph 2';
      const p1 = source.indexOf('Paragraph 1');
      const p2 = source.indexOf('Paragraph 2');
      const tx = createReorderBlockToPositionTransaction(source, p1, p2);
      expect(tx).not.toBeNull();
      const session = new MarkdownDocumentSession(source);
      const snap = session.dispatch(tx!);
      expect(snap.source).toBe('> Paragraph 2\n>\n> Paragraph 1');
    });

    it('reorders list items within list container', () => {
      const source = '- Item 1\n- Item 2\n- Item 3';
      const p1 = source.indexOf('Item 1');
      const p3 = source.indexOf('Item 3');
      const tx = createReorderBlockToPositionTransaction(source, p1, p3);
      expect(tx).not.toBeNull();
      const session = new MarkdownDocumentSession(source);
      const snap = session.dispatch(tx!);
      expect(snap.source).toBe('- Item 3\n- Item 2\n- Item 1');
    });

    it('reorders nested blockquotes and lists', () => {
      const source = '> - Parent\n>   - Nested 1\n>   - Nested 2';
      const p1 = source.indexOf('Nested 1');
      const p2 = source.indexOf('Nested 2');
      const tx = createReorderBlockToPositionTransaction(source, p1, p2);
      expect(tx).not.toBeNull();
      const session = new MarkdownDocumentSession(source);
      const snap = session.dispatch(tx!);
      expect(snap.source).toBe('> - Parent\n>   - Nested 2\n>   - Nested 1');
    });

    it('returns null (no-op) when attempting to reorder across different containers', () => {
      const source = '# Heading\n\n> Quote block';
      const pHeading = source.indexOf('# Heading');
      const pQuote = source.indexOf('Quote block');
      expect(createReorderBlockToPositionTransaction(source, pHeading, pQuote)).toBeNull();
      expect(createReorderBlockToPositionTransaction(source, pQuote, pHeading)).toBeNull();
    });

    it('returns null (no-op) when source or target is in a blank gap', () => {
      const source = 'Block 1\n\nBlock 2';
      const p1 = source.indexOf('Block 1');
      const gapPos = source.indexOf('\n\n') + 1;
      expect(createReorderBlockToPositionTransaction(source, p1, gapPos)).toBeNull();
      expect(createReorderBlockToPositionTransaction(source, gapPos, p1)).toBeNull();
    });

    it('returns null (no-op) when source and target refer to the same block', () => {
      const source = 'Block 1\n\nBlock 2';
      const p1 = source.indexOf('Block 1');
      const p1End = p1 + 3;
      expect(createReorderBlockToPositionTransaction(source, p1, p1End)).toBeNull();
    });

    it('preserves exact source formatting: trailing spaces, multiple empty lines, CRLF, EOF, CJK, Emoji', () => {
      const source = '段落一🌟  \r\n\r\n\r\n段落二🚀\r\n';
      const p1 = source.indexOf('段落一');
      const p2 = source.indexOf('段落二');
      const sel = { anchor: p1 + 2, head: p1 + 2 };
      const tx = createReorderBlockToPositionTransaction(source, p1, p2, sel);
      expect(tx).not.toBeNull();
      const session = new MarkdownDocumentSession(source, sel);
      const snap = session.dispatch(tx!);
      expect(snap.source).toBe('段落二🚀\r\n\r\n\r\n段落一🌟  \r\n');
      expect(snap.selection.head).toBeGreaterThan(0);
    });
  });
});

describe('Edit Transactions: Inline Code and Clear Formatting (P0-7)', () => {
  type Kind = 'inline-code' | 'clear';

  const apply = (source: string, selection: MarkdownSelection, kind: Kind) => {
    const transaction = createInlineFormatTransaction(source, selection, kind);
    if (!transaction) return null;
    const session = new MarkdownDocumentSession(source, selection);
    return session.dispatch(transaction);
  };

  const around = (source: string, needle: string): MarkdownSelection => {
    const from = source.indexOf(needle);
    if (from < 0) throw new Error(`needle not found: ${needle}`);
    return { anchor: from, head: from + needle.length };
  };

  describe('inline-code: wrapping', () => {
    it('wraps a plain selection in a single backtick fence', () => {
      const source = 'Hello world here';
      const snapshot = apply(source, around(source, 'world'), 'inline-code');

      expect(snapshot?.source).toBe('Hello `world` here');
      expect(snapshot?.selection).toEqual({ anchor: 7, head: 12 });
    });

    it('lengthens the fence past the longest backtick run in the content', () => {
      const source = 'code a`b end';
      const snapshot = apply(source, around(source, 'a`b'), 'inline-code');

      expect(snapshot?.source).toBe('code ``a`b`` end');
    });

    it('pads with a space when the content starts or ends with a backtick', () => {
      const source = 'v `a w';
      const snapshot = apply(source, { anchor: 2, head: 4 }, 'inline-code');

      expect(snapshot?.source).toBe('v `` `a `` w');
    });

    it('rejects a selection whose boundary cuts into an atomic node', () => {
      // 从 `` `val` `` 的中间开始，会把行内代码切一半
      expect(
        createInlineFormatTransaction('See `val` here', { anchor: 5, head: 12 }, 'inline-code')
      ).toBeNull();
    });

    it('rejects a selection that swallows a link', () => {
      const source = 'go [a](b) now';
      expect(
        createInlineFormatTransaction(source, { anchor: 0, head: source.length }, 'inline-code')
      ).toBeNull();
    });

    it('rejects a collapsed selection', () => {
      expect(createInlineFormatTransaction('Hello', { anchor: 2, head: 2 }, 'inline-code')).toBeNull();
    });
  });

  describe('inline-code: unwrapping', () => {
    it('unwraps when the selection is exactly the whole inline code', () => {
      const source = 'See `val` here';
      const snapshot = apply(source, { anchor: 4, head: 9 }, 'inline-code');

      expect(snapshot?.source).toBe('See val here');
      expect(snapshot?.selection).toEqual({ anchor: 4, head: 7 });
    });

    it('unwraps when the selection is only the content inside the fence', () => {
      // 「包完再按一次」就是选区落在内容上的形状 —— 不认它等于包上去解不开
      const source = 'See `val` here';
      const snapshot = apply(source, { anchor: 5, head: 8 }, 'inline-code');

      expect(snapshot?.source).toBe('See val here');
      expect(snapshot?.selection).toEqual({ anchor: 4, head: 7 });
    });

    it('drops the padding together with the fence', () => {
      const source = 'x `` a `` y';
      const snapshot = apply(source, { anchor: 2, head: 9 }, 'inline-code');

      expect(snapshot?.source).toBe('x a y');
    });

    it('round-trips: wrap then unwrap restores the original source', () => {
      const source = 'Hello world here';
      const wrapped = apply(source, around(source, 'world'), 'inline-code');
      expect(wrapped?.source).toBe('Hello `world` here');

      const unwrapped = apply(wrapped!.source, wrapped!.selection, 'inline-code');
      expect(unwrapped?.source).toBe(source);
    });
  });

  describe('inline-code: line endings', () => {
    it('keeps CRLF offsets intact', () => {
      const source = 'one\r\ntwo three\r\n';
      const snapshot = apply(source, around(source, 'two'), 'inline-code');

      expect(snapshot?.source).toBe('one\r\n`two` three\r\n');
    });
  });

  describe('clear formatting', () => {
    it('strips every marker in the selection while leaving the text untouched', () => {
      const source = '**bold** and _italic_ and ~~gone~~';
      const snapshot = apply(source, { anchor: 0, head: source.length }, 'clear');

      expect(snapshot?.source).toBe('bold and italic and gone');
    });

    it('clears a marker when the selection sits inside it', () => {
      const source = 'Hello **world** here';
      const snapshot = apply(source, around(source, 'world'), 'clear');

      expect(snapshot?.source).toBe('Hello world here');
      expect(snapshot?.selection).toEqual({ anchor: 6, head: 11 });
    });

    it('strips nested markers on both levels', () => {
      const source = 'Some ***both*** here';
      const snapshot = apply(source, around(source, 'both'), 'clear');

      expect(snapshot?.source).toBe('Some both here');
    });

    it('strips inline-code fences together with their padding', () => {
      const source = 'a `x` b `` `y` `` c';
      const snapshot = apply(source, { anchor: 0, head: source.length }, 'clear');

      expect(snapshot?.source).toBe('a x b `y` c');
    });

    it('clears formatting inside a link without touching the link itself', () => {
      const source = 'see [**a**](url) now';
      const snapshot = apply(source, around(source, 'a'), 'clear');

      expect(snapshot?.source).toBe('see [a](url) now');
    });

    it('returns null when there is nothing to clear (no empty transaction in the undo stack)', () => {
      const source = 'plain text here';
      expect(
        createInlineFormatTransaction(source, { anchor: 0, head: source.length }, 'clear')
      ).toBeNull();
    });

    it('returns null inside a fenced code block', () => {
      const source = '```\n**not bold**\n```';
      expect(
        createInlineFormatTransaction(source, { anchor: 4, head: 16 }, 'clear')
      ).toBeNull();
    });

    it('returns null for a collapsed selection', () => {
      expect(createInlineFormatTransaction('**bold**', { anchor: 3, head: 3 }, 'clear')).toBeNull();
    });

    it('keeps CJK and emoji byte-for-byte', () => {
      const source = '**段落🌟** 与 _斜体🚀_';
      const snapshot = apply(source, { anchor: 0, head: source.length }, 'clear');

      expect(snapshot?.source).toBe('段落🌟 与 斜体🚀');
    });
  });

  describe('fence helpers', () => {
    it('readInlineCodeFence reports content bounds that already exclude the padding', () => {
      const source = 'x `` a `` y';
      const fence = readInlineCodeFence(source, 2, 9);

      expect(fence.open).toBe('`` ');
      expect(fence.close).toBe(' ``');
      expect(source.slice(fence.contentFrom, fence.contentTo)).toBe('a');
    });

    it('inlineCodeFenceFor always beats the longest backtick run in the content', () => {
      expect(inlineCodeFenceFor('plain')).toBe('`');
      expect(inlineCodeFenceFor('a`b')).toBe('``');
      expect(inlineCodeFenceFor('a``b')).toBe('```');
    });
  });

  describe('formatting query', () => {
    it('reports the markers the selection sits inside', () => {
      const source = 'a **b** c `d`';
      const doc = EditorState.create({ doc: source }).doc;
      const analyze = createFormattingAnalyzer();

      expect(analyze(doc, around(source, 'b')).active).toEqual(['strong']);
      expect(analyze(doc, around(source, 'd')).active).toEqual(['inline-code']);
      expect(analyze(doc, { anchor: 0, head: 1 }).active).toEqual([]);
    });

    it('flags selections inside atomic nodes with the same expression the transaction guards on', () => {
      const source = 'See `val` here';
      const doc = EditorState.create({ doc: source }).doc;
      const analyze = createFormattingAnalyzer();
      const selection = { anchor: 5, head: 12 };

      expect(analyze(doc, selection).atomic).toBe(true);
      expect(createInlineFormatTransaction(source, selection, 'strong')).toBeNull();

      expect(analyze(doc, { anchor: 0, head: 3 }).atomic).toBe(false);
    });

    it('scans once per document version, no matter how often the selection moves', () => {
      const source = '**bold** plain text here';
      const doc = EditorState.create({ doc: source }).doc;
      let calls = 0;
      const analyze = createFormattingAnalyzer((text) => {
        calls += 1;
        return scanFormatting(text);
      });

      for (let i = 0; i < 50; i += 1) {
        const at = i % (source.length - 1);
        analyze(doc, { anchor: at, head: at + 1 });
      }

      expect(calls).toBe(1);
    });

    it('re-scans when the document version changes', () => {
      const docA = EditorState.create({ doc: 'plain' }).doc;
      const docB = EditorState.create({ doc: '**bold**' }).doc;
      let calls = 0;
      const analyze = createFormattingAnalyzer((text) => {
        calls += 1;
        return scanFormatting(text);
      });

      analyze(docA, { anchor: 0, head: 1 });
      analyze(docB, { anchor: 2, head: 4 });

      expect(calls).toBe(2);
    });
  });
});



