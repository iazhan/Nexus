import { parseMarkdown } from '@nexus/markdown';
import type { MarkdownEditTransaction } from '../types.js';
import { findDeepestBlockAtPos, getContentEnd } from './lookup.js';

/**
 * 根据 source 坐标找到最深的可编辑 block，并精确选中其范围，不误选相邻 gap。
 */
export function createSelectBlockAtPositionTransaction(
  source: string,
  position: number
): MarkdownEditTransaction | null {
  const { root } = parseMarkdown(source);
  const context = findDeepestBlockAtPos(root, position, source);
  if (!context) return null;

  const node = context.node;
  const from = node.range.from;
  const to = getContentEnd(source, node.range);

  return {
    changes: [],
    selection: {
      anchor: from,
      head: to
    },
    userEvent: 'select.block'
  };
}

/**
 * 根据顶级块索引全选块。
 */
export function createSelectBlockAtIndexTransaction(
  source: string,
  index: number
): MarkdownEditTransaction | null {
  const { root } = parseMarkdown(source);
  if (index < 0 || index >= root.children.length) return null;

  const block = root.children[index]!;
  const from = block.range.from;
  const to = getContentEnd(source, block.range);

  return {
    changes: [],
    selection: {
      anchor: from,
      head: to
    },
    userEvent: 'select.block'
  };
}

/**
 * 兼容旧接口：当 target 为有效坐标或索引时选中块。
 */
export function createSelectBlockTransaction(
  source: string,
  target: number
): MarkdownEditTransaction | null {
  const { root } = parseMarkdown(source);
  if (root.children.length === 0) return null;

  // 坐标优先匹配
  const posTx = createSelectBlockAtPositionTransaction(source, target);
  if (posTx) return posTx;

  // 索引匹配
  if (target >= 0 && target < root.children.length) {
    return createSelectBlockAtIndexTransaction(source, target);
  }

  return null;
}

