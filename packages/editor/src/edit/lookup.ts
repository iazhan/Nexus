import {
  type MarkdownBlockNode,
  type MarkdownListItem,
  type MarkdownNode,
  type MarkdownRoot
} from '@nexus/markdown';

interface LineInfo {
  text: string;
  from: number;
  to: number;
  number: number;
}

export function getLineAt(source: string, pos: number): LineInfo {
  let lineStart = 0;
  let lineNumber = 1;
  while (lineStart < source.length) {
    const lf = source.indexOf('\n', lineStart);
    const lineEnd = lf === -1 ? source.length : (source[lf - 1] === '\r' ? lf - 1 : lf);
    const nextStart = lf === -1 ? source.length : lf + 1;

    if (pos >= lineStart && pos <= (lf === -1 ? source.length : lf)) {
      return {
        text: source.slice(lineStart, lineEnd),
        from: lineStart,
        to: lineEnd,
        number: lineNumber
      };
    }

    lineStart = nextStart;
    lineNumber++;
  }

  return {
    text: '',
    from: source.length,
    to: source.length,
    number: lineNumber
  };
}

export function parseLines(source: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let lineStart = 0;
  let num = 1;

  while (lineStart <= source.length) {
    const lf = source.indexOf('\n', lineStart);
    const lineEnd = lf === -1 ? source.length : (source[lf - 1] === '\r' ? lf - 1 : lf);
    lines.push({
      text: source.slice(lineStart, lineEnd),
      from: lineStart,
      to: lineEnd,
      number: num++
    });
    if (lf === -1) break;
    lineStart = lf + 1;
  }

  return lines;
}

/**
 * 根据文档位置在 AST 根节点列表中查找包含该位置的顶级块索引。
 */
export function findContainingBlockIndex(root: MarkdownRoot, pos: number, sourceLength: number): number {
  for (let i = 0; i < root.children.length; i++) {
    const block = root.children[i]!;
    const nextBlock = root.children[i + 1];
    const boundary = nextBlock ? nextBlock.range.from : sourceLength;
    if (pos >= block.range.from && pos < boundary) {
      return i;
    }
  }
  if (root.children.length > 0 && pos === sourceLength) {
    return root.children.length - 1;
  }
  return -1;
}

/**
 * 根据文档位置查找包含该位置的顶级块节点。
 */
/**
 * 代码围栏是否已闭合（存在与起始围栏同类型的结束行）。
 *
 * 未闭合围栏既不能投影成 block widget（会吞掉后续输入），
 * 也不能按普通块拆分（回车无效），因此两处都需要这个判定。
 */
