import { describe, it, expect } from 'vitest';
import type { IndexedDocument } from '@nexus/core';
import { resolveWikiLink } from '../src/workspace/wikilink.js';

function doc(relativePath: string): IndexedDocument {
  const name = relativePath.split('/').pop() ?? relativePath;
  return {
    id: 0,
    path: `/vault/${relativePath}`,
    relativePath,
    name,
    title: name.replace(/\.[^.]+$/, ''),
    sizeBytes: 1,
    modifiedAtMs: 1,
    contentHash: 'x'
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
