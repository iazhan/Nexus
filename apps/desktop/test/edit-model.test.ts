import { describe, it, expect } from 'vitest';
import { parseMarkdown, serializeMarkdown, type MarkdownBlockNode } from '@nexus/markdown';
import {
  serializeEditableInlineContent,
  buildHeadingReplacement,
  buildParagraphReplacement,
  buildBlockReplacement,
  updateSourceWithBlock,
  getBlockNodeKey,
  type MinimalDomNode
} from '../renderer/src/wysiwyg/edit-model.js';

// Helper to create mock DOM text nodes
function createMockTextNode(text: string): MinimalDomNode {
  return {
    nodeType: 3, // Node.TEXT_NODE
    nodeName: '#text',
    textContent: text,
    childNodes: [],
    getAttribute: () => null
  };
}

// Helper to create mock DOM element nodes
function createMockElementNode(
  tagName: string,
  attrs: Record<string, string> = {},
  children: MinimalDomNode[] = []
): MinimalDomNode {
  return {
    nodeType: 1, // Node.ELEMENT_NODE
    nodeName: tagName.toUpperCase(),
    textContent: children.map((c) => c.textContent).join(''),
    childNodes: children,
    getAttribute: (name: string) => attrs[name] ?? null
  };
}

describe('Edit Model - Inline Content Serialization', () => {
  it('serializes plain text nodes directly', () => {
    const root = createMockElementNode('P', {}, [
      createMockTextNode('Hello world, simple plain text.')
    ]);
    expect(serializeEditableInlineContent(root)).toBe('Hello world, simple plain text.');
  });

  it('serializes strong / bold tags preserving ** or __ delimiter style', () => {
    const rootAsterisk = createMockElementNode('P', {}, [
      createMockTextNode('Prefix '),
      createMockElementNode('STRONG', { 'data-node-type': 'bold', 'data-delim': '**' }, [
        createMockTextNode('bold content')
      ]),
      createMockTextNode(' suffix')
    ]);
    expect(serializeEditableInlineContent(rootAsterisk)).toBe('Prefix **bold content** suffix');

    const rootUnderscore = createMockElementNode('P', {}, [
      createMockElementNode('STRONG', { 'data-node-type': 'bold', 'data-delim': '__' }, [
        createMockTextNode('underscore bold')
      ])
    ]);
    expect(serializeEditableInlineContent(rootUnderscore)).toBe('__underscore bold__');
  });

  it('serializes em / italic tags preserving * or _ delimiter style', () => {
    const rootAsterisk = createMockElementNode('P', {}, [
      createMockElementNode('EM', { 'data-node-type': 'italic', 'data-delim': '*' }, [
        createMockTextNode('italic content')
      ])
    ]);
    expect(serializeEditableInlineContent(rootAsterisk)).toBe('*italic content*');

    const rootUnderscore = createMockElementNode('P', {}, [
      createMockElementNode('EM', { 'data-node-type': 'italic', 'data-delim': '_' }, [
        createMockTextNode('underscore italic')
      ])
    ]);
    expect(serializeEditableInlineContent(rootUnderscore)).toBe('_underscore italic_');
  });

  it('serializes code / inline-code tags with proper backtick delimiters and padding', () => {
    const rootSimple = createMockElementNode('P', {}, [
      createMockElementNode('CODE', { 'data-node-type': 'inline-code' }, [
        createMockTextNode('const x = 42;')
      ])
    ]);
    expect(serializeEditableInlineContent(rootSimple)).toBe('`const x = 42;`');

    // With internal backticks requiring multiple delimiter backticks
    const rootBacktick = createMockElementNode('P', {}, [
      createMockElementNode('CODE', { 'data-node-type': 'inline-code' }, [
        createMockTextNode('foo `bar` baz')
      ])
    ]);
    expect(serializeEditableInlineContent(rootBacktick)).toBe('``foo `bar` baz``');

    // Leading / trailing spaces require padding
    const rootPadded = createMockElementNode('P', {}, [
      createMockElementNode('CODE', { 'data-node-type': 'inline-code' }, [
        createMockTextNode('`padded`')
      ])
    ]);
    expect(serializeEditableInlineContent(rootPadded)).toBe('`` `padded` ``');
  });

  it('preserves non-editable inline-math verbatim via data-raw without parsing inner text', () => {
    const root = createMockElementNode('P', {}, [
      createMockTextNode('The formula is '),
      createMockElementNode(
        'SPAN',
        {
          'data-node-type': 'inline-math',
          'data-raw': '$E = mc^2$',
          contenteditable: 'false'
        },
        [
          createMockElementNode('SPAN', { class: 'math-delim' }, [createMockTextNode('$')]),
          createMockElementNode('SPAN', { class: 'math-body' }, [createMockTextNode('E = mc^2')]),
          createMockElementNode('SPAN', { class: 'math-delim' }, [createMockTextNode('$')])
        ]
      ),
      createMockTextNode(' in physics.')
    ]);
    expect(serializeEditableInlineContent(root)).toBe('The formula is $E = mc^2$ in physics.');
  });

  it('preserves non-editable wikilink verbatim via data-raw', () => {
    const root = createMockElementNode('P', {}, [
      createMockTextNode('Refer to '),
      createMockElementNode(
        'SPAN',
        {
          'data-node-type': 'wikilink',
          'data-raw': '[[Architecture|Arch Doc]]',
          contenteditable: 'false'
        },
        [createMockTextNode('Arch Doc')]
      ),
      createMockTextNode(' for details.')
    ]);
    expect(serializeEditableInlineContent(root)).toBe('Refer to [[Architecture|Arch Doc]] for details.');
  });

  it('preserves non-editable raw HTML and comments verbatim via data-raw', () => {
    const root = createMockElementNode('P', {}, [
      createMockTextNode('Before '),
      createMockElementNode('SPAN', {
        'data-node-type': 'raw',
        'data-raw': '<!-- comment -->',
        contenteditable: 'false'
      }),
      createMockTextNode(' and '),
      createMockElementNode('SPAN', {
        'data-node-type': 'raw',
        'data-raw': '<span style="color:red">alert</span>',
        contenteditable: 'false'
      }),
      createMockTextNode(' after.')
    ]);
    expect(serializeEditableInlineContent(root)).toBe(
      'Before <!-- comment --> and <span style="color:red">alert</span> after.'
    );
  });

  it('sanitizes unrecognized elements as safe plain text and never injects dangerous HTML', () => {
    const root = createMockElementNode('P', {}, [
      createMockTextNode('Normal '),
      createMockElementNode('SCRIPT', {}, [createMockTextNode('alert("xss")')]),
      createMockTextNode(' text')
    ]);
    const serialized = serializeEditableInlineContent(root);
    expect(serialized).not.toContain('<script>');
    expect(serialized).toContain('alert("xss")');
  });
});

