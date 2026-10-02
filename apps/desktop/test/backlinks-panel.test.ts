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

const openFileByName = (app: ElectronAppInstance, name: string) =>
  app.evaluate(`(() => {
    const files = Array.from(document.querySelectorAll('.nexus-tree-file'));
    const target = files.find((el) => el.textContent?.includes(${JSON.stringify(name)}));
    if (!target) return false;
    target.click();
    return true;
  })()`);

/**
 * 反向链接与未链接提及 —— 面板底部的两节。
 *
 * 出链由索引器在写库时收集（`links` 表），所以反向链接反映的是**磁盘上的内容**，
 * 不是编辑器里正在写的草稿。查询规则本身的单测在 `test/backlinks.test.ts`；
 * 提及的匹配规则在 `packages/core/test/mentions.test.ts`，扫描在 `test/mentions.test.ts`。
 * 这里只验它们接进面板之后的样子。
 */
describe('反向链接', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-backlink-e2e-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });

    // index.md 链接到 dma；dma 没有任何出链
    fs.writeFileSync(
      path.join(workspace, 'index.md'),
      '# 索引\n\n参见 [[dma]] 那一篇。\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(workspace, 'notes', 'dma.md'),
      '# DMA\n\n控制器支持多通道传输。\n',
      'utf-8'
    );
    // 提到了 dma 却没写成链接 —— 这一节要抓的就是它
    fs.writeFileSync(
      path.join(workspace, 'draft.md'),
      '# 草稿\n\n之后要补 dma 的说明。\n',
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

  it('列出链接到当前文档的文档，点击可打开', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    // 等索引建好 —— 反向链接依赖它
    await app.waitForIndexReady();

    // 打开**被链接**的那篇（dma）
    expect(await openFileByName(app, 'dma')).toBe(true);
    await app.waitForSelector('.cm-content', 20000);

    // 反向链接在大纲面板下方
    await app.click('.nexus-activity-icon[data-activity="outline"]');
    await app.waitForSelector('.nexus-backlink-item', 20000);

    const items = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.nexus-backlink-item')).map((el) => el.textContent)`
    );
    expect(items).toEqual(['index.md']);

    /*
      未链接提及：`draft.md` 正文里写了 `dma` 但没写成链接。
      **必须在点反向链接之前断言** —— 那一下会把活动文档换成 index.md，
      面板随之重查，这一节的内容就变了。
    */
    await app.waitForSelector('.nexus-mention-item', 20000);
    const mentions = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.nexus-mention-item')).map((el) => el.textContent)`
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toContain('draft.md');
    // 摘录是这一节的全部价值：没有它用户得逐篇打开才知道提的是不是这一篇
    expect(mentions[0]).toContain('之后要补 dma 的说明。');

    // 点反向链接 → 打开链接源文档
    await app.click('.nexus-backlink-item');
    await app.waitForFunction(
      `window.nexusSession.getSnapshot().source.includes('参见')`,
      15000
    );

    expect(
      await app.evaluate<string>(`document.querySelector('.nexus-filename')?.textContent ?? ''`)
    ).toBe('index.md');
  }, INDEXED_TEST_TIMEOUT_MS);
});
