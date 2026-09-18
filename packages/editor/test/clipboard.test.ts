// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  MarkdownDocumentSession,
  createSessionEditorView,
  setEditorReadOnly,
  createClipboardPasteTransaction,
  extractPlainTextFromHtml
} from '../src/index.js';

describe('P1-04E Clipboard Security & Paste Handling', () => {
  describe('A. HTML Clipboard Plain-Text Extraction', () => {
    it('strips script tags and executable contents, outputting only clean text', () => {
      const dirtyHtml = '<p>Safe text</p><script>alert("hack")</script><b>Bold</b>';
      const clean = extractPlainTextFromHtml(dirtyHtml);
      expect(clean).not.toContain('<script');
      expect(clean).not.toContain('alert');
      expect(clean).toContain('Safe text');
      expect(clean).toContain('Bold');
    });

    it('strips iframe, embed, and object tags from pasted HTML', () => {
      const iframeHtml = '<div>Check this: <iframe src="http://evil.com"></iframe><embed src="x"></div>';
      const clean = extractPlainTextFromHtml(iframeHtml);
      expect(clean).not.toContain('<iframe');
      expect(clean).not.toContain('<embed');
      expect(clean).toContain('Check this:');
    });

    it('neutralizes inline events, javascript: URIs, xlink:href, and unquoted attributes', () => {
      const xssHtml = '<a href=javascript:alert(1) onclick="evil()">Click <svg><a xlink:href="javascript:bad()"><text>SVGText</text></a></svg></a>';
      const clean = extractPlainTextFromHtml(xssHtml);
      expect(clean).not.toContain('javascript:');
      expect(clean).not.toContain('alert');
      expect(clean).toContain('Click');
    });

    it('decodes decimal and hex character entities and preserves user leading and trailing whitespace', () => {
      const htmlWithEntities = '  Hello &#65;&#x42; &amp; &#39;World&#39;  ';
      const text = extractPlainTextFromHtml(htmlWithEntities);
      expect(text).toBe("  Hello AB & 'World'  ");
      // Must NOT unconditionally trim user leading/trailing spaces
      expect(text.startsWith('  ')).toBe(true);
      expect(text.endsWith('  ')).toBe(true);
    });

    it('handles malformed HTML, unclosed tags, and void tags gracefully', () => {
      const malformed = '<p>Line 1<hr>Line 2<br>Line 3<div>Unclosed div';
      const text = extractPlainTextFromHtml(malformed);
      expect(text).toContain('Line 1');
      expect(text).toContain('Line 2');
      expect(text).toContain('Line 3');
      expect(text).toContain('Unclosed div');
    });

    it('preserves trailing newline for inline span followed by explicit BR (<span>x</span><br> -> x\\n)', () => {
      const result = extractPlainTextFromHtml('<span>x</span><br>');
      expect(result).toBe('x\n');
    });

    it('does not append trailing newline merely due to block wrapper (<div>x</div> -> x)', () => {
      const result = extractPlainTextFromHtml('<div>x</div>');
      expect(result).toBe('x');
    });

    it('preserves explicit BR following block element (<div>x</div><br> -> x\\n)', () => {
      const result = extractPlainTextFromHtml('<div>x</div><br>');
      expect(result).toBe('x\n');
    });

    it('fails closed when document is undefined instead of using regex tag removal', () => {
      const originalDoc = globalThis.document;
      try {
        // @ts-expect-error simulating non-DOM environment
        delete globalThis.document;
        const result = extractPlainTextFromHtml('<script>alert(1)</script>text');
        expect(result).toBe('');
      } finally {
        globalThis.document = originalDoc;
      }
    });
  });

  describe('B. Paste Transactions and Session History', () => {
    it('creates clipboard paste transaction and applies cleanly', () => {
      const source = 'Hello World';
      const tx = createClipboardPasteTransaction(source, { anchor: 6, head: 11 }, 'Nexus');
      expect(tx.userEvent).toBe('input.paste');
      expect(tx.changes[0]).toEqual({ from: 6, to: 11, insert: 'Nexus' });
    });

    it('rejects paste event when surface is readOnly', () => {
      const session = new MarkdownDocumentSession('Read only document');
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'paste-ro-1',
        surfaceKind: 'visual',
        readOnly: true,
        parent
      });

      const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
      handle.view.contentDOM.dispatchEvent(pasteEvent);
      expect(pasteEvent.defaultPrevented).toBe(true);

      handle.destroy();
      parent.remove();
    });

    it('handles clipboard paste in active surface and supports session undo/redo', () => {
      const session = new MarkdownDocumentSession('Prefix Suffix');
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'paste-active-1',
        surfaceKind: 'visual',
        parent
      });

      // Set selection at index 7 (after 'Prefix ')
      handle.view.dispatch({ selection: { anchor: 7, head: 7 } });

      // Create a mock paste event with DataTransfer
      const dataTransfer = {
        getData: (type: string) => (type === 'text/plain' ? 'Middle ' : '')
      };
      const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, 'clipboardData', { value: dataTransfer });

      handle.view.contentDOM.dispatchEvent(pasteEvent);

      expect(session.getSnapshot().source).toBe('Prefix Middle Suffix');

      // Undo paste
      session.undo();
      expect(session.getSnapshot().source).toBe('Prefix Suffix');

      // Redo paste
      session.redo();
      expect(session.getSnapshot().source).toBe('Prefix Middle Suffix');

      handle.destroy();
      parent.remove();
    });

    it('rejects paste event dynamically when setEditorReadOnly is set to true', () => {
      const session = new MarkdownDocumentSession('Read only dynamic doc');
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'paste-dyn-ro',
        surfaceKind: 'visual',
        readOnly: false,
        parent
      });

      // Dynamically toggle readOnly to true
      setEditorReadOnly(handle.view, true);
      expect(handle.view.state.readOnly).toBe(true);

      const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
      const dataTransfer = {
        getData: (type: string) => (type === 'text/plain' ? 'Disallowed' : '')
      };
      Object.defineProperty(pasteEvent, 'clipboardData', { value: dataTransfer });

      handle.view.contentDOM.dispatchEvent(pasteEvent);
      expect(pasteEvent.defaultPrevented).toBe(true);
      expect(session.getSnapshot().source).toBe('Read only dynamic doc');

      handle.destroy();
      parent.remove();
    });

    it('sanitizes and safely pastes HTML when text/plain is missing or empty', () => {
      const session = new MarkdownDocumentSession('Initial ');
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'paste-html-1',
        surfaceKind: 'visual',
        parent
      });

      handle.view.dispatch({ selection: { anchor: 8, head: 8 } });

      const dirtyHtml = '<p>Pasted <SCRIPT>alert("xss")</SCRIPT><embed src="bad"><b>Content</b></p>';
      const dataTransfer = {
        getData: (type: string) => {
          if (type === 'text/plain') return '';
          if (type === 'text/html') return dirtyHtml;
          return '';
        }
      };
      const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, 'clipboardData', { value: dataTransfer });

      handle.view.contentDOM.dispatchEvent(pasteEvent);

      expect(pasteEvent.defaultPrevented).toBe(true);
      const snapshot = session.getSnapshot().source;
      expect(snapshot).not.toContain('<SCRIPT');
      expect(snapshot).not.toContain('alert');
      expect(snapshot).not.toContain('<embed');
      expect(snapshot).toContain('Pasted');
      expect(snapshot).toContain('Content');

      handle.destroy();
      parent.remove();
    });

    it('rejects paste and prevents default when clipboard HTML contains only dangerous executable scripts', () => {
      const session = new MarkdownDocumentSession('Unchanged Document');
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'paste-html-evil',
        surfaceKind: 'visual',
        parent
      });

      const evilHtml = '<SCRIPT>alert(1)</SCRIPT><svg><script>evil()</script></svg>';
      const dataTransfer = {
        getData: (type: string) => {
          if (type === 'text/plain') return '';
          if (type === 'text/html') return evilHtml;
          return '';
        }
      };
      const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, 'clipboardData', { value: dataTransfer });

      handle.view.contentDOM.dispatchEvent(pasteEvent);

      expect(pasteEvent.defaultPrevented).toBe(true);
      expect(session.getSnapshot().source).toBe('Unchanged Document');

      handle.destroy();
      parent.remove();
    });

    it('prioritizes text/plain when both text/plain and text/html are present', () => {
      const session = new MarkdownDocumentSession('Base: ');
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'paste-prio',
        surfaceKind: 'visual',
        parent
      });

      handle.view.dispatch({ selection: { anchor: 6, head: 6 } });

      const dataTransfer = {
        getData: (type: string) => {
          if (type === 'text/plain') return 'Plain Priority';
          if (type === 'text/html') return '<p>HTML Version</p>';
          return '';
        }
      };
      const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, 'clipboardData', { value: dataTransfer });

      handle.view.contentDOM.dispatchEvent(pasteEvent);

      expect(pasteEvent.defaultPrevented).toBe(true);
      expect(session.getSnapshot().source).toBe('Base: Plain Priority');

      handle.destroy();
      parent.remove();
    });
  });
});
