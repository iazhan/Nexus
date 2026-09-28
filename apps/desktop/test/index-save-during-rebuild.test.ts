// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createTempDir,
  launchElectronApp,
  type ElectronAppInstance
} from './smoke-harness.js';

describe('索引期间保存响应', () => {
  let activeApp: ElectronAppInstance | null = null;

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('工作区索引进行时，writeFile IPC 在两秒内完成', async () => {
    const workspace = createTempDir('nexus-index-save-');
    const notePath = path.join(workspace, 'note.md');
    fs.writeFileSync(notePath, '# 原文\n', 'utf-8');
    for (let index = 0; index < 618; index += 1) {
      fs.writeFileSync(path.join(workspace, `asset-${index}.png`), 'fixture');
    }

    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForSelector('.nexus-workspace-sidebar[data-phase="indexing"]', 20000);

    await app.evaluate(`(() => {
      const delayWrite = () => {
        window.__indexSaveProbe = { startedAt: performance.now(), state: 'pending' };
        window.nexus.writeFile(${JSON.stringify(notePath)}, '# 索引期间保存成功\\n').then(
          () => {
            window.__indexSaveProbe.state = 'saved';
            window.__indexSaveProbe.elapsedMs = performance.now() - window.__indexSaveProbe.startedAt;
          },
          (error) => {
            window.__indexSaveProbe.state = 'failed';
            window.__indexSaveProbe.error = String(error);
          }
        );
      };
      window.setTimeout(delayWrite, 250);
      return true;
    })()`);

    await app.waitForFunction(
      `() => window.__indexSaveProbe?.state === 'saved' || window.__indexSaveProbe?.state === 'failed'`,
      10000
    );
    const result = await app.evaluate<{ state: string; elapsedMs?: number; error?: string }>(
      'window.__indexSaveProbe'
    );

    expect(result.state, result.error).toBe('saved');
    expect(result.elapsedMs).toBeLessThan(2000);
    expect(fs.readFileSync(notePath, 'utf-8')).toBe('# 索引期间保存成功\n');
  }, 90000);
});
