// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createTempDir,
  launchElectronApp,
  readFileTolerant,
  type ElectronAppInstance
} from './smoke-harness.js';

describe('索引期间保存不产生外部修改冲突', () => {
  let activeApp: ElectronAppInstance | null = null;

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('打开的 Markdown 在重建索引时保存后仍保持无冲突', async () => {
    const workspace = createTempDir('nexus-index-save-conflict-');
    const notePath = path.join(workspace, 'a-note.md');
    fs.writeFileSync(notePath, '# 保存测试\n\n原始内容。\n', 'utf-8');
    for (let index = 0; index < 618; index += 1) {
      fs.writeFileSync(path.join(workspace, `z-${index}.md`), `# 文档 ${index}\n\n内容。\n`);
    }

    activeApp = await launchElectronApp({ filePath: workspace });
    await activeApp.waitForFunction(
      `document.querySelector('.nexus-workspace-sidebar')?.dataset.phase === 'ready'`,
      20_000
    );
    await activeApp.click('.nexus-tree-file');
    await activeApp.waitForSelector('.cm-content', 10_000);
    await activeApp.evaluate(`window.nexusActiveView.focus()`);

    await activeApp.evaluate(`(() => {
      window.__indexRebuildResult = 'pending';
      window.nexus.rebuildIndex(${JSON.stringify(workspace)}).then(
        (result) => {
          window.__indexRebuildResult = JSON.stringify(result);
        },
        (error) => {
          window.__indexRebuildResult = 'error: ' + String(error);
        }
      );
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await activeApp.insertText('X');
    await activeApp.waitForFunction(
      `window.nexusSession.getSnapshot().source.includes('X')`,
      5000
    );
    await activeApp.pressKey('s', { ctrl: true });

    await activeApp.waitForFunction(
      `window.__indexRebuildResult !== 'pending' && window.nexusWorkspace.getDocuments()[0]?.saveState === 'saved'`,
      20_000
    );
    await new Promise((resolve) => setTimeout(resolve, 500));

    const rebuildResult = await activeApp.evaluate<string>('window.__indexRebuildResult');
    expect(readFileTolerant(notePath)).toContain('X');
    expect(rebuildResult).toContain('"scanned":619');
    expect(
      await activeApp.evaluate<boolean>(`Boolean(document.querySelector('.nexus-conflict-banner'))`)
    ).toBe(false);
  }, 90_000);
});
