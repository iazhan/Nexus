import { describe, expect, it, vi } from 'vitest';
import {
  graphemeBoundaryAtOrAfter,
  graphemeBoundaryAtOrBefore,
  segmentGraphemes
} from '../src/document/grapheme.js';

/**
 * 字素簇工具。
 *
 * 判据的核心是一条**不变量**而不是几个具体期望值：输出里不许出现孤立代理项。
 * 用正则 `/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/`
 * 表达 —— 它同时抓「高代理后面没跟低代理」与「低代理前面没有高代理」。
 *
 * 但只测不变量是不够的：「把整个字符串丢掉」也不含孤立代理项。所以每条不变量断言
 * 都配一条**具体值**断言（切在哪、留下什么），两边都过才算对。
 */

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const GRINNING = '\u{1F600}';
/** 带 ZWJ 的「一家三口」：7 个码元，1 个字素簇 */
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
/** 区域指示符对（日本国旗）：2 个码元，1 个字素簇 */
const FLAG_JP = '\u{1F1EF}\u{1F1F5}';
/** 分解形式的 `é`：`e` + 组合尖音符，2 个码元，1 个字素簇 */
const E_ACUTE_DECOMPOSED = 'e\u0301';
/** 罕见汉字，占两个码元 */
const RARE_HAN = '\u{20BB7}';

describe('segmentGraphemes', () => {
  it('纯 ASCII 一字一簇', () => {
    expect(segmentGraphemes('abc')).toEqual(['a', 'b', 'c']);
  });

  it('空串给空数组', () => {
    expect(segmentGraphemes('')).toEqual([]);
  });

  it('BMP 之外的字符是一整个簇，不是两个码元', () => {
    expect(segmentGraphemes(`ab${GRINNING}cd`)).toEqual(['a', 'b', GRINNING, 'c', 'd']);
    expect(segmentGraphemes(RARE_HAN)).toEqual([RARE_HAN]);
  });

  it('组合字符、ZWJ 序列、旗帜都是一个簇', () => {
    expect(segmentGraphemes(E_ACUTE_DECOMPOSED)).toEqual([E_ACUTE_DECOMPOSED]);
    expect(segmentGraphemes(`x${FAMILY}y`)).toEqual(['x', FAMILY, 'y']);
    expect(segmentGraphemes(FLAG_JP)).toEqual([FLAG_JP]);
  });

  it('切出来的簇拼回去等于原串（一个码元都不丢）', () => {
    const text = `前${FAMILY}中${E_ACUTE_DECOMPOSED}${RARE_HAN}后`;
    expect(segmentGraphemes(text).join('')).toBe(text);
  });
});

describe('字素簇边界对齐', () => {
  it('下标落在簇内部时，往前收到簇首、往后推到簇尾', () => {
    const text = `ab${GRINNING}cd`; // 簇边界：0,1,2,4,5,6
    // 下标 3 落在 emoji 的后半
    expect(graphemeBoundaryAtOrBefore(text, 3)).toBe(2);
    expect(graphemeBoundaryAtOrAfter(text, 3)).toBe(4);
  });

  it('下标本来就在边界上时原样返回', () => {
    const text = `ab${GRINNING}cd`;
    for (const boundary of [0, 1, 2, 4, 5, 6]) {
      expect(graphemeBoundaryAtOrBefore(text, boundary)).toBe(boundary);
      expect(graphemeBoundaryAtOrAfter(text, boundary)).toBe(boundary);
    }
  });

  it('ZWJ 序列内部的下标会被整个吞掉，不会停在中间', () => {
    const text = `x${FAMILY}y`; // 簇边界：0,1,1+FAMILY.length
    const middle = 1 + 3; // ZWJ 之后、第二个 emoji 中间
    expect(graphemeBoundaryAtOrBefore(text, middle)).toBe(1);
    expect(graphemeBoundaryAtOrAfter(text, middle)).toBe(1 + FAMILY.length);
  });

  it('两端越界时退回原下标，不抛异常', () => {
    const text = 'abc';
    expect(graphemeBoundaryAtOrBefore(text, text.length)).toBe(3);
    expect(graphemeBoundaryAtOrAfter(text, text.length)).toBe(3);
    expect(graphemeBoundaryAtOrBefore(text, 0)).toBe(0);
    expect(graphemeBoundaryAtOrAfter(text, 0)).toBe(0);
  });
});

describe('没有 Intl.Segmenter 时', () => {
  /**
   * 老 Chromium / 精简 ICU 的 Node 里没有 `Intl.Segmenter`。那时退到码点级：
   * 切得粗（`é` 会被切成两半）但**绝不允许切开代理对**，也绝不允许抛异常 ——
   * 这段代码在「画一个标签」的路径上，抛出去就是整块图谱不画。
   *
   * 分词器在模块加载时取一次，所以这里必须删掉属性 + `resetModules` + 动态 import，
   * 才真的跑到那条分支。
   */
  async function loadWithoutSegmenter(): Promise<typeof import('../src/document/grapheme.js')> {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
    Reflect.deleteProperty(Intl, 'Segmenter');
    vi.resetModules();
    try {
      return await import('../src/document/grapheme.js');
    } finally {
      if (descriptor !== undefined) Object.defineProperty(Intl, 'Segmenter', descriptor);
      vi.resetModules();
    }
  }

  it('按码点切：代理对仍然不拆', async () => {
    const mod = await loadWithoutSegmenter();
    expect(mod.segmentGraphemes(`ab${GRINNING}cd`)).toEqual(['a', 'b', GRINNING, 'c', 'd']);
    expect(mod.segmentGraphemes(RARE_HAN)).toEqual([RARE_HAN]);
  });

  it('边界对齐仍然不切开代理对（组合字符会被切开 —— 这是刻意的降级）', async () => {
    const mod = await loadWithoutSegmenter();
    const text = `ab${GRINNING}cd`;
    expect(mod.graphemeBoundaryAtOrBefore(text, 3)).toBe(2);
    expect(mod.graphemeBoundaryAtOrAfter(text, 3)).toBe(4);
    expect(mod.graphemeBoundaryAtOrBefore(text, 2)).toBe(2);
  });

  it('降级路径下也不抛异常', async () => {
    const mod = await loadWithoutSegmenter();
    expect(() => mod.graphemeBoundaryAtOrAfter('', 0)).not.toThrow();
    expect(mod.graphemeBoundaryAtOrAfter('', 0)).toBe(0);
    expect(mod.graphemeBoundaryAtOrBefore('', 0)).toBe(0);
  });
});

describe('孤立代理项判据本身是有效的', () => {
  it('能抓出被人为切开的一半 emoji', () => {
    expect(LONE_SURROGATE.test(GRINNING.slice(0, 1))).toBe(true);
    expect(LONE_SURROGATE.test(GRINNING.slice(1))).toBe(true);
    expect(LONE_SURROGATE.test(GRINNING)).toBe(false);
    expect(LONE_SURROGATE.test(`ab${GRINNING}cd`)).toBe(false);
  });
});
