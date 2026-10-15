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
 * 从图谱点进一篇文档，落在它的**代表性锚点**那一节。
 *
 * ## 为什么非要有这一层
 *
 * 三处各验了一半，只有真机能证明它们**接得上**：
 * - `index-store.test.ts` 验主进程算出来的 `anchor` 对不对；
 * - `renderer/test/graph-panel.test.tsx` 验渲染层把它传给了 `onOpenFile`（用的是桩）；
 * - 而「传下去之后**真的**跳到了那一行」只能在这里验 —— 中间还隔着一条 IPC、
 *   一次文档打开、一次编辑器视图重建，以及「等新视图就绪再跳」那段排队逻辑。
 *
 * ## 锚点是怎么来的
 *
 * `dma.md` 被三处引用：两处写 `[[dma#性能]]`、一处写 `[[dma#中断]]` —— 取出现最多的
 * 那个。`tie.md` 被两处各引用一次（`#Beta` / `#Alpha`），平局按字典序取小的。
 * `plain.md` 只被 `[[plain]]` 引用，没有任何锚点，落回开头。
 */
describe('图谱节点的代表性锚点', () => {
  let tempDir: string;
  let workspace: string;
  let app: ElectronAppInstance;

  interface ScreenNode {
    id: number;
    name: string;
    x: number;
    y: number;
  }

  /** `## 性能` 那一行的起始偏移。**算出来而不是写死** —— 写死的话夹具一改就飘。 */
  const dmaSource = '# DMA\n\n引言。\n\n## 性能\n\n正文。\n\n## 中断\n\n结尾。\n';
  const dmaOffset = dmaSource.indexOf('## 性能');
  const tieSource = '# TIE\n\n## Alpha\n\n甲。\n\n## Beta\n\n乙。\n';
  const tieOffset = tieSource.indexOf('## Alpha');

  const readScreenNodes = () =>
    app
      .evaluate<string>(`document.querySelector('.nexus-graph-hitmap')?.dataset.screenNodes ?? '[]'`)
      .then((raw) => JSON.parse(raw) as ScreenNode[]);

  const canvasPoint = (node: { x: number; y: number }) =>
    `(() => {
      const canvas = document.querySelector('.nexus-graph-canvas');
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + ${node.x}, y: rect.top + ${node.y} };
    })()`;

  const doubleClickAt = (pointExpression: string) =>
    app.evaluate(`(() => {
      const canvas = document.querySelector('.nexus-graph-canvas');
      const point = ${pointExpression};
      canvas.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, button: 0, clientX: point.x, clientY: point.y
      }));
      canvas.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, button: 0, clientX: point.x, clientY: point.y
      }));
      canvas.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true, button: 0, clientX: point.x, clientY: point.y
      }));
    })()`);

  const ensureGraphVisible = async () => {
    const present = await app.evaluate<boolean>(
      `!!document.querySelector('.nexus-main-content .nexus-graph-canvas')`
    );
    if (present) return;
    await app.click('.nexus-activity-icon[data-activity="graph"]');
    await app.waitForSelector('.nexus-main-content .nexus-graph-canvas', 20000);
    await app.waitForFunction(
      `document.querySelector('.nexus-graph-hitmap')?.dataset.screenNodes !== '[]'`,
      20000
    );
  };

  /** 双击某个节点的圆点，然后等编辑器出现。 */
  const openFromGraph = async (name: string) => {
    await ensureGraphVisible();
    const node = (await readScreenNodes()).find((item) => item.name === name)!;
    await doubleClickAt(canvasPoint(node));
    await app.waitForSelector('.cm-content', 20000);
  };

  const caretOffset = () =>
    app.evaluate<number>('window.nexusActiveView.state.selection.main.head');

  const openedName = () =>
    app.evaluate<string>(`document.querySelector('.nexus-filename')?.textContent ?? ''`);

  beforeAll(async () => {
    tempDir = createTempDir('nexus-graph-anchor-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });

    fs.writeFileSync(path.join(workspace, 'dma.md'), dmaSource, 'utf-8');
    fs.writeFileSync(path.join(workspace, 'tie.md'), tieSource, 'utf-8');
    fs.writeFileSync(path.join(workspace, 'plain.md'), '# PLAIN\n\n没有锚点。\n', 'utf-8');

    // 指向 dma：性能 ×2、中断 ×1
    fs.writeFileSync(path.join(workspace, 'one.md'), '见 [[dma#性能]]。\n', 'utf-8');
    fs.writeFileSync(
      path.join(workspace, 'two.md'),
      '也见 [[dma#性能]] 与 [[tie#Beta]]。\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(workspace, 'three.md'),
      '见 [[dma#中断]] 与 [[tie#Alpha]]。\n',
      'utf-8'
    );
    // 不带锚点的引用：不能让 plain 凭空带上一个锚点
    fs.writeFileSync(path.join(workspace, 'four.md'), '见 [[plain]]。\n', 'utf-8');

    app = await launchElectronApp({ filePath: workspace });
    await app.waitForIndexReady();
  }, INDEXED_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('双击节点落在引用最多的那个锚点上', async () => {
    /*
      正例。`性能` 被两处引用、`中断` 被一处 —— 落点是前者。
      `caretOffset() > 0` 单独是不够的：它必须**正好**是那一行的起始偏移，
      落在正文任何一行都能让「大于 0」成立。
    */
    await openFromGraph('dma.md');

    expect(await openedName()).toBe('dma.md');
    expect(dmaOffset).toBeGreaterThan(0);
    expect(await caretOffset()).toBe(dmaOffset);
  }, INDEXED_TEST_TIMEOUT_MS);

  it('平局时按字典序取小的 —— 不是「看哪个先被扫到」', async () => {
    /*
      反例侧：`#Beta` 与 `#Alpha` 各被引用一次。裁决必须是**全序**的，
      否则同一份工作区两次打开会落到不同标题上，而画面上没有任何东西解释这件事。
    */
    await openFromGraph('tie.md');

    expect(await openedName()).toBe('tie.md');
    expect(await caretOffset()).toBe(tieOffset);
  }, INDEXED_TEST_TIMEOUT_MS);

  it('没有带锚点的引用时落在文档开头', async () => {
    /*
      反例侧：`plain.md` 只被 `[[plain]]` 引用。不能给它凭空挑一个标题 ——
      那会落到一个用户根本没在指的位置，比「落在开头」糟得多。
    */
    await openFromGraph('plain.md');

    expect(await openedName()).toBe('plain.md');
    expect(await caretOffset()).toBe(0);
  }, INDEXED_TEST_TIMEOUT_MS);
});
