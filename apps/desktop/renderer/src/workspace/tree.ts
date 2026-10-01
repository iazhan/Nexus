import type { IndexedDocument, WorkspaceDirectoryEntry } from '@nexus/core';

/**
 * 文件树节点。
 *
 * ## 目录是一等实体（2026-10-01 改）
 *
 * 这里原来写着「目录**没有绝对路径** —— 索引里只有文件，目录是相对路径里推出来的，
 * 它不对应磁盘上的一个实体，别为了统一给目录编一个假路径」。
 *
 * 那条理由在**目录列举**（`listWorkspaceDirectories`）接进来之后不再成立：目录现在
 * 来自磁盘，是真实实体，而工具栏的「新建到选中目录」「删除选中项」都要拿它当落点。
 *
 * `path` 仍可能为 `null`，但原因变了：只在「索引里有文件、目录列举里却没有它所在的
 * 那一层」时才会出现 —— 那是两次调用之间目录被删掉的窗口。这种节点只用于**显示**，
 * 不能当落点。
 */
export interface FileTreeNode {
  name: string;
  relativePath: string;
  type: 'file' | 'directory';
  /** 绝对路径；补出来的目录节点为 `null`（见上）。 */
  path: string | null;
  /**
   * 文件节点对应的索引文档；目录节点为 `null`。
   *
   * 带上整份文档而不是只带一个 `type`：附件行要显示**大小**与**提取状态**，
   * 那两样都只有索引有。这不是「把索引塞进树」—— 树本来就是索引的投影，
   * `relativePath` 与 `name` 也来自它。
   */
  document: IndexedDocument | null;
  children: FileTreeNode[];
}

export interface FileTreeInput {
  /** 索引里的文档（Markdown + 附件）。 */
  documents: readonly IndexedDocument[];
  /** 磁盘上的目录。**这条让空目录可见** —— 索引里没有它们。 */
  directories: readonly WorkspaceDirectoryEntry[];
}

/**
 * 名字比较器。
 *
 * `numeric: true` 让 `file2` 排在 `file10` 前面 —— 裸 `localeCompare` 是字典序，
 * 会把 `file10` 排到 `file2` 前面，而那是用户一眼能看出的错。
 *
 * 第一个参数传 `undefined`（＝运行时默认 locale）是刻意的：这一栏里中英混排的先后
 * 本来就跟着系统语言走，把它钉死到某个 locale 会让另一台机器上的表现变样。
 * 代价是**跨语种顺序不可断言**（见 `.workbuddy-ai/memory/testing-pitfalls.md`）；
 * 数字之间的顺序不受影响，那部分可以断言。
 */
const nameCollator = new Intl.Collator(undefined, { numeric: true });

/**
 * 把「索引里的文档」与「磁盘上的目录」合并成层级树。
 *
 * ## 为什么是两路合并
 *
 * 索引里只有文件：目录是从 `relativePath` 反推的，所以一个还没放东西的 `assets/`
 * 在索引里根本不存在 —— 用户新建一个文件夹，界面上什么都不会发生。目录因此必须
 * 另外从磁盘拿一次，两路在这里合流。
 *
 * ## 补父目录而不是丢掉
 *
 * 文件所在的目录不在列举里时，**补一个 `path: null` 的目录节点**而不是把文件丢掉：
 * 丢掉的话它会从树上消失，而它确实在磁盘上、也确实在索引里 —— 用户看到的是
 * 「我的笔记不见了」。补出来的节点只用于显示。
 */
export function buildFileTree(input: FileTreeInput): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const directoriesByPath = new Map<string, FileTreeNode>();

  // 按深度排一次，保证每插入一个目录时它的父节点已经在 map 里。
  // 目录列举本身带这个顺序（先 push 再递归），这里再排一次是为了不依赖调用方。
  const sortedDirectories = [...input.directories].sort(
    (a, b) => depthOf(a.relativePath) - depthOf(b.relativePath)
  );

  for (const directory of sortedDirectories) {
    // 同一个相对路径出现两次只可能来自重复输入，去重比报错有用
    if (directoriesByPath.has(directory.relativePath)) continue;

    const node: FileTreeNode = {
      name: directory.name,
      relativePath: directory.relativePath,
      type: 'directory',
      path: directory.path,
      document: null,
      children: []
    };
    directoriesByPath.set(directory.relativePath, node);
    attach(roots, directoriesByPath, node);
  }

  for (const document of input.documents) {
    attach(roots, directoriesByPath, {
      name: document.name,
      relativePath: document.relativePath,
      type: 'file',
      path: document.path,
      document,
      children: []
    });
  }

  sortFileTree(roots);
  return roots;
}

/** 把节点挂到父目录下；父目录不在树里就补一个（`path: null`）。 */
function attach(
  roots: FileTreeNode[],
  directoriesByPath: Map<string, FileTreeNode>,
  node: FileTreeNode
): void {
  const parentPath = parentPathOf(node.relativePath);
  if (parentPath === null) {
    roots.push(node);
    return;
  }

  let parent = directoriesByPath.get(parentPath);
  if (!parent) {
    parent = {
      name: lastSegment(parentPath),
      relativePath: parentPath,
      type: 'directory',
      path: null,
      document: null,
      children: []
    };
    directoriesByPath.set(parentPath, parent);
    attach(roots, directoriesByPath, parent);
  }

  parent.children.push(node);
}

