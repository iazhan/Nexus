// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { IPC_CHANNELS, UPDATE_REMIND_INTERVAL_MS } from '../ipc/channels.js';
import { createTempDir } from './smoke-harness.js';

/**
 * 更新状态机：检查 → 后台下载 → 提示重启安装。
 *
 * 这个文件存在的理由是**一条真实的误报**：原先的判据是
 * `result.updateInfo.version === app.getVersion()`（字符串相等），而 `checkForUpdates()`
 * 在**没有更新时也返回对象**，`updateInfo.version` 是远端那个 —— 本地版本高于远端时
 * 两者不等，于是走「有新版本」分支，说「正在后台下载」而 `downloadPromise` 压根没建。
 * 症状是「提示了一下，然后永远没有下文」，而触发条件恰好是开发机常态。
 * 所以下面 mock 的是**整个返回值**（不是只换一个版本号）：只换版本号的话，
 * 「比字符串」与「读 `isUpdateAvailable`」两种写法会一起过 —— 那条用例就白写了。
 *
 * 主进程不再弹任何原生对话框（界面全在渲染进程），所以这里断言的是**状态与广播**，
 * 而不是弹窗文案。文案在 `@nexus/i18n`。
 *
 * ## 三个模块级单例，必须逐个重置
 *
 * `state`（状态）、`wired`（监听是否挂过）都是模块级变量，`window-dirty` 也是一张模块级
 * 的 Set。所以每个用例都 `vi.resetModules()` 之后**动态 import** —— 而且要连
 * `window-dirty` 一起动态拿：静态 import 拿到的是重置前那份，标记脏窗口时两边看的
 * 不是同一个 Set，`installNow()` 会永远认为没有未保存的文档。
 */

const harness = vi.hoisted(() => ({
  packaged: true,
  version: '0.73.0',
  userData: '',
  handlers: new Map<string, (...args: unknown[]) => void>(),
  checkForUpdates: vi.fn(),
  quitAndInstall: vi.fn(),
  autoDownload: false,
  autoInstallOnAppQuit: false,
  windows: [] as {
    isDestroyed: () => boolean;
    webContents: { send: (channel: string, payload: unknown) => void };
  }[],
  sent: [] as { channel: string; payload: unknown }[]
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return harness.packaged;
    },
    getVersion: () => harness.version,
    getPath: () => harness.userData
  },
  BrowserWindow: {
    getAllWindows: () => harness.windows
  }
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    checkForUpdates: (...args: unknown[]) => harness.checkForUpdates(...args),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      harness.handlers.set(event, handler);
    },
    quitAndInstall: () => harness.quitAndInstall(),
    get autoDownload() {
      return harness.autoDownload;
    },
    set autoDownload(value: boolean) {
      harness.autoDownload = value;
    },
    get autoInstallOnAppQuit() {
      return harness.autoInstallOnAppQuit;
    },
    set autoInstallOnAppQuit(value: boolean) {
      harness.autoInstallOnAppQuit = value;
    }
  }
}));

/** 重置模块级单例，拿到一份干净的状态机与它看的那张「脏窗口」表。 */
async function loadUpdater() {
  vi.resetModules();
  const [updater, dirty] = await Promise.all([
    import('../electron/updater.js'),
    import('../electron/window-dirty.js')
  ]);
  return { updater, dirty };
}

/** 造一个假窗口，把它的 `webContents.send` 记进 `harness.sent`。 */
function fakeWindow(destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: {
      send: (channel: string, payload: unknown) => {
        harness.sent.push({ channel, payload });
      }
    }
  };
}

/** 让下一次 `checkForUpdates()` 返回「远端有这个版本」。 */
function remoteHas(version: string, isUpdateAvailable: boolean) {
  harness.checkForUpdates.mockResolvedValue({
    isUpdateAvailable,
    updateInfo: { version }
  });
}

/** 触发一个由 `setupAutoUpdater` 挂上的事件。 */
function emit(event: string, ...args: unknown[]) {
  const handler = harness.handlers.get(event);
  if (!handler) throw new Error(`事件 ${event} 没有被挂上`);
  handler(...args);
}

