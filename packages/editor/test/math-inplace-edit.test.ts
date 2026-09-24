// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest';
import {
  MarkdownDocumentSession,
  createSessionEditorView,
  setVisualFocusEffect,
  mathActivationAnchor,
  type SessionEditorViewHandle
} from '../src/index.js';

/**
 * 视觉模式下公式的**就地编辑**。
 *
 * 两种投影形态：
 * - 未揭示：整节点/整块替换成 KaTeX 渲染体；
 * - 已揭示（光标落在范围内部）：替换消失，`$...$` / `$$...$$` 变回真实文档文本，直接改。
 *
 * 整节点 widget 会把点击吞掉，所以激活手势（`activateMathSource`）必须自己把光标送进
 * 范围内部。落点算术抽成了纯函数，这里直接覆盖；真实点击路径由桌面 E2E 覆盖。
 */
describe('视觉模式公式就地编辑', () => {
  let parent: HTMLDivElement;

  beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
    return () => {
      document.body.removeChild(parent);
    };
  });

  function mount(source: string, surfaceId: string): SessionEditorViewHandle {
    return createSessionEditorView({
      parent,
      session: new MarkdownDocumentSession(source),
      surfaceId,
      surfaceKind: 'visual'
    });
  }

  /**
   * 揭示某段范围。用「选区 + 聚焦 effect」同事务完成，而不是 `view.focus()`：
   * happy-dom 在 CM 写 DOM 选区时会**同步**派发 selectionchange，让 CM 的 observer
   * 在一次 update 尚未结束时再次 dispatch；含块级 widget 的文档一律会踩这个坑。
   */
  function reveal(handle: SessionEditorViewHandle, anchor: number): void {
    handle.view.dispatch({
      selection: { anchor },
      effects: setVisualFocusEffect.of(true)
    });
  }

  describe('落点算术（纯函数）', () => {
    it('把光标放在起始定界符之后', () => {
      // `$x$`：定界符 1 个字符
      expect(mathActivationAnchor(0, 3, '$x$')).toBe(1);
      // `$$x$$`：定界符 2 个字符
      expect(mathActivationAnchor(0, 5, '$$x$$')).toBe(2);
      // 块级公式：从 `$$` 之后进入第一行
      expect(mathActivationAnchor(10, 22, '$$\nE = mc^2\n$$')).toBe(12);
    });

    it('空公式时夹在 to - 1 之内，不越界', () => {
      // `$$` 整段只有定界符：from + 2 会越过末尾
      expect(mathActivationAnchor(0, 2, '$$')).toBe(1);
      // 退化到只有 1 个字符
      expect(mathActivationAnchor(0, 1, '$')).toBe(0);
      expect(mathActivationAnchor(5, 5, '$x$')).toBe(5);
    });

    it('raw 不以 $ 开头时退回偏移 1', () => {
      expect(mathActivationAnchor(0, 4, 'x$y$')).toBe(1);
    });
  });

  describe('行内公式', () => {
    it('未揭示时是整节点渲染 widget，没有源码 mark', () => {
      const handle = mount('能量 $E = mc^2$ 守恒。', 'math-inline-rendered');

      expect(handle.view.dom.querySelectorAll('.cm-visual-inline-math').length).toBe(1);
      // 揭示态才有的两种投影都不该出现：源码 mark 与「露出的定界符」。
      // （不去断言 textContent 不含 `$`：单测里没有注册 math 扩展，widget 会退化成
      //  `$E = mc^2$` 的兜底文本，那是降级显示，不代表源码没被替换。）
      expect(handle.view.dom.querySelectorAll('.cm-visual-inline-math-source').length).toBe(0);
      expect(handle.view.dom.querySelectorAll('.cm-visual-delimiter-revealed').length).toBe(0);

      handle.destroy();
    });

    it('光标进入范围后露出源码：定界符可见、正文是真实文本、渲染 widget 消失', () => {
      const source = '能量 $E = mc^2$ 守恒。';
      const handle = mount(source, 'math-inline-revealed');

      const from = source.indexOf('$');
      reveal(handle, from + 1);

      expect(handle.view.dom.querySelectorAll('.cm-visual-inline-math').length).toBe(0);
      expect(handle.view.dom.querySelectorAll('.cm-visual-inline-math-source').length).toBe(1);
      // 定界符以 revealed 形态出现（不是 display:none 的隐藏态）
      const delimiters = handle.view.dom.querySelectorAll('.cm-visual-delimiter-revealed');
      expect(Array.from(delimiters, (el) => el.textContent).join('')).toBe('$$');
      // LaTeX 源码本身是真实文档文本，可以直接编辑
      expect(handle.view.dom.textContent).toContain('E = mc^2');

      handle.destroy();
    });

    it('光标移出范围后回到渲染态', () => {
      const source = '能量 $E = mc^2$ 守恒。';
      const handle = mount(source, 'math-inline-roundtrip');

      const from = source.indexOf('$');
      reveal(handle, from + 1);
      expect(handle.view.dom.querySelectorAll('.cm-visual-inline-math').length).toBe(0);

      handle.view.dispatch({ selection: { anchor: 0 } });
      expect(handle.view.dom.querySelectorAll('.cm-visual-inline-math').length).toBe(1);

      handle.destroy();
    });

    it('嵌在引用块 / 标题 / 列表里的公式同样能揭示', () => {
      const cases: Array<{ id: string; source: string }> = [
        { id: 'quote', source: '> 引用里的 $a+b$ 公式' },
        { id: 'heading', source: '# 标题里的 $a+b$ 公式' },
        { id: 'list', source: '- 列表里的 $a+b$ 公式' }
      ];

      for (const { id, source } of cases) {
        const handle = mount(source, `math-nested-${id}`);
        const from = source.indexOf('$');

        expect(handle.view.dom.querySelectorAll('.cm-visual-inline-math').length).toBe(1);

        reveal(handle, from + 1);

        expect(handle.view.dom.querySelectorAll('.cm-visual-inline-math').length).toBe(0);
        expect(handle.view.dom.querySelectorAll('.cm-visual-inline-math-source').length).toBe(1);

        handle.destroy();
      }
    });
  });

  describe('块级公式', () => {
    const source = '$$\nE = mc^2\n$$\n\n后段正文。';

    it('未揭示时整块替换成渲染 widget', () => {
      const handle = mount(source, 'math-block-rendered');

      expect(
        handle.view.dom.querySelectorAll('.cm-visual-block-math:not(.cm-visual-block-math-preview)')
          .length
      ).toBe(1);
      expect(handle.view.dom.querySelectorAll('.cm-visual-block-math-preview').length).toBe(0);

      handle.destroy();
    });

    it('揭示后源码行可编辑，块尾追加实时预览（源码与预览并存）', () => {
      const handle = mount(source, 'math-block-revealed');

      reveal(handle, 2);

      // 渲染态的整块替换消失，`$$` 行变回真实文本
      expect(
        handle.view.dom.querySelectorAll('.cm-visual-block-math:not(.cm-visual-block-math-preview)')
          .length
      ).toBe(0);
      expect(handle.view.dom.textContent).toContain('E = mc^2');
      expect(handle.view.dom.textContent).toContain('$$');

      // 实时预览仍在（这正是"编辑时也能看到渲染结果"）
      expect(handle.view.dom.querySelectorAll('.cm-visual-block-math-preview').length).toBe(1);

      handle.destroy();
    });

    it('改源码后 session 与另一个 surface 同步', () => {
      const session = new MarkdownDocumentSession(source);
      const sourceParent = document.createElement('div');
      document.body.appendChild(sourceParent);
      const sourceHandle = createSessionEditorView({
        parent: sourceParent,
        session,
        surfaceId: 'math-block-sync-source',
        surfaceKind: 'source'
      });
      const visualHandle = createSessionEditorView({
        parent,
        session,
        surfaceId: 'math-block-sync-visual',
        surfaceKind: 'visual'
      });

      reveal(visualHandle, 2);

      const formulaFrom = source.indexOf('E = mc^2');
      visualHandle.view.dispatch({
        changes: { from: formulaFrom + 7, to: formulaFrom + 8, insert: '3' }
      });

      const updated = '$$\nE = mc^3\n$$\n\n后段正文。';
      expect(session.getSnapshot().source).toBe(updated);
      expect(sourceHandle.view.state.doc.toString()).toBe(updated);

      sourceHandle.destroy();
      visualHandle.destroy();
      document.body.removeChild(sourceParent);
    });
  });

  it('公式与其它块级 widget 混排时装饰构造不抛（排序契约回归）', () => {
    // 揭示态会同时产生 replace（定界符）与 mark（源码），未揭示态是整节点 replace。
    // 一旦排序比较器退化，RangeSetBuilder 会在构造期直接抛错——这里守住它。
    const source = [
      '# 混排 $a+b$',
      '',
      '段落 $x^2$ 与 $$y^2$$ 同行。',
      '',
      '| 表头 |',
      '| --- |',
      '| 单元格 $c$ |',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
      '$$',
      'E = mc^2',
      '$$'
    ].join('\n');

    const session = new MarkdownDocumentSession(source);
    const parent2 = document.createElement('div');
    document.body.appendChild(parent2);
    const handle = createSessionEditorView({
      parent: parent2,
      session,
      surfaceId: 'math-mixed',
      surfaceKind: 'visual'
    });

    const mathFrom = source.indexOf('$a+b$');
    expect(() => reveal(handle, mathFrom + 1)).not.toThrow();

    handle.destroy();
    document.body.removeChild(parent2);
  });
});
