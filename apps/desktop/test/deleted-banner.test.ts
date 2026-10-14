// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * 文档被外部删掉之后，横幅上有哪几条出路。
 *
 * 回归背景有两半：
 *
 * - **误报那一半**：自己保存自己也会弹这条横幅。原子写入是「旧文件改名做备份、
 *   临时文件改名就位」两步 rename，第二步带着目标文件名，旧 watcher 按事件类型
 *   转发，于是把它当成了「外部删除」（#2 里「拖动块的位置就弹数据丢失」的来历）。
 *   「不再误报」由 `file-service.test.ts` 与 `external-change-app.test.tsx` 钉死，
 *   这里只管**真的被删了之后**的用户路径。
 * - **出路那一半**：横幅上原来只有「另存为」一个按钮。文档还在缓冲区里，
 *   「重新读取」与「写回原位置」都是现成能力，缺的只是把按钮摆出来。
 */
describe('文档被外部删除后的横幅', () => {
  const tempDir = createTempDir('nexus-deleted-banner-');
  let activeApp: ElectronAppInstance | null = null;

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('三条出路都在，「写回原位置」把文件按缓冲区重建出来', async () => {
    const docPath = path.join(tempDir, 'gone.md');
    const body = '# 会被删掉\n\n正文一段。\n';
    fs.writeFileSync(docPath, body, 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 20000);
    // 等一轮保存落地再删：删文件撞上自动保存的原子替换，等到的会是 `changed`
    await app.waitForFunction(
      `() => document.querySelector('.status-text')?.textContent?.includes('Saved')`,
      15000
    );

    fs.unlinkSync(docPath);
    await app.waitForSelector('.nexus-conflict-banner', 15000);

    // 三条出路一个都不少（此前只有「另存为」）
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-banner-reread-btn')`)).toBe(
      true
    );
    expect(
      await app.evaluate<boolean>(`!!document.querySelector('.nexus-banner-writeback-btn')`)
    ).toBe(true);
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-banner-saveas-btn')`)).toBe(
      true
    );

    // 「重新读取」此刻读不到东西：文件确实不在，横幅必须留着 ——
    // 不能默默清掉，那会让用户以为没事了，而盘上什么都没有。
    await app.click('.nexus-banner-reread-btn');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-conflict-banner')`)).toBe(
      true
    );
    expect(fs.existsSync(docPath)).toBe(false);

    // 「写回原位置」：按缓冲区把文件重建出来，横幅收起
    await app.click('.nexus-banner-writeback-btn');
    // 等**文件回到盘上**，不是等横幅消失 —— 横幅在保存一开始（`saving`）就收了，
    // 那会儿字节还没落盘。
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !fs.existsSync(docPath)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(fs.existsSync(docPath)).toBe(true);
    expect(fs.readFileSync(docPath, 'utf-8')).toBe(body);
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-conflict-banner')`)).toBe(
      false
    );
  }, 90000);
});
