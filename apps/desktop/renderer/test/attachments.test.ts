import { describe, it, expect } from 'vitest';
import type { ExtractionStatus, IndexedDocument } from '@nexus/core';
import { extractionNoteOf } from '../src/workspace/attachments.js';

/**
 * 附件行的提取提示。
 *
 * 这个文件原来还测 `splitIndexedDocuments` / `buildAttachmentGroups`（26 条）——
 * 那两个函数服务于「笔记树 + 附件区」两段布局，而那个布局已经取消：附件与笔记现在是
 * 同一棵树里的节点，按目录结构混排。**分类与分组不再存在，所以那些用例跟着删掉了**，
 * 不是搬到别处。
 *
 * 留下的这一条仍然有用：附件行还在标「未提取到文本」与「提取失败」。
 */
function doc(extractionStatus: ExtractionStatus): IndexedDocument {
  return {
    id: 0,
    path: '/vault/a.pdf',
    relativePath: 'a.pdf',
    name: 'a.pdf',
    title: 'a',
    type: 'pdf',
    sizeBytes: 1,
    modifiedAtMs: 1,
    contentHash: 'x',
    extractionStatus
  };
}

describe('附件行的提取提示', () => {
  it('`empty` 与 `failed` 要说话 —— 一个是事实，一个是故障', () => {
    expect(extractionNoteOf(doc('empty'))).toBe('empty');
    expect(extractionNoteOf(doc('failed'))).toBe('failed');
  });

  it('`extracted` 不说话 —— 成功不需要提示', () => {
    expect(extractionNoteOf(doc('extracted'))).toBeNull();
  });

  it('`none` 不说话 —— 它同时表示「没有处理器」与「这一轮没被引用」', () => {
    // 这正是合并这两个语义的收益：渲染进程不需要知道哪些类型有处理器。
    // 如果这里改成提示，图片行会集体冒出一句「未提取到文本」。
    expect(extractionNoteOf(doc('none'))).toBeNull();
  });
});
