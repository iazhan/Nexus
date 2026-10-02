import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkForUpdatesManually } from '../electron/updater.js';

/**
 * 「检查更新」在四种版本组合下各报什么。
 *
 * 这个文件存在的理由是**一条真实的误报**：原先的判据是
 * `result.updateInfo.version === app.getVersion()`（字符串相等），而 `checkForUpdates()`
 * 在**没有更新时也返回对象**，`updateInfo.version` 是远端那个 —— 本地版本高于远端时
 * 两者不等，于是走「有新版本」分支，弹「正在后台下载」而 `downloadPromise` 压根没建。
 * 症状是「弹了一下，然后永远没有下文」，而触发条件恰好是开发机常态。
 *
 * 所以这里 mock 的是**整个返回值**（不是只换一个版本号）：要锁住的正是
 * 「拿到了对象 ≠ 有新版本」这件事。只把 `updateInfo.version` 换个值，
 * 两种写法（比字符串 / 读 `isUpdateAvailable`）会一起过 —— 那这条用例就白写了。
 */

const { showMessageBox, checkForUpdates, state } = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  checkForUpdates: vi.fn(),
  state: { currentVersion: '0.65.0', packaged: true }
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.packaged;
    },
    getVersion: () => state.currentVersion,
    getLocale: () => 'zh-CN'
  },
  // `parentWindow()` 两个都问；返回空 ⇒ 弹窗走单参数那条路（应用级模态）。
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => []
  },
  dialog: {
    showMessageBox: (...args: unknown[]) => showMessageBox(...args)
  }
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    checkForUpdates: (...args: unknown[]) => checkForUpdates(...args),
    on: () => {},
    autoDownload: true,
    autoInstallOnAppQuit: true
  }
}));

/** 最后一次弹窗的内容。`showMessage` 不带父窗口时是单参数，options 就在 `[0]`。 */
function lastMessage(): { title: string; message: string } {
  return (showMessageBox.mock.calls.at(-1)?.[0] ?? {}) as { title: string; message: string };
}

describe('检查更新：四种版本组合各报什么', () => {
  beforeEach(() => {
    showMessageBox.mockReset();
    checkForUpdates.mockReset();
    state.currentVersion = '0.65.0';
    state.packaged = true;
  });

  it('远端更高 → 报「发现新版本」，带上远端那个版本号', async () => {
    checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '0.66.0' }
    });

    await checkForUpdatesManually();

    expect(lastMessage().title).toBe('发现新版本');
    expect(lastMessage().message).toContain('0.66.0');
  });

  it('等版本 → 报「已是最新」', async () => {
    checkForUpdates.mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: { version: '0.65.0' }
    });

    await checkForUpdatesManually();

    expect(lastMessage().title).toBe('已是最新版本');
    expect(lastMessage().message).toContain('0.65.0');
  });

  it('远端更低 → 报「已是最新」，**不是**「正在后台下载」', async () => {
    // 远端还停在 0.64.0，本地已经是 0.65.0 —— 开发机常态，也就是被修掉的那一格。
    checkForUpdates.mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: { version: '0.64.0' }
    });

    await checkForUpdatesManually();

    expect(lastMessage().title).toBe('已是最新版本');
    // 报的必须是**本地**版本：说「0.64.0 已是最新」会把用户搞糊涂。
    expect(lastMessage().message).toContain('0.65.0');
    expect(lastMessage().message).not.toContain('0.64.0');
  });

  it('拿不到结果（null）→ 报「已是最新」，不崩', async () => {
    checkForUpdates.mockResolvedValue(null);

    await checkForUpdatesManually();

    expect(lastMessage().title).toBe('已是最新版本');
  });

  it('未打包 → 报「无法检查更新」，且根本没去问远端', async () => {
    state.packaged = false;

    await checkForUpdatesManually();

    expect(lastMessage().title).toBe('无法检查更新');
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it('远端报错 → 报「检查更新失败」，把原因带出来（不静默）', async () => {
    checkForUpdates.mockRejectedValue(new Error('ENOTFOUND github.com'));

    await checkForUpdatesManually();

    expect(lastMessage().title).toBe('检查更新失败');
    expect(lastMessage().message).toContain('ENOTFOUND');
  });
});
