import { describe, it, expect } from 'vitest';
import {
  documentTypeForPath,
  resolveWikiLink,
  rewriteWikiLinkTarget,
  type IndexedDocument
} from '../src/index.js';

function doc(relativePath: string): IndexedDocument {
  const name = relativePath.split('/').pop() ?? relativePath;
  return {
    id: 0,
    path: `/vault/${relativePath}`,
    relativePath,
    name,
    title: name.replace(/\.[^.]+$/, ''),
    // 类型从路径推导，与索引层同一条判据 —— 手写死会让测试与白名单脱节，
    // 将来加了新扩展名这里不会跟着变。
    type: documentTypeForPath(relativePath) ?? 'markdown',
    sizeBytes: 1,
    modifiedAtMs: 1,
    contentHash: 'x',
    extractionStatus: 'none'
  };
}

/** 注意 dma 有两份同名，用来验证歧义处理。 */
const DOCS = [doc('root.md'), doc('notes/dma.md'), doc('archive/dma.md')];

describe('WikiLink 解析', () => {
  it('按文件名解析', () => {
    const result = resolveWikiLink('root', DOCS);
    expect(result.status).toBe('resolved');
    expect(result.document?.relativePath).toBe('root.md');
  });

  it('带 .md 与不带 .md 都能解析', () => {
    expect(resolveWikiLink('root', DOCS).status).toBe('resolved');
    expect(resolveWikiLink('root.md', DOCS).status).toBe('resolved');
  });

  it('大小写不敏感 —— 正文里写 DMA 不该因为磁盘上是 dma.md 就找不到', () => {
    expect(resolveWikiLink('ROOT', DOCS).document?.name).toBe('root.md');
  });

  it('去掉首尾空白', () => {
    expect(resolveWikiLink('  root  ', DOCS).status).toBe('resolved');
  });

  it('按相对路径解析，同名文件靠目录区分', () => {
    const result = resolveWikiLink('notes/dma', DOCS);
    expect(result.status).toBe('resolved');
    expect(result.document?.relativePath).toBe('notes/dma.md');
  });

  it('相对路径带 .md 也能解析', () => {
    expect(resolveWikiLink('notes/dma.md', DOCS).document?.relativePath).toBe('notes/dma.md');
  });

  it('同名文件落在不同目录时返回 ambiguous，而不是随便挑一个', () => {
    const result = resolveWikiLink('dma', DOCS);

    expect(result.status).toBe('ambiguous');
    expect(result.candidates.map((item) => item.relativePath)).toEqual([
      'notes/dma.md',
      'archive/dma.md'
    ]);
    // 歧义时不能给出「就用这个」的暗示
    expect(result.document).toBeUndefined();
  });

  it('找不到时返回 not-found，候选为空', () => {
    const result = resolveWikiLink('不存在的东西', DOCS);
    expect(result.status).toBe('not-found');
    expect(result.candidates).toEqual([]);
  });

  it('空目标返回 not-found', () => {
    expect(resolveWikiLink('', DOCS).status).toBe('not-found');
    expect(resolveWikiLink('   ', DOCS).status).toBe('not-found');
  });

  it('空工作区里任何目标都解析不到', () => {
    expect(resolveWikiLink('root', []).status).toBe('not-found');
  });
});

/**
 * Phase 3 / P3-04：候选里多了附件扩展名，于是 `[[stm32]]` 也能指向 `stm32.pdf`。
 *
 * 这一组的重点是**候选顺序**：它决定了同名共存时短名归谁。顺序由 core 的
 * `wikilinkCandidates()` 统一给出，索引层的反向链接用的是同一套口径 ——
 * 两处不一致会出现「能跳转但查不到反向链接」这种极难察觉的偏差。
 */
describe('WikiLink 解析：附件（Phase 3 / P3-04）', () => {
  const WITH_ATTACHMENTS = [doc('index.md'), doc('stm32.pdf'), doc('assets/diagram.png')];

  it('短名能解析到同名的附件', () => {
    const result = resolveWikiLink('stm32', WITH_ATTACHMENTS);

    expect(result.status).toBe('resolved');
    expect(result.document?.relativePath).toBe('stm32.pdf');
  });

  it('图片的短名同样能解析，跨目录也认', () => {
    expect(resolveWikiLink('diagram', WITH_ATTACHMENTS).document?.relativePath).toBe(
      'assets/diagram.png'
    );
  });

  it('写全名时精确指向附件', () => {
    expect(resolveWikiLink('stm32.pdf', WITH_ATTACHMENTS).document?.relativePath).toBe(
      'stm32.pdf'
    );
  });

  it('同名共存时短名归 Markdown，附件必须写全名', () => {
    const both = [doc('stm32.md'), doc('stm32.pdf')];

    // `.md` 排在附件扩展名之前 —— 这是契约，不是实现细节：
    // 笔记才是知识库的主体，短名默认指向笔记更符合预期。
    expect(resolveWikiLink('stm32', both).document?.relativePath).toBe('stm32.md');
    expect(resolveWikiLink('stm32.pdf', both).document?.relativePath).toBe('stm32.pdf');
  });

  it('带点但不是白名单扩展名的短名仍会展开', () => {
    // `v1.2` 里的 `.2` 不在白名单，所以它是个短名，要能指向 `v1.2.md`。
    // 判据若是「含点就不展开」，这条会静默失效。
    expect(resolveWikiLink('v1.2', [doc('v1.2.md')]).document?.relativePath).toBe('v1.2.md');
  });

  it('不在白名单里的扩展名不会凭空命中 Markdown', () => {
    // `[[readme.txt]]` 不该命中 `readme.md` —— 用户写出 `.txt` 显然不是想链接 Markdown
    expect(resolveWikiLink('readme.txt', [doc('readme.md')]).status).toBe('not-found');
  });
});

