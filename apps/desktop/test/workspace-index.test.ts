// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * 工作区索引在**真实 Electron 主进程**里跑通（P2-05）。
 *
 * 这条用例的主要价值是验证 ADR-0002 里标为「未验证」的准入条件：
 * `node-sqlite3-wasm` 是外部化的依赖，运行时要去 node_modules 里找 `.wasm` 文件 ——
 * 源码目录里跑得通不代表 electron-vite 打包后的 `out/main/index.cjs` 里也找得到。
 * 索引逻辑本身的正确性由 `index-store.test.ts` 的 12 条单测覆盖，这里只验集成。
 */
describe('工作区索引（Electron 主进程）', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-index-e2e-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });

    fs.writeFileSync(
      path.join(workspace, 'root.md'),
      '# 根文档\n\n记录 EtherCAT 从站的 PDO 映射。\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(workspace, 'notes', 'dma.md'),
      '# DMA\n\n控制器支持多通道传输，注意缓存一致性。\n',
      'utf-8'
    );
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  // 超时放宽：workspace 模式下侧栏挂载时会先跑一次索引，这个用例又要再跑两次，
  // 加上 Electron 冷启动，30s 的默认上限太贴边（实测 29.97s）。
  it('能在主进程建库、索引工作区，并用中文 2 字词检索到结果', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForSelector('.nexus-workspace-empty', 20000);

    const result = await app.evaluate<{
      scanned: number;
      indexed: number;
      skipped: number;
      truncated: boolean;
      errors: string[];
    }>(`window.nexus.rebuildIndex(${JSON.stringify(workspace)})`);

    expect(result.errors).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.scanned).toBe(2);
    // **不要断言 `indexed === 2`**：workspace 模式下侧栏挂载时已经自动跑过一次
    // `rebuildIndex()`，所以这次多半是幂等的第二次，两个文件都会按内容哈希跳过。
    // 这里断言「两个文件都被处理到了」，把「第一次还是第二次」留给下面的幂等用例。
    expect(result.indexed + result.skipped).toBe(2);

    // 再跑一次：内容没变，应该全部跳过（幂等）
    const second = await app.evaluate<{ indexed: number; skipped: number }>(
      `window.nexus.rebuildIndex(${JSON.stringify(workspace)})`
    );
    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(2);

    // 中文 2 字词 —— unicode61 与 trigram 都做不到这件事（ADR-0002 实测）
    const hits = await app.evaluate<Array<{ name: string }>>(
      `window.nexus.searchIndex('从站')`
    );
    expect(hits.map((hit) => hit.name)).toEqual(['root.md']);

    const docs = await app.evaluate<Array<{ relativePath: string }>>(
      `window.nexus.listIndexedDocuments()`
    );
    expect(docs.map((doc) => doc.relativePath)).toEqual(['notes/dma.md', 'root.md']);
  }, 45000);
});
