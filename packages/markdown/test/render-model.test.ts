import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/parser.js';
import { extractTextContent, countNodes } from '../src/render-model.js';

describe('Render Model Utilities', () => {
  it('extracts plain text from heading and paragraph', () => {
    const doc = parseMarkdown('# Header\n\nSome paragraph text.');
    const text = extractTextContent(doc.root.children);
    expect(text).toContain('Header');
    expect(text).toContain('Some paragraph text.');
  });

  it('extracts plain text from lists and blockquotes', () => {
    const doc = parseMarkdown('> Quote text\n\n- Item 1\n- Item 2');
    const text = extractTextContent(doc.root.children);
    expect(text).toContain('Quote text');
    expect(text).toContain('Item 1');
    expect(text).toContain('Item 2');
  });

  it('counts nodes accurately in complex markdown', () => {
    const doc = parseMarkdown('# Title\n\nParagraph with **bold** and *italic*.');
    const total = countNodes(doc.root);
    expect(total).toBeGreaterThan(4);
  });
});
