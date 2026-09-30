import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { MarkdownDocumentSession } from './document-session.js';
import type { MarkdownEditTransaction, MarkdownSelection } from './types.js';

export interface ClipboardOptions {
  surfaceId: string;
  readOnly?: boolean;
  /**
   * 剪贴板里带着**图片文件**时的落盘钩子，由宿主提供。
   *
   * 返回要插进文档的 Markdown 片段；返回 `null` 表示这次不处理（认不出的类型、
   * 文档还没存过盘没有落点…）—— 那时退回剪贴板里的**文本**，也就是「没有这个钩子时
   * 本来会发生的事」。不做退回的话，「粘贴一个还没保存的文档里的截图」会是一次静默的
   * 空操作：用户看得见剪贴板里有东西，粘下去什么都没发生。
   *
   * 编辑器包不认识 IPC，也不该认识：它只负责「把文件交给宿主、拿回一段文本」。
   * 写盘、重名、边界校验全在宿主那一侧。
   */
  onPasteFiles?: (files: readonly File[]) => Promise<string | null>;
}

/**
 * 剪贴板里的**图片**文件。
 *
 * 只认 `image/*`：别的类型没有对应的渲染器，粘进来只能是一行点不开的链接，
 * 而「哪些类型允许落盘、大小上限多少」是一套独立的安全策略，不该顺带定下来。
 *
 * 用 `files` 而不是 `items`：`DataTransferItem` 的 `getAsFile()` 只有在前者拿不到时才需要，
 * 而 Chromium 对粘贴事件总是填好 `files`。
 */
function imageFilesFrom(clipboardData: DataTransfer): File[] {
  const files: File[] = [];
  const list = clipboardData.files;
  if (!list) return files;
  for (let index = 0; index < list.length; index += 1) {
    const file = list.item(index);
    if (file && file.type.startsWith('image/')) files.push(file);
  }
  return files;
}

/**
 * 剪贴板里的文本。优先 `text/plain`，没有才从 HTML 里抽纯文本。
 *
 * 两条分支合在这里是必需的：图片分支需要它做**兜底文本**，文本分支需要它做**正文**，
 * 而两处各写一遍的话，兜底那条迟早会漏掉 HTML 抽取 —— 症状是「粘截图到未保存的文档里，
 * 什么都没发生」，而同一个剪贴板在有落点时是好的。
 */
function clipboardText(clipboardData: DataTransfer): string {
  const plainText = clipboardData.getData('text/plain');
  if (typeof plainText === 'string' && plainText.length > 0) return plainText;

  const html = clipboardData.getData('text/html');
  if (typeof html === 'string' && html.length > 0) return extractPlainTextFromHtml(html);
  return '';
}

/**
 * 落盘之后再插入引用。
 *
 * **走 `session.dispatch` 而不是 `view.dispatch`。** 写盘是异步的，回来的时候这个 view
 * 可能已经随着 surface 切换被销毁了（切一次 Source / Visual 就换一个 `EditorView`），
 * 而 session 跨 surface 存活 —— 往销毁的 view 上 dispatch 会抛
 * `Tried to dispatch on a destroyed view`，用户看到的是「图存下来了，引用没插进去」。
 *
 * 插入点取**那一刻**的选区，不是粘贴发生时的：写盘期间用户可能已经移动了光标，
 * 把引用插到他刚离开的位置是反直觉的。
 */
async function pasteFiles(
  session: MarkdownDocumentSession,
  onPasteFiles: (files: readonly File[]) => Promise<string | null>,
  files: readonly File[],
  fallbackText: string
): Promise<void> {
  let snippet: string | null = null;
  try {
    snippet = await onPasteFiles(files);
  } catch (err) {
    // 这里不能把异常往外扔：`paste` 处理器是同步返回的，这个 promise 没人 await，
    // 抛出去就是一个静默的 unhandled rejection。失败就是「什么都没发生」。
    console.error('Paste attachment failed:', err);
    return;
  }

  // 宿主不处理（返回 `null`）时退回文本。见 `ClipboardOptions.onPasteFiles`。
  const insert = snippet ?? fallbackText;
  if (insert.length === 0) return;

  const { selection } = session.getSnapshot();
  const from = Math.min(selection.anchor, selection.head);
  const to = Math.max(selection.anchor, selection.head);
  const caret = from + insert.length;
  session.dispatch({
    changes: [{ from, to, insert }],
    selection: { anchor: caret, head: caret },
    userEvent: 'input.paste'
  });
}

/**
 * 拦截粘贴事件并分发到 session 的 CodeMirror 扩展。
 * 始终 preventDefault，保证 Visual DOM 绝对不注入未清洗的剪贴板 HTML。
 */
export function createClipboardExtension(
  session: MarkdownDocumentSession,
  options: ClipboardOptions
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

      const text = clipboardText(clipboardData);

      // **图片优先于文本。** 截图粘贴时剪贴板里往往同时有 `text/html`（一个 `<img>`），
      // 先走文本分支的话 `extractPlainTextFromHtml` 会把它抽成空串 —— 图就没了，
      // 而用户明明看得见剪贴板里有东西。
      //
      // `preventDefault` 已经在上面**同步**做掉了，所以这里的异步不会让浏览器的默认粘贴
      // 在稍后漏进来。这是「异步分支能安全存在」的前提。
      const images = imageFilesFrom(clipboardData);
      if (images.length > 0 && options.onPasteFiles) {
        void pasteFiles(session, options.onPasteFiles, images, text);
        return true;
      }

      if (text.length > 0) {
        const sel = view.state.selection.main;
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: text },
          selection: { anchor: sel.from + text.length },
          userEvent: 'input.paste'
        });
      }

      return true;
    }
  });
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