export function isFenceClosed(raw: string): boolean {
  const lines = raw.replace(/\r\n/g, '\n').split('\n').filter((line) => line.trim().length > 0);
  if (lines.length < 2) return false;

  const opener = lines[0]!.trim().match(/^(`{3,}|~{3,})/);
  if (!opener) return false;

  const fenceChar = opener[1]![0]!;
  const minLength = opener[1]!.length;
  const closer = lines[lines.length - 1]!.trim();
  return new RegExp(`^\\${fenceChar}{${minLength},}$`).test(closer);
}

export function findContainingBlock(root: MarkdownRoot, pos: number, sourceLength: number): MarkdownBlockNode | null {
  const index = findContainingBlockIndex(root, pos, sourceLength);
  return index >= 0 ? root.children[index]! : null;
}

/**
 * 计算 AST 节点正文结束位置，排除末尾自带的换行符（如 heading、list 在 AST 范围包含末尾 \n），
 * 同时保留行尾空格（如两个空格硬换行）等全部正文切片。
 */
export function getContentEnd(source: string, range: { from: number; to: number }): number {
  let to = range.to;
  while (to > range.from && (source[to - 1] === '\n' || source[to - 1] === '\r')) {
    to--;
  }
  return to;
}

function isBlockNode(node: MarkdownNode): node is MarkdownBlockNode {
  const t = node.type;
  return (
    t === 'paragraph' ||
    t === 'heading' ||
    t === 'blockquote' ||
    t === 'list' ||
    t === 'code-block' ||
    t === 'table' ||
    t === 'block-math' ||
    t === 'raw' ||
    t === 'horizontal-rule'
  );
}

export interface BlockContext {
  /** 当前命中的最深可编辑 block 节点 */
  node: MarkdownBlockNode | MarkdownListItem;
  /** 从 root 到当前 node 的完整 AST 路径 */
  path: (MarkdownRoot | MarkdownBlockNode | MarkdownListItem)[];
  /** 当前 node 所属的直接父容器 */
  parent: MarkdownRoot | MarkdownBlockNode | MarkdownListItem;
  /** 父容器内的同级 block 列表 */
  siblings: (MarkdownBlockNode | MarkdownListItem)[];
  /** 当前 node 在 siblings 列表中的索引 */
  index: number;
}

/**
 * 根据 source position 深入 AST 树，找到最深的可编辑 block 及其父容器与上下文。
 *
 * 支持容器：
 * - root children
 * - blockquote children
 * - list item children 中的 block
 * - nested blockquote
 * - nested list item 内的 block
 * - 多层 list / blockquote 组合
 */
export function findDeepestBlockAtPos(
  root: MarkdownRoot,
  pos: number,
  sourceOrLength: string | number
): BlockContext | null {
  const source = typeof sourceOrLength === 'string' ? sourceOrLength : null;
  const sourceLength: number = typeof sourceOrLength === 'string' ? sourceOrLength.length : sourceOrLength;

  if (root.children.length === 0) return null;
  if (pos < 0 || pos >= sourceLength) return null;

  function getNodeEnd(node: MarkdownNode): number {
    if (source !== null) {
      return getContentEnd(source, node.range);
    }
    return node.range.to;
  }

  let currentParent: MarkdownRoot | MarkdownBlockNode | MarkdownListItem = root;
  let currentSiblings: (MarkdownBlockNode | MarkdownListItem)[] = root.children;
  const currentPath: (MarkdownRoot | MarkdownBlockNode | MarkdownListItem)[] = [root];

  while (true) {
    let foundIndex = -1;
    for (let i = 0; i < currentSiblings.length; i++) {
      const node = currentSiblings[i]!;
      const from = node.range.from;
      let to = getNodeEnd(node);
      if (node.type === 'list-item' && node.children.length > 0) {
        to = getNodeEnd(node.children[node.children.length - 1]!);
      }

      if (pos >= from && pos < to) {
        foundIndex = i;
        break;
      }
    }

    if (foundIndex === -1) {
      // 当前层级所有兄弟节点均不包含 pos（即 pos 处于 gap 或超出范围）
      return null;
    }

    const currentNode = currentSiblings[foundIndex]!;
    currentPath.push(currentNode);

    // 检查是否能向更深层容器下潜
    if (currentNode.type === 'blockquote') {
      if (currentNode.children.length > 0) {
        currentParent = currentNode;
        currentSiblings = currentNode.children;
        continue;
      }
      return null;
    }

    if (currentNode.type === 'list') {
      if (currentNode.items.length > 0) {
        currentParent = currentNode;
        currentSiblings = currentNode.items;
        continue;
      }
      return null;
    }

    if (currentNode.type === 'list-item') {
      const childBlocks = currentNode.children.filter(isBlockNode);
      if (childBlocks.length > 0) {
        let matchedChildIndex = -1;
        for (let k = 0; k < childBlocks.length; k++) {
          const cb = childBlocks[k]!;
          const cbFrom = cb.range.from;
          const cbTo = getNodeEnd(cb);
          if (pos >= cbFrom && pos <= cbTo) {
            matchedChildIndex = k;
            break;
          }
        }
        if (matchedChildIndex !== -1) {
          currentParent = currentNode;
          currentSiblings = childBlocks;
          continue;
        }
        return null;
      }

      return {
        node: currentNode,
        path: currentPath,
        parent: currentParent,
        siblings: currentSiblings,
        index: foundIndex
      };
    }

    return {
      node: currentNode,
      path: currentPath,
      parent: currentParent,
      siblings: currentSiblings,
      index: foundIndex
    };
  }
}


export function getQuotePrefixLength(lineText: string, quoteDepth: number): number {
  if (quoteDepth <= 0) return 0;
  let count = 0;
  let idx = 0;
  while (idx < lineText.length && count < quoteDepth) {
    while (idx < lineText.length && (lineText[idx] === ' ' || lineText[idx] === '\t')) {
      idx++;
    }
    if (idx < lineText.length && lineText[idx] === '>') {
      idx++;
      count++;
    } else {
      break;
    }
  }
  if (count === quoteDepth && idx < lineText.length && lineText[idx] === ' ') {
    idx++;
  }
  return idx;
}

export interface ListItemContext {
  item: MarkdownListItem;
  parentList: MarkdownBlockNode & { type: 'list' };
  parentItem: MarkdownListItem | null;
  itemIndex: number;
  quoteDepth: number;
}

/**
 * 基于 Markdown AST 递归查找光标或偏移量所在的列表项上下文，支持任意层级的 blockquote 和 list 互相嵌套。
 */
export function findListItemAtPos(root: MarkdownRoot, pos: number): ListItemContext | null {
  let deepestContext: ListItemContext | null = null;
  let maxDepth = -1;

  function traverseBlocks(
    nodes: readonly MarkdownNode[],
    parentList: (MarkdownBlockNode & { type: 'list' }) | null,
    parentItem: MarkdownListItem | null,
    quoteDepth: number,
    depth: number
  ) {
    for (const node of nodes) {
      if (node.type === 'list') {
        for (let i = 0; i < node.items.length; i++) {
          const item = node.items[i]!;
          const nextItem = node.items[i + 1];
          const isInsideItem = nextItem
            ? (pos >= item.range.from && pos < nextItem.range.from)
            : (pos >= item.range.from && pos <= item.range.to);

          if (isInsideItem) {
            if (depth >= maxDepth) {
              maxDepth = depth;
              deepestContext = {
                item,
                parentList: node,
                parentItem,
                itemIndex: i,
                quoteDepth
              };
            }
            // 递归遍历该 item 内部的子块（包括嵌套的 list、blockquote 等）
            traverseBlocks(item.children, node, item, quoteDepth, depth + 1);
          }
        }
      } else if (node.type === 'blockquote') {
        traverseBlocks(node.children, parentList, parentItem, quoteDepth + 1, depth + 1);
      }
    }
  }

  traverseBlocks(root.children, null, null, 0, 0);
  return deepestContext;
}