describe('Edit Model - SourceRange Partial Update & Formatting', () => {
  it('updates paragraph and preserves trailing LF newline', () => {
    const source = 'First paragraph.\n\nSecond paragraph.\n';
    const parsed = parseMarkdown(source);
    expect(parsed.root.children).toHaveLength(2);

    const firstP = parsed.root.children[0]!;
    expect(firstP.type).toBe('paragraph');

    const replacement = buildParagraphReplacement(firstP.raw, 'Modified first paragraph.');
    const nextSource = updateSourceWithBlock(source, firstP.range, replacement);

    expect(nextSource).toBe('Modified first paragraph.\n\nSecond paragraph.\n');

    const reParsed = parseMarkdown(nextSource);
    expect(reParsed.root.children).toHaveLength(2);
    expect(reParsed.root.children[0]!.type).toBe('paragraph');
    expect(reParsed.root.children[1]!.type).toBe('paragraph');
    expect(serializeMarkdown(reParsed)).toBe(nextSource);
  });

  it('preserves CRLF line endings when modifying paragraph and heading', () => {
    const source = '# Heading Title\r\n\r\nParagraph text.\r\n';
    const parsed = parseMarkdown(source);
    expect(parsed.root.children).toHaveLength(2);

    const heading = parsed.root.children[0]!;
    expect(heading.type).toBe('heading');
    if (heading.type === 'heading') {
      const headingRep = buildHeadingReplacement(heading.raw, heading.depth, 'New Title');
      const step1Source = updateSourceWithBlock(source, heading.range, headingRep);
      expect(step1Source).toBe('# New Title\r\n\r\nParagraph text.\r\n');
      expect(step1Source).toContain('\r\n');
      expect(step1Source).not.toMatch(/[^\r]\n/);
    }
  });

  it('preserves heading level, leading indentation, and closing # markers', () => {
    const source = '  ### Deep Heading ###\n';
    const parsed = parseMarkdown(source);
    const heading = parsed.root.children[0]!;
    expect(heading.type).toBe('heading');
    if (heading.type === 'heading') {
      const rep = buildHeadingReplacement(heading.raw, heading.depth, 'Renamed Heading');
      const nextSource = updateSourceWithBlock(source, heading.range, rep);
      expect(nextSource).toBe('  ### Renamed Heading ###\n');
    }
  });

  it('only modifies target range when two paragraphs have identical text', () => {
    const source = 'Duplicate text.\n\nDuplicate text.\n';
    const parsed = parseMarkdown(source);
    expect(parsed.root.children).toHaveLength(2);

    const p1 = parsed.root.children[0]!;
    const p2 = parsed.root.children[1]!;
    expect(p1.raw.trim()).toBe('Duplicate text.');
    expect(p2.raw.trim()).toBe('Duplicate text.');
    expect(p1.range.from).toBe(0);
    expect(p2.range.from).toBe(17);

    // Modify ONLY p2
    const rep2 = buildParagraphReplacement(p2.raw, 'Updated duplicate.');
    const nextSource = updateSourceWithBlock(source, p2.range, rep2);

    expect(nextSource).toBe('Duplicate text.\n\nUpdated duplicate.\n');

    // Modify ONLY p1
    const rep1 = buildParagraphReplacement(p1.raw, 'Updated first duplicate.');
    const nextSourceP1 = updateSourceWithBlock(source, p1.range, rep1);

    expect(nextSourceP1).toBe('Updated first duplicate.\n\nDuplicate text.\n');
  });

  it('preserves blank lines between paragraphs without losing spacing', () => {
    const source = 'Paragraph A.\n\n\n\nParagraph B.\n';
    const parsed = parseMarkdown(source);
    expect(parsed.root.children).toHaveLength(2);

    const pA = parsed.root.children[0]!;
    const repA = buildParagraphReplacement(pA.raw, 'Edited A.');
    const nextSource = updateSourceWithBlock(source, pA.range, repA);

    expect(nextSource).toBe('Edited A.\n\n\n\nParagraph B.\n');
  });

  it('preserves CJK and multi-byte emojis without UTF-16 offset drift', () => {
    const source = '# 欢迎 👨‍👩‍👧‍👦\n\n这里是测试中文段落 🚀。\n\n尾部段落。\n';
    const parsed = parseMarkdown(source);
    expect(parsed.root.children).toHaveLength(3);

    const cjkP = parsed.root.children[1]!;
    expect(cjkP.type).toBe('paragraph');

    const rep = buildParagraphReplacement(cjkP.raw, '中文修改成功 🎉✨');
    const nextSource = updateSourceWithBlock(source, cjkP.range, rep);

    expect(nextSource).toBe('# 欢迎 👨‍👩‍👧‍👦\n\n中文修改成功 🎉✨\n\n尾部段落。\n');

    const reParsed = parseMarkdown(nextSource);
    expect(reParsed.root.children).toHaveLength(3);
    expect(reParsed.root.children[0]!.type).toBe('heading');
    expect(reParsed.root.children[1]!.type).toBe('paragraph');
    expect(reParsed.root.children[2]!.type).toBe('paragraph');
    expect(reParsed.root.children[2]!.raw.trim()).toBe('尾部段落。');
    expect(serializeMarkdown(reParsed)).toBe(nextSource);
  });

  it('preserves escaped character backslash semantics', () => {
    const source = 'Paragraph with \\*escaped\\* asterisk.\n';
    const parsed = parseMarkdown(source);
    const p = parsed.root.children[0]!;
    expect(p.type).toBe('paragraph');

    const rep = buildParagraphReplacement(p.raw, 'Updated with \\*escaped\\* star.');
    const nextSource = updateSourceWithBlock(source, p.range, rep);
    expect(nextSource).toBe('Updated with \\*escaped\\* star.\n');

    const reParsed = parseMarkdown(nextSource);
    expect(reParsed.diagnostics).toHaveLength(0);
    expect(serializeMarkdown(reParsed)).toBe(nextSource);
  });

  it('generates stable unique node keys using type:from:to', () => {
    const node: MarkdownBlockNode = {
      type: 'paragraph',
      range: { from: 10, to: 45 },
      raw: 'Some paragraph text',
      children: []
    };
    expect(getBlockNodeKey(node)).toBe('paragraph:10:45');
  });

  it('buildBlockReplacement dispatches correctly for heading and paragraph', () => {
    const headingNode: MarkdownBlockNode = {
      type: 'heading',
      depth: 2,
      range: { from: 0, to: 10 },
      raw: '## Title\n',
      children: []
    };
    expect(buildBlockReplacement(headingNode, 'New Title')).toBe('## New Title\n');

    const paragraphNode: MarkdownBlockNode = {
      type: 'paragraph',
      range: { from: 0, to: 11 },
      raw: 'Paragraph\n',
      children: []
    };
    expect(buildBlockReplacement(paragraphNode, 'New Para')).toBe('New Para\n');
  });

  describe('Inline Marks Round-Trip & AST Structure Invariants', () => {
    it('modifying bold text within paragraph retains bold AST and unedited siblings', () => {
      const source = '# Heading\n\nNormal **bold text** end.\n\nTrailing paragraph.';
      const parsed = parseMarkdown(source);
      expect(parsed.root.children).toHaveLength(3);

      const targetP = parsed.root.children[1]!;
      expect(targetP.type).toBe('paragraph');

      // Simulate DOM representation with modified bold text
      const mockDom = createMockElementNode('P', {}, [
        createMockTextNode('Normal '),
        createMockElementNode('STRONG', { 'data-node-type': 'bold', 'data-delim': '**' }, [
          createMockTextNode('super bold text')
        ]),
        createMockTextNode(' end.')
      ]);

      const newInlines = serializeEditableInlineContent(mockDom);
      const replacement = buildParagraphReplacement(targetP.raw, newInlines);
      const nextSource = updateSourceWithBlock(source, targetP.range, replacement);

      expect(nextSource).toBe('# Heading\n\nNormal **super bold text** end.\n\nTrailing paragraph.');

      const nextParsed = parseMarkdown(nextSource);
      // Assertions required by spec:
      expect(nextParsed.root.children).toHaveLength(3);
      expect(nextParsed.root.children[0]!.type).toBe('heading');
      expect(nextParsed.root.children[1]!.type).toBe('paragraph');
      expect(nextParsed.root.children[2]!.type).toBe('paragraph');

      const updatedP = nextParsed.root.children[1]!;
      if (updatedP.type === 'paragraph') {
        expect(updatedP.children).toHaveLength(3);
        expect(updatedP.children[0]!.type).toBe('text');
        expect(updatedP.children[1]!.type).toBe('bold');
        if (updatedP.children[1]!.type === 'bold') {
          expect(updatedP.children[1]!.children[0]!.type).toBe('text');
          if (updatedP.children[1]!.children[0]!.type === 'text') {
            expect(updatedP.children[1]!.children[0]!.value).toBe('super bold text');
          }
        }
        expect(updatedP.children[2]!.type).toBe('text');
      }

      expect(nextParsed.root.children[0]!.raw).toBe(parsed.root.children[0]!.raw);
      expect(nextParsed.root.children[2]!.raw).toBe(parsed.root.children[2]!.raw);
      expect(serializeMarkdown(nextParsed)).toBe(nextSource);
    });

    it('modifying italic text within paragraph retains italic AST and unedited siblings', () => {
      const source = 'First line.\n\nSome *italic text* here.\n\nLast line.';
      const parsed = parseMarkdown(source);
      expect(parsed.root.children).toHaveLength(3);

      const targetP = parsed.root.children[1]!;
      expect(targetP.type).toBe('paragraph');

      const mockDom = createMockElementNode('P', {}, [
        createMockTextNode('Some '),
        createMockElementNode('EM', { 'data-node-type': 'italic', 'data-delim': '*' }, [
          createMockTextNode('modified italic')
        ]),
        createMockTextNode(' here.')
      ]);

      const newInlines = serializeEditableInlineContent(mockDom);
      const replacement = buildParagraphReplacement(targetP.raw, newInlines);
      const nextSource = updateSourceWithBlock(source, targetP.range, replacement);

      expect(nextSource).toBe('First line.\n\nSome *modified italic* here.\n\nLast line.');

      const nextParsed = parseMarkdown(nextSource);
      expect(nextParsed.root.children).toHaveLength(3);
      expect(nextParsed.root.children[1]!.type).toBe('paragraph');

      const updatedP = nextParsed.root.children[1]!;
      if (updatedP.type === 'paragraph') {
        expect(updatedP.children).toHaveLength(3);
        expect(updatedP.children[1]!.type).toBe('italic');
        if (updatedP.children[1]!.type === 'italic') {
          expect(updatedP.children[1]!.children[0]!.type).toBe('text');
          if (updatedP.children[1]!.children[0]!.type === 'text') {
            expect(updatedP.children[1]!.children[0]!.value).toBe('modified italic');
          }
        }
      }

      expect(nextParsed.root.children[0]!.raw).toBe(parsed.root.children[0]!.raw);
      expect(nextParsed.root.children[2]!.raw).toBe(parsed.root.children[2]!.raw);
      expect(serializeMarkdown(nextParsed)).toBe(nextSource);
    });

    it('modifying inline-code text retains valid code span AST', () => {
      const source = 'Check `npm test` command.\n\nNext line.';
      const parsed = parseMarkdown(source);
      const targetP = parsed.root.children[0]!;
      expect(targetP.type).toBe('paragraph');

      const mockDom = createMockElementNode('P', {}, [
        createMockTextNode('Check '),
        createMockElementNode('CODE', { 'data-node-type': 'inline-code' }, [
          createMockTextNode('pnpm run build')
        ]),
        createMockTextNode(' command.')
      ]);

      const newInlines = serializeEditableInlineContent(mockDom);
      const replacement = buildParagraphReplacement(targetP.raw, newInlines);
      const nextSource = updateSourceWithBlock(source, targetP.range, replacement);

      expect(nextSource).toBe('Check `pnpm run build` command.\n\nNext line.');

      const nextParsed = parseMarkdown(nextSource);
      expect(nextParsed.root.children).toHaveLength(2);
      const updatedP = nextParsed.root.children[0]!;
      expect(updatedP.type).toBe('paragraph');
      if (updatedP.type === 'paragraph') {
        expect(updatedP.children[1]!.type).toBe('inline-code');
        if (updatedP.children[1]!.type === 'inline-code') {
          expect(updatedP.children[1]!.value).toBe('pnpm run build');
        }
      }
      expect(serializeMarkdown(nextParsed)).toBe(nextSource);
    });

    it('editing adjacent text preserves inline math $...$ in AST without corruption', () => {
      const source = 'Equation $E = mc^2$ is famous.\n\nFooter.';
      const parsed = parseMarkdown(source);
      const targetP = parsed.root.children[0]!;

      const mockDom = createMockElementNode('P', {}, [
        createMockTextNode('The formula '),
        createMockElementNode('SPAN', {
          'data-node-type': 'inline-math',
          'data-raw': '$E = mc^2$',
          contenteditable: 'false'
        }),
        createMockTextNode(' is universally known.')
      ]);

      const newInlines = serializeEditableInlineContent(mockDom);
      const replacement = buildParagraphReplacement(targetP.raw, newInlines);
      const nextSource = updateSourceWithBlock(source, targetP.range, replacement);

      expect(nextSource).toBe('The formula $E = mc^2$ is universally known.\n\nFooter.');

      const nextParsed = parseMarkdown(nextSource);
      expect(nextParsed.root.children).toHaveLength(2);
      const updatedP = nextParsed.root.children[0]!;
      expect(updatedP.type).toBe('paragraph');
      if (updatedP.type === 'paragraph') {
        expect(updatedP.children[1]!.type).toBe('inline-math');
        if (updatedP.children[1]!.type === 'inline-math') {
          expect(updatedP.children[1]!.formula).toBe('E = mc^2');
        }
      }
      expect(serializeMarkdown(nextParsed)).toBe(nextSource);
    });

    it('editing adjacent text preserves wikilink [[...]] in AST without corruption', () => {
      const source = 'See [[QuickStart|Guide]] for setup.\n';
      const parsed = parseMarkdown(source);
      const targetP = parsed.root.children[0]!;

      const mockDom = createMockElementNode('P', {}, [
        createMockTextNode('Please consult '),
        createMockElementNode('SPAN', {
          'data-node-type': 'wikilink',
          'data-raw': '[[QuickStart|Guide]]',
          contenteditable: 'false'
        }),
        createMockTextNode(' right now.')
      ]);

      const newInlines = serializeEditableInlineContent(mockDom);
      const replacement = buildParagraphReplacement(targetP.raw, newInlines);
      const nextSource = updateSourceWithBlock(source, targetP.range, replacement);

      expect(nextSource).toBe('Please consult [[QuickStart|Guide]] right now.\n');

      const nextParsed = parseMarkdown(nextSource);
      const updatedP = nextParsed.root.children[0]!;
      expect(updatedP.type).toBe('paragraph');
      if (updatedP.type === 'paragraph') {
        expect(updatedP.children[1]!.type).toBe('wikilink');
        if (updatedP.children[1]!.type === 'wikilink') {
          expect(updatedP.children[1]!.target).toBe('QuickStart');
          expect(updatedP.children[1]!.alias).toBe('Guide');
        }
      }
      expect(serializeMarkdown(nextParsed)).toBe(nextSource);
    });

    it('editing adjacent text preserves raw HTML in AST without corruption', () => {
      const source = 'Text with <!-- comment --> in middle.\n';
      const parsed = parseMarkdown(source);
      const targetP = parsed.root.children[0]!;

      const mockDom = createMockElementNode('P', {}, [
        createMockTextNode('Updated text with '),
        createMockElementNode('SPAN', {
          'data-node-type': 'raw',
          'data-raw': '<!-- comment -->',
          contenteditable: 'false'
        }),
        createMockTextNode(' preserved.')
      ]);

      const newInlines = serializeEditableInlineContent(mockDom);
      const replacement = buildParagraphReplacement(targetP.raw, newInlines);
      const nextSource = updateSourceWithBlock(source, targetP.range, replacement);

      expect(nextSource).toBe('Updated text with <!-- comment --> preserved.\n');

      const nextParsed = parseMarkdown(nextSource);
      const updatedP = nextParsed.root.children[0]!;
      expect(updatedP.type).toBe('paragraph');
      if (updatedP.type === 'paragraph') {
        expect(updatedP.children[1]!.type).toBe('raw');
      }
      expect(serializeMarkdown(nextParsed)).toBe(nextSource);
    });
  });

  describe('Important 1: Escaped Characters Round-Trip & AST Preservation', () => {
    it('preserves escaped asterisk without edit, preventing false italic mutation', () => {
      const source = 'Paragraph with \\*escaped\\* asterisk.\n';
      const parsed = parseMarkdown(source);
      const targetP = parsed.root.children[0]!;
      expect(targetP.type).toBe('paragraph');

      // DOM represents visible literal characters ('*') without backslashes
      const mockDom = createMockElementNode('P', {}, [
        createMockTextNode('Paragraph with '),
        createMockElementNode('SPAN', {
          'data-node-type': 'escaped',
          'data-raw': '\\*',
          'data-value': '*'
        }, [createMockTextNode('*')]),
        createMockTextNode('escaped'),
        createMockElementNode('SPAN', {
          'data-node-type': 'escaped',
          'data-raw': '\\*',
          'data-value': '*'
        }, [createMockTextNode('*')]),
        createMockTextNode(' asterisk.')
      ]);

      const newInlines = serializeEditableInlineContent(mockDom);
      const replacement = buildParagraphReplacement(targetP.raw, newInlines);
      const nextSource = updateSourceWithBlock(source, targetP.range, replacement);

      expect(nextSource).toBe(source);

      const reParsed = parseMarkdown(nextSource);
      expect(reParsed.root.children).toHaveLength(1);
      const p = reParsed.root.children[0]!;
      expect(p.type).toBe('paragraph');
      if (p.type === 'paragraph') {
        // Must be text nodes with escaped flag, NEVER italic
        expect(p.children.some((c) => c.type === 'italic')).toBe(false);
        const escNodes = p.children.filter((c) => c.type === 'text' && (c as { escaped?: boolean }).escaped);
        expect(escNodes).toHaveLength(2);
      }
    });

    it('preserves escaped characters inside bold and italic', () => {
      const source = 'Prefix **bold \\*escaped\\*** and *italic \\_escaped\\_*.\n';
      const parsed = parseMarkdown(source);
      const targetP = parsed.root.children[0]!;

      const mockDom = createMockElementNode('P', {}, [
        createMockTextNode('Prefix '),
        createMockElementNode('STRONG', { 'data-node-type': 'bold', 'data-delim': '**' }, [
          createMockTextNode('bold '),
          createMockElementNode('SPAN', {
            'data-node-type': 'escaped',
            'data-raw': '\\*',
            'data-value': '*'
          }, [createMockTextNode('*')]),
          createMockTextNode('escaped'),
          createMockElementNode('SPAN', {
            'data-node-type': 'escaped',
            'data-raw': '\\*',
            'data-value': '*'
          }, [createMockTextNode('*')])
        ]),
        createMockTextNode(' and '),
        createMockElementNode('EM', { 'data-node-type': 'italic', 'data-delim': '*' }, [
          createMockTextNode('italic '),
          createMockElementNode('SPAN', {
            'data-node-type': 'escaped',
            'data-raw': '\\_',
            'data-value': '_'
          }, [createMockTextNode('_')]),
          createMockTextNode('escaped'),
          createMockElementNode('SPAN', {
            'data-node-type': 'escaped',
            'data-raw': '\\_',
            'data-value': '_'
          }, [createMockTextNode('_')])
        ]),
        createMockTextNode('.')
      ]);

      const newInlines = serializeEditableInlineContent(mockDom);
      const replacement = buildParagraphReplacement(targetP.raw, newInlines);
      const nextSource = updateSourceWithBlock(source, targetP.range, replacement);

      expect(nextSource).toBe(source);
      const reParsed = parseMarkdown(nextSource);
      expect(serializeMarkdown(reParsed)).toBe(nextSource);
    });

    it('safely escapes user-modified punctuation in escaped span to prevent syntax corruption', () => {
      // If user edits text inside escaped node to another punctuation
      const mockDom = createMockElementNode('P', {}, [
        createMockTextNode('Prefix '),
        createMockElementNode('SPAN', {
          'data-node-type': 'escaped',
          'data-raw': '\\*',
          'data-value': '*'
        }, [createMockTextNode('_')]),
        createMockTextNode(' suffix')
      ]);

      const serialized = serializeEditableInlineContent(mockDom);
      expect(serialized).toBe('Prefix \\_ suffix');
    });
  });

  describe('Important 2: Inline-Code Delimiter Preservation & Upgrade', () => {
    it('preserves double-backtick delimiter without edit on blur (no-op)', () => {
      const source = 'Before ``old`` after.\n';
      const parsed = parseMarkdown(source);
      const targetP = parsed.root.children[0]!;

      const mockDom = createMockElementNode('P', {}, [
        createMockTextNode('Before '),
        createMockElementNode('CODE', {
          'data-node-type': 'inline-code',
          'data-raw': '``old``',
          'data-delim-len': '2',
          'data-had-padding': 'false',
          'data-value': 'old'
        }, [createMockTextNode('old')]),
        createMockTextNode(' after.')
      ]);

      const newInlines = serializeEditableInlineContent(mockDom);
      const replacement = buildParagraphReplacement(targetP.raw, newInlines);
      const nextSource = updateSourceWithBlock(source, targetP.range, replacement);

      expect(nextSource).toBe('Before ``old`` after.\n');
    });

    it('preserves double-backtick delimiter when code content is edited', () => {
      const source = 'Before ``old`` after.\n';
      const parsed = parseMarkdown(source);
      const targetP = parsed.root.children[0]!;

      const mockDom = createMockElementNode('P', {}, [
        createMockTextNode('Before '),
        createMockElementNode('CODE', {
          'data-node-type': 'inline-code',
          'data-raw': '``old``',
          'data-delim-len': '2',
          'data-had-padding': 'false',
          'data-value': 'old'
        }, [createMockTextNode('new')]),
        createMockTextNode(' after.')
      ]);

      const newInlines = serializeEditableInlineContent(mockDom);
      const replacement = buildParagraphReplacement(targetP.raw, newInlines);
      const nextSource = updateSourceWithBlock(source, targetP.range, replacement);

      expect(nextSource).toBe('Before ``new`` after.\n');

      const reParsed = parseMarkdown(nextSource);
      const p = reParsed.root.children[0]!;
      if (p.type === 'paragraph') {
        expect(p.children[1]!.type).toBe('inline-code');
        if (p.children[1]!.type === 'inline-code') {
          expect(p.children[1]!.value).toBe('new');
          expect(p.children[1]!.raw).toBe('``new``');
        }
      }
    });

    it('upgrades delimiter length when new content conflicts with delimiter length', () => {
      const source = 'Before ``old`` after.\n';
      const parsed = parseMarkdown(source);
      const targetP = parsed.root.children[0]!;

      // User enters content containing two consecutive backticks: "foo `` bar"
      const mockDom = createMockElementNode('P', {}, [
        createMockTextNode('Before '),
        createMockElementNode('CODE', {
          'data-node-type': 'inline-code',
          'data-raw': '``old``',
          'data-delim-len': '2',
          'data-had-padding': 'false',
          'data-value': 'old'
        }, [createMockTextNode('foo `` bar')]),
        createMockTextNode(' after.')
      ]);

      const newInlines = serializeEditableInlineContent(mockDom);
      const replacement = buildParagraphReplacement(targetP.raw, newInlines);
      const nextSource = updateSourceWithBlock(source, targetP.range, replacement);

      // Must upgrade to 3 backticks: ```foo `` bar```
      expect(nextSource).toBe('Before ```foo `` bar``` after.\n');

      const reParsed = parseMarkdown(nextSource);
      const p = reParsed.root.children[0]!;
      if (p.type === 'paragraph') {
        expect(p.children[1]!.type).toBe('inline-code');
        if (p.children[1]!.type === 'inline-code') {
          expect(p.children[1]!.value).toBe('foo `` bar');
          expect(p.children[1]!.raw).toBe('```foo `` bar```');
        }
      }
    });

    it('preserves code padding when original had space padding or when starts/ends with backtick', () => {
      const source = 'Code `` `inner` `` span.\n';
      const parsed = parseMarkdown(source);
      const targetP = parsed.root.children[0]!;

      const mockDom = createMockElementNode('P', {}, [
        createMockTextNode('Code '),
        createMockElementNode('CODE', {
          'data-node-type': 'inline-code',
          'data-raw': '`` `inner` ``',
          'data-delim-len': '2',
          'data-had-padding': 'true',
          'data-value': '`inner`'
        }, [createMockTextNode('`updated`')]),
        createMockTextNode(' span.')
      ]);

      const newInlines = serializeEditableInlineContent(mockDom);
      const replacement = buildParagraphReplacement(targetP.raw, newInlines);
      const nextSource = updateSourceWithBlock(source, targetP.range, replacement);

      expect(nextSource).toBe('Code `` `updated` `` span.\n');
    });

    it('preserves CRLF line endings when editing double-backtick code span', () => {
      const source = 'Before ``old`` after.\r\n';
      const parsed = parseMarkdown(source);
      const targetP = parsed.root.children[0]!;

      const mockDom = createMockElementNode('P', {}, [
        createMockTextNode('Before '),
        createMockElementNode('CODE', {
          'data-node-type': 'inline-code',
          'data-raw': '``old``',
          'data-delim-len': '2',
          'data-had-padding': 'false',
          'data-value': 'old'
        }, [createMockTextNode('new')]),
        createMockTextNode(' after.')
      ]);

      const newInlines = serializeEditableInlineContent(mockDom);
      const replacement = buildParagraphReplacement(targetP.raw, newInlines);
      const nextSource = updateSourceWithBlock(source, targetP.range, replacement);

      expect(nextSource).toBe('Before ``new`` after.\r\n');
      expect(nextSource).not.toMatch(/[^\r]\n/);
    });

    it('preserves CJK and Emoji offsets when editing code spans and escaped text', () => {
      const source = '测试 👨‍👩‍👧‍👦 ``原代码`` 与 \\*星号\\* 🚀\n';
      const parsed = parseMarkdown(source);
      const targetP = parsed.root.children[0]!;

      const mockDom = createMockElementNode('P', {}, [
        createMockTextNode('测试 👨‍👩‍👧‍👦 '),
        createMockElementNode('CODE', {
          'data-node-type': 'inline-code',
          'data-raw': '``原代码``',
          'data-delim-len': '2',
          'data-had-padding': 'false',
          'data-value': '原代码'
        }, [createMockTextNode('新代码')]),
        createMockTextNode(' 与 '),
        createMockElementNode('SPAN', {
          'data-node-type': 'escaped',
          'data-raw': '\\*',
          'data-value': '*'
        }, [createMockTextNode('*')]),
        createMockTextNode('星号'),
        createMockElementNode('SPAN', {
          'data-node-type': 'escaped',
          'data-raw': '\\*',
          'data-value': '*'
        }, [createMockTextNode('*')]),
        createMockTextNode(' 🚀')
      ]);

      const newInlines = serializeEditableInlineContent(mockDom);
      const replacement = buildParagraphReplacement(targetP.raw, newInlines);
      const nextSource = updateSourceWithBlock(source, targetP.range, replacement);

      expect(nextSource).toBe('测试 👨‍👩‍👧‍👦 ``新代码`` 与 \\*星号\\* 🚀\n');

      const reParsed = parseMarkdown(nextSource);
      expect(reParsed.root.children).toHaveLength(1);
      expect(serializeMarkdown(reParsed)).toBe(nextSource);
    });
  });
});
