import { assert, describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/parser.js';
import { markDirty, serializeMarkdown } from '../src/serializer.js';

/**
 * P1-04R 的 Markdown 领域契约测试。
 *
 * 这些测试先固定 parser/serializer 的节点语义，再由 editor 层负责投影和交互。
 * 不允许通过把节点降级为 raw 来绕过 Visual 编辑要求。
 */
describe('P1-04R Markdown semantic closure', () => {
  it('parses strikethrough as an editable inline node and preserves an untouched source', () => {
    const source = 'Before ~~deleted~~ after.\n';
    const result = parseMarkdown(source);
    const paragraph = result.root.children[0];

    assert(paragraph?.type === 'paragraph');
    expect(paragraph.children).toEqual([
      expect.objectContaining({ type: 'text', value: 'Before ' }),
      expect.objectContaining({
        type: 'strike',
        raw: '~~deleted~~',
        range: { from: 7, to: 18 },
        children: [expect.objectContaining({ type: 'text', value: 'deleted', range: { from: 9, to: 16 } })]
      }),
      expect.objectContaining({ type: 'text', value: ' after.' })
    ]);
    expect(serializeMarkdown(result)).toBe(source);
  });

  it.each([
    { source: 'A ~word~ B', marker: '~', innerFrom: 3, innerEnd: 7 },
    { source: 'A ~~word~~ B', marker: '~~', innerFrom: 4, innerEnd: 8 }
  ])('parses $marker delimiter with exact source ranges: $source', ({ source, marker, innerFrom, innerEnd }) => {
    const result = parseMarkdown(source);
    const paragraph = result.root.children[0];
    assert(paragraph?.type === 'paragraph');

    const strike = paragraph.children[1];
    assert(strike?.type === 'strike');
    expect(strike.raw).toBe(`${marker}word${marker}`);
    expect(source.slice(strike.range.from, strike.range.to)).toBe(strike.raw);
    expect(strike.children).toHaveLength(1);

    const child = strike.children[0];
    assert(child?.type === 'text');
    expect(child.value).toBe('word');
    expect(child.range).toEqual({ from: innerFrom, to: innerEnd });
    expect(source.slice(child.range.from, child.range.to)).toBe('word');
    expect(serializeMarkdown(result)).toBe(source);
  });

  it.each([
    { initial: 'A ~word~ B', expected: 'A ~new~ B' },
    { initial: 'A ~~word~~ B', expected: 'A ~~new~~ B' }
  ])('preserves original tilde style when editing strike child: $initial -> $expected', ({ initial, expected }) => {
    const result = parseMarkdown(initial);
    const paragraph = result.root.children[0];
    assert(paragraph?.type === 'paragraph');

    const strike = paragraph.children[1];
    assert(strike?.type === 'strike');
    const child = strike.children[0];
    assert(child?.type === 'text');
    child.value = 'new';
    markDirty(child);

    expect(serializeMarkdown(result)).toBe(expected);
  });

  it('preserves nested formatting and punctuation inside a strike span', () => {
    const source = 'Left ~~**bold** and *soft*~~, right.\n';
    const result = parseMarkdown(source);
    const paragraph = result.root.children[0];

    assert(paragraph?.type === 'paragraph');
    expect(paragraph.children[1]).toMatchObject({
      type: 'strike',
      raw: '~~**bold** and *soft*~~',
      children: [
        { type: 'bold', children: [{ type: 'text', value: 'bold' }] },
        { type: 'text', value: ' and ' },
        { type: 'italic', children: [{ type: 'text', value: 'soft' }] }
      ]
    });
    expect(serializeMarkdown(result)).toBe(source);
  });

  it('serializes a dirty strike child without losing delimiters, siblings, or CRLF', () => {
    const source = 'Before ~~old~~ after.\r\n\r\n***\r\n';
    const result = parseMarkdown(source);
    const paragraph = result.root.children[0];

    assert(paragraph?.type === 'paragraph');
    const strike = paragraph.children[1];
    expect(strike?.type).toBe('strike');
    // 通过现有公共节点结构收窄，避免为尚未实现的 strike 类型强制断言。
    assert(strike && 'children' in strike);
    const text = strike.children[0];
    assert(text?.type === 'text');
    text.value = 'new';
    markDirty(text);

    expect(serializeMarkdown(result)).toBe('Before ~~new~~ after.\r\n\r\n***\r\n');
  });

  it.each(['`~~literal~~`', '\\~\\~literal\\~\\~'])('keeps literal tildes outside strike semantics: %s', (literal) => {
    const source = `Before ${literal} after.\n`;
    const result = parseMarkdown(source);
    const paragraph = result.root.children[0];

    assert(paragraph?.type === 'paragraph');
    expect(paragraph.children.map((child) => child.type)).not.toContain('strike');
    expect(serializeMarkdown(result)).toBe(source);
  });

  it.each(['---', '***', '___'])('represents %s as a structured horizontal rule with an exact source range', (marker) => {
    const source = `Before\n\n${marker}\n\nAfter\n`;
    const result = parseMarkdown(source);
    const rule = result.root.children[1];

    assert(rule);
    expect(rule.type).toBe('horizontal-rule');
    expect(rule.opaque).not.toBe(true);
    expect(rule.range.from).toBe(8);
    expect(rule.raw.trim()).toBe(marker);
    expect(source.slice(rule.range.from, rule.range.to)).toBe(rule.raw);
    expect(serializeMarkdown(result)).toBe(source);
  });

  it('keeps a quoted horizontal rule structured while preserving its prefix and CRLF', () => {
    const source = '> Before\r\n>\r\n> ---\r\n>\r\n> After\r\n';
    const result = parseMarkdown(source);
    const quote = result.root.children[0];

    assert(quote?.type === 'blockquote');
    const rule = quote.children[1];
    assert(rule);
    expect(rule.type).toBe('horizontal-rule');
    expect(rule.opaque).not.toBe(true);
    expect(source.slice(rule.range.from, rule.range.to)).toBe(rule.raw);
    expect(serializeMarkdown(result)).toBe(source);
  });

  it('keeps a horizontal rule structured inside a list without changing an opaque HTML sibling', () => {
    const source = '- item\n  <!-- comment -->\n  ---\n';
    const result = parseMarkdown(source);
    const list = result.root.children[0];

    assert(list?.type === 'list');
    const item = list.items[0];
    assert(item);
    expect(item.children[1]).toMatchObject({ type: 'raw', opaque: true, raw: '  <!-- comment -->\n' });
    const rule = item.children[2];
    assert(rule);
    expect(rule.type).toBe('horizontal-rule');
    expect(rule.opaque).not.toBe(true);
    expect(rule.raw).toBe('  ---\n');
    expect(source.slice(rule.range.from, rule.range.to)).toBe(rule.raw);
    expect(serializeMarkdown(result)).toBe(source);
  });

  it.each([
    { underline: '---', depth: 2 },
    { underline: '===', depth: 1 }
  ])('keeps $underline directly below text as a setext heading', ({ underline, depth }) => {
    const source = `Title\n${underline}\n`;
    const result = parseMarkdown(source);

    expect(result.root.children).toEqual([
      expect.objectContaining({ type: 'heading', depth })
    ]);
    expect(serializeMarkdown(result)).toBe(source);
  });

  it('keeps the delimiter row inside a table with its alignment semantics', () => {
    const source = '| A | B |\n| --- | :---: |\n| 1 | 2 |\n';
    const result = parseMarkdown(source);

    expect(result.root.children).toEqual([
      expect.objectContaining({ type: 'table', align: [null, 'center'] })
    ]);
    expect(serializeMarkdown(result)).toBe(source);
  });

  it.each(['\n', '\r\n'])('keeps untouched Unicode, strike, and rule source byte-for-byte identical with %j', (newline) => {
    const source = ['前文 🎉  ~~删除~~。  ', '', '___', '', '<unknown>raw</unknown>', ''].join(newline);
    const result = parseMarkdown(source);

    expect(serializeMarkdown(result)).toBe(source);
  });
});