let directory: string;

beforeEach(() => {
  directory = createTempDir('nexus-updater-');
  harness.packaged = true;
  harness.version = '0.73.0';
  harness.userData = directory;
  harness.handlers.clear();
  harness.checkForUpdates.mockReset();
  harness.quitAndInstall.mockReset();
  harness.autoDownload = false;
  harness.autoInstallOnAppQuit = false;
  harness.windows = [];
  harness.sent = [];
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('检查更新：四种版本组合各落到哪个阶段', () => {
  it('远端更高 → available，latest 是远端那个', async () => {
    const { updater } = await loadUpdater();
    remoteHas('0.74.0', true);

    const state = await updater.checkNow();

    expect(state).toMatchObject({ phase: 'available', latest: '0.74.0', current: '0.73.0' });
  });

  it('等版本 → up-to-date', async () => {
    const { updater } = await loadUpdater();
    remoteHas('0.73.0', false);

    expect((await updater.checkNow()).phase).toBe('up-to-date');
  });

  it('远端更低 → up-to-date，**不是** available —— 被修掉的就是这一格', async () => {
    const { updater } = await loadUpdater();
    // 远端还停在 0.64.0，本地已经是 0.73.0：开发机常态。
    remoteHas('0.64.0', false);

    const state = await updater.checkNow();

    expect(state.phase).toBe('up-to-date');
    // `latest` 如实记远端那个（界面在 up-to-date 时不画它），但**判据是 phase**。
    expect(state.latest).toBe('0.64.0');
  });

  it('拿不到结果（null）→ up-to-date，不崩', async () => {
    const { updater } = await loadUpdater();
    harness.checkForUpdates.mockResolvedValue(null);

    const state = await updater.checkNow();

    expect(state).toMatchObject({ phase: 'up-to-date', latest: null });
  });

  it('远端报错 → error 并把原因带出来，**不往外抛**', async () => {
    const { updater } = await loadUpdater();
    harness.checkForUpdates.mockRejectedValue(new Error('ENOTFOUND github.com'));

    // 抛出去在渲染进程那边没有落点，用户看到的是「点了没反应」。
    const state = await updater.checkNow();

    expect(state.phase).toBe('error');
    expect(state.error).toContain('ENOTFOUND');
  });

  it('未打包 → unsupported，且根本没去问远端', async () => {
    harness.packaged = false;
    const { updater } = await loadUpdater();

    expect(updater.updatesSupported()).toBe(false);
    expect((await updater.checkNow()).phase).toBe('unsupported');
    expect(harness.checkForUpdates).not.toHaveBeenCalled();
  });

  it('返回值就是当时的状态快照，与 getUpdateState 一致', async () => {
    const { updater } = await loadUpdater();
    remoteHas('0.74.0', true);

    expect(await updater.checkNow()).toEqual(updater.getUpdateState());
  });

  it('检查前先落一个 checking 阶段 —— 界面在等网络期间要有东西可显示', async () => {
    const { updater } = await loadUpdater();
    harness.windows = [fakeWindow()];
    remoteHas('0.74.0', true);

    await updater.checkNow();

    const phases = harness.sent.map((entry) => (entry.payload as { phase: string }).phase);
    expect(phases[0]).toBe('checking');
    expect(phases.at(-1)).toBe('available');
  });
});

describe('事件流：阶段与进度', () => {
  it('挂上六个事件，并打开自动下载与退出时自动安装', async () => {
    const { updater } = await loadUpdater();
    updater.setupAutoUpdater();

    expect([...harness.handlers.keys()].sort()).toEqual([
      'checking-for-update',
      'download-progress',
      'error',
      'update-available',
      'update-downloaded',
      'update-not-available'
    ]);
    expect(harness.autoDownload).toBe(true);
    expect(harness.autoInstallOnAppQuit).toBe(true);
  });

  it('重复调用只挂一次 —— `autoUpdater` 是进程级单例，重复挂会让一次下载广播 N 次', async () => {
    const { updater } = await loadUpdater();

    updater.setupAutoUpdater();
    const afterFirst = harness.handlers.size;
    expect(afterFirst).toBe(6);

    updater.setupAutoUpdater();
    updater.setupAutoUpdater();

    expect(harness.handlers.size).toBe(afterFirst);
  });

  it('未打包时整个函数是空操作 —— 一个监听都不挂', async () => {
    harness.packaged = false;
    const { updater } = await loadUpdater();

    updater.setupAutoUpdater();

    expect(harness.handlers.size).toBe(0);
    expect(harness.autoDownload).toBe(false);
  });

  it('update-available / download-progress / update-downloaded 推着阶段走', async () => {
    const { updater } = await loadUpdater();
    updater.setupAutoUpdater();

    emit('update-available', { version: '0.74.0' });
    expect(updater.getUpdateState()).toMatchObject({ phase: 'available', latest: '0.74.0' });

    emit('download-progress', {
      percent: 42.5,
      bytesPerSecond: 1024,
      transferred: 425,
      total: 1000
    });
    expect(updater.getUpdateState()).toMatchObject({
      phase: 'downloading',
      progress: 0.425,
      bytesPerSecond: 1024,
      transferred: 425,
      total: 1000
    });

    emit('update-downloaded', { version: '0.74.0' });
    expect(updater.getUpdateState()).toMatchObject({
      phase: 'downloaded',
      latest: '0.74.0',
      progress: 1
    });
  });

  it('进度归一成 0–1 并夹住越界值', async () => {
    const { updater } = await loadUpdater();
    updater.setupAutoUpdater();

    emit('download-progress', { percent: 140 });
    expect(updater.getUpdateState().progress).toBe(1);

    emit('download-progress', { percent: -20 });
    expect(updater.getUpdateState().progress).toBe(0);
  });

  it('进度拿不到（NaN）时是 null，不是 NaN —— NaN 过不了结构化克隆，界面会拿到一个怪值', async () => {
    const { updater } = await loadUpdater();
    updater.setupAutoUpdater();

    emit('download-progress', { percent: Number.NaN });

    expect(updater.getUpdateState().progress).toBeNull();
  });

  it('update-not-available → up-to-date，且 latest 如实记远端那个', async () => {
    const { updater } = await loadUpdater();
    updater.setupAutoUpdater();

    emit('update-not-available', { version: '0.64.0' });

    expect(updater.getUpdateState()).toMatchObject({ phase: 'up-to-date', latest: '0.64.0' });
  });

  it('error 事件 → error 阶段，不弹任何东西', async () => {
    const { updater } = await loadUpdater();
    updater.setupAutoUpdater();

    emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));

    expect(updater.getUpdateState().phase).toBe('error');
    expect(updater.getUpdateState().error).toContain('ERR_INTERNET_DISCONNECTED');
  });
});

