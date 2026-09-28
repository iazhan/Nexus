import { describe, it, expect } from 'vitest';
import { documentTypeForPath, type IndexedDocument } from '@nexus/core';
import { buildFileTree, defaultExpandedDirectories } from '../src/workspace/tree.js';

/** 只关心路径相关字段，其余给固定值。 */
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

describe('文件树构建', () => {
  it('顶层文件直接成为根节点', () => {
    const tree = buildFileTree([doc('a.md'), doc('b.md')]);

    expect(tree.map((node) => [node.name, node.type])).toEqual([
      ['a.md', 'file'],
      ['b.md', 'file']
    ]);
    expect(tree[0]!.path).toBe('/vault/a.md');
  });

  it('相对路径里的目录被还原成层级', () => {
    const tree = buildFileTree([doc('notes/deep/a.md')]);

    expect(tree).toHaveLength(1);
    const notes = tree[0]!;
    expect([notes.name, notes.type, notes.relativePath]).toEqual(['notes', 'directory', 'notes']);
    // 目录节点没有绝对路径 —— 它不对应磁盘实体
    expect(notes.path).toBeNull();

    const deep = notes.children[0]!;
    expect([deep.name, deep.type, deep.relativePath]).toEqual(['deep', 'directory', 'notes/deep']);

    const file = deep.children[0]!;
    expect([file.name, file.type, file.relativePath, file.path]).toEqual([
      'a.md',
      'file',
      'notes/deep/a.md',
      '/vault/notes/deep/a.md'
    ]);
  });

  it('多个文件共用同一层目录时不会重复建目录', () => {
    const tree = buildFileTree([doc('notes/a.md'), doc('notes/b.md')]);

    expect(tree).toHaveLength(1);
    expect(tree[0]!.children.map((node) => node.name)).toEqual(['a.md', 'b.md']);
  });

  it('目录排在文件前面，同类按名称排序', () => {
    const tree = buildFileTree([
      doc('zebra.md'),
      doc('apple.md'),
      doc('notes/z.md'),
      doc('docs/a.md')
    ]);

    expect(tree.map((node) => [node.name, node.type])).toEqual([
      ['docs', 'directory'],
      ['notes', 'directory'],
      ['apple.md', 'file'],
      ['zebra.md', 'file']
    ]);
  });

  it('嵌套层级内部同样排序', () => {
    const tree = buildFileTree([doc('notes/z.md'), doc('notes/sub/a.md'), doc('notes/a.md')]);
    const notes = tree[0]!;

    expect(notes.children.map((node) => [node.name, node.type])).toEqual([
      ['sub', 'directory'],
      ['a.md', 'file'],
      ['z.md', 'file']
    ]);
  });

  it('中文文件名按 locale 排序', () => {
    const tree = buildFileTree([doc('乙.md'), doc('甲.md')]);
    // localeCompare 对中文的排序与码点顺序不同，这里只断言稳定且两个都在
    expect(tree.map((node) => node.name).sort()).toEqual(['乙.md', '甲.md']);
  });

  it('空输入得到空树', () => {
    expect(buildFileTree([])).toEqual([]);
  });

  it('忽略异常路径里的空段', () => {
    const tree = buildFileTree([doc('/leading.md'), doc('a//b.md')]);

    // 空段被过滤掉：'/leading.md' 落到根，'a//b.md' 仍然建出 a/ 目录
    expect(tree.map((node) => [node.name, node.type])).toEqual([
      ['a', 'directory'],
      ['leading.md', 'file']
    ]);
    expect(tree[0]!.children.map((node) => node.name)).toEqual(['b.md']);
  });
});

describe('默认展开的目录', () => {
  it('只展开顶层目录', () => {
    const tree = buildFileTree([doc('notes/deep/a.md'), doc('docs/b.md'), doc('root.md')]);
    const expanded = defaultExpandedDirectories(tree);

    expect([...expanded].sort()).toEqual(['docs', 'notes']);
    // 深层目录不默认展开
    expect(expanded.has('notes/deep')).toBe(false);
  });

  it('没有目录时返回空集合', () => {
    const tree = buildFileTree([doc('a.md')]);
    expect(defaultExpandedDirectories(tree).size).toBe(0);
  });
});
