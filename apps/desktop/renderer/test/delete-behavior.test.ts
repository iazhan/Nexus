import { describe, it, expect, beforeEach } from 'vitest';
import { DELETE_MODES } from '../../ipc/channels.js';
import {
  DELETE_BEHAVIOR_DEFAULT,
  DELETE_BEHAVIOR_OPTIONS,
  DELETE_BEHAVIOR_STORAGE_KEY,
  parseDeleteMode
} from '../src/settings/preference-specs.js';
import { SettingsStore } from '../src/settings/store.js';

/**
 * 删除行为偏好（`files.deleteBehavior`）。
 *
 * 这一项与别的设置项有个结构性的不同：**它是「失败方向」的设置**。两条分支不是
 * 「方便 / 不方便」，而是「可逆 / 不可逆」，所以三条判据都指向同一个方向 ——
 * 认不出、读不到、写坏了，一律倒向**回收站**那一侧。这与主进程的
 * `deleteFile` handler（认不出的 mode 按 `trash` 处理）是同一条，两处必须同时成立：
 * 渲染进程这边倒了、主进程那边没倒，用户还是会看到文件被永久删掉。
 *
 * 用真 `localStorage` 造 `SettingsStore`（happy-dom 提供）—— `parse` / `serialize`
 * 的往返正是这里要验的，打桩存储就绕过了键名与格式。
 */
describe('删除行为偏好', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('只有两档，且第一档是可恢复的那一档', () => {
    // 顺序是界面顺序（`radio` 按 `options` 排列），也是 `FIELDS` 里那一项的取值域。
    expect(DELETE_BEHAVIOR_OPTIONS.map((option) => option.value)).toEqual(['trash', 'permanent']);
    expect(DELETE_BEHAVIOR_DEFAULT).toBe('trash');
  });

  it('两档的取值域与主进程契约同源 —— 不是各写一份字面量', () => {
    // `DeleteMode` 定义在 `ipc/channels.ts`（跨进程契约）。这里如果各抄一份，
    // 主进程加一档而设置页没加，症状是「新增的档位在设置里选不到」。
    expect(DELETE_BEHAVIOR_OPTIONS.map((option) => option.value)).toEqual([...DELETE_MODES]);
  });

  it('每档都有自己的文案键，两两不同', () => {
    const keys = DELETE_BEHAVIOR_OPTIONS.map((option) => option.labelKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key.startsWith('settings.files.deleteBehavior.')).toBe(true);
    }
  });

  it('认得出的两档原样收窄', () => {
    expect(parseDeleteMode('trash')).toBe('trash');
    expect(parseDeleteMode('permanent')).toBe('permanent');
  });

  it('认不出的一律回落到回收站', () => {
    // 大小写、前后空格、近义词都不是「合法的另一档」，没有理由让它们升级成不可逆。
    for (const bad of [null, undefined, '', 'Trash', 'PERMANENT', 'delete', 'trash ', ' {}']) {
      expect(parseDeleteMode(bad as string | null | undefined)).toBe('trash');
    }
  });

  it('写进 store 再读出来是同一个值（换一个实例读，验的是磁盘上那一份）', () => {
    const store = new SettingsStore(localStorage);
    store.set('files.deleteBehavior', 'permanent');

    expect(store.get('files.deleteBehavior')).toBe('permanent');
    expect(new SettingsStore(localStorage).get('files.deleteBehavior')).toBe('permanent');
    expect(localStorage.getItem(DELETE_BEHAVIOR_STORAGE_KEY)).toBe('permanent');
  });

  it('没有存量时是回收站', () => {
    expect(new SettingsStore(localStorage).get('files.deleteBehavior')).toBe(DELETE_BEHAVIOR_DEFAULT);
  });

  it('存档里是垃圾值时回落到回收站，而不是永久删除', () => {
    // 这一条是整组里最要紧的：坏值必须落在**可恢复**的那一侧。
    // 反过来（回落 permanent）意味着「存档里一个错字，用户点一下删除就再也找不回来」。
    localStorage.setItem(DELETE_BEHAVIOR_STORAGE_KEY, 'shred');
    expect(new SettingsStore(localStorage).get('files.deleteBehavior')).toBe('trash');
  });

  it('存档是空串时也回落到回收站', () => {
    localStorage.setItem(DELETE_BEHAVIOR_STORAGE_KEY, '');
    expect(new SettingsStore(localStorage).get('files.deleteBehavior')).toBe('trash');
  });
});
