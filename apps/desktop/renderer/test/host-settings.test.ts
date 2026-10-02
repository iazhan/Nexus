import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HISTORY_RETENTION_DEFAULT, HISTORY_RETENTION_UNLIMITED } from '@nexus/core';
import { settings } from '../src/platform.js';
import { hostSettingsSynced, startHostSettingsSync } from '../src/host-settings.js';

/**
 * 「主进程要照着做的设置」是怎么送过去的。
 *
 * 判据取**桥收到了什么**，不取主进程最终用了什么 —— 那是主进程自己的事
 * （`electron/host-settings.ts`），两边分开测才不会互相掩盖。
 */
describe('宿主设置同步', () => {
  let syncSpy: ReturnType<typeof vi.fn>;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    localStorage.clear();
    // `SettingsStore` 在构造时缓存了值，`localStorage.clear()` 改不动它 ——
    // 必须走 `settings.set` 才能把上一轮用例的改动还原。
    settings.set('files.ignoreRules', '');
    settings.set('data.historyRetention', HISTORY_RETENTION_DEFAULT);
    settings.set('general.restoreLastWorkspace', true);
    syncSpy = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { nexus?: unknown }).nexus = { syncHostSettings: syncSpy };
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    delete (window as unknown as { nexus?: unknown }).nexus;
    settings.set('files.ignoreRules', '');
    settings.set('data.historyRetention', HISTORY_RETENTION_DEFAULT);
    settings.set('general.restoreLastWorkspace', true);
  });

  it('启动时立刻推一次，值已经归一化', async () => {
    settings.set('files.ignoreRules', 'Drafts, notes\\private');

    stop = startHostSettingsSync();
    await hostSettingsSynced();

    expect(syncSpy).toHaveBeenCalledWith({
      ignoreRules: ['Drafts', 'notes/private'],
      historyRetention: 100,
      restoreLastWorkspace: true
    });
  });

  it('没填规则时推空表 —— 主进程因此只有内置规则', async () => {
    stop = startHostSettingsSync();
    await hostSettingsSynced();

    expect(syncSpy).toHaveBeenCalledWith({
      ignoreRules: [],
      historyRetention: 100,
      restoreLastWorkspace: true
    });
  });

  it('改设置会再推一次', async () => {
    stop = startHostSettingsSync();
    await hostSettingsSynced();
    expect(syncSpy).toHaveBeenCalledTimes(1);

    settings.set('files.ignoreRules', 'drafts');
    await hostSettingsSynced();

    expect(syncSpy).toHaveBeenCalledTimes(2);
    expect(syncSpy).toHaveBeenLastCalledWith({
      ignoreRules: ['drafts'],
      historyRetention: 100,
      restoreLastWorkspace: true
    });
  });

  /**
   * 这一条是整条链路存在的理由：索引启动紧跟着设置同步，`hostSettingsSynced()`
   * 必须真的等到推送**落定**（而不是「发出去了」），否则第一次建索引会跑在旧规则上。
   */
  it('hostSettingsSynced() 等的是推送落定，不是「发出去了」', async () => {
    let release: (() => void) | undefined;
    syncSpy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    stop = startHostSettingsSync();

    let settled = false;
    void hostSettingsSynced().then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    release?.();
    await hostSettingsSynced();
    expect(settled).toBe(true);
  });

  it('桥不在时静默跳过，不抛 —— 渲染进程用例与纯浏览器里都没有它', async () => {
    delete (window as unknown as { nexus?: unknown }).nexus;

    stop = startHostSettingsSync();
    await expect(hostSettingsSynced()).resolves.toBeUndefined();
  });

  it('推送失败不炸，且后续推送仍然能发出去', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    syncSpy.mockRejectedValueOnce(new Error('主进程没接上'));

    stop = startHostSettingsSync();
    await hostSettingsSynced();

    settings.set('files.ignoreRules', 'drafts');
    await hostSettingsSynced();

    expect(syncSpy).toHaveBeenCalledTimes(2);
    expect(syncSpy).toHaveBeenLastCalledWith({
      ignoreRules: ['drafts'],
      historyRetention: 100,
      restoreLastWorkspace: true
    });
    consoleError.mockRestore();
  });

  describe('历史快照上限', () => {
    it('默认档位送的是数字 100，不是存档里的字符串', async () => {
      // 存档格式（`'100'`）是渲染进程的事；主进程只该拿到「留几份」这个答案。
      stop = startHostSettingsSync();
      await hostSettingsSynced();

      expect(syncSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ historyRetention: 100 })
      );
    });

    it('「不清理」送 null，不是 0 —— 0 是「一份都不留」', async () => {
      settings.set('data.historyRetention', HISTORY_RETENTION_UNLIMITED);

      stop = startHostSettingsSync();
      await hostSettingsSynced();

      expect(syncSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ historyRetention: null })
      );
    });

    it('**改这一项本身就会触发推送** —— 漏订阅的症状是「改了要重启才生效」', async () => {
      stop = startHostSettingsSync();
      await hostSettingsSynced();
      expect(syncSpy).toHaveBeenCalledTimes(1);

      settings.set('data.historyRetention', '20');
      await hostSettingsSynced();

      expect(syncSpy).toHaveBeenCalledTimes(2);
      expect(syncSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ historyRetention: 20 })
      );
    });

    it('取消订阅后两个键都不再推 —— 用例之间不该互相污染', async () => {
      stop = startHostSettingsSync();
      await hostSettingsSynced();
      stop();
      stop = undefined;

      settings.set('data.historyRetention', '20');
      settings.set('files.ignoreRules', 'drafts');
      await hostSettingsSynced();

      expect(syncSpy).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * 启动时恢复上次工作区。
   *
   * 这一项与上面两组有一处结构性的不同：主进程拿到它之后**会落盘**（它是唯一一个
   * 「要在第一个渲染进程存在之前就被读到」的设置）。但那是主进程自己的事 ——
   * 这一层只管「值送出去了没有」，落盘与启动回落由 `recent-workspace.test.ts` 与
   * 真机用例各测一半。
   */
  describe('启动时恢复上次工作区', () => {
    it('默认送 true —— 双击图标回到上次那个库', async () => {
      stop = startHostSettingsSync();
      await hostSettingsSynced();

      expect(syncSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ restoreLastWorkspace: true })
      );
    });

    it('关掉这一项送 false —— 下次启动先给欢迎态，不自动接手', async () => {
      settings.set('general.restoreLastWorkspace', false);

      stop = startHostSettingsSync();
      await hostSettingsSynced();

      expect(syncSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ restoreLastWorkspace: false })
      );
    });

    it('打开这一项送 true', async () => {
      settings.set('general.restoreLastWorkspace', true);

      stop = startHostSettingsSync();
      await hostSettingsSynced();

      expect(syncSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ restoreLastWorkspace: true })
      );
    });

    it('**改这一项本身就会触发推送** —— 漏订阅的症状是「改了开关，下次启动却没生效」', async () => {
      stop = startHostSettingsSync();
      await hostSettingsSynced();
      expect(syncSpy).toHaveBeenCalledTimes(1);

      // 默认是开的，所以这里往**反方向**改一次才算「改了」。
      settings.set('general.restoreLastWorkspace', false);
      await hostSettingsSynced();

      expect(syncSpy).toHaveBeenCalledTimes(2);
      expect(syncSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ restoreLastWorkspace: false })
      );
    });

    it('推的是布尔值，不是存档里的字符串', async () => {
      // 存档里是 `'true'` / `'false'`，主进程只该拿到「要不要恢复」这个答案。
      settings.set('general.restoreLastWorkspace', true);

      stop = startHostSettingsSync();
      await hostSettingsSynced();

      const payload = syncSpy.mock.calls.at(-1)?.[0] as { restoreLastWorkspace: unknown };
      expect(payload.restoreLastWorkspace).toBe(true);
    });
  });
});
