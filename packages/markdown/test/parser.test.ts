import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/parser.js';

describe('Markdown Parser & Render Model', () => {
  describe('Empty and Whitespace Inputs', () => {
    it('returns an empty root for empty string', () => {
      const result = parseMarkdown('');
      expect(result.source).toBe('');
      expect(result.root.children).toEqual([]);
      expect(result.diagnostics).toEqual([]);
    });

    it('returns an empty root for whitespace only string', () => {
      const result = parseMarkdown('   \n\t  \n  ');
      expect(result.source).toBe('   \n\t  \n  ');
      expect(result.root.children).toEqual([]);
      expect(result.diagnostics).toEqual([]);
    });

    it('always preserves canonical raw source', () => {
      const src = '# Hello\n\nPreserve *everything*.';
      const result = parseMarkdown(src);
      expect(result.source).toBe(src);
    });
  });

  describe('Headings, Paragraphs, Bold, and Italic', () => {
    it('parses headings with depths 1 through 6', () => {
      const src = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6';
      const result = parseMarkdown(src);
      expect(result.root.children).toHaveLength(6);
      for (let i = 0; i < 6; i++) {
        const node = result.root.children[i];
        expect(node?.type).toBe('heading');
        if (node?.type === 'heading') {
          expect(node.depth).toBe(i + 1);
        }
      }
    });

    it('parses paragraph with bold and italic inline styles', () => {
      const src = 'Normal **bold** and *italic* and ***both*** text.';
      const result = parseMarkdown(src);
      expect(result.root.children).toHaveLength(1);

      const p = result.root.children[0];
      expect(p?.type).toBe('paragraph');
      if (p?.type === 'paragraph') {
        const types = p.children.map((c) => c.type);
        expect(types).toContain('bold');
        expect(types).toContain('italic');
      }
    });
  });

  describe('Links and Images with Security Boundaries', () => {
    it('parses valid HTTPS and mailto links', () => {
      const src = '[Nexus](https://example.com) and [Email](mailto:user@example.com)';
      const result = parseMarkdown(src);
      const p = result.root.children[0];
      expect(p?.type).toBe('paragraph');
      if (p?.type === 'paragraph') {
        const link = p.children.find((c) => c.type === 'link');
        expect(link).toBeDefined();
        if (link && link.type === 'link') {
          expect(link.safeHref).toBe('https://example.com');
          expect(link.isBlocked).toBe(false);
        }
      }
    });

    it('blocks dangerous javascript: links and records a warning diagnostic', () => {
      const src = '[Attack](javascript:alert(1))';
      const result = parseMarkdown(src);
      const p = result.root.children[0];
      expect(p?.type).toBe('paragraph');
      if (p?.type === 'paragraph') {
        const link = p.children[0];
        expect(link?.type).toBe('link');
        if (link?.type === 'link') {
          expect(link.isBlocked).toBe(true);
          expect(link.safeHref).toBeNull();
        }
      }
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.diagnostics[0]?.severity).toBe('warning');
    });

    it('blocks data: protocol on images and provides safe fallback', () => {
      const src = '![Dangerous](data:image/svg+xml,<script>alert(1)</script>)';
      const result = parseMarkdown(src);
      const p = result.root.children[0];
      expect(p?.type).toBe('paragraph');
      if (p?.type === 'paragraph') {
        const img = p.children[0];
        expect(img?.type).toBe('image');
        if (img?.type === 'image') {
          expect(img.isBlocked).toBe(true);
          expect(img.safeSrc).toBeNull();
          expect(img.alt).toBe('Dangerous');
        }
      }
    });

    it('allows relative image paths', () => {
      const src = '![Local Image](./assets/diagram.png "Diagram")';
      const result = parseMarkdown(src);
      const p = result.root.children[0];
      if (p?.type === 'paragraph') {
        const img = p.children[0];
        expect(img?.type).toBe('image');
        if (img?.type === 'image') {
          expect(img.safeSrc).toBe('./assets/diagram.png');
          expect(img.title).toBe('Diagram');
          expect(img.isBlocked).toBe(false);
        }
      }
    });
  });

  describe('Lists: Ordered, Unordered, and Nested', () => {
    it('parses unordered lists', () => {
      const src = '- Item 1\n- Item 2\n- Item 3';
      const result = parseMarkdown(src);
      expect(result.root.children).toHaveLength(1);
      const list = result.root.children[0];
      expect(list?.type).toBe('list');
      if (list?.type === 'list') {
        expect(list.ordered).toBe(false);
        expect(list.items).toHaveLength(3);
      }
    });

    it('parses ordered lists with start numbers', () => {
      const src = '1. First\n2. Second\n3. Third';
      const result = parseMarkdown(src);
      const list = result.root.children[0];
      expect(list?.type).toBe('list');
      if (list?.type === 'list') {
        expect(list.ordered).toBe(true);
        expect(list.items).toHaveLength(3);
      }
    });

    it('parses task list checkboxes', () => {
      const src = '- [ ] Incomplete\n- [x] Completed';
      const result = parseMarkdown(src);
      const list = result.root.children[0];
      if (list?.type === 'list') {
        expect(list.items[0]?.task).toBe(true);
        expect(list.items[0]?.checked).toBe(false);
        expect(list.items[1]?.task).toBe(true);
        expect(list.items[1]?.checked).toBe(true);
      }
    });

    it('parses nested lists', () => {
      const src = `- Parent 1
  - Child 1.1
  - Child 1.2
- Parent 2`;
      const result = parseMarkdown(src);
      const list = result.root.children[0];
      expect(list?.type).toBe('list');
      if (list?.type === 'list') {
        expect(list.items).toHaveLength(2);
      }
    });
  });

  describe('Blockquotes', () => {
    it('parses single and multi-line blockquotes', () => {
      const src = '> Line 1\n> Line 2';
      const result = parseMarkdown(src);
      expect(result.root.children).toHaveLength(1);
      const bq = result.root.children[0];
      expect(bq?.type).toBe('blockquote');
      if (bq?.type === 'blockquote') {
        expect(bq.children.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Fenced Code Blocks and Invariance', () => {
    it('parses fenced code blocks with language tag', () => {
      const code = 'const msg = "hello";\nconsole.log(msg);';
      const src = `\`\`\`typescript\n${code}\n\`\`\``;
      const result = parseMarkdown(src);

      expect(result.root.children).toHaveLength(1);
      const cb = result.root.children[0];
      expect(cb?.type).toBe('code-block');
      if (cb?.type === 'code-block') {
        expect(cb.language).toBe('typescript');
        expect(cb.value.trim()).toBe(code);
      }
    });

    it('does NOT parse markdown or math or wikilinks inside code blocks', () => {
      const codeInside = '# Not a heading\n**not bold**\n$x = 1$\n[[NotALink]]';
      const src = `\`\`\`text\n${codeInside}\n\`\`\``;
      const result = parseMarkdown(src);

      const cb = result.root.children[0];
      expect(cb?.type).toBe('code-block');
      if (cb?.type === 'code-block') {
        expect(cb.value.trim()).toBe(codeInside);
      }
    });

    it('does NOT parse math or wikilinks inside inline codespan', () => {
      const src = 'Use `$x$` and `[[Page]]` in code.';
      const result = parseMarkdown(src);
      const p = result.root.children[0];
      if (p?.type === 'paragraph') {
        const codes = p.children.filter((c) => c.type === 'inline-code');
        expect(codes).toHaveLength(2);
        expect(codes[0]?.value).toBe('$x$');
        expect(codes[1]?.value).toBe('[[Page]]');
      }
    });
  });

  describe('Special Syntax Preservation: Math and Wikilinks', () => {
    it('preserves inline math $x$ in regular text', () => {
      const src = 'The formula is $a^2 + b^2 = c^2$ in Euclidean space.';
      const result = parseMarkdown(src);
      const p = result.root.children[0];
      if (p?.type === 'paragraph') {
        const math = p.children.find((c) => c.type === 'inline-math');
        expect(math).toBeDefined();
        if (math && math.type === 'inline-math') {
          expect(math.formula).toBe('a^2 + b^2 = c^2');
          expect(math.raw).toBe('$a^2 + b^2 = c^2$');
        }
      }
    });

    it('preserves block math $$...$$', () => {
      const src = '$$\n\\int_0^1 f(x) dx\n$$';
      const result = parseMarkdown(src);
      expect(result.root.children).toHaveLength(1);
      const bm = result.root.children[0];
      expect(bm?.type).toBe('block-math');
      if (bm?.type === 'block-math') {
        expect(bm.formula).toBe('\\int_0^1 f(x) dx');
        expect(bm.raw).toBe('$$\n\\int_0^1 f(x) dx\n$$');
      }
    });

    it('preserves wikilinks [[Page]] and [[Page|Alias]]', () => {
      const src = 'Refer to [[Project Roadmap]] and [[Architecture|Arch Doc]].';
      const result = parseMarkdown(src);
      const p = result.root.children[0];
      if (p?.type === 'paragraph') {
        const wikilinks = p.children.filter((c) => c.type === 'wikilink');
        expect(wikilinks).toHaveLength(2);
        if (wikilinks[0] && wikilinks[0].type === 'wikilink') {
          expect(wikilinks[0].target).toBe('Project Roadmap');
          expect(wikilinks[0].alias).toBeUndefined();
        }
        if (wikilinks[1] && wikilinks[1].type === 'wikilink') {
          expect(wikilinks[1].target).toBe('Architecture');
          expect(wikilinks[1].alias).toBe('Arch Doc');
        }
      }
    });
  });

  describe('Tables', () => {
    it('parses tables with headers, rows, and alignments', () => {
      const src = `| Left | Center | Right |
| :--- | :---: | ---: |
| A1   | B1     | C1    |
| A2   | B2     | C2    |`;

      const result = parseMarkdown(src);
      expect(result.root.children).toHaveLength(1);
      const table = result.root.children[0];
      expect(table?.type).toBe('table');
      if (table?.type === 'table') {
        expect(table.headers).toHaveLength(3);
        expect(table.rows).toHaveLength(2);
        expect(table.align).toEqual(['left', 'center', 'right']);
      }
    });
  });

  describe('Robustness and Malformed Markdown', () => {
    it('handles unclosed brackets and malformed syntax without throwing', () => {
      const malformed = [
        '# Unclosed heading',
        '**unclosed bold',
        '*unclosed italic',
        '[unclosed link](',
        '![unclosed img](',
        '```unclosed fence',
        '| malformed | table\n| ---',
        '$$\nunclosed block math',
        '[[unclosed wikilink'
      ].join('\n\n');

      expect(() => {
        const result = parseMarkdown(malformed);
        expect(result.source).toBe(malformed);
        expect(result.root.children.length).toBeGreaterThan(0);
      }).not.toThrow();
    });
  });

  describe('SourceRange, Raw Preservation, and AST Invariants', () => {
    it('satisfies root range and raw invariant', () => {
      const src = '# Hello\n\nContent paragraph.';
      const res = parseMarkdown(src);
      expect(res.root.range).toEqual({ from: 0, to: src.length });
      expect(res.root.raw).toBe(src);
    });

    it('heading range ends at line break and does NOT swallow trailing blank lines', () => {
      const src = '# Title\n\nNext paragraph';
      const res = parseMarkdown(src);
      const heading = res.root.children[0];
      const p = res.root.children[1];

      expect(heading?.type).toBe('heading');
      expect(p?.type).toBe('paragraph');
      if (heading && p) {
        expect(heading.range).toEqual({ from: 0, to: 8 }); // '# Title\n'
        expect(heading.raw).toBe('# Title\n');
        expect(p.range.from).toBe(9); // starts after the second '\n'
        expect(heading.range.to).toBeLessThanOrEqual(p.range.from);
      }
    });

    it('heading range works under CRLF and does not swallow trailing CRLF blank line', () => {
      const src = '# Title\r\n\r\nNext paragraph';
      const res = parseMarkdown(src);
      const heading = res.root.children[0];
      const p = res.root.children[1];

      expect(heading?.type).toBe('heading');
      expect(p?.type).toBe('paragraph');
      if (heading && p) {
        expect(heading.range).toEqual({ from: 0, to: 9 }); // '# Title\r\n'
        expect(heading.raw).toBe('# Title\r\n');
        expect(p.range.from).toBe(11);
        expect(heading.range.to).toBeLessThanOrEqual(p.range.from);
      }
    });

    it('fenced code block covers opening fence through closing fence', () => {
      const src = '```typescript\nconst x = 1;\n```\n\nNext';
      const res = parseMarkdown(src);
      const cb = res.root.children[0];
      expect(cb?.type).toBe('code-block');
      if (cb) {
        expect(cb.range.from).toBe(0);
        expect(cb.range.to).toBe(30);
        expect(cb.raw).toBe('```typescript\nconst x = 1;\n```');
        expect(src.slice(cb.range.from, cb.range.to)).toBe(cb.raw);
      }
    });

    it('list and list-item ranges contain all markers, content, and sublists', () => {
      const src = '- Item 1\n  - Sub 1.1\n- Item 2\n';
      const res = parseMarkdown(src);
      const list = res.root.children[0];
      expect(list?.type).toBe('list');
      if (list && list.type === 'list') {
        expect(list.range.from).toBe(0);
        expect(list.items).toHaveLength(2);

        const item0 = list.items[0];
        const item1 = list.items[1];
        if (item0 && item1) {
          expect(item0.range.from).toBe(0);
          expect(item0.raw).toBe(src.slice(item0.range.from, item0.range.to));
          expect(item1.range.from).toBe(item0.range.to);
          expect(item1.raw).toBe(src.slice(item1.range.from, item1.range.to));
          expect(list.range.to).toBe(item1.range.to);
        }
      }
    });

    it('table range covers from start of header through end of last row', () => {
      const src = '| A | B |\n|---|---|\n| 1 | 2 |\n\nAfter table';
      const res = parseMarkdown(src);
      const tbl = res.root.children[0];
      expect(tbl?.type).toBe('table');
      if (tbl) {
        expect(tbl.range.from).toBe(0);
        expect(tbl.raw).toBe('| A | B |\n|---|---|\n| 1 | 2 |\n');
        expect(src.slice(tbl.range.from, tbl.range.to)).toBe(tbl.raw);
      }
    });

    it('inlines include delimiter characters and parents strictly encapsulate children', () => {
      const src = 'Sentence with **bold text** and *italic text* and [Link](https://nexus.dev).';
      const res = parseMarkdown(src);
      const p = res.root.children[0];
      expect(p?.type).toBe('paragraph');
      if (p && p.type === 'paragraph') {
        const bold = p.children.find((c) => c.type === 'bold');
        expect(bold).toBeDefined();
        if (bold && bold.type === 'bold') {
          expect(bold.raw).toBe('**bold text**');
          expect(src.slice(bold.range.from, bold.range.to)).toBe('**bold text**');
          // Child text inside bold
          const childText = bold.children[0];
          expect(childText?.raw).toBe('bold text');
          expect(bold.range.from).toBeLessThanOrEqual(childText!.range.from);
          expect(childText!.range.to).toBeLessThanOrEqual(bold.range.to);
        }

        const link = p.children.find((c) => c.type === 'link');
        expect(link).toBeDefined();
        if (link && link.type === 'link') {
          expect(link.raw).toBe('[Link](https://nexus.dev)');
          const linkChild = link.children[0];
          expect(linkChild?.raw).toBe('Link');
          expect(link.range.from).toBeLessThanOrEqual(linkChild!.range.from);
          expect(linkChild!.range.to).toBeLessThanOrEqual(link.range.to);
        }
      }
    });

    it('marks raw HTML and unknown constructs as opaque: true', () => {
      const src = '<div class="banner">Important</div>\n\nSome text with <span>inline</span>.\n\n---\n';
      const res = parseMarkdown(src);

      const htmlBlock = res.root.children[0];
      expect(htmlBlock?.type).toBe('raw');
      expect(htmlBlock?.opaque).toBe(true);

      const hrBlock = res.root.children[2];
      expect(hrBlock?.type).toBe('horizontal-rule');
      expect(hrBlock?.opaque).not.toBe(true);

      const p = res.root.children[1];
      if (p && p.type === 'paragraph') {
        const htmlInline = p.children.find((c) => c.type === 'raw');
        expect(htmlInline).toBeDefined();
        expect(htmlInline?.opaque).toBe(true);
      }
    });

    it('strictly satisfies all 4 core invariants on complex document', () => {
      const src = [
        '# Main Heading',
        '',
        'Paragraph with **bold**, *italic*, `code`, and $x=1$ and [[Target|Alias]].',
        '',
        '```python',
        'def hello():',
        '    print("world")',
        '```',
        '',
        '- Item A',
        '  - Sub A.1',
        '- Item B',
        '',
        '| H1 | H2 |',
        '| --- | --- |',
        '| C1 | C2 |',
        '',
        '> Blockquote line 1',
        '> Blockquote line 2',
        '',
        '<script>safe()</script>',
        ''
      ].join('\n');

      const res = parseMarkdown(src);
      assertRecursiveInvariants(res.root, src);
    });

    it('validates exact nested list parent-child containment', () => {
      const src = '- parent\n  - child\n';
      const res = parseMarkdown(src);
      assertRecursiveInvariants(res.root, src);

      const parentList = res.root.children[0];
      expect(parentList?.type).toBe('list');
      if (parentList && parentList.type === 'list') {
        const parentItem = parentList.items[0];
        expect(parentItem).toBeDefined();
        expect(parentItem?.raw).toBe('- parent\n  - child\n');
        expect(parentItem?.range).toEqual({ from: 0, to: 19 });

        const nestedList = parentItem?.children.find((c) => c.type === 'list');
        expect(nestedList).toBeDefined();
        if (nestedList && nestedList.type === 'list') {
          const nestedItem = nestedList.items[0];
          expect(nestedItem).toBeDefined();
          expect(nestedItem?.raw).toBe('  - child\n');
          expect(nestedItem?.range).toEqual({ from: 9, to: 19 });

          const childText = nestedItem?.children[0];
          expect(childText).toBeDefined();
          expect(childText?.raw).toBe('child');
          expect(childText?.range).toEqual({ from: 13, to: 18 });

          // Parent-child containment assertions
          expect(nestedItem!.range.from).toBeLessThanOrEqual(childText!.range.from);
          expect(childText!.range.to).toBeLessThanOrEqual(nestedItem!.range.to);
          expect(parentItem!.range.from).toBeLessThanOrEqual(nestedItem!.range.from);
          expect(nestedItem!.range.to).toBeLessThanOrEqual(parentItem!.range.to);
        }
      }
    });

    it('validates 3-level deep nested list invariants', () => {
      const src = '- outer\n  - middle\n    - inner\n';
      const res = parseMarkdown(src);
      assertRecursiveInvariants(res.root, src);
    });

    it('validates blockquote containing nested list invariants', () => {
      const src = '> quote\n> - nested list\n>   - nested item\n';
      const res = parseMarkdown(src);
      assertRecursiveInvariants(res.root, src);
    });

    it('validates table cell recursive invariants', () => {
      const src = '| A | B |\n|---|---|\n| x | y |\n';
      const res = parseMarkdown(src);
      assertRecursiveInvariants(res.root, src);
    });

    it('validates table without outer pipes recursive invariants', () => {
      const src = 'A | B\n---|---\nx | y\n';
      const res = parseMarkdown(src);
      assertRecursiveInvariants(res.root, src);
    });

    it('validates table with escaped pipes recursive invariants', () => {
      const src = '| A \\| 1 | B |\n|---|---|\n| x | y |\n';
      const res = parseMarkdown(src);
      assertRecursiveInvariants(res.root, src);
    });

    it('validates CJK, emoji, and CRLF nested structures', () => {
      const src = '# 🚀 标题\r\n\r\n- 一级项目\r\n  - 二级项目 **粗体** ✨\r\n    - 三级项目 $E=mc^2$\r\n\r\n> 引用块\r\n> - 嵌套列表\r\n';
      const res = parseMarkdown(src);
      assertRecursiveInvariants(res.root, src);
    });

    describe('P1-04A Parser High-Fidelity Regressions', () => {
      it('accurately maps blockquote child SourceRange and raw without stripping drift', () => {
        const src = '> first\n> **new**\n';
        const res = parseMarkdown(src);
        assertRecursiveInvariants(res.root, src);

        expect(res.root.children).toHaveLength(1);
        const bq = res.root.children[0]!;
        expect(bq.type).toBe('blockquote');
        expect(bq.range).toEqual({ from: 0, to: 18 });
        expect(bq.raw).toBe('> first\n> **new**\n');

        if (bq.type === 'blockquote') {
          expect(bq.children).toHaveLength(1);
          const p = bq.children[0]!;
          expect(p.type).toBe('paragraph');
          expect(p.range).toEqual({ from: 2, to: 17 });
          expect(p.raw).toBe('first\n> **new**');

          if (p.type === 'paragraph') {
            expect(p.children.length).toBeGreaterThanOrEqual(2);
            const first = p.children[0]!;
            const bold = p.children[p.children.length - 1]!;

            expect(first.type).toBe('text');
            expect(first.range).toEqual({ from: 2, to: 8 });
            expect(first.raw).toBe('first\n');

            expect(bold.type).toBe('bold');
            expect(bold.range).toEqual({ from: 10, to: 17 });
            expect(bold.raw).toBe('**new**');
          }
        }
      });

      it('accurately maps blockquote child SourceRange, raw and value under CRLF', () => {
        const src = '> first\r\n> **new**\r\n';
        const res = parseMarkdown(src);
        assertRecursiveInvariants(res.root, src);

        expect(res.root.children).toHaveLength(1);
        const bq = res.root.children[0]!;
        expect(bq.type).toBe('blockquote');
        expect(bq.range).toEqual({ from: 0, to: 20 });
        expect(bq.raw).toBe('> first\r\n> **new**\r\n');

        if (bq.type === 'blockquote') {
          expect(bq.children).toHaveLength(1);
          const p = bq.children[0]!;
          expect(p.type).toBe('paragraph');
          expect(p.range).toEqual({ from: 2, to: 18 });
          expect(p.raw).toBe('first\r\n> **new**');

          if (p.type === 'paragraph') {
            expect(p.children.length).toBeGreaterThanOrEqual(2);
            const first = p.children[0]!;
            const bold = p.children[p.children.length - 1]!;

            expect(first.type).toBe('text');
            expect(first.range).toEqual({ from: 2, to: 9 });
            expect(first.raw).toBe('first\r\n');
            if (first.type === 'text') {
              expect(first.value).toBe('first\r\n');
            }

            expect(bold.type).toBe('bold');
            expect(bold.range).toEqual({ from: 11, to: 18 });
            expect(bold.raw).toBe('**new**');
          }
        }
      });

      it('accurately maps multi-paragraph and nested blockquotes', () => {
        const src = '> line 1\n>\n> line 2\n';
        const res = parseMarkdown(src);
        assertRecursiveInvariants(res.root, src);

        const bq = res.root.children[0]!;
        expect(bq.type).toBe('blockquote');
        if (bq.type === 'blockquote') {
          expect(bq.children).toHaveLength(2);
          const p1 = bq.children[0]!;
          const p2 = bq.children[1]!;
          expect(p1.raw).toBe('line 1');
          expect(p2.raw).toBe('line 2');
        }
      });

      it('prevents offset drift for inline math and wikilinks across CRLF newlines', () => {
        const src = 'line 1\r\nline 2 $x$\r\nline 3 [[Page]]\r\n';
        const res = parseMarkdown(src);
        assertRecursiveInvariants(res.root, src);

        const p = res.root.children[0]!;
        expect(p.type).toBe('paragraph');
        if (p.type === 'paragraph') {
          const mathNode = p.children.find((c) => c.type === 'inline-math');
          expect(mathNode).toBeDefined();
          expect(mathNode?.type).toBe('inline-math');
          if (mathNode && mathNode.type === 'inline-math') {
            expect(mathNode.formula).toBe('x');
            expect(mathNode.raw).toBe('$x$');
            expect(mathNode.range).toEqual({ from: 15, to: 18 });
            expect(src.slice(mathNode.range.from, mathNode.range.to)).toBe('$x$');
          }

          const wikiNode = p.children.find((c) => c.type === 'wikilink');
          expect(wikiNode).toBeDefined();
          expect(wikiNode?.type).toBe('wikilink');
          if (wikiNode && wikiNode.type === 'wikilink') {
            expect(wikiNode.target).toBe('Page');
            expect(wikiNode.raw).toBe('[[Page]]');
            expect(wikiNode.range).toEqual({ from: 27, to: 35 });
            expect(src.slice(wikiNode.range.from, wikiNode.range.to)).toBe('[[Page]]');
          }
        }
      });

      it('preserves escaped pipe in table cell inline tokens without truncation', () => {
        const src = '| A \\| 1 | B |\n|---|---|\n| x | y |\n';
        const res = parseMarkdown(src);
        assertRecursiveInvariants(res.root, src);

        const tbl = res.root.children[0]!;
        expect(tbl.type).toBe('table');
        if (tbl.type === 'table') {
          const cell0 = tbl.headers[0]!;
          expect(cell0).toHaveLength(1);
          const textToken = cell0[0]!;
          expect(textToken.type).toBe('text');
          expect(textToken.raw).toBe('A \\| 1');
          expect(textToken.range).toEqual({ from: 2, to: 8 });
          expect(src.slice(textToken.range.from, textToken.range.to)).toBe('A \\| 1');
        }
      });
    });

    describe('escape tokens and nested structure invariants', () => {
      it('parses escape tokens as text nodes with unescaped value and escaped flag', () => {
        const src = '\\*literal\\* and \\_literal\\_ and \\# literal and \\`raw\\`';
        const res = parseMarkdown(src);
        assertRecursiveInvariants(res.root, src);

        const p = res.root.children[0]!;
        expect(p.type).toBe('paragraph');
        if (p.type === 'paragraph') {
          const esc0 = p.children[0]!;
          expect(esc0.type).toBe('text');
          if (esc0.type === 'text') {
            expect(esc0.value).toBe('*');
            expect(esc0.raw).toBe('\\*');
            expect(esc0.escaped).toBe(true);
            expect(esc0.opaque).toBeUndefined();
          }
        }
      });

      it('validates invariants for list with nested blockquote', () => {
        const src = '- first\n  > quoted\n  > next\n- second\n';
        const res = parseMarkdown(src);
        assertRecursiveInvariants(res.root, src);
      });

      it('validates invariants for blockquote with nested list and blockquote', () => {
        const src = '> - first\n>   > quoted\n>   > next\n> - second\n';
        const res = parseMarkdown(src);
        assertRecursiveInvariants(res.root, src);
      });
    });

    describe('list item block-level tokens and raw ranges', () => {
      it('parses block-level html inside list item as raw block with exact range and opaque flag', () => {
        const src = '- item\n  <div>html</div>\n';
        const res = parseMarkdown(src);
        assertRecursiveInvariants(res.root, src);

        const list = res.root.children[0];
        expect(list?.type).toBe('list');
        if (list?.type === 'list') {
          const item = list.items[0]!;
          expect(item.children).toHaveLength(2);

          const textNode = item.children[0]!;
          expect(textNode.type).toBe('text');
          expect(textNode.range).toEqual({ from: 2, to: 6 });
          expect(textNode.raw).toBe('item');

          const rawBlock = item.children[1]!;
          expect(rawBlock.type).toBe('raw');
          if (rawBlock.type === 'raw') {
            expect(rawBlock.opaque).toBe(true);
            expect(rawBlock.range).toEqual({ from: 7, to: 25 });
            expect(rawBlock.raw).toBe('  <div>html</div>\n');
            expect(src.slice(rawBlock.range.from, rawBlock.range.to)).toBe(rawBlock.raw);
          }
        }
      });

      it('parses block-level comment and hr inside list item with valid recursive invariants', () => {
        const src = '- item\n  <!-- comment -->\n  ---\n';
        const res = parseMarkdown(src);
        assertRecursiveInvariants(res.root, src);

        const list = res.root.children[0];
        expect(list?.type).toBe('list');
        if (list?.type === 'list') {
          const item = list.items[0]!;
          expect(item.children.length).toBeGreaterThanOrEqual(3);
          const comment = item.children[1]!;
          expect(comment.type).toBe('raw');
          if (comment.type === 'raw') {
            expect(comment.opaque).toBe(true);
            expect(comment.raw).toBe('  <!-- comment -->\n');
          }
          const hr = item.children[2]!;
          expect(hr.type).toBe('horizontal-rule');
          expect(hr.opaque).not.toBe(true);
          expect(hr.raw).toBe('  ---\n');
        }
      });

      it('parses block-level html inside list item with CRLF invariants', () => {
        const src = '- item\r\n  <div>html</div>\r\n';
        const res = parseMarkdown(src);
        assertRecursiveInvariants(res.root, src);

        const list = res.root.children[0];
        expect(list?.type).toBe('list');
        if (list?.type === 'list') {
          const item = list.items[0]!;
          expect(item.children).toHaveLength(2);
          const rawBlock = item.children[1]!;
          expect(rawBlock.type).toBe('raw');
          if (rawBlock.type === 'raw') {
            expect(rawBlock.opaque).toBe(true);
            expect(rawBlock.raw).toBe('  <div>html</div>\r\n');
          }
        }
      });

      it('parses list item with trailing hard break spaces with valid recursive invariants', () => {
        const src = '- hard  \n';
        const res = parseMarkdown(src);
        assertRecursiveInvariants(res.root, src);
        const list = res.root.children[0];
        expect(list?.type).toBe('list');
        if (list?.type === 'list') {
          const item = list.items[0]!;
          const text = item.children[0]!;
          expect(text.type).toBe('text');
          if (text.type === 'text') {
            expect(text.value).toBe('hard  ');
          }
        }
      });

      it('parses inline HTML in list item without block flag and with valid invariants', () => {
        const src = '- item <span>html</span>\n';
        const res = parseMarkdown(src);
        assertRecursiveInvariants(res.root, src);
        const list = res.root.children[0];
        expect(list?.type).toBe('list');
        if (list?.type === 'list') {
          const item = list.items[0]!;
          for (const child of item.children) {
            expect(child.block).toBeFalsy();
          }
        }
      });

      it('parses multiple blockquote children in list item with valid recursive invariants', () => {
        const src = '- item\n  > first\n\n  > second\n- next\n';
        const res = parseMarkdown(src);
        assertRecursiveInvariants(res.root, src);
        const list = res.root.children[0];
        expect(list?.type).toBe('list');
        if (list?.type === 'list') {
          const item = list.items[0]!;
          const bqs = item.children.filter((c) => c.type === 'blockquote');
          expect(bqs).toHaveLength(2);
        }
      });
    });
  });
});

interface InvariantCheckableNode {
  type?: string;
  range?: { from: number; to: number };
  raw?: string;
  children?: unknown[];
  items?: unknown[];
  headers?: unknown[][];
  rows?: unknown[][][];
}

/**
 * Universal recursive validator asserting that:
 * 1. 0 <= node.range.from <= node.range.to <= source.length
 * 2. node.raw === source.slice(node.range.from, node.range.to)
 */
function assertRecursiveInvariants(
  node: InvariantCheckableNode,
  source: string,
  parent?: InvariantCheckableNode
): void {
  expect(node).toBeDefined();
  expect(node.range).toBeDefined();
  if (!node.range) return;
  expect(typeof node.range.from).toBe('number');
  expect(typeof node.range.to).toBe('number');
  expect(node.range.from).toBeGreaterThanOrEqual(0);
  expect(node.range.to).toBeGreaterThanOrEqual(node.range.from);
  expect(node.range.to).toBeLessThanOrEqual(source.length);
  expect(node.raw).toBe(source.slice(node.range.from, node.range.to));

  if (parent && parent.range) {
    expect(parent.range.from).toBeLessThanOrEqual(node.range.from);
    expect(node.range.to).toBeLessThanOrEqual(parent.range.to);
  }

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      assertRecursiveInvariants(child as InvariantCheckableNode, source, node);
    }
  }

  if (node.items && Array.isArray(node.items)) {
    for (const item of node.items) {
      assertRecursiveInvariants(item as InvariantCheckableNode, source, node);
    }
  }

  if (node.type === 'table') {
    if (node.headers) {
      for (const headerRow of node.headers) {
        for (const cell of headerRow) {
          assertRecursiveInvariants(cell as InvariantCheckableNode, source, node);
        }
      }
    }
    if (node.rows) {
      for (const row of node.rows) {
        for (const cell of row) {
          if (Array.isArray(cell)) {
            for (const inline of cell) {
              assertRecursiveInvariants(inline as InvariantCheckableNode, source, node);
            }
          }
        }
      }
    }
  }
}
