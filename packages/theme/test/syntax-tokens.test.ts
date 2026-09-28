import { describe, it, expect } from 'vitest';
import { nexusLight, nexusDark } from '../src/index.js';

const REQUIRED_SYNTAX_TOKENS = [
  'syntax-heading',
  'syntax-keyword',
  'syntax-control',
  'syntax-string',
  'syntax-comment',
  'syntax-number',
  'syntax-bool',
  'syntax-function',
  'syntax-variable',
  'syntax-property',
  'syntax-type',
  'syntax-operator',
  'syntax-punctuation',
  'syntax-builtin',
  'syntax-url',
  'syntax-inline-code-bg',
  'syntax-inline-code-text'
];

describe('Theme Syntax Tokens', () => {
  it('nexusLight defines all required syntax tokens with distinct colors', () => {
    for (const token of REQUIRED_SYNTAX_TOKENS) {
      expect(nexusLight.tokens[token], `nexusLight should define token ${token}`).toBeDefined();
      expect(nexusLight.tokens[token].length).toBeGreaterThan(0);
    }

    // 浅色主题的高对比检查：不得沿用暗色主题的同名色
    expect(nexusLight.tokens['syntax-function']).not.toBe('#dcdcaa'); // 暗色主题的淡黄
    expect(nexusLight.tokens['syntax-variable']).not.toBe('#9cdcfe'); // 暗色主题的浅青
    expect(nexusLight.tokens['syntax-number']).not.toBe('#b5cea8');   // 暗色主题的浅绿
  });

  it('nexusDark defines all required syntax tokens', () => {
    for (const token of REQUIRED_SYNTAX_TOKENS) {
      expect(nexusDark.tokens[token], `nexusDark should define token ${token}`).toBeDefined();
      expect(nexusDark.tokens[token].length).toBeGreaterThan(0);
    }
  });
});
