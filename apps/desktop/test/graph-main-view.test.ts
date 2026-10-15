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
 * 图谱占**编辑区**：主区图谱视图的真机接线。
 *
 * 这一层与 `graph-panel.test.ts` 分工：那一条验图谱**自己**（布局、命中、拖拽、
 * 清单切换），全部发生在「图谱已经在那儿」之后；这一条验的是**它换了位置**——
 * 从活动栏的窄面板搬到主区，编辑区整块让位。
 *
 * 三条只有真机能证的：
 *
 * 1. **主区真的换了内容**：画布在 `.nexus-main-content` 里面，且标签栏 / 工具栏 /
 *    编辑器都不画了。happy-dom 那层（`renderer/test/graph-main-view.test.tsx`）验的是
 *    「React 树换了分支」，这里验的是**真窗口里的盒子**——CSS 一改（比如主区忘了
 *    `overflow: hidden`）就只有这边会红。
 * 2. **侧栏整块隐藏**：图要的是「一屏图」。侧栏虽然还挂载着（切回来不用重跑索引），
 *    但 slot 挂 hidden 类、由 CSS 收起；这里顺带盯住它没有变成空白或第二份图谱。
 * 3. **双击节点打开文档后退场**：主区一旦有文档要显示，图谱就让位，侧栏跟着回来。
 *    这条同时是「图谱不会把自己变成一潭死水」的保证：双击节点看得见文档。
 *
 * **一个文件只启动一次 Electron**（同文件第二次启动会卡在 `Runtime.enable` 不返回）。
 * 两条用例按顺序共用一次启动：第一条切进图谱，第二条在图谱里双击节点。
 */

interface ScreenNode {
  id: number;
  name: string;
  x: number;
  y: number;
}

