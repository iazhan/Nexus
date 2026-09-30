// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { launchElectronApp, createTempDir, type ElectronAppInstance } from './smoke-harness.js';

/**
 * 「扫描时忽略的目录」（`files.ignoreRules`）在**真机**里跑通整条链路：
 * 设置页的值 → 宿主设置通道 → 主进程 walker → 索引 → （索引的投影）文件树。
 *
 * 这是这条通道存在的理由：跳过规则是在**主进程**生效的，而设置值在渲染进程手里。
 * 少了这条通道，或者推送晚于索引，症状都是「填了忽略规则，第一次没生效」——
 * 而那个症状在单测里看不出来（单测可以自己把规则传进去）。
 *
 * 判据取 `listIndexedDocuments()` 而不是 DOM：侧栏是**索引的投影**，而索引在这里
 * 就是用户可见结果的来源。DOM 那一层（索引 → 树）由 `workspace-sidebar*.test.tsx` 覆盖，
 * 而这条用例要钉的是「主进程到底扫了什么」。索引会把不再出现的文档剪掉
 * （`seenPaths` → `removeDocuments`），所以「被忽略」在这里必须表现为**少了一项**，
 * 不是「还在但没更新」。
 */
describe('扫描忽略规则（真机端到端）', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  /**
   * 轮询到条件成立。
   *
   * **不能用 harness 的 `waitForFunction`**：它把表达式包成一个**同步**函数再取布尔值
   * （`smoke-harness.ts` 的 `Boolean(v())`），所以返回 Promise 的表达式恒为真、立刻通过 ——
   * 等待变成空转，后面的断言就会读到中间状态。要等的东西都走 IPC（`scanWorkspace` /
   * `listIndexedDocuments` 都是异步的），只能自己用 `evaluate` 轮询（它带 `awaitPromise`）。
   */
  async function waitFor<T>(
    probe: () => Promise<T>,
    done: (value: T) => boolean,
    timeoutMs = 20000
  ): Promise<T> {
    const start = Date.now();
    let last: T | undefined;
    while (Date.now() - start < timeoutMs) {
      last = await probe();
      if (done(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`等待超时，最后一次读到：${JSON.stringify(last)}`);
  }

  beforeAll(() => {
    tempDir = createTempDir('nexus-ignore-rules-');
    workspace = path.join(tempDir, 'vault');

    for (const relative of ['notes', 'drafts', 'archive/private']) {
      fs.mkdirSync(path.join(workspace, relative), { recursive: true });
    }
    fs.writeFileSync(path.join(workspace, 'root.md'), '# 根文档\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'notes', 'dma.md'), '# DMA\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'drafts', 'wip.md'), '# 草稿\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'archive', 'private', 'secret.md'), '# 私密\n', 'utf-8');
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

  it('填了规则、重建索引之后，被忽略的目录不再出现在索引里', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForSelector('.nexus-workspace-empty', 20000);

    const indexedPaths = () =>
      app.evaluate<string[]>(
        `window.nexus.listIndexedDocuments().then((docs) => docs.map((doc) => doc.relativePath))`
      );

    /** 主进程当前这一轮扫描收了多少个文件 —— 规则有没有送到，只有它说了算。 */
    const scannedFileCount = () =>
      app.evaluate<number>(
        `window.nexus.scanWorkspace(${JSON.stringify(workspace)}).then((scan) => scan.files.length)`
      );

    // ① 起点：四个文档都在。先等到侧栏那次自动索引跑完，否则下面读到的是中间状态。
    await waitFor(indexedPaths, (paths) => paths.length === 4, 30000);
    expect(await indexedPaths()).toEqual([
      'archive/private/secret.md',
      'drafts/wip.md',
      'notes/dma.md',
      'root.md'
    ]);

    // ② 改设置 —— 走**真实**的写盘 + 广播路径（`window.nexusSettings` 是测试接缝）。
    //    它同时触发宿主设置推送（`host-settings.ts` 订阅了这项）。
    await app.evaluate(
      `window.nexusSettings.set('files.ignoreRules', 'drafts, archive/private')`
    );

    // ③ 等规则真的到了主进程再重建索引。
    //
    //    判据用「扫描结果变了」而不是固定延时：`scanWorkspace` 收多少个文件就是主进程
    //    当前用的规则算出来的。这条等待是必要的 —— 这里的 `rebuildIndex` 是直接调桥，
    //    绕开了渲染进程那两个 `await hostSettingsSynced()` 的调用点。
    await waitFor(scannedFileCount, (count) => count === 2, 15000);

    // ④ 重建索引：新规则生效，且**不再被扫到的文档被剪掉**（不是留着旧条目）。
    const result = await app.evaluate<{ scanned: number; errors: string[] }>(
      `window.nexus.rebuildIndex(${JSON.stringify(workspace)})`
    );
    expect(result.errors).toEqual([]);
    expect(result.scanned).toBe(2);

    expect(await indexedPaths()).toEqual(['notes/dma.md', 'root.md']);

    // ⑤ 清空规则 → 目录回来。这一条钉住「规则是可逆的」，而不是一次性的单向过滤。
    await app.evaluate(`window.nexusSettings.set('files.ignoreRules', '')`);
    await waitFor(scannedFileCount, (count) => count === 4, 15000);

    const restored = await app.evaluate<{ scanned: number }>(
      `window.nexus.rebuildIndex(${JSON.stringify(workspace)})`
    );
    expect(restored.scanned).toBe(4);
    expect(await indexedPaths()).toEqual([
      'archive/private/secret.md',
      'drafts/wip.md',
      'notes/dma.md',
      'root.md'
    ]);
  }, 90000);
});
