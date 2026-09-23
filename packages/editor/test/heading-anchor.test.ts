import { describe, expect, it } from 'vitest';
import { buildHeadingIndex, resolveHeadingAnchor, slugifyHeading } from '../src/index.js';

describe('slugifyHeading', () => {
  it('reproduces the anchors written by hand in docs/markdown-syntax-reference.md', () => {
    // 这份文档的目录全部是手写锚点。只要这些断言成立，Ctrl+左键点目录就能跳到对应标题。
    expect(slugifyHeading('13. 转义与常见陷阱')).toBe('13-转义与常见陷阱');
    expect(slugifyHeading('2. 强调：粗体、斜体、删除线')).toBe('2-强调粗体斜体删除线');
    expect(slugifyHeading('10. 超链接')).toBe('10-超链接');
    expect(slugifyHeading('7. 行内代码')).toBe('7-行内代码');
    expect(slugifyHeading('3. 无序列表与有序列表')).toBe('3-无序列表与有序列表');
  });

  it('lowercases, collapses whitespace, and keeps - and _', () => {
    expect(slugifyHeading('Hello   World')).toBe('hello-world');
    expect(slugifyHeading('snake_case-name')).toBe('snake_case-name');
    expect(slugifyHeading('  padded  ')).toBe('padded');
  });

  it('drops punctuation', () => {
    expect(slugifyHeading('C++ / Rust?')).toBe('c-rust');
    expect(slugifyHeading('API: v2.0 (beta)')).toBe('api-v20-beta');
  });

  it('keeps - and _ but drops everything else, and blanks out empty input', () => {
    // 连字符与下划线本身就在保留集里，所以纯符号串会原样留下
    expect(slugifyHeading('---')).toBe('---');
    expect(slugifyHeading('!!!')).toBe('');
    expect(slugifyHeading('')).toBe('');
    expect(slugifyHeading('   ')).toBe('');
  });
});

describe('buildHeadingIndex', () => {
  it('collects headings in document order with their source offsets', () => {
    const source = ['# Title', '', 'Body', '', '## Section A', '', '### Deep'].join('\n');
    const index = buildHeadingIndex(source);

    expect(index.map((entry) => entry.slug)).toEqual(['title', 'section-a', 'deep']);
    expect(index.map((entry) => entry.depth)).toEqual([1, 2, 3]);

    for (const entry of index) {
      expect(source.slice(entry.from, entry.from + 1)).toBe('#');
    }
  });

  it('reads plain text from inline children rather than raw markup', () => {
    const source = '## Use `npm install` **now**';
    const index = buildHeadingIndex(source);

    expect(index[0]?.text).toBe('Use npm install now');
    expect(index[0]?.slug).toBe('use-npm-install-now');
  });

  it('disambiguates duplicate headings the way GitHub does', () => {
    const source = ['# Setup', '', '## Setup', '', '## Setup'].join('\n');
    expect(buildHeadingIndex(source).map((entry) => entry.slug)).toEqual([
      'setup',
      'setup-1',
      'setup-2'
    ]);
  });

  it('returns an empty index for documents without headings', () => {
    expect(buildHeadingIndex('Just a paragraph.')).toEqual([]);
    expect(buildHeadingIndex('')).toEqual([]);
  });
});

describe('resolveHeadingAnchor', () => {
  const source = ['# Title', '', '## 13. 转义与常见陷阱', '', 'Body'].join('\n');
  const expected = source.indexOf('## 13.');

  it('resolves a matching anchor to the heading start offset', () => {
    expect(resolveHeadingAnchor(source, '#13-转义与常见陷阱')).toBe(expected);
  });

  it('accepts the anchor with or without the leading #, and percent-encoded', () => {
    expect(resolveHeadingAnchor(source, '13-转义与常见陷阱')).toBe(expected);
    expect(resolveHeadingAnchor(source, `#${encodeURIComponent('13-转义与常见陷阱')}`)).toBe(expected);
  });

  it('is case-insensitive, matching how browsers treat fragments', () => {
    expect(resolveHeadingAnchor(source, '#13-转义与常见陷阱'.toUpperCase())).toBe(expected);
  });

  it('returns null for unknown, empty or malformed anchors', () => {
    expect(resolveHeadingAnchor(source, '#nope')).toBeNull();
    expect(resolveHeadingAnchor(source, '#')).toBeNull();
    expect(resolveHeadingAnchor(source, '#%E4%B8')).toBeNull();
  });
});
