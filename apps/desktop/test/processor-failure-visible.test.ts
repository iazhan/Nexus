// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProcessorRegistry, type DocumentProcessor } from '@nexus/core';
import { FileService } from '../electron/file-service.js';
import { IndexStore } from '../electron/index-store.js';
import { indexWorkspace } from '../electron/indexer.js';

/**
 * 「提取失败」必须在**索引里**留下痕迹，而不是只在日志里（计划 §2.4 第 3 条）。
 *
 * ## 为什么这一组要有用例
 *
 * 失败有两条路：处理器抛异常（由 `ProcessorRegistry.extract` 收成 `failed`），
 * 与**字节读不出来**（权限、扫描途中被删）。两条都必须写 `extraction_status` ——
 * 不写的话那一行停在 `'none'`，而 `'none'` 在界面上是「不提示」（`extractionNoteOf()`），
 * 于是那个附件既没有正文、也没有任何说明，用户唯一的感受是「搜不到」。
 * 这条路径**不会报错**，只有断言能钉住它。
 *
 * ## 为什么重试这件事也在这里
 *
 * 「看得见失败」与「有办法重试」是同一件事的两半：`'failed'` 如果和 `'extracted'` 一样
 * 被跳过，用户看到失败之后唯一的动作（设置页那个「重建索引」）对它就是空转，
 * 而且是静默的 —— 按钮只报「已完成」。所以跳过判据的两侧都要钉：
 * `'failed'` 重试，`'empty'` **不**重试（它是关于内容的结论，重跑只是白付一次解析）。
 *
 * ## 为什么不用 Electron
 *
 * `file-service.ts` / `indexer.ts` 都不 import electron，整个文件在 node 里跑完 ——
 * 不占 desktop 那套「一个文件只启动一次」的批次预算。
 */

/** 每次都抛 —— 模拟 pdfjs / mammoth 在坏文件上炸掉。 */
function throwingProcessor(
  id: string,
  type: 'pdf' | 'docx',
  message = '损坏的文件'
): DocumentProcessor {
  return {
    id,
    documentTypes: [type],
    extract: async () => {
      throw new Error(message);
    }
  };
}

/** 前 `failTimes` 次抛错，之后成功。用来证明失败**会被重试**，而不是永久钉死。 */
function flakyProcessor(
  id: string,
  type: 'pdf' | 'docx',
  failTimes: number,
  text: string
): { processor: DocumentProcessor; calls: () => number } {
  let calls = 0;
  return {
    processor: {
      id,
      documentTypes: [type],
      extract: async () => {
        calls += 1;
        if (calls <= failTimes) throw new Error(`第 ${calls} 次解析失败`);
        return { status: 'extracted', text };
      }
    },
    calls: () => calls
  };
}

/** 报告「没有文本」（扫描版 PDF 的形态），并数被调了几次。 */
function emptyProcessor(
  id: string,
  type: 'pdf' | 'docx'
): { processor: DocumentProcessor; calls: () => number } {
  let calls = 0;
  return {
    processor: {
      id,
      documentTypes: [type],
      extract: async () => {
        calls += 1;
        return { status: 'empty', text: '' };
      }
    },
    calls: () => calls
  };
}

