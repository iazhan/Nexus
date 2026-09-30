// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { MarkdownDocumentSession, createSessionEditorState } from '../src/index.js';
import { buildBlockGapDecorations, buildMarkerDecorations } from '../src/markdown-markers.js';
import { buildDragHandleDecorations } from '../src/drag-handle.js';

/**
 * 装饰构造顺序契约。
 *
 * `RangeSetBuilder` 只接受按 `(from, value.startSide)` 升序的输入。
 * 破坏它不会渲染错乱，而是直接抛
 * "Ranges must be added sorted by `from` position and `startSide`"，
 * 又因为投影在 `StateField.create` 里运行（即 React render 阶段），
 * 最终表现为整窗白屏。
 *
 * 全仓有四处构造点，这个文件把四处都罩住：
 *   1. `buildMarkerDecorations`  —— Source 模式标记装饰
 *   2. `buildDragHandleDecorations` —— Visual 拖拽手柄
 *   3. `createSessionEditorState(surfaceKind: 'source')`
 *   4. `createSessionEditorState(surfaceKind: 'visual')`
 *
 * 段间距的 `buildBlockGapDecorations` 是**单独一个集合**（理由见它的注释），所以
 * `assertAscending` 对它是成立的 —— 它不含跨行 mark，不会产生嵌套层。
 *
 * 语料刻意自包含（不依赖被 gitignore 的 docs/），并且必须包含
 * **链接文字本身就是单个 widget** 的构造——那是唯一会踩中
 * 「mark 与 replace 的 from/to 完全相同」平局情形的形状。
 */
const TRICKY_DOC = [
  '# 标题',
  '',
  '## 链接文字是单个 widget',
  '',
  '[![图标](./a.png)](https://example.com)',
  '',
  '[$E=mc^2$](https://e.com)',
  '',
  '## 链接文字是分隔符型节点',
  '',
  '[**粗**](https://e.com)、[`码`](https://e.com)、[~~删~~](https://e.com)',
  '',
  '## 引用块嵌套',
  '',
  '> 段落',
  '>',
  '> - 引用里的列表',
  '> - 第二项',
  '>',
  '> ```text',
  '> 引用里的代码块',
  '> ```',
  '',
  '## 四反引号围栏包三反引号',
  '',
  '````text',
  '```',
  '````',
  '',
  '## 列表与任务',
  '',
  '- 无序项',
  '  - 嵌套项 [![n](./n.png)](https://e.com)',
  '',
  '- [ ] 待办',
  '- [x] 已完成',
  '',
  '## 表格',
  '',
  '| 列 | 说明 |',
  '| --- | --- |',
  '| `code` | [link](https://e.com) |',
  '',
  '## 公式与双链',
  '',
  '行内公式 $a^2 + b^2 = c^2$ 与双链 [[另一篇笔记|别名]]。',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '---'
].join('\n');

/** 断言装饰集合的 `from` 非递减——顺序契约被破坏时构造阶段就会抛，这里再守一层。 */
function assertAscending(set: { between: (from: number, to: number, f: (from: number) => void) => void }, length: number): number {
  let last = -1;
  let count = 0;
  set.between(0, length, (from) => {
    count++;
    expect(from).toBeGreaterThanOrEqual(last);
    last = from;
  });
  return count;
}

describe('decoration construction order contract', () => {
  it('builds marker decorations in ascending from-order', () => {
    const set = buildMarkerDecorations(TRICKY_DOC);
    expect(assertAscending(set, TRICKY_DOC.length)).toBeGreaterThan(0);
  });

  /**
   * 段间距集合**只有零长度行装饰、位置严格递增**，所以它必须单层、严格升序。
   * 这条同时是「别把段间距并回标记字段」的守卫：并回去之后跨行 mark 会把它推给嵌套层，
   * 这里立刻红。
   */
  it('builds block gap decorations in ascending from-order', () => {
    const set = buildBlockGapDecorations(TRICKY_DOC);
    expect(assertAscending(set, TRICKY_DOC.length)).toBeGreaterThan(0);
  });

  it('builds drag handle decorations for every block without throwing', () => {
    for (const readOnly of [false, true]) {
      const set = buildDragHandleDecorations(TRICKY_DOC, readOnly);
      expect(assertAscending(set, TRICKY_DOC.length)).toBeGreaterThan(0);
    }
  });

  it('creates an EditorState for both surfaces without breaking the order contract', () => {
    for (const surfaceKind of ['source', 'visual'] as const) {
      const state = createSessionEditorState({
        session: new MarkdownDocumentSession(TRICKY_DOC),
        surfaceId: `order-contract-${surfaceKind}`,
        surfaceKind
      });
      // 渲染失败绝不能改动 canonical source。
      expect(state.doc.toString()).toBe(TRICKY_DOC);
    }
  });

  it('handles a linked image in every construction path', () => {
    const source = '[![Nexus 图标](./assets/nexus-logo.png)](https://example.com)';

    expect(() => buildMarkerDecorations(source)).not.toThrow();
    expect(() => buildDragHandleDecorations(source, false)).not.toThrow();
    for (const surfaceKind of ['source', 'visual'] as const) {
      const state = createSessionEditorState({
        session: new MarkdownDocumentSession(source),
        surfaceId: `linked-image-${surfaceKind}`,
        surfaceKind
      });
      expect(state.doc.toString()).toBe(source);
    }
  });

  it('handles a document that is nothing but adjacent linked images', () => {
    // 连续多张链接图片：同一行里多个 mark/replace 平局对，最容易暴露排序缺陷。
    const source = [
      '[![a](./a.png)](https://a.com) [![b](./b.png)](https://b.com) [![c](./c.png)](https://c.com)',
      '',
      '[$x$](https://x.com) [$y$](https://y.com)',
      '',
      '[![d](./d.png)](https://d.com)[![e](./e.png)](https://e.com)'
    ].join('\n');

    for (const surfaceKind of ['source', 'visual'] as const) {
      const state = createSessionEditorState({
        session: new MarkdownDocumentSession(source),
        surfaceId: `adjacent-linked-images-${surfaceKind}`,
        surfaceKind
      });
      expect(state.doc.toString()).toBe(source);
    }
  });

  it('handles an empty document and a document with only whitespace', () => {
    for (const source of ['', '\n', '   \n\n']) {
      expect(() => buildMarkerDecorations(source)).not.toThrow();
      expect(() => buildDragHandleDecorations(source, false)).not.toThrow();
      for (const surfaceKind of ['source', 'visual'] as const) {
        expect(() =>
          createSessionEditorState({
            session: new MarkdownDocumentSession(source),
            surfaceId: `degenerate-${surfaceKind}-${source.length}`,
            surfaceKind
          })
        ).not.toThrow();
      }
    }
  });
});
