// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import {
  createSourceEditorView,
  applyEditorVim,
  loadVimExtension,
  type CreateSourceEditorOptions
} from '../src/index.js';

/**
 * 这里加载的是**真的** `@replit/codemirror-vim`，不是桩 —— 要验的就是「它与本应用共存」
 * 这条判断本身。桩只能证明 compartment 装上去了，证明不了「它只吃自己绑定的键」。
 *
 * 代价是这个包会跟着进 unit 的模块图（`vitest.config.ts` 里 `@replit` 已被 inline，
 * 否则 vim 会 require 到第二份 `@codemirror/state`）。
 */

const mounted: EditorView[] = [];

type MountOptions = Omit<Partial<CreateSourceEditorOptions>, 'doc' | 'parent'>;

function mount(doc: string, options: MountOptions = {}): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = createSourceEditorView({ doc, parent, ...options });
  mounted.push(view);
  return view;
}

/** 造一个 keydown 并派发到 contentDOM。返回事件本身与 `stopPropagation` 的 spy。 */
function press(view: EditorView, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  // 直接查 `cancelBubble` 在 happy-dom 上不可靠；包一层 spy 既拿得到调用记录，
  // 又不会让「是否阻止冒泡」这件事因为没真的执行而失真（我们只断言调用与否）。
  const stopPropagation = vi.spyOn(event, 'stopPropagation');
  view.contentDOM.dispatchEvent(event);
  return { event, stopPropagation };
}

afterEach(() => {
  for (const view of mounted.splice(0)) {
    view.dom.parentElement?.remove();
    view.destroy();
  }
});

describe('Vim 键位', () => {
  it('懒加载：拿到的是同一个扩展对象（第二次不重新加载）', async () => {
    const first = await loadVimExtension();
    const second = await loadVimExtension();

    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it('装上之后 vim 普通模式的键真的生效（x 删掉光标下的字符）', async () => {
    const view = mount('hello');
    applyEditorVim(view, await loadVimExtension());

    const { event, stopPropagation } = press(view, { key: 'x', code: 'KeyX' });

    expect(view.state.doc.toString()).toBe('ello');
    // vim 那条判据：只有 `handleKey` 返回真才 preventDefault + stopPropagation。
    expect(event.defaultPrevented).toBe(true);
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('卸下之后同一个键不再生效', async () => {
    const view = mount('hello');
    applyEditorVim(view, await loadVimExtension());
    applyEditorVim(view, null);

    press(view, { key: 'x', code: 'KeyX' });

    // 未匹配到 keymap 的普通字符键交给浏览器插入，而这里没有真实输入管线 —— 文档应当纹丝不动。
    expect(view.state.doc.toString()).toBe('hello');
  });

  it('不吞掉不属于自己的键：Ctrl+S 仍走到 CodeMirror 的 keymap', async () => {
    let saved = false;
    const view = mount('hello', {
      keybindings: [
        {
          key: 'Mod-s',
          run: () => {
            saved = true;
            return true;
          }
        }
      ]
    });
    applyEditorVim(view, await loadVimExtension());

    // vim 默认表里没有 `<C-s>`（`<C-b>` 有，所以别拿它当例子）。
    const { event, stopPropagation } = press(view, { key: 's', code: 'KeyS', ctrlKey: true });

    expect(saved).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(stopPropagation).not.toHaveBeenCalled();
  });
});
