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
 * 图谱上的**断链**。
 *
 * 单独一个文件、单独一次启动：这一组要验的是「点断链 → 在工作区里建出那个文件」，
 * 它**会改动工作区**（新建一篇文档）。放进 `graph-panel.test.ts` 会污染那边四个用例
 * 依赖的固定节点数。
 *
 * 断链节点本身的生成规则在 `index-store.test.ts` 的「断链节点」里逐条验过，
 * 这里只验接线：索引 → 图 → 画布 → 点击 → 新建 → 图上那个点变成真实文档。
 */
describe('图谱断链', () => {
  let tempDir: string;
  let workspace: string;
  let app: ElectronAppInstance;

  interface ScreenNode {
    id: number;
    name: string;
    kind: 'document' | 'missing';
    x: number;
    y: number;
  }

  const readScreenNodes = () =>
    app
      .evaluate<string>(`document.querySelector('.nexus-graph-hitmap')?.dataset.screenNodes ?? '[]'`)
      .then((raw) => JSON.parse(raw) as ScreenNode[]);

  beforeAll(async () => {
    tempDir = createTempDir('nexus-graph-missing-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });

    // 一篇存在、一篇只被引用
    fs.writeFileSync(path.join(workspace, 'index.md'), '# 索引\n\n见 [[还没写的方案]]。\n', 'utf-8');

    app = await launchElectronApp({ filePath: workspace });
    await app.waitForIndexReady();
    await app.click('.nexus-activity-icon[data-activity="graph"]');
    await app.waitForSelector('.nexus-graph-canvas', 20000);
  }, INDEXED_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('指向不存在的文档时画出一个断链节点，而不是静默丢掉这条链接', async () => {
    await app.waitForFunction(
      `JSON.parse(document.querySelector('.nexus-graph-hitmap').dataset.screenNodes)
         .some((node) => node.kind === 'missing')`,
      10000
    );

    const nodes = await readScreenNodes();
    expect(nodes.map((node) => node.name).sort()).toEqual(['index.md', '还没写的方案']);

    // 画布上确实画了东西（断链是虚线环，不是实心点）
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
  }, INDEXED_TEST_TIMEOUT_MS);

  it('点断链节点会按目标名新建并打开那篇文档', async () => {
    const missing = (await readScreenNodes()).find((node) => node.kind === 'missing')!;
    expect(missing).toBeTruthy();

    await app.evaluate(`(() => {
      const canvas = document.querySelector('.nexus-graph-canvas');
      const rect = canvas.getBoundingClientRect();
      const point = { x: rect.left + ${missing.x}, y: rect.top + ${missing.y} };
      canvas.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, button: 0, clientX: point.x, clientY: point.y
      }));
      canvas.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, button: 0, clientX: point.x, clientY: point.y
      }));
    })()`);

    // 新建的那篇会被打开
    await app.waitForFunction(
      `document.querySelector('.nexus-filename')?.textContent === '还没写的方案.md'`,
      15000
    );

    // 磁盘上真的有这个文件，不是只改了界面
    expect(fs.existsSync(path.join(workspace, '还没写的方案.md'))).toBe(true);
  }, INDEXED_TEST_TIMEOUT_MS);

  it('建完之后图上不再有断链节点', async () => {
    // 新建会把索引版本顶上去，图谱重取 —— 那个点应该变成普通文档节点
    await app.waitForFunction(
      `JSON.parse(document.querySelector('.nexus-graph-hitmap').dataset.screenNodes)
         .every((node) => node.kind === 'document')`,
      15000
    );

    const nodes = await readScreenNodes();
    expect(nodes.map((node) => node.name).sort()).toEqual(['index.md', '还没写的方案.md']);
  }, INDEXED_TEST_TIMEOUT_MS);
});