describe('图谱占编辑区', () => {
  let tempDir: string;
  let workspace: string;
  let app: ElectronAppInstance;

  beforeAll(async () => {
    tempDir = createTempDir('nexus-graph-main-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });

    // 一条链就好：这个文件不验图谱的内容，只验它在哪儿。
    fs.writeFileSync(path.join(workspace, 'a.md'), '# A\n\n参见 [[b]]。\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'b.md'), '# B\n\n终点。\n', 'utf-8');

    app = await launchElectronApp({ filePath: workspace });
    await app.waitForIndexReady();
  }, INDEXED_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('点「图谱」图标：编辑区整块让位，图谱进主区，侧栏整块隐藏', async () => {
    // 前置条件：现在还是编辑区那一屏（空态），树上有两篇笔记
    await app.waitForSelector('[data-relative-path="a.md"]', 20000);
    expect(
      await app.evaluate<boolean>(`!!document.querySelector('.nexus-workspace-empty')`)
    ).toBe(true);

    // 记下让位前主区的宽度，后面验「那块空间真的归图谱了」
    const mainWidthBefore = await app.evaluate<number>(
      `document.querySelector('.nexus-main-content').getBoundingClientRect().width`
    );

    await app.click('.nexus-activity-icon[data-activity="graph"]');

    // 图谱进了主区，而且是「主区」那一版外观
    await app.waitForSelector('.nexus-main-content .nexus-graph', 20000);
    expect(
      await app.evaluate<string>(
        `document.querySelector('.nexus-main-content .nexus-graph')?.dataset.variant ?? ''`
      )
    ).toBe('main');
    await app.waitForSelector('.nexus-main-content .nexus-graph-canvas', 20000);

    // 编辑区整块不画 —— 空态、标签栏、编辑器一起（图谱要的是「一屏图」）
    expect(
      await app.evaluate<boolean>(
        `document.querySelector('.nexus-main-content .nexus-workspace-empty') === null &&
         document.querySelector('.nexus-tab') === null &&
         document.querySelector('.nexus-editor-toolbar') === null &&
         document.querySelector('.cm-content') === null`
      )
    ).toBe(true);

    // 侧栏整块让位：slot 挂 hidden 类（真机上 `display: none`），
    // **连面板容器一起**（宽度类 `-open` 决定 flex-basis）—— 只藏内容会让
    // 那 240px 顶着白边，图谱拿不到这块空间。侧栏里也没有第二份图谱；
    // 挂载保留是刻意的（切回来不用重跑索引）。
    //
    // 宽度是**过渡**出来的（`flex-basis` 有 160ms 动画），所以要等它落定，
    // 不能立刻量 —— 量到中间值会以为「没让位」。收完后还剩 1px，那是容器
    // 常驻的 `border-right: 1px solid transparent`（直接切边框会让动画末尾跳一下）。
    await app.waitForFunction(
      `document.querySelector('.nexus-activity-panel')?.getBoundingClientRect().width <= 1`,
      15000
    );
    expect(
      await app.evaluate<boolean>(
        `(() => {
           const panel = document.querySelector('.nexus-activity-panel');
           const slot = document.querySelector('.nexus-activity-panel .nexus-workspace-sidebar')
             ?.closest('.nexus-panel-slot');
           return slot !== null &&
             slot.classList.contains('nexus-panel-slot-hidden') &&
             getComputedStyle(slot).display === 'none' &&
             !panel.classList.contains('nexus-activity-panel-open') &&
             document.querySelector('.nexus-activity-panel .nexus-graph') === null &&
             document.querySelector('.nexus-panel-resizer') === null;
         })()`
      )
    ).toBe(true);

    // 用户视角的那条：那块空间真的归图谱了 —— 主区比图谱进来之前宽出接近一个面板
    expect(
      await app.evaluate<number>(
        `document.querySelector('.nexus-main-content').getBoundingClientRect().width`
      )
    ).toBeGreaterThan(mainWidthBefore - 1 + 150);

    // 灯亮 ⇔ 图在主区
    expect(
      await app.evaluate<string>(
        `document.querySelector('.nexus-activity-icon[data-activity="graph"]')?.getAttribute('aria-pressed')`
      )
    ).toBe('true');
  }, INDEXED_TEST_TIMEOUT_MS);

  it('在图谱里双击节点打开文档：主区让位回编辑区', async () => {
    // 布局比画布晚一拍（尺寸要等 ResizeObserver 报上来），等节点真的算出来
    await app.waitForFunction(
      `document.querySelector('.nexus-graph-hitmap')?.dataset.screenNodes !== '[]'`,
      20000
    );

    const nodes = JSON.parse(
      await app.evaluate<string>(
        `document.querySelector('.nexus-graph-hitmap')?.dataset.screenNodes ?? '[]'`
      )
    ) as ScreenNode[];
    const target = nodes.find((node) => node.name === 'a.md');
    expect(target).toBeDefined();

    // 在画布上那一点双击 —— 单击只选中（2026-10-15 起），打开是双击。
    // 浏览器里双击是 `mousedown/mouseup/click` ×2 之后再来一个 `dblclick`；
    // 这里省掉 `click`（没人监听它）但保留一次按-放。
    await app.evaluate(`(() => {
      const canvas = document.querySelector('.nexus-main-content .nexus-graph-canvas');
      const rect = canvas.getBoundingClientRect();
      const point = { x: rect.left + ${target!.x}, y: rect.top + ${target!.y} };
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

    // 文档开了：标题栏跟上、编辑器挂上，图谱整块退场
    await app.waitForSelector('.cm-content', 20000);
    expect(
      await app.evaluate<string>(`document.querySelector('.nexus-filename')?.textContent ?? ''`)
    ).toBe('a.md');
    expect(
      await app.evaluate<boolean>(`document.querySelector('.nexus-main-content .nexus-graph') === null`)
    ).toBe(true);

    // 侧栏跟着回到文件树：hidden 类摘掉、宽度类还回来、灯亮在工作区图标上。
    // 宽度同样是过渡回来的，等它落定（判据用「够宽」而不是「> 0」，
    // 否则动画刚起步的那一刻也算过）
    await app.waitForFunction(
      `document.querySelector('.nexus-activity-panel')?.getBoundingClientRect().width > 100`,
      5000
    );
    expect(
      await app.evaluate<boolean>(
        `(() => {
           const panel = document.querySelector('.nexus-activity-panel');
           const slot = document.querySelector('.nexus-activity-panel .nexus-workspace-sidebar')
             ?.closest('.nexus-panel-slot');
           return slot !== null &&
             !slot.classList.contains('nexus-panel-slot-hidden') &&
             getComputedStyle(slot).display !== 'none' &&
             panel.classList.contains('nexus-activity-panel-open') &&
             document.querySelector('.nexus-activity-icon[data-activity="workspace"]')
               ?.getAttribute('aria-pressed') === 'true';
         })()`
      )
    ).toBe(true);
  }, INDEXED_TEST_TIMEOUT_MS);
});
