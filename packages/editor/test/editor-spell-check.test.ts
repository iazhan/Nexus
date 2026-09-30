// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import { createSourceEditorView, setEditorSpellCheck } from '../src/index.js';

const mounted: EditorView[] = [];

function mount(options: { spellCheck?: boolean } = {}): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = createSourceEditorView({ doc: 'spell me', parent, ...options });
  mounted.push(view);
  return view;
}

afterEach(() => {
  for (const view of mounted.splice(0)) {
    view.dom.parentElement?.remove();
    view.destroy();
  }
});

describe('拼写检查开关', () => {
  it('缺省是关：CodeMirror 自己写下的 spellcheck="false" 原样留着', () => {
    const view = mount();
    expect(view.contentDOM.getAttribute('spellcheck')).toBe('false');
  });

  it('spellCheck: true 时覆盖成 "true"', () => {
    const view = mount({ spellCheck: true });
    expect(view.contentDOM.getAttribute('spellcheck')).toBe('true');
  });

  it('setEditorSpellCheck 能开能关', () => {
    const view = mount();
    expect(view.contentDOM.getAttribute('spellcheck')).toBe('false');

    setEditorSpellCheck(view, true);
    expect(view.contentDOM.getAttribute('spellcheck')).toBe('true');

    setEditorSpellCheck(view, false);
    // 关掉之后必须回到「没打开过」的样子，而不是停在 "true"。
    expect(view.contentDOM.getAttribute('spellcheck')).toBe('false');
  });
});