function parentPathOf(relativePath: string): string | null {
  const slash = relativePath.lastIndexOf('/');
  return slash < 0 ? null : relativePath.slice(0, slash);
}

function lastSegment(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  return slash < 0 ? relativePath : relativePath.slice(slash + 1);
}

function depthOf(relativePath: string): number {
  let depth = 0;
  for (const char of relativePath) {
    if (char === '/') depth += 1;
  }
  return depth;
}

/**
 * 目录优先，同类按名称。就地排序。
 *
 * 目录恒排文件前是**两个参考实现一致**的做法（Markra 的 `sortTreeNodes`、
 * OpenKnowledge 的树），理由也朴素：目录与文件混排时，那条分界线每次都要重新看一遍。
 */
export function sortFileTree(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return nameCollator.compare(a.name, b.name);
  });

  for (const node of nodes) {
    sortFileTree(node.children);
  }
}

/**
 * 树里所有目录的相对路径（深度优先，父在子前）。
 *
 * 「全部展开 / 收起」两处都要它：一个算「现在是不是全展开」，一个算「该写进展开集合
 * 的是哪些」。**两处必须同源** —— 各算一份的话，判据与动作会在「空目录算不算」
 * 这类细节上漂开，症状是按钮按下去没反应（或反过来，永远显示「全部展开」）。
 */
export function collectDirectoryPaths(nodes: readonly FileTreeNode[]): string[] {
  const paths: string[] = [];

  const walk = (list: readonly FileTreeNode[]): void => {
    for (const node of list) {
      if (node.type !== 'directory') continue;
      paths.push(node.relativePath);
      walk(node.children);
    }
  };

  walk(nodes);
  return paths;
}

/**
 * 默认展开的目录集合：只有顶层。
 *
 * 全部展开在稍大的库里会淹掉整个面板，全部折叠又要点很多次才看到内容 ——
 * 顶层展开是两者之间最省事的默认值。
 */
export function defaultExpandedDirectories(tree: readonly FileTreeNode[]): Set<string> {
  const expanded = new Set<string>();
  for (const node of tree) {
    if (node.type === 'directory') expanded.add(node.relativePath);
  }
  return expanded;
}

/**
 * 一个文件节点是不是**附件**（在白名单里、但不是 Markdown）。
 *
 * 判据从 `@nexus/core` 的白名单来，不在这里另写一份扩展名表 —— 两处各写一份的话，
 * 新增一种可预览格式时会出现「树里按附件画了图标、点开却按文档处理」这种对不上的状态。
 *
 * 白名单之外的文件（索引里不会有）返回 `false`，也就是**照常显示**：
 * 看不见的东西比看得见的东西难排查。
 *
 * **它只决定画哪枚图标，不决定谁会被藏起来** —— 藏起来的是图片，见 `isImageNode`。
 */
export function isAttachmentNode(node: FileTreeNode): boolean {
  return node.document !== null && node.document.type !== 'markdown';
}

/**
 * 一个文件节点是不是**图片**。工具栏那个开关过滤的就是它。
 *
 * ## 为什么只藏图片，不藏全部附件
 *
 * 这一栏的意图是「树被图淹了」—— 一个 vault 里几十张截图平铺在笔记中间，扫一眼全是
 * 缩略名。而 PDF / DOCX 在同一个 vault 里通常是**个位数**、且往往正是要找的东西
 * （手册、规格书），把它们一起藏起来只会让人以为文件丢了。
 *
 * Markra 也是这么切的：它的 `fileTreeAssetsVisible` 判的是 `file.kind === 'asset'`，
 * 而 `asset` 就是图片；attachment 走的是另一套「托管目录」规则，不受这个开关影响。
 */
export function isImageNode(node: FileTreeNode): boolean {
  return node.document !== null && node.document.type === 'image';
}

/** 按相对路径找节点。找不到返回 `null`。 */
export function findTreeNode(
  nodes: readonly FileTreeNode[],
  relativePath: string
): FileTreeNode | null {
  for (const node of nodes) {
    if (node.relativePath === relativePath) return node;
    const found = findTreeNode(node.children, relativePath);
    if (found) return found;
  }
  return null;
}

/**
 * 按**绝对路径**找节点。
 *
 * 与上面那个分开是必要的：新建之后手上只有主进程返回的绝对路径，而树上每一行存的
 * 相对路径要等列表重读之后才对得上。拿绝对路径去比相对路径永远找不到。
 */
export function findTreeNodeByPath(
  nodes: readonly FileTreeNode[],
  path: string
): FileTreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    const found = findTreeNodeByPath(node.children, path);
    if (found) return found;
  }
  return null;
}

/**
 * 找某个相对路径**所在的目录节点**；它就在顶层时返回 `null`（＝工作区根）。
 *
 * 工具栏的「新建」落点要用它：选中一个文件时，新文件应当建在**它旁边**，
 * 而不是工作区根。为此必须知道那个文件的父目录是哪一个节点（不是它的相对路径 ——
 * 那还要再转成绝对路径）。
 */
export function findParentDirectory(
  nodes: readonly FileTreeNode[],
  relativePath: string
): FileTreeNode | null {
  const parentPath = parentPathOf(relativePath);
  if (parentPath === null) return null;
  const parent = findTreeNode(nodes, parentPath);
  return parent?.type === 'directory' ? parent : null;
}
