import { describe, expect, it } from 'vitest';
import { extractOutline, type OutlineHeading } from '../src/workspace/outline.js';
import {
  buildOutlineRenderItems,
  resolveActiveHeadingOffset,
  visibleOutlineRenderItems
} from '../src/workspace/outline-model.js';

/**
 * 大纲折叠的纯逻辑层。
 *
 * 组件用例只验「点三角之后列表变了」，验不了「为什么是这个结果」；真机用例一个文件
 * 只能造一种文档形状。层级跳跃、同名标题、折叠嵌套这些都在这里铺开。
 */

/** 从源码走一遍完整链路，避免手写 offset 把用例写歪。 */
const itemsOf = (source: string) => buildOutlineRenderItems(extractOutline(source));

const textsOf = (items: ReturnType<typeof buildOutlineRenderItems>) =>
  items.map((item) => item.heading.text);

/** 折叠若干 key，返回剩下的可见项文本。 */
const collapse = (source: string, ...keys: string[]) => {
  const items = itemsOf(source);
  const target = new Set(keys);
  return textsOf(visibleOutlineRenderItems(items, target));
};

const NESTED = ['# A', '## A1', '### A1a', '## A2', '# B', '## B1'].join('\n');

describe('大纲折叠：hasChildren', () => {
  it('层级更深的标题跟在后面才算子项', () => {
    const items = itemsOf(NESTED);
    expect(items.map((item) => [item.heading.text, item.hasChildren])).toEqual([
      ['A', true],
      ['A1', true],
      ['A1a', false],
      ['A2', false],
      ['B', true],
      ['B1', false]
    ]);
  });

  it('最后一个标题永远没有子项', () => {
    expect(itemsOf('# 只有一个').map((item) => item.hasChildren)).toEqual([false]);
  });

  it('层级跳跃也算子项（h1 后面直接是 h3）', () => {
    // 层级不连续是合法的 Markdown，而且很常见（有人只用 h1/h3）
    const items = itemsOf(['# A', '### 深', '# B'].join('\n'));
    expect(items.map((item) => [item.heading.text, item.hasChildren])).toEqual([
      ['A', true],
      ['深', false],
      ['B', false]
    ]);
  });

  it('同名同层级的标题各算各的', () => {
    const items = itemsOf(['# A', '## 说明', '## 说明'].join('\n'));
    expect(items.map((item) => item.hasChildren)).toEqual([true, false, false]);
  });
});

