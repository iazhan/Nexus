// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Decoration } from '@codemirror/view';
import { BLOCK_GAP_CLASS, buildBlockGapDecorations } from '../src/markdown-markers.js';

/**
 * 段间距的行装饰（`--nx-editor-paragraph-spacing` 挂在 `.cm-block-gap` 上）。
 *
 * 判据只能是**位置集合**，不是「渲染出来好不好看」：这一层的产出就是「哪些偏移量上挂了行装饰」，
 * 而「挂了会怎样」全在 CSS 变量里。所以这里钉的是**哪些空行该挂、哪些不该挂**。
 *
 * 三条边界是真实会踩的：
 *   - 代码块里的空行是**内容**，加间距会把代码撑出大小不一的缝；
 *   - 块级公式内部的空行同理；
 *   - 非空行一个都不该挂（挂了会把行距也一起改掉，那是行高的事）。
 */

/** 装饰挂到了哪些偏移量上。 */
function decoratedOffsets(content: string): number[] {
  const set = buildBlockGapDecorations(content);
  const offsets: number[] = [];
  set.between(0, Math.max(content.length, 1), (from, _to, value) => {
    if (value.spec.class === BLOCK_GAP_CLASS) offsets.push(from);
  });
  return offsets;
}

/** 每个行首的偏移量，用来把「挂在哪一行」写成人类可读的形状。 */
function lineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** 被装饰的行号（从 0 起）。比断言偏移量稳，改一个字不会整片红。 */
function decoratedLines(content: string): number[] {
  const starts = lineStarts(content);
  return decoratedOffsets(content).map((offset) => starts.indexOf(offset));
}

describe('block gap decorations', () => {
  it('空行是段间距的载体：块与块之间那一行被装饰', () => {
    const source = ['第一段', '', '第二段'].join('\n');

    // 行 1 是唯一的空行。
    expect(decoratedLines(source)).toEqual([1]);
  });

  it('相邻的块（没有空行）一个装饰都不挂', () => {
    expect(decoratedOffsets(['# 标题', '正文'].join('\n'))).toEqual([]);
  });

  it('多个空行时每一行都挂 —— 松散列表的项间空行同样算段间距', () => {
    const source = ['- 第一项', '', '- 第二项', '', '', '收尾'].join('\n');

    expect(decoratedLines(source)).toEqual([1, 3, 4]);
  });

  /**
   * 代码块里的空行是**内容**。给它加段间距，代码块的视觉节奏就跟着设置值变 ——
   * 而用户调的是「段落之间」，不是「代码里」。
   */
  it('代码围栏内部的空行不挂', () => {
    const source = ['正文', '', '```js', 'const a = 1;', '', 'const b = 2;', '```', '', '结尾'].join(
      '\n'
    );

    expect(decoratedLines(source)).toEqual([1, 7]);
  });

  it('块级公式内部的空行不挂', () => {
    const source = ['正文', '', '$$', 'a = 1', '', 'b = 2', '$$', '', '结尾'].join('\n');

    expect(decoratedLines(source)).toEqual([1, 7]);
  });

  /** 只含空白的行在 Markdown 里同样是空行，不能因为「有空格」就漏掉。 */
  it('只含空格的行也算空行', () => {
    expect(decoratedLines(['第一段', '   ', '第二段'].join('\n'))).toEqual([1]);
  });

  it('空文档与纯空白文档不抛异常', () => {
    for (const source of ['', '\n', '\n\n', '   ']) {
      expect(() => buildBlockGapDecorations(source)).not.toThrow();
    }
  });

  /** 装饰是行装饰，不是 mark —— 挂了它不该改变任何字符的样式区间。 */
  it('挂上去的是行装饰，不是 mark', () => {
    const set = buildBlockGapDecorations(['第一段', '', '第二段'].join('\n'));

    set.between(0, 100, (_from, _to, value) => {
      expect(value).toBeInstanceOf(Decoration.line({}).constructor);
      expect(value.spec.class).toBe(BLOCK_GAP_CLASS);
    });
  });
});
