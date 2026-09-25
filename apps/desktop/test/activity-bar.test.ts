// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { launchElectronApp, type ElectronAppInstance } from './smoke-harness.js';

/** 面板当前宽度（收起时是 0）。 */
const panelWidth = (app: ElectronAppInstance) =>
  app.evaluate<number>(
    `Math.round(document.querySelector('.nexus-activity-panel')?.getBoundingClientRect().width ?? -1)`
  );

/** 当前高亮的图标 id。 */
const activeIcon = (app: ElectronAppInstance) =>
  app.evaluate<string>(
    `document.querySelector('.nexus-activity-icon-active')?.getAttribute('data-activity') ?? '(无)'`
  );

/**
 * 活动栏（VSCode 式侧栏）的交互。
 *
 * 状态层自己的 8 条用例在 `renderer/test/activity-bar-state.test.ts`，这里验证它
 * 接进 App 之后的行为：展开、再点收起、点别的切换，以及「收起后图标仍高亮」。
 */
describe('活动栏与侧栏面板', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-activity-'));
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'a.md'), '# A\n\n正文。\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'b.md'), '# B\n\n第二篇。\n', 'utf-8');
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

  // 超时放宽到 45s：这个用例跑完整交互链（4 次图标点击 + Ctrl+N + 几何测量），
  // 再加上 Electron 冷启动，30s 的默认上限不够。
  it('展开、再点收起、点别的切换，且收起后图标仍高亮', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForSelector('.nexus-activity-bar', 20000);

    // 四个文档级入口 + 底部的设置
    const icons = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.nexus-activity-icon')).map((el) => el.getAttribute('data-activity'))`
    );
    expect(icons).toEqual(['workspace', 'outline', 'search', 'extensions', 'settings']);

    // 初始状态自洽：图标选中的同时面板就是打开的
    // （早先是「图标亮着、面板关着」，视觉上自相矛盾）
    expect(await panelWidth(app)).toBe(240);
    expect(await activeIcon(app)).toBe('workspace');

    // 点同一个图标 → 收起。收起后宽度留 1px 是刻意的：面板右边框常驻（透明），
    // 在有/无之间切会让收起动画的最后一帧跳一下。
    await app.click('.nexus-activity-icon[data-activity="workspace"]');
    await app.waitForFunction(
      `Math.round(document.querySelector('.nexus-activity-panel').getBoundingClientRect().width) <= 1`,
      5000
    );
    // 收起后图标仍高亮，表示「上次看的是这个」
    expect(await activeIcon(app)).toBe('workspace');

    // 再点一次 → 重新展开
    await app.click('.nexus-activity-icon[data-activity="workspace"]');
    await app.waitForFunction(
      `Math.round(document.querySelector('.nexus-activity-panel').getBoundingClientRect().width) === 240`,
      5000
    );

    // 点搜索 → 切换过去（面板重新展开，高亮换人）
    await app.click('.nexus-activity-icon[data-activity="search"]');
    await app.waitForFunction(
      `Math.round(document.querySelector('.nexus-activity-panel').getBoundingClientRect().width) === 240`,
      5000
    );
    expect(await activeIcon(app)).toBe('search');

    // 同时只有一个面板槽可见
    const visibleSlots = await app.evaluate<number>(
      `Array.from(document.querySelectorAll('.nexus-panel-slot')).filter((el) => el.offsetParent !== null).length`
    );
    expect(visibleSlots).toBe(1);

    // 从搜索切回工作区：面板始终是展开的，不经过「关→开」
    await app.click('.nexus-activity-icon[data-activity="workspace"]');
    await app.waitForFunction(
      `Math.round(document.querySelector('.nexus-activity-panel').getBoundingClientRect().width) === 240`,
      5000
    );
    expect(await activeIcon(app)).toBe('workspace');

    // 标签栏的容器范围：只横跨编辑区，不延伸到活动栏和侧栏上方。
    // 单文档时标签栏不渲染，所以先从侧栏打开第二个文件（比按 Ctrl+N 稳 ——
    // 快捷键依赖窗口焦点，而点击不依赖）。
    await app.waitForSelector('.nexus-tree-file', 60000);
    await app.click('.nexus-tree-file');
    await app.waitForSelector('.cm-content', 20000);
    await app.evaluate(`document.querySelectorAll('.nexus-tree-file')[1].click(), true`);
    await app.waitForSelector('.nexus-tab-bar', 15000);

    const geometry = await app.evaluate<{
      barLeft: number;
      barWidth: number;
      mainLeft: number;
      mainWidth: number;
      panelRight: number;
    }>(`(() => {
      const bar = document.querySelector('.nexus-tab-bar').getBoundingClientRect();
      const main = document.querySelector('.nexus-main-content').getBoundingClientRect();
      const panel = document.querySelector('.nexus-activity-panel').getBoundingClientRect();
      return {
        barLeft: Math.round(bar.left),
        barWidth: Math.round(bar.width),
        mainLeft: Math.round(main.left),
        mainWidth: Math.round(main.width),
        panelRight: Math.round(panel.right)
      };
    })()`);

    // 与编辑区左边界对齐，且完全在侧栏右侧
    expect(geometry.barLeft).toBe(geometry.mainLeft);
    expect(geometry.barLeft).toBeGreaterThanOrEqual(geometry.panelRight);
    // 宽度与编辑区一致（不是整个窗口宽度）
    expect(geometry.barWidth).toBe(geometry.mainWidth);
  }, 90000);
});
