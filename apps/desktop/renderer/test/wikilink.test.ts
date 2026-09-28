import { describe, it, expect } from 'vitest';
import { documentTypeForPath, type IndexedDocument } from '@nexus/core';
import { resolveWikiLink } from '../src/workspace/wikilink.js';

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