/**
 * 锚点（`[[dma#性能]]`）不参与「指向哪一篇」的判断。
 *
 * 全仓还没有「跳到某个标题」的能力，所以这里只保证**解析得出文档**：切掉 `#…` 再取候选。
 * 不切的话点一下会报「链接解析失败」，比打开到文档顶部更糟。
 */
describe('WikiLink 解析：锚点', () => {
  const ONE = [doc('dma.md')];

  it('带锚点时按锚点前的路径解析', () => {
    expect(resolveWikiLink('dma#性能', ONE).document?.relativePath).toBe('dma.md');
    expect(resolveWikiLink('notes/dma#性能', [doc('notes/dma.md')]).document?.relativePath).toBe(
      'notes/dma.md'
    );
  });

  it('锚点里的内容不影响解析结果', () => {
    expect(resolveWikiLink('dma#', ONE).status).toBe('resolved');
    expect(resolveWikiLink('dma#a#b', ONE).status).toBe('resolved');
    expect(resolveWikiLink('dma.md#性能', ONE).document?.relativePath).toBe('dma.md');
  });

  it('只有锚点（文档内跳转）解析不到文档', () => {
    expect(resolveWikiLink('#性能', ONE).status).toBe('not-found');
  });
});

/**
 * 回写：把「指向被改名那一篇」的写法改对，**保留用户写目标的方式**。
 *
 * 这个函数不做判定（判定在 `resolveWikiLink`），所以这里只管「四种写法各自怎么变」。
 */
describe('rewriteWikiLinkTarget', () => {
  const from = 'notes/dma.md';
  const to = 'notes/dma2.md';

  it('只写名字 → 只写新名字', () => {
    expect(rewriteWikiLinkTarget('dma', from, to)).toBe('dma2');
  });

  it('写工作区相对路径 → 换路径段', () => {
    expect(rewriteWikiLinkTarget('notes/dma', from, to)).toBe('notes/dma2');
  });

  it('显式写了扩展名 → 保留这个意图', () => {
    expect(rewriteWikiLinkTarget('dma.md', from, to)).toBe('dma2.md');
    expect(rewriteWikiLinkTarget('notes/dma.md', from, to)).toBe('notes/dma2.md');
  });

  it('锚点原样', () => {
    expect(rewriteWikiLinkTarget('dma#性能', from, to)).toBe('dma2#性能');
    expect(rewriteWikiLinkTarget('notes/dma.md#a#b', from, to)).toBe('notes/dma2.md#a#b');
  });

  it('大小写按磁盘上的真名写，不去猜用户的排版意图', () => {
    expect(rewriteWikiLinkTarget('DMA', from, to)).toBe('dma2');
    expect(rewriteWikiLinkTarget('NOTES/DMA.MD', from, to)).toBe('notes/dma2.md');
  });

  it('文档在根目录时「全路径」与「基名」重合，也要判对', () => {
    expect(rewriteWikiLinkTarget('dma.md', 'dma.md', 'dma2.md')).toBe('dma2.md');
    expect(rewriteWikiLinkTarget('dma', 'dma.md', 'dma2.md')).toBe('dma2');
  });

  it('附件被 wikilink 引用时同样只换写法', () => {
    expect(rewriteWikiLinkTarget('stm32', 'stm32.pdf', 'banner.pdf')).toBe('banner');
    expect(rewriteWikiLinkTarget('stm32.pdf', 'stm32.pdf', 'banner.pdf')).toBe('banner.pdf');
  });

  it('写不出安全语法时返回 null，不硬改', () => {
    // `]` 会让 wikilink 提前结束、`|` 会被当成别名分隔符
    expect(rewriteWikiLinkTarget('dma', from, 'notes/a]b.md')).toBeNull();
    expect(rewriteWikiLinkTarget('dma', from, 'notes/a|b.md')).toBeNull();
  });

  it('四种写法都认不出时返回 null', () => {
    // wikilink 的路径段是**工作区根相对**的，`../` 这种写法解析阶段本来就匹配不到
    expect(rewriteWikiLinkTarget('../dma', from, to)).toBeNull();
    expect(rewriteWikiLinkTarget('其它/dma', from, to)).toBeNull();
    expect(rewriteWikiLinkTarget('', from, to)).toBeNull();
    expect(rewriteWikiLinkTarget('#性能', from, to)).toBeNull();
  });
});
