import { describe, it, expect } from 'vitest';
import { findUnlinkedMentions } from '../src/index.js';

/**
 * 未链接提及。
 *
 * 这一层的错法都表现为**建议本身不可信**：
 * 建议了一条已经写好的链接、建议了一个用户根本没提到的词（`dmax` 里的 `dma`）、
 * 或者反过来漏掉正文里明明白白写着的那一处。所以正反两面都要守。
 *
 * `findUnlinkedMentions(source, candidates)` 的第二个参数是「这篇文档能被 `[[…]]`
 * 指到的写法」，与 `resolveWikiLink` 同一份口径。
 */

/** 简写：只要命中的原文。 */
function texts(source: string, candidates: string[]): string[] {
  return findUnlinkedMentions(source, candidates).map((mention) => mention.text);
}

describe('未链接提及', () => {
  const DMA = ['dma'];

  it('正文里光秃秃地提到就命中', () => {
    expect(texts('见 dma 那篇。', DMA)).toEqual(['dma']);
  });

  it('大小写不敏感，但**保留源码里的大小写**', () => {
    // 用户看到的是自己写的那个词，不是候选表里的小写形式
    expect(texts('见 DMA 那篇。', DMA)).toEqual(['DMA']);
  });

  describe('排除已经写在链接里的', () => {
    it('`[[dma]]` 里的不算 —— 它已经是链接了', () => {
      expect(texts('见 [[dma]]。', DMA)).toEqual([]);
    });

    it('`[[dma|别名]]` 里的也不算', () => {
      expect(texts('见 [[dma|那篇]]。', DMA)).toEqual([]);
    });

    it('Markdown 链接的文字部分不算', () => {
      expect(texts('见 [dma](notes/dma.md)。', DMA)).toEqual([]);
    });

    it('图片链接里也不算', () => {
      expect(texts('![dma](dma.png)', DMA)).toEqual([]);
    });

    it('同一篇里另有一处光秃秃的仍然要报', () => {
      // 判据是**位置**不是目标：已经链接过的那一处不报，另一处照报
      const source = '见 [[dma]]。另外 dma 也很重要。';
      const mentions = findUnlinkedMentions(source, DMA);

      expect(mentions).toHaveLength(1);
      expect(source.slice(mentions[0]!.from, mentions[0]!.to)).toBe('dma');
    });
  });

  describe('排除代码', () => {
    it('行内代码里的不算', () => {
      expect(texts('配置 `dma` 参数。', DMA)).toEqual([]);
    });

    it('围栏代码块里的不算', () => {
      expect(texts('```c\nint dma;\n```\n', DMA)).toEqual([]);
    });

    it('缩进代码块里的不算', () => {
      expect(texts('示例：\n\n    int dma;\n', DMA)).toEqual([]);
    });

    it('frontmatter 里的不算', () => {
      expect(texts('---\ntitle: dma\n---\n\n正文。', DMA)).toEqual([]);
    });

    it('CRLF 文件里同样认得出（围栏要靠剥 `\\r` 才判得对）', () => {
      // 不剥 `\r` 的话围栏认不出来，整块代码会被当成正文 —— 单测全绿、真实数据全错
      expect(texts('```c\r\nint dma;\r\n```\r\n\r\n正文里 dma 出现了。\r\n', DMA)).toEqual(['dma']);
    });
  });

  describe('词边界', () => {
    it('不匹配更长的词的一部分', () => {
      // `dmax` 里没有提到 `dma` —— 报出来用户会觉得「我根本没写」
      expect(texts('dmax 是另一个东西。', DMA)).toEqual([]);
    });

    it('前面粘着字母也不算', () => {
      expect(texts('adma 不是 dma。', DMA)).toEqual(['dma']);
    });

    it('下划线算词字符', () => {
      expect(texts('dma_ctrl 与 dma。', DMA)).toEqual(['dma']);
    });

    it('两侧是标点时照常命中', () => {
      expect(texts('（dma）、dma：dma。', DMA)).toEqual(['dma', 'dma', 'dma']);
    });
  });

  describe('候选写法', () => {
    it('长的候选优先，短的不会吃掉它的尾巴', () => {
      // 候选里同时有 `dma` 与 `notes/dma` 时，`notes/dma` 必须先匹配
      expect(texts('见 notes/dma。', ['dma', 'notes/dma'])).toEqual(['notes/dma']);
    });

    it('候选顺序不影响结果（内部按长度排序）', () => {
      expect(texts('见 notes/dma。', ['notes/dma', 'dma'])).toEqual(['notes/dma']);
    });

    it('太短的候选被忽略 —— 否则会把列表冲掉', () => {
      // 一个叫 `a.md` 的文档，候选是 `a`，正文里到处都命中
      expect(texts('a 与 b 与 ab。', ['a'])).toEqual([]);
      // 两个字符就收
      expect(texts('见 ab 那篇。', ['ab'])).toEqual(['ab']);
    });

    it('空候选或空源码返回空数组', () => {
      expect(texts('见 dma。', [])).toEqual([]);
      expect(texts('', ['dma'])).toEqual([]);
      expect(texts('见 dma。', ['', '  '])).toEqual([]);
    });

    it('候选里的正则元字符按字面处理', () => {
      // `v1.2` 里的 `.` 不能变成「任意字符」，否则 `v1x2` 也会命中
      expect(texts('见 v1.2 与 v1x2。', ['v1.2'])).toEqual(['v1.2']);
    });
  });

  describe('摘录', () => {
    it('给的是命中处所在的那一行', () => {
      const mentions = findUnlinkedMentions('第一行。\n见 dma 那篇。\n第三行。', DMA);
      expect(mentions[0]!.excerpt).toBe('见 dma 那篇。');
    });

    it('长行围绕命中处截断，两端带省略号', () => {
      const long = `${'前'.repeat(120)} dma ${'后'.repeat(120)}`;
      const excerpt = findUnlinkedMentions(long, DMA)[0]!.excerpt;

      expect(excerpt.length).toBeLessThan(long.length);
      expect(excerpt).toContain('dma');
      expect(excerpt.startsWith('…')).toBe(true);
      expect(excerpt.endsWith('…')).toBe(true);
    });

    it('摘录末尾不带 CRLF 的 `\\r`', () => {
      const mentions = findUnlinkedMentions('见 dma。\r\n下一行。\r\n', DMA);
      expect(mentions[0]!.excerpt).toBe('见 dma。');
    });
  });

  it('偏移能直接拿去切片', () => {
    const source = '见 dma 那篇。';
    const mention = findUnlinkedMentions(source, DMA)[0]!;
    expect(source.slice(mention.from, mention.to)).toBe(mention.text);
  });
});
