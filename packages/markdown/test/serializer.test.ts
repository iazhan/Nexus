import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/parser.js';
import {
  serializeMarkdown,
  serializeBlock,
  serializeInline,
  serializeNode,
  markDirty
} from '../src/serializer.js';
import type { MarkdownNode } from '../src/types.js';

describe('Markdown Serializer', () => {
  describe('No-Edit Round-Trip Byte Identity', () => {
    const testCases: { name: string; source: string }[] = [
      {
        name: 'empty document',
        source: ''
      },
      {
        name: 'whitespace only document',
        source: '   \n\t  \n  '
      },
      {
        name: 'headings 1 through 6',
        source: '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n'
      },
      {
        name: 'heading with leading spaces and inline styles',
        source: '  ## Heading with **bold** and *italic*\n'
      },
      {
        name: 'heading with no trailing newline at EOF',
        source: '# Heading without newline'
      },
      {
        name: 'paragraph with complex inlines',
        source: 'Paragraph with **bold**, *italic*, `inline code`, [Nexus](https://nexus.dev), and ![Logo](logo.png "Title").\n'
      },
      {
        name: 'fenced code block with language and internal formatting',
        source: '```typescript\nfunction add(a: number, b: number): number {\n  return a + b;\n}\n```\n'
      },
      {
        name: 'nested lists with task items and mixed markers',
        source: '- [x] Task completed\n- [ ] Task pending\n  - Subtask 1\n  - Subtask 2\n- Simple item\n'
      },
      {
        name: 'ordered lists with numbering',
        source: '1. First item\n2. Second item\n3. Third item\n'
      },
      {
        name: 'blockquotes with nested content',
        source: '> Quote line 1\n> Quote line 2\n> > Nested quote\n'
      },
      {
        name: 'table with alignments and pipe borders',
        source: '| Feature | Status | Rating |\n| :--- | :---: | ---: |\n| Engine | Active | 100% |\n| Parser | Ready | 95% |\n'
      },
      {
        name: 'math expressions (inline and block)',
        source: 'Math $E = mc^2$ and display:\n\n$$\n\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}\n$$\n'
      },
      {
        name: 'wikilinks with targets and aliases',
        source: 'Check [[Architecture]] and [[Documentation|Docs Page]].\n'
      },
      {
        name: 'raw HTML blocks and inline tags',
        source: '<div class="alert danger">\n  <p>Warning: <b>Forbidden</b> action</p>\n</div>\n'
      },
      {
        name: 'horizontal rules and dividers',
        source: 'Section 1\n\n---\n\nSection 2\n'
      },
      {
        name: 'Windows CRLF line endings throughout',
        source: '# Title\r\n\r\nParagraph line 1\r\nParagraph line 2\r\n\r\n- Item 1\r\n- Item 2\r\n'
      },
      {
        name: 'Unicode, CJK characters and emojis',
        source: '# 🚀 快速开始与指南\n\n这是一个针对 **Nexus 平台** 的测试段落。包含了中文字符、日本語、한글 以及各种表情符号 ✨🎉。\n'
      },
      {
        name: 'realistic mixed document',
        source: [
          '# Nexus Documentation',
          '',
          'Welcome to the **Nexus Project**.',
          '',
          '## Features',
          '',
          '- [x] Fast parser',
          '- [ ] Full WYSIWYG editing',
          '  - Inline ranges',
          '  - Serializer contract',
          '',
          '```json',
          '{',
          '  "status": "active",',
          '  "count": 42',
          '}',
          '```',
          '',
          '| Name | Role |',
          '| :--- | ---: |',
          '| Alpha | Core |',
          '| Beta | View |',
          '',
          '> Notice: Always preserve raw source.',
          '',
          'Inline formula $a^2 + b^2 = c^2$ and [[Glossary|terms]].',
          ''
        ].join('\n')
      },
      {
        // 真实语料回归：有序列表项 + 3 空格缩进的子列表 + 空行 + 缩进段落。
        // 子列表的结束偏移一旦算成外层 item 的末尾，后面的段落 token 会定位落空，
        // 序列化时用 value 再输出一次 —— 末段重复。
        name: 'ordered item with indented sublist, blank line and indented continuation',
        source: ['1. 顶', '   - 子项', '', '    末段', ''].join('\n')
      },
      {
        name: 'ordered item with sublist and indented continuation (CRLF)',
        source: ['1. 顶', '   - 子项', '', '    末段', ''].join('\r\n')
      },
      {
        // 同一根因的另一形态：末块是围栏代码块而不是段落。
        name: 'ordered item with sublist, blank line and indented fenced code block',
        source: ['1. 顶', '   - 子项', '', '    ```js', '    x;', '    ```', ''].join('\n')
      }
    ];

    for (const { name, source } of testCases) {
      it(`preserves byte identity for ${name}`, () => {
        const parsed = parseMarkdown(source);
        const serialized = serializeMarkdown(parsed);
        expect(serialized).toBe(source);
      });

      it(`preserves byte identity when serializing root directly for ${name}`, () => {
        const parsed = parseMarkdown(source);
        const serialized = serializeMarkdown(parsed.root);
        expect(serialized).toBe(source);
      });
    }
  });

  describe('Partial Editing Support', () => {
    it('preserves untouched blocks and spacing when modifying one block', () => {
      const source = '# Original Heading\n\nParagraph 1.\n\nParagraph 2.\n';
      const parsed = parseMarkdown(source);

      // Modify the first block's raw text
      const heading = parsed.root.children[0];
      expect(heading?.type).toBe('heading');
      if (heading && heading.type === 'heading') {
        heading.raw = '# Updated Heading\n';
      }

      const serialized = serializeMarkdown(parsed);
      expect(serialized).toBe('# Updated Heading\n\nParagraph 1.\n\nParagraph 2.\n');
    });

    it('preserves untouched blocks when modifying a middle block', () => {
      const source = '# Heading\n\nMiddle paragraph.\n\nEnd paragraph.\n';
      const parsed = parseMarkdown(source);

      const middle = parsed.root.children[1];
      expect(middle?.type).toBe('paragraph');
      if (middle && middle.type === 'paragraph') {
        middle.raw = 'Replaced middle content.';
      }

      const serialized = serializeMarkdown(parsed);
      expect(serialized).toBe('# Heading\n\nReplaced middle content.\n\nEnd paragraph.\n');
    });

    it('preserves CRLF line endings when modifying a block in CRLF document', () => {
      const source = '# Heading\r\n\r\nFirst item.\r\n\r\nSecond item.\r\n';
      const parsed = parseMarkdown(source);

      const first = parsed.root.children[1];
      if (first && first.type === 'paragraph') {
        first.raw = 'Modified first item.';
      }

      const serialized = serializeMarkdown(parsed);
      expect(serialized).toBe('# Heading\r\n\r\nModified first item.\r\n\r\nSecond item.\r\n');
    });

    it('serializes modified inline child instead of returning stale source', () => {
      const parsed = parseMarkdown('hello **world**');
      const paragraph = parsed.root.children[0];

      if (paragraph && paragraph.type === 'paragraph') {
        const bold = paragraph.children.find((node) => node.type === 'bold');
        if (bold && bold.type === 'bold') {
          bold.children = [
            {
              type: 'text',
              value: 'changed',
              range: { from: 7, to: 12 },
              raw: ''
            }
          ];
        }
      }

      expect(serializeMarkdown(parsed)).toBe('hello **changed**');
    });

    it('serializes modified link child in paragraph', () => {
      const parsed = parseMarkdown('Visit [Old](https://old.com) now.');
      const paragraph = parsed.root.children[0];

      if (paragraph && paragraph.type === 'paragraph') {
        const link = paragraph.children.find((n) => n.type === 'link');
        if (link && link.type === 'link') {
          link.href = 'https://new.dev';
          link.children = [
            {
              type: 'text',
              value: 'New Site',
              range: { from: 7, to: 10 },
              raw: ''
            }
          ];
          link.raw = '';
        }
      }

      expect(serializeMarkdown(parsed)).toBe('Visit [New Site](https://new.dev) now.');
    });

    it('serializes modified nested list item inline child', () => {
      const parsed = parseMarkdown('- parent\n  - child\n');
      const list = parsed.root.children[0];

      if (list && list.type === 'list') {
        const parentItem = list.items[0];
        const nestedList = parentItem?.children.find((c) => c.type === 'list');
        if (nestedList && nestedList.type === 'list') {
          const nestedItem = nestedList.items[0];
          if (nestedItem) {
            nestedItem.children = [
              {
                type: 'text',
                value: 'updated child',
                range: { from: 13, to: 18 },
                raw: ''
              }
            ];
            nestedItem.raw = '';
          }
        }
      }

      expect(serializeMarkdown(parsed)).toBe('- parent\n  - updated child\n');
    });

    it('serializes modified table cell inline child', () => {
      const parsed = parseMarkdown('| A | B |\n|---|---|\n| x | y |\n');
      const table = parsed.root.children[0];

      if (table && table.type === 'table') {
        // Modify cell [0, 0] in rows
        const cell = table.rows[0]?.[0];
        if (cell && cell[0]) {
          cell[0] = {
            type: 'text',
            value: 'edited',
            range: { from: 20, to: 21 },
            raw: ''
          };
        }
        table.raw = '';
      }

      const res = serializeMarkdown(parsed);
      expect(res).toContain('| edited | y |');
      expect(res).toContain('| A | B |');
    });

    it('serializes modified block math formula', () => {
      const parsed = parseMarkdown('$$\n\\alpha\n$$\n');
      const bm = parsed.root.children[0];

      if (bm && bm.type === 'block-math') {
        bm.formula = '\\beta';
        bm.raw = '';
      }

      expect(serializeMarkdown(parsed)).toBe('$$\n\\beta\n$$');
    });

    it('serializes modified wikilink target and alias', () => {
      const parsed = parseMarkdown('See [[OldPage|OldAlias]] for info.');
      const p = parsed.root.children[0];

      if (p && p.type === 'paragraph') {
        const wiki = p.children.find((c) => c.type === 'wikilink');
        if (wiki && wiki.type === 'wikilink') {
          wiki.target = 'NewPage';
          wiki.alias = 'NewAlias';
          wiki.raw = '';
        }
      }

      expect(serializeMarkdown(parsed)).toBe('See [[NewPage|NewAlias]] for info.');
    });

    it('serializes modified code block language and content', () => {
      const parsed = parseMarkdown('```ts\nconst a = 1;\n```\n');
      const cb = parsed.root.children[0];

      if (cb && cb.type === 'code-block') {
        cb.language = 'javascript';
        cb.value = 'const b = 2;';
        markDirty(cb);
      }

      expect(serializeMarkdown(parsed)).toBe('```javascript\nconst b = 2;\n```\n');
    });

    it('preserves Markdown style: __bold__ does not turn into **bold**', () => {
      const parsed = parseMarkdown('hello __world__');
      const p = parsed.root.children[0];

      if (p && p.type === 'paragraph') {
        const bold = p.children.find((c) => c.type === 'bold');
        if (bold && bold.type === 'bold') {
          bold.children = [
            {
              type: 'text',
              value: 'custom',
              range: { from: 8, to: 13 },
              raw: ''
            }
          ];
        }
      }

      expect(serializeMarkdown(parsed)).toBe('hello __custom__');
    });

    it('preserves Markdown style: _italic_ does not turn into *italic*', () => {
      const parsed = parseMarkdown('hello _world_');
      const p = parsed.root.children[0];

      if (p && p.type === 'paragraph') {
        const italic = p.children.find((c) => c.type === 'italic');
        if (italic && italic.type === 'italic') {
          italic.children = [
            {
              type: 'text',
              value: 'custom',
              range: { from: 7, to: 12 },
              raw: ''
            }
          ];
        }
      }

      expect(serializeMarkdown(parsed)).toBe('hello _custom_');
    });

    it('preserves Markdown style: * item does not turn into - item', () => {
      const parsed = parseMarkdown('* Item 1\n* Item 2\n');
      const list = parsed.root.children[0];

      if (list && list.type === 'list') {
        const item1 = list.items[0];
        if (item1) {
          item1.children = [
            {
              type: 'text',
              value: 'Updated 1',
              range: { from: 2, to: 8 },
              raw: ''
            }
          ];
        }
      }

      const res = serializeMarkdown(parsed);
      expect(res).toContain('* Updated 1');
      expect(res).toContain('* Item 2');
    });

    it('preserves Markdown style: 1. item does not turn into 1) item', () => {
      const parsed = parseMarkdown('1. Item 1\n2. Item 2\n');
      const list = parsed.root.children[0];

      if (list && list.type === 'list') {
        const item1 = list.items[0];
        if (item1) {
          item1.children = [
            {
              type: 'text',
              value: 'Updated 1',
              range: { from: 3, to: 9 },
              raw: ''
            }
          ];
        }
      }

      const res = serializeMarkdown(parsed);
      expect(res).toContain('1. Updated 1');
      expect(res).toContain('2. Item 2');
    });
  });

  describe('AST Reconstruction Mode (forceReconstruct: true)', () => {
    it('reconstructs markdown from AST without relying on raw slices', () => {
      const source = '# Heading 1\n\nParagraph with **bold** and *italic*.\n\n```ts\nconst a = 1;\n```\n';
      const parsed = parseMarkdown(source);

      const reconstructed = serializeMarkdown(parsed, { forceReconstruct: true });
      expect(reconstructed).toContain('# Heading 1');
      expect(reconstructed).toContain('**bold**');
      expect(reconstructed).toContain('*italic*');
      expect(reconstructed).toContain('```ts\nconst a = 1;\n```');
    });

    it('reconstructs tables correctly', () => {
      const source = '| Col 1 | Col 2 |\n| :--- | ---: |\n| Val 1 | Val 2 |\n';
      const parsed = parseMarkdown(source);

      const reconstructed = serializeMarkdown(parsed, { forceReconstruct: true });
      expect(reconstructed).toContain('| Col 1 | Col 2 |');
      expect(reconstructed).toContain(':---');
      expect(reconstructed).toContain('Val 1');
    });

    it('reconstructs lists correctly', () => {
      const source = '- Item 1\n- [x] Item 2\n';
      const parsed = parseMarkdown(source);

      const reconstructed = serializeMarkdown(parsed, { forceReconstruct: true });
      expect(reconstructed).toContain('- Item 1');
      expect(reconstructed).toContain('[x]');
    });
  });

  describe('Individual Node Serialization Helpers', () => {
    it('serializeNode serializes individual inline and block nodes', () => {
      const parsed = parseMarkdown('# Header\n\nText with **bold**.');
      const headerNode = parsed.root.children[0];
      const pNode = parsed.root.children[1];

      if (headerNode) {
        expect(serializeNode(headerNode)).toContain('Header');
      }
      if (pNode && pNode.type === 'paragraph') {
        expect(serializeNode(pNode)).toContain('Text with **bold**.');
        const boldNode = pNode.children.find((c) => c.type === 'bold');
        if (boldNode) {
          expect(serializeNode(boldNode)).toBe('**bold**');
        }
      }
    });

    it('serializeBlock and serializeInline format synthesized nodes', () => {
      const inline = serializeInline({
        type: 'bold',
        children: [{ type: 'text', value: 'hello', range: { from: 0, to: 5 }, raw: 'hello' }],
        range: { from: 0, to: 9 },
        raw: ''
      }, true);
      expect(inline).toBe('**hello**');

      const block = serializeBlock({
        type: 'heading',
        depth: 2,
        children: [{ type: 'text', value: 'Subtitle', range: { from: 0, to: 8 }, raw: 'Subtitle' }],
        range: { from: 0, to: 11 },
        raw: ''
      }, true);
      expect(block).toBe('## Subtitle\n');
    });
  });

  describe('markDirty Semantic Modifications (No raw wiping)', () => {
    it('modifies text.value inside bold without clearing raw', () => {
      const document = parseMarkdown('hello **world**');
      const paragraph = document.root.children[0];
      if (paragraph && paragraph.type === 'paragraph') {
        const bold = paragraph.children.find((node) => node.type === 'bold');
        if (bold && bold.type === 'bold') {
          const text = bold.children[0];
          if (text && text.type === 'text') {
            text.value = 'changed';
            markDirty(text);
          }
        }
      }
      expect(serializeMarkdown(document)).toBe('hello **changed**');
    });

    it('modifies inline-math.formula without clearing raw', () => {
      const document = parseMarkdown('Formula: $E=mc^2$ is famous.');
      const paragraph = document.root.children[0];
      if (paragraph && paragraph.type === 'paragraph') {
        const math = paragraph.children.find((node) => node.type === 'inline-math');
        if (math && math.type === 'inline-math') {
          math.formula = 'x^2 + y^2 = z^2';
          markDirty(math);
        }
      }
      expect(serializeMarkdown(document)).toBe('Formula: $x^2 + y^2 = z^2$ is famous.');
    });

    it('modifies link.href and link text without clearing raw', () => {
      const document = parseMarkdown('Check [Google](https://google.com) out.');
      const paragraph = document.root.children[0];
      if (paragraph && paragraph.type === 'paragraph') {
        const link = paragraph.children.find((node) => node.type === 'link');
        if (link && link.type === 'link') {
          link.href = 'https://nexus.dev';
          markDirty(link);
          const text = link.children[0];
          if (text && text.type === 'text') {
            text.value = 'Nexus';
            markDirty(text);
          }
        }
      }
      expect(serializeMarkdown(document)).toBe('Check [Nexus](https://nexus.dev) out.');
    });

    it('modifies wikilink target and alias without clearing raw', () => {
      const document = parseMarkdown('See [[OldTarget|OldAlias]] for reference.');
      const paragraph = document.root.children[0];
      if (paragraph && paragraph.type === 'paragraph') {
        const wiki = paragraph.children.find((node) => node.type === 'wikilink');
        if (wiki && wiki.type === 'wikilink') {
          wiki.target = 'NewTarget';
          wiki.alias = 'NewAlias';
          markDirty(wiki);
        }
      }
      expect(serializeMarkdown(document)).toBe('See [[NewTarget|NewAlias]] for reference.');
    });

    it('modifies nested list item text via markDirty without clearing raw', () => {
      const document = parseMarkdown('- parent\n  - child\n');
      const list = document.root.children[0];
      if (list && list.type === 'list') {
        const parentItem = list.items[0];
        const nestedList = parentItem?.children.find((c) => c.type === 'list');
        if (nestedList && nestedList.type === 'list') {
          const nestedItem = nestedList.items[0];
          const textNode = nestedItem?.children.find((c) => c.type === 'text');
          if (textNode && textNode.type === 'text') {
            textNode.value = 'changed';
            markDirty(textNode);
          }
        }
      }
      expect(serializeMarkdown(document)).toBe('- parent\n  - changed\n');
    });

    it('modifies code block value via markDirty without clearing raw', () => {
      const document = parseMarkdown('```ts\nconst x = 1;\n```\n');
      const cb = document.root.children[0];
      if (cb && cb.type === 'code-block') {
        cb.value = 'const x = 2;';
        markDirty(cb);
      }
      expect(serializeMarkdown(document)).toBe('```ts\nconst x = 2;\n```\n');
    });

    it('modifies heading text via markDirty without clearing raw', () => {
      const document = parseMarkdown('# Old Title\n');
      const h = document.root.children[0];
      if (h && h.type === 'heading') {
        const text = h.children[0];
        if (text && text.type === 'text') {
          text.value = 'New Title';
          markDirty(text);
        }
      }
      expect(serializeMarkdown(document)).toBe('# New Title\n');
    });

    it('preserves direct raw change without dirty/modified flags', () => {
      const document = parseMarkdown('hello world');
      const p = document.root.children[0];
      if (p && p.type === 'paragraph') {
        const text = p.children[0];
        if (text && text.type === 'text') {
          text.raw = 'hello universe';
        }
      }
      expect(serializeMarkdown(document)).toBe('hello universe');
    });
  });

  describe('Table Local Modification and Preservation', () => {
    it('modifies data cell and preserves separator and unedited cells byte-for-byte', () => {
      const source = '| A | B |\n|---|---|\n| x | y |\n';
      const document = parseMarkdown(source);
      const table = document.root.children[0];
      if (table && table.type === 'table') {
        const cellNode = table.rows[0]?.[0]?.[0];
        if (cellNode && cellNode.type === 'text') {
          cellNode.value = 'edited';
          markDirty(cellNode);
        }
      }
      const result = serializeMarkdown(document);
      expect(result).toBe('| A | B |\n|---|---|\n| edited | y |\n');
    });

    it('modifies header cell and preserves separator and data cells byte-for-byte', () => {
      const source = '| A | B |\n|---|---|\n| x | y |\n';
      const document = parseMarkdown(source);
      const table = document.root.children[0];
      if (table && table.type === 'table') {
        const cellNode = table.headers[0]?.[0];
        if (cellNode && cellNode.type === 'text') {
          cellNode.value = 'Header 1';
          markDirty(cellNode);
        }
      }
      const result = serializeMarkdown(document);
      expect(result).toBe('| Header 1 | B |\n|---|---|\n| x | y |\n');
    });

    it('modifies middle row data cell in multiline table', () => {
      const source = '| C1 | C2 |\n|:---|---:|\n| r1c1 | r1c2 |\n| r2c1 | r2c2 |\n| r3c1 | r3c2 |\n';
      const document = parseMarkdown(source);
      const table = document.root.children[0];
      if (table && table.type === 'table') {
        const cellNode = table.rows[1]?.[0]?.[0];
        if (cellNode && cellNode.type === 'text') {
          cellNode.value = 'MODIFIED';
          markDirty(cellNode);
        }
      }
      expect(serializeMarkdown(document)).toBe(
        '| C1 | C2 |\n|:---|---:|\n| r1c1 | r1c2 |\n| MODIFIED | r2c2 |\n| r3c1 | r3c2 |\n'
      );
    });

    it('preserves tables without outer pipes', () => {
      const source = 'A | B\n---|---\nx | y\n';
      const document = parseMarkdown(source);
      const table = document.root.children[0];
      if (table && table.type === 'table') {
        const cellNode = table.rows[0]?.[0]?.[0];
        if (cellNode && cellNode.type === 'text') {
          cellNode.value = 'edited';
          markDirty(cellNode);
        }
      }
      expect(serializeMarkdown(document)).toBe('A | B\n---|---\nedited | y\n');
    });

    it('preserves separator alignment variants (:---:, ---:, :---, ---)', () => {
      const source = '| Left | Center | Right | None |\n|:---|:---:|---:|---|\n| a | b | c | d |\n';
      const document = parseMarkdown(source);
      const table = document.root.children[0];
      if (table && table.type === 'table') {
        const cellNode = table.rows[0]?.[2]?.[0];
        if (cellNode && cellNode.type === 'text') {
          cellNode.value = 'C_NEW';
          markDirty(cellNode);
        }
      }
      expect(serializeMarkdown(document)).toBe(
        '| Left | Center | Right | None |\n|:---|:---:|---:|---|\n| a | b | C_NEW | d |\n'
      );
    });

    it('preserves cells with escaped pipes', () => {
      const source = '| Esc\\|Pipe | Normal |\n|---|---|\n| cell 1 | cell 2 |\n';
      const document = parseMarkdown(source);
      const table = document.root.children[0];
      if (table && table.type === 'table') {
        const cellNode = table.rows[0]?.[1]?.[0];
        if (cellNode && cellNode.type === 'text') {
          cellNode.value = 'updated';
          markDirty(cellNode);
        }
      }
      expect(serializeMarkdown(document)).toBe(
        '| Esc\\|Pipe | Normal |\n|---|---|\n| cell 1 | updated |\n'
      );
    });

    it('preserves CRLF in table modifications', () => {
      const source = '| A | B |\r\n|---|---|\r\n| x | y |\r\n';
      const document = parseMarkdown(source);
      const table = document.root.children[0];
      if (table && table.type === 'table') {
        const cellNode = table.rows[0]?.[0]?.[0];
        if (cellNode && cellNode.type === 'text') {
          cellNode.value = 'edited';
          markDirty(cellNode);
        }
      }
      expect(serializeMarkdown(document)).toBe('| A | B |\r\n|---|---|\r\n| edited | y |\r\n');
    });

    it('preserves table at EOF without trailing newline', () => {
      const source = '| A | B |\n|---|---|\n| x | y |';
      const document = parseMarkdown(source);
      const table = document.root.children[0];
      if (table && table.type === 'table') {
        const cellNode = table.rows[0]?.[0]?.[0];
        if (cellNode && cellNode.type === 'text') {
          cellNode.value = 'edited';
          markDirty(cellNode);
        }
      }
      expect(serializeMarkdown(document)).toBe('| A | B |\n|---|---|\n| edited | y |');
    });

    it('supports markDirty on cell array directly', () => {
      const source = '| A | B |\n|---|---|\n| x | y |\n';
      const document = parseMarkdown(source);
      const table = document.root.children[0];
      if (table && table.type === 'table') {
        const cell = table.rows[0]?.[0];
        if (cell && cell[0] && cell[0].type === 'text') {
          cell[0].value = 'edited';
          markDirty(cell as unknown as Parameters<typeof markDirty>[0]);
        }
      }
      expect(serializeMarkdown(document)).toBe('| A | B |\n|---|---|\n| edited | y |\n');
    });
  });

  describe('Code Block Formatting Preservation', () => {
    it('preserves ~~~ fence and CRLF in code block', () => {
      const source = '~~~ts\r\nold\r\n~~~\r\n';
      const document = parseMarkdown(source);
      const cb = document.root.children[0];
      if (cb && cb.type === 'code-block') {
        cb.value = 'new';
        markDirty(cb);
      }
      expect(serializeMarkdown(document)).toBe('~~~ts\r\nnew\r\n~~~\r\n');
    });

    it('preserves ``` fence and LF in code block', () => {
      const source = '```ts\nold\n```\n';
      const document = parseMarkdown(source);
      const cb = document.root.children[0];
      if (cb && cb.type === 'code-block') {
        cb.value = 'new';
        markDirty(cb);
      }
      expect(serializeMarkdown(document)).toBe('```ts\nnew\n```\n');
    });

    it('preserves fence length greater than 3', () => {
      const source = '~~~~~json\n{"a": 1}\n~~~~~\n';
      const document = parseMarkdown(source);
      const cb = document.root.children[0];
      if (cb && cb.type === 'code-block') {
        cb.value = '{"a": 2}';
        markDirty(cb);
      }
      expect(serializeMarkdown(document)).toBe('~~~~~json\n{"a": 2}\n~~~~~\n');
    });

    it('preserves code block leading indent', () => {
      const source = '  ```python\n  print(1)\n  ```\n';
      const document = parseMarkdown(source);
      const cb = document.root.children[0];
      if (cb && cb.type === 'code-block') {
        cb.value = 'print(2)';
        markDirty(cb);
      }
      expect(serializeMarkdown(document)).toBe('  ```python\n  print(2)\n  ```\n');
    });

    it('preserves code block without language info', () => {
      const source = '```\nold code\n```\n';
      const document = parseMarkdown(source);
      const cb = document.root.children[0];
      if (cb && cb.type === 'code-block') {
        cb.value = 'new code';
        markDirty(cb);
      }
      expect(serializeMarkdown(document)).toBe('```\nnew code\n```\n');
    });

    it('preserves modified language info', () => {
      const source = '~~~ts\nold\n~~~\n';
      const document = parseMarkdown(source);
      const cb = document.root.children[0];
      if (cb && cb.type === 'code-block') {
        cb.language = 'rust';
        cb.value = 'fn main() {}';
        markDirty(cb);
      }
      expect(serializeMarkdown(document)).toBe('~~~rust\nfn main() {}\n~~~\n');
    });

    it('preserves multiline code values with matching newline style', () => {
      const source = '```ts\r\nold\r\n```\r\n';
      const document = parseMarkdown(source);
      const cb = document.root.children[0];
      if (cb && cb.type === 'code-block') {
        cb.value = 'line1\nline2';
        markDirty(cb);
      }
      expect(serializeMarkdown(document)).toBe('```ts\r\nline1\r\nline2\r\n```\r\n');
    });

    it('preserves code block at EOF without trailing newline', () => {
      const source = '```ts\nold\n```';
      const document = parseMarkdown(source);
      const cb = document.root.children[0];
      if (cb && cb.type === 'code-block') {
        cb.value = 'new';
        markDirty(cb);
      }
      expect(serializeMarkdown(document)).toBe('```ts\nnew\n```');
    });
  });

  describe('Heading Formatting Preservation', () => {
    it('preserves leading indentation and CRLF in heading', () => {
      const source = '  ## title\r\n';
      const document = parseMarkdown(source);
      const h = document.root.children[0];
      if (h && h.type === 'heading') {
        const text = h.children[0];
        if (text && text.type === 'text') {
          text.value = 'new';
          markDirty(text);
        }
      }
      expect(serializeMarkdown(document)).toBe('  ## new\r\n');
    });

    it('preserves unindented headings from level 1 through 6', () => {
      for (let level = 1; level <= 6; level++) {
        const hashes = '#'.repeat(level);
        const source = `${hashes} Heading ${level}\n`;
        const document = parseMarkdown(source);
        const h = document.root.children[0];
        if (h && h.type === 'heading') {
          const text = h.children[0];
          if (text && text.type === 'text') {
            text.value = `Updated ${level}`;
            markDirty(text);
          }
        }
        expect(serializeMarkdown(document)).toBe(`${hashes} Updated ${level}\n`);
      }
    });

    it('preserves variable whitespace after heading marker', () => {
      const source = '###   Multiple Spaces Title\n';
      const document = parseMarkdown(source);
      const h = document.root.children[0];
      if (h && h.type === 'heading') {
        const text = h.children[0];
        if (text && text.type === 'text') {
          text.value = 'Updated Spaces';
          markDirty(text);
        }
      }
      expect(serializeMarkdown(document)).toBe('###   Updated Spaces\n');
    });

    it('preserves heading at EOF without trailing newline', () => {
      const source = '  # No Trailing Newline';
      const document = parseMarkdown(source);
      const h = document.root.children[0];
      if (h && h.type === 'heading') {
        const text = h.children[0];
        if (text && text.type === 'text') {
          text.value = 'Updated';
          markDirty(text);
        }
      }
      expect(serializeMarkdown(document)).toBe('  # Updated');
    });
  });

  describe('P1-04A Serializer High-Fidelity Regressions', () => {
    describe('Issue 1: Blockquote dirty serialization', () => {
      it('preserves > prefixes and avoids duplicated prefix corruption when modifying inline child', () => {
        const source = '> first\n> **old**\n';
        const document = parseMarkdown(source);
        const bq = document.root.children[0]!;
        expect(bq.type).toBe('blockquote');
        if (bq.type === 'blockquote') {
          const p = bq.children[0]!;
          if (p.type === 'paragraph') {
            const bold = p.children.find((c) => c.type === 'bold');
            expect(bold).toBeDefined();
            if (bold && bold.type === 'bold') {
              const textNode = bold.children[0];
              if (textNode && textNode.type === 'text') {
                textNode.value = 'new';
                markDirty(textNode);
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('> first\n> **new**\n');
      });

      it('preserves CRLF line endings in blockquote dirty serialization', () => {
        const source = '> first\r\n> **old**\r\n';
        const document = parseMarkdown(source);

        const blockquote = document.root.children[0];
        if (blockquote?.type === 'blockquote') {
          const paragraph = blockquote.children[0];
          if (paragraph?.type === 'paragraph') {
            const bold = paragraph.children.find((node) => node.type === 'bold');
            if (bold?.type === 'bold') {
              const text = bold.children[0];
              if (text?.type === 'text') {
                text.value = 'new';
                markDirty(text);
              }
            }
          }
        }

        expect(serializeMarkdown(document)).toBe(
          '> first\r\n> **new**\r\n'
        );
      });

      it('preserves CRLF line endings when modifying first text child in blockquote', () => {
        const source = '> first\r\n> **old**\r\n';
        const document = parseMarkdown(source);

        const blockquote = document.root.children[0];
        if (blockquote?.type === 'blockquote') {
          const paragraph = blockquote.children[0];
          if (paragraph?.type === 'paragraph') {
            const textNode = paragraph.children.find((node) => node.type === 'text');
            if (textNode?.type === 'text') {
              textNode.value = 'hello\r\n';
              markDirty(textNode);
            }
          }
        }

        expect(serializeMarkdown(document)).toBe(
          '> hello\r\n> **old**\r\n'
        );
      });

      it('preserves >> quote prefixes without spaces on nested blockquotes', () => {
        const source = '>> inner\r\n>> **old**\r\n';
        const document = parseMarkdown(source);

        const outerBq = document.root.children[0];
        if (outerBq?.type === 'blockquote') {
          const innerBq = outerBq.children[0];
          if (innerBq?.type === 'blockquote') {
            const p = innerBq.children[0];
            if (p?.type === 'paragraph') {
              const bold = p.children.find((c) => c.type === 'bold');
              if (bold?.type === 'bold') {
                const text = bold.children[0];
                if (text?.type === 'text') {
                  text.value = 'new';
                  markDirty(text);
                }
              }
            }
          }
        }

        expect(serializeMarkdown(document)).toBe('>> inner\r\n>> **new**\r\n');
      });

      it('preserves > > quote prefixes with space on nested blockquotes', () => {
        const source = '> > inner\r\n> > **old**\r\n';
        const document = parseMarkdown(source);

        const outerBq = document.root.children[0];
        if (outerBq?.type === 'blockquote') {
          const innerBq = outerBq.children[0];
          if (innerBq?.type === 'blockquote') {
            const p = innerBq.children[0];
            if (p?.type === 'paragraph') {
              const bold = p.children.find((c) => c.type === 'bold');
              if (bold?.type === 'bold') {
                const text = bold.children[0];
                if (text?.type === 'text') {
                  text.value = 'new';
                  markDirty(text);
                }
              }
            }
          }
        }

        expect(serializeMarkdown(document)).toBe('> > inner\r\n> > **new**\r\n');
      });
    });

    describe('Issue 3: Indented code block and unclosed fence', () => {
      it('indents unindented new code lines by original fence indentation', () => {
        const source = '  ```python\n  print(1)\n  ```\n';
        const document = parseMarkdown(source);
        const cb = document.root.children[0]!;
        if (cb.type === 'code-block') {
          cb.value = 'print(2)';
          markDirty(cb);
        }
        expect(serializeMarkdown(document)).toBe('  ```python\n  print(2)\n  ```\n');
      });

      it('indents multiline code while leaving empty lines empty', () => {
        const source = '  ```python\n  print(1)\n  ```\n';
        const document = parseMarkdown(source);
        const cb = document.root.children[0]!;
        if (cb.type === 'code-block') {
          cb.value = 'def foo():\n\n    return 1';
          markDirty(cb);
        }
        expect(serializeMarkdown(document)).toBe('  ```python\n  def foo():\n\n      return 1\n  ```\n');
      });

      it('preserves unclosed code block without synthesizing closing fence', () => {
        const source = '```ts\nconst x = 1;';
        const document = parseMarkdown(source);
        const cb = document.root.children[0]!;
        if (cb.type === 'code-block') {
          cb.value = 'const y = 2;';
          markDirty(cb);
        }
        expect(serializeMarkdown(document)).toBe('```ts\nconst y = 2;');
      });

      it('preserves indented unclosed code block with trailing newline', () => {
        const source = '  ```ts\n  const x = 1;\n';
        const document = parseMarkdown(source);
        const cb = document.root.children[0]!;
        if (cb.type === 'code-block') {
          cb.value = 'const y = 2;';
          markDirty(cb);
        }
        expect(serializeMarkdown(document)).toBe('  ```ts\n  const y = 2;\n');
      });
    });

    describe('Issue 4: ATX heading closing marker preservation', () => {
      it('preserves closing # sequence and preceding whitespace on edit', () => {
        const source = '## title ##';
        const document = parseMarkdown(source);
        const h = document.root.children[0]!;
        if (h.type === 'heading') {
          const t = h.children[0]!;
          if (t.type === 'text') {
            t.value = 'new title';
            markDirty(t);
          }
        }
        expect(serializeMarkdown(document)).toBe('## new title ##');
      });

      it('preserves indented heading with closing # sequence and CRLF', () => {
        const source = '  ## title ##\r\n';
        const document = parseMarkdown(source);
        const h = document.root.children[0]!;
        if (h.type === 'heading') {
          const t = h.children[0]!;
          if (t.type === 'text') {
            t.value = 'new title';
            markDirty(t);
          }
        }
        expect(serializeMarkdown(document)).toBe('  ## new title ##\r\n');
      });

      it('preserves closing # sequence with trailing whitespace and newline', () => {
        const source = '### title ###   \n';
        const document = parseMarkdown(source);
        const h = document.root.children[0]!;
        if (h.type === 'heading') {
          const t = h.children[0]!;
          if (t.type === 'text') {
            t.value = 'new title';
            markDirty(t);
          }
        }
        expect(serializeMarkdown(document)).toBe('### new title ###   \n');
      });
    });

    describe('Issue 5: Dirty block-math format preservation', () => {
      it('preserves single-line display math format $$x$$', () => {
        const source = '$$x$$';
        const document = parseMarkdown(source);
        const bm = document.root.children[0]!;
        if (bm.type === 'block-math') {
          bm.formula = 'y';
          markDirty(bm);
        }
        expect(serializeMarkdown(document)).toBe('$$y$$');
      });

      it('preserves multiline display math with CRLF, formula padding and EOF newline', () => {
        const source = '$$\r\n x \r\n$$\r\n';
        const document = parseMarkdown(source);
        const bm = document.root.children[0]!;
        if (bm.type === 'block-math') {
          bm.formula = 'y';
          markDirty(bm);
        }
        expect(serializeMarkdown(document)).toBe('$$\r\n y \r\n$$\r\n');
      });

      it('preserves multiline display math with LF and formula spaces', () => {
        const source = '$$\n  x = 1  \n$$\n';
        const document = parseMarkdown(source);
        const bm = document.root.children[0]!;
        if (bm.type === 'block-math') {
          bm.formula = 'y = 2';
          markDirty(bm);
        }
        expect(serializeMarkdown(document)).toBe('$$\n  y = 2  \n$$\n');
      });

      it('preserves multiline display math at EOF without trailing newline', () => {
        const source = '$$\n x \n$$';
        const document = parseMarkdown(source);
        const bm = document.root.children[0]!;
        if (bm.type === 'block-math') {
          bm.formula = 'y';
          markDirty(bm);
        }
        expect(serializeMarkdown(document)).toBe('$$\n y \n$$');
      });
    });

    describe('Inline code delimiter and padding preservation', () => {
      it('preserves double-backtick delimiters when modified', () => {
        const source = 'hello ``old``\n';
        const document = parseMarkdown(source);
        const p = document.root.children[0]!;
        if (p.type === 'paragraph') {
          const code = p.children.find((c) => c.type === 'inline-code');
          if (code && code.type === 'inline-code') {
            code.value = 'new';
            markDirty(code);
          }
        }
        expect(serializeMarkdown(document)).toBe('hello ``new``\n');
      });

      it('escalates delimiter length when new value contains backticks', () => {
        const source = 'hello `old`\n';
        const document = parseMarkdown(source);
        const p = document.root.children[0]!;
        if (p.type === 'paragraph') {
          const code = p.children.find((c) => c.type === 'inline-code');
          if (code && code.type === 'inline-code') {
            code.value = 'a ` b';
            markDirty(code);
          }
        }
        expect(serializeMarkdown(document)).toBe('hello ``a ` b``\n');
      });

      it('adds padding when inline code begins or ends with backtick', () => {
        const source = 'hello `old`\n';
        const document = parseMarkdown(source);
        const p = document.root.children[0]!;
        if (p.type === 'paragraph') {
          const code = p.children.find((c) => c.type === 'inline-code');
          if (code && code.type === 'inline-code') {
            code.value = '`foo`';
            markDirty(code);
          }
        }
        expect(serializeMarkdown(document)).toBe('hello `` `foo` ``\n');
      });

      it('preserves original space padding in inline code', () => {
        const source = 'hello `` old ``\n';
        const document = parseMarkdown(source);
        const p = document.root.children[0]!;
        if (p.type === 'paragraph') {
          const code = p.children.find((c) => c.type === 'inline-code');
          if (code && code.type === 'inline-code') {
            code.value = 'updated';
            markDirty(code);
          }
        }
        expect(serializeMarkdown(document)).toBe('hello `` updated ``\n');
      });
    });

    describe('Table cell pipe escaping and preservation', () => {
      it('escapes newly added pipe in table data cell with leading/trailing pipes', () => {
        const source = '| A | B |\n|---|---|\n| x | y |\n';
        const document = parseMarkdown(source);
        const table = document.root.children[0]!;
        if (table.type === 'table') {
          const cell = table.rows[0]![0]!;
          const text = cell[0]!;
          if (text.type === 'text') {
            text.value = 'a | b';
            markDirty(text);
          }
        }
        expect(serializeMarkdown(document)).toBe('| A | B |\n|---|---|\n| a \\| b | y |\n');
      });

      it('escapes newly added pipe in table header cell', () => {
        const source = '| A | B |\n|---|---|\n| x | y |\n';
        const document = parseMarkdown(source);
        const table = document.root.children[0]!;
        if (table.type === 'table') {
          const cell = table.headers[0]!;
          const text = cell[0]!;
          if (text.type === 'text') {
            text.value = 'Col | 1';
            markDirty(text);
          }
        }
        expect(serializeMarkdown(document)).toBe('| Col \\| 1 | B |\n|---|---|\n| x | y |\n');
      });

      it('escapes newly added pipe in table without leading/trailing pipes', () => {
        const source = 'A | B\n---|---\nx | y\n';
        const document = parseMarkdown(source);
        const table = document.root.children[0]!;
        if (table.type === 'table') {
          const cell = table.rows[0]![0]!;
          const text = cell[0]!;
          if (text.type === 'text') {
            text.value = 'a | b';
            markDirty(text);
          }
        }
        expect(serializeMarkdown(document)).toBe('A | B\n---|---\na \\| b | y\n');
      });

      it('preserves already-escaped pipe and escapes multiple consecutive pipes', () => {
        const source = '| A | B |\n|---|---|\n| x | y |\n';
        const document = parseMarkdown(source);
        const table = document.root.children[0]!;
        if (table.type === 'table') {
          const cell0 = table.rows[0]![0]!;
          const text0 = cell0[0]!;
          if (text0.type === 'text') {
            text0.value = 'a \\| b';
            markDirty(text0);
          }
          const cell1 = table.rows[0]![1]!;
          const text1 = cell1[0]!;
          if (text1.type === 'text') {
            text1.value = 'c || d';
            markDirty(text1);
          }
        }
        expect(serializeMarkdown(document)).toBe('| A | B |\n|---|---|\n| a \\| b | c \\|\\| d |\n');
      });

      it('correctly handles combinations of backslashes and pipes', () => {
        const source = '| A | B |\n|---|---|\n| x | y |\n';
        const document = parseMarkdown(source);
        const table = document.root.children[0]!;
        if (table.type === 'table') {
          // Escaped backslash before unescaped pipe (\\|) -> must escape pipe (\\\|)
          const cell0 = table.rows[0]![0]!;
          const text0 = cell0[0]!;
          if (text0.type === 'text') {
            text0.value = 'a \\\\| b';
            markDirty(text0);
          }
          // Escaped backslash before escaped pipe (\\\|) -> already escaped, stays \\\|
          const cell1 = table.rows[0]![1]!;
          const text1 = cell1[0]!;
          if (text1.type === 'text') {
            text1.value = 'c \\\\\\| d';
            markDirty(text1);
          }
        }
        expect(serializeMarkdown(document)).toBe('| A | B |\n|---|---|\n| a \\\\\\| b | c \\\\\\| d |\n');
      });
    });

    describe('Important 1, 2, 3 High-Fidelity Preservation Fixes', () => {
      it('preserves list item nested code block closing fence on edit (Important 1)', () => {
        const source = '- parent\n  ```ts\n  old\n  ```\n';
        const document = parseMarkdown(source);
        const list = document.root.children[0];
        expect(list?.type).toBe('list');
        if (list?.type === 'list') {
          const item = list.items[0];
          const code = item?.children.find((c) => c.type === 'code-block');
          expect(code?.type).toBe('code-block');
          if (code?.type === 'code-block') {
            code.value = 'new';
            markDirty(code);
          }
        }
        expect(serializeMarkdown(document)).toBe('- parent\n  ```ts\n  new\n  ```\n');
      });

      it('preserves list item nested blockquote subsequent lines on edit (Important 1)', () => {
        const source = '- parent\n  > old\n  > next\n';
        const document = parseMarkdown(source);
        const list = document.root.children[0];
        expect(list?.type).toBe('list');
        if (list?.type === 'list') {
          const item = list.items[0];
          const bq = item?.children.find((c) => c.type === 'blockquote');
          expect(bq?.type).toBe('blockquote');
          if (bq?.type === 'blockquote') {
            const p = bq.children[0];
            expect(p?.type).toBe('paragraph');
            if (p?.type === 'paragraph') {
              const text = p.children[0];
              expect(text?.type).toBe('text');
              if (text?.type === 'text') {
                text.value = 'new\nnext';
                markDirty(text);
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('- parent\n  > new\n  > next\n');
      });

      it('preserves CRLF between list item first line and nested code block (Important 1)', () => {
        const source = '- parent\r\n  ```ts\r\n  old\r\n  ```\r\n';
        const document = parseMarkdown(source);
        const list = document.root.children[0];
        expect(list?.type).toBe('list');
        if (list?.type === 'list') {
          const item = list.items[0];
          const code = item?.children.find((c) => c.type === 'code-block');
          expect(code?.type).toBe('code-block');
          if (code?.type === 'code-block') {
            code.value = 'new';
            markDirty(code);
          }
        }
        expect(serializeMarkdown(document)).toBe('- parent\r\n  ```ts\r\n  new\r\n  ```\r\n');
      });

      it('preserves non-standard spaces in nested blockquotes without extra spaces (Important 2)', () => {
        const source = '>   > inner\n>   > **old**\n';
        const document = parseMarkdown(source);
        const outerBq = document.root.children[0];
        expect(outerBq?.type).toBe('blockquote');
        if (outerBq?.type === 'blockquote') {
          const innerBq = outerBq.children[0];
          expect(innerBq?.type).toBe('blockquote');
          if (innerBq?.type === 'blockquote') {
            const p = innerBq.children[0];
            expect(p?.type).toBe('paragraph');
            if (p?.type === 'paragraph') {
              const bold = p.children.find((c) => c.type === 'bold');
              expect(bold?.type).toBe('bold');
              if (bold?.type === 'bold') {
                const text = bold.children[0];
                expect(text?.type).toBe('text');
                if (text?.type === 'text') {
                  text.value = 'new';
                  markDirty(text);
                }
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('>   > inner\n>   > **new**\n');
      });

      it('preserves blockquote with nested list without extra indentation or duplicate markers (Important 2)', () => {
        const source = '> - parent\n>   - **old**\n';
        const document = parseMarkdown(source);
        const bq = document.root.children[0];
        expect(bq?.type).toBe('blockquote');
        if (bq?.type === 'blockquote') {
          const list = bq.children[0];
          expect(list?.type).toBe('list');
          if (list?.type === 'list') {
            const parentItem = list.items[0];
            const nestedList = parentItem?.children.find((c) => c.type === 'list');
            expect(nestedList?.type).toBe('list');
            if (nestedList?.type === 'list') {
              const item1 = nestedList.items[0];
              expect(item1?.type).toBe('list-item');
              const bold = item1?.children.find((c) => c.type === 'bold');
              expect(bold?.type).toBe('bold');
              if (bold?.type === 'bold') {
                const text = bold.children[0];
                expect(text?.type).toBe('text');
                if (text?.type === 'text') {
                  text.value = 'new';
                  markDirty(text);
                }
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('> - parent\n>   - **new**\n');
      });

      it('preserves multiple consecutive empty quote lines in blockquote on edit (Important 2)', () => {
        const source = '> a\n>\n>\n> **old**\n';
        const document = parseMarkdown(source);
        const bq = document.root.children[0];
        expect(bq?.type).toBe('blockquote');
        if (bq?.type === 'blockquote') {
          const p2 = bq.children[1];
          expect(p2?.type).toBe('paragraph');
          if (p2?.type === 'paragraph') {
            const bold = p2.children.find((c) => c.type === 'bold');
            expect(bold?.type).toBe('bold');
            if (bold?.type === 'bold') {
              const text = bold.children[0];
              expect(text?.type).toBe('text');
              if (text?.type === 'text') {
                text.value = 'new';
                markDirty(text);
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('> a\n>\n>\n> **new**\n');
      });

      it('preserves escape character semantics under forceReconstruct: true (Important 3)', () => {
        const source = '\\*literal\\* and \\_literal\\_ and \\# literal and \\`raw\\`\n';
        const document = parseMarkdown(source);
        const serialized = serializeMarkdown(document, { forceReconstruct: true });
        expect(serialized).toBe('\\*literal\\* and \\_literal\\_ and \\# literal and \\`raw\\`');

        // Verify round-trip re-parsing does not generate italic, heading, or inline-code
        const reparsed = parseMarkdown(serialized);
        const p = reparsed.root.children[0];
        expect(p?.type).toBe('paragraph');
        if (p?.type === 'paragraph') {
          expect(p.children.some((c) => c.type === 'italic')).toBe(false);
          expect(p.children.some((c) => c.type === 'inline-code')).toBe(false);
        }
        expect(reparsed.root.children.some((c) => c.type === 'heading')).toBe(false);
      });
    });

    describe('P1-04A Remaining High-Fidelity Regressions', () => {
      // 1. List item sibling dirty with nested blockquote (LF)
      it('preserves nested blockquote when sibling list item is modified (LF)', () => {
        const source = '- first\n  > quoted\n  > next\n- second\n';
        const document = parseMarkdown(source);
        const list = document.root.children[0];
        expect(list?.type).toBe('list');
        if (list?.type === 'list') {
          const item1 = list.items[1];
          const text = item1?.children.find((c) => c.type === 'text');
          if (text?.type === 'text') {
            text.value = 'changed';
            markDirty(text);
          }
        }
        expect(serializeMarkdown(document)).toBe('- first\n  > quoted\n  > next\n- changed\n');
      });

      // 2. List item sibling dirty with nested blockquote (CRLF)
      it('preserves nested blockquote when sibling list item is modified (CRLF)', () => {
        const source = '- first\r\n  > quoted\r\n  > next\r\n- second\r\n';
        const document = parseMarkdown(source);
        const list = document.root.children[0];
        expect(list?.type).toBe('list');
        if (list?.type === 'list') {
          const item1 = list.items[1];
          const text = item1?.children.find((c) => c.type === 'text');
          if (text?.type === 'text') {
            text.value = 'changed';
            markDirty(text);
          }
        }
        expect(serializeMarkdown(document)).toBe('- first\r\n  > quoted\r\n  > next\r\n- changed\r\n');
      });

      // 3. Outer blockquote with list containing nested blockquote
      it('preserves nested blockquote inside list item within outer blockquote on sibling edit', () => {
        const source = '> - first\n>   > quoted\n>   > next\n> - second\n';
        const document = parseMarkdown(source);
        const bq = document.root.children[0];
        expect(bq?.type).toBe('blockquote');
        if (bq?.type === 'blockquote') {
          const list = bq.children[0];
          expect(list?.type).toBe('list');
          if (list?.type === 'list') {
            const item1 = list.items[1];
            const text = item1?.children.find((c) => c.type === 'text');
            if (text?.type === 'text') {
              text.value = 'changed';
              markDirty(text);
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('> - first\n>   > quoted\n>   > next\n> - changed\n');
      });

      // 4. Dirty blockquote with subsequent plain text line (LF)
      it('does not duplicate > on subsequent plain text lines in dirty blockquote (LF)', () => {
        const source = '> **old**\n> next\n';
        const document = parseMarkdown(source);
        const bq = document.root.children[0];
        expect(bq?.type).toBe('blockquote');
        if (bq?.type === 'blockquote') {
          const p = bq.children[0];
          expect(p?.type).toBe('paragraph');
          if (p?.type === 'paragraph') {
            const bold = p.children.find((c) => c.type === 'bold');
            if (bold?.type === 'bold') {
              const text = bold.children[0];
              if (text?.type === 'text') {
                text.value = 'new';
                markDirty(text);
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('> **new**\n> next\n');
      });

      // 5. Dirty blockquote with subsequent plain text line (CRLF)
      it('does not duplicate > on subsequent plain text lines in dirty blockquote (CRLF)', () => {
        const source = '> **old**\r\n> next\r\n';
        const document = parseMarkdown(source);
        const bq = document.root.children[0];
        expect(bq?.type).toBe('blockquote');
        if (bq?.type === 'blockquote') {
          const p = bq.children[0];
          expect(p?.type).toBe('paragraph');
          if (p?.type === 'paragraph') {
            const bold = p.children.find((c) => c.type === 'bold');
            if (bold?.type === 'bold') {
              const text = bold.children[0];
              if (text?.type === 'text') {
                text.value = 'new';
                markDirty(text);
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('> **new**\r\n> next\r\n');
      });

      // 6. Dirty blockquote with 3 lines
      it('does not duplicate > on multiple subsequent lines in dirty blockquote', () => {
        const source = '> **old**\n> next\n> third\n';
        const document = parseMarkdown(source);
        const bq = document.root.children[0];
        expect(bq?.type).toBe('blockquote');
        if (bq?.type === 'blockquote') {
          const p = bq.children[0];
          expect(p?.type).toBe('paragraph');
          if (p?.type === 'paragraph') {
            const bold = p.children.find((c) => c.type === 'bold');
            if (bold?.type === 'bold') {
              const text = bold.children[0];
              if (text?.type === 'text') {
                text.value = 'new';
                markDirty(text);
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('> **new**\n> next\n> third\n');
      });

      // 7. List item containing blockquote dirty
      it('does not duplicate > on list item nested blockquote on edit', () => {
        const source = '- parent\n  > **old**\n  > next\n';
        const document = parseMarkdown(source);
        const list = document.root.children[0];
        expect(list?.type).toBe('list');
        if (list?.type === 'list') {
          const item = list.items[0];
          const bq = item?.children.find((c) => c.type === 'blockquote');
          if (bq?.type === 'blockquote') {
            const p = bq.children[0];
            if (p?.type === 'paragraph') {
              const bold = p.children.find((c) => c.type === 'bold');
              if (bold?.type === 'bold') {
                const text = bold.children[0];
                if (text?.type === 'text') {
                  text.value = 'new';
                  markDirty(text);
                }
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('- parent\n  > **new**\n  > next\n');
      });

      // 8. Multi-level blockquote dirty with subsequent line
      it('does not duplicate > on multi-level blockquote with subsequent line', () => {
        const source = '>   > **old**\n>   > next\n';
        const document = parseMarkdown(source);
        const outerBq = document.root.children[0];
        expect(outerBq?.type).toBe('blockquote');
        if (outerBq?.type === 'blockquote') {
          const innerBq = outerBq.children[0];
          if (innerBq?.type === 'blockquote') {
            const p = innerBq.children[0];
            if (p?.type === 'paragraph') {
              const bold = p.children.find((c) => c.type === 'bold');
              if (bold?.type === 'bold') {
                const text = bold.children[0];
                if (text?.type === 'text') {
                  text.value = 'new';
                  markDirty(text);
                }
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('>   > **new**\n>   > next\n');
      });

      // 9. Escape character semantic model in AST
      it('models escape characters as text nodes with value and raw in AST', () => {
        const source = '\\*literal\\*';
        const parsed = parseMarkdown(source);
        const p = parsed.root.children[0];
        expect(p?.type).toBe('paragraph');
        if (p?.type === 'paragraph') {
          const escNode = p.children[0];
          expect(escNode?.type).toBe('text');
          if (escNode?.type === 'text') {
            expect(escNode.value).toBe('*');
            expect(escNode.raw).toBe('\\*');
            expect(escNode.opaque).toBeUndefined();
          }
        }
        const serialized = serializeMarkdown(parsed, { forceReconstruct: true });
        expect(serialized).toBe('\\*literal\\*');
        const reparsed = parseMarkdown(serialized);
        expect(reparsed.root.children[0]?.type).toBe('paragraph');
        expect(reparsed.root.children.some((node) => node.type === 'heading')).toBe(false);
      });
    });

    describe('Cross-nesting high-fidelity regressions (P1-04A)', () => {
      // 1. Outer blockquote + list + multi-level blockquote (>>)
      it('preserves subsequent lines in outer blockquote + list + nested multi-level blockquote (>>)', () => {
        const source = '> - parent\n>   >> old\n>   >> next\n';
        const document = parseMarkdown(source);
        const bq = document.root.children[0];
        expect(bq?.type).toBe('blockquote');
        if (bq?.type === 'blockquote') {
          const list = bq.children[0];
          expect(list?.type).toBe('list');
          if (list?.type === 'list') {
            const item = list.items[0];
            const nestedBq = item?.children.find((c) => c.type === 'blockquote');
            expect(nestedBq?.type).toBe('blockquote');
            if (nestedBq?.type === 'blockquote') {
              const innerBq = nestedBq.children[0];
              expect(innerBq?.type).toBe('blockquote');
              if (innerBq?.type === 'blockquote') {
                const p = innerBq.children[0];
                expect(p?.type).toBe('paragraph');
                if (p?.type === 'paragraph') {
                  const text = p.children[0];
                  expect(text?.type).toBe('text');
                  if (text?.type === 'text') {
                    text.value = text.value.replace('old', 'NEW');
                    markDirty(text);
                  }
                }
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('> - parent\n>   >> NEW\n>   >> next\n');
      });

      it('preserves subsequent lines in outer blockquote + list + nested multi-level blockquote (> >)', () => {
        const source = '> - parent\n>   > > old\n>   > > next\n';
        const document = parseMarkdown(source);
        const bq = document.root.children[0];
        if (bq?.type === 'blockquote') {
          const list = bq.children[0];
          if (list?.type === 'list') {
            const item = list.items[0];
            const nestedBq = item?.children.find((c) => c.type === 'blockquote');
            if (nestedBq?.type === 'blockquote') {
              const innerBq = nestedBq.children[0];
              if (innerBq?.type === 'blockquote') {
                const p = innerBq.children[0];
                if (p?.type === 'paragraph') {
                  const text = p.children[0];
                  if (text?.type === 'text') {
                    text.value = text.value.replace('old', 'NEW');
                    markDirty(text);
                  }
                }
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('> - parent\n>   > > NEW\n>   > > next\n');
      });

      it('preserves subsequent lines in outer blockquote + list + nested multi-level blockquote (>   >)', () => {
        const source = '> - parent\n>   >   > old\n>   >   > next\n';
        const document = parseMarkdown(source);
        const bq = document.root.children[0];
        if (bq?.type === 'blockquote') {
          const list = bq.children[0];
          if (list?.type === 'list') {
            const item = list.items[0];
            const nestedBq = item?.children.find((c) => c.type === 'blockquote');
            if (nestedBq?.type === 'blockquote') {
              const innerBq = nestedBq.children[0];
              if (innerBq?.type === 'blockquote') {
                const p = innerBq.children[0];
                if (p?.type === 'paragraph') {
                  const text = p.children[0];
                  if (text?.type === 'text') {
                    text.value = text.value.replace('old', 'NEW');
                    markDirty(text);
                  }
                }
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('> - parent\n>   >   > NEW\n>   >   > next\n');
      });

      it('preserves subsequent lines in outer blockquote + list + nested multi-level blockquote (CRLF)', () => {
        const source = '> - parent\r\n>   >> old\r\n>   >> next\r\n';
        const document = parseMarkdown(source);
        const bq = document.root.children[0];
        if (bq?.type === 'blockquote') {
          const list = bq.children[0];
          if (list?.type === 'list') {
            const item = list.items[0];
            const nestedBq = item?.children.find((c) => c.type === 'blockquote');
            if (nestedBq?.type === 'blockquote') {
              const innerBq = nestedBq.children[0];
              if (innerBq?.type === 'blockquote') {
                const p = innerBq.children[0];
                if (p?.type === 'paragraph') {
                  const text = p.children[0];
                  if (text?.type === 'text') {
                    text.value = text.value.replace('old', 'NEW');
                    markDirty(text);
                  }
                }
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('> - parent\r\n>   >> NEW\r\n>   >> next\r\n');
      });

      // 2. List item with multiple blockquotes separated by empty lines
      it('preserves second blockquote when first blockquote in list item is modified (LF)', () => {
        const source = '- parent\n  > old\n\n  > next\n';
        const document = parseMarkdown(source);
        const list = document.root.children[0];
        expect(list?.type).toBe('list');
        if (list?.type === 'list') {
          const item = list.items[0];
          const bq1 = item?.children.filter((c) => c.type === 'blockquote')[0];
          expect(bq1?.type).toBe('blockquote');
          if (bq1?.type === 'blockquote') {
            const p = bq1.children[0];
            if (p?.type === 'paragraph') {
              const text = p.children[0];
              if (text?.type === 'text') {
                text.value = 'new';
                markDirty(text);
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('- parent\n  > new\n\n  > next\n');
      });

      it('preserves second blockquote with inline mark when first blockquote is modified', () => {
        const source = '- parent\n  > old\n\n  > **next**\n';
        const document = parseMarkdown(source);
        const list = document.root.children[0];
        expect(list?.type).toBe('list');
        if (list?.type === 'list') {
          const item = list.items[0];
          const bq1 = item?.children.filter((c) => c.type === 'blockquote')[0];
          if (bq1?.type === 'blockquote') {
            const p = bq1.children[0];
            if (p?.type === 'paragraph') {
              const text = p.children[0];
              if (text?.type === 'text') {
                text.value = 'new';
                markDirty(text);
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('- parent\n  > new\n\n  > **next**\n');
      });

      it('preserves multiple consecutive empty lines between blockquotes in list item', () => {
        const source = '- parent\n  > old\n\n\n  > next\n';
        const document = parseMarkdown(source);
        const list = document.root.children[0];
        if (list?.type === 'list') {
          const item = list.items[0];
          const bq1 = item?.children.filter((c) => c.type === 'blockquote')[0];
          if (bq1?.type === 'blockquote') {
            const p = bq1.children[0];
            if (p?.type === 'paragraph') {
              const text = p.children[0];
              if (text?.type === 'text') {
                text.value = 'new';
                markDirty(text);
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('- parent\n  > new\n\n\n  > next\n');
      });

      it('preserves multiple blockquotes in list item under CRLF', () => {
        const source = '- parent\r\n  > old\r\n\r\n  > next\r\n';
        const document = parseMarkdown(source);
        const list = document.root.children[0];
        if (list?.type === 'list') {
          const item = list.items[0];
          const bq1 = item?.children.filter((c) => c.type === 'blockquote')[0];
          if (bq1?.type === 'blockquote') {
            const p = bq1.children[0];
            if (p?.type === 'paragraph') {
              const text = p.children[0];
              if (text?.type === 'text') {
                text.value = 'new';
                markDirty(text);
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('- parent\r\n  > new\r\n\r\n  > next\r\n');
      });

      it('preserves first blockquote when second blockquote in list item is modified', () => {
        const source = '- parent\n  > old\n\n  > next\n';
        const document = parseMarkdown(source);
        const list = document.root.children[0];
        if (list?.type === 'list') {
          const item = list.items[0];
          const bq2 = item?.children.filter((c) => c.type === 'blockquote')[1];
          expect(bq2?.type).toBe('blockquote');
          if (bq2?.type === 'blockquote') {
            const p = bq2.children[0];
            if (p?.type === 'paragraph') {
              const text = p.children[0];
              if (text?.type === 'text') {
                text.value = 'NEW';
                markDirty(text);
              }
            }
          }
        }
        expect(serializeMarkdown(document)).toBe('- parent\n  > old\n\n  > NEW\n');
      });

      // Minor: Empty inline code serialization strategy
      it('serializes empty inline code as empty string without leaving invalid backticks', () => {
        const source = 'hello `old` world\n';
        const document = parseMarkdown(source);
        const p = document.root.children[0];
        if (p?.type === 'paragraph') {
          const code = p.children.find((c) => c.type === 'inline-code');
          expect(code?.type).toBe('inline-code');
          if (code?.type === 'inline-code') {
            code.value = '';
            markDirty(code);
          }
        }
        expect(serializeMarkdown(document)).toBe('hello  world\n');
      });
    });
  });

  describe('P1-04A Review Regression Tests', () => {
    it('does not insert a blank quote line when editing a nested list inside an outer blockquote', () => {
      const source = '> - parent\n>   - old\n>   - next\n> - sibling\n';
      const document = parseMarkdown(source);
      const outer = document.root.children[0];

      expect(outer?.type).toBe('blockquote');
      if (outer?.type === 'blockquote') {
        const list = outer.children[0];
        expect(list?.type).toBe('list');
        if (list?.type === 'list') {
          const nestedList = list.items[0]?.children.find((child) => child.type === 'list');
          expect(nestedList?.type).toBe('list');
          if (nestedList?.type === 'list') {
            const text = nestedList.items[0]?.children.find((child) => child.type === 'text');
            expect(text?.type).toBe('text');
            if (text?.type === 'text') {
              text.value = 'NEW';
              markDirty(text);
            }
          }
        }
      }

      expect(serializeMarkdown(document)).toBe('> - parent\n>   - NEW\n>   - next\n> - sibling\n');
    });

    it('preserves the closing fence when editing a fenced code block inside an outer blockquote and list', () => {
      const source = '> - parent\n>   ```ts\n>   old\n>   next\n>   ```\n> - sibling\n';
      const document = parseMarkdown(source);
      const outer = document.root.children[0];

      expect(outer?.type).toBe('blockquote');
      if (outer?.type === 'blockquote') {
        const list = outer.children[0];
        expect(list?.type).toBe('list');
        if (list?.type === 'list') {
          const code = list.items[0]?.children.find((child) => child.type === 'code-block');
          expect(code?.type).toBe('code-block');
          if (code?.type === 'code-block') {
            code.value = 'NEW\nnext';
            markDirty(code);
          }
        }
      }

      const serialized = serializeMarkdown(document);
      expect(serialized).toBe('> - parent\n>   ```ts\n>   NEW\n>   next\n>   ```\n> - sibling\n');

      const reparsed = parseMarkdown(serialized);
      const reparsedOuter = reparsed.root.children[0];
      expect(reparsedOuter?.type).toBe('blockquote');
      if (reparsedOuter?.type === 'blockquote') {
        const reparsedList = reparsedOuter.children[0];
        expect(reparsedList?.type).toBe('list');
        if (reparsedList?.type === 'list') {
          expect(reparsedList.items[0]?.children.some((child) => child.type === 'code-block')).toBe(true);
          expect(reparsedList.items[1]?.children.some((child) => child.type === 'text')).toBe(true);
        }
      }
    });

    it('keeps nested blockquote structure during force reconstruction', () => {
      const source = '- parent\n  > old\n  > next\n- sibling\n';
      const document = parseMarkdown(source);

      const reconstructed = serializeMarkdown(document, { forceReconstruct: true });
      expect(reconstructed).toBe('- parent\n  > old\n  > next\n- sibling');

      const reparsed = parseMarkdown(reconstructed);
      expect(reparsed.root.children).toHaveLength(1);
      const list = reparsed.root.children[0];
      expect(list?.type).toBe('list');
      if (list?.type === 'list') {
        expect(list.items).toHaveLength(2);
        expect(list.items[0]?.children.some((child) => child.type === 'blockquote')).toBe(true);
      }
    });

    it('preserves the missing trailing newline for a dirty list item at EOF', () => {
      const source = '- old';
      const document = parseMarkdown(source);
      const list = document.root.children[0];

      expect(list?.type).toBe('list');
      if (list?.type === 'list') {
        const text = list.items[0]?.children.find((child) => child.type === 'text');
        expect(text?.type).toBe('text');
        if (text?.type === 'text') {
          text.value = 'NEW';
          markDirty(text);
        }
      }

      expect(serializeMarkdown(document)).toBe('- NEW');
    });

    it('does not insert a blank quote line when editing a nested list inside an outer blockquote (CRLF)', () => {
      const source = '> - parent\r\n>   - old\r\n>   - next\r\n> - sibling\r\n';
      const document = parseMarkdown(source);
      const outer = document.root.children[0];

      expect(outer?.type).toBe('blockquote');
      if (outer?.type === 'blockquote') {
        const list = outer.children[0];
        expect(list?.type).toBe('list');
        if (list?.type === 'list') {
          const nestedList = list.items[0]?.children.find((child) => child.type === 'list');
          expect(nestedList?.type).toBe('list');
          if (nestedList?.type === 'list') {
            const text = nestedList.items[0]?.children.find((child) => child.type === 'text');
            expect(text?.type).toBe('text');
            if (text?.type === 'text') {
              text.value = 'NEW';
              markDirty(text);
            }
          }
        }
      }

      const serialized = serializeMarkdown(document);
      expect(serialized).toBe('> - parent\r\n>   - NEW\r\n>   - next\r\n> - sibling\r\n');

      const reparsed = parseMarkdown(serialized);
      expect(reparsed.root.children).toHaveLength(1);
      const reparsedOuter = reparsed.root.children[0];
      expect(reparsedOuter?.type).toBe('blockquote');
      if (reparsedOuter?.type === 'blockquote') {
        expect(reparsedOuter.children).toHaveLength(1);
        const reparsedList = reparsedOuter.children[0];
        expect(reparsedList?.type).toBe('list');
        if (reparsedList?.type === 'list') {
          expect(reparsedList.items).toHaveLength(2);
        }
      }
    });

    it('preserves the closing fence when editing fenced code with tildes and CRLF inside blockquote and list', () => {
      const source = '> - parent\r\n>   ~~~ts\r\n>   old\r\n>   next\r\n>   ~~~\r\n> - sibling\r\n';
      const document = parseMarkdown(source);
      const outer = document.root.children[0];

      expect(outer?.type).toBe('blockquote');
      if (outer?.type === 'blockquote') {
        const list = outer.children[0];
        expect(list?.type).toBe('list');
        if (list?.type === 'list') {
          const code = list.items[0]?.children.find((child) => child.type === 'code-block');
          expect(code?.type).toBe('code-block');
          if (code?.type === 'code-block') {
            code.value = 'NEW\r\nnext';
            markDirty(code);
          }
        }
      }

      const serialized = serializeMarkdown(document);
      expect(serialized).toBe('> - parent\r\n>   ~~~ts\r\n>   NEW\r\n>   next\r\n>   ~~~\r\n> - sibling\r\n');

      const reparsed = parseMarkdown(serialized);
      const reparsedOuter = reparsed.root.children[0];
      expect(reparsedOuter?.type).toBe('blockquote');
      if (reparsedOuter?.type === 'blockquote') {
        const reparsedList = reparsedOuter.children[0];
        expect(reparsedList?.type).toBe('list');
        if (reparsedList?.type === 'list') {
          expect(reparsedList.items[0]?.children.some((child) => child.type === 'code-block')).toBe(true);
          expect(reparsedList.items[1]?.children.some((child) => child.type === 'text')).toBe(true);
        }
      }
    });

    it('keeps nested blockquote structure during force reconstruction (CRLF)', () => {
      const source = '- parent\r\n  > old\r\n  > next\r\n- sibling\r\n';
      const document = parseMarkdown(source);

      const reconstructed = serializeMarkdown(document, { forceReconstruct: true });
      expect(reconstructed).toBe('- parent\r\n  > old\r\n  > next\r\n- sibling');

      const reparsed = parseMarkdown(reconstructed);
      expect(reparsed.root.children).toHaveLength(1);
      const list = reparsed.root.children[0];
      expect(list?.type).toBe('list');
      if (list?.type === 'list') {
        expect(list.items).toHaveLength(2);
        expect(list.items[0]?.children.some((child) => child.type === 'blockquote')).toBe(true);
      }
    });

    it('preserves trailing newline for dirty list item when source has LF newline', () => {
      const source = '- old\n';
      const document = parseMarkdown(source);
      const list = document.root.children[0];
      assertNodeType(list, 'list');
      const text = list.items[0]?.children[0];
      assertNodeType(text, 'text');
      text.value = 'NEW';
      markDirty(text);
      expect(serializeMarkdown(document)).toBe('- NEW\n');
    });

    it('preserves trailing newline for dirty list item when source has CRLF newline', () => {
      const source = '- old\r\n';
      const document = parseMarkdown(source);
      const list = document.root.children[0];
      assertNodeType(list, 'list');
      const text = list.items[0]?.children[0];
      assertNodeType(text, 'text');
      text.value = 'NEW';
      markDirty(text);
      expect(serializeMarkdown(document)).toBe('- NEW\r\n');
    });

    it('preserves line break between dirty list item and subsequent sibling', () => {
      const source = '- old\n- next\n';
      const document = parseMarkdown(source);
      const list = document.root.children[0];
      assertNodeType(list, 'list');
      const text = list.items[0]?.children[0];
      assertNodeType(text, 'text');
      text.value = 'NEW';
      markDirty(text);
      expect(serializeMarkdown(document)).toBe('- NEW\n- next\n');
    });
  });

  describe('P1-04A Subsequent Regression Tests: Nested Lists, Block-level HTML, and CRLF Blockquotes', () => {
    it('preserves 3-level unordered nested list structure during force reconstruction', () => {
      const source = '- a\n  - b\n    - c\n';
      const doc = parseMarkdown(source);
      const reconstructed = serializeMarkdown(doc, { forceReconstruct: true });
      expect(reconstructed).toBe('- a\n  - b\n    - c');

      const reparsed = parseMarkdown(reconstructed);
      expect(reparsed.root.children).toHaveLength(1);
      const list0 = reparsed.root.children[0];
      assertNodeType(list0, 'list');
      expect(list0.items).toHaveLength(1);

      const list1 = list0.items[0]?.children.find((c) => c.type === 'list');
      assertNodeType(list1, 'list');
      expect(list1.items).toHaveLength(1);

      const list2 = list1.items[0]?.children.find((c) => c.type === 'list');
      assertNodeType(list2, 'list');
      expect(list2.items).toHaveLength(1);
      const cText = list2.items[0]?.children.find((c) => c.type === 'text');
      assertNodeType(cText, 'text');
      expect(cText.value).toBe('c');
    });

    it('preserves 3-level ordered nested list structure during force reconstruction', () => {
      const source = '1. a\n   1. b\n      1. c\n';
      const doc = parseMarkdown(source);
      const reconstructed = serializeMarkdown(doc, { forceReconstruct: true });
      const reparsed = parseMarkdown(reconstructed);
      expect(reparsed.root.children).toHaveLength(1);
      const list0 = reparsed.root.children[0];
      assertNodeType(list0, 'list');
      expect(list0.ordered).toBe(true);

      const list1 = list0.items[0]?.children.find((c) => c.type === 'list');
      assertNodeType(list1, 'list');
      expect(list1.ordered).toBe(true);

      const list2 = list1.items[0]?.children.find((c) => c.type === 'list');
      assertNodeType(list2, 'list');
      expect(list2.ordered).toBe(true);
      const cText = list2.items[0]?.children.find((c) => c.type === 'text');
      assertNodeType(cText, 'text');
      expect(cText.value).toBe('c');
    });

    it('preserves 3-level task list structure during force reconstruction', () => {
      const source = '- [ ] a\n  - [ ] b\n    - [x] c\n';
      const doc = parseMarkdown(source);
      const reconstructed = serializeMarkdown(doc, { forceReconstruct: true });
      const reparsed = parseMarkdown(reconstructed);
      expect(reparsed.root.children).toHaveLength(1);
      const list0 = reparsed.root.children[0];
      assertNodeType(list0, 'list');
      expect(list0.items[0]?.task).toBe(true);

      const list1 = list0.items[0]?.children.find((c) => c.type === 'list');
      assertNodeType(list1, 'list');
      expect(list1.items[0]?.task).toBe(true);

      const list2 = list1.items[0]?.children.find((c) => c.type === 'list');
      assertNodeType(list2, 'list');
      expect(list2.items[0]?.task).toBe(true);
      expect(list2.items[0]?.checked).toBe(true);
    });

    it('preserves 3-level mixed list structure during force reconstruction', () => {
      const source = '1. a\n   - b\n     1. c\n';
      const doc = parseMarkdown(source);
      const reconstructed = serializeMarkdown(doc, { forceReconstruct: true });
      const reparsed = parseMarkdown(reconstructed);
      expect(reparsed.root.children).toHaveLength(1);
      const list0 = reparsed.root.children[0];
      assertNodeType(list0, 'list');
      expect(list0.ordered).toBe(true);

      const list1 = list0.items[0]?.children.find((c) => c.type === 'list');
      assertNodeType(list1, 'list');
      expect(list1.ordered).toBe(false);

      const list2 = list1.items[0]?.children.find((c) => c.type === 'list');
      assertNodeType(list2, 'list');
      expect(list2.ordered).toBe(true);
    });

    it('preserves 3-level list with siblings at each level during force reconstruction', () => {
      const source = '- a1\n  - b1\n    - c1\n    - c2\n  - b2\n- a2\n';
      const doc = parseMarkdown(source);
      const reconstructed = serializeMarkdown(doc, { forceReconstruct: true });
      expect(reconstructed).toBe('- a1\n  - b1\n    - c1\n    - c2\n  - b2\n- a2');
      const reparsed = parseMarkdown(reconstructed);
      expect(reparsed.root.children).toHaveLength(1);
      const list0 = reparsed.root.children[0];
      assertNodeType(list0, 'list');
      expect(list0.items).toHaveLength(2);

      const bList = list0.items[0]?.children.find((c) => c.type === 'list');
      assertNodeType(bList, 'list');
      expect(bList.items).toHaveLength(2);

      const cList = bList.items[0]?.children.find((c) => c.type === 'list');
      assertNodeType(cList, 'list');
      expect(cList.items).toHaveLength(2);
    });

    it('preserves 3-level list with code-block and blockquote under force reconstruction', () => {
      const source = '- a\n  ```ts\n  const x = 1;\n  ```\n  - b\n    > quoted\n    - c\n';
      const doc = parseMarkdown(source);
      const reconstructed = serializeMarkdown(doc, { forceReconstruct: true });
      const reparsed = parseMarkdown(reconstructed);
      expect(reparsed.root.children).toHaveLength(1);
      const list0 = reparsed.root.children[0];
      assertNodeType(list0, 'list');
      expect(list0.items[0]?.children.some((c) => c.type === 'code-block')).toBe(true);
      const bList = list0.items[0]?.children.find((c) => c.type === 'list');
      assertNodeType(bList, 'list');
      expect(bList.items[0]?.children.some((c) => c.type === 'blockquote')).toBe(true);
      const cList = bList.items[0]?.children.find((c) => c.type === 'list');
      assertNodeType(cList, 'list');
    });

    it('preserves 3-level nested list structure during force reconstruction (CRLF)', () => {
      const source = '- a\r\n  - b\r\n    - c\r\n';
      const doc = parseMarkdown(source);
      const reconstructed = serializeMarkdown(doc, { forceReconstruct: true });
      expect(reconstructed).toBe('- a\r\n  - b\r\n    - c');
      const reparsed = parseMarkdown(reconstructed);
      expect(reparsed.root.children).toHaveLength(1);
      const list0 = reparsed.root.children[0];
      assertNodeType(list0, 'list');
      const list1 = list0.items[0]?.children.find((c) => c.type === 'list');
      assertNodeType(list1, 'list');
      const list2 = list1.items[0]?.children.find((c) => c.type === 'list');
      assertNodeType(list2, 'list');
    });

    it('preserves block-level HTML inside list item when modifying item text', () => {
      const source = '- item\n  <div>html</div>\n';
      const doc = parseMarkdown(source);
      const list = doc.root.children[0];
      assertNodeType(list, 'list');
      const item = list.items[0];
      expect(item).toBeDefined();
      const text = item?.children.find((c) => c.type === 'text');
      assertNodeType(text, 'text');
      text.value = 'item updated';
      markDirty(text);

      const serialized = serializeMarkdown(doc);
      expect(serialized).toBe('- item updated\n  <div>html</div>\n');
    });

    it('preserves comment and hr inside list item when modifying item text', () => {
      const source = '- item\n  <!-- comment -->\n  ---\n';
      const doc = parseMarkdown(source);
      const list = doc.root.children[0];
      assertNodeType(list, 'list');
      const item = list.items[0];
      expect(item).toBeDefined();
      const text = item?.children.find((c) => c.type === 'text');
      assertNodeType(text, 'text');
      text.value = 'item updated';
      markDirty(text);

      const serialized = serializeMarkdown(doc);
      expect(serialized).toBe('- item updated\n  <!-- comment -->\n  ---\n');
    });

    it('preserves block-level HTML inside list item with CRLF when modifying item text', () => {
      const source = '- item\r\n  <div>html</div>\r\n';
      const doc = parseMarkdown(source);
      const list = doc.root.children[0];
      assertNodeType(list, 'list');
      const item = list.items[0];
      expect(item).toBeDefined();
      const text = item?.children.find((c) => c.type === 'text');
      assertNodeType(text, 'text');
      text.value = 'item updated';
      markDirty(text);

      const serialized = serializeMarkdown(doc);
      expect(serialized).toBe('- item updated\r\n  <div>html</div>\r\n');
    });

    it('preserves CRLF and trailing newline during top-level blockquote force reconstruction', () => {
      const source = '> first\r\n> second\r\n';
      const doc = parseMarkdown(source);
      const reconstructed = serializeMarkdown(doc, { forceReconstruct: true });
      expect(reconstructed).toBe('> first\r\n> second\r\n');
    });

    it('preserves lack of trailing newline during top-level blockquote force reconstruction', () => {
      const source = '> first\r\n> second';
      const doc = parseMarkdown(source);
      const reconstructed = serializeMarkdown(doc, { forceReconstruct: true });
      expect(reconstructed).toBe('> first\r\n> second');
    });
  });

  describe('P1-04A Follow-up Review Regression Tests: Inline HTML, Multiple Block Siblings, Hard Breaks, Mixed CRLF', () => {
    it('does not treat inline HTML inside a list item as a block node during force reconstruction', () => {
      const source = '- item <span>html</span>\n';
      const doc = parseMarkdown(source);
      const reconstructed = serializeMarkdown(doc, { forceReconstruct: true });
      expect(reconstructed).toBe('- item <span>html</span>');

      const reparsed = parseMarkdown(reconstructed);
      expect(reparsed.root.children).toHaveLength(1);
      const list = reparsed.root.children[0];
      assertNodeType(list, 'list');
      const item = list.items[0];
      expect(item).toBeDefined();
      expect(item?.children.some((c) => c.type === 'blockquote' || c.type === 'code-block' || c.type === 'list')).toBe(false);
    });

    it('preserves blank line separation between multiple blockquote siblings inside a list item during force reconstruction', () => {
      const source = '- item\n  > first\n\n  > second\n- next\n';
      const doc = parseMarkdown(source);
      const reconstructed = serializeMarkdown(doc, { forceReconstruct: true });
      expect(reconstructed).toBe('- item\n  > first\n\n  > second\n- next');

      const reparsed = parseMarkdown(reconstructed);
      expect(reparsed.root.children).toHaveLength(1);
      const list = reparsed.root.children[0];
      assertNodeType(list, 'list');
      expect(list.items).toHaveLength(2);
      const item0 = list.items[0];
      expect(item0).toBeDefined();
      expect(item0?.children.filter((node) => node.type === 'blockquote')).toHaveLength(2);
    });

    it('preserves Markdown hard line break (trailing two spaces) during list force reconstruction', () => {
      const source = '- hard  \n';
      const doc = parseMarkdown(source);
      const reconstructed = serializeMarkdown(doc, { forceReconstruct: true });
      expect(reconstructed).toBe('- hard  ');
    });

    it('preserves mixed LF and CRLF line breaks per line during blockquote force reconstruction', () => {
      const source = '> first\r\n> second\n> third\r\n';
      const doc = parseMarkdown(source);
      const reconstructed = serializeMarkdown(doc, { forceReconstruct: true });
      expect(reconstructed).toBe('> first\r\n> second\n> third\r\n');
    });
  });
});

function assertNodeType<T extends MarkdownNode['type']>(
  node: MarkdownNode | undefined | null,
  expectedType: T
): asserts node is Extract<MarkdownNode, { type: T }> {
  expect(node).toBeDefined();
  expect(node?.type).toBe(expectedType);
  if (!node || node.type !== expectedType) {
    throw new Error(`Expected node type '${expectedType}', but got '${node?.type}'`);
  }
}
