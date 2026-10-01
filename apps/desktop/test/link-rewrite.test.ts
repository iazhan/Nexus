// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { documentTypeForPath, type IndexedDocument } from '@nexus/core';
import { maskCodeRegions, rewriteReferencesInSource } from '../electron/link-rewrite.js';

/**
 * 回写「指向被改名那一篇」的引用。
 *
 * 判定用 `resolveWikiLink()`（与「能不能跳转」同一套判据）+ `resolveWorkspacePath()`
 * （与索引期「这篇引用了哪些附件」同一套），所以这一层的用例都是**判据**的用例：
 * 谁该被改、谁不该被改、代码区为什么不算。
 */
function doc(relativePath: string): IndexedDocument {
  const name = relativePath.split('/').pop() ?? relativePath;
  return {
    id: 0,
    path: `C:/vault/${relativePath}`,
    relativePath,
    name,
    title: name.replace(/\.[^.]+$/, ''),
    type: documentTypeForPath(relativePath) ?? 'markdown',
    sizeBytes: 1,
    modifiedAtMs: 1,
    contentHash: 'x',
    extractionStatus: 'none'
  };
}

const DOCUMENTS = [
  doc('notes/dma.md'),
  doc('notes/other.md'),
  doc('assets/logo.png'),
  doc('attachments/stm32.pdf')
];

/** 简写：`notes/other.md` 里的一处引用，被改名的是 `notes/dma.md`。 */
function rewrite(
  source: string,
  from = 'notes/dma.md',
  to = 'notes/dma2.md',
  sourceRelativePath = 'notes/other.md'
): ReturnType<typeof rewriteReferencesInSource> {
  return rewriteReferencesInSource(source, sourceRelativePath, from, to, DOCUMENTS);
}

describe('rewriteReferencesInSource · wikilink', () => {
  it('只写名字 → 只写新名字', () => {
    expect(rewrite('参见 [[dma]]。').text).toBe('参见 [[dma2]]。');
  });

  it('写路径 / 带扩展名 / 带别名 / 带锚点都保留写法', () => {
    expect(rewrite('[[notes/dma]]').text).toBe('[[notes/dma2]]');
    expect(rewrite('[[dma.md]]').text).toBe('[[dma2.md]]');
    expect(rewrite('[[dma|DMA 那篇]]').text).toBe('[[dma2|DMA 那篇]]');
    expect(rewrite('[[dma#性能]]').text).toBe('[[dma2#性能]]');
  });

  it('用户写的首尾空白原样保留', () => {
    expect(rewrite('[[ dma ]]').text).toBe('[[ dma2 ]]');
  });

  it('一行里多处、重复引用，全都改', () => {
    expect(rewrite('[[dma]] 与 [[dma]]').text).toBe('[[dma2]] 与 [[dma2]]');
    expect(rewrite('[[dma]] 与 [[dma]]').count).toBe(2);
  });

  it('指向别处的引用不动，返回值与入参同一个字符串', () => {
    const source = '[[other]] 与 [[不存在的东西]] 与 [外部](https://example.com)';
    const result = rewrite(source);
    expect(result.text).toBe(source);
    expect(result.count).toBe(0);
    expect(result.unresolved).toEqual([]);
  });

  it('同名两篇时**不动** —— 猜错就是把链接改到别的文档上', () => {
    const ambiguous = [doc('notes/dma.md'), doc('archive/dma.md')];
    const result = rewriteReferencesInSource(
      '[[dma]]',
      'notes/other.md',
      'notes/dma.md',
      'notes/dma2.md',
      ambiguous
    );
    expect(result.text).toBe('[[dma]]');
    expect(result.count).toBe(0);
  });

  it('`[[dma.markdown]]` 不改 —— 它本来就跳不过去（归一化只去 `.md`）', () => {
    const result = rewrite('[[dma.markdown]]');
    expect(result.text).toBe('[[dma.markdown]]');
    expect(result.count).toBe(0);
  });

  it('写不出安全语法时计入 unresolved，而不是硬改', () => {
    const result = rewrite('[[dma]]', 'notes/dma.md', 'notes/a]b.md');
    expect(result.text).toBe('[[dma]]');
    expect(result.count).toBe(0);
    expect(result.unresolved).toEqual(['dma']);
  });
});

