import { describe, it, expect, afterEach } from 'vitest';
import {
  hostSettings,
  resetHostSettings,
  sanitizeHostSettings,
  updateHostSettings
} from '../electron/host-settings.js';

/**
 * 主进程侧那份缓存的形状与校验。
 *
 * `singleFork` 下模块状态跨文件共享，所以每条用例之后都要还原 ——
 * 留一份 `ignoreRules` 在那儿会让后面任何一个真机用例的扫描结果变样。
 */
describe('主进程宿主设置', () => {
  afterEach(() => resetHostSettings());

  describe('sanitizeHostSettings · 跨进程边界的校验', () => {
    it('认得的键收下，逐个判类型', () => {
      expect(sanitizeHostSettings({ ignoreRules: ['a', 'b'] })).toEqual({
        ignoreRules: ['a', 'b']
      });
      expect(sanitizeHostSettings({ ignoreRules: [] })).toEqual({ ignoreRules: [] });
    });

    it('不认得的键忽略 —— 渲染进程先升级时不该让整条通道报错', () => {
      expect(sanitizeHostSettings({ ignoreRules: [], somethingElse: 1 })).toEqual({
        ignoreRules: []
      });
      expect(sanitizeHostSettings({})).toEqual({});
    });

    it('认得的键类型不对就抛 —— 静默丢掉会变成「改了设置没生效」', () => {
      expect(() => sanitizeHostSettings({ ignoreRules: 'drafts' })).toThrow(/字符串数组/);
      expect(() => sanitizeHostSettings({ ignoreRules: [1, 2] })).toThrow(/字符串数组/);
      expect(() => sanitizeHostSettings({ ignoreRules: null })).toThrow(/字符串数组/);
    });

    it('载荷本身不是对象就抛', () => {
      expect(() => sanitizeHostSettings(null)).toThrow(/必须是对象/);
      expect(() => sanitizeHostSettings('drafts')).toThrow(/必须是对象/);
    });
  });

  describe('updateHostSettings · 补丁合并', () => {
    it('初始值等于「加这条通道之前的行为」', () => {
      expect(hostSettings()).toEqual({ ignoreRules: [] });
    });

    it('未出现的键保持原值', () => {
      updateHostSettings({ ignoreRules: ['drafts'] });
      updateHostSettings({});

      expect(hostSettings().ignoreRules).toEqual(['drafts']);
    });

    it('出现的键整份替换', () => {
      updateHostSettings({ ignoreRules: ['a', 'b'] });
      updateHostSettings({ ignoreRules: ['c'] });

      expect(hostSettings().ignoreRules).toEqual(['c']);
    });

    it('resetHostSettings 回到初始值', () => {
      updateHostSettings({ ignoreRules: ['drafts'] });
      resetHostSettings();

      expect(hostSettings()).toEqual({ ignoreRules: [] });
    });
  });
});
