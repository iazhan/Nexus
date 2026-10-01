import { describe, it, expect } from 'vitest';
import { documentTypeForPath, type IndexedDocument } from '@nexus/core';
import { buildWorkspaceImageOptions } from '../src/workspace/image-picker.js';

function doc(relativePath: string, overrides: Partial<IndexedDocument> = {}): IndexedDocument {
  const name = relativePath.split('/').pop() ?? relativePath;
  return {
    id: 0,
    path: `/vault/${relativePath}`,
    relativePath,
    name,
    title: name.replace(/\.[^.]+$/, ''),
    type: documentTypeForPath(relativePath) ?? 'markdown',
    sizeBytes: 1,
    modifiedAtMs: 1,
    contentHash: 'x',
    extractionStatus: 'none',
    ...overrides
  };
}

describe('工作区图片列表', () => {
  it('只收图片，Markdown 与其它附件不进列表', () => {
    const options = buildWorkspaceImageOptions(
      [doc('a.md'), doc('assets/logo.png'), doc('manual.pdf'), doc('shot.JPEG')],
      '/vault',
      '/vault'
    );

    expect(options.map((option) => option.name)).toEqual(['logo.png', 'shot.JPEG']);
  });

  it('`![](…)` 那份地址相对**当前文档目录**', () => {
    // 标准 Markdown 的基准，只此一档。混成工作区根会写出一条指向别处、
    // 而且不报错的路径。
    const options = buildWorkspaceImageOptions([doc('assets/logo.png')], '/vault/notes/daily', '/vault');

    expect(options[0]!.path).toBe('../../assets/logo.png');
  });

  it('`![[…]]` 那份地址是全库唯一时的裸名 —— 与 Obsidian 写出来的一致', () => {
    // 裸名最稳：图跟着笔记一起搬走，引用不用改。Obsidian 也是这么写的，
    // 写别的形状会让同一篇笔记在两个工具里来回编辑时被反复改写。
    const options = buildWorkspaceImageOptions([doc('assets/logo.png')], '/vault/notes/daily', '/vault');

    expect(options[0]!.wikiPath).toBe('logo.png');
  });

  it('`![[…]]` 那份地址在同名时退到**工作区根相对**路径', () => {
    // 两个 `logo.png` 都在，裸名指不明 —— 这时才用完整路径，且基准是工作区根
    // （wikilink 的规矩），不是当前文档目录。
    const options = buildWorkspaceImageOptions(
      [doc('assets/logo.png'), doc('brand/logo.png')],
      '/vault/notes/daily',
      '/vault'
    );

    expect(options.map((option) => option.wikiPath)).toEqual(['assets/logo.png', 'brand/logo.png']);
    // 同一批选项里，Markdown 那份仍按文档目录算
    expect(options.map((option) => option.path)).toEqual([
      '../../assets/logo.png',
      '../../brand/logo.png'
    ]);
  });

  it('文档与图片同目录时两份地址都是文件名本身', () => {
    // 真实 vault 里最常见的一格：`![[MAIN.png]]` 与 `MAIN.png` 都在文档旁边，
    // 写出来必须是裸文件名（带 `./` 反而不符合既有笔记的写法）。
    const options = buildWorkspaceImageOptions([doc('EZCODE/2024/MAIN.png')], '/vault/EZCODE/2024', '/vault');

    expect(options[0]!.path).toBe('MAIN.png');
    expect(options[0]!.wikiPath).toBe('MAIN.png');
  });

  it('缩略图走 nexus-asset://，与内嵌图片同一条通道', () => {
    const options = buildWorkspaceImageOptions([doc('assets/logo.png')], '/vault', '/vault');

    expect(options[0]!.url.startsWith('nexus-asset://')).toBe(true);
    expect(decodeURIComponent(options[0]!.url)).toContain('/vault/assets/logo.png');
  });

  it('同名文件带上相对路径消歧', () => {
    const options = buildWorkspaceImageOptions(
      [doc('assets/logo.png'), doc('brand/logo.png'), doc('assets/only.png')],
      '/vault',
      '/vault'
    );

    expect(options.map((option) => option.name)).toEqual([
      'assets/logo.png',
      'brand/logo.png',
      'only.png'
    ]);
  });

  it('没有文档目录（新建未保存）时不提供列表 —— 相对谁都不知道', () => {
    expect(buildWorkspaceImageOptions([doc('assets/logo.png')], null, '/vault')).toEqual([]);
  });

  it('跨卷算不出相对路径的项直接丢掉，不写一条解析不了的地址', () => {
    const options = buildWorkspaceImageOptions(
      [doc('assets/logo.png', { path: 'D:/other/logo.png' })],
      '/vault',
      '/vault'
    );

    expect(options).toEqual([]);
  });
});
