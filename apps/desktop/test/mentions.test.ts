// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FileService } from '../electron/file-service.js';
import { IndexStore } from '../electron/index-store.js';
import { indexWorkspace } from '../electron/indexer.js';
import { findMentionsOfDocument } from '../electron/mentions.js';
import { createTempDir } from './smoke-harness.js';

/**
 * 未链接提及的**扫描**。
 *
 * 逐条匹配的判据（代码块里不算、词边界、候选长短）在 `packages/core/test/mentions.test.ts`；
 * 这里验的是接上真实工作区之后的三件事：**候选取自哪篇、跳过谁、结果怎么排**。
 */
describe('未链接提及', () => {
  let dir: string;
  let workspace: string;
  let store: IndexStore;
  let service: FileService;

  const write = (relativePath: string, content: string) => {
    const absolute = path.join(workspace, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf-8');
    return absolute;
  };

  const mentionsOf = (relativePath: string) =>
    findMentionsOfDocument({
      service,
      store,
      documentPath: path.join(workspace, relativePath)
    });

  beforeEach(async () => {
    dir = createTempDir('nexus-mentions-');
    workspace = path.join(dir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });
    service = new FileService();
    await service.authorizeWorkspace(workspace);
    store = IndexStore.open(path.join(dir, 'index.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const index = async () => {
    await indexWorkspace({ service, store, rootPath: workspace });
  };

  it('找出正文里提到目标却没写成链接的文档', async () => {
    write('notes/dma.md', '# DMA\n\n正文。\n');
    write('index.md', '见 dma 那篇。\n');
    write('linked.md', '见 [[dma]]。\n');
    await index();

    const result = await mentionsOf('notes/dma.md');

    // 已经写了链接的那篇不算 —— 它已经是链接了
    expect(result.mentions.map((mention) => mention.document.relativePath)).toEqual(['index.md']);
    expect(result.mentions[0]!.text).toBe('dma');
    expect(result.mentions[0]!.excerpt).toBe('见 dma 那篇。');
    expect(result.truncated).toBe(false);
  });

  it('不把目标文档自己算进去', async () => {
    // 文档里写自己的名字（标题、正文）是最常见的情况，报出来是纯噪音
    write('notes/dma.md', '# DMA\n\n这里讲 dma 是什么。\n');
    await index();

    expect((await mentionsOf('notes/dma.md')).mentions).toEqual([]);
  });

  it('相对路径形式的提及也认', async () => {
    write('notes/dma.md', '# DMA\n');
    write('index.md', '见 notes/dma 那篇。\n');
    await index();

    const result = await mentionsOf('notes/dma.md');
    expect(result.mentions[0]!.text).toBe('notes/dma');
  });

  it('按相对路径排序，与文档列表同序', async () => {
    write('notes/dma.md', '# DMA\n');
    write('z.md', 'dma\n');
    write('a.md', 'dma\n');
    await index();

    expect(
      (await mentionsOf('notes/dma.md')).mentions.map((mention) => mention.document.relativePath)
    ).toEqual(['a.md', 'z.md']);
  });

  it('目标不在索引里时返回空结果，而不是报错', async () => {
    write('index.md', 'dma\n');
    await index();

    const result = await mentionsOf('还没建的.md');
    expect(result).toEqual({ mentions: [], truncated: false });
  });

  it('目标是附件时返回空结果', async () => {
    // 附件没有「正文提到它」这回事，只有引用；而引用归 `links` 表管
    write('manual.pdf', 'PDF 占位');
    write('index.md', '见 manual 那份。\n');
    await index();

    expect((await mentionsOf('manual.pdf')).mentions).toEqual([]);
  });

  it('同一篇里多处提及都列出来，偏移各不相同', async () => {
    write('notes/dma.md', '# DMA\n');
    write('index.md', '第一处 dma。\n\n第二处 dma。\n');
    await index();

    const mentions = (await mentionsOf('notes/dma.md')).mentions;
    expect(mentions).toHaveLength(2);
    expect(mentions[0]!.from).not.toBe(mentions[1]!.from);
    expect(mentions.map((mention) => mention.excerpt)).toEqual(['第一处 dma。', '第二处 dma。']);
  });

  it('代码块里的提及不算', async () => {
    write('notes/dma.md', '# DMA\n');
    write('index.md', '```c\nint dma;\n```\n');
    await index();

    expect((await mentionsOf('notes/dma.md')).mentions).toEqual([]);
  });
});
