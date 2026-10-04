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
 * 标签页之间**各记各的**浏览位置。
 *
 * 两个标签页之间 `EditorSurface` 是同一个组件实例（App 没给它 key），所以切标签页走的
 * 就是「切 surface」那条路：effect 重跑，cleanup 捕获锚点、下一次创建时恢复。区别只在
 * **给谁记** —— 切 surface 是同一个文档换个视图，切标签页是换了文档。
 *
 * 这条守的回归是「锚点只留一个槽位」：那样 A 的锚点会被 B 读到 —— 打开 B 就落在 A 的位置，
 * 切回 A 又落在 B 的位置。所以断言分四段：
 *   ① 新打开的文档停在顶部（没被上一个文档污染）；
 *   ② 各自滚到不同位置，落点必须能区分开；
 *   ③ 切回去，各自的落点还是各自原来那一行；
 *   ④ 同一个文档切 surface 仍然保留 —— 锚点按文档分槽之后这条不能被带坏。
 *
 * 断言的是**位置语义**（锚点行号 + 行内亚行偏移）而不是 `scrollTop`：视觉投影会改行高，
 * 像素值在两个 surface 之间本来就对不上。
 *
 * 一个文件只启动一次 Electron —— 同文件第二次启动会卡在 `Runtime.enable` 不返回
 * （见 `.workbuddy-ai/memory/MEMORY.md`），所以全部断言塞进同一个用例。
 */
describe('标签页之间的滚动位置', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  /** 两份同构但够长的文档：都滚得动，且锚点落在不同行才能验「各记各的」。 */
  function longDocument(title: string, label: string): string {
    return ['# ' + title, '', ...Array.from({ length: 200 }, (_, i) => `${label}第 ${i + 1} 行。`)].join(
      '\n\n'
    );
  }

  beforeAll(() => {
    tempDir = createTempDir('nexus-tab-scroll-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'alpha.md'), longDocument('alpha', '甲段'), 'utf-8');
    fs.writeFileSync(path.join(workspace, 'beta.md'), longDocument('beta', '乙段'), 'utf-8');
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

  interface ViewportProbe {
    lineNumber: number;
    lineText: string;
    /** 视口顶边在锚点行内的亚行偏移（像素）。 */
    offset: number;
    scrollTop: number;
  }

  async function probeViewport(app: ElectronAppInstance): Promise<ViewportProbe> {
    return app.evaluate<ViewportProbe>(`(() => {
      const view = window.nexusActiveView;
      if (!view) throw new Error('Active view unavailable');
      // scrollSnapshot() 是位置语义：range.head = 视口顶边所在 block 的起点，
      // yMargin = 视口顶边在该 block 内的偏移。
      const snap = view.scrollSnapshot().value;
      const line = view.state.doc.lineAt(snap.range.head);
      return {
        lineNumber: line.number,
        lineText: line.text.trim().slice(0, 30),
        offset: snap.yMargin,
        scrollTop: view.scrollDOM.scrollTop
      };
    })()`);
  }

  async function scrollToLine(app: ElectronAppInstance, needle: string): Promise<void> {
    await app.evaluate(`(() => {
      const view = window.nexusActiveView;
      const pos = view.state.doc.toString().indexOf(${JSON.stringify(needle)});
      if (pos < 0) throw new Error('needle not found');
      view.scrollDOM.scrollTop = view.lineBlockAt(pos).top;
      return true;
    })()`);
    // 等 CM 重新测量并渲染新视口
    await new Promise((resolve) => setTimeout(resolve, 600));
  }

  /** 点树上的某一行开成标签页。按名字找，不按顺序 —— 顺序取决于目录展开与排序。 */
  async function openTreeFile(app: ElectronAppInstance, name: string): Promise<void> {
    await app.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.nexus-tree-file'))
        .find((el) => el.querySelector('.nexus-tree-name')?.textContent === ${JSON.stringify(name)});
      if (!row) throw new Error('树上找不到 ' + ${JSON.stringify(name)});
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    })()`);
    await app.waitForFunction(
      `document.querySelector('.nexus-filename')?.textContent === ${JSON.stringify(name)}`,
      15000
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  /** 切到第 `index` 个标签页，并等编辑器真的换成了含 `marker` 的那份文档。 */
  async function activateTab(
    app: ElectronAppInstance,
    index: number,
    marker: string
  ): Promise<void> {
    await app.evaluate(`document.querySelectorAll('.nexus-tab')[${index}].click(), true`);
    await app.waitForFunction(
      `window.nexusActiveView?.state.doc.toString().includes(${JSON.stringify(marker)})`,
      15000
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  async function toggleSurface(app: ElectronAppInstance, target: string): Promise<void> {
    await app.click('[data-action="toggle-surface"]');
    await app.waitForSelector(`[data-surface-kind="${target}"]`, 20000);
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  it('新打开的标签页停在顶部，切回去各自回到自己的位置', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForIndexReady();

    /* ① 打开 alpha，滚到中段 */
    await openTreeFile(app, 'alpha.md');
    await scrollToLine(app, '甲段第 120 行');
    const alphaAt120 = await probeViewport(app);
    // 前提：确实滚下去了，否则后面的断言恒真
    expect(alphaAt120.scrollTop).toBeGreaterThan(100);
    expect(alphaAt120.lineText).toContain('甲段第');

    /* ② 打开 beta —— 必须停在顶部，而不是被 alpha 的锚点拖走 */
    await openTreeFile(app, 'beta.md');
    expect(await app.evaluate<number>(`document.querySelectorAll('.nexus-tab').length`)).toBe(2);
    const betaAtOpen = await probeViewport(app);
    expect(betaAtOpen.lineNumber).toBe(1);
    expect(betaAtOpen.scrollTop).toBeLessThanOrEqual(2);

    /* ③ beta 滚到另一处 —— 与 alpha 的落点必须能区分开，否则 ④ 里分不出谁是谁 */
    await scrollToLine(app, '乙段第 30 行');
    const betaAt30 = await probeViewport(app);
    expect(betaAt30.scrollTop).toBeGreaterThan(100);
    expect(betaAt30.lineText).toContain('乙段第');
    expect(betaAt30.lineNumber).not.toBe(alphaAt120.lineNumber);

    /* ④ 切回 alpha：落点还是 ① 那一行 */
    await activateTab(app, 0, '甲段第');
    const alphaAgain = await probeViewport(app);
    expect(alphaAgain.lineNumber).toBe(alphaAt120.lineNumber);
    expect(alphaAgain.lineText).toBe(alphaAt120.lineText);
    expect(Math.abs(alphaAgain.offset - alphaAt120.offset)).toBeLessThanOrEqual(1.5);

    /* ⑤ 同一个文档切 surface 仍然保留 —— 锚点按文档分槽不能把这条带坏 */
    await toggleSurface(app, 'visual');
    const alphaVisual = await probeViewport(app);
    expect(alphaVisual.lineNumber).toBe(alphaAt120.lineNumber);
    expect(alphaVisual.lineText).toBe(alphaAt120.lineText);
    await toggleSurface(app, 'source');

    /* ⑥ 再回 beta：它自己那一处也还在 */
    await activateTab(app, 1, '乙段第');
    const betaAgain = await probeViewport(app);
    expect(betaAgain.lineNumber).toBe(betaAt30.lineNumber);
    expect(betaAgain.lineText).toBe(betaAt30.lineText);
    expect(Math.abs(betaAgain.offset - betaAt30.offset)).toBeLessThanOrEqual(1.5);
  }, INDEXED_TEST_TIMEOUT_MS);
});
