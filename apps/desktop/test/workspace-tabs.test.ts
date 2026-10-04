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
 * 多标签页（P2-04）。
 *
 * 状态层自己的 16 条用例在 renderer project（`renderer/test/workspace-store.test.ts`），
 * 这里只验证它接进 App 之后的行为：Ctrl+N 开出第二个标签页、切换时内容互不串台。
 *
 * 「互不串台」才是这一条的重点 —— 单文档改多文档最典型的回归就是编辑写错文档。
 */
describe('工作区多标签页', () => {
  let tempDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-tabs-');
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

  it('新建文档开出第二个标签页，切换时内容互不串台', async () => {
    const firstPath = path.join(tempDir, 'first.md');
    fs.writeFileSync(firstPath, '# first\n\n第一个文档。\n', 'utf-8');

    activeApp = await launchElectronApp({ filePath: firstPath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 20000);

    // 标签栏**常驻**：一个文档时就已经在，而且那一条就是当前文档。
    // （2026-10-04 之前是「只有一个文档就不渲染」，判据在这里反过来。）
    await app.waitForSelector('.nexus-tab-bar', 10000);
    expect(await app.evaluate<number>(`document.querySelectorAll('.nexus-tab').length`)).toBe(1);
    expect(
      await app.evaluate<string>(
        `document.querySelector('.nexus-tab-active')?.getAttribute('title') ?? ''`
      )
    ).toContain('first.md');

    await app.pressKey('n', { ctrl: true });
    await app.waitForFunction(`document.querySelectorAll('.nexus-tab').length === 2`, 10000);

    // 第二个文档是空白的，且当前活动的就是它
    expect(await app.evaluate<string>(`window.nexusSession.getSnapshot().source`)).toBe('');

    // 切到新标签页后编辑器必须跟着换文档 —— view 与 session 都要是新的那个。
    expect(await app.evaluate<string>(`window.nexusActiveView.state.doc.toString()`)).toBe('');
    expect(await app.evaluate<string>(`window.nexusSession.getSnapshot().source`)).toBe('');

    // 在第二个文档里编辑。走 session.dispatch（与 desktop-smoke 第 7 条同一写法）：
    // 它不依赖窗口的系统焦点，而这里要验证的是「编辑写进了哪个 session」，不是输入链路。
    await app.evaluate(`(() => {
      window.nexusSession.dispatch({ changes: [{ from: 0, to: 0, insert: '# second draft' }] });
      return true;
    })()`);
    await app.waitForFunction(
      `window.nexusSession.getSnapshot().source.includes('second draft')`,
      10000
    );

    // 切回第一个标签页：编辑器和 session 都必须跟着回来，且不能被刚才那次编辑污染。
    await app.click('.nexus-tab');
    await app.waitForFunction(
      `window.nexusSession.getSnapshot().source.includes('第一个文档')`,
      10000
    );
    const firstContent = await app.evaluate<string>(`window.nexusSession.getSnapshot().source`);
    expect(firstContent).toContain('# first');
    expect(firstContent).not.toContain('second draft');
    expect(await app.evaluate<string>(`window.nexusActiveView.state.doc.toString()`)).toContain(
      '# first'
    );

    // 再切回第二个：那次编辑必须还在 —— 说明它确实写进了第二个文档自己的 session
    await app.evaluate(`document.querySelectorAll('.nexus-tab')[1].click(), true`);
    await app.waitForFunction(
      `window.nexusSession.getSnapshot().source.includes('second draft')`,
      10000
    );
  });
});
