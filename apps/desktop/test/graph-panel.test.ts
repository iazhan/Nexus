// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  INDEXED_TEST_TIMEOUT_MS,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * 图谱面板。
 *
 * 布局算法本身的 8 条单测在 `renderer/test/graph-layout.test.ts`（含确定性、
 * 坐标边界、相连节点更近）。这里验接进 App 之后的链路：索引 → 图 → 画布 → 点击打开。
 */
describe('图谱面板', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-graph-e2e-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });

    // a → b → c 一条链，外加一篇孤立的
    fs.writeFileSync(path.join(workspace, 'a.md'), '# A\n\n参见 [[b]]。\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'b.md'), '# B\n\n参见 [[c]]。\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'c.md'), '# C\n\n终点。\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'lonely.md'), '# 孤立\n\n谁也不链。\n', 'utf-8');
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

  it('画出节点与边，点击节点打开对应文档', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    // 等索引就绪 —— 图谱的数据来自它
    await app.waitForIndexReady();

    await app.click('.nexus-activity-icon[data-activity="graph"]');
    await app.waitForSelector('.nexus-graph-canvas', 20000);

    // 四个文档都该进图
    const nodes = JSON.parse(
      await app.evaluate<string>(
        `document.querySelector('.nexus-graph-hitmap')?.dataset.nodes ?? '[]'`
      )
    ) as Array<{ id: number; x: number; y: number }>;
    expect(nodes).toHaveLength(4);

    // 画布上确实画了东西（不是一张空白）
    const painted = await app.evaluate<number>(`(() => {
      const canvas = document.querySelector('.nexus-graph-canvas');
      const context = canvas.getContext('2d');
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) count += 1;
      }
      return count;
    })()`);
    expect(painted).toBeGreaterThan(0);

    // 点第一个节点 → 打开它的文档
    const opened = await app.evaluate<string>(`(() => {
      const canvas = document.querySelector('.nexus-graph-canvas');
      const rect = canvas.getBoundingClientRect();
      const node = ${JSON.stringify(nodes)}[0];
      canvas.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: rect.left + node.x,
        clientY: rect.top + node.y
      }));
      return document.querySelector('.nexus-filename')?.textContent ?? '';
    })()`);

    await app.waitForSelector('.cm-content', 20000);

    // 打开的应该是图上的某个文档（具体哪一个取决于布局顺序，不做强断言）
    const fileName = await app.evaluate<string>(
      `document.querySelector('.nexus-filename')?.textContent ?? ''`
    );
    expect(['a.md', 'b.md', 'c.md', 'lonely.md']).toContain(fileName);
    expect(opened).toBeDefined();
  }, INDEXED_TEST_TIMEOUT_MS);
});
