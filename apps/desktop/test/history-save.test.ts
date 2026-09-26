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

/** 轮询到条件成立；返回是否成立（不用断言，调用方决定怎么报）。 */
async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return check();
}

/**
 * 保存时留版本历史（端到端）。
 *
 * 存储层本身的 11 条单测在 `history-store.test.ts`；这里验的是**接线**：
 * 保存流程真的在覆盖前把旧内容交给了 `HistoryStore`。
 *
 * 断言里查的是**磁盘上的历史目录**而不是 IPC 返回 —— 这条链路的价值就在于
 * 「关掉应用之后那些内容还在」，只查内存状态证明不了这一点。
 */
describe('保存时留版本历史', () => {
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    workspace = createTempDir('nexus-history-save-');
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('覆盖保存前，旧内容进了历史目录', async () => {
    const documentPath = path.join(workspace, 'note.md');
    fs.writeFileSync(documentPath, '# 原内容\n', 'utf8');

    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForIndexReady();

    // 打开 note.md
    await app.evaluate(`(() => {
      const files = Array.from(document.querySelectorAll('.nexus-tree-file'));
      files.find((el) => el.textContent?.includes('note'))?.click();
      return true;
    })()`);
    await app.waitForSelector('.cm-content', 20000);

    // 改成新内容 —— 编辑器会自动保存（防抖）
    await app.setSource('# 新内容\n');

    const saved = await waitUntil(
      () => fs.readFileSync(documentPath, 'utf8') === '# 新内容\n',
      15000
    );
    expect(saved, '自动保存应当把新内容写进磁盘').toBe(true);

    // 关键断言：旧内容留在了历史目录里
    const historyDirectory = path.join(workspace, '.nexus', 'history', 'note.md');
    const appeared = await waitUntil(() => fs.existsSync(historyDirectory), 10000);
    expect(appeared, `历史目录应当出现: ${historyDirectory}`).toBe(true);

    const entries = fs.readdirSync(historyDirectory);
    expect(entries).toHaveLength(1);
    expect(fs.readFileSync(path.join(historyDirectory, entries[0]!), 'utf8')).toBe('# 原内容\n');
  }, INDEXED_TEST_TIMEOUT_MS);

  it('内容没变时不留新快照', async () => {
    const documentPath = path.join(workspace, 'stable.md');
    fs.writeFileSync(documentPath, '# 稳定\n', 'utf8');

    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForIndexReady();

    await app.evaluate(`(() => {
      const files = Array.from(document.querySelectorAll('.nexus-tree-file'));
      files.find((el) => el.textContent?.includes('stable'))?.click();
      return true;
    })()`);
    await app.waitForSelector('.cm-content', 20000);

    // 写入与磁盘完全相同的内容：不该产生任何快照
    await app.setSource('# 稳定\n');
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const historyDirectory = path.join(workspace, '.nexus', 'history', 'stable.md');
    expect(fs.existsSync(historyDirectory)).toBe(false);
  }, INDEXED_TEST_TIMEOUT_MS);

  it('恢复历史版本，且恢复本身可逆', async () => {
    const documentPath = path.join(workspace, 'restore.md');
    fs.writeFileSync(documentPath, '# 版本一\n', 'utf8');

    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForIndexReady();

    await app.evaluate(`(() => {
      const files = Array.from(document.querySelectorAll('.nexus-tree-file'));
      files.find((el) => el.textContent?.includes('restore'))?.click();
      return true;
    })()`);
    await app.waitForSelector('.cm-content', 20000);

    // 改成版本二 → 版本一进历史
    await app.setSource('# 版本二\n');
    const saved = await waitUntil(
      () => fs.readFileSync(documentPath, 'utf8') === '# 版本二\n',
      15000
    );
    expect(saved, '自动保存应当写进磁盘').toBe(true);

    const entries = await app.evaluate<Array<{ savedAt: string; hash: string }>>(
      `window.nexus.listHistory(${JSON.stringify(documentPath)})`
    );
    expect(entries).toHaveLength(1);

    // 恢复到版本一
    await app.evaluate(
      `window.nexus.restoreHistory(${JSON.stringify(documentPath)}, ${JSON.stringify(entries[0])})`
    );

    const restored = await waitUntil(
      () => fs.readFileSync(documentPath, 'utf8') === '# 版本一\n',
      10000
    );
    expect(restored, '恢复应当把旧版本写回磁盘').toBe(true);

    // **关键**：恢复前的内容也进了历史，所以这一步是可逆的。
    // 少了这个，用户恢复错版本就永久丢掉了恢复前的内容。
    const afterRestore = await app.evaluate<Array<{ savedAt: string; hash: string }>>(
      `window.nexus.listHistory(${JSON.stringify(documentPath)})`
    );
    expect(afterRestore).toHaveLength(2);
  }, INDEXED_TEST_TIMEOUT_MS);
});
