import { describe, expect, it } from 'vitest';
import {
  documentTitleOf,
  fileNameOf,
  formatDocumentCitation,
  pageAnchorOf,
  parsePageAnchor,
  relativePathFrom
} from '../src/index.js';

/**
 * P3-11 的引用生成：**路径相对工作区**、**页码锚点能被自己的 Viewer 认出来**。
 *
 * 这两条是验收第 4 条（引用闭环）的两半，所以分开测：路径算错的表现是
 * 「点进去说找不到文件」，锚点写错的表现是「打开了但停在第 1 页」—— 两种故障
 * 长得完全不同，混在一条用例里会看不出是哪一半坏了。
 */
describe('parsePageAnchor', () => {
  it('读出 #page=N —— 蓝图 §11.4 的形式', () => {
    expect(parsePageAnchor('#page=342')).toBe(342);
    expect(parsePageAnchor('attachments/stm32.pdf#page=3')).toBe(3);
  });

  it('大小写不敏感，且允许片段里带别的参数', () => {
    // 自己将来往锚点里加东西时，读不到 page 才算坏
    expect(parsePageAnchor('#Page=7')).toBe(7);
    expect(parsePageAnchor('#page=7&zoom=150')).toBe(7);
  });

  it('页码从 1 起 —— 0 / 负数 / 小数都不是页码', () => {
    expect(parsePageAnchor('#page=0')).toBeNull();
    expect(parsePageAnchor('#page=-1')).toBeNull();
    expect(parsePageAnchor('#page=3.5')).toBeNull();
    expect(parsePageAnchor('#page=abc')).toBeNull();
    expect(parsePageAnchor('#page=')).toBeNull();
  });

  it('只认 # 片段，不认查询串', () => {
    // 锚点是文档内的位置，查询串是给服务端的参数 —— 两种解释会让切分规则分叉
    expect(parsePageAnchor('a.pdf?page=3')).toBeNull();
    expect(parsePageAnchor('#anchor')).toBeNull();
    expect(parsePageAnchor('a.pdf')).toBeNull();
    expect(parsePageAnchor('')).toBeNull();
  });
});

describe('pageAnchorOf', () => {
  it('正整数写成锚点，其余写空串', () => {
    expect(pageAnchorOf(1)).toBe('#page=1');
    expect(pageAnchorOf(342)).toBe('#page=342');
    // 链接仍然有效，只是不定位 —— 这比编一个 #page=0 诚实
    expect(pageAnchorOf(0)).toBe('');
    expect(pageAnchorOf(-2)).toBe('');
    expect(pageAnchorOf(1.5)).toBe('');
  });
});

describe('relativePathFrom', () => {
  const vault = 'D:\\vault';

  it('工作区内的路径按段算，正斜杠输出', () => {
    expect(relativePathFrom(vault, 'D:\\vault\\attachments\\stm32.pdf')).toBe(
      'attachments/stm32.pdf'
    );
    expect(relativePathFrom(vault, 'D:\\vault\\index.md')).toBe('index.md');
  });

  it('从子目录出发要往上走', () => {
    expect(relativePathFrom('D:\\vault\\notes', 'D:\\vault\\a.pdf')).toBe('../a.pdf');
    expect(relativePathFrom('D:\\vault\\notes\\deep', 'D:\\vault\\a.pdf')).toBe('../../a.pdf');
  });

  it('大小写只用于比较，输出保留磁盘上的原始写法', () => {
    expect(relativePathFrom('d:\\VAULT', 'D:\\vault\\Assets\\Logo.PNG')).toBe('Assets/Logo.PNG');
  });

  it('跨盘符没有相对路径 —— 返回 null 而不是编一个', () => {
    expect(relativePathFrom('D:\\vault', 'E:\\other\\a.pdf')).toBeNull();
    expect(relativePathFrom('/home/azhan', 'D:\\vault\\a.pdf')).toBeNull();
  });

  it('UNC 同共享可算，不同共享不可算', () => {
    expect(relativePathFrom('\\\\host\\share\\vault', '\\\\host\\share\\vault\\a.pdf')).toBe('a.pdf');
    expect(relativePathFrom('\\\\host\\share', '\\\\host\\other\\a.pdf')).toBeNull();
  });

  it('POSIX 路径同样成立', () => {
    expect(relativePathFrom('/home/azhan/vault', '/home/azhan/vault/a/b.pdf')).toBe('a/b.pdf');
  });

  it('相同路径与相对路径都给 null —— 没有可写进链接的东西', () => {
    expect(relativePathFrom(vault, vault)).toBeNull();
    expect(relativePathFrom('', 'D:\\vault\\a.pdf')).toBeNull();
    expect(relativePathFrom('vault', 'D:\\vault\\a.pdf')).toBeNull();
  });
});

