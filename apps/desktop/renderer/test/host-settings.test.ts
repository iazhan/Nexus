import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HISTORY_RETENTION_DEFAULT,
  HISTORY_RETENTION_UNLIMITED,
  LOG_LEVEL_DEFAULT
} from '@nexus/core';
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
    settings.set('plugins.disabled', '');
    settings.set('data.logLevel', LOG_LEVEL_DEFAULT);
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
    settings.set('plugins.disabled', '');
    settings.set('data.logLevel', LOG_LEVEL_DEFAULT);
  });

  it('启动时立刻推一次，值已经归一化', async () => {
    settings.set('files.ignoreRules', 'Drafts, notes\\private');

    stop = startHostSettingsSync();
    await hostSettingsSynced();

    expect(syncSpy).toHaveBeenCalledWith({
      ignoreRules: ['Drafts', 'notes/private'],
      historyRetention: 100,
      restoreLastWorkspace: true,
      disabledCapabilities: [],
      logLevel: 'info'
    });
  });

  it('没填规则时推空表 —— 主进程因此只有内置规则', async () => {
    stop = startHostSettingsSync();
    await hostSettingsSynced();

    expect(syncSpy).toHaveBeenCalledWith({
      ignoreRules: [],
      historyRetention: 100,
      restoreLastWorkspace: true,
      disabledCapabilities: [],
      logLevel: 'info'
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
      restoreLastWorkspace: true,
      disabledCapabilities: [],
      logLevel: 'info'
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
      restoreLastWorkspace: true,
      disabledCapabilities: [],
      logLevel: 'info'
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

  /**
   * 内置能力启停。
   *
   * 渲染进程内那 5 个能力不需要这条通道（它们直接读存档），但主进程那 2 个文档处理器
   * 只能靠它 —— 所以这里测「值送出去了没有」，「送过去之后主进程怎么用」在
   * `apps/desktop/test/host-settings.test.ts` 与真机用例里各测一半。
   */
  describe('被禁用的内置能力', () => {
    it('默认送空表 —— 一个都没关', async () => {
      stop = startHostSettingsSync();
      await hostSettingsSynced();

      expect(syncSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ disabledCapabilities: [] })
      );
    });

    it('送的是归一化后的成员数组，不是存档里的逗号串', async () => {
      // 存档里是 `'nexus-math,pdf-text'`；主进程只该拿到「哪些被关掉了」这个答案。
      settings.set('plugins.disabled', 'nexus-math,pdf-text');

      stop = startHostSettingsSync();
      await hostSettingsSynced();

      expect(syncSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ disabledCapabilities: ['nexus-math', 'pdf-text'] })
      );
    });

    /**
     * 主进程那两个处理器的 id 在名册里 —— 这是 P1-4b 三条缺一不可里最容易被漏掉的一条。
     * 名册少一项的症状就是这一条红：值被 `disabledMembers` 当未知成员丢掉，
     * 开关点了什么都不会发生。
     */
    it('pdf-text / docx-text 送得出去 —— 它们在名册里', async () => {
      settings.set('plugins.disabled', 'pdf-text,docx-text');

      stop = startHostSettingsSync();
      await hostSettingsSynced();

      expect(syncSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ disabledCapabilities: ['pdf-text', 'docx-text'] })
      );
    });

    it('**改这一项本身就会触发推送** —— 漏订阅的症状是「关了处理器，重建索引却还在提取」', async () => {
      stop = startHostSettingsSync();
      await hostSettingsSynced();
      expect(syncSpy).toHaveBeenCalledTimes(1);

      settings.set('plugins.disabled', 'pdf-text');
      await hostSettingsSynced();

      expect(syncSpy).toHaveBeenCalledTimes(2);
      expect(syncSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ disabledCapabilities: ['pdf-text'] })
      );
    });

    it('认不出的成员丢掉，不会让整串失效 —— 老存档不该整份作废', async () => {
      settings.set('plugins.disabled', 'pdf-text,gone-from-a-future-version');

      stop = startHostSettingsSync();
      await hostSettingsSynced();

      expect(syncSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ disabledCapabilities: ['pdf-text'] })
      );
    });
  });

  /**
   * 日志级别。
   *
   * 跨进程的理由与上面几组相同：**写盘的是主进程**，而级别住在渲染进程的存储里。
   * 这里只测「值送出去了没有」；「主进程拿到之后怎么用」由 `apps/desktop/test/logger.test.ts`
   * 与 `host-settings.test.ts`（主进程那一份）各测一半。
   *
   * 认不出的**值**回落默认档由 `parseLogLevel` 负责，纯逻辑测试在
   * `packages/core/test/logging-level.test.ts`；主进程侧还会再兜一次
   * （`sanitizeHostSettings`），那一条在 desktop 的那份用例里。
   */
  describe('日志级别', () => {
    it('默认送 info —— 不是更安静的 error', async () => {
      // 默认只记 error 的话，用户遇到问题时盘上只剩一条孤零零的报错，前因全被滤掉了。
      stop = startHostSettingsSync();
      await hostSettingsSynced();

      expect(syncSpy).toHaveBeenLastCalledWith(expect.objectContaining({ logLevel: 'info' }));
    });

    it('送的是级别本身 —— 主进程只该拿到「按哪一档记」这个答案', async () => {
      settings.set('data.logLevel', 'debug');

      stop = startHostSettingsSync();
      await hostSettingsSynced();

      expect(syncSpy).toHaveBeenLastCalledWith(expect.objectContaining({ logLevel: 'debug' }));
    });

    it('**改这一项本身就会触发推送** —— 漏订阅的症状是「调了级别要重启才生效」', async () => {
      stop = startHostSettingsSync();
      await hostSettingsSynced();
      expect(syncSpy).toHaveBeenCalledTimes(1);

      settings.set('data.logLevel', 'error');
      await hostSettingsSynced();

      expect(syncSpy).toHaveBeenCalledTimes(2);
      expect(syncSpy).toHaveBeenLastCalledWith(expect.objectContaining({ logLevel: 'error' }));
    });
  });
});
