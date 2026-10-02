// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  INDEXED_TEST_TIMEOUT_MS,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * 图谱视图状态的**跨启动**持久化。
 *
 * 单独一个文件：这一组要启动两次 Electron，而「一次启动一个文件」是这套用例的硬约束
 * （每次启动 ~7s，混在别的文件里会拖长整个文件）。
 *
 * 为什么非要有这一层：`graph-view-state.test.ts` 验的是值域与读写，
 * `graph-panel.test.tsx` 验的是**重新挂载**之后还在 —— 那都发生在同一个进程里。
 * 而这三项落盘的**全部意义**是「下次打开 Nexus 时还是这个视图」，
 * 所以判据必须跨一次真实的启动：同一个 `--user-data-dir` 起两次。
 */
describe('图谱视图状态跨启动', () => {
  let tempDir: string;
  let workspace: string;
  let userDataDir: string;
  let app: ElectronAppInstance | null = null;

  const openGraph = async () => {
    const instance = await launchElectronApp({ filePath: workspace, userDataDir });
    await instance.waitForIndexReady();
    await instance.click('.nexus-activity-icon[data-activity="graph"]');
    await instance.waitForSelector('.nexus-graph-canvas', 20000);
    return instance;
  };

  const isPressed = (selector: string) =>
    app!.evaluate<boolean>(
      `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-pressed') === 'true'`
    );

  beforeAll(() => {
    tempDir = createTempDir('nexus-graph-persist-');
    workspace = path.join(tempDir, 'vault');
    // 显式给 userDataDir：harness 只在**没传**的时候才自己建一个并在退出时删掉，
    // 传了就是「我要跨启动复用这份状态」。
    userDataDir = path.join(tempDir, 'userdata');
    fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'notes', 'a.md'), '# A\n\n[[b]]\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'notes', 'b.md'), '# B\n', 'utf-8');
    // 有附件才画得出类型筛选条
    fs.writeFileSync(path.join(workspace, 'manual.pdf'), '%PDF-1.4 占位', 'utf-8');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('第一次启动：改成孤儿视图并关掉 PDF', async () => {
    app = await openGraph();

    // 关掉 PDF（筛选条只在图谱视图里画），再切到孤儿视图
    await app.click('.nexus-graph-chip[data-type="pdf"]');
    await app.waitForFunction(
      `document.querySelector('.nexus-graph-chip[data-type="pdf"]').getAttribute('aria-pressed') === 'false'`,
      10000
    );
    await app.click('.nexus-graph-chip[data-mode="orphans"]');
    await app.waitForFunction(
      `document.querySelector('.nexus-graph-chip[data-mode="orphans"]').getAttribute('aria-pressed') === 'true'`,
      10000
    );

    // **必须优雅关闭**：这三项存在 localStorage 里，而 SIGTERM 会让 Chromium
    // 来不及把它刷到磁盘 —— 症状是「下次启动读回来是空的」，看起来像产品 bug
    await app.closeGracefully();
    app = null;
  }, INDEXED_TEST_TIMEOUT_MS);

  it('第二次启动：视图与筛选都还在', async () => {
    app = await openGraph();

    // 换一次进程之后仍是孤儿视图 —— 这就是这三项落盘的全部意义
    expect(await isPressed('.nexus-graph-chip[data-mode="orphans"]')).toBe(true);

    // 切回图谱视图看筛选条：关掉的 PDF 仍然是关的
    await app.click('.nexus-graph-chip[data-mode="explore"]');
    await app.waitForSelector('.nexus-graph-chip[data-type="pdf"]', 10000);
    expect(await isPressed('.nexus-graph-chip[data-type="pdf"]')).toBe(false);

    await app.closeGracefully();
    app = null;
  }, INDEXED_TEST_TIMEOUT_MS);
});
