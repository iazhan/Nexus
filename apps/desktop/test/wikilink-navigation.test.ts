// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { launchElectronApp, type ElectronAppInstance } from './smoke-harness.js';

/** Ctrl+左键点击某个元素 —— 与编辑器包里的导航手势一致。 */
const ctrlClick = (app: ElectronAppInstance, selector: string) =>
  app.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, ctrlKey: true,
      clientX: rect.left + 2, clientY: rect.top + 2
    }));
    return true;
  })()`);

/** Mod+M 切换 surface（Source ⇄ Visual）。 */
const pressModM = (app: ElectronAppInstance) =>
  app.evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'm', ctrlKey: true, bubbles: true, cancelable: true
    }));
    return true;
  })()`);

/**
 * WikiLink 点击跳转。
 *
 * 分层：编辑器只把 `[[...]]` 里的**目标名**递出来，解析成哪篇文档是宿主的策略
 * （宿主才有工作区索引）。解析规则本身的 10 条单测在 `renderer/test/wikilink.test.ts`。
 */
describe('WikiLink 跳转', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-wikilink-'));
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });

    // 入口文档里放一个指向 dma 的 wikilink
    fs.writeFileSync(
      path.join(workspace, 'index.md'),
      '# 索引\n\n参见 [[dma]] 那一篇。\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(workspace, 'notes', 'dma.md'),
      '# DMA\n\n控制器支持多通道传输，注意缓存一致性。\n',
      'utf-8'
    );
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

  it('Ctrl+点击 wikilink 打开目标文档', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    // 等索引建好 —— 解析依赖它
    await app.waitForSelector('.nexus-tree-item', 60000);

    // 打开入口文档
    await app.evaluate(`(() => {
      const files = Array.from(document.querySelectorAll('.nexus-tree-file'));
      const entry = files.find((el) => el.textContent?.includes('index'));
      entry?.click();
      return true;
    })()`);
    await app.waitForSelector('.cm-content', 20000);

    // wikilink 只在 **Visual** 模式下渲染成 widget。默认 surface 不确定，
    // 所以先看有没有；没有才切一次，避免把已经是 Visual 的状态又切回 Source。
    const alreadyVisual = await app.evaluate<boolean>(
      `document.querySelectorAll('.cm-visual-wikilink').length > 0`
    );
    if (!alreadyVisual) await pressModM(app);

    await app.waitForSelector('.cm-visual-wikilink', 15000);

    expect(await ctrlClick(app, '.cm-visual-wikilink')).toBe(true);

    // 跳转完成：当前文档换成了目标那篇
    await app.waitForFunction(
      `window.nexusSession.getSnapshot().source.includes('缓存一致性')`,
      15000
    );

    expect(
      await app.evaluate<string>(`document.querySelector('.nexus-filename')?.textContent ?? ''`)
    ).toBe('dma.md');
  }, 90000);
});
