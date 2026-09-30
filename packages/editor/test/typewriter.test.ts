// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import { createSourceEditorView, setEditorTypewriter } from '../src/index.js';

/**
 * 打字机模式的用例**不查视口坐标** —— happy-dom 没有布局，`getBoundingClientRect` 恒为 0，
 * 滚没滚动在 DOM 上看不出来。能观察的是插件**是否发出滚动请求**：
 * `EditorView.scrollIntoView` 是一个 `StateEffect`，落在事务的 `effects` 里。
 *
 * 这已经足够：插件唯一的职责就是「该滚的时候请求滚、不该滚的时候不请求」。
 * 真机上「滚到没滚到中央」由 `scrollIntoView` 自己保证。
 */

const mounted: EditorView[] = [];

/**
 * `EditorView.scrollIntoView(pos, opts)` 是一个**返回效果的静态方法**，不是 `StateEffectType` ——
 * 所以不能写 `effect.is(EditorView.scrollIntoView)`（那是个函数，永远不相等，计数会恒为 0）。
 * 拿它造一个效果出来、取 `.type` 才是那个类型。
 */
const SCROLL_INTO_VIEW = EditorView.scrollIntoView(0).type;

/** 滚动请求计数。每次 `view.dispatch` 里带 `scrollIntoView` 效果就 +1。 */
function watchScrolls(view: EditorView): { count: () => number } {
  let count = 0;
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => {
        for (const transaction of update.transactions) {
          for (const effect of transaction.effects) {
            if (effect.is(SCROLL_INTO_VIEW)) count += 1;
          }
        }
      })
    )
  });
  return { count: () => count };
}

function mount(doc = 'line one\nline two\nline three'): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = createSourceEditorView({ doc, parent });
  mounted.push(view);
  return view;
}

/** 让 `queueMicrotask` 里那次 dispatch 跑完。两次是为了也覆盖「滚动自己又排队」的情形。 */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** 用户敲了一个字符。 */
function type(view: EditorView, at = 0): void {
  view.dispatch({
    changes: { from: at, insert: 'x' },
    selection: { anchor: at + 1 },
    userEvent: 'input'
  });
}

afterEach(() => {
  for (const view of mounted.splice(0)) {
    view.dom.parentElement?.remove();
    view.destroy();
  }
});

describe('打字机模式', () => {
  it('默认不跟随：用户输入不发出滚动请求', async () => {
    const view = mount();
    const scrolls = watchScrolls(view);

    type(view);
    await settle();

    expect(scrolls.count()).toBe(0);
  });

  it('打开后用户输入会发出一次滚动请求', async () => {
    const view = mount();
    setEditorTypewriter(view, true);
    const scrolls = watchScrolls(view);

    type(view);
    await settle();

    expect(scrolls.count()).toBe(1);
  });

  it('程序发出的选区变化不跟随（多 surface 光标同步不该把视口拽走）', async () => {
    const view = mount();
    setEditorTypewriter(view, true);
    const scrolls = watchScrolls(view);

    // 没有 userEvent 标注 —— session 把别处光标同步过来就是这个形状。
    view.dispatch({ selection: { anchor: 5 } });
    await settle();

    expect(scrolls.count()).toBe(0);
  });

  it('滚动请求自身不会再引发一次滚动', async () => {
    const view = mount();
    setEditorTypewriter(view, true);
    const scrolls = watchScrolls(view);

    type(view);
    await settle();

    // 一次输入 → 一次滚动。若插件把滚动事务也算作「光标动了」，这里会变成 2、3…… 直到栈溢出。
    expect(scrolls.count()).toBe(1);
  });

  it('同一个同步块里连发两次输入只滚一次，且滚到最新那处光标', async () => {
    const view = mount();
    setEditorTypewriter(view, true);
    const scrolls = watchScrolls(view);

    type(view, 0);
    type(view, 5);
    await settle();

    expect(scrolls.count()).toBe(1);
    // 位置现读而不是排队时快照：最后一次输入把光标放在了 6。
    expect(view.state.selection.main.head).toBe(6);
  });

  it('关掉之后再输入不再跟随', async () => {
    const view = mount();
    setEditorTypewriter(view, true);
    setEditorTypewriter(view, false);
    const scrolls = watchScrolls(view);

    type(view);
    await settle();

    expect(scrolls.count()).toBe(0);
  });

  it('视图在微任务排队期间被销毁时不抛', async () => {
    const view = mount();
    setEditorTypewriter(view, true);

    type(view);
    // 排队之后、微任务之前销毁：插件必须自己认出视图没了。
    view.dom.parentElement?.remove();
    view.destroy();
    mounted.splice(mounted.indexOf(view), 1);

    await expect(settle()).resolves.toBeUndefined();
  });
});
