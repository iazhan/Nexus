// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  createTempDir,
  launchElectronApp,
  type ElectronAppInstance
} from './smoke-harness.js';
import { RECENT_WORKSPACE_FILE } from '../electron/recent-workspace.js';
import { indexPathForWorkspace } from '../electron/index-path.js';

/**
 * 「启动时恢复上次工作区」的**端到端**验证 —— 这一条是这一批里唯一验得到的那一格。
 *
 * 为什么必须两次启动：这一项的效果就是「上一次启动写了什么，下一次启动读到什么」。
 * 其它三层各自只盖住一半 —— 取值域（`recent-workspace.test.ts`）不知道主进程有没有把它接上，
 * 通道（`host-settings.test.ts`）不知道值有没有落盘，视图（`settings-view.test.tsx`）
 * 连存档都没出去。所以这个文件**独占一批**：一个文件两次启动，与别的文件合批会卡。
 *
 * 两次启动必须看**同一个 userData 目录** —— 所以这里给 `launchElectronApp` 传
 * `userDataDir`（harness 默认每次新建一个，是为了隔离；这里正好是那条默认的反面）。
 */
describe('启动时恢复上次工作区', () => {
  let tempDir: string;
  let vault: string;
  let userDataDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-recent-e2e-');
    vault = path.join(tempDir, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, 'note.md'), '# 笔记\n\n内容。\n', 'utf-8');
    userDataDir = createTempDir('nexus-userdata-shared-');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  /** 读主进程那份落盘。文件还没出现时返回 `null` —— 启动是异步的，要轮询。 */
  function readState(): { restoreLastWorkspace?: unknown; workspaceRoot?: unknown } | null {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(userDataDir, RECENT_WORKSPACE_FILE), 'utf8')
      ) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async function waitForState(
    predicate: (state: Record<string, unknown>) => boolean,
    timeoutMs = 15000
  ): Promise<Record<string, unknown>> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const state = readState();
      if (state && predicate(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`等待 recent-workspace.json 落盘超时，最后一份是 ${JSON.stringify(readState())}`);
  }

  it('工作区启动 → 记下目录；打开设置后 → 空启动把它接回来', async () => {
    // ── 第一次启动：显式给一个目录，进工作区模式 ────────────────────────────────
    activeApp = await launchElectronApp({ filePath: vault, userDataDir });
    const first = activeApp;
    await first.waitForSelector('.nexus-activity-bar', 20000);

    expect(await first.evaluate(`window.nexus.getLaunchContext()`)).toMatchObject({
      mode: 'workspace',
      workspaceRoot: vault
    });

    // 记下来了 —— 而且**设置还关着**：记录与「要不要恢复」是两件事，
    // 用户之后再打开那一项，上次的工作区立刻能用。
    const recorded = await waitForState((state) => state.workspaceRoot === vault);
    expect(recorded.restoreLastWorkspace).toBe(false);

    // ── 打开设置（走真实的设置 → 订阅 → 推送 → 落盘那条链）──────────────────────
    await first.evaluate(`(() => {
      window.nexusSettings.set('general.restoreLastWorkspace', true);
      return true;
    })()`);

    const enabled = await waitForState((state) => state.restoreLastWorkspace === true);
    // 打开开关**不该**把已经记下的目录弄丢 —— 落盘那份是两个字段一起写的。
    expect(enabled.workspaceRoot).toBe(vault);

    // ── 等第一次启动把索引建完、把锁放掉，再关应用 ────────────────────────────────
    //
    // **这一等不是装饰。** 侧栏一挂载就 `rebuildIndex`，而索引用的 wasm SQLite 实现
    // 拿**目录**当锁（`<db>.lock`：加锁 `mkdirSync`、解锁 `rmdirSync`，锁是按语句取的）。
    // 不等就 `close()`（SIGTERM）的话，若信号正好落在某条语句中间，那个目录会留在磁盘上；
    // 第二次启动的 `rebuildIndex` 于是报 `SQLite3Error: database is locked`，而
    // `IndexStore.open()` **明确拒绝**打开残留锁的库（刻意如此：残留锁也可能是另一个实例
    // 正在用），侧栏拿不到文档 → 本用例最后那一步等到超时。
    //
    // 症状是「同一个文件单独跑两次，一次红一次绿」，失败信息指向侧栏文件树 —— 看上去
    // 像恢复功能坏了，其实与恢复无关。所以这一等同时是**把竞态变成显式前置条件**：
    // 下面那条 `existsSync` 断言在说「现在确实没有锁了」，而不是碰运气。
    await first.waitForFunction(
      `() => Boolean(document.querySelector('.nexus-workspace-sidebar .nexus-tree-item'))`,
      20000
    );
    const indexLockPath = `${indexPathForWorkspace(userDataDir, vault)}.lock`;
    const lockDeadline = Date.now() + 10000;
    while (fs.existsSync(indexLockPath) && Date.now() < lockDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(fs.existsSync(indexLockPath)).toBe(false);

    await first.close();
    activeApp = null;

    // ── 第二次启动：**不给任何路径**，应该自己进上次那个工作区 ────────────────────
    activeApp = await launchElectronApp({ userDataDir });
    const second = activeApp;
    await second.waitForSelector('.nexus-activity-bar', 20000);

    expect(await second.evaluate(`window.nexus.getLaunchContext()`)).toMatchObject({
      mode: 'workspace',
      workspaceRoot: vault
    });

    // 判据取**文件树**而不是 launchContext：那个对象只证明主进程算对了，
    // 证明不了渲染进程真的按工作区模式渲染。这一条是「真的恢复了」与「只是变量对了」的分界。
    await second.waitForFunction(
      `() => Boolean(document.querySelector('.nexus-workspace-sidebar .nexus-tree-item'))`,
      20000
    );
  }, 120000);
});
