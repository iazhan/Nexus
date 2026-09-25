// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { launchElectronApp, type ElectronAppInstance } from './smoke-harness.js';

const panelWidth = (app: ElectronAppInstance) =>
  app.evaluate<number>(
    `Math.round(document.querySelector('.nexus-activity-panel')?.getBoundingClientRect().width ?? -1)`
  );

const waitForWidth = (app: ElectronAppInstance, width: number) =>
  app.waitForFunction(
    `Math.round(document.querySelector('.nexus-activity-panel').getBoundingClientRect().width) === ${width}`,
    5000
  );

/**
 * 模拟一次完整拖拽。
 *
 * mousedown 落在把手上，mousemove / mouseup 派发到 **window** ——
 * 与实现一致（它监听的是 window，这样鼠标移出那 4px 把手也不会断）。
 */
const dragHandle = (app: ElectronAppInstance, deltaX: number) =>
  app.evaluate(`(() => {
    const handle = document.querySelector('.nexus-panel-resizer');
    const rect = handle.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const startY = rect.top + 20;

    handle.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, clientX: startX, clientY: startY
    }));
    window.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: startX + (${deltaX}), clientY: startY
    }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  })()`);

const doubleClickHandle = (app: ElectronAppInstance) =>
  app.evaluate(`(() => {
    document.querySelector('.nexus-panel-resizer')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);

/**
 * 侧栏宽度拖拽。
 *
 * 纯函数 `clampPanelWidth` 的 8 条单测在 `renderer/test/panel-width.test.ts`，
 * 这里验的是它接进 App 之后真的生效：拖得动、夹得住、双击能复位。
 */
describe('侧栏宽度拖拽', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-resize-'));
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'a.md'), '# A\n\n正文。\n', 'utf-8');
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

  it('拖拽调整宽度、夹在合法范围内、双击恢复默认', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForSelector('.nexus-panel-resizer', 20000);

    // 默认 240
    expect(await panelWidth(app)).toBe(240);

    // 往右拖 80 → 320
    await dragHandle(app, 80);
    await waitForWidth(app, 320);

    // 往左拖 1000 → 夹到下限 160，而不是变成负数
    await dragHandle(app, -1000);
    await waitForWidth(app, 160);

    // 双击把手 → 恢复默认 240
    await doubleClickHandle(app);
    await waitForWidth(app, 240);
  }, 45000);
});
