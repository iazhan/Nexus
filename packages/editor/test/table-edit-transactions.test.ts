import { describe, expect, it } from 'vitest';
import { parseMarkdown, getRowCellRanges, type MarkdownBlockNode } from '@nexus/markdown';
import {
  parseTableContext,
  findTableAtPosition,
  findTableCellAtPosition,
  createTableCellEditTransaction,
  createTableAddRowTransaction,
  createTableDeleteRowTransaction,
  createTableAddColumnTransaction,
  createTableDeleteColumnTransaction,
  createTableSetAlignTransaction,
  verifyCandidateTable,
  applyChangesToSource
} from '../src/index.js';

describe('P1-04E Table Edit Transactions (Pure AST & SourceRange)', () => {
  const sampleTableSource = [
    '# Table Document',
    '',
    '| Name | Age | City |',
    '| :--- | :---: | ---: |',
    '| Alice | 24 | London |',
    '| Bob | 30 | New York |',
    '',
    'Trailing paragraph.'
  ].join('\n');

  describe('A. Table Parsing and Context Extraction', () => {
    it('parses TableContext and extracts rows and alignment', () => {
      const parsed = parseMarkdown(sampleTableSource);
      const tableNode = parsed.root.children.find((c) => c.type === 'table')!;
      expect(tableNode).toBeDefined();

      const context = parseTableContext(sampleTableSource, tableNode as Extract<MarkdownBlockNode, { type: 'table' }>);
      expect(context.headers).toHaveLength(3);
      expect(context.rows).toHaveLength(2);
      expect(context.align).toEqual(['left', 'center', 'right']);
      expect(context.raw).toBe(sampleTableSource.split('\n').slice(2, 6).join('\n') + '\n');
    });

    it('findTableAtPosition locates table correctly', () => {
      const pos = sampleTableSource.indexOf('Alice');
      const context = findTableAtPosition(sampleTableSource, pos);
      expect(context).not.toBeNull();
      expect(context!.rows).toHaveLength(2);
    });

    it('returns null when pos equals table.range.to or is on trailing newline/gap (half-open interval)', () => {
      const posAlice = sampleTableSource.indexOf('Alice');
      const context = findTableAtPosition(sampleTableSource, posAlice)!;
      // Exact boundary `to` must not be considered inside the table
      expect(findTableAtPosition(sampleTableSource, context.tableRange.to)).toBeNull();

      // Trailing newline at the end of table raw
      const trailingNlPos = context.tableRange.from + context.raw.length - 1;
      expect(findTableAtPosition(sampleTableSource, trailingNlPos)).toBeNull();
    });

    it('findTableCellAtPosition locates specific cell in header and body and returns null on delimiter pipes or newline', () => {
      const posAlice = sampleTableSource.indexOf('Alice');
      const tableCtx = findTableAtPosition(sampleTableSource, posAlice)!;
      const cellAlice = findTableCellAtPosition(tableCtx, posAlice);
      expect(cellAlice).not.toBeNull();
      expect(cellAlice!.rowIndex).toBe(0);
      expect(cellAlice!.colIndex).toBe(0);
      expect(cellAlice!.cellRaw.trim()).toBe('Alice');

      const posAge = sampleTableSource.indexOf('Age');
      const cellAge = findTableCellAtPosition(tableCtx, posAge);
      expect(cellAge).not.toBeNull();
      expect(cellAge!.rowIndex).toBe(-1); // Header row
      expect(cellAge!.colIndex).toBe(1);

      // Pipe delimiter '|' between cells must return null
      const pipePos = sampleTableSource.indexOf('|', posAlice);
      expect(findTableCellAtPosition(tableCtx, pipePos)).toBeNull();

      // Trailing newline must return null
      const nlPos = sampleTableSource.indexOf('\n', posAlice);
      expect(findTableCellAtPosition(tableCtx, nlPos)).toBeNull();
    });

    it('locates and edits tables nested inside blockquotes and deeply nested containers', () => {
      const nestedSource = [
        '> # Quote',
        '> | Nested Header 1 | Nested Header 2 |',
        '> | :--- | ---: |',
        '> | Value A | Value B |',
        '',
        '> > | Deep Header 1 | Deep Header 2 |',
        '> > | --- | --- |',
        '> > | Deep Val 1 | Deep Val 2 |'
      ].join('\n');

      // Table inside blockquote
      const posBq = nestedSource.indexOf('Value A');
      const tableBq = findTableAtPosition(nestedSource, posBq);
      expect(tableBq).not.toBeNull();
      const cellBq = findTableCellAtPosition(tableBq!, posBq);
      expect(cellBq).not.toBeNull();
      const txBq = createTableCellEditTransaction(nestedSource, cellBq!, 'New Value A');
      expect(txBq).not.toBeNull();

      // Table inside deeply nested blockquote
      const posDeep = nestedSource.indexOf('Deep Val 1');
      const tableDeep = findTableAtPosition(nestedSource, posDeep);
      expect(tableDeep).not.toBeNull();
      const cellDeep = findTableCellAtPosition(tableDeep!, posDeep);
      expect(cellDeep).not.toBeNull();
      const txDeep = createTableCellEditTransaction(nestedSource, cellDeep!, 'New Deep Val');
      expect(txDeep).not.toBeNull();
    });
  });

  describe('B. Cell Text Editing', () => {
    it('modifies table body cell text and preserves surrounding whitespace', () => {
      const pos = sampleTableSource.indexOf('Alice');
      const tableCtx = findTableAtPosition(sampleTableSource, pos)!;
      const cellCtx = findTableCellAtPosition(tableCtx, pos)!;

      const tx = createTableCellEditTransaction(sampleTableSource, cellCtx, 'Alicia');
      expect(tx).not.toBeNull();
      expect(tx!.userEvent).toBe('table.cell-edit');

      const next = applyChangesToSource(sampleTableSource, tx!.changes);
      expect(next).toContain('| Alicia | 24 | London |');
      expect(next).toContain('Trailing paragraph.');
    });

    it('escapes unescaped pipe characters in new cell value to protect table structure', () => {
      const pos = sampleTableSource.indexOf('Alice');
      const tableCtx = findTableAtPosition(sampleTableSource, pos)!;
      const cellCtx = findTableCellAtPosition(tableCtx, pos)!;

      const tx = createTableCellEditTransaction(sampleTableSource, cellCtx, 'Alice | Bob');
      expect(tx).not.toBeNull();

      const next = applyChangesToSource(sampleTableSource, tx!.changes);
      expect(next).toContain('| Alice \\| Bob | 24 | London |');
    });

    it('preserves CRLF line endings when modifying a cell in CRLF table', () => {
      const crlfSource = sampleTableSource.replace(/\n/g, '\r\n');
      const pos = crlfSource.indexOf('Bob');
      const tableCtx = findTableAtPosition(crlfSource, pos)!;
      const cellCtx = findTableCellAtPosition(tableCtx, pos)!;

      const tx = createTableCellEditTransaction(crlfSource, cellCtx, 'Robert');
      expect(tx).not.toBeNull();

      const next = applyChangesToSource(crlfSource, tx!.changes);
      expect(next).toContain('\r\n| Robert | 30 | New York |\r\n');
      expect(next.includes('\r\n')).toBe(true);
    });

    it('handles CJK characters and Emoji in cell editing', () => {
      const pos = sampleTableSource.indexOf('London');
      const tableCtx = findTableAtPosition(sampleTableSource, pos)!;
      const cellCtx = findTableCellAtPosition(tableCtx, pos)!;

      const tx = createTableCellEditTransaction(sampleTableSource, cellCtx, '北京 🚀');
      expect(tx).not.toBeNull();

      const next = applyChangesToSource(sampleTableSource, tx!.changes);
      expect(next).toContain('| Alice | 24 | 北京 🚀 |');
    });
  });

  describe('C. Add and Delete Rows', () => {
    it('adds a new row at the end of the table', () => {
      const pos = sampleTableSource.indexOf('Alice');
      const tableCtx = findTableAtPosition(sampleTableSource, pos)!;

      const tx = createTableAddRowTransaction(sampleTableSource, tableCtx);
      expect(tx).not.toBeNull();
      expect(tx!.userEvent).toBe('table.add-row');

      const next = applyChangesToSource(sampleTableSource, tx!.changes);
      const reparsed = parseMarkdown(next);
      const tableAfter = reparsed.root.children.find((c) => c.type === 'table') as Extract<MarkdownBlockNode, { type: 'table' }>;
      expect(tableAfter.rows).toHaveLength(3);
    });

    it('deletes a row in the middle of the table', () => {
      const pos = sampleTableSource.indexOf('Alice');
      const tableCtx = findTableAtPosition(sampleTableSource, pos)!;

      // Delete Alice (row 0)
      const tx = createTableDeleteRowTransaction(sampleTableSource, tableCtx, 0);
      expect(tx).not.toBeNull();
      expect(tx!.userEvent).toBe('table.delete-row');

      const next = applyChangesToSource(sampleTableSource, tx!.changes);
      expect(next).not.toContain('Alice');
      expect(next).toContain('Bob');

      const reparsed = parseMarkdown(next);
      const tableAfter = reparsed.root.children.find((c) => c.type === 'table') as Extract<MarkdownBlockNode, { type: 'table' }>;
      expect(tableAfter.rows).toHaveLength(1);
    });

    it('rejects deleting row if row index is out of bounds or attempts to delete header as body row', () => {
      const pos = sampleTableSource.indexOf('Alice');
      const tableCtx = findTableAtPosition(sampleTableSource, pos)!;

      const tx = createTableDeleteRowTransaction(sampleTableSource, tableCtx, 99);
      expect(tx).toBeNull();
    });
  });

  describe('D. Add and Delete Columns', () => {
    it('adds a new column at the end of the table', () => {
      const pos = sampleTableSource.indexOf('Alice');
      const tableCtx = findTableAtPosition(sampleTableSource, pos)!;

      const tx = createTableAddColumnTransaction(sampleTableSource, tableCtx);
      expect(tx).not.toBeNull();
      expect(tx!.userEvent).toBe('table.add-column');

      const next = applyChangesToSource(sampleTableSource, tx!.changes);
      const reparsed = parseMarkdown(next);
      const tableAfter = reparsed.root.children.find((c) => c.type === 'table') as Extract<MarkdownBlockNode, { type: 'table' }>;
      expect(tableAfter.headers).toHaveLength(4);
      expect(tableAfter.rows[0]).toHaveLength(4);
      expect(tableAfter.rows[1]).toHaveLength(4);
    });

    it('rejects add-column candidates that modify a non-target cell', () => {
      const source = '| A | B |\n| --- | --- |\n| one | two |';
      const context = findTableAtPosition(source, source.indexOf('one'))!;
      const ok = verifyCandidateTable('| A | B | C |\n| --- | --- | --- |\n| changed | two |   |', 0, {
        op: 'add-column',
        expectedColCount: 3,
        targetColIndex: 2,
        originalContext: context
      });

      expect(ok).toBe(false);
    });

    it('deletes a column from the table', () => {
      const pos = sampleTableSource.indexOf('Alice');
      const tableCtx = findTableAtPosition(sampleTableSource, pos)!;

      // Delete Age (col 1)
      const tx = createTableDeleteColumnTransaction(sampleTableSource, tableCtx, 1);
      expect(tx).not.toBeNull();
      expect(tx!.userEvent).toBe('table.delete-column');

      const next = applyChangesToSource(sampleTableSource, tx!.changes);
      expect(next).not.toContain('Age');
      expect(next).toContain('Name');
      expect(next).toContain('City');

      const reparsed = parseMarkdown(next);
      const tableAfter = reparsed.root.children.find((c) => c.type === 'table') as Extract<MarkdownBlockNode, { type: 'table' }>;
      expect(tableAfter.headers).toHaveLength(2);
      expect(tableAfter.rows[0]).toHaveLength(2);
    });

    it('rejects deleting column when table only has one column', () => {
      const singleColSource = '| Header |\n| --- |\n| Cell |';
      const parsed = parseMarkdown(singleColSource);
      const tableNode = parsed.root.children.find((c) => c.type === 'table')!;
      const tableCtx = parseTableContext(singleColSource, tableNode as Extract<MarkdownBlockNode, { type: 'table' }>);

      const tx = createTableDeleteColumnTransaction(singleColSource, tableCtx, 0);
      expect(tx).toBeNull();
    });
  });

  describe('E. Column Alignment Modification', () => {
    it('updates column alignment to center', () => {
      const pos = sampleTableSource.indexOf('Alice');
      const tableCtx = findTableAtPosition(sampleTableSource, pos)!;

      // Change Name (col 0) from left to center
      const tx = createTableSetAlignTransaction(sampleTableSource, tableCtx, 0, 'center');
      expect(tx).not.toBeNull();
      expect(tx!.userEvent).toBe('table.set-align');

      const next = applyChangesToSource(sampleTableSource, tx!.changes);
      const reparsed = parseMarkdown(next);
      const tableAfter = reparsed.root.children.find((c) => c.type === 'table') as Extract<MarkdownBlockNode, { type: 'table' }>;
      expect(tableAfter.align[0]).toBe('center');
    });
  });

  describe('F. Precise Local Edits & Byte-for-Byte Format Preservation', () => {
    const formattedTable = [
      '  | Header 1   | Header 2   |',
      '  | :---       | ---:       |',
      '  | Alice \\| A | 100        |',
      '  | Bob        | 200        |',
      ''
    ].join('\n');

    it('add row only inserts target line without modifying existing rows, indentation, or escaped pipes', () => {
      const pos = formattedTable.indexOf('Alice');
      const tableCtx = findTableAtPosition(formattedTable, pos)!;

      const tx = createTableAddRowTransaction(formattedTable, tableCtx);
      expect(tx).not.toBeNull();
      // Should be a single contiguous insertion change
      expect(tx!.changes).toHaveLength(1);
      const change = tx!.changes[0]!;
      expect(change.from).toBe(change.to); // Pure insertion, zero deletions

      const next = applyChangesToSource(formattedTable, tx!.changes);
      // Existing lines must remain byte-for-byte identical
      expect(next).toContain('  | Header 1   | Header 2   |\n');
      expect(next).toContain('  | :---       | ---:       |\n');
      expect(next).toContain('  | Alice \\| A | 100        |\n');
      expect(next).toContain('  | Bob        | 200        |\n');
    });

    it('delete row only deletes target line without modifying other rows or indentation', () => {
      const pos = formattedTable.indexOf('Bob');
      const tableCtx = findTableAtPosition(formattedTable, pos)!;

      // Delete Bob (row 1)
      const tx = createTableDeleteRowTransaction(formattedTable, tableCtx, 1);
      expect(tx).not.toBeNull();
      expect(tx!.changes).toHaveLength(1);
      const change = tx!.changes[0]!;
      expect(change.insert).toBe(''); // Pure deletion

      const next = applyChangesToSource(formattedTable, tx!.changes);
      expect(next).not.toContain('Bob');
      // Alice line and header must remain byte-for-byte identical
      expect(next).toContain('  | Header 1   | Header 2   |\n');
      expect(next).toContain('  | :---       | ---:       |\n');
      expect(next).toContain('  | Alice \\| A | 100        |\n');
    });

    it('set align only modifies delimiter marker without touching other rows or spacing', () => {
      const pos = formattedTable.indexOf('Alice');
      const tableCtx = findTableAtPosition(formattedTable, pos)!;

      // Set align of col 1 to center
      const tx = createTableSetAlignTransaction(formattedTable, tableCtx, 1, 'center');
      expect(tx).not.toBeNull();
      const next = applyChangesToSource(formattedTable, tx!.changes);

      // Header and data rows must remain untouched byte-for-byte
      expect(next).toContain('  | Header 1   | Header 2   |\n');
      expect(next).toContain('  | Alice \\| A | 100        |\n');
      expect(next).toContain('  | Bob        | 200        |\n');
    });

    it('add column modifies each line locally without destroying custom spacing or escaped pipes', () => {
      const pos = formattedTable.indexOf('Alice');
      const tableCtx = findTableAtPosition(formattedTable, pos)!;

      // Add column in middle (colIndex 1)
      const tx = createTableAddColumnTransaction(formattedTable, tableCtx, 1);
      expect(tx).not.toBeNull();
      // Must perform one local change per line (header, delimiter, and 2 data rows = 4 lines)
      expect(tx!.changes.length).toBeGreaterThanOrEqual(4);

      const next = applyChangesToSource(formattedTable, tx!.changes);
      // Original cell spacing and escaped pipes must remain intact
      expect(next).toContain('Alice \\| A');
      expect(next).toContain('100        |');
      expect(next).toContain('Bob        |');
      expect(next).toContain('Header 1   |');

      const reparsed = parseMarkdown(next);
      const tableNode = reparsed.root.children.find((c) => c.type === 'table') as Extract<
        MarkdownBlockNode,
        { type: 'table' }
      >;
      expect(tableNode.headers).toHaveLength(3);
      expect(tableNode.rows[0]).toHaveLength(3);
    });

    it('delete column modifies each line locally without rewriting non-target column spaces or escaped pipes', () => {
      const pos = formattedTable.indexOf('Alice');
      const tableCtx = findTableAtPosition(formattedTable, pos)!;

      // Delete Header 2 (colIndex 1)
      const tx = createTableDeleteColumnTransaction(formattedTable, tableCtx, 1);
      expect(tx).not.toBeNull();
      expect(tx!.changes.length).toBeGreaterThanOrEqual(4);

      const next = applyChangesToSource(formattedTable, tx!.changes);
      expect(next).not.toContain('Header 2');
      expect(next).not.toContain('100');
      expect(next).not.toContain('200');
      // Col 1 must be preserved byte-for-byte with its custom spacing and escaped pipe
      expect(next).toContain('  | Header 1   |');
      expect(next).toContain('  | Alice \\| A |');

      const reparsed = parseMarkdown(next);
      const tableNode = reparsed.root.children.find((c) => c.type === 'table') as Extract<
        MarkdownBlockNode,
        { type: 'table' }
      >;
      expect(tableNode.headers).toHaveLength(1);
    });

    it('preserves multi-layer blockquote prefix (> > ) on each line during column operations', () => {
      const multiBqSource = [
        '> > |   Col 1   |   Col 2   |',
        '> > | :---      | ---:      |',
        '> > | Val 1     | Val 2     |',
        ''
      ].join('\n');

      const pos = multiBqSource.indexOf('Val 1');
      const tableCtx = findTableAtPosition(multiBqSource, pos)!;
      expect(tableCtx).not.toBeNull();

      const tx = createTableAddColumnTransaction(multiBqSource, tableCtx, 2);
      expect(tx).not.toBeNull();

      const next = applyChangesToSource(multiBqSource, tx!.changes);
      const lines = next.split('\n');
      // Every line of the table in multiBqSource must retain '> > '
      expect(lines[0]!.startsWith('> > ')).toBe(true);
      expect(lines[1]!.startsWith('> > ')).toBe(true);
      expect(lines[2]!.startsWith('> > ')).toBe(true);
      expect(next).toContain('Val 1     |');
      expect(next).toContain('Val 2     |');
    });

    it('modifies only target table when document contains multiple identical tables', () => {
      const multiTableDoc = [
        '# First Table',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '# Second Table',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        ''
      ].join('\n');

      // Target the second table
      const secondTablePos = multiTableDoc.lastIndexOf('| A | B |');
      const tableCtx2 = findTableAtPosition(multiTableDoc, secondTablePos)!;
      expect(tableCtx2).not.toBeNull();
      expect(tableCtx2.tableRange.from).toBeGreaterThan(secondTablePos - 5);

      const tx = createTableAddRowTransaction(multiTableDoc, tableCtx2);
      expect(tx).not.toBeNull();

      const next = applyChangesToSource(multiTableDoc, tx!.changes);
      // First table must remain 100% unchanged
      const firstTableText = multiTableDoc.slice(0, multiTableDoc.indexOf('# Second Table'));
      expect(next.startsWith(firstTableText)).toBe(true);

      const reparsed = parseMarkdown(next);
      const tables = reparsed.root.children.filter((c) => c.type === 'table') as Extract<
        MarkdownBlockNode,
        { type: 'table' }
      >[];
      expect(tables).toHaveLength(2);
      expect(tables[0]!.rows).toHaveLength(1);
      expect(tables[1]!.rows).toHaveLength(2);
    });

    it('supports column deletion across all 4 pipe styles (A | B, | A | B, A | B |, | A | B |) for first, middle, and last columns', () => {
      // Style 1: | A | B | C |
      const style1 = [
        '| H1 | H2 | H3 |',
        '| --- | --- | --- |',
        '| D1 | D2 | D3 |'
      ].join('\n');
      const ctx1 = findTableAtPosition(style1, 0)!;

      // Delete middle (col 1)
      const tx1Mid = createTableDeleteColumnTransaction(style1, ctx1, 1);
      expect(tx1Mid).not.toBeNull();
      const res1Mid = applyChangesToSource(style1, tx1Mid!.changes);
      expect(res1Mid).toContain('| H1 | H3 |');

      // Delete first (col 0)
      const tx1First = createTableDeleteColumnTransaction(style1, ctx1, 0);
      expect(tx1First).not.toBeNull();
      const res1First = applyChangesToSource(style1, tx1First!.changes);
      expect(res1First).toContain('| H2 | H3 |');

      // Delete last (col 2)
      const tx1Last = createTableDeleteColumnTransaction(style1, ctx1, 2);
      expect(tx1Last).not.toBeNull();
      const res1Last = applyChangesToSource(style1, tx1Last!.changes);
      expect(res1Last).toContain('| H1 | H2 |');

      // Style 2: | A | B | C (no trailing pipe)
      const style2 = [
        '| H1 | H2 | H3',
        '| --- | --- | ---',
        '| D1 | D2 | D3'
      ].join('\n');
      const ctx2 = findTableAtPosition(style2, 0)!;

      // Delete first
      const tx2First = createTableDeleteColumnTransaction(style2, ctx2, 0);
      expect(tx2First).not.toBeNull();
      const res2First = applyChangesToSource(style2, tx2First!.changes);
      const p2First = parseMarkdown(res2First).root.children[0] as Extract<MarkdownBlockNode, { type: 'table' }>;
      expect(p2First.headers).toHaveLength(2);

      // Delete last
      const tx2Last = createTableDeleteColumnTransaction(style2, ctx2, 2);
      expect(tx2Last).not.toBeNull();
      const res2Last = applyChangesToSource(style2, tx2Last!.changes);
      const p2Last = parseMarkdown(res2Last).root.children[0] as Extract<MarkdownBlockNode, { type: 'table' }>;
      expect(p2Last.headers).toHaveLength(2);

      // Style 3: A | B | C | (no leading pipe)
      const style3 = [
        'H1 | H2 | H3 |',
        '--- | --- | --- |',
        'D1 | D2 | D3 |'
      ].join('\n');
      const ctx3 = findTableAtPosition(style3, 0)!;

      // Delete first
      const tx3First = createTableDeleteColumnTransaction(style3, ctx3, 0);
      expect(tx3First).not.toBeNull();
      const res3First = applyChangesToSource(style3, tx3First!.changes);
      const p3First = parseMarkdown(res3First).root.children[0] as Extract<MarkdownBlockNode, { type: 'table' }>;
      expect(p3First.headers).toHaveLength(2);

      // Delete last
      const tx3Last = createTableDeleteColumnTransaction(style3, ctx3, 2);
      expect(tx3Last).not.toBeNull();
      const res3Last = applyChangesToSource(style3, tx3Last!.changes);
      const p3Last = parseMarkdown(res3Last).root.children[0] as Extract<MarkdownBlockNode, { type: 'table' }>;
      expect(p3Last.headers).toHaveLength(2);

      // Style 4: A | B | C (no leading, no trailing pipe)
      const style4 = [
        'H1 | H2 | H3',
        '--- | --- | ---',
        'D1 | D2 | D3'
      ].join('\n');
      const ctx4 = findTableAtPosition(style4, 0)!;

      // Delete middle
      const tx4Mid = createTableDeleteColumnTransaction(style4, ctx4, 1);
      expect(tx4Mid).not.toBeNull();
      const res4Mid = applyChangesToSource(style4, tx4Mid!.changes);
      const p4Mid = parseMarkdown(res4Mid).root.children[0] as Extract<MarkdownBlockNode, { type: 'table' }>;
      expect(p4Mid.headers).toHaveLength(2);

      // Delete first
      const tx4First = createTableDeleteColumnTransaction(style4, ctx4, 0);
      expect(tx4First).not.toBeNull();
      const res4First = applyChangesToSource(style4, tx4First!.changes);
      const p4First = parseMarkdown(res4First).root.children[0] as Extract<MarkdownBlockNode, { type: 'table' }>;
      expect(p4First.headers).toHaveLength(2);

      // Delete last
      const tx4Last = createTableDeleteColumnTransaction(style4, ctx4, 2);
      expect(tx4Last).not.toBeNull();
      const res4Last = applyChangesToSource(style4, tx4Last!.changes);
      const p4Last = parseMarkdown(res4Last).root.children[0] as Extract<MarkdownBlockNode, { type: 'table' }>;
      expect(p4Last.headers).toHaveLength(2);
    });

    it('supports deleting column on single-internal-pipe table (A | B) preserving valid 1-column table', () => {
      const singlePipeSource = [
        'Left | Right',
        '--- | ---',
        'L1 | R1'
      ].join('\n');
      const ctx = findTableAtPosition(singlePipeSource, 0)!;
      expect(ctx.headers).toHaveLength(2);

      // Delete col 0 (Left)
      const txDel0 = createTableDeleteColumnTransaction(singlePipeSource, ctx, 0);
      expect(txDel0).not.toBeNull();
      const res0 = applyChangesToSource(singlePipeSource, txDel0!.changes);
      const p0 = parseMarkdown(res0).root.children[0] as Extract<MarkdownBlockNode, { type: 'table' }>;
      expect(p0.type).toBe('table');
      expect(p0.headers).toHaveLength(1);
      expect(res0).not.toContain('Left');
      expect(res0).toContain('Right');

      // Delete col 1 (Right)
      const txDel1 = createTableDeleteColumnTransaction(singlePipeSource, ctx, 1);
      expect(txDel1).not.toBeNull();
      const res1 = applyChangesToSource(singlePipeSource, txDel1!.changes);
      const p1 = parseMarkdown(res1).root.children[0] as Extract<MarkdownBlockNode, { type: 'table' }>;
      expect(p1.type).toBe('table');
      expect(p1.headers).toHaveLength(1);
      expect(res1).toContain('Left');
      expect(res1).not.toContain('Right');
    });

    it('rejects createTableCellEditTransaction when newValue contains raw newline characters (\\r or \\n)', () => {
      const pos = sampleTableSource.indexOf('Alice');
      const tableCtx = findTableAtPosition(sampleTableSource, pos)!;
      const cellCtx = findTableCellAtPosition(tableCtx, pos)!;

      // Newline \n
      const txNl = createTableCellEditTransaction(sampleTableSource, cellCtx, 'Alice\nNextLine');
      expect(txNl).toBeNull();

      // Carriage return \r\n
      const txCrlf = createTableCellEditTransaction(sampleTableSource, cellCtx, 'Alice\r\nNextLine');
      expect(txCrlf).toBeNull();
    });

    it('handles ragged tables with short rows when deleting columns without destroying row closing pipes', () => {
      // Table with 2 columns, but row 1 is ragged (short: only 1 cell)
      const raggedSource = [
        '| Col 1 | Col 2 |',
        '| --- | --- |',
        '| Cell 1 |'
      ].join('\n');

      const ctx = findTableAtPosition(raggedSource, 0)!;
      expect(ctx).not.toBeNull();
      expect(ctx.headers).toHaveLength(2);

      // Deleting column 1 (Col 2), which row 1 does not have
      const tx = createTableDeleteColumnTransaction(raggedSource, ctx, 1);
      expect(tx).not.toBeNull();

      const next = applyChangesToSource(raggedSource, tx!.changes);
      expect(next).toContain('| Col 1 |');
      // Non-target cell Cell 1 in ragged row must retain its closing pipe and byte content
      expect(next).toContain('| Cell 1 |');

      const reparsed = parseMarkdown(next).root.children[0] as Extract<MarkdownBlockNode, { type: 'table' }>;
      expect(reparsed.type).toBe('table');
      expect(reparsed.headers).toHaveLength(1);

      // Assert row actual cell count using getRowCellRanges
      const rowLines = next.split('\n').slice(2);
      const row0Ranges = getRowCellRanges(rowLines[0]!, 0);
      expect(row0Ranges).toHaveLength(1);
    });

    it('handles ragged tables with extra-long rows and preserves non-target cell bytes exactly', () => {
      // Table with 2 columns, but row 1 has 3 cells
      const extraLongSource = [
        '| H1 | H2 |',
        '| --- | --- |',
        '| R1C1 | R1C2 | Extra |'
      ].join('\n');

      const ctx = findTableAtPosition(extraLongSource, 0)!;
      expect(ctx).not.toBeNull();

      // Deleting column 1 (H2)
      const tx = createTableDeleteColumnTransaction(extraLongSource, ctx, 1);
      expect(tx).not.toBeNull();

      const next = applyChangesToSource(extraLongSource, tx!.changes);
      expect(next).toContain('| H1 |');
      // R1C2 removed, R1C1 and Extra preserved
      expect(next).toContain('| R1C1 | Extra |');
      expect(next).not.toContain('R1C2');

      const reparsed = parseMarkdown(next).root.children[0] as Extract<MarkdownBlockNode, { type: 'table' }>;
      expect(reparsed.type).toBe('table');
      expect(reparsed.headers).toHaveLength(1);

      // Extra-long row has 2 cells left (| R1C1 | Extra |)
      const rowLines = next.split('\n').slice(2);
      const row0Ranges = getRowCellRanges(rowLines[0]!, 0);
      expect(row0Ranges).toHaveLength(2);
    });

    it('handles ragged tables with no outer pipes, escaped \\|, CRLF, and multi-layer blockquotes', () => {
      const complexRagged = [
        '> > Left | Right \\| Escaped',
        '> > --- | ---',
        '> > R1Val |',
        '> > R2Col1 | R2Col2 | ExtraCell'
      ].join('\r\n');

      const pos = complexRagged.indexOf('Left');
      const ctx = findTableAtPosition(complexRagged, pos)!;
      expect(ctx).not.toBeNull();

      const tx = createTableDeleteColumnTransaction(complexRagged, ctx, 0);
      expect(tx).not.toBeNull();

      const next = applyChangesToSource(complexRagged, tx!.changes);
      expect(next).toContain('> > | Right \\| Escaped');
      expect(next).not.toContain('Left');
      expect(next).toContain('> > |');
      expect(next).toContain('\r\n');

      const parsed = parseMarkdown(next);
      const bq = parsed.root.children[0] as Extract<MarkdownBlockNode, { type: 'blockquote' }>;
      const bqInner = bq.children[0] as Extract<MarkdownBlockNode, { type: 'blockquote' }>;
      const reparsed = bqInner.children[0] as Extract<MarkdownBlockNode, { type: 'table' }>;
      expect(reparsed.type).toBe('table');
      expect(reparsed.headers).toHaveLength(1);

      // Check actual columns in each row
      const rowLines = next.split('\r\n').slice(2);
      const row0Clean = rowLines[0]!.replace(/^[ \t]*(?:>[ \t]*)* /, '');
      const row0Ranges = getRowCellRanges(row0Clean, 0);
      expect(row0Ranges).toHaveLength(1);
      const row1Clean = rowLines[1]!.replace(/^[ \t]*(?:>[ \t]*)* /, '');
      const row1Ranges = getRowCellRanges(row1Clean, 0);
      expect(row1Ranges).toHaveLength(2);
    });

    it('rejects candidate table when delimiter row is damaged or missing', () => {
      const source = '| A | B |\n| --- | --- |\n| 1 | 2 |';
      const ctx = findTableAtPosition(source, 0)!;

      // Corrupted candidate with damaged delimiter row (missing delimiter cell: | --- |)
      const corruptedDelimiter = '| A | B |\n| --- |\n| 1 | 2 |';
      const ok = verifyCandidateTable(corruptedDelimiter, 0, {
        op: 'cell-edit',
        rowIndex: 0,
        colIndex: 0,
        expectedValue: '1',
        originalContext: ctx
      });
      expect(ok).toBe(false);
    });

    it('rejects candidate when non-target cell in ragged table is modified or short row is damaged', () => {
      const raggedSource = '| Col 1 | Col 2 |\n| --- | --- |\n| Cell 1 |';
      const ctx = findTableAtPosition(raggedSource, 0)!;

      // Candidate that accidentally modified non-target cell "Cell 1" to "Corrupted"
      const corruptedCandidate = '| Col 1 |\n| --- |\n| Corrupted |';
      const ok = verifyCandidateTable(corruptedCandidate, 0, {
        op: 'delete-column',
        expectedColCount: 1,
        targetColIndex: 1,
        originalContext: ctx
      });
      expect(ok).toBe(false);
    });

    it('rejects candidate when extra cell in extra-long row is dropped', () => {
      const extraLongSource = '| H1 | H2 |\n| --- | --- |\n| R1C1 | R1C2 | Extra |';
      const ctx = findTableAtPosition(extraLongSource, 0)!;

      // Candidate deleted H2 and R1C2, but ALSO dropped "Extra" cell
      const droppedExtraCandidate = '| H1 |\n| --- |\n| R1C1 |';
      const ok = verifyCandidateTable(droppedExtraCandidate, 0, {
        op: 'delete-column',
        expectedColCount: 1,
        targetColIndex: 1,
        originalContext: ctx
      });
      expect(ok).toBe(false);
    });
  });
});
