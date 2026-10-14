// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import { ViewPlugin } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import {
  MarkdownDocumentSession,
  createSessionEditorView,
  visualFocusField
} from '../src/index.js';

const mounted: EditorView[] = [];

function mountVisual(): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = createSessionEditorView({
    session: new MarkdownDocumentSession('# 标题\n\n正文。\n'),
    surfaceId: 'visual-focus-test',
    surfaceKind: 'visual',
    parent
  });
  mounted.push(handle.view);
  return handle.view;
}

afterEach(() => {
  for (const view of mounted.splice(0)) {
    view.dom.parentElement?.remove();
    view.destroy();
  }
});

/**
 * 在**插件 update 阶段**把焦点送进编辑器的扩展。
 *
 * `@codemirror/search` 的面板正是在这一步挂载的：`SearchPanel` 由 `showPanel` 的
 * compartment 在 `view.update()` 里创建，构造末尾的 `mount()` 调
 * `searchField.select()` —— 焦点同步到达时 `updateState` 还不是 `Idle`，
 * 此刻 dispatch 会抛 `Calls to EditorView.update are not allowed while an
 * update is in progress`。这里用同一个到达时机复现，不必真开面板。
 */
const focusDuringUpdate = ViewPlugin.define((view) => ({
  update(update) {
    if (update.docChanged || update.selectionSet) {
      view.contentDOM.focus();
    }
  }
}));

/**
 * focus 事件落到一次 view update 内部时，`visualFocusPlugin` 不能把异常抛出去。
 *
 * 触发这条路的是查找 / 替换面板（见 `focusDuringUpdate` 的说明）。源码面不装这个
 * 插件，所以只有视觉面会踩到；而 Markdown 的默认打开面正是视觉面，于是「按 Mod-F
 * 打开查找」就会在真机控制台留一条未捕获异常，focus 状态同时丢失 —— 「点块级公式
 * 立刻折叠」那类行为跟着失灵。
 */
describe('visual 面的 focus 记账', () => {
  it('插件 update 期间到达的 focus 不抛异常，状态在微任务里补上', () => {
    const view = mountVisual();
    view.dispatch({ effects: StateEffect.appendConfig.of(focusDuringUpdate) });

    expect(view.state.field(visualFocusField, false)).toBe(false);
    expect(() => view.dispatch({ selection: { anchor: 1 } })).not.toThrow();

    return Promise.resolve().then(() => {
      expect(view.state.field(visualFocusField, false)).toBe(true);
    });
  });

  it('编辑器自己拿到焦点时立刻记账', () => {
    const view = mountVisual();

    view.focus();

    expect(view.state.field(visualFocusField, false)).toBe(true);
  });

  it('焦点离开时收回记账', () => {
    const view = mountVisual();
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    view.focus();
    expect(view.state.field(visualFocusField, false)).toBe(true);

    // 焦点真的挪出去（不是只派发一个合成事件）：onBlur 会核对 activeElement
    outside.focus();
    return Promise.resolve().then(() => {
      expect(view.state.field(visualFocusField, false)).toBe(false);
      outside.remove();
    });
  });
});

