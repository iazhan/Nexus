import { describe, expect, it } from 'vitest';
import { CODE_FILLER, maskCodeRegions } from '../src/index.js';

/**
 * 这组用例原先住在 `apps/desktop/test/link-rewrite.test.ts`，随实现一起搬进 core ——
 * 渲染进程的「缓冲区重基准」也要用它，所以它不该待在主进程里。
 */
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
    expect(masked).toContain(CODE_FILLER);
  });

  it('没有代码区时只留下换行，其余全部原样', () => {
    const source = '没有代码区\n第二行';
    expect(maskCodeRegions(source)).toBe(source);
  });

  it('掩码是幂等的 —— 已经掩过的文本再掩一遍结果不变', () => {
    // `rewriteReferencesInSourceForMany()` 会连着掩两次（先 wikilink 再附件），
    // 第二次拿到的是**已经掩过**的文本。若不幂等，第二遍会把第一遍的成果毁掉。
    const once = maskCodeRegions('a\n```\ncode\n```\nb `inline` c');
    expect(maskCodeRegions(once)).toBe(once);
  });

  it('围栏的起止必须同字符且闭合串不短于开启串', () => {
    // `~~~` 开、``` ``` ``` 收 —— 不是同一个围栏，所以整段一直掩到末尾
    expect(maskCodeRegions('~~~\nx\n```\ny')).not.toContain('x');
    // 短于开启串的闭合串不算闭合（CommonMark）
    expect(maskCodeRegions('````\nx\n```\ny')).not.toContain('x');
    // 等长才算闭合
    expect(maskCodeRegions('```\nx\n```\ny')).toContain('y');
  });
});
