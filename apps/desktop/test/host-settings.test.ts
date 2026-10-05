import { describe, it, expect, afterEach } from 'vitest';
import {
  hostCapabilityEnabled,
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

    it('disabledCapabilities 收字符串数组（空表也收）', () => {
      expect(sanitizeHostSettings({ disabledCapabilities: ['pdf-text'] })).toEqual({
        disabledCapabilities: ['pdf-text']
      });
      expect(sanitizeHostSettings({ disabledCapabilities: [] })).toEqual({
        disabledCapabilities: []
      });
    });

    it('disabledCapabilities 认不出的 id 照收 —— 认不认识是各自查表时的事', () => {
      // 渲染进程送来的表里有渲染进程内那 5 个 id（`nexus-math` / `pdf` …），主进程不认识它们。
      // 这里**不比对 id**：过滤掉会让「主进程那份缓存」与「渲染进程送来的那份」不一致，
      // 而前向兼容（渲染进程先升级）也要求多出来的 id 不报错。主进程只拿自己的 id 查表。
      expect(
        sanitizeHostSettings({ disabledCapabilities: ['nexus-math', 'pdf', 'docx-text'] })
      ).toEqual({ disabledCapabilities: ['nexus-math', 'pdf', 'docx-text'] });
    });

    it('disabledCapabilities 不是字符串数组就抛', () => {
      expect(() => sanitizeHostSettings({ disabledCapabilities: 'pdf-text' })).toThrow(
        /字符串数组/
      );
      expect(() => sanitizeHostSettings({ disabledCapabilities: [1] })).toThrow(/字符串数组/);
      expect(() => sanitizeHostSettings({ disabledCapabilities: null })).toThrow(/字符串数组/);
    });

    it('载荷本身不是对象就抛', () => {
      expect(() => sanitizeHostSettings(null)).toThrow(/必须是对象/);
      expect(() => sanitizeHostSettings('drafts')).toThrow(/必须是对象/);
    });
  });

  describe('updateHostSettings · 补丁合并', () => {
    it('初始值：删历史那一项保守，恢复工作区那一项跟设置默认值', () => {
      // `historyRetention: null` 是那个「更保守」的取值：没听到设置之前不删任何历史。
      // 它**不等于**设置项的默认档位（100）—— 前者是「还没听到」，后者是「用户没选过」。
      //
      // `restoreLastWorkspace: true` 则相反，与设置项的默认值一致：关掉它只是让人看到
      // 欢迎态，不涉及任何不可逆动作，所以这里没有「保守」可言。
      expect(hostSettings()).toEqual({
        ignoreRules: [],
        historyRetention: null,
        restoreLastWorkspace: true,
        disabledCapabilities: []
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
        restoreLastWorkspace: true,
        disabledCapabilities: []
      });
    });

    it('resetHostSettings 回到初始值', () => {
      updateHostSettings({ ignoreRules: ['drafts'] });
      resetHostSettings();

      expect(hostSettings()).toEqual({
        ignoreRules: [],
        historyRetention: null,
        restoreLastWorkspace: true,
        disabledCapabilities: []
      });
    });
  });

  /**
   * 启停谓词（P1-4b）。
   *
   * 它是 `ProcessorRegistry` 唯一的输入 —— 这一层测「它答得对不对」，
   * 「注册表拿这个答案做了什么」在 `packages/core/test/processor-registry.test.ts` 里测。
   */
  describe('hostCapabilityEnabled · 启停谓词', () => {
    it('默认全启用 —— 与加启停之前的行为一致', () => {
      expect(hostCapabilityEnabled('pdf-text')).toBe(true);
      expect(hostCapabilityEnabled('docx-text')).toBe(true);
      expect(hostCapabilityEnabled('nexus-math')).toBe(true);
    });

    it('在被关掉的表里的 id 报 false，其余报 true', () => {
      updateHostSettings({ disabledCapabilities: ['pdf-text'] });

      expect(hostCapabilityEnabled('pdf-text')).toBe(false);
      expect(hostCapabilityEnabled('docx-text')).toBe(true);
    });

    /**
     * **每次调用现读当前值**，不是构造时快照 —— 这是「拨开关立即生效、不用重启」的全部依据。
     * 写成 `const disabled = ...; return (id) => !disabled.includes(id)` 会让这一条红。
     */
    it('现读：改完设置再问，答案立刻变（不用重新构造谓词）', () => {
      const enabled = hostCapabilityEnabled;

      expect(enabled('pdf-text')).toBe(true);
      updateHostSettings({ disabledCapabilities: ['pdf-text'] });
      expect(enabled('pdf-text')).toBe(false);
      // 再开回来
      updateHostSettings({ disabledCapabilities: [] });
      expect(enabled('pdf-text')).toBe(true);
    });

    it('不认识渲染进程的 id 只是永远命中不了 —— 不报错，也不牵连别人', () => {
      // 渲染进程会把 `nexus-math` 之类一起送过来；主进程照收，但只有自己的 id 会被查。
      updateHostSettings({ disabledCapabilities: ['nexus-math'] });

      expect(hostCapabilityEnabled('nexus-math')).toBe(false);
      expect(hostCapabilityEnabled('pdf-text')).toBe(true);
    });
  });
});
