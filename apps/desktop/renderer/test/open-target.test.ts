import { describe, it, expect } from 'vitest';
import { classifyOpenTarget } from '../src/workspace/open-target.js';

/**
 * 「这条路径该被打开成什么」（P3-05）。
 *
 * 抽成纯函数的意义在于**四条入口共用一个判断点**：侧栏文件树、快速打开、
 * 编辑器里的相对路径链接、以及 wikilink 解析出的附件。分散判断的症状很具体 ——
 * 同一条路径从链接点进去是只读查看、从文件树点进去却报「不支持的格式」。
 */
describe('classifyOpenTarget', () => {
  it('Markdown 走可编辑分支', () => {
    expect(classifyOpenTarget('/vault/note.md')).toEqual({
      kind: 'editor',
      path: '/vault/note.md'
    });
    expect(classifyOpenTarget('/vault/note.markdown').kind).toBe('editor');
  });

  it('白名单里的附件走只读分支，并带上具体类型', () => {
    expect(classifyOpenTarget('/vault/stm32.pdf')).toEqual({
      kind: 'viewer',
      path: '/vault/stm32.pdf',
      type: 'pdf'
    });
    expect(classifyOpenTarget('/vault/manual.docx').kind).toBe('viewer');
    expect(classifyOpenTarget('/vault/assets/diagram.png')).toEqual({
      kind: 'viewer',
      path: '/vault/assets/diagram.png',
      type: 'image'
    });
  });

  it('白名单外的扩展名归 unsupported，而不是硬塞给某一类', () => {
    // `.txt` 既不是 Markdown 也不在白名单里 —— 猜成 editor 会让它在
    // `openDocument` 里被 assertTextDocument 拒掉（错误信息还很难懂）
    expect(classifyOpenTarget('/vault/readme.txt')).toEqual({
      kind: 'unsupported',
      path: '/vault/readme.txt'
    });
    expect(classifyOpenTarget('/vault/archive.zip').kind).toBe('unsupported');
    expect(classifyOpenTarget('/vault/no-extension').kind).toBe('unsupported');
  });

  it('大小写不敏感，且不受路径里的点号影响', () => {
    expect(classifyOpenTarget('/vault/DIAGRAM.PNG').kind).toBe('viewer');
    // 目录名里的点不该被当成扩展名
    expect(classifyOpenTarget('/vault/v1.2/note.md').kind).toBe('editor');
    expect(classifyOpenTarget('/vault/v1.2/note.pdf').type).toBe('pdf');
  });
});
