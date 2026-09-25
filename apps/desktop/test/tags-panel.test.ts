// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  launchElectronApp,
  INDEXED_TEST_TIMEOUT_MS,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * 标签面板。
 *
 * 标签来自索引（磁盘内容），不是编辑器草稿。提取规则的 10 条单测和
 * 查询的 7 条单测在 `test/tags.test.ts`，这里验接进 App 之后的链路。
 */
describe('标签面板', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tags-e2e-'));
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });

    fs.writeFileSync(path.join(workspace, 'a.md'), '# A\n\n讲 #dma 和 #ethercat。\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'b.md'), '# B\n\n也讲 #dma。\n', 'utf-8');
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

  it('列出标签与文档数，展开后能看到文档并打开', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    // 等索引建好 —— 标签依赖它
    await app.waitForIndexReady();

    await app.click('.nexus-activity-icon[data-activity="tags"]');

    // 先看 IPC 层拿到了什么 —— 区分「索引里没标签」和「面板没渲染」
    const tagsFromIpc = await app.evaluate<string>(
      `window.nexus.listTags().then((tags) => JSON.stringify(tags))`
    );

    try {
      await app.waitForSelector('.nexus-tag-item', 20000);
    } catch (err) {
      const panelDump = await app.evaluate<string>(
        `document.querySelector('.nexus-tags')?.textContent ?? '(面板不存在)'`
      );
      throw new Error(
        `标签列表没渲染。IPC 返回: ${tagsFromIpc} / 面板内容: ${panelDump} / 原始错误: ${
          err instanceof Error ? err.message : err
        }`
      );
    }

    const rows = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.nexus-tag-item')).map((el) => el.textContent ?? '')`
    );
    // 按标签名排序：dma 在 ethercat 前
    expect(rows[0]).toContain('#dma');
    expect(rows[0]).toContain('2');
    expect(rows[1]).toContain('#ethercat');
    expect(rows[1]).toContain('1');

    // 点 #dma 展开它下面的文档
    await app.evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('.nexus-tag-item'));
      items.find((el) => el.textContent?.includes('dma'))?.click();
      return true;
    })()`);
    await app.waitForSelector('.nexus-tag-documents .nexus-backlink-item', 15000);

    const documents = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.nexus-tag-documents .nexus-backlink-item'))
         .map((el) => el.textContent)`
    );
    expect(documents).toEqual(['a.md', 'b.md']);

    // 点文档 → 打开
    await app.click('.nexus-tag-documents .nexus-backlink-item');
    await app.waitForSelector('.cm-content', 20000);

    expect(
      await app.evaluate<string>(`document.querySelector('.nexus-filename')?.textContent ?? ''`)
    ).toBe('a.md');
  }, INDEXED_TEST_TIMEOUT_MS);
});
