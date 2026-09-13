import { describe, it, expect } from 'vitest';
import {
  findMarkdownMarkers,
  hasMathMarkers
} from '../src/markdown-markers.js';

describe('Markdown Marker Recognition', () => {
  describe('Boundary and Empty Inputs', () => {
    it('returns an empty array for empty string or whitespace only', () => {
      expect(findMarkdownMarkers('')).toEqual([]);
      expect(findMarkdownMarkers('   \n  \t  ')).toEqual([]);
    });

    it('handles unclosed inline math safely without throwing', () => {
      const markers = findMarkdownMarkers('Formula $x is incomplete');
      expect(markers).toEqual([]);
    });

    it('handles unclosed block math safely without throwing', () => {
      const markers = findMarkdownMarkers('Block math $$\nx = 1\n');
      expect(markers).toEqual([]);
    });

    it('handles unclosed wikilink safely without throwing', () => {
      const markers = findMarkdownMarkers('Link to [[Page without closing');
      expect(markers).toEqual([]);
    });

    it('handles unclosed fenced code block by extending to EOF', () => {
      const input = '```ts\nconst a = 1;\nconsole.log(a);';
      const markers = findMarkdownMarkers(input);
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({
        type: 'code-fence',
        from: 0,
        to: input.length
      });
    });
  });

  describe('Inline Math ($...$)', () => {
    it('recognizes standard inline math expression $x$', () => {
      const input = 'Value is $x$ here.';
      const markers = findMarkdownMarkers(input);
      expect(markers).toHaveLength(1);
      expect(markers[0]).toEqual({
        type: 'inline-math',
        from: 9,
        to: 12,
        text: '$x$'
      });
    });

    it('recognizes complex inline math expressions', () => {
      const input = 'Equation $E = mc^2$ and $\\alpha + \\beta = \\gamma$.';
      const markers = findMarkdownMarkers(input);
      expect(markers).toHaveLength(2);
      expect(markers[0]).toEqual({
        type: 'inline-math',
        from: 9,
        to: 19,
        text: '$E = mc^2$'
      });
      expect(markers[1]).toEqual({
        type: 'inline-math',
        from: 24,
        to: 49,
        text: '$\\alpha + \\beta = \\gamma$'
      });
    });

    it('ignores escaped dollars \\$x\\$', () => {
      const input = 'Price is \\$100\\$ not math.';
      const markers = findMarkdownMarkers(input);
      expect(markers).toEqual([]);
    });

    it('ignores currency mentions like $10 and $20', () => {
      const input = 'It costs $10 and then $20 today.';
      const markers = findMarkdownMarkers(input);
      expect(markers).toEqual([]);
    });

    it('does not recognize inline math with leading or trailing whitespace', () => {
      const input = 'Invalid $ x $ math.';
      const markers = findMarkdownMarkers(input);
      expect(markers).toEqual([]);
    });
  });

  describe('Block Math ($$...$$)', () => {
    it('recognizes single-line block math $$x$$', () => {
      const input = 'Formula $$x$$ displayed.';
      const markers = findMarkdownMarkers(input);
      expect(markers).toHaveLength(1);
      expect(markers[0]).toEqual({
        type: 'block-math',
        from: 8,
        to: 13,
        text: '$$x$$'
      });
    });

    it('recognizes multi-line block math', () => {
      const input = 'Before\n$$\nf(x) = \\int_0^1 t dt\n$$\nAfter';
      const markers = findMarkdownMarkers(input);
      expect(markers).toHaveLength(1);
      expect(markers[0]?.type).toBe('block-math');
      expect(markers[0]?.text).toBe('$$\nf(x) = \\int_0^1 t dt\n$$');
    });

    it('handles math marker presence check correctly', () => {
      expect(hasMathMarkers('Plain markdown')).toBe(false);
      expect(hasMathMarkers('Contains $x$')).toBe(true);
      expect(hasMathMarkers('Contains $$y$$')).toBe(true);
    });
  });

  describe('Wikilinks ([[...]])', () => {
    it('recognizes standard wikilink [[Page]]', () => {
      const input = 'See [[Page]] for details.';
      const markers = findMarkdownMarkers(input);
      expect(markers).toHaveLength(1);
      expect(markers[0]).toEqual({
        type: 'wikilink',
        from: 4,
        to: 12,
        text: '[[Page]]'
      });
    });

    it('recognizes aliased wikilink [[Page|Custom Title]]', () => {
      const input = 'Link: [[Page|Custom Title]]';
      const markers = findMarkdownMarkers(input);
      expect(markers).toHaveLength(1);
      expect(markers[0]).toEqual({
        type: 'wikilink',
        from: 6,
        to: 27,
        text: '[[Page|Custom Title]]'
      });
    });

    it('does not recognize empty [[ ]] wikilinks', () => {
      const input = 'Empty [[]] link';
      const markers = findMarkdownMarkers(input);
      expect(markers).toEqual([]);
    });

    it('does not recognize wikilinks spanning across multiple lines', () => {
      const input = 'Broken [[\nPage\n]] link';
      const markers = findMarkdownMarkers(input);
      expect(markers).toEqual([]);
    });
  });

  describe('Fenced Code Blocks', () => {
    it('recognizes closed backtick code fence', () => {
      const input = '```ts\nconst x = 1;\n```\n';
      const markers = findMarkdownMarkers(input);
      expect(markers).toHaveLength(1);
      expect(markers[0]?.type).toBe('code-fence');
      expect(markers[0]?.from).toBe(0);
      expect(markers[0]?.to).toBe(input.length);
    });

    it('recognizes closed tilde code fence', () => {
      const input = '~~~markdown\n# Heading inside\n~~~\n';
      const markers = findMarkdownMarkers(input);
      expect(markers).toHaveLength(1);
      expect(markers[0]?.type).toBe('code-fence');
    });

    it('does not mistake ordinary inline backticks for code fence', () => {
      const input = 'Use `console.log()` to debug.';
      const markers = findMarkdownMarkers(input);
      expect(markers).toEqual([]);
    });

    it('ignores math and wikilinks inside fenced code blocks', () => {
      const input = '```ts\nconst a = "$x$";\n// [[Page]]\n$$\nfoo\n$$\n```\n';
      const markers = findMarkdownMarkers(input);
      // Should ONLY contain code-fence, neither inline math nor wikilinks
      expect(markers).toHaveLength(1);
      expect(markers[0]?.type).toBe('code-fence');
    });

    it('ignores math and wikilinks inside inline code spans', () => {
      const input = 'Use `$x$` or `[[Page]]` in text, but $real$ is math.';
      const markers = findMarkdownMarkers(input);
      expect(markers).toHaveLength(1);
      expect(markers[0]).toEqual({
        type: 'inline-math',
        from: 37,
        to: 43,
        text: '$real$'
      });
    });
  });

  describe('Mixed document parsing', () => {
    it('accurately parses multiple interleaved marker types in order', () => {
      const doc = `# Header

Here is an inline math $a^2 + b^2 = c^2$ and a wikilink [[Quantum Mechanics]].

$$\\int_a^b f(x) dx = F(b) - F(a)$$

\`\`\`python
def calculate():
    return "$not_math$"
\`\`\`

End with [[Summary]].`;

      const markers = findMarkdownMarkers(doc);
      expect(markers.map((m) => m.type)).toEqual([
        'inline-math',
        'wikilink',
        'block-math',
        'code-fence',
        'wikilink'
      ]);

      // Assert all markers are strictly ascending and non-overlapping
      for (let i = 1; i < markers.length; i++) {
        const prev = markers[i - 1]!;
        const curr = markers[i]!;
        expect(curr.from).toBeGreaterThanOrEqual(prev.to);
      }
    });
  });
});
