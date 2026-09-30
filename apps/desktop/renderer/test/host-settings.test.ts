import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    settings.set('files.ignoreRules', '');
    syncSpy = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { nexus?: unknown }).nexus = { syncHostSettings: syncSpy };
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    delete (window as unknown as { nexus?: unknown }).nexus;
    settings.set('files.ignoreRules', '');
  });

  it('启动时立刻推一次，值已经归一化', async () => {
    settings.set('files.ignoreRules', 'Drafts, notes\\private');

    stop = startHostSettingsSync();
    await hostSettingsSynced();

    expect(syncSpy).toHaveBeenCalledWith({
      ignoreRules: ['Drafts', 'notes/private']
    });
  });

  it('没填规则时推空表 —— 主进程因此只有内置规则', async () => {
    stop = startHostSettingsSync();
    await hostSettingsSynced();

    expect(syncSpy).toHaveBeenCalledWith({ ignoreRules: [] });
  });

  it('改设置会再推一次', async () => {
    stop = startHostSettingsSync();
    await hostSettingsSynced();
    expect(syncSpy).toHaveBeenCalledTimes(1);

    settings.set('files.ignoreRules', 'drafts');
    await hostSettingsSynced();

    expect(syncSpy).toHaveBeenCalledTimes(2);
    expect(syncSpy).toHaveBeenLastCalledWith({ ignoreRules: ['drafts'] });
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
    expect(syncSpy).toHaveBeenLastCalledWith({ ignoreRules: ['drafts'] });
    consoleError.mockRestore();
  });
});
