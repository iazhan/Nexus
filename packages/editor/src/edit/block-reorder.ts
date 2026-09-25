import {
  parseMarkdown,
  type MarkdownBlockNode,
  type MarkdownListItem
} from '@nexus/markdown';
import { createMarkdownChangeSet, mapMarkdownSelection } from '../document-session.js';
import type { MarkdownEditTransaction, MarkdownSelection } from '../types.js';
import { findDeepestBlockAtPos, getContentEnd } from './lookup.js';

/**
 * 在同一父容器的同级 block 列表中重排/交换两个位置的 block，保持源码完全保真。
 */
export function reorderSiblingBlocks(
  source: string,
  siblings: (MarkdownBlockNode | MarkdownListItem)[],
  fromIndex: number,
  toIndex: number,
  currentSelection?: MarkdownSelection
): MarkdownEditTransaction | null {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= siblings.length ||
    toIndex >= siblings.length ||
    fromIndex === toIndex
  ) {
    return null;
  }

  const minIdx = Math.min(fromIndex, toIndex);
  const maxIdx = Math.max(fromIndex, toIndex);
  const subBlocks = siblings.slice(minIdx, maxIdx + 1);

  const blockContents: string[] = [];
  const gaps: string[] = [];

  for (let i = 0; i < subBlocks.length; i++) {
    const curBlock = subBlocks[i]!;
    const cEnd = getContentEnd(source, curBlock.range);
    blockContents.push(source.slice(curBlock.range.from, cEnd));

    if (i < subBlocks.length - 1) {
      const nextBlock = subBlocks[i + 1]!;
      gaps.push(source.slice(cEnd, nextBlock.range.from));
    }
  }

  const fromOffset = fromIndex - minIdx;
  const toOffset = toIndex - minIdx;
  const reorderedContents = [...blockContents];

  // 交换 fromOffset 与 toOffset 对应插槽的正文切片
  const temp = reorderedContents[fromOffset]!;
  reorderedContents[fromOffset] = reorderedContents[toOffset]!;
  reorderedContents[toOffset] = temp;

  let newSegment = '';
  for (let i = 0; i < reorderedContents.length; i++) {
    newSegment += reorderedContents[i];
    if (i < gaps.length) {
      newSegment += gaps[i];
    }
  }

  const rangeFrom = subBlocks[0]!.range.from;
  const rangeTo = getContentEnd(source, subBlocks[subBlocks.length - 1]!.range);

  const changes = [{ from: rangeFrom, to: rangeTo, insert: newSegment }];

  // 计算移动块在新文本段中的起始位置
  let movedBlockOffsetInSegment = 0;
  for (let i = 0; i < toOffset; i++) {
    movedBlockOffsetInSegment += reorderedContents[i]!.length + gaps[i]!.length;
  }
  const destBlockFrom = rangeFrom + movedBlockOffsetInSegment;
  const movedLen = reorderedContents[toOffset]!.length;
  const destBlockTo = destBlockFrom + movedLen;

  let nextSelection: MarkdownSelection;
  const fromBlock = siblings[fromIndex]!;
  if (
    currentSelection &&
    currentSelection.head >= fromBlock.range.from &&
    currentSelection.head <= fromBlock.range.to &&
    currentSelection.anchor >= fromBlock.range.from &&
    currentSelection.anchor <= fromBlock.range.to
  ) {
    const relHead = Math.min(
      Math.max(0, currentSelection.head - fromBlock.range.from),
      movedLen
    );
    const relAnchor = Math.min(
      Math.max(0, currentSelection.anchor - fromBlock.range.from),
      movedLen
    );
    nextSelection = {
      anchor: destBlockFrom + relAnchor,
      head: destBlockFrom + relHead
    };
  } else if (currentSelection) {
    const changeSet = createMarkdownChangeSet(source, changes);
    nextSelection = mapMarkdownSelection(currentSelection, changeSet);
  } else if (fromIndex === 0 && toIndex === 1) {
    nextSelection = {
      anchor: rangeFrom,
      head: rangeFrom + reorderedContents[0]!.length
    };
  } else {
    nextSelection = {
      anchor: destBlockFrom,
      head: destBlockTo
    };
  }

  return {
    changes,
    selection: nextSelection,
    userEvent: 'block.reorder'
  };
}

/**
 * 在同一父容器内向上或向下重排当前光标所在的最深 block。
 *
 * 核心约束：
 * 1. 只能在同一父容器的同级 block 间移动；位于容器首部向上或尾部向下时返回 null（不跨容器）。
 * 2. 保持 list marker、blockquote prefix、缩进与 gap 格式完全保真。
 * 3. 产生原 source 坐标下的单一局部变更。
 * 4. 通过 ChangeSet 或相对偏移高保真映射选区。
 */
export function createReorderBlockAtPositionTransaction(
  source: string,
  position: number,
  direction: 'up' | 'down',
  currentSelection?: MarkdownSelection
): MarkdownEditTransaction | null {
  const { root } = parseMarkdown(source);
  let context = findDeepestBlockAtPos(root, position, source);
  if (!context && currentSelection && currentSelection.anchor !== currentSelection.head) {
    const selFrom = Math.min(currentSelection.anchor, currentSelection.head);
    context = findDeepestBlockAtPos(root, selFrom, source);
  }
  if (!context && position > 0) {
    const prevCtx = findDeepestBlockAtPos(root, position - 1, source);
    if (prevCtx && getContentEnd(source, prevCtx.node.range) === position) {
      context = prevCtx;
    }
  }
  if (!context) return null;

  const { siblings, index } = context;
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= siblings.length) {
    return null;
  }

  return reorderSiblingBlocks(source, siblings, index, targetIndex, currentSelection);
}

/**
 * 基于 AST 区间重排顶级块（Reorder Block），严格保持源码原样格式。
 */
export function createReorderBlockTransaction(
  source: string,
  fromIndex: number,
  toIndex: number,
  currentSelection?: MarkdownSelection
): MarkdownEditTransaction | null {
  const { root } = parseMarkdown(source);
  return reorderSiblingBlocks(source, root.children, fromIndex, toIndex, currentSelection);
}

/**
 * 基于源位置和目标位置在同一父容器内重排 block。
 *
 * 核心约束：
 * 1. sourcePosition 与 targetPosition 均必须解析为有效的最深 block。
 * 2. 如果任一位置处于空白 gap，返回 null。
 * 3. 必须处于同一父容器的同级兄弟列表中（sourceCtx.parent === targetCtx.parent），禁止跨容器重排。
 * 4. 如果源位置与目标位置解析为同一个 block，返回 null（no-op）。
 * 5. 调用 reorderSiblingBlocks 执行对称插槽置换，完整保留原始 gap 与换行符。
 */
export function createReorderBlockToPositionTransaction(
  source: string,
  sourcePosition: number,
  targetPosition: number,
  currentSelection?: MarkdownSelection
): MarkdownEditTransaction | null {
  const { root } = parseMarkdown(source);
  const sourceCtx = findDeepestBlockAtPos(root, sourcePosition, source);
  const targetCtx = findDeepestBlockAtPos(root, targetPosition, source);

  if (!sourceCtx || !targetCtx) {
    return null;
  }

  if (sourceCtx.parent !== targetCtx.parent) {
    return null;
  }

  if (sourceCtx.index === targetCtx.index) {
    return null;
  }

  return reorderSiblingBlocks(
    source,
    sourceCtx.siblings,
    sourceCtx.index,
    targetCtx.index,
    currentSelection
  );
}