describe('广播：状态的唯一出口', () => {
  it('每次变化都发 updateStateChanged，payload 是最新状态', async () => {
    const { updater } = await loadUpdater();
    harness.windows = [fakeWindow()];
    remoteHas('0.74.0', true);

    await updater.checkNow();

    const last = harness.sent.at(-1);
    expect(last?.channel).toBe(IPC_CHANNELS.updateStateChanged);
    expect(last?.payload).toEqual(updater.getUpdateState());
  });

  it('同一次变化发给所有窗口 —— 更新窗口与主窗口都要跟上', async () => {
    const { updater } = await loadUpdater();
    harness.windows = [fakeWindow(), fakeWindow()];

    // 跳过恰好改一次状态，所以这里能数清：两个窗口各一份，且内容相同。
    updater.skipVersion('0.74.0');

    expect(harness.sent).toHaveLength(2);
    expect(new Set(harness.sent.map((entry) => entry.payload)).size).toBe(1);
  });

  it('已销毁的窗口不发送 —— 往销毁的 webContents 上 send 会抛', async () => {
    const { updater } = await loadUpdater();
    harness.windows = [fakeWindow(true)];
    remoteHas('0.74.0', true);

    await expect(updater.checkNow()).resolves.toBeDefined();
    expect(harness.sent).toHaveLength(0);
  });
});

