import { describe, it, expect } from 'vitest';
import { documentTypeForPath, type IndexedDocument } from '@nexus/core';
import { buildFileTree, type FileTreeNode } from '../src/workspace/tree.js';
import { filterTreeByImageVisibility } from '../src/workspace/tree-filter.js';

function doc(relativePath: string): IndexedDocument {
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
    extractionStatus: 'none'
  };
}

function dir(relativePath: string) {
  const name = relativePath.split('/').pop() ?? relativePath;
  return { path: `/vault/${relativePath}`, relativePath, name };
}

/** 把树拍成 `relativePath` 列表，方便断言「哪些还在」。 */
function paths(nodes: readonly FileTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly FileTreeNode[]) => {
    for (const node of list) {
      out.push(node.relativePath);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

describe('按「显示图片」过滤树', () => {
  const tree = buildFileTree({
    documents: [
      doc('root.md'),
      doc('notes/a.md'),
      doc('assets/logo.png'),
      doc('assets/cover.jpg'),
      doc('notes/图.png'),
      doc('datasheet.pdf'),
      doc('spec.docx')
    ],
    directories: [dir('notes'), dir('assets'), dir('empty')]
  });

  it('开着的时候原样返回，一张都不藏', () => {
    const result = filterTreeByImageVisibility(tree, true);

    expect(result.hiddenImageCount).toBe(0);
    expect(result.nodes).toBe(tree);
  });

  it('关掉之后只藏**图片**，PDF 与 DOCX 照常显示', () => {
    const result = filterTreeByImageVisibility(tree, false);
    const kept = paths(result.nodes);

    expect(kept).not.toContain('assets/logo.png');
    expect(kept).not.toContain('assets/cover.jpg');
    expect(kept).not.toContain('notes/图.png');

    // 这条是这一栏最要紧的判据：这个开关的意图是「树被图淹了」，
    // 而 PDF / DOCX 通常正是要找的东西 —— 一起藏起来只会让人以为文件丢了。
    expect(kept).toContain('datasheet.pdf');
    expect(kept).toContain('spec.docx');

    expect(result.hiddenImageCount).toBe(3);
  });

  it('**因过滤才变空**的目录被丢掉，**本来就空**的目录留着', () => {
    const kept = paths(filterTreeByImageVisibility(tree, false).nodes);

    // `assets/` 里两张图全被藏了 → 它跟着消失。留着的话用户看到一个空目录，
    // 而里面其实有东西 —— 那是界面在说谎。
    expect(kept).not.toContain('assets');
    // `empty/` 本来就是空的 → 留着。用户正要往里放东西。
    expect(kept).toContain('empty');
  });

  it('目录里还留着 PDF 时，目录与图片之外的东西都在', () => {
    const withPdf = buildFileTree({
      documents: [doc('手册/a.pdf'), doc('手册/b.png')],
      directories: [dir('手册')]
    });

    const result = filterTreeByImageVisibility(withPdf, false);
    expect(paths(result.nodes)).toEqual(['手册', '手册/a.pdf']);
  });

  it('全是图片时结果是空树 —— 侧栏据此显示「显示全部」那条出路', () => {
    const onlyImages = buildFileTree({
      documents: [doc('assets/a.png'), doc('assets/b.webp')],
      directories: [dir('assets')]
    });

    const result = filterTreeByImageVisibility(onlyImages, false);
    expect(result.nodes).toEqual([]);
    expect(result.hiddenImageCount).toBe(2);
  });

  it('过滤不会改动原树（返回的是新节点）', () => {
    const before = paths(tree);
    filterTreeByImageVisibility(tree, false);

    expect(paths(tree)).toEqual(before);
  });
});