describe('处理器失败可见 · 索引里的失败状态与重试', () => {
  let tempDir: string;
  let workspace: string;
  let service: FileService;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-extract-failure-'));
    workspace = path.join(tempDir, 'vault');
    await fsPromises.mkdir(workspace, { recursive: true });

    service = new FileService();
    await service.authorizeWorkspace(workspace);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  const writeFile = async (relativePath: string, content: string) => {
    const absolute = path.join(workspace, relativePath);
    await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
    await fsPromises.writeFile(absolute, content, 'utf-8');
  };

  const openStore = (name: string): IndexStore => IndexStore.open(path.join(tempDir, name));

  const statusOf = (store: IndexStore, relativePath: string) =>
    store.listDocuments().find((document) => document.relativePath === relativePath)
      ?.extractionStatus;

  const registryOf = (...processors: DocumentProcessor[]): ProcessorRegistry => {
    const registry = new ProcessorRegistry();
    for (const processor of processors) registry.register(processor);
    return registry;
  };

  it('处理器抛异常：附件写成 failed、错误清单里有一条，且下一次重建会重试并成功', async () => {
    await writeFile('note.md', '# 笔记\n\n见 [甲](doc.pdf)。\n');
    await writeFile('doc.pdf', 'AlphaMarker');

    const flaky = flakyProcessor('pdf-text', 'pdf', 1, 'AlphaMarker');
    const store = openStore('flaky.db');

    try {
      // ── 第一轮：解析失败 ────────────────────────────────────────────────
      const first = await indexWorkspace({
        service,
        store,
        rootPath: workspace,
        processors: registryOf(flaky.processor)
      });

      // 这一条是「可见」的核心：状态不是 'none'（那在界面上等于不说话），
      // 而是 'failed'（树上会标出来）。
      expect(statusOf(store, 'doc.pdf')).toBe('failed');
      // 明细里要有它 —— 侧栏那条警告条与设置页的回执都靠这个清单。
      expect(first.errors).toHaveLength(1);
      expect(first.errors[0]).toContain('doc.pdf');
      expect(first.errors[0]).toContain('第 1 次解析失败');
      // 反面：失败不能连累别的文件，笔记照旧索引进来了
      expect(statusOf(store, 'note.md')).toBe('none');
      expect(store.listDocuments().map((document) => document.relativePath).sort()).toEqual([
        'doc.pdf',
        'note.md'
      ]);

      // ── 第二轮：磁盘一个字没动，再建一次 ─────────────────────────────────
      // 这正是「重建索引」按钮做的事。**必须重试** —— 不重试的话那个按钮对
      // 已经失败的文件就是空转，用户被堵在死胡同里。
      const second = await indexWorkspace({
        service,
        store,
        rootPath: workspace,
        processors: registryOf(flaky.processor)
      });

      expect(flaky.calls()).toBe(2);
      expect(statusOf(store, 'doc.pdf')).toBe('extracted');
      // 反面：这一轮没有失败，清单必须是空的（不能一直挂着上一轮的记录）
      expect(second.errors).toEqual([]);
      expect(
        store
          .search('AlphaMarker')
          .map((hit) => hit.relativePath)
      ).toEqual(['doc.pdf']);
    } finally {
      store.close();
    }
  });

  it('报告「没有文本」的附件：是 empty 不是 failed，且**不**被重试', async () => {
    await writeFile('note.md', '# 笔记\n\n见 [甲](scan.pdf)。\n');
    await writeFile('scan.pdf', '没有文本层');

    const empty = emptyProcessor('pdf-text', 'pdf');
    const store = openStore('empty.db');

    try {
      const first = await indexWorkspace({
        service,
        store,
        rootPath: workspace,
        processors: registryOf(empty.processor)
      });

      expect(statusOf(store, 'scan.pdf')).toBe('empty');
      // 反面一：`empty` 是关于**内容**的结论，不是故障 —— 不能混进错误清单。
      // 混进去的表现是「一切正常的工作区里也挂着一条警告」。
      expect(first.errors).toEqual([]);

      await indexWorkspace({
        service,
        store,
        rootPath: workspace,
        processors: registryOf(empty.processor)
      });

      // 反面二：`empty` 必须继续被跳过。跳过判据要是被简化成「不是 extracted 就重跑」，
      // 每个扫描版 PDF 都会在每轮索引里被完整解析一遍 —— 几百页的手册上这笔账很实。
      expect(empty.calls()).toBe(1);
    } finally {
      store.close();
    }
  });

  it('字节读不出来（权限 / 扫描途中被删）：同样写成 failed，不留一个不出声的附件', async () => {
    await writeFile('note.md', '# 笔记\n\n见 [甲](doc.pdf)。\n');
    await writeFile('doc.pdf', 'AlphaMarker');

    // 这条路**没有处理器参与** —— 处理器连字节都没拿到。它是最容易被漏掉的一支：
    // 原来的实现只 `errors.push()` 而不写状态，于是文件停在 'none'、界面上什么也不说。
    vi.spyOn(service, 'readDocumentBytes').mockRejectedValue(new Error('EACCES: 权限不足'));

    const store = openStore('unreadable.db');

    try {
      const result = await indexWorkspace({
        service,
        store,
        rootPath: workspace,
        processors: registryOf(throwingProcessor('pdf-text', 'pdf'))
      });

      expect(statusOf(store, 'doc.pdf')).toBe('failed');
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('doc.pdf');
      expect(result.errors[0]).toContain('EACCES');

      // 反面：这一支只影响附件那一遍。Markdown 走的是另一个方法（`readFile`），
      // 所以它照常进了索引 —— 拦一个方法不能把整次索引带走。
      expect(statusOf(store, 'note.md')).toBe('none');
      expect(result.scanned).toBe(2);
    } finally {
      store.close();
    }
  });

  it('一切正常时清单是空的 —— 这条警告不能被挂成常驻', async () => {
    await writeFile('note.md', '# 笔记\n\n见 [甲](doc.pdf)。\n');
    await writeFile('doc.pdf', 'AlphaMarker');

    const flaky = flakyProcessor('pdf-text', 'pdf', 0, 'AlphaMarker');
    const store = openStore('healthy.db');

    try {
      const result = await indexWorkspace({
        service,
        store,
        rootPath: workspace,
        processors: registryOf(flaky.processor)
      });

      expect(result.errors).toEqual([]);
      expect(statusOf(store, 'doc.pdf')).toBe('extracted');
    } finally {
      store.close();
    }
  });
});
