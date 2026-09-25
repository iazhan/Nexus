// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { launchElectronApp, type ElectronAppInstance } from './smoke-harness.js';

/**
 * 插件面板。
 *
 * 它显示的重点是 `idle`（已注册但文档里从没出现过触发语法、扩展包一个字节都没下载）
 * 与 `loaded` 的对比 —— 这是「按内容懒加载」在 UI 上的证据。
 * 状态推导本身的 7 条单测在 `packages/editor/test/extension-status.test.ts`。
 */
describe('插件面板', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-plugins-'));
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });
    // 刻意不放公式与 mermaid：两个扩展都该停留在「未加载」
    fs.writeFileSync(path.join(workspace, 'plain.md'), '# 纯文本\n\n没有公式也没有图表。\n', 'utf-8');
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

  it('列出已注册的扩展，纯文本文档下都停留在未加载', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForSelector('.nexus-activity-bar', 20000);

    await app.click('.nexus-activity-icon[data-activity="extensions"]');
    await app.waitForSelector('.nexus-plugin-row', 10000);

    const names = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.nexus-plugin-name')).map((el) => el.textContent)`
    );
    expect(names).toContain('nexus-math');
    expect(names).toContain('nexus-mermaid');

    // 纯文本文档：两个扩展都没被触发，都显示「未加载」
    const idleCount = await app.evaluate<number>(
      `document.querySelectorAll('.nexus-plugin-state-idle').length`
    );
    expect(idleCount).toBe(2);

    // 没有任何扩展处于已加载 / 失败态
    expect(
      await app.evaluate<number>(
        `document.querySelectorAll('.nexus-plugin-state-loaded, .nexus-plugin-state-failed').length`
      )
    ).toBe(0);
  }, 45000);
});
