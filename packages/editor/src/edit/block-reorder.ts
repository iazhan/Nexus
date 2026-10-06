import {
  parseMarkdown,
  type MarkdownBlockNode,
  type MarkdownListItem
} from '@nexus/markdown';
import { createMarkdownChangeSet, mapMarkdownSelection } from '../document-session.js';
import type { MarkdownEditTransaction, MarkdownSelection } from '../types.js';
import { findDeepestBlockAtPos, getContentEnd } from './lookup.js';

/**
 * 同一父容器内同级 block 的重排。
 *
 * **语义是「移动」，不是「交换」。** 早先这里是「对称插槽置换」—— 把两个槽位的正文对调，
 * 中间那些块原地不动。它只在**相邻一格**时与移动等价，而键盘上下移动恰好只请求相邻一格，
 * 所以差异一直没暴露；拖拽能落到任意距离，交换会让中间块纹丝不动、只把两端对调，
 * 与「拖到哪儿就放哪儿」的直觉不符。
 *
 * **分隔符只做置换、不合成任何字符。** 块之间的空行不属于任何一块，它属于**槽位**。
 * 搬走源块时把它那一侧的 gap 一起带走（向下走带尾部 gap、向上走带首部 gap），落点复用
 * 这个 gap，于是 gap 的**多重集**不变 —— 文档里不会凭空多出或少掉一个空行。
 * 与参考实现的分歧点就在这里：Markra 按 `requiredBreaks` 合成 `\n`，用「允许规范化空行」
 * 换「落点两侧间距一定正确」；这边选的是不发明字符，代价是混合间隔（`\n\n` 与 `\n\n\n` 并存）
 * 的文档里，落点两侧的间距跟着源块走而不是跟着位置走。
 *
 * **两个入口的索引口径不同，别混。** `moveSiblingBlock` 收**插入位**（插到原数组下标 k 之前，
 * 等于 length 表示插到末尾）—— 从「块的前 / 后侧」换算过来最直接，拖拽走这条；
 * `createReorderBlockTransaction` 收**目的地下标**（移动后它应处的下标）—— 纯下标语义的
 * 调用方读起来更自然。
 */

/**
 * 放置落在目标块的哪一侧。
 */
export type DropSide = 'before' | 'after';

/**
 * 把 fromIndex 处的块取出，插到原数组下标 insertBefore 之前。
 */
export function moveSiblingBlock(
  source: string,
  siblings: (MarkdownBlockNode | MarkdownListItem)[],
  fromIndex: number,
  insertBefore: number,
  currentSelection?: MarkdownSelection
): MarkdownEditTransaction | null {
  if (
    fromIndex < 0 ||
    fromIndex >= siblings.length ||
    insertBefore < 0 ||
    insertBefore > siblings.length ||
    insertBefore === fromIndex ||
    insertBefore === fromIndex + 1
  ) {
    return null;
  }

  const contents: string[] = [];
  const gaps: string[] = [];
  for (let i = 0; i < siblings.length; i++) {
    const block = siblings[i]!;
    const contentEnd = getContentEnd(source, block.range);
    contents.push(source.slice(block.range.from, contentEnd));
    if (i < siblings.length - 1) {
      gaps.push(source.slice(contentEnd, siblings[i + 1]!.range.from));
    }
  }

  // 源块两侧总得留一个分隔符给自己，否则它会和相邻块粘成一块。
  const movingDown = insertBefore > fromIndex;
  const carriedGapIndex = movingDown ? fromIndex : fromIndex - 1;
  const carriedGap = gaps[carriedGapIndex]!;

  const remainingContents = contents.filter((_, i) => i !== fromIndex);
  const remainingGaps = gaps.filter((_, i) => i !== carriedGapIndex);

  const position = movingDown ? insertBefore - 1 : insertBefore;
  const reorderedContents = [
    ...remainingContents.slice(0, position),
    contents[fromIndex]!,
    ...remainingContents.slice(position)
  ];
  // 落点原来那个 gap 留在原地、改当「被搬来的块之后」的分隔符，搬来的 gap 补在它前面。
  const reorderedGaps = [
    ...remainingGaps.slice(0, position - 1),
    carriedGap,
    ...remainingGaps.slice(position - 1)
  ];

  let newSegment = '';
  for (let i = 0; i < reorderedContents.length; i++) {
    newSegment += reorderedContents[i];
    if (i < reorderedGaps.length) {
      newSegment += reorderedGaps[i];
    }
  }

  const rangeFrom = siblings[0]!.range.from;
  const rangeTo = getContentEnd(source, siblings[siblings.length - 1]!.range);
  const changes = [{ from: rangeFrom, to: rangeTo, insert: newSegment }];

  let movedOffset = 0;
  for (let i = 0; i < position; i++) {
    movedOffset += reorderedContents[i]!.length + reorderedGaps[i]!.length;
  }
  const destBlockFrom = rangeFrom + movedOffset;
  const movedLen = reorderedContents[position]!.length;
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
 * 在同一父容器内把当前光标所在的最深 block 向上或向下挪一格。
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

  return moveSiblingBlock(
    source,
    siblings,
    index,
    direction === 'up' ? targetIndex : targetIndex + 1,
    currentSelection
  );
}

/**
 * 基于 AST 区间重排顶级块（Reorder Block），严格保持源码原样格式。
 *
 * `toIndex` 是**目的地下标**：块移动后应处的下标。
 */
export function createReorderBlockTransaction(
  source: string,
  fromIndex: number,
  toIndex: number,
  currentSelection?: MarkdownSelection
): MarkdownEditTransaction | null {
  const { root } = parseMarkdown(source);
  return moveSiblingBlock(
    source,
    root.children,
    fromIndex,
    toIndex > fromIndex ? toIndex + 1 : toIndex,
    currentSelection
  );
}

/**
 * 基于源位置和目标位置在同一父容器内移动 block。
 *
 * 核心约束：
 * 1. sourcePosition 与 targetPosition 均必须解析为有效的最深 block。
 * 2. 如果任一位置处于空白 gap，返回 null。
 * 3. 必须处于同一父容器的同级兄弟列表中（sourceCtx.parent === targetCtx.parent），禁止跨容器重排。
 * 4. 如果源位置与目标位置解析为同一个 block，返回 null（no-op）。
 * 5. `side` 决定落到目标块的**前面**还是**后面** —— 它由指针在目标块的哪一半给出，
 *    所以「落在块 A 之后」与「落在块 B 之前」（A、B 相邻）是同一个插入位。
 */
export function createReorderBlockToPositionTransaction(
  source: string,
  sourcePosition: number,
  targetPosition: number,
  side: DropSide,
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

  return moveSiblingBlock(
    source,
    sourceCtx.siblings,
    sourceCtx.index,
    side === 'before' ? targetCtx.index : targetCtx.index + 1,
    currentSelection
  );
}
