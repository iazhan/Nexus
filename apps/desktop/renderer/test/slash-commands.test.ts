// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView, createSourceEditorState } from '@nexus/editor';
import { createSlashCommandHost } from '../src/editor/slash-commands.js';

/**
 * `/` 面板的命令宿主（P2-2 的落点）。
 *
 * 面板的清单来自 `BLOCK_FORMAT_SPECS`（那一份在 `block-format-menu.test.tsx` 里与「格式」
 * 菜单逐项对齐），这里钉的是**动作本身**：`run` 收到一段 `/查询` 的范围之后做什么。
 *
 * 判据取**真实 `EditorView` 的文档与选区**，不取「调没调 run」——
 * 「调了但没删查询串」的实现同样能让「调过」成立，而它在界面上是 `# /h1`。
 */
describe('`/` 面板的命令宿主', () => {
  const parents: HTMLElement[] = [];
  const views: EditorView[] = [];

  function mount(doc: string): EditorView {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({ state: createSourceEditorState({ doc }), parent });
    parents.push(parent);
    views.push(view);
    return view;
  }

  afterEach(() => {
    for (const view of views) view.destroy();
    for (const parent of parents) parent.remove();
    views.length = 0;
    parents.length = 0;
  });

  const label = (key: string) => key;

  it('先删掉 `/查询`，再跑命令 —— 不删就会变成 `# /h1`', () => {
    const view = mount('/h1');
    const run = vi.fn();

    createSlashCommandHost(label, run).run(view, 'format.heading-1', 0, 3);

    expect(view.state.doc.toString()).toBe('');
    expect(run).toHaveBeenCalledWith('format.heading-1');
  });

  it('删完把光标留在行首 —— 命令读的是 view 的当前选区', () => {
    const view = mount('正文 /h1');

    createSlashCommandHost(label, () => {}).run(view, 'format.heading-1', 3, 6);

    expect(view.state.doc.toString()).toBe('正文 ');
    expect(view.state.selection.main.head).toBe(3);
  });

  it('没有查询串时（Ctrl-Space 显式触发）不派发空事务，只跑命令', () => {
    const view = mount('正文');
    const run = vi.fn();

    createSlashCommandHost(label, run).run(view, 'format.heading-1', 0, 0);

    expect(view.state.doc.toString()).toBe('正文');
    expect(run).toHaveBeenCalledWith('format.heading-1');
  });

  /**
   * 两条派发都标同一个 `userEvent`。
   *
   * 会话的撤销栈按事务记、不做分组，所以这**不**把两步并成一个 undo 步 —— 它保证的是
   * 源码面（带 CodeMirror 自己 history 的那条路）里两步同组，两处行为一致。
   * 判据取派发出去的 `userEvent`，不取「撤销了几次」：后者在会话路径上本来就是 2。
   */
  it('删除与命令都标 `format.block` —— 源码面里两步同组', () => {
    const view = mount('/h1');
    const events: (string | undefined)[] = [];
    const dispatch = view.dispatch.bind(view);
    view.dispatch = ((spec: { userEvent?: string }) => {
      events.push(spec.userEvent);
      dispatch(spec as never);
    }) as EditorView['dispatch'];

    createSlashCommandHost(label, () => {
      view.dispatch({ changes: { from: 0, to: 0, insert: '# ' }, userEvent: 'format.block' });
    }).run(view, 'format.heading-1', 0, 3);

    expect(view.state.doc.toString()).toBe('# ');
    expect(events).toEqual(['format.block', 'format.block']);
  });

  it('清单按顺序投影自动作表，标签现读 —— 换语言不需要重建宿主', () => {
    let current = 'zh';
    const host = createSlashCommandHost((key) => `${current}:${key}`, () => {});

    expect(host.entries()[0]?.label).toBe('zh:cmd.paragraph');

    current = 'en';
    expect(host.entries()[0]?.label).toBe('en:cmd.paragraph');
  });
});
