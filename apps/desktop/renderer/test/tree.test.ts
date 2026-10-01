import { describe, it, expect } from 'vitest';
import {
  documentTypeForPath,
  type IndexedDocument,
  type WorkspaceDirectoryEntry
} from '@nexus/core';
import {
  buildFileTree,
  collectDirectoryPaths,
  defaultExpandedDirectories,
  findParentDirectory,
  findTreeNode,
  isAttachmentNode,
  isImageNode
} from '../src/workspace/tree.js';

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

/** 目录列举里的一项。绝对路径由相对路径拼出来，与主进程给的一致。 */
function dir(relativePath: string): WorkspaceDirectoryEntry {
  const name = relativePath.split('/').pop() ?? relativePath;
  return { path: `/vault/${relativePath}`, relativePath, name };
}

describe('文件树构建', () => {
  it('顶层文件直接成为根节点', () => {
    const tree = buildFileTree({ documents: [doc('a.md'), doc('b.md')], directories: [] });

    expect(tree.map((node) => [node.name, node.type])).toEqual([
      ['a.md', 'file'],
      ['b.md', 'file']
    ]);
    expect(tree[0]!.path).toBe('/vault/a.md');
  });

  it('目录来自**磁盘列举**，因此空目录也在树里', () => {
    // 这正是第二条数据源存在的理由：索引里只有文件，`assets/` 一个文件都没有，
    // 只靠索引的话它根本不会出现 —— 用户新建一个文件夹，界面上什么都不会发生。
    const tree = buildFileTree({ documents: [], directories: [dir('assets')] });

    expect(tree).toHaveLength(1);
    expect([tree[0]!.name, tree[0]!.type, tree[0]!.path]).toEqual([
      'assets',
      'directory',
      '/vault/assets'
    ]);
    expect(tree[0]!.children).toEqual([]);
  });

  it('目录带绝对路径 —— 它现在是磁盘上的真实实体（工具栏要拿它当落点）', () => {
    const tree = buildFileTree({
      documents: [doc('notes/a.md')],
      directories: [dir('notes'), dir('notes/deep')]
    });

    const notes = tree[0]!;
    expect([notes.name, notes.type, notes.path]).toEqual(['notes', 'directory', '/vault/notes']);
    expect(notes.children.map((child) => child.name)).toEqual(['deep', 'a.md']);
    expect(notes.children[0]!.path).toBe('/vault/notes/deep');
  });

  it('文件所在的目录不在列举里时**补一个**，而不是把文件丢掉', () => {
    // 两次调用之间目录被删掉的那个窗口会走到这里。丢掉文件的话它会从树上消失，
    // 而它确实在磁盘上、也确实在索引里 —— 用户看到的是「我的笔记不见了」。
    const tree = buildFileTree({ documents: [doc('notes/deep/a.md')], directories: [] });

    const notes = tree[0]!;
    expect([notes.name, notes.type]).toEqual(['notes', 'directory']);
    // 补出来的节点没有绝对路径 —— 它只用于显示，不能当落点
    expect(notes.path).toBeNull();

    const deep = notes.children[0]!;
    expect(deep.path).toBeNull();
    expect(deep.children[0]!.name).toBe('a.md');
    expect(deep.children[0]!.path).toBe('/vault/notes/deep/a.md');
  });

  it('目录恒排在文件前面', () => {
    const tree = buildFileTree({
      documents: [doc('zzz.md'), doc('aaa.md')],
      directories: [dir('mmm')]
    });

    expect(tree.map((node) => node.type)).toEqual(['directory', 'file', 'file']);
  });

  it('名字里的数字按**数值**比，不是按字典序（`file10` 要排在 `file2` 后面）', () => {
    const tree = buildFileTree({
      documents: [doc('file10.md'), doc('file2.md'), doc('file1.md')],
      directories: []
    });

    // 裸 `localeCompare` 会给 `file1, file10, file2` —— 那是用户一眼能看出的错。
    expect(tree.map((node) => node.name)).toEqual(['file1.md', 'file2.md', 'file10.md']);
  });

  it('重复的目录项被去重，不产生两个同名节点', () => {
    const tree = buildFileTree({ documents: [], directories: [dir('notes'), dir('notes')] });

    expect(tree).toHaveLength(1);
  });

  it('目录列举顺序被打乱也能建出正确的层级', () => {
    const tree = buildFileTree({
      documents: [doc('a/b/c.md')],
      // 故意把子目录放在父目录前面
      directories: [dir('a/b'), dir('a')]
    });

    expect(tree[0]!.name).toBe('a');
    expect(tree[0]!.children[0]!.name).toBe('b');
    expect(tree[0]!.children[0]!.children[0]!.name).toBe('c.md');
  });
});

