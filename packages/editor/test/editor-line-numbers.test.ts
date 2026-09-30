// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import {
  createSourceEditorView,
  setEditorLineNumbers
} from '../src/index.js';

const mounted: EditorView[] = [];

function mount(doc = 'line one\nline two'): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = createSourceEditorView({ doc, parent });
  mounted.push(view);
  return view;
}

afterEach(() => {
  for (const view of mounted.splice(0)) {
    view.dom.parentElement?.remove();
    view.destroy();
  }
});

describe('编辑器行号槽开关', () => {
  it('默认装配行号 gutter', () => {
    const view = mount();
    expect(view.dom.querySelector('.cm-lineNumbers')).not.toBeNull();
  });

  it('lineNumbers: false 时不装配行号 gutter', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = createSourceEditorView({ doc: 'a\nb', parent, lineNumbers: false });
    mounted.push(view);

    expect(view.dom.querySelector('.cm-lineNumbers')).toBeNull();
  });

  it('setEditorLineNumbers(false) 把 gutter DOM 整个移走，而不是只藏起来', () => {
    const view = mount();
    expect(view.dom.querySelector('.cm-lineNumbers')).not.toBeNull();

    setEditorLineNumbers(view, false);

    // 判据取 DOM 是否存在 —— 只改 display 的话宽度还在，正文会空出一条。
    expect(view.dom.querySelector('.cm-lineNumbers')).toBeNull();
  });

  it('setEditorLineNumbers(true) 能把 gutter 装回来', () => {
    const view = mount();
    setEditorLineNumbers(view, false);
    expect(view.dom.querySelector('.cm-lineNumbers')).toBeNull();

    setEditorLineNumbers(view, true);
    expect(view.dom.querySelector('.cm-lineNumbers')).not.toBeNull();
  });
});
