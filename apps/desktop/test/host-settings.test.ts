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

    it('historyRetention 收下非负整数与 null', () => {
      expect(sanitizeHostSettings({ historyRetention: 20 })).toEqual({ historyRetention: 20 });
      // `null` 是合法值（＝不清理），不是「字段缺失」—— 两者在合并时的效果一样，
      // 但「显式说不清理」与「这次没说」是两件事，前者不该被当成后者的笔误。
      expect(sanitizeHostSettings({ historyRetention: null })).toEqual({ historyRetention: null });
      expect(sanitizeHostSettings({ historyRetention: 0 })).toEqual({ historyRetention: 0 });
    });

    it('historyRetention 是负数 / 小数 / 字符串 / 布尔就抛', () => {
      // 这一个字段是**删数据**的开关，宁可整条通道报错也不猜用户想表达什么。
      expect(() => sanitizeHostSettings({ historyRetention: -1 })).toThrow(/非负整数/);
      expect(() => sanitizeHostSettings({ historyRetention: 1.5 })).toThrow(/非负整数/);
      expect(() => sanitizeHostSettings({ historyRetention: '20' })).toThrow(/非负整数/);
      expect(() => sanitizeHostSettings({ historyRetention: true })).toThrow(/非负整数/);
      expect(() => sanitizeHostSettings({ historyRetention: NaN })).toThrow(/非负整数/);
    });

    it('restoreLastWorkspace 只收布尔值', () => {
      expect(sanitizeHostSettings({ restoreLastWorkspace: true })).toEqual({
        restoreLastWorkspace: true
      });
      expect(sanitizeHostSettings({ restoreLastWorkspace: false })).toEqual({
        restoreLastWorkspace: false
      });
      // 「看着像」的一律拒：它决定下一次启动要不要对一个目录做授权，
      // 猜错的方向是「不该开的开了」。
      expect(() => sanitizeHostSettings({ restoreLastWorkspace: 'true' })).toThrow(/布尔值/);
      expect(() => sanitizeHostSettings({ restoreLastWorkspace: 1 })).toThrow(/布尔值/);
      expect(() => sanitizeHostSettings({ restoreLastWorkspace: null })).toThrow(/布尔值/);
    });

    it('载荷本身不是对象就抛', () => {
      expect(() => sanitizeHostSettings(null)).toThrow(/必须是对象/);
      expect(() => sanitizeHostSettings('drafts')).toThrow(/必须是对象/);
    });
  });

  describe('updateHostSettings · 补丁合并', () => {
    it('初始值等于「加这条通道之前的行为」', () => {
      // `historyRetention: null` 就是那个「之前的行为」：没听到设置之前不删任何历史。
      // 它**不等于**设置项的默认档位（100）—— 前者是「还没听到」，后者是「用户没选过」。
      expect(hostSettings()).toEqual({
        ignoreRules: [],
        historyRetention: null,
        restoreLastWorkspace: false
      });
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

    it('historyRetention 只推一半时不影响 ignoreRules，反之亦然', () => {
      updateHostSettings({ ignoreRules: ['drafts'] });
      updateHostSettings({ historyRetention: 50 });

      expect(hostSettings()).toEqual({
        ignoreRules: ['drafts'],
        historyRetention: 50,
        restoreLastWorkspace: false
      });
    });

    it('resetHostSettings 回到初始值', () => {
      updateHostSettings({ ignoreRules: ['drafts'] });
      resetHostSettings();

      expect(hostSettings()).toEqual({
        ignoreRules: [],
        historyRetention: null,
        restoreLastWorkspace: false
      });
    });
  });
});
