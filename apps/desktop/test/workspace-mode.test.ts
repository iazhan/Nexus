// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  type ElectronAppInstance
} from './smoke-harness.js';
import { RECENT_WORKSPACE_FILE } from '../electron/recent-workspace.js';

/**
 * workspace 模式的启动契约（P2-01）。
 *
 * 目录参数以前会被判成「不支持的文件」：`nexus.exe "D:\Notes"` 显示「只支持 Markdown 文档」。
 * 现在 main 进程用 fs.statSync 判定目录，parser 返回 mode: 'workspace' + workspaceRoot。
 *
 * 文件树与索引还没接入，所以这一条只验证「目录被正确识别」，以及**没有**被伪装成空编辑器 ——
 * 后者才是真风险：workspace 模式下渲染一个空白 `.cm-content`，用户会以为工作区里的文件是空的。
 */
describe('workspace 模式启动', () => {
  let tempDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-workspace-');
    fs.writeFileSync(path.join(tempDir, 'note.md'), '# 笔记\n\n正文。\n', 'utf-8');
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

  it('以目录为参数启动时进入 workspace 模式，且不伪造空编辑器', async () => {
    activeApp = await launchElectronApp({ filePath: tempDir });
    const app = activeApp;

    await app.waitForSelector('.nexus-workspace-empty', 20000);

    const shownPath = await app.evaluate<string>(
      `document.querySelector('.nexus-workspace-empty-path')?.textContent ?? ''`
    );
    expect(shownPath).toBe(tempDir);

    // 关键负向断言：不能同时渲染编辑器。
    const editorCount = await app.evaluate<number>(
      `document.querySelectorAll('.cm-content').length`
    );
    expect(editorCount).toBe(0);

    // 顶栏显示工作区目录名，而不是 Untitled.md
    const headerName = await app.evaluate<string>(
      `document.querySelector('.nexus-filename')?.textContent ?? ''`
    );
    expect(headerName).toBe(path.basename(tempDir));

    // 状态栏格式指标从 Markdown 切到 Workspace
    const format = await app.evaluate<string>(
      `document.querySelector('.status-format')?.textContent?.trim() ?? ''`
    );
    expect(format).toBe('Workspace');
  });

  it('路径不存在时仍按不支持处理，不会进入 workspace', async () => {
    // 打错一个字不该从「文件不存在」变成「打开一个空工作区」——
    // 那会把真实错误吞掉。main 的 classifyLaunchPath 对 stat 失败返回 'unknown'。
    const missing = path.join(tempDir, 'does-not-exist');

    activeApp = await launchElectronApp({ filePath: missing });
    const app = activeApp;

    await app.waitForSelector('.nexus-error-card', 20000);

    const workspaceCount = await app.evaluate<number>(
      `document.querySelectorAll('.nexus-workspace-empty').length`
    );
    expect(workspaceCount).toBe(0);
  });

  /**
   * **裸启动**（双击桌面图标）＝ 一个参数都不带。
   *
   * 它以前落到一个没有路径的空编辑器上 —— 一个既不是文件、也不是工作区的中间态，
   * 而且用户在那里没有任何办法进到工作区（安装版没有目录选择器）。
   * 现在它是工作区模式 + 欢迎态。
   *
   * 这条用例用的 `userDataDir` 是 harness 每次新建的，所以「上次的工作区」一定不存在，
   * 走的就是「没东西可恢复」那一格。
   */
  it('不带任何参数启动时进入 workspace 模式并给欢迎态，而不是空编辑器', async () => {
    activeApp = await launchElectronApp();
    const app = activeApp;

    expect(await app.evaluate(`window.nexus.getLaunchContext()`)).toMatchObject({
      mode: 'workspace',
      filePath: null,
      workspaceRoot: null
    });

    await app.waitForSelector('.nexus-workspace-empty', 20000);

    // 判据取组件自己的锚点：`ViewerPlaceholder` 复用 `.nexus-workspace-empty` 那套类名，
    // 只按类名找会把两者混在一起。
    const openFolderCount = await app.evaluate<number>(
      `document.querySelectorAll('[data-workspace-empty] [data-workspace-open-folder]').length`
    );
    expect(openFolderCount).toBe(1);

    // 关键负向断言：不能同时渲染编辑器。
    const editorCount = await app.evaluate<number>(
      `document.querySelectorAll('.cm-content').length`
    );
    expect(editorCount).toBe(0);

    // 还没有目录 ⇒ 活动栏与文件树都不该出现（它们的前提是有工作区根）。
    const activityBarCount = await app.evaluate<number>(
      `document.querySelectorAll('.nexus-activity-bar').length`
    );
    expect(activityBarCount).toBe(0);
  });

  /**
   * 欢迎态里「打开文件夹」那条链的**主进程那一半**：桥 → 授权 → 记回落目标。
   *
   * 真机用例**点不到**那个按钮 —— 它弹的是原生目录选择框，CDP 进不去。而直接从桥上调
   * `openWorkspace` 只会走主进程，**不会**让渲染进程切状态（切换发生在
   * `App.handleOpenWorkspace` 里，那是按钮与菜单项共用的那一层）。所以两半分开测：
   *
   *   - 主进程那一半在这里（授权 + 落盘）；
   *   - 渲染进程那一半（点按钮 → `setWorkspaceRoot` → 外壳挂起来）在
   *     `apps/desktop/renderer/test/open-workspace-app.test.tsx` 里，用 happy-dom 渲染整个 App 盖。
   *
   * 落盘那一份 `recent-workspace.json` 是这条用例独有的价值：主进程在这里是**重新读**磁盘
   * 那份再合并写入的，不是拿启动时那份快照（否则会把本次会话里已经改过的开关覆盖回去）——
   * 这条路径别处都验不到。
   */
  it('从桥上调 openWorkspace：授权该目录、能读它下面的文件、并记成下次的回落目标', async () => {
    activeApp = await launchElectronApp();
    const app = activeApp;

    const picked = path.join(tempDir, 'picked');
    const note = path.join(picked, 'note.md');
    fs.mkdirSync(picked, { recursive: true });
    fs.writeFileSync(note, '# 笔记\n\n正文。\n', 'utf-8');

    await app.waitForSelector('[data-workspace-open-folder]', 20000);

    const returned = await app.evaluate<string | null>(
      `window.nexus.openWorkspace(${JSON.stringify(picked)})`
    );
    expect(returned).toBe(picked);

    // 授权真的生效了，而不是只回了个字符串 —— 没授权的话这里会 OUT_OF_BOUNDS。
    const readBack = await app.evaluate<string | null>(
      `window.nexus.readFile(${JSON.stringify(note)})`
    );
    expect(readBack).toBe('# 笔记\n\n正文。\n');

    const recorded = JSON.parse(
      fs.readFileSync(path.join(app.userDataDir, RECENT_WORKSPACE_FILE), 'utf8')
    ) as { workspaceRoot?: unknown; restoreLastWorkspace?: unknown };
    expect(recorded.workspaceRoot).toBe(picked);
    // 写这一份时不能把已经落盘的开关冲掉。
    expect(recorded.restoreLastWorkspace).toBe(true);
  });
});