describe('大纲折叠：key 的稳定性', () => {
  it('同名同层级按出现次序区分，不重复', () => {
    const keys = itemsOf(['# A', '## 说明', '## 说明', '# B'].join('\n')).map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('在文档中间插入标题，其余项的 key 不变', () => {
    // 这是**不用数组下标做 key** 的全部理由：大纲实时跟随编辑，下标会整体平移，
    // 折叠状态就跟着错位到别的标题上。换成下标做 key 这条会红。
    const before = itemsOf(['# A', '## A1', '# B', '## B1'].join('\n'));
    const after = itemsOf(['# A', '## A1', '### 插进来的', '# B', '## B1'].join('\n'));

    const survived = new Set(after.map((item) => item.key));
    for (const item of before) {
      expect(survived.has(item.key)).toBe(true);
    }
  });

  it('改标题文字会换掉那一项的 key（接受的代价）', () => {
    const before = itemsOf('# 旧名字').map((item) => item.key);
    const after = itemsOf('# 新名字').map((item) => item.key);
    expect(after).not.toEqual(before);
  });
});

describe('大纲折叠：过滤', () => {
  it('折叠一级标题会带走它下面的全部子孙，但不碰后面的同级标题', () => {
    const [a, b] = itemsOf(NESTED).filter((item) => item.heading.level === 1);
    expect(collapse(NESTED, a!.key)).toEqual(['A', 'B', 'B1']);
    expect(collapse(NESTED, b!.key)).toEqual(['A', 'A1', 'A1a', 'A2', 'B']);
  });

  it('折叠二级标题只带走它自己的子孙', () => {
    const a1 = itemsOf(NESTED).find((item) => item.heading.text === 'A1')!;
    expect(collapse(NESTED, a1.key)).toEqual(['A', 'A1', 'A2', 'B', 'B1']);
  });

  it('同时折叠嵌套的两层，展开外层后内层仍是折着的', () => {
    const items = itemsOf(NESTED);
    const a = items.find((item) => item.heading.text === 'A')!;
    const a1 = items.find((item) => item.heading.text === 'A1')!;

    // 折叠 A：A1 被祖先挡住，游标停在 A 的层级
    expect(textsOf(visibleOutlineRenderItems(items, new Set([a.key, a1.key])))).toEqual([
      'A',
      'B',
      'B1'
    ]);
    // 展开 A：A1 露出来，但它自己那份折叠状态还在 → A1a 依然看不见
    expect(textsOf(visibleOutlineRenderItems(items, new Set([a1.key])))).toEqual([
      'A',
      'A1',
      'A2',
      'B',
      'B1'
    ]);
  });

  it('折叠不影响不相关的分支（正反两面）', () => {
    const a2 = itemsOf(NESTED).find((item) => item.heading.text === 'A2')!;
    // A2 没有子项，折它等于什么都没折 —— 而 B 那一支必须原样在
    expect(collapse(NESTED, a2.key)).toEqual(['A', 'A1', 'A1a', 'A2', 'B', 'B1']);
  });

  it('空的折叠集合等于不折叠', () => {
    expect(collapse(NESTED)).toEqual(['A', 'A1', 'A1a', 'A2', 'B', 'B1']);
  });
});

describe('大纲折叠：层级过滤', () => {
  it('maxLevel 丢掉更深的项', () => {
    const items = buildOutlineRenderItems(extractOutline(NESTED), 2);
    expect(textsOf(items)).toEqual(['A', 'A1', 'A2', 'B', 'B1']);
  });

  it('maxLevel 会把「子项全被滤掉」的项判成没有子项', () => {
    // 否则会出现一个指向看不见的子项的折叠三角，点下去什么都不发生
    const items = buildOutlineRenderItems(extractOutline(NESTED), 2);
    expect(items.map((item) => [item.heading.text, item.hasChildren])).toEqual([
      ['A', true],
      ['A1', false],
      ['A2', false],
      ['B', true],
      ['B1', false]
    ]);
  });

  it('过滤后 index 仍指向原列表（折叠键与下标无关，但 index 要能回查）', () => {
    const all = extractOutline(NESTED);
    const items = buildOutlineRenderItems(all, 2);
    for (const item of items) {
      expect(item.heading).toBe(all[item.index]);
    }
  });
});

describe('大纲高亮：当前所处的标题', () => {
  const headings = extractOutline(NESTED);
  const offsetOf = (text: string) => headings.find((item) => item.text === text)!.offset;

  it('位置落在标题行上时，那一条就是当前项', () => {
    expect(resolveActiveHeadingOffset(headings, offsetOf('A1'))).toBe(offsetOf('A1'));
    expect(resolveActiveHeadingOffset(headings, offsetOf('B'))).toBe(offsetOf('B'));
  });

  it('位置在标题之间时算前一个标题（包括标题行内部）', () => {
    // 光标在 `## A1` 这一行的中间，仍然属于 A1
    expect(resolveActiveHeadingOffset(headings, offsetOf('A1') + 3)).toBe(offsetOf('A1'));
    // 正文段落落在 A1 与 A1a 之间，仍属于 A1
    const between = offsetOf('A1a') - 1;
    expect(resolveActiveHeadingOffset(headings, between)).toBe(offsetOf('A1'));
  });

  it('位置在最后一个标题之后时算最后一个标题', () => {
    // `NESTED` 的最后一项是 `## B1`，不是 `# B`
    expect(resolveActiveHeadingOffset(headings, 10_000)).toBe(offsetOf('B1'));
  });

  it('位置在第一个标题之前时不高亮任何一项', () => {
    // 文首的前言不属于任何一节 —— 硬指一个会让人以为自己在那一节里
    expect(resolveActiveHeadingOffset(headings, offsetOf('A') - 1)).toBeNull();
  });

  it('没有标题时永远不高亮', () => {
    expect(resolveActiveHeadingOffset([], 42)).toBeNull();
  });
});

describe('大纲折叠：空输入', () => {
  it('没有标题时两层都返回空', () => {
    expect(buildOutlineRenderItems([] as OutlineHeading[])).toEqual([]);
    expect(visibleOutlineRenderItems([], new Set())).toEqual([]);
  });
});
