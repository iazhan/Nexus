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
 * 直接向 window 派发 keydown，而不是用 harness 的 pressKey ——
 * 后者依赖窗口真实聚焦，在无头/后台运行时不可靠（Ctrl+N 那条用例踩过）。
 */
const pressCtrlP = (app: ElectronAppInstance) =>
  app.evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p', ctrlKey: true, bubbles: true, cancelable: true
    }));
    return true;
  })()`);

/** React 受控输入要用原生 setter + input 事件。 */
const typeQuery = (app: ElectronAppInstance, value: string) =>
  app.evaluate(`(() => {
    const input = document.querySelector('.nexus-quickopen-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

const pressEnter = (app: ElectronAppInstance) =>
  app.evaluate(`(() => {
    document.querySelector('.nexus-quickopen-input')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);

/**
 * 快速打开（Ctrl+P）。
 *
 * 候选来自**索引**而不是已打开的标签页 —— 它存在的意义就是打开还没打开的文件。
 * 模糊匹配本身的 10 条单测在 `renderer/test/fuzzy.test.ts`，这里验接进 App 之后的链路。
 */
describe('快速打开', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-quickopen-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });

    fs.writeFileSync(
      path.join(workspace, 'notes', 'dma.md'),
      '# DMA\n\n控制器支持多通道传输，注意缓存一致性。\n',
      'utf-8'
    );
    fs.writeFileSync(path.join(workspace, 'ethercat.md'), '# EtherCAT\n\n从站与 PDO。\n', 'utf-8');
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

  it('Ctrl+P 打开、输入过滤、回车打开文件', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    // 先等索引建好（快速打开的候选来自索引）
    await app.waitForIndexReady();

    await pressCtrlP(app);
    await app.waitForSelector('.nexus-quickopen-input', 10000);

    // 输入前应列出全部候选
    expect(
      await app.evaluate<number>(`document.querySelectorAll('.nexus-quickopen-item').length`)
    ).toBe(2);

    await typeQuery(app, 'dma');
    await app.waitForFunction(
      `document.querySelectorAll('.nexus-quickopen-item').length === 1`,
      5000
    );
    expect(
      await app.evaluate<string>(`document.querySelector('.nexus-quickopen-name')?.textContent ?? ''`)
    ).toBe('dma.md');

    // 回车打开
    await pressEnter(app);
    await app.waitForSelector('.cm-content', 20000);

    expect(await app.evaluate<string>(`window.nexusSession.getSnapshot().source`)).toContain(
      '缓存一致性'
    );
    // 打开后浮层应当关闭
    expect(await app.evaluate<number>(`document.querySelectorAll('.nexus-quickopen').length`)).toBe(0);

    // 搜不到的词显示空态，而不是留着上一次的结果
    await pressCtrlP(app);
    await app.waitForSelector('.nexus-quickopen-input', 10000);
    await typeQuery(app, 'zzzzz');
    await app.waitForFunction(
      `document.querySelectorAll('.nexus-quickopen-item').length === 0`,
      5000
    );
  }, INDEXED_TEST_TIMEOUT_MS);
});
