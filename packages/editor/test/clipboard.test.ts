// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import {
  MarkdownDocumentSession,
  createSessionEditorView,
  setEditorReadOnly,
  createClipboardPasteTransaction,
  extractPlainTextFromHtml
} from '../src/index.js';

/**
 * 造一个只带 `files` 与 `getData` 的剪贴板。
 *
 * 不用真的 `DataTransfer`：happy-dom 的那份构造不了「带文件的粘贴」，而这里要钉的
 * 恰恰是 `files` 与 `text/plain` **同时存在**时的优先级。
 */
function clipboardWith(files: File[], text = ''): DataTransfer {
  return {
    files: { length: files.length, item: (index: number) => files[index] ?? null },
    getData: (type: string) => (type === 'text/plain' ? text : '')
  } as unknown as DataTransfer;
}

function imageFile(name = 'image.png', type = 'image/png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

/** 粘贴处理器是同步返回的，落盘那一支是异步的 —— 等一轮宏任务再看文档。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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

  /**
   * 图片落盘钩子（`files` 组）。编辑器这一层只证明「文件交出去了、回来的文本插进去了」——
   * 名字怎么算、写到哪、重名怎么办全在宿主，那些在 `packages/core` 的单测与真机用例里。
   */
  describe('C. Image Paste Hook', () => {
    it('图片交给宿主，落盘返回的引用插进文档，且不让位给剪贴板文本', async () => {
      const session = new MarkdownDocumentSession('Base: ');
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const received: File[][] = [];
      const handle = createSessionEditorView({
        session,
        surfaceId: 'paste-img-1',
        surfaceKind: 'source',
        parent,
        onPasteFiles: (files) => {
          received.push([...files]);
          return Promise.resolve('![shot](assets/pasted-1.png)');
        }
      });

      handle.view.dispatch({ selection: { anchor: 6, head: 6 } });

      // 截图粘贴时剪贴板里往往**同时**有 `text/html`（一个 `<img>`）与文本。
      // 先走文本分支的话图就没了，而用户明明看得见剪贴板里有东西。
      const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: clipboardWith([imageFile()], 'plain fallback')
      });
      handle.view.contentDOM.dispatchEvent(pasteEvent);

      expect(pasteEvent.defaultPrevented).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]?.[0]?.name).toBe('image.png');

      await flush();
      expect(session.getSnapshot().source).toBe('Base: ![shot](assets/pasted-1.png)');

      handle.destroy();
      parent.remove();
    });

    it('宿主返回 null（没有落点）时退回剪贴板文本，而不是静默什么都不发生', async () => {
      const session = new MarkdownDocumentSession('Base: ');
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'paste-img-2',
        surfaceKind: 'source',
        parent,
        onPasteFiles: () => Promise.resolve(null)
      });

      handle.view.dispatch({ selection: { anchor: 6, head: 6 } });

      const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: clipboardWith([imageFile()], 'C:\\shots\\a.png')
      });
      handle.view.contentDOM.dispatchEvent(pasteEvent);

      await flush();
      expect(session.getSnapshot().source).toBe('Base: C:\\shots\\a.png');

      handle.destroy();
      parent.remove();
    });

    it('落盘失败不外抛，也不写进文档', async () => {
      const session = new MarkdownDocumentSession('Base: ');
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const handle = createSessionEditorView({
        session,
        surfaceId: 'paste-img-3',
        surfaceKind: 'source',
        parent,
        onPasteFiles: () => Promise.reject(new Error('disk full'))
      });

      handle.view.dispatch({ selection: { anchor: 6, head: 6 } });

      const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, 'clipboardData', { value: clipboardWith([imageFile()]) });
      handle.view.contentDOM.dispatchEvent(pasteEvent);

      await flush();
      // 抛出去就是一个没人 await 的 promise rejection；失败就是「什么都没发生」。
      expect(session.getSnapshot().source).toBe('Base: ');
      expect(spy).toHaveBeenCalled();

      spy.mockRestore();
      handle.destroy();
      parent.remove();
    });

    it('只读 surface 不触发落盘钩子', () => {
      const session = new MarkdownDocumentSession('Read only');
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const calls: number[] = [];
      const handle = createSessionEditorView({
        session,
        surfaceId: 'paste-img-ro',
        surfaceKind: 'source',
        readOnly: true,
        parent,
        onPasteFiles: () => {
          calls.push(1);
          return Promise.resolve('![]()');
        }
      });

      const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, 'clipboardData', { value: clipboardWith([imageFile()]) });
      handle.view.contentDOM.dispatchEvent(pasteEvent);

      expect(pasteEvent.defaultPrevented).toBe(true);
      expect(calls).toHaveLength(0);

      handle.destroy();
      parent.remove();
    });

    it('没有钩子时图片粘贴不拦文本 —— 沿用改版前的行为', async () => {
      const session = new MarkdownDocumentSession('Base: ');
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const handle = createSessionEditorView({
        session,
        surfaceId: 'paste-img-none',
        surfaceKind: 'source',
        parent
      });

      handle.view.dispatch({ selection: { anchor: 6, head: 6 } });

      const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, 'clipboardData', { value: clipboardWith([imageFile()], 'text wins') });
      handle.view.contentDOM.dispatchEvent(pasteEvent);

      await flush();
      expect(session.getSnapshot().source).toBe('Base: text wins');

      handle.destroy();
      parent.remove();
    });
  });
});
