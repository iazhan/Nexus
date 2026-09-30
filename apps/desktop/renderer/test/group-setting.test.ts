import { describe, it, expect } from 'vitest';
import {
  CHROME_VISIBILITY,
  disabledMembers,
  parseGroupSetting,
  serializeGroupMembers,
  STATUS_BAR_METRICS,
  toggleGroupMember,
  type GroupSettingSpec
} from '../src/settings/preference-specs.js';

const SPEC: GroupSettingSpec = {
  storageKey: 'test-group',
  options: ['a', 'b', 'c'],
  fallback: ''
};

describe('开关组 · 值 → 成员', () => {
  it('空串与 null 都得到空集合（＝ 全开）', () => {
    expect(disabledMembers(SPEC.options, '')).toEqual([]);
    expect(disabledMembers(SPEC.options, null)).toEqual([]);
    expect(disabledMembers(SPEC.options, '   ')).toEqual([]);
  });

  it('逗号分隔，首尾空白吃掉', () => {
    expect(disabledMembers(SPEC.options, 'a, b')).toEqual(['a', 'b']);
    expect(disabledMembers(SPEC.options, ' a ,,b , ')).toEqual(['a', 'b']);
  });

  it('重复的只算一次', () => {
    expect(disabledMembers(SPEC.options, 'a,a,a')).toEqual(['a']);
  });

  it('**不认识的成员被丢掉，而不是让整串失效** —— 将来删掉一个成员时老存档不该整份作废', () => {
    expect(disabledMembers(SPEC.options, 'a,gone,c')).toEqual(['a', 'c']);
    expect(disabledMembers(SPEC.options, 'gone')).toEqual([]);
  });
});

describe('开关组 · 成员 → 值', () => {
  it('按 options 的顺序拼，所以同一个集合只有一种写法', () => {
    expect(serializeGroupMembers(SPEC.options, ['c', 'a'])).toBe('a,c');
    expect(serializeGroupMembers(SPEC.options, ['a', 'c'])).toBe('a,c');
  });

  it('空集合写成空串', () => {
    expect(serializeGroupMembers(SPEC.options, [])).toBe('');
  });

  it('认不出的成员不会写进值', () => {
    expect(serializeGroupMembers(SPEC.options, ['a', 'gone'])).toBe('a');
  });
});

describe('开关组 · 存档解析的失败方向', () => {
  it('null 回落到默认值', () => {
    expect(parseGroupSetting(SPEC, null)).toBe('');
  });

  it('**整串都认不出时得到空串（全开），不是「全关」** —— 一个坏值不该把界面藏起来', () => {
    // 这是存「被关掉的」而不是「开着的」的核心理由：坏值落在默认值上，而不是落在
    // 「全都藏起来」上 —— 后者是用户再也点不回来的状态。
    expect(parseGroupSetting(SPEC, 'garbage')).toBe('');
    expect(parseGroupSetting(SPEC, ',,,')).toBe('');
    expect(parseGroupSetting(SPEC, '{}')).toBe('');
  });

  it('能认出的那部分照常生效', () => {
    expect(parseGroupSetting(SPEC, 'b,gone')).toBe('b');
  });

  it('规范化是幂等的 —— 否则「值变了没有」的判断会误报', () => {
    for (const raw of ['', 'a', 'a,c', 'c,a', 'gone', 'a,a', ' b , c ']) {
      const once = parseGroupSetting(SPEC, raw);
      expect(parseGroupSetting(SPEC, once)).toBe(once);
    }
  });
});

describe('开关组 · 拨动一个成员', () => {
  it('关掉一个成员', () => {
    expect(toggleGroupMember(SPEC.options, '', 'b')).toBe('b');
  });

  it('打开一个成员', () => {
    expect(toggleGroupMember(SPEC.options, 'a,b', 'b')).toBe('a');
  });

  it('关到只剩一个、再关掉它 —— 空集合是合法状态，控件照样画得回来', () => {
    expect(toggleGroupMember(SPEC.options, 'a', 'a')).toBe('');
  });

  it('结果按 options 顺序，与拨动顺序无关', () => {
    // 先关 c 再关 a：两种顺序都要得到 `a,c`
    const first = toggleGroupMember(SPEC.options, toggleGroupMember(SPEC.options, '', 'c'), 'a');
    const second = toggleGroupMember(SPEC.options, toggleGroupMember(SPEC.options, '', 'a'), 'c');

    expect(first).toBe('a,c');
    expect(second).toBe('a,c');
  });

  it('认不出的成员是空操作', () => {
    expect(toggleGroupMember(SPEC.options, 'a', 'gone')).toBe('a');
  });
});

describe('两个真实取值域', () => {
  it('默认都是「全开」（空串）', () => {
    expect(CHROME_VISIBILITY.fallback).toBe('');
    expect(STATUS_BAR_METRICS.fallback).toBe('');
  });

  it('成员表非空且不重复', () => {
    for (const spec of [CHROME_VISIBILITY, STATUS_BAR_METRICS]) {
      expect(spec.options.length).toBeGreaterThan(0);
      expect(new Set(spec.options).size).toBe(spec.options.length);
    }
  });

  it('**状态栏显示项里没有「保存态」** —— 它是状态栏上唯一据以行动的东西，不给开关', () => {
    // 这条盯的是「顺手把左侧也做成可藏」这个改动：保存失败只在那里说。
    expect(STATUS_BAR_METRICS.options).not.toContain('saveState');
    expect(STATUS_BAR_METRICS.options).not.toContain('status');
    // 字数也不在这里：它已经有自己的开关（`editor.wordCount`），
    // 同一个东西给两个开关，两个都会显得不可信。
    expect(STATUS_BAR_METRICS.options).not.toContain('wordCount');
  });

  it('**界面元素里没有活动栏与顶栏** —— 藏了就没有地方点回来 / 拖不动窗口', () => {
    expect(CHROME_VISIBILITY.options).not.toContain('activityBar');
    expect(CHROME_VISIBILITY.options).not.toContain('headerBar');
    expect(CHROME_VISIBILITY.options).not.toContain('sidebar');
  });
});