describe('跳过与稍后：两件事，都落盘', () => {
  it('跳过某版本后，重开一份状态机仍记得 —— 它是跨会话的', async () => {
    const first = await loadUpdater();
    expect(first.updater.skipVersion('0.74.0')).toMatchObject({
      skipped: '0.74.0',
      remindAfter: null
    });

    const second = await loadUpdater();
    expect(second.updater.getUpdateState().skipped).toBe('0.74.0');
  });

  it('版本号两端的空白会被去掉', async () => {
    const { updater } = await loadUpdater();
    expect(updater.skipVersion('  0.74.0  ').skipped).toBe('0.74.0');
  });

  it('空版本号是空操作 —— 不落盘、不改状态', async () => {
    const { updater } = await loadUpdater();

    for (const value of ['', '   ']) {
      expect(updater.skipVersion(value).skipped).toBeNull();
    }

    const fresh = await loadUpdater();
    expect(fresh.updater.getUpdateState().skipped).toBeNull();
  });

  it('跳过会清掉已有的「稍后」—— 两个标记同时存在时「听谁的」要靠约定，而约定会漂', async () => {
    const { updater } = await loadUpdater();

    updater.remindLater();
    expect(updater.getUpdateState().remindAfter).not.toBeNull();

    expect(updater.skipVersion('0.74.0').remindAfter).toBeNull();
  });

  it('稍后提醒给的是一个时刻，不是布尔 —— 到期自动失效，不需要任何定时器', async () => {
    const { updater } = await loadUpdater();
    const before = Date.now();

    const state = updater.remindLater();

    expect(state.remindAfter).toBeGreaterThanOrEqual(before + UPDATE_REMIND_INTERVAL_MS);
    expect(state.remindAfter).toBeLessThanOrEqual(Date.now() + UPDATE_REMIND_INTERVAL_MS);
  });

  it('稍后提醒不碰已跳过的版本 —— 两者互斥是「跳过清稍后」，不是「稍后清跳过」', async () => {
    const { updater } = await loadUpdater();

    updater.skipVersion('0.74.0');
    const state = updater.remindLater();

    expect(state.skipped).toBe('0.74.0');
    expect(state.remindAfter).not.toBeNull();
  });

  it('稍后提醒也落盘', async () => {
    const first = await loadUpdater();
    const remindAfter = first.updater.remindLater().remindAfter;

    const second = await loadUpdater();
    expect(second.updater.getUpdateState().remindAfter).toBe(remindAfter);
  });
});

describe('立即安装：脏文档时不硬来', () => {
  it('还没下载完 → false，且不去重启', async () => {
    const { updater } = await loadUpdater();

    expect(updater.installNow()).toBe(false);
    expect(harness.quitAndInstall).not.toHaveBeenCalled();
  });

  it('有未保存的文档 → false，且不去重启 —— `quitAndInstall()` 会撞上关闭拦截', async () => {
    const { updater, dirty } = await loadUpdater();
    updater.setupAutoUpdater();
    emit('update-downloaded', { version: '0.74.0' });
    dirty.markWindowDirty(1, true);

    expect(updater.installNow()).toBe(false);
    expect(harness.quitAndInstall).not.toHaveBeenCalled();
  });

  it('已下载且都保存了 → true，真的发起重启', async () => {
    const { updater } = await loadUpdater();
    updater.setupAutoUpdater();
    emit('update-downloaded', { version: '0.74.0' });

    expect(updater.installNow()).toBe(true);
    expect(harness.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('文档保存之后就能装了 —— 脏标记是活的', async () => {
    const { updater, dirty } = await loadUpdater();
    updater.setupAutoUpdater();
    emit('update-downloaded', { version: '0.74.0' });

    dirty.markWindowDirty(1, true);
    expect(updater.installNow()).toBe(false);

    dirty.markWindowDirty(1, false);
    expect(updater.installNow()).toBe(true);
  });
});