describe('收集目录路径', () => {
  it('深度优先、父在子前，只收目录', () => {
    const tree = buildFileTree({
      documents: [doc('a/b/c.md'), doc('a/x.md')],
      directories: [dir('a'), dir('a/b'), dir('top')]
    });

    // 「全部展开 / 收起」的判据与动作都从它算 —— 顺序不重要，**集合要一致**才重要
    expect(collectDirectoryPaths(tree).sort()).toEqual(['a', 'a/b', 'top']);
  });

  it('空目录也在里面 —— 它也是树里的一层', () => {
    const tree = buildFileTree({ documents: [], directories: [dir('empty')] });

    expect(collectDirectoryPaths(tree)).toEqual(['empty']);
  });

  it('没有目录时返回空数组（工具栏据此不渲染那枚按钮）', () => {
    const tree = buildFileTree({ documents: [doc('a.md')], directories: [] });

    expect(collectDirectoryPaths(tree)).toEqual([]);
  });
});

describe('默认展开', () => {
  it('只展开顶层目录', () => {
    const tree = buildFileTree({
      documents: [doc('a/b/c.md')],
      directories: [dir('a'), dir('a/b'), dir('top')]
    });

    const expanded = defaultExpandedDirectories(tree);
    // `top` 与 `a` 是顶层，`a/b` 不是
    expect(expanded.has('top')).toBe(true);
    expect(expanded.has('a')).toBe(true);
    expect(expanded.has('a/b')).toBe(false);
  });
});

describe('查找与判定', () => {
  const tree = buildFileTree({
    documents: [doc('notes/a.md'), doc('assets/logo.png')],
    directories: [dir('notes'), dir('assets'), dir('empty')]
  });

  it('findTreeNode 按相对路径找得到文件与目录', () => {
    expect(findTreeNode(tree, 'notes/a.md')?.type).toBe('file');
    expect(findTreeNode(tree, 'empty')?.type).toBe('directory');
    expect(findTreeNode(tree, 'nope')).toBeNull();
  });

  it('findParentDirectory 给的是**父目录节点**，顶层返回 null（＝工作区根）', () => {
    expect(findParentDirectory(tree, 'notes/a.md')?.relativePath).toBe('notes');
    expect(findParentDirectory(tree, 'root.md')).toBeNull();
  });

  it('附件判定走 core 的白名单：不是 Markdown 的都算附件（决定画哪枚图标）', () => {
    const png = findTreeNode(tree, 'assets/logo.png')!;
    const md = findTreeNode(tree, 'notes/a.md')!;
    const folder = findTreeNode(tree, 'assets')!;

    expect(isAttachmentNode(png)).toBe(true);
    expect(isAttachmentNode(md)).toBe(false);
    // 目录永远不是附件
    expect(isAttachmentNode(folder)).toBe(false);
  });

  it('图片判定比附件窄：只有 `type === "image"` 才是', () => {
    const withPdf = buildFileTree({
      documents: [doc('assets/logo.png'), doc('手册.pdf'), doc('规格.docx')],
      directories: [dir('assets')]
    });

    // 「显示图片」这个开关过滤的是它 —— 判据比 `isAttachmentNode` 窄一档，
    // 否则关掉图片会把 PDF / DOCX 一起藏掉。
    expect(isImageNode(findTreeNode(withPdf, 'assets/logo.png')!)).toBe(true);
    expect(isImageNode(findTreeNode(withPdf, '手册.pdf')!)).toBe(false);
    expect(isImageNode(findTreeNode(withPdf, '规格.docx')!)).toBe(false);
    expect(isImageNode(findTreeNode(withPdf, 'assets')!)).toBe(false);
  });
});
