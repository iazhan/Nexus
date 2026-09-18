import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { MarkdownDocumentSession } from './document-session.js';
import type { MarkdownEditTransaction, MarkdownSelection } from './types.js';

export interface ClipboardOptions {
  surfaceId: string;
  readOnly?: boolean;
}

/**
 * 从 HTML 结构化提取纯文本内容，完全移除可执行脚本、iframe、对象与危险协议。
 * 遵循 detached DOM 结构化解析，仅输出纯文本，绝不作为 HTML 重新注入。
 * 解码 decimal/hex/named HTML 实体，并保留用户前导和尾随空白。
 */
export function extractPlainTextFromHtml(html: string): string {
  if (typeof document === 'undefined') {
    return '';
  }

  const template = document.createElement('template');
  template.innerHTML = html;
  const content = template.content;

  // 移除危险与不可见的标签及其子元素
  const forbiddenSelectors =
    'script, style, iframe, object, embed, applet, noscript, svg, math, meta, link, base, form';
  const forbidden = content.querySelectorAll(forbiddenSelectors);
  for (let i = 0; i < forbidden.length; i++) {
    forbidden[i]!.remove();
  }

  const pieces: string[] = [];
  let pendingBlockBreak = false;

  function flushBlockBreak(): void {
    if (pendingBlockBreak) {
      if (pieces.length > 0 && !pieces[pieces.length - 1]!.endsWith('\n')) {
        pieces.push('\n');
      }
      pendingBlockBreak = false;
    }
  }

  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const val = node.nodeValue ?? '';
      if (val.length > 0) {
        flushBlockBreak();
        pieces.push(val);
      }
      return;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tag = el.tagName.toUpperCase();

      if (tag === 'BR') {
        pendingBlockBreak = false;
        pieces.push('\n');
        return;
      }

      if (tag === 'HR') {
        flushBlockBreak();
        pieces.push('\n');
        return;
      }

      if (tag === 'IMG') {
        const alt = (el as HTMLImageElement).alt || '';
        if (alt.length > 0) {
          flushBlockBreak();
          pieces.push(alt);
        }
        return;
      }

      const isBlock = /^(P|DIV|H[1-6]|LI|TR|BLOCKQUOTE|PRE|ARTICLE|SECTION|HEADER|FOOTER|NAV)$/i.test(tag);
      if (isBlock) {
        if (pieces.length > 0 && !pieces[pieces.length - 1]!.endsWith('\n')) {
          pendingBlockBreak = true;
        }
      }

      for (const child of Array.from(node.childNodes)) {
        walk(child);
      }

      if (isBlock) {
        if (pieces.length > 0 && !pieces[pieces.length - 1]!.endsWith('\n')) {
          pendingBlockBreak = true;
        }
      }
    }
  }

  for (const child of Array.from(content.childNodes)) {
    walk(child);
  }

  return pieces.join('');
}

/**
 * 构建粘贴纯文本到指定选区的 MarkdownEditTransaction。
 */
export function createClipboardPasteTransaction(
  _source: string,
  selection: MarkdownSelection,
  text: string
): MarkdownEditTransaction {
  const from = Math.min(selection.anchor, selection.head);
  const to = Math.max(selection.anchor, selection.head);

  return {
    changes: [{ from, to, insert: text }],
    selection: { anchor: from + text.length, head: from + text.length },
    userEvent: 'input.paste'
  };
}

/**
 * 拦截粘贴事件并分发到 session 的 CodeMirror 扩展。
 * 始终 preventDefault，保证 Visual DOM 绝对不注入未清洗的剪贴板 HTML。
 */
export function createClipboardExtension(
  _session: MarkdownDocumentSession,
  _options: ClipboardOptions
): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      if (view.state.readOnly) {
        event.preventDefault();
        return true;
      }

      // 始终阻止默认粘贴行为，避免未清洗 DOM 直接注入 contentDOM
      event.preventDefault();

      const clipboardData = event.clipboardData;
      if (!clipboardData) return true;

      const plainText = clipboardData.getData('text/plain');
      if (typeof plainText === 'string' && plainText.length > 0) {
        const sel = view.state.selection.main;
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: plainText },
          selection: { anchor: sel.from + plainText.length },
          userEvent: 'input.paste'
        });
        return true;
      }

      const html = clipboardData.getData('text/html');
      if (typeof html === 'string' && html.length > 0) {
        const text = extractPlainTextFromHtml(html);
        if (text.length > 0) {
          const sel = view.state.selection.main;
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: text },
            selection: { anchor: sel.from + text.length },
            userEvent: 'input.paste'
          });
          return true;
        }
      }

      return true;
    }
  });
}
