// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  ensureSurface,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * 「打开 Markdown 时的模式」的**真行为**，重点是**跨启动**。
 *
 * 初始面在 App 装载时解析一次（`resolveEditorSurface(openMode, remembered)`），
 * 之后只随用户切换写记忆，不受设置项变动影响 —— 所以「换了设置要不要等重启才生效」
 * 只有关一次窗口、再开一次才说得清。happy-dom 那层
 * （`renderer/test/editor-open-mode.test.ts`）证的是纯函数与 store 接线。
 *
 * 三档各有一条：
 * - 默认「始终富文本」；
 * - 「始终源码」改完跨启动仍生效；
 * - 「记住上次模式」按**上一次真的停在哪个面**决定，而不是按默认值作弊。
 */
describe('打开 Markdown 时的模式', () => {
  let tempDir: string;
  let docPath: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-open-mode-');
    docPath = path.join(tempDir, 'doc.md');
    fs.writeFileSync(docPath, '# 标题\n\n正文。\n', 'utf-8');
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

  /** 每条用例一份独立 userDataDir：设置与「上次模式」都躺在它的 localStorage 里。 */
  let caseIndex = 0;
  const nextUserDataDir = () => path.join(tempDir, `userdata-${caseIndex++}`);

  const surfaceKind = (app: ElectronAppInstance) =>
    app.evaluate<string | null>(
      `document.querySelector('[data-surface-kind]')?.getAttribute('data-surface-kind') ?? null`
    );

  it('默认富文本；改成「始终源码」后跨启动仍生效', async () => {
    const userDataDir = nextUserDataDir();

    activeApp = await launchElectronApp({ filePath: docPath, userDataDir });
    await activeApp.waitForSelector('[data-surface-kind]', 20000);
    expect(await surfaceKind(activeApp)).toBe('visual');

    await activeApp.evaluate(`window.nexusSettings.set('editor.openMode', 'source')`);
    // 必须优雅关闭：`close()` 是 SIGTERM，Chromium 不会把 localStorage 的
    // leveldb 提交掉 —— 同一个进程里读得回来（走内存），下一次启动读是空的，
    // 表现成「设置没生效」而其实是「没刷盘」。见 `closeGracefully` 的头注释。
    await activeApp.closeGracefully();
    activeApp = null;

    activeApp = await launchElectronApp({ filePath: docPath, userDataDir });
    await activeApp.waitForSelector('[data-surface-kind]', 20000);
    expect(await surfaceKind(activeApp)).toBe('source');
  }, 120000);

  it('「记住上次模式」按上次真的停在哪个面来，而不是回落默认值', async () => {
    const userDataDir = nextUserDataDir();

    activeApp = await launchElectronApp({
      filePath: docPath,
      userDataDir
    });
    await activeApp.waitForSelector('[data-surface-kind]', 20000);
    await activeApp.evaluate(`window.nexusSettings.set('editor.openMode', 'remember')`);
    // 此刻停在富文本（默认值），切到源码会写下「上次是源码」
    await ensureSurface(activeApp, 'source');
    expect(await surfaceKind(activeApp)).toBe('source');
    await activeApp.closeGracefully();
    activeApp = null;

    // 上一次停在源码，而默认值是富文本 —— 落到源码才说明真的读了记忆
    activeApp = await launchElectronApp({ filePath: docPath, userDataDir });
    await activeApp.waitForSelector('[data-surface-kind]', 20000);
    expect(await surfaceKind(activeApp)).toBe('source');

    // 反方向也成立：这次停在富文本，下次就该是富文本
    await ensureSurface(activeApp, 'visual');
    await activeApp.closeGracefully();
    activeApp = null;

    activeApp = await launchElectronApp({ filePath: docPath, userDataDir });
    await activeApp.waitForSelector('[data-surface-kind]', 20000);
    expect(await surfaceKind(activeApp)).toBe('visual');
  }, 150000);

  it('「始终富文本」压过记忆：上次停在源码也照样开富文本', async () => {
    const userDataDir = nextUserDataDir();

    activeApp = await launchElectronApp({ filePath: docPath, userDataDir });
    await activeApp.waitForSelector('[data-surface-kind]', 20000);
    // 先让记忆变成「源码」
    await ensureSurface(activeApp, 'source');
    await activeApp.evaluate(`window.nexusSettings.set('editor.openMode', 'visual')`);
    await activeApp.closeGracefully();
    activeApp = null;

    activeApp = await launchElectronApp({ filePath: docPath, userDataDir });
    await activeApp.waitForSelector('[data-surface-kind]', 20000);
    expect(await surfaceKind(activeApp)).toBe('visual');
  }, 120000);
});
