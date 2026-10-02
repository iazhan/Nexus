// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * 窗口标题必须反映运行模式。
 *
 * 之前 `index.html` 的 `<title>` 写死「Nexus Lite」，而**页面的 `<title>` 会覆盖
 * `BrowserWindow` 的 title** —— 所以全量模式的窗口标题也一直挂着 Lite，
 * 只改主进程是没用的。
 */
describe('窗口标题', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-title-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'note.md'), '# 笔记\n\n内容。\n', 'utf-8');
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

  it('工作区模式下标题与顶栏都不带 Lite', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForSelector('.nexus-activity-bar', 20000);

    const title = await app.evaluate<string>(`document.title`);
    expect(title).not.toContain('Lite');
    expect(title).toContain('Nexus');

    expect(
      await app.evaluate<string>(`document.querySelector('.nexus-app-title')?.textContent ?? ''`)
    ).toBe('Nexus');
  }, 45000);

  it('轻量模式下标题与顶栏带 Lite', async () => {
    const docPath = path.join(tempDir, 'single.md');
    fs.writeFileSync(docPath, '# 单文件\n\n内容。\n', 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 20000);

    const title = await app.evaluate<string>(`document.title`);
    expect(title).toContain('Nexus Lite');

    expect(
      await app.evaluate<string>(`document.querySelector('.nexus-app-title')?.textContent ?? ''`)
    ).toBe('Nexus Lite');
  }, 45000);

  /**
   * 裸启动（双击图标）＝ 工作区模式、**还没有目录**。
   *
   * 这一格的工作区根是 `null`，所以「带不带 Lite」不能从它反推 —— 那会让欢迎态
   * 顶着「Nexus Lite」的标题，正好把用户期待看到的完全版说成轻量版。
   */
  it('裸启动（工作区模式、还没定目录）标题也不带 Lite', async () => {
    activeApp = await launchElectronApp();
    const app = activeApp;
    await app.waitForSelector('[data-workspace-open-folder]', 20000);

    const title = await app.evaluate<string>(`document.title`);
    expect(title).not.toContain('Lite');
    expect(title).toContain('Nexus');

    expect(
      await app.evaluate<string>(`document.querySelector('.nexus-app-title')?.textContent ?? ''`)
    ).toBe('Nexus');
  }, 45000);
});
