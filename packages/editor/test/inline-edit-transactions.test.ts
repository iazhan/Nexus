import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '@nexus/markdown';
import {
  createLinkEditTransaction,
  createImageEditTransaction,
  createInlineCodeEditTransaction,
  createWikiLinkEditTransaction,
  applyChangesToSource,
  getInlineNodePlainText,
  type InlineEditContext
} from '../src/index.js';

describe('P1-04D Inline Edit Transactions (Pure AST & SourceRange)', () => {
  describe('A. Link Edit Transactions', () => {
    it('updates link destination and replaces only target SourceRange', () => {
      const source = 'Prefix [Nexus Home](https://nexus.dev) suffix.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const linkNode = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;
      expect(linkNode).toBeDefined();

      const context: InlineEditContext = {
        nodeType: 'link',
        range: { from: linkNode.range.from, to: linkNode.range.to },
        raw: linkNode.raw,
        source
      };

      const tx = createLinkEditTransaction(source, context, {
        label: 'Nexus Home',
        destination: 'https://nexus.dev/docs'
      });

      expect(tx).not.toBeNull();
      expect(tx!.changes).toHaveLength(1);
      expect(tx!.changes[0]).toEqual({
        from: linkNode.range.from,
        to: linkNode.range.to,
        insert: '[Nexus Home](https://nexus.dev/docs)'
      });

      const nextSource = applyChangesToSource(source, tx!.changes);
      expect(nextSource).toBe('Prefix [Nexus Home](https://nexus.dev/docs) suffix.');
      expect(tx!.userEvent).toBe('link.edit');
    });

    it('updates only the second link when two identical links exist in document', () => {
      const source = 'Check [Doc](https://nexus.dev) and later [Doc](https://nexus.dev) again.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const links = ('children' in p ? p.children : []).filter((c) => c.type === 'link');
      expect(links).toHaveLength(2);

      const targetLink = links[1]!;
      const context: InlineEditContext = {
        nodeType: 'link',
        range: { from: targetLink.range.from, to: targetLink.range.to },
        raw: targetLink.raw,
        source
      };

      const tx = createLinkEditTransaction(source, context, {
        label: 'API Reference',
        destination: 'https://nexus.dev/api'
      });

      expect(tx).not.toBeNull();
      expect(tx!.changes[0]!.from).toBe(targetLink.range.from);
      expect(tx!.changes[0]!.to).toBe(targetLink.range.to);

      const nextSource = applyChangesToSource(source, tx!.changes);
      expect(nextSource).toBe('Check [Doc](https://nexus.dev) and later [API Reference](https://nexus.dev/api) again.');
    });

    it('preserves byte-level raw label slice when label text is not modified', () => {
      const source = 'Go to [**Bold** `Code` Label](https://nexus.dev/start "Getting Started").';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const context: InlineEditContext = {
        nodeType: 'link',
        range: { from: link.range.from, to: link.range.to },
        raw: link.raw,
        source
      };

      // Plaintext is "Bold Code Label"; user only changes destination
      const tx = createLinkEditTransaction(source, context, {
        label: 'Bold Code Label',
        destination: 'https://nexus.dev/updated',
        title: 'Getting Started'
      });

      expect(tx).not.toBeNull();
      const nextSource = applyChangesToSource(source, tx!.changes);
      // Notice: [**Bold** `Code` Label] formatting slice is preserved byte-for-byte!
      expect(nextSource).toBe('Go to [**Bold** `Code` Label](https://nexus.dev/updated "Getting Started").');
    });

    it('escapes brackets when user explicitly edits link label to avoid Markdown injection', () => {
      const source = 'Visit [Nexus](https://nexus.dev).';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const context: InlineEditContext = {
        nodeType: 'link',
        range: { from: link.range.from, to: link.range.to },
        raw: link.raw,
        source
      };

      const tx = createLinkEditTransaction(source, context, {
        label: 'Nexus [Core] Hub](injection)',
        destination: 'https://nexus.dev'
      });

      expect(tx).not.toBeNull();
      const nextSource = applyChangesToSource(source, tx!.changes);
      // Brackets inside label must be escaped
      expect(nextSource).toBe('Visit [Nexus \\[Core\\] Hub\\](injection)](https://nexus.dev).');

      // Must re-parse into a single valid link node covering the updated interval
      const reparsed = parseMarkdown(nextSource);
      const pNode = reparsed.root.children[0];
      expect(pNode?.type).toBe('paragraph');
      if (pNode && pNode.type === 'paragraph') {
        const linkAfter = pNode.children.find((c) => c.type === 'link');
        expect(linkAfter).toBeDefined();
        expect(linkAfter?.range.from).toBe(6);
      }
    });

    it('preserves single quotes and parentheses title delimiters', () => {
      // 1. Single quotes 'title'
      const sourceSingle = "Visit [Nexus](https://nexus.dev 'Official Single').";
      const parsedSingle = parseMarkdown(sourceSingle);
      const pSingle = parsedSingle.root.children[0]!;
      const linkSingle = ('children' in pSingle ? pSingle.children : []).find(
        (c) => c.type === 'link'
      )!;

      const txSingle = createLinkEditTransaction(
        sourceSingle,
        {
          nodeType: 'link',
          range: { from: linkSingle.range.from, to: linkSingle.range.to },
          raw: linkSingle.raw,
          source: sourceSingle
        },
        {
          label: 'Nexus Hub',
          destination: 'https://nexus.dev/hub',
          title: 'Official Single'
        }
      );
      expect(txSingle).not.toBeNull();
      expect(applyChangesToSource(sourceSingle, txSingle!.changes)).toBe(
        "Visit [Nexus Hub](https://nexus.dev/hub 'Official Single')."
      );

      // 2. Parentheses (title)
      const sourceParen = 'Visit [Nexus](https://nexus.dev (Official Paren)).';
      const parsedParen = parseMarkdown(sourceParen);
      const pParen = parsedParen.root.children[0]!;
      const linkParen = ('children' in pParen ? pParen.children : []).find(
        (c) => c.type === 'link'
      )!;

      const txParen = createLinkEditTransaction(
        sourceParen,
        {
          nodeType: 'link',
          range: { from: linkParen.range.from, to: linkParen.range.to },
          raw: linkParen.raw,
          source: sourceParen
        },
        {
          label: 'Nexus Hub',
          destination: 'https://nexus.dev/hub',
          title: 'Official Paren'
        }
      );
      expect(txParen).not.toBeNull();
      expect(applyChangesToSource(sourceParen, txParen!.changes)).toBe(
        'Visit [Nexus Hub](https://nexus.dev/hub (Official Paren)).'
      );
    });

    it('preserves angle bracket destination style and whitespace', () => {
      const source = 'See [Angle Link](  <https://nexus.dev/with spaces>  ).';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const context: InlineEditContext = {
        nodeType: 'link',
        range: { from: link.range.from, to: link.range.to },
        raw: link.raw,
        source
      };

      const tx = createLinkEditTransaction(source, context, {
        label: 'Angle Link',
        destination: 'https://nexus.dev/new spaces',
        syntax: 'angle'
      });

      expect(tx).not.toBeNull();
      const nextSource = applyChangesToSource(source, tx!.changes);
      expect(nextSource).toBe('See [Angle Link](  <https://nexus.dev/new spaces>  ).');
    });

    it('returns null when values are identical, maintaining byte-level raw fidelity', () => {
      const source = 'See [Exact](https://nexus.dev "Title").';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const context: InlineEditContext = {
        nodeType: 'link',
        range: { from: link.range.from, to: link.range.to },
        raw: link.raw,
        source
      };

      const tx = createLinkEditTransaction(source, context, {
        label: 'Exact',
        destination: 'https://nexus.dev',
        title: 'Title'
      });

      expect(tx).toBeNull();
    });

    it('rejects when context.source does not match current source', () => {
      const source = 'Click [Original](https://safe.com) here.';
      const context: InlineEditContext = {
        nodeType: 'link',
        range: { from: 6, to: 34 },
        raw: '[Original](https://safe.com)',
        source: 'Different source content entirely'
      };

      const tx = createLinkEditTransaction(source, context, {
        label: 'New',
        destination: 'https://safe.com/docs'
      });

      expect(tx).toBeNull();
    });

    it('rejects unsafe javascript: protocol and returns null', () => {
      const source = 'Click [XSS](https://safe.com) here.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const context: InlineEditContext = {
        nodeType: 'link',
        range: { from: link.range.from, to: link.range.to },
        raw: link.raw,
        source
      };

      const tx = createLinkEditTransaction(source, context, {
        label: 'XSS',
        destination: 'javascript:alert(1)'
      });

      expect(tx).toBeNull();
    });

    it('rejects CRLF newline injection in destination or title', () => {
      const source = 'Click [Test](https://safe.com) here.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const context: InlineEditContext = {
        nodeType: 'link',
        range: { from: link.range.from, to: link.range.to },
        raw: link.raw,
        source
      };

      const tx = createLinkEditTransaction(source, context, {
        label: 'Test',
        destination: 'https://safe.com\r\nBad-Header: true'
      });

      expect(tx).toBeNull();
    });
  });

  describe('B. Image Edit Transactions', () => {
    it('modifies image alt text accurately with structural bracket escaping', () => {
      const source = 'Photo: ![Old Alt](https://nexus.dev/pic.png)';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const img = ('children' in p ? p.children : []).find((c) => c.type === 'image')!;

      const context: InlineEditContext = {
        nodeType: 'image',
        range: { from: img.range.from, to: img.range.to },
        raw: img.raw,
        source
      };

      const tx = createImageEditTransaction(source, context, {
        alt: 'New [Alt] Text](injection)',
        destination: 'https://nexus.dev/pic.png'
      });

      expect(tx).not.toBeNull();
      const nextSource = applyChangesToSource(source, tx!.changes);
      expect(nextSource).toBe('Photo: ![New \\[Alt\\] Text\\](injection)](https://nexus.dev/pic.png)');
      expect(tx!.userEvent).toBe('image.edit');

      // Verify re-parsing
      const reparsed = parseMarkdown(nextSource);
      const pNode = reparsed.root.children[0];
      expect(pNode?.type).toBe('paragraph');
      if (pNode && pNode.type === 'paragraph') {
        const imgAfter = pNode.children.find((c) => c.type === 'image');
        expect(imgAfter).toBeDefined();
        expect(imgAfter?.range.from).toBe(7);
      }
    });

    it('modifies image source and title preserving quote style', () => {
      const source = "Diagram: ![Arch](./arch.png 'Single Title')";
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const img = ('children' in p ? p.children : []).find((c) => c.type === 'image')!;

      const context: InlineEditContext = {
        nodeType: 'image',
        range: { from: img.range.from, to: img.range.to },
        raw: img.raw,
        source
      };

      const tx = createImageEditTransaction(source, context, {
        alt: 'Arch',
        destination: './new-arch.png',
        title: 'New Title'
      });

      expect(tx).not.toBeNull();
      const nextSource = applyChangesToSource(source, tx!.changes);
      expect(nextSource).toBe("Diagram: ![Arch](./new-arch.png 'New Title')");
    });

    it('rejects when context.source does not match current source', () => {
      const source = '![Pic](./pic.png)';
      const context: InlineEditContext = {
        nodeType: 'image',
        range: { from: 0, to: 17 },
        raw: '![Pic](./pic.png)',
        source: 'Outdated source'
      };

      const tx = createImageEditTransaction(source, context, {
        alt: 'New Pic',
        destination: './new-pic.png'
      });

      expect(tx).toBeNull();
    });

    it('rejects CRLF newline injection in image alt or destination', () => {
      const source = '![Pic](./pic.png)';
      const context: InlineEditContext = {
        nodeType: 'image',
        range: { from: 0, to: 17 },
        raw: '![Pic](./pic.png)',
        source
      };

      expect(createImageEditTransaction(source, context, {
        alt: 'Pic\nNewline',
        destination: './new.png'
      })).toBeNull();

      expect(createImageEditTransaction(source, context, {
        alt: 'Pic',
        destination: './new.png\r\n'
      })).toBeNull();
    });
  });

  describe('C. Inline Code Edit Transactions', () => {
    it('modifies inline code and automatically expands backtick count if value contains backticks', () => {
      const source = 'Run `npm test` here.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const codeNode = ('children' in p ? p.children : []).find((c) => c.type === 'inline-code')!;

      const context: InlineEditContext = {
        nodeType: 'inline-code',
        range: { from: codeNode.range.from, to: codeNode.range.to },
        raw: codeNode.raw,
        source
      };

      // Value contains a single backtick, so delimiters must expand to 2 backticks and space padding
      const tx = createInlineCodeEditTransaction(source, context, {
        value: 'npm `run` test'
      });

      expect(tx).not.toBeNull();
      const nextSource = applyChangesToSource(source, tx!.changes);
      expect(nextSource).toBe('Run `` npm `run` test `` here.');
      expect(tx!.userEvent).toBe('code.edit');

      // Verify AST roundtrip
      const reparsed = parseMarkdown(nextSource);
      const pNode = reparsed.root.children[0];
      expect(pNode?.type).toBe('paragraph');
      if (pNode && pNode.type === 'paragraph') {
        const codeAfter = pNode.children.find((c) => c.type === 'inline-code');
        expect(codeAfter).toBeDefined();
        if (codeAfter && codeAfter.type === 'inline-code') {
          expect(codeAfter.value).toBe('npm `run` test');
        }
      }
    });

    it('rejects CR/LF newlines in inline code value', () => {
      const source = 'Run `code` here.';
      const context: InlineEditContext = {
        nodeType: 'inline-code',
        range: { from: 4, to: 10 },
        raw: '`code`',
        source
      };

      expect(createInlineCodeEditTransaction(source, context, { value: 'line1\nline2' })).toBeNull();
    });

    it('rejects when context.source does not match current source', () => {
      const source = 'Run `code` here.';
      const context: InlineEditContext = {
        nodeType: 'inline-code',
        range: { from: 4, to: 10 },
        raw: '`code`',
        source: 'Stale source'
      };

      expect(createInlineCodeEditTransaction(source, context, { value: 'new' })).toBeNull();
    });
  });

  describe('D. WikiLink Edit Transactions', () => {
    it('modifies target and alias of WikiLink', () => {
      const source = 'See [[OldTarget|OldAlias]] link.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const wiki = ('children' in p ? p.children : []).find((c) => c.type === 'wikilink')!;

      const context: InlineEditContext = {
        nodeType: 'wikilink',
        range: { from: wiki.range.from, to: wiki.range.to },
        raw: wiki.raw,
        source
      };

      const tx = createWikiLinkEditTransaction(source, context, {
        target: 'NewTarget',
        alias: 'NewAlias'
      });

      expect(tx).not.toBeNull();
      const nextSource = applyChangesToSource(source, tx!.changes);
      expect(nextSource).toBe('See [[NewTarget|NewAlias]] link.');
      expect(tx!.userEvent).toBe('wikilink.edit');

      // Verify AST roundtrip
      const reparsed = parseMarkdown(nextSource);
      const pNode = reparsed.root.children[0];
      if (pNode && pNode.type === 'paragraph') {
        const wikiAfter = pNode.children.find((c) => c.type === 'wikilink');
        expect(wikiAfter).toBeDefined();
        if (wikiAfter && wikiAfter.type === 'wikilink') {
          expect(wikiAfter.target).toBe('NewTarget');
          expect(wikiAfter.alias).toBe('NewAlias');
        }
      }
    });

    it('can remove alias from WikiLink [[Target|Alias]] to [[Target]]', () => {
      const source = 'See [[Doc|Documentation]] link.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const wiki = ('children' in p ? p.children : []).find((c) => c.type === 'wikilink')!;

      const context: InlineEditContext = {
        nodeType: 'wikilink',
        range: { from: wiki.range.from, to: wiki.range.to },
        raw: wiki.raw,
        source
      };

      const tx = createWikiLinkEditTransaction(source, context, {
        target: 'Doc'
      });

      expect(tx).not.toBeNull();
      const nextSource = applyChangesToSource(source, tx!.changes);
      expect(nextSource).toBe('See [[Doc]] link.');
    });

    it('rejects brackets, newlines, and empty target in WikiLink', () => {
      const source = 'See [[Doc]] link.';
      const context: InlineEditContext = {
        nodeType: 'wikilink',
        range: { from: 4, to: 11 },
        raw: '[[Doc]]',
        source
      };

      expect(createWikiLinkEditTransaction(source, context, { target: '' })).toBeNull();
      expect(createWikiLinkEditTransaction(source, context, { target: 'Doc[Bad]' })).toBeNull();
      expect(createWikiLinkEditTransaction(source, context, { target: 'Doc\nBad' })).toBeNull();
      expect(createWikiLinkEditTransaction(source, context, { target: 'Doc', alias: 'Alias]Bad' })).toBeNull();
    });

    it('rejects when context.source does not match current source', () => {
      const source = 'See [[Doc]] link.';
      const context: InlineEditContext = {
        nodeType: 'wikilink',
        range: { from: 4, to: 11 },
        raw: '[[Doc]]',
        source: 'Stale'
      };

      expect(createWikiLinkEditTransaction(source, context, { target: 'Doc2' })).toBeNull();
    });
  });

  describe('E. Nested AST Nodes (List, Table, Bold, Italic)', () => {
    function findFirstNode(root: unknown, type: string): MarkdownInlineNode | null {
      let found: MarkdownInlineNode | null = null;
      function walk(n: unknown) {
        if (!n || typeof n !== 'object' || found) return;
        const rec = n as Record<string, unknown>;
        if (rec.type === type) {
          found = n as MarkdownInlineNode;
          return;
        }
        if (Array.isArray(rec.children)) for (const c of rec.children) walk(c);
        if (Array.isArray(rec.items)) for (const it of rec.items) walk(it);
        if (Array.isArray(rec.headers)) {
          for (const row of rec.headers) {
            if (Array.isArray(row)) for (const c of row) walk(c);
          }
        }
        if (Array.isArray(rec.rows)) {
          for (const row of rec.rows) {
            if (Array.isArray(row)) {
              for (const cList of row) {
                if (Array.isArray(cList)) for (const c of cList) walk(c);
              }
            }
          }
        }
      }
      walk(root);
      return found;
    }

    it('updates link inside list item without being rejected as extra node', () => {
      const source = '- Item with [List Link](https://nexus.dev) text.';
      const parsed = parseMarkdown(source);
      const link = findFirstNode(parsed.root, 'link')!;
      expect(link).toBeDefined();

      const tx = createLinkEditTransaction(
        source,
        {
          nodeType: 'link',
          range: { from: link.range.from, to: link.range.to },
          raw: link.raw,
          source
        },
        {
          label: 'List Link',
          destination: 'https://nexus.dev/updated'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('- Item with [List Link](https://nexus.dev/updated) text.');
    });

    it('updates image inside nested list item', () => {
      const source = '- Parent list\n  - Subitem with ![Nested Img](./sub.png) end.';
      const parsed = parseMarkdown(source);
      const img = findFirstNode(parsed.root, 'image')!;
      expect(img).toBeDefined();

      const tx = createImageEditTransaction(
        source,
        {
          nodeType: 'image',
          range: { from: img.range.from, to: img.range.to },
          raw: img.raw,
          source
        },
        {
          alt: 'Nested Img',
          destination: './sub-new.png'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('- Parent list\n  - Subitem with ![Nested Img](./sub-new.png) end.');
    });

    it('updates inline code nested inside bold formatting', () => {
      const source = 'See **bold `my_fn()` call** here.';
      const parsed = parseMarkdown(source);
      const code = findFirstNode(parsed.root, 'inline-code')!;
      expect(code).toBeDefined();

      const tx = createInlineCodeEditTransaction(
        source,
        {
          nodeType: 'inline-code',
          range: { from: code.range.from, to: code.range.to },
          raw: code.raw,
          source
        },
        {
          value: 'other_fn()'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('See **bold `other_fn()` call** here.');
    });

    it('updates WikiLink nested inside italic formatting', () => {
      const source = 'Check *italic [[TargetPage|OldAlias]] link* now.';
      const parsed = parseMarkdown(source);
      const wiki = findFirstNode(parsed.root, 'wikilink')!;
      expect(wiki).toBeDefined();

      const tx = createWikiLinkEditTransaction(
        source,
        {
          nodeType: 'wikilink',
          range: { from: wiki.range.from, to: wiki.range.to },
          raw: wiki.raw,
          source
        },
        {
          target: 'TargetPage',
          alias: 'NewAlias'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('Check *italic [[TargetPage|NewAlias]] link* now.');
    });

    it('updates link inside table cell', () => {
      const source = '| Col A |\n| --- |\n| [Cell Link](https://old.dev) |';
      const parsed = parseMarkdown(source);
      const link = findFirstNode(parsed.root, 'link')!;
      expect(link).toBeDefined();

      const tx = createLinkEditTransaction(
        source,
        {
          nodeType: 'link',
          range: { from: link.range.from, to: link.range.to },
          raw: link.raw,
          source
        },
        {
          label: 'Cell Link',
          destination: 'https://new.dev'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('| Col A |\n| --- |\n| [Cell Link](https://new.dev) |');
    });
  });

  describe('F. Autolink and Reference-Style Links and Images', () => {
    it('editing destination of an autolink preserves autolink syntax', () => {
      const source = 'Visit <https://nexus.dev> here.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const tx = createLinkEditTransaction(
        source,
        {
          nodeType: 'link',
          range: { from: link.range.from, to: link.range.to },
          raw: link.raw,
          source
        },
        {
          label: 'https://nexus.dev',
          destination: 'https://nexus.dev/v2'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('Visit <https://nexus.dev/v2> here.');
    });

    it('editing label of an autolink converts it into an inline link', () => {
      const source = 'Visit <https://nexus.dev> here.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const tx = createLinkEditTransaction(
        source,
        {
          nodeType: 'link',
          range: { from: link.range.from, to: link.range.to },
          raw: link.raw,
          source
        },
        {
          label: 'Nexus Official',
          destination: 'https://nexus.dev'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('Visit [Nexus Official](https://nexus.dev) here.');
    });

    it('reference-style link rejects destination edit within local SourceRange', () => {
      const source = 'See [My Link][ref1] here.\n\n[ref1]: https://nexus.dev';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const tx = createLinkEditTransaction(
        source,
        {
          nodeType: 'link',
          range: { from: link.range.from, to: link.range.to },
          raw: link.raw,
          source
        },
        {
          label: 'My Link',
          destination: 'https://other.dev'
        }
      );

      // Destination is defined elsewhere; cannot silently mutate local range into inline link
      expect(tx).toBeNull();
    });

    it('reference-style link permits updating label within local SourceRange', () => {
      const source = 'See [My Link][ref1] here.\n\n[ref1]: https://nexus.dev';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const tx = createLinkEditTransaction(
        source,
        {
          nodeType: 'link',
          range: { from: link.range.from, to: link.range.to },
          raw: link.raw,
          source
        },
        {
          label: 'Updated Link',
          destination: 'https://nexus.dev'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('See [Updated Link][ref1] here.\n\n[ref1]: https://nexus.dev');
    });

    it('reference-style image rejects destination edit within local SourceRange', () => {
      const source = 'Photo: ![My Alt][img1] here.\n\n[img1]: ./photo.png';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const img = ('children' in p ? p.children : []).find((c) => c.type === 'image')!;

      const tx = createImageEditTransaction(
        source,
        {
          nodeType: 'image',
          range: { from: img.range.from, to: img.range.to },
          raw: img.raw,
          source
        },
        {
          alt: 'My Alt',
          destination: './new.png'
        }
      );

      expect(tx).toBeNull();
    });

    it('reference-style image permits updating alt within local SourceRange', () => {
      const source = 'Photo: ![My Alt][img1] here.\n\n[img1]: ./photo.png';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const img = ('children' in p ? p.children : []).find((c) => c.type === 'image')!;

      const tx = createImageEditTransaction(
        source,
        {
          nodeType: 'image',
          range: { from: img.range.from, to: img.range.to },
          raw: img.raw,
          source
        },
        {
          alt: 'New Alt',
          destination: './photo.png'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('Photo: ![New Alt][img1] here.\n\n[img1]: ./photo.png');
    });
  });

  describe('G. WikiLink Semantic Validation & Whitespace Fidelity', () => {
    it('rejects target containing pipe character', () => {
      const source = 'See [[ValidTarget]] link.';
      const context: InlineEditContext = {
        nodeType: 'wikilink',
        range: { from: 4, to: 19 },
        raw: '[[ValidTarget]]',
        source
      };

      expect(createWikiLinkEditTransaction(source, context, { target: 'A|B' })).toBeNull();
    });

    it('rejects target with leading or trailing whitespace', () => {
      const source = 'See [[ValidTarget]] link.';
      const context: InlineEditContext = {
        nodeType: 'wikilink',
        range: { from: 4, to: 19 },
        raw: '[[ValidTarget]]',
        source
      };

      expect(createWikiLinkEditTransaction(source, context, { target: '  Target  ' })).toBeNull();
    });

    it('rejects alias with whitespace-only value', () => {
      const source = 'See [[ValidTarget]] link.';
      const context: InlineEditContext = {
        nodeType: 'wikilink',
        range: { from: 4, to: 19 },
        raw: '[[ValidTarget]]',
        source
      };

      expect(createWikiLinkEditTransaction(source, context, { target: 'ValidTarget', alias: '   ' })).toBeNull();
    });

    it('preserves whitespace around unmodified target when editing alias', () => {
      const source = 'See [[  TargetPage  |  OldAlias  ]] link.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const wiki = ('children' in p ? p.children : []).find((c) => c.type === 'wikilink')!;

      const tx = createWikiLinkEditTransaction(
        source,
        {
          nodeType: 'wikilink',
          range: { from: wiki.range.from, to: wiki.range.to },
          raw: wiki.raw,
          source
        },
        {
          target: 'TargetPage',
          alias: 'NewAlias'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('See [[  TargetPage  |  NewAlias  ]] link.');
    });
  });

  describe('H. Comprehensive Inline Code Boundary Cases', () => {
    it('handles runs of 2 consecutive backticks in content', () => {
      const source = 'Run `code` here.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const code = ('children' in p ? p.children : []).find((c) => c.type === 'inline-code')!;

      const tx = createInlineCodeEditTransaction(
        source,
        {
          nodeType: 'inline-code',
          range: { from: code.range.from, to: code.range.to },
          raw: code.raw,
          source
        },
        {
          value: 'a `` b'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('Run ``` a `` b ``` here.');
      const reparsed = parseMarkdown(next);
      const pNode1 = reparsed.root.children[0];
      const node1 = pNode1 && 'children' in pNode1 ? pNode1.children.find((c) => c.type === 'inline-code') : undefined;
      expect(node1 && 'value' in node1 ? node1.value : undefined).toBe('a `` b');
    });

    it('handles runs of 3 consecutive backticks in content', () => {
      const source = 'Run `code` here.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const code = ('children' in p ? p.children : []).find((c) => c.type === 'inline-code')!;

      const tx = createInlineCodeEditTransaction(
        source,
        {
          nodeType: 'inline-code',
          range: { from: code.range.from, to: code.range.to },
          raw: code.raw,
          source
        },
        {
          value: 'a ``` b'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('Run ```` a ``` b ```` here.');
      const reparsed = parseMarkdown(next);
      const pNode2 = reparsed.root.children[0];
      const node2 = pNode2 && 'children' in pNode2 ? pNode2.children.find((c) => c.type === 'inline-code') : undefined;
      expect(node2 && 'value' in node2 ? node2.value : undefined).toBe('a ``` b');
    });

    it('handles value starting and ending with backtick', () => {
      const source = 'Run `code` here.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const code = ('children' in p ? p.children : []).find((c) => c.type === 'inline-code')!;

      const tx = createInlineCodeEditTransaction(
        source,
        {
          nodeType: 'inline-code',
          range: { from: code.range.from, to: code.range.to },
          raw: code.raw,
          source
        },
        {
          value: '`wrapped`'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('Run `` `wrapped` `` here.');
      const reparsed = parseMarkdown(next);
      const pNode3 = reparsed.root.children[0];
      const node3 = pNode3 && 'children' in pNode3 ? pNode3.children.find((c) => c.type === 'inline-code') : undefined;
      expect(node3 && 'value' in node3 ? node3.value : undefined).toBe('`wrapped`');
    });

    it('handles value with leading and trailing spaces without losing them', () => {
      const source = 'Run `code` here.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const code = ('children' in p ? p.children : []).find((c) => c.type === 'inline-code')!;

      const tx = createInlineCodeEditTransaction(
        source,
        {
          nodeType: 'inline-code',
          range: { from: code.range.from, to: code.range.to },
          raw: code.raw,
          source
        },
        {
          value: '  padded  '
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      const reparsed = parseMarkdown(next);
      const pNode4 = reparsed.root.children[0];
      const node4 = pNode4 && 'children' in pNode4 ? pNode4.children.find((c) => c.type === 'inline-code') : undefined;
      expect(node4 && 'value' in node4 ? node4.value : undefined).toBe('  padded  ');
    });

    it('handles value consisting entirely of spaces', () => {
      const source = 'Run `code` here.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const code = ('children' in p ? p.children : []).find((c) => c.type === 'inline-code')!;

      const tx = createInlineCodeEditTransaction(
        source,
        {
          nodeType: 'inline-code',
          range: { from: code.range.from, to: code.range.to },
          raw: code.raw,
          source
        },
        {
          value: '   '
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      const reparsed = parseMarkdown(next);
      const pNode5 = reparsed.root.children[0];
      const node5 = pNode5 && 'children' in pNode5 ? pNode5.children.find((c) => c.type === 'inline-code') : undefined;
      expect(node5 && 'value' in node5 ? node5.value : undefined).toBe('   ');
    });

    it('returns null and leaves raw unchanged when value is unmodified', () => {
      const source = 'Run ````  orig code  ```` here.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const code = ('children' in p ? p.children : []).find((c) => c.type === 'inline-code')!;

      const tx = createInlineCodeEditTransaction(
        source,
        {
          nodeType: 'inline-code',
          range: { from: code.range.from, to: code.range.to },
          raw: code.raw,
          source
        },
        {
          value: code.value
        }
      );

      expect(tx).toBeNull();
    });
  });

  describe('I. Plain-Text Link Label Contract and Markdown Inline Delimiter Escaping', () => {
    it('treats label as plain text escaping inline markdown delimiters (*, _, `, $, [[...]], <tag>, \\, CJK, Emoji)', () => {
      const source = 'See [Original](https://example.com) now.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const complexPlainLabel = '*star* and _under_ and `code` and $math$ and [[Wiki]] and <tag> and foo\\bar and 中文 and 🎉 and ~~strike~~';
      const tx = createLinkEditTransaction(
        source,
        {
          nodeType: 'link',
          range: { from: link.range.from, to: link.range.to },
          raw: link.raw,
          source
        },
        {
          label: complexPlainLabel,
          destination: 'https://example.com'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      const reparsed = parseMarkdown(next);
      const pNode = reparsed.root.children[0]!;
      const reparsedLink = ('children' in pNode ? pNode.children : []).find((c) => c.type === 'link')!;
      expect(reparsedLink).toBeDefined();

      // Crucial requirement: candidate AST must have getInlineNodePlainText matching user's requested plain label
      expect(getInlineNodePlainText(reparsedLink)).toBe(complexPlainLabel);
    });

    it('preserves rich label byte-for-byte when label is unmodified', () => {
      const source = 'Visit [**bold** and _italic_](https://nexus.dev) here.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const tx = createLinkEditTransaction(
        source,
        {
          nodeType: 'link',
          range: { from: link.range.from, to: link.range.to },
          raw: link.raw,
          source
        },
        {
          label: getInlineNodePlainText(link),
          destination: 'https://nexus.dev/updated'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('Visit [**bold** and _italic_](https://nexus.dev/updated) here.');
    });
  });

  describe('J. parseLocalParenDescriptor Finite-State Local Scanner', () => {
    it('preserves normal destination with balanced parentheses without forcing angle brackets', () => {
      const source = 'Go to [Wiki](https://en.wikipedia.org/wiki/Nexus_(disambiguation)) please.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const tx = createLinkEditTransaction(
        source,
        {
          nodeType: 'link',
          range: { from: link.range.from, to: link.range.to },
          raw: link.raw,
          source
        },
        {
          label: 'Nexus Disambiguation',
          destination: 'https://en.wikipedia.org/wiki/Nexus_(disambiguation)'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      // Destination MUST NOT be forcibly wrapped into angle brackets <...>
      expect(next).toBe('Go to [Nexus Disambiguation](https://en.wikipedia.org/wiki/Nexus_(disambiguation)) please.');
    });

    it('handles escaped parentheses inside normal destination', () => {
      const source = 'Go to [Link](https://example.com/foo\\(bar\\)) please.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const tx = createLinkEditTransaction(
        source,
        {
          nodeType: 'link',
          range: { from: link.range.from, to: link.range.to },
          raw: link.raw,
          source
        },
        {
          label: 'New Link',
          destination: 'https://example.com/foo\\(bar\\)'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('Go to [New Link](https://example.com/foo\\(bar\\)) please.');
    });

    it('handles escaped quotes and parentheses in title', () => {
      const source = 'Go to [Link](https://example.com "Title with \\"quotes\\" and (parens)") please.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const tx = createLinkEditTransaction(
        source,
        {
          nodeType: 'link',
          range: { from: link.range.from, to: link.range.to },
          raw: link.raw,
          source
        },
        {
          label: 'Updated Link',
          destination: 'https://example.com',
          title: 'Title with "quotes" and (parens)'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('Go to [Updated Link](https://example.com "Title with \\"quotes\\" and (parens)") please.');
    });

    it('handles tabs and CRLF document line breaks', () => {
      const source = 'Go to [Link](https://example.com\t\t"Tabbed Title")\r\nnext line.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const tx = createLinkEditTransaction(
        source,
        {
          nodeType: 'link',
          range: { from: link.range.from, to: link.range.to },
          raw: link.raw,
          source
        },
        {
          label: 'Updated Link',
          destination: 'https://example.com',
          title: 'Tabbed Title'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('Go to [Updated Link](https://example.com\t\t"Tabbed Title")\r\nnext line.');
    });
  });

  describe('K. Reference-Style Links and Images Full vs Collapsed vs Shortcut', () => {
    it('full reference [label][id] permits updating label while preserving [id]', () => {
      const source = 'Check [Old Label][doc1] now.\n\n[doc1]: https://nexus.dev';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const tx = createLinkEditTransaction(
        source,
        {
          nodeType: 'link',
          range: { from: link.range.from, to: link.range.to },
          raw: link.raw,
          source
        },
        {
          label: 'New Label',
          destination: link.href
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      expect(next).toBe('Check [New Label][doc1] now.\n\n[doc1]: https://nexus.dev');
    });

    it('full reference [label][id] rejects title edit', () => {
      const source = 'Check [Old Label][doc1] now.\n\n[doc1]: https://nexus.dev "Doc Title"';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const tx = createLinkEditTransaction(
        source,
        {
          nodeType: 'link',
          range: { from: link.range.from, to: link.range.to },
          raw: link.raw,
          source
        },
        {
          label: 'Old Label',
          destination: link.href,
          title: 'Modified Title'
        }
      );

      expect(tx).toBeNull();
    });

    it('collapsed reference [label][] rejects label edit', () => {
      const source = 'Check [doc1][] now.\n\n[doc1]: https://nexus.dev';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const tx = createLinkEditTransaction(
        source,
        {
          nodeType: 'link',
          range: { from: link.range.from, to: link.range.to },
          raw: link.raw,
          source
        },
        {
          label: 'doc2',
          destination: link.href
        }
      );

      expect(tx).toBeNull();
    });

    it('shortcut reference [label] rejects label edit', () => {
      const source = 'Check [doc1] now.\n\n[doc1]: https://nexus.dev';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const link = ('children' in p ? p.children : []).find((c) => c.type === 'link')!;

      const tx = createLinkEditTransaction(
        source,
        {
          nodeType: 'link',
          range: { from: link.range.from, to: link.range.to },
          raw: link.raw,
          source
        },
        {
          label: 'doc2',
          destination: link.href
        }
      );

      expect(tx).toBeNull();
    });

    it('collapsed and shortcut reference image reject alt edit', () => {
      const source1 = 'Check ![logo][] now.\n\n[logo]: /img.png';
      const parsed1 = parseMarkdown(source1);
      const img1 = ('children' in parsed1.root.children[0]! ? parsed1.root.children[0]!.children : []).find((c) => c.type === 'image')!;

      const tx1 = createImageEditTransaction(
        source1,
        {
          nodeType: 'image',
          range: { from: img1.range.from, to: img1.range.to },
          raw: img1.raw,
          source: source1
        },
        {
          alt: 'newlogo',
          destination: img1.src
        }
      );
      expect(tx1).toBeNull();

      const source2 = 'Check ![logo] now.\n\n[logo]: /img.png';
      const parsed2 = parseMarkdown(source2);
      const img2 = ('children' in parsed2.root.children[0]! ? parsed2.root.children[0]!.children : []).find((c) => c.type === 'image')!;

      const tx2 = createImageEditTransaction(
        source2,
        {
          nodeType: 'image',
          range: { from: img2.range.from, to: img2.range.to },
          raw: img2.raw,
          source: source2
        },
        {
          alt: 'newlogo',
          destination: img2.src
        }
      );
      expect(tx2).toBeNull();
    });
  });

  describe('L. Inline Code Fence Length Preservation & Expansion', () => {
    it('preserves original 3-backtick fence when editing content if internal run does not exceed fence', () => {
      const source = 'Run ``` old ``` here.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const code = ('children' in p ? p.children : []).find((c) => c.type === 'inline-code')!;

      const tx = createInlineCodeEditTransaction(
        source,
        {
          nodeType: 'inline-code',
          range: { from: code.range.from, to: code.range.to },
          raw: code.raw,
          source
        },
        {
          value: 'new'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      // MUST preserve original 3-backtick fence and NOT downgrade to single backtick `new`!
      expect(next).toBe('Run ``` new ``` here.');
      const reparsed = parseMarkdown(next);
      const pNode = reparsed.root.children[0]!;
      const node = ('children' in pNode ? pNode.children : []).find((c) => c.type === 'inline-code')!;
      expect(node.value).toBe('new');
    });

    it('only expands fence when new value contains backticks exceeding original fence', () => {
      const source = 'Run `` old `` here.';
      const parsed = parseMarkdown(source);
      const p = parsed.root.children[0]!;
      const code = ('children' in p ? p.children : []).find((c) => c.type === 'inline-code')!;

      const tx = createInlineCodeEditTransaction(
        source,
        {
          nodeType: 'inline-code',
          range: { from: code.range.from, to: code.range.to },
          raw: code.raw,
          source
        },
        {
          value: 'a `` b'
        }
      );

      expect(tx).not.toBeNull();
      const next = applyChangesToSource(source, tx!.changes);
      // Since new value contains 2 consecutive backticks, fence must expand to 3 or 4 to strictly exceed it
      expect(next).toBe('Run ``` a `` b ``` here.');
      const reparsed = parseMarkdown(next);
      const pNode = reparsed.root.children[0]!;
      const node = ('children' in pNode ? pNode.children : []).find((c) => c.type === 'inline-code')!;
      expect(node.value).toBe('a `` b');
    });
  });
});
