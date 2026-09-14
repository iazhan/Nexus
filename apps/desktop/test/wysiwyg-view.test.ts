import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WysiwygView } from '../renderer/src/wysiwyg/WysiwygView.js';

describe('WysiwygView Component Projection', () => {
  describe('Source Invariance & Non-Mutation', () => {
    it('does not mutate or alter the original source string', () => {
      const source = '# Sample Markdown\n\nWith **bold** and $formula$.';
      const originalCopy = source.slice();

      const html = renderToStaticMarkup(
        React.createElement(WysiwygView, { source })
      );

      expect(source).toBe(originalCopy);
      expect(html).toContain('<h1 class="nexus-wysiwyg-h1">Sample Markdown</h1>');
    });
  });

  describe('Source / WYSIWYG Content Continuity', () => {
    it('projects the latest edited source rather than initial content', () => {
      const initial = '# Initial Document';
      const updated = '# Updated Content\n\nUser typed more text here.';

      // Verify that passing the updated source directly projects the updated content
      const htmlInitial = renderToStaticMarkup(
        React.createElement(WysiwygView, { source: initial })
      );
      expect(htmlInitial).toContain('Initial Document');

      const htmlUpdated = renderToStaticMarkup(
        React.createElement(WysiwygView, { source: updated })
      );
      expect(htmlUpdated).toContain('Updated Content');
      expect(htmlUpdated).toContain('User typed more text here.');
      expect(htmlUpdated).not.toContain('Initial Document');
    });
  });

  describe('Security & XSS Injection Prevention', () => {
    it('escapes raw HTML script tags and never renders live scripts', () => {
      const malicious = '<script>alert("xss")</script>';
      const html = renderToStaticMarkup(
        React.createElement(WysiwygView, { source: malicious })
      );

      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('blocks dangerous javascript: links from href attributes', () => {
      const malicious = '[Click here](javascript:alert(document.cookie))';
      const html = renderToStaticMarkup(
        React.createElement(WysiwygView, { source: malicious })
      );

      expect(html).not.toContain('href="javascript:');
      expect(html).toContain('nexus-wysiwyg-link blocked');
    });

    it('blocks dangerous data: images and falls back to safe placeholder', () => {
      const malicious = '![Exploit](data:image/svg+xml;utf8,<svg><script>alert(1)</script></svg>)';
      const html = renderToStaticMarkup(
        React.createElement(WysiwygView, { source: malicious })
      );

      expect(html).not.toContain('<img');
      expect(html).toContain('nexus-wysiwyg-image-fallback');
      expect(html).toContain('Exploit');
    });

    it('prevents inline event handler injections by escaping raw html', () => {
      const payload = '<img src="invalid" onerror="alert(1)">';
      const html = renderToStaticMarkup(
        React.createElement(WysiwygView, { source: payload })
      );

      expect(html).not.toContain('<img ');
      expect(html).toContain('&lt;img');
    });
  });

  describe('Syntax Region Renderings', () => {
    it('renders math and wikilinks with dedicated placeholders', () => {
      const doc = 'Formula $E = mc^2$ and note [[Architecture|Arch Doc]].';
      const html = renderToStaticMarkup(
        React.createElement(WysiwygView, { source: doc })
      );

      expect(html).toContain('nexus-wysiwyg-math-inline');
      expect(html).toContain('E = mc^2');
      expect(html).toContain('nexus-wysiwyg-wikilink');
      expect(html).toContain('Arch Doc');
    });

    it('renders nested lists with valid block containers', () => {
      const doc = '- Parent\n  - Child';
      const html = renderToStaticMarkup(
        React.createElement(WysiwygView, { source: doc })
      );

      expect(html).toContain('<ul class="nexus-wysiwyg-ul">');
      expect(html).toContain('<div class="nexus-list-content">');
      expect(html).toContain('Child');
    });

    it('renders fenced code blocks without parsing internal markdown', () => {
      const doc = '```typescript\nconst a = "# Not A Header";\n```';
      const html = renderToStaticMarkup(
        React.createElement(WysiwygView, { source: doc })
      );

      expect(html).toContain('class="language-typescript"');
      expect(html).toContain('const a = &quot;# Not A Header&quot;;');
      expect(html).not.toContain('<h1');
    });
  });
});
