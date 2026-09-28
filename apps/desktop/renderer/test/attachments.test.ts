import { describe, it, expect } from 'vitest';
import { documentTypeForPath, type DocumentType, type IndexedDocument } from '@nexus/core';
import {
  buildAttachmentGroups,
  extractionNoteOf,
  splitIndexedDocuments
} from '../src/workspace/attachments.js';

/**
 * 只关心路径与类型，其余给固定值。
 *
 * `type` 允许显式覆盖 —— 有一条用例要造一个**不在白名单里**的类型，
 * 走 `documentTypeForPath` 造不出来（它只认白名单）。
 */
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

describe('索引文档分流', () => {
  it('Markdown 进笔记树，附件进附件区', () => {
    const { notes, attachments } = splitIndexedDocuments([
      doc('a.md'),
      doc('assets/logo.png'),
      doc('manual.pdf'),
      doc('spec.docx')
    ]);

    expect(notes.map((d) => d.relativePath)).toEqual(['a.md']);
    expect(attachments.map((d) => d.relativePath)).toEqual([
      'assets/logo.png',
      'manual.pdf',
      'spec.docx'
    ]);
  });

  it('保持输入顺序，不在这里排序', () => {
    // 排序是 buildFileTree / buildAttachmentGroups 各自的事 —— 分流只做分类
    const { notes } = splitIndexedDocuments([doc('z.md'), doc('a.md')]);
    expect(notes.map((d) => d.relativePath)).toEqual(['z.md', 'a.md']);
  });

  it('空输入得到两个空数组', () => {
    const { notes, attachments } = splitIndexedDocuments([]);
    expect(notes).toEqual([]);
    expect(attachments).toEqual([]);
  });

  it('不在 viewer 清单里的未知类型归笔记树，不会被静默丢掉', () => {
    // 这是分流方向的关键判据：如果反过来按 `type === 'markdown'` 判定，
    // 这个文档会进附件区，而 buildAttachmentGroups 按 VIEWER_DOCUMENT_TYPES
    // 遍历建组 —— 它会**既不在笔记树也不在附件区**，界面上凭空消失。
    const unknown = doc('notes.txt', { type: 'text' as unknown as DocumentType });
    const { notes, attachments } = splitIndexedDocuments([unknown]);

    expect(notes.map((d) => d.relativePath)).toEqual(['notes.txt']);
    expect(attachments).toEqual([]);
  });
});

describe('附件分组', () => {
  it('空输入得到空数组', () => {
    expect(buildAttachmentGroups([])).toEqual([]);
  });

  it('组顺序固定为 图片 → PDF → DOCX，与输入顺序无关', () => {
    const groups = buildAttachmentGroups([
      doc('spec.docx'),
      doc('manual.pdf'),
      doc('logo.png')
    ]);

    expect(groups.map((group) => group.type)).toEqual(['image', 'pdf', 'docx']);
  });

  it('空组不出现', () => {
    const groups = buildAttachmentGroups([doc('logo.png'), doc('cover.jpg')]);

    // 没有 PDF / DOCX —— 只该有一个组，不该出现「PDF 0」这种标题
    expect(groups).toHaveLength(1);
    expect(groups[0]!.type).toBe('image');
  });

  it('组内按名称排序，同名时按相对路径兜底', () => {
    const groups = buildAttachmentGroups([
      doc('z/logo.png'),
      doc('a/logo.png'),
      doc('apple.png')
    ]);

    expect(groups[0]!.entries.map((entry) => entry.document.relativePath)).toEqual([
      'apple.png',
      'a/logo.png',
      'z/logo.png'
    ]);
  });

  it('中文文件名按 locale 排序且两个都在', () => {
    const groups = buildAttachmentGroups([doc('乙.png'), doc('甲.png')]);

    expect(groups[0]!.entries.map((entry) => entry.document.name).sort()).toEqual([
      '乙.png',
      '甲.png'
    ]);
  });

  it('无同名时不带目录提示', () => {
    const groups = buildAttachmentGroups([doc('assets/logo.png'), doc('assets/cover.png')]);

    expect(groups[0]!.entries.map((entry) => entry.directoryHint)).toEqual([null, null]);
  });

  it('同名时给出所在相对目录，根目录的文件给空串', () => {
    // null（不需要提示）与 ''（就在根目录）是两件事，调用方要分开处理。
    // 顺序：三个同名，按相对路径兜底 —— 所以是 assets → logo → projects/a，
    // 「根目录那个」排在同名组的中间（不是最前）。
    const groups = buildAttachmentGroups([
      doc('logo.png'),
      doc('assets/logo.png'),
      doc('projects/a/logo.png')
    ]);

    expect(groups[0]!.entries.map((entry) => [entry.document.relativePath, entry.directoryHint]))
      .toEqual([
        ['assets/logo.png', 'assets'],
        ['logo.png', ''],
        ['projects/a/logo.png', 'projects/a']
      ]);
  });

  it('同名判定只在组内，跨组同名互不影响', () => {
    // logo.png 与 logo.pdf 不同名（含扩展名），两边都不该出目录提示
    const groups = buildAttachmentGroups([doc('logo.png'), doc('logo.pdf')]);

    expect(groups.map((group) => group.entries[0]!.directoryHint)).toEqual([null, null]);
  });

  it('不改动入参数组的顺序', () => {
    const input = [doc('z.png'), doc('a.png')];
    const snapshot = input.map((d) => d.relativePath);

    buildAttachmentGroups(input);

    expect(input.map((d) => d.relativePath)).toEqual(snapshot);
  });
});

/**
 * 提取提示的判据（P3-10）。
 *
 * 四条里**三条都是「不提示」** —— 这是刻意的：这个函数的价值不在「什么时候提示」，
 * 而在「什么时候闭嘴」。`'extracted'` 是成功（不必说话），`'none'` 是
 * 「这一轮没被引用」或「这个类型没有处理器」（同样不必说话）。
 * 后者尤其重要：它让渲染进程**不需要**知道哪些类型有处理器。
 */
describe('提取提示的判据', () => {
  it('empty 与 failed 各自返回自己的状态，不合并成一个布尔', () => {
    // 一个是「这份文件里真的没有文本」（扫描版 PDF，事实），
    // 一个是「本来可能有、但读失败了」（故障）—— 对用户是两件事
    expect(extractionNoteOf(doc('a.pdf', { extractionStatus: 'empty' }))).toBe('empty');
    expect(extractionNoteOf(doc('a.pdf', { extractionStatus: 'failed' }))).toBe('failed');
  });

  it('extracted 不提示 —— 成功不需要说话', () => {
    expect(extractionNoteOf(doc('a.pdf', { extractionStatus: 'extracted' }))).toBeNull();
  });

  it('none 不提示 —— 图片、没被引用的附件、Markdown 都走这里', () => {
    expect(extractionNoteOf(doc('a.png'))).toBeNull();
    expect(extractionNoteOf(doc('unreferenced.pdf'))).toBeNull();
    expect(extractionNoteOf(doc('note.md'))).toBeNull();
  });
});