describe('rewriteReferencesInSource · 附件引用', () => {
  const from = 'assets/logo.png';
  const to = 'assets/logo2.png';

  it('文档相对写法只换文件名', () => {
    expect(rewrite('![x](../assets/logo.png)', from, to).text).toBe('![x](../assets/logo2.png)');
  });

  it('HTML img 只换 src，引号与其余属性一个字节都不动', () => {
    expect(rewrite('<img src="../assets/logo.png" width="200">', from, to).text).toBe(
      '<img src="../assets/logo2.png" width="200">'
    );
  });

  it('附件也能被 wikilink 引用，短名照旧', () => {
    const result = rewrite('[[logo]]', from, to);
    expect(result.text).toBe('[[logo2]]');
  });

  it('页码锚点原样', () => {
    expect(
      rewrite('见 [手册](../attachments/stm32.pdf#page=342)', 'attachments/stm32.pdf', 'attachments/stm32-v2.pdf')
        .text
    ).toBe('见 [手册](../attachments/stm32-v2.pdf#page=342)');
  });

  it('两种写法混在一篇里，一起改', () => {
    const source = '见 [[dma]]，图见 ![原理图](../assets/logo.png)。';
    expect(rewrite(source, 'notes/dma.md', 'notes/dma2.md').text).toBe(
      '见 [[dma2]]，图见 ![原理图](../assets/logo.png)。'
    );

    const both = rewriteReferencesInSource(
      source,
      'notes/other.md',
      'assets/logo.png',
      'assets/logo2.png',
      DOCUMENTS
    );
    expect(both.text).toBe('见 [[dma]]，图见 ![原理图](../assets/logo2.png)。');
  });
});

/**
 * 代码区不算引用。
 *
 * 这一组的价值在于：索引器当初刻意用正则、**连代码块里的 `[[...]]` 也收**（偏召回），
 * 而回写不能沿用那条取舍 —— 文档里到处是 `` `[[dma]]` `` 这样的例子，
 * 改它们就是把用户写的文档改成错的。
 */
describe('rewriteReferencesInSource · 代码区', () => {
  it('围栏代码块里的引用不动', () => {
    const source = '正文 [[dma]]\n\n```md\n[[dma]]\n```\n\n结尾 [[dma]]';
    expect(rewrite(source).text).toBe('正文 [[dma2]]\n\n```md\n[[dma]]\n```\n\n结尾 [[dma2]]');
  });

  it('波浪号围栏同样认', () => {
    expect(rewrite('~~~\n[[dma]]\n~~~').text).toBe('~~~\n[[dma]]\n~~~');
  });

  it('行内代码里的引用不动', () => {
    expect(rewrite('写作 `[[dma]]` 即可').text).toBe('写作 `[[dma]]` 即可');
  });

  it('等长反引号才算一对 —— `` 里可以包 `，包完不影响后面的正文', () => {
    expect(rewrite('``a`b`` 与 [[dma]]').text).toBe('``a`b`` 与 [[dma2]]');
    // 单个反引号包起来的仍然不算引用
    expect(rewrite('`[[dma]]` 与 [[dma]]').text).toBe('`[[dma]]` 与 [[dma2]]');
  });

  it('没配对的单个反引号是字面量（CommonMark 同款），里面的引用照改', () => {
    expect(rewrite('``[[dma]] 与 [[dma]]').text).toBe('``[[dma2]] 与 [[dma2]]');
  });

  it('未闭合的围栏一直掩到文件末尾（宁可不改，也不改错）', () => {
    expect(rewrite('```\n[[dma]]\n[[dma]]').text).toBe('```\n[[dma]]\n[[dma]]');
  });
});

describe('maskCodeRegions', () => {
  it('长度与换行位置都不变 —— 回写要靠偏移', () => {
    const source = 'a\n```\ncode\n```\nb';
    const masked = maskCodeRegions(source);
    expect(masked).toHaveLength(source.length);
    expect([...masked].map((c) => (c === '\n' ? '\n' : 'x')).join('')).toBe(
      [...source].map((c) => (c === '\n' ? '\n' : 'x')).join('')
    );
  });

  it('代码区的字符被换成填充字符，正文不受影响', () => {
    const masked = maskCodeRegions('正文 `code` 结尾');
    expect(masked).toContain('正文');
    expect(masked).toContain('结尾');
    expect(masked).not.toContain('code');
    expect(masked).toContain('\u0000');
  });

  it('没有代码区时只留下换行，其余全部原样', () => {
    const source = '没有代码区\n第二行';
    expect(maskCodeRegions(source)).toBe(source);
  });
});
