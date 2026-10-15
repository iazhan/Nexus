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
 * 图谱标签在**密集图**上的可读性：chip 底 + 随缩放分级。
 *
 * 为什么单独一个文件、单独一次启动：这两条都要**很多节点**才看得出来 ——
 * `graph-panel.test.ts` 的 fixture 只有四篇，标签预算（48 条）根本轮不到它说话，
 * 而「标签糊在边上」这个症状本身也是密了才出现。给它一个 60 篇的 fixture，
 * 两条判据才都落到「预算在起作用」而不是「几何上只放得下这么多」。
 *
 * 为什么必须是真机：`renderer` 那层 happy-dom 没有 canvas 实现，`getContext()`
 * 返回 null，绘制 effect 直接早退 —— 画布上**画了什么**只有真窗口能看。
 * 纯函数（`labelBudget` / `planGraphLabels`）的用例在
 * `renderer/test/graph-labels.test.ts`，这里只验接线。
 */
describe('图谱标签的 chip 与缩放分级', () => {
  let tempDir: string;
  let workspace: string;
  let app: ElectronAppInstance;

  interface LabelRect {
    id: number;
    text: string;
    rect: { left: number; top: number; right: number; bottom: number };
  }

  const readLabels = async (): Promise<LabelRect[]> => {
    const raw = await app.evaluate<string>(
      `document.querySelector('.nexus-graph-hitmap')?.dataset.labels ?? '[]'`
    );
    return JSON.parse(raw) as LabelRect[];
  };

  const readScale = () =>
    app
      .evaluate<string>(`document.querySelector('.nexus-graph-hitmap')?.dataset.view ?? '{}'`)
      .then((raw) => (JSON.parse(raw) as { scale: number }).scale);

  /**
   * 每条标签矩形里取两个**只可能被 chip 覆盖**的点，返回它们的像素 alpha（0–255）。
   *
   * 点位刻意避开文字：`planGraphLabels` 的 padding 是左 4 / 上 3，所以
   * 「矩形左沿往内 2px」与「上沿往内 2px」这两条窄带在文字之外。改动前那里是**透明**的
   * （裸文字），改动后是 chip 的底。
   */
  const chipAlphas = () =>
    app.evaluate<string>(`(() => {
      const canvas = document.querySelector('.nexus-graph-canvas');
      const ratio = window.devicePixelRatio || 1;
      const context = canvas.getContext('2d');
      const labels = JSON.parse(document.querySelector('.nexus-graph-hitmap').dataset.labels);
      const out = [];
      for (const label of labels) {
        const { left, top, right, bottom } = label.rect;
        const points = [
          { x: left + 2, y: (top + bottom) / 2 },
          { x: (left + right) / 2, y: top + 2 }
        ];
        for (const point of points) {
          const data = context.getImageData(
            Math.round(point.x * ratio), Math.round(point.y * ratio), 1, 1
          ).data;
          out.push({ id: label.id, alpha: data[3], x: point.x, y: point.y,
            rect: [left, top, right, bottom], canvas: [canvas.width, canvas.height], ratio });
        }
      }
      return JSON.stringify(out);
    })()`).then((raw) => JSON.parse(raw) as {
      id: number; alpha: number; x: number; y: number;
      rect: number[]; canvas: number[]; ratio: number;
    }[]);

  /** 画布中心为锚点滚一格。`direction` 取 -1 放大、+1 缩小。 */
  const wheel = (direction: -1 | 1) =>
    app.evaluate(`(() => {
      const canvas = document.querySelector('.nexus-graph-canvas');
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaY: ${direction} * 700,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
      }));
    })()`);

  beforeAll(async () => {
    tempDir = createTempDir('nexus-graph-density-');
    workspace = path.join(tempDir, 'vault');

    // 6 个目录 × 10 篇 = 60 个节点。每个目录内部连成一条链，保证图是连通的。
    for (const dir of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
      fs.mkdirSync(path.join(workspace, dir), { recursive: true });
      for (let index = 0; index < 10; index += 1) {
        const next = (index + 1) % 10;
        fs.writeFileSync(
          path.join(workspace, dir, `doc-${index}.md`),
          `# ${dir}-${index}\n\n见 [[${dir}/doc-${next}]]。\n`,
          'utf-8'
        );
      }
    }

    app = await launchElectronApp({ filePath: workspace });
    await app.waitForIndexReady();
    await app.click('.nexus-activity-icon[data-activity="graph"]');
    await app.waitForSelector('.nexus-graph-canvas', 20000);
    // 布局比画布晚一拍（要等 ResizeObserver 报尺寸），等标签真的算出来
    await app.waitForFunction(
      `JSON.parse(document.querySelector('.nexus-graph-hitmap')?.dataset.labels ?? '[]').length > 0`,
      20000
    );
  }, INDEXED_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('标签有 chip 底，而且**静止之后还在**', async () => {
    /*
      这一条同时守两件事：
      1. chip 真的画了（改动前这些点在文字之外，是透明的）；
      2. 它**不是只在动画帧里画**——绘制 effect 只在出生动画期间排帧，静止后不再重绘。
         若 chip 被写进动画那一支而漏在首帧，症状是「图动的时候有底色、停下来就没了」。
         所以先等动画落定，取一次、等一会儿再取一次，两次必须相同且都不为 0。
    */
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const settled = await chipAlphas();
    expect(settled.length).toBeGreaterThan(0);
    expect(
      settled.filter((sample) => sample.alpha === 0),
      '这些采样点落在标签矩形里却没有像素（chip 没画到那里）'
    ).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await chipAlphas()).toEqual(settled);
  }, INDEXED_TEST_TIMEOUT_MS);

  it('缩小时标签明显变少，放大回 1 倍时又回到原来的条数', async () => {
    // 初始视图是 1:1（`view` 初值是 IDENTITY_VIEW），此时预算给满 48 条。
    // 这一条也是「改动前后初始视图逐字段相等」的判据 —— 改动前同样是 48。
    expect(await readScale()).toBe(1);
    const atOne = (await readLabels()).length;
    expect(atOne).toBeGreaterThan(40);

    await wheel(1);
    await app.waitForFunction(
      `JSON.parse(document.querySelector('.nexus-graph-hitmap').dataset.view).scale < 0.6`,
      5000
    );
    // 标签是 effect 里算的、比 scale 晚一帧落进 `data-labels`，等它跟上再读
    await app.waitForFunction(
      `JSON.parse(document.querySelector('.nexus-graph-hitmap').dataset.labels).length < ${atOne}`,
      5000
    );
    const atHalf = (await readLabels()).length;
    // 预算在 0.5 倍时是 24 条；「明显变少」而不是「少一两条」
    expect(atHalf).toBeLessThan(atOne * 0.7);
    expect(atHalf).toBeLessThanOrEqual(24);

    // 缩回去：预算回到满额，条数必须跟着回来（不是「缩过一次就再也回不来」）
    await wheel(-1);
    await app.waitForFunction(
      `JSON.parse(document.querySelector('.nexus-graph-hitmap').dataset.view).scale >= 0.95`,
      5000
    );
    await app.waitForFunction(
      `JSON.parse(document.querySelector('.nexus-graph-hitmap').dataset.labels).length > ${atHalf}`,
      5000
    );
    expect((await readLabels()).length).toBe(atOne);
  }, INDEXED_TEST_TIMEOUT_MS);
});
