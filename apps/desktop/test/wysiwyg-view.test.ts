// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseMarkdown } from '@nexus/markdown';
import { WysiwygView } from '../renderer/src/wysiwyg/WysiwygView.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('WysiwygView Component Projection', () => {
  describe('Source Invariance & Non-Mutation', () => {
    it('does not mutate or alter the original source string', () => {
      const source = '# Sample Markdown\n\nWith **bold** and $formula$.';
      const originalCopy = source.slice();

      const html = renderToStaticMarkup(
        React.createElement(WysiwygView, { source })
      );

      expect(source).toBe(originalCopy);
      expect(html).toContain('class="nexus-wysiwyg-h1"');
      expect(html).toContain('Sample Markdown</h1>');
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

      expect(html).toContain('class="nexus-wysiwyg-ul"');
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

  describe('P1-04B Editable WYSIWYG Core Markers & Constraints', () => {
    it('marks top-level paragraph as editable block with range metadata', () => {
      const doc = 'This is an editable paragraph.';
      const html = renderToStaticMarkup(
        React.createElement(WysiwygView, { source: doc })
      );

      expect(html).toContain('data-testid="wysiwyg-editable-block"');
      expect(html).toContain('data-node-type="paragraph"');
      expect(html).toContain('data-range-from="0"');
      expect(html).toContain(`data-range-to="${doc.length}"`);
      expect(html.toLowerCase()).toContain('contenteditable="true"');
    });

    it('marks top-level heading as editable block with range metadata', () => {
      const doc = '# My Editable Heading\n';
      const html = renderToStaticMarkup(
        React.createElement(WysiwygView, { source: doc })
      );

      expect(html).toContain('data-testid="wysiwyg-editable-block"');
      expect(html).toContain('data-node-type="heading"');
      expect(html).toContain('data-range-from="0"');
      expect(html.toLowerCase()).toContain('contenteditable="true"');
    });

    it('marks non-editable blocks with contenteditable="false" and readonly testid', () => {
      const doc = '> A quote\n\n- List item\n\n```js\nconsole.log(1);\n```\n\n| H |\n| - |\n| C |\n\n$$\nx^2\n$$';
      const html = renderToStaticMarkup(
        React.createElement(WysiwygView, { source: doc })
      );

      expect(html).toContain('data-testid="wysiwyg-readonly-block"');
      expect(html).toContain('data-node-type="blockquote"');
      expect(html).toContain('data-node-type="list"');
      expect(html).toContain('data-node-type="code-block"');
      expect(html).toContain('data-node-type="table"');
      expect(html).toContain('data-node-type="block-math"');
      expect(html.toLowerCase()).toContain('contenteditable="false"');
    });

    it('marks non-editable inlines with contenteditable="false" and data-raw', () => {
      const doc = 'Text with $formula$, [[WikiPage]], and `code`.';
      const html = renderToStaticMarkup(
        React.createElement(WysiwygView, { source: doc })
      );

      // Paragraph itself is editable
      expect(html).toContain('data-testid="wysiwyg-editable-block"');
      // Inline math is non-editable with data-raw
      expect(html).toContain('data-node-type="inline-math"');
      expect(html).toContain('data-raw="$formula$"');
      // Wikilink is non-editable with data-raw
      expect(html).toContain('data-node-type="wikilink"');
      expect(html).toContain('data-raw="[[WikiPage]]"');
      // Inline code has data-node-type="inline-code"
      expect(html).toContain('data-node-type="inline-code"');
    });

    it('sets contenteditable="false" on editable blocks when readOnly={true}', () => {
      const doc = '# Readonly Title\n\nReadonly text.';
      const html = renderToStaticMarkup(
        React.createElement(WysiwygView, { source: doc, readOnly: true })
      );

      expect(html).toContain('data-testid="wysiwyg-editable-block"');
      expect(html.toLowerCase()).not.toContain('contenteditable="true"');
      expect(html.toLowerCase()).toContain('contenteditable="false"');
    });

    it('strictly forbids dangerouslySetInnerHTML and element.innerHTML across WYSIWYG code', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const wysiwygSource = fs.readFileSync(
        path.resolve(__dirname, '../renderer/src/wysiwyg/WysiwygView.tsx'),
        'utf-8'
      );
      const editModelSource = fs.readFileSync(
        path.resolve(__dirname, '../renderer/src/wysiwyg/edit-model.ts'),
        'utf-8'
      );

      expect(wysiwygSource).not.toContain('dangerouslySetInnerHTML');
      expect(wysiwygSource).not.toContain('.innerHTML');
      expect(editModelSource).not.toContain('dangerouslySetInnerHTML');
      expect(editModelSource).not.toContain('.innerHTML');
    });

    it('preserves Source and WYSIWYG content continuity without dropping edits', () => {
      // Test the contract: when WysiwygView receives updated source, it projects it accurately
      let currentContent = '# Original Title\n\nOriginal body.';
      const onContentChange = (next: string) => {
        currentContent = next;
      };

      // 1. Initial WYSIWYG projection
      let html = renderToStaticMarkup(
        React.createElement(WysiwygView, {
          source: currentContent,
          onChange: onContentChange
        })
      );
      expect(html).toContain('Original Title');

      // 2. Simulated edit triggered by WysiwygView
      onContentChange('# Updated in WYSIWYG\n\nOriginal body.');
      expect(currentContent).toContain('Updated in WYSIWYG');

      // 3. Source Mode gets the exact currentContent
      expect(currentContent).toBe('# Updated in WYSIWYG\n\nOriginal body.');

      // 4. Switching back to WYSIWYG with currentContent preserves it
      html = renderToStaticMarkup(
        React.createElement(WysiwygView, {
          source: currentContent,
          onChange: onContentChange
        })
      );
      expect(html).toContain('Updated in WYSIWYG');
      expect(html).not.toContain('Original Title');
    });
  });

  describe('Real DOM Event Chain & Interaction Verification', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => {
        root.unmount();
      });
      container.remove();
    });

    it('handles paragraph edit text mutation and blur event chain', () => {
      const initial = 'Original paragraph content.\n';
      const onChange = vi.fn();

      act(() => {
        root.render(
          React.createElement(WysiwygView, {
            source: initial,
            onChange
          })
        );
      });

      const block = container.querySelector('[data-testid="wysiwyg-editable-block"]') as HTMLElement;
      expect(block).toBeDefined();
      expect(block.tagName).toBe('P');

      act(() => {
        block.focus();
      });

      // Modify DOM text content
      block.textContent = 'Modified paragraph content.';

      // Blur event
      act(() => {
        block.blur();
      });

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith('Modified paragraph content.\n');
    });

    it('handles heading edit preserving heading level, indentation, closing # and CRLF', () => {
      const initial = '  ## Original Heading ##\r\n';
      const onChange = vi.fn();

      act(() => {
        root.render(
          React.createElement(WysiwygView, {
            source: initial,
            onChange
          })
        );
      });

      const block = container.querySelector('[data-testid="wysiwyg-editable-block"]') as HTMLElement;
      expect(block).toBeDefined();
      expect(block.tagName).toBe('H2');

      act(() => {
        block.focus();
      });

      block.textContent = 'Updated Heading';

      act(() => {
        block.blur();
      });

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith('  ## Updated Heading ##\r\n');
    });

    it('preserves escaped text on blur and prevents false italic parse', () => {
      const initial = 'Paragraph with \\*escaped\\* asterisk.\n';
      const onChange = vi.fn();

      act(() => {
        root.render(
          React.createElement(WysiwygView, {
            source: initial,
            onChange
          })
        );
      });

      const block = container.querySelector('[data-testid="wysiwyg-editable-block"]') as HTMLElement;
      expect(block).toBeDefined();

      // Blur without edit
      act(() => {
        block.focus();
        block.blur();
      });

      // Unchanged source -> onChange should not be called
      expect(onChange).not.toHaveBeenCalled();

      // Edit adjacent text
      const firstChild = block.childNodes[0];
      if (firstChild && firstChild.nodeType === 3) {
        firstChild.textContent = 'Updated with ';
      }

      act(() => {
        block.focus();
        block.blur();
      });

      expect(onChange).toHaveBeenCalledTimes(1);
      const nextSource = onChange.mock.calls[0]![0] as string;
      expect(nextSource).toBe('Updated with \\*escaped\\* asterisk.\n');

      const parsed = parseMarkdown(nextSource);
      const p = parsed.root.children[0]!;
      expect(p.type).toBe('paragraph');
      if (p.type === 'paragraph') {
        expect(p.children.some((c) => c.type === 'italic')).toBe(false);
      }
    });

    it('preserves double-backtick code span without edit and with edit', () => {
      const initial = 'Before ``old`` after.\n';
      const onChange = vi.fn();

      act(() => {
        root.render(
          React.createElement(WysiwygView, {
            source: initial,
            onChange
          })
        );
      });

      const block = container.querySelector('[data-testid="wysiwyg-editable-block"]') as HTMLElement;

      // Blur without edit
      act(() => {
        block.focus();
        block.blur();
      });

      expect(onChange).not.toHaveBeenCalled();

      // Edit the code element inside block
      const codeEl = block.querySelector('code') as HTMLElement;
      expect(codeEl).toBeDefined();
      codeEl.textContent = 'new';

      act(() => {
        block.focus();
        block.blur();
      });

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith('Before ``new`` after.\n');
    });

    it('cancels edit on Escape key and restores original view without calling onChange', () => {
      const initial = 'Original content before escape.\n';
      const onChange = vi.fn();

      act(() => {
        root.render(
          React.createElement(WysiwygView, {
            source: initial,
            onChange
          })
        );
      });

      const block = container.querySelector('[data-testid="wysiwyg-editable-block"]') as HTMLElement;
      act(() => {
        block.focus();
      });

      block.textContent = 'Dirty modified content.';

      act(() => {
        block.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        );
      });

      expect(onChange).not.toHaveBeenCalled();
      // View is restored
      expect(container.textContent).toContain('Original content before escape.');
    });

    it('prevents default and commits on Enter key without creating illegal nested DOM', () => {
      const initial = 'Line before enter.\n';
      const onChange = vi.fn();

      act(() => {
        root.render(
          React.createElement(WysiwygView, {
            source: initial,
            onChange
          })
        );
      });

      const block = container.querySelector('[data-testid="wysiwyg-editable-block"]') as HTMLElement;
      act(() => {
        block.focus();
      });

      block.textContent = 'Line after enter.';

      let enterEvent: KeyboardEvent;
      act(() => {
        enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        block.dispatchEvent(enterEvent);
      });

      expect(enterEvent!.defaultPrevented).toBe(true);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith('Line after enter.\n');
      expect(block.querySelectorAll('p, div')).toHaveLength(0);
    });

    it('forbids onChange when readOnly is true', () => {
      const initial = '# ReadOnly Title\n\nReadOnly text.\n';
      const onChange = vi.fn();

      act(() => {
        root.render(
          React.createElement(WysiwygView, {
            source: initial,
            onChange,
            readOnly: true
          })
        );
      });

      const blocks = container.querySelectorAll('[data-testid="wysiwyg-editable-block"]');
      expect(blocks).toHaveLength(2);
      blocks.forEach((b) => {
        expect((b as HTMLElement).getAttribute('contenteditable')).toBe('false');
      });

      const firstBlock = blocks[0] as HTMLElement;
      act(() => {
        firstBlock.textContent = 'Changed Title';
        firstBlock.blur();
      });

      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
