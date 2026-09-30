import { describe, it, expect } from 'vitest';
import { getDocumentDirectory, getFileName, newDocumentDirectory } from '../src/paths.js';
import {
  NEW_DOCUMENT_LOCATION_DOCUMENT,
  NEW_DOCUMENT_LOCATION_WORKSPACE
} from '../src/settings/preference-specs.js';

describe('路径工具 · 取目录与文件名', () => {
  it('两种分隔符都认', () => {
    expect(getDocumentDirectory('C:\\notes\\a.md')).toBe('C:\\notes');
    expect(getDocumentDirectory('/home/me/notes/a.md')).toBe('/home/me/notes');
  });

  it('裸文件名没有目录，未命名文档也没有', () => {
    expect(getDocumentDirectory('a.md')).toBeNull();
    expect(getDocumentDirectory(null)).toBeNull();
    expect(getDocumentDirectory('')).toBeNull();
  });

  it('取文件名同时兼容两种分隔符', () => {
    expect(getFileName('C:\\notes\\a.md')).toBe('a.md');
    expect(getFileName('/home/me/a.md')).toBe('a.md');
    expect(getFileName('a.md')).toBe('a.md');
    expect(getFileName(null)).toBe('');
  });
});

/**
 * 「新建文档默认位置」的判断。判据是**三个输入的组合**，不是某一支的实现 ——
 * 这条链上有两个容易写反的地方：轻量模式没有工作区、以及未命名文档时记住的目录要留着。
 */
describe('路径工具 · 新建文档默认位置', () => {
  const WORKSPACE = 'C:\\vault';
  const LAST = 'C:\\vault\\notes';

  it('选了工作区根目录且工作区在 → 用工作区根', () => {
    expect(newDocumentDirectory(NEW_DOCUMENT_LOCATION_WORKSPACE, WORKSPACE, LAST)).toBe(WORKSPACE);
  });

  it('选了「与当前文档同目录」→ 用记住的目录，工作区在也不去', () => {
    expect(newDocumentDirectory(NEW_DOCUMENT_LOCATION_DOCUMENT, WORKSPACE, LAST)).toBe(LAST);
  });

  it('轻量模式下没有工作区：选了工作区根也回落到记住的目录，而不是放弃', () => {
    expect(newDocumentDirectory(NEW_DOCUMENT_LOCATION_WORKSPACE, null, LAST)).toBe(LAST);
  });

  it('两个来源都没有 → null（调用方不传 defaultPath，交给系统）', () => {
    expect(newDocumentDirectory(NEW_DOCUMENT_LOCATION_WORKSPACE, null, null)).toBeNull();
    expect(newDocumentDirectory(NEW_DOCUMENT_LOCATION_DOCUMENT, null, null)).toBeNull();
    expect(newDocumentDirectory(NEW_DOCUMENT_LOCATION_DOCUMENT, WORKSPACE, null)).toBeNull();
  });

  it('认不出的档位按「与当前文档同目录」处理', () => {
    // 存档是用户能改的；`store` 的 parse 会先把它落回默认，这里兜住直接调用的情形。
    expect(newDocumentDirectory('somewhere-else', WORKSPACE, LAST)).toBe(LAST);
  });
});
