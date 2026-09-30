import { describe, it, expect } from 'vitest';
import { countDocumentCharacters } from '../src/index.js';

describe('countDocumentCharacters', () => {
  it('returns 0 for an empty document', () => {
    expect(countDocumentCharacters('')).toBe(0);
  });

  it('counts CJK and latin characters one each', () => {
    expect(countDocumentCharacters('你好')).toBe(2);
    expect(countDocumentCharacters('hello')).toBe(5);
    expect(countDocumentCharacters('你好 world')).toBe(7);
  });

  it('ignores spaces, tabs and newlines', () => {
    expect(countDocumentCharacters('a b\tc\nd')).toBe(4);
    expect(countDocumentCharacters('  \n\n  ')).toBe(0);
  });

  it('ignores the full-width space (U+3000)', () => {
    expect(countDocumentCharacters('你\u3000好')).toBe(2);
  });

  it('counts markdown syntax characters', () => {
    expect(countDocumentCharacters('# 标题')).toBe(3);
    expect(countDocumentCharacters('- [x] done')).toBe(8);
  });

  it('counts one emoji as one character, not two UTF-16 units', () => {
    expect('😀'.length).toBe(2);
    expect(countDocumentCharacters('😀')).toBe(1);
    expect(countDocumentCharacters('a😀b')).toBe(3);
  });

  it('counts a multi-code-point grapheme by code point', () => {
    // 家族 emoji：5 个码点，UTF-16 长度 11。口径是码点，不是字素簇。
    const family = '👨‍👩‍👧‍👦';
    expect(countDocumentCharacters(family)).toBe(7);
  });
});