describe('documentTitleOf / fileNameOf', () => {
  it('标题是去扩展名的文件名', () => {
    expect(documentTitleOf('D:\\vault\\attachments\\stm32.pdf')).toBe('stm32');
    expect(fileNameOf('D:\\vault\\attachments\\stm32.pdf')).toBe('stm32.pdf');
  });

  it('多个点只去掉最后一个扩展名', () => {
    expect(documentTitleOf('a/b.rev2.pdf')).toBe('b.rev2');
  });

  it('前导点不是扩展名 —— .gitignore 保持原样', () => {
    expect(documentTitleOf('D:\\vault\\.gitignore')).toBe('.gitignore');
  });
});

describe('formatDocumentCitation', () => {
  const base = {
    targetPath: 'D:\\vault\\attachments\\stm32.pdf',
    baseDirectory: 'D:\\vault',
    page: 342
  };

  it('完整形状：引用块 + 空行 + 带页码锚点的链接', () => {
    expect(formatDocumentCitation({ ...base, quote: 'DMA controller supports ...' })).toBe(
      '> DMA controller supports ...\n\n[stm32](attachments/stm32.pdf#page=342)'
    );
  });

  it('引文里的空白折成一个空格 —— text layer 的换行是排版产物', () => {
    // 真选区里既有 span 之间的空格也有行末的换行，两者无法区分语义
    expect(formatDocumentCitation({ ...base, quote: 'DMA   controller\nsupports\n\nburst' })).toBe(
      '> DMA controller supports burst\n\n[stm32](attachments/stm32.pdf#page=342)'
    );
  });

  it('没有引文时只输出链接行 —— 用户可能只想引用这份文档', () => {
    expect(formatDocumentCitation({ ...base, quote: '   ' })).toBe(
      '[stm32](attachments/stm32.pdf#page=342)'
    );
  });

  it('标题可以覆盖，且方括号被转义', () => {
    expect(formatDocumentCitation({ ...base, quote: 'x', title: 'STM32F4 [RM]' })).toBe(
      '> x\n\n[STM32F4 \\[RM\\]](attachments/stm32.pdf#page=342)'
    );
  });

  it('路径含空格时用尖括号包裹 —— 否则空格会截断链接目标', () => {
    expect(
      formatDocumentCitation({
        quote: 'x',
        targetPath: 'D:\\vault\\my docs\\ref manual.pdf',
        baseDirectory: 'D:\\vault',
        page: 2
      })
    ).toBe('> x\n\n[ref manual](<my docs/ref manual.pdf#page=2>)');
  });

  it('页码非法时链接照写、不写锚点', () => {
    expect(formatDocumentCitation({ ...base, quote: 'x', page: 0 })).toBe(
      '> x\n\n[stm32](attachments/stm32.pdf)'
    );
  });

  it('跨盘符退回文件名 —— 相对路径不存在，但引用本身仍指向磁盘上的文件', () => {
    expect(
      formatDocumentCitation({
        quote: 'x',
        targetPath: 'E:\\shared\\spec.pdf',
        baseDirectory: 'D:\\vault',
        page: 5
      })
    ).toBe('> x\n\n[spec](spec.pdf#page=5)');
  });
});
