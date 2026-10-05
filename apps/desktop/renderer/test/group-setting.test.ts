import { describe, it, expect } from 'vitest';
import {
  CHROME_VISIBILITY,
  disabledMembers,
  isCapabilityDisabled,
  parseGroupSetting,
  PLUGINS_DISABLED,
  serializeGroupMembers,
  STATUS_BAR_METRICS,
  toggleGroupMember,
  type GroupSettingSpec
} from '../src/settings/preference-specs.js';
import { BUILTIN_CAPABILITY_IDS } from '../src/capability-roster.js';

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

describe('三个真实取值域', () => {
  it('默认都是「全开」（空串）', () => {
    expect(CHROME_VISIBILITY.fallback).toBe('');
    expect(STATUS_BAR_METRICS.fallback).toBe('');
    expect(PLUGINS_DISABLED.fallback).toBe('');
  });

  it('成员表非空且不重复', () => {
    for (const spec of [CHROME_VISIBILITY, STATUS_BAR_METRICS, PLUGINS_DISABLED]) {
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
    // 菜单栏也不行：它是「格式」菜单的落点，藏了块级动作就只剩命令面板一个入口。
    expect(CHROME_VISIBILITY.options).not.toContain('menuBar');
  });

  /**
   * 正面那一半：**工具栏在名单里**。
   *
   * 准入判据是「藏了还能用」—— 栏上每个动作都有第二条路（系统键 / 顶栏 / `Mod-M` /
   * `Mod-F` / 「格式」菜单），所以藏它是「少一条捷径」。少了这条正面断言，
   * 一个「顺手把工具栏从名单里删掉」的改动照样全绿。
   */
  it('界面元素里有编辑器工具栏', () => {
    expect(CHROME_VISIBILITY.options).toContain('editorToolbar');
  });
});

/**
 * 内置插件启停。
 *
 * 这一组的成员表**不是手写的**，它从出厂名册（`capability-roster.ts`）拼出来 ——
 * 于是「名册少一项」的后果是那个能力永远关不掉（开关点了没反应），而手抄的字符串
 * 在 id 常量改名时不会报错。下面两条一正一反盯着这件事。
 */
describe('内置插件启停 · 取值域', () => {
  it('成员表与出厂名册逐项相同、顺序也相同', () => {
    // 顺序即存储顺序：两份表顺序不同的话，同一个集合会有两种写法，「值变了没有」会误报。
    expect(PLUGINS_DISABLED.options).toEqual([...BUILTIN_CAPABILITY_IDS]);
  });

  it('名册非空，且每一项都能被这个取值域认出来', () => {
    expect(BUILTIN_CAPABILITY_IDS.length).toBeGreaterThan(0);
    for (const id of BUILTIN_CAPABILITY_IDS) {
      expect(disabledMembers(PLUGINS_DISABLED.options, id)).toEqual([id]);
    }
  });
});

describe('isCapabilityDisabled', () => {
  it('空串与 null ＝ 一个都没关', () => {
    for (const id of BUILTIN_CAPABILITY_IDS) {
      expect(isCapabilityDisabled('', id)).toBe(false);
      expect(isCapabilityDisabled(null, id)).toBe(false);
    }
  });

  it('关掉一个只影响它自己', () => {
    const raw = serializeGroupMembers(PLUGINS_DISABLED.options, ['pdf']);

    expect(isCapabilityDisabled(raw, 'pdf')).toBe(true);
    // 反面：只断言「pdf 被关了」对「关掉 pdf 顺手把别的也关了」同样成立
    for (const id of BUILTIN_CAPABILITY_IDS.filter((value) => value !== 'pdf')) {
      expect(isCapabilityDisabled(raw, id)).toBe(false);
    }
  });

  /**
   * 按**整词**比对，不是子串包含。`raw.includes('pdf')` 会把 `pdf` 匹配到 `pdf-text` 上。
   *
   * P1-4b 之后这两个 id **同时在这份成员表里**了（`pdf` 是查看器、`pdf-text` 是文档处理器），
   * 所以这条从「埋伏」变成了当场生效的判据。两个方向都要断言 —— 只测一个方向的话，
   * 把实现换成 `raw.includes(id)` 恰好能过其中一个。
   */
  it('不按子串匹配：pdf 与 pdf-text 互不牵连（两个方向都测）', () => {
    const onlyViewer = serializeGroupMembers(PLUGINS_DISABLED.options, ['pdf']);
    expect(isCapabilityDisabled(onlyViewer, 'pdf')).toBe(true);
    expect(isCapabilityDisabled(onlyViewer, 'pdf-text')).toBe(false);

    const onlyProcessor = serializeGroupMembers(PLUGINS_DISABLED.options, ['pdf-text']);
    expect(isCapabilityDisabled(onlyProcessor, 'pdf-text')).toBe(true);
    expect(isCapabilityDisabled(onlyProcessor, 'pdf')).toBe(false);

    // docx 那一对同理：`docx` 是 `docx-text` 的前缀。
    const onlyDocx = serializeGroupMembers(PLUGINS_DISABLED.options, ['docx']);
    expect(isCapabilityDisabled(onlyDocx, 'docx')).toBe(true);
    expect(isCapabilityDisabled(onlyDocx, 'docx-text')).toBe(false);
  });

  it('认不出的 id 一律当作启用 —— 一个坏字节不该静默关掉一项能力', () => {
    expect(isCapabilityDisabled('garbage', 'pdf')).toBe(false);
    expect(isCapabilityDisabled('pdf,gone', 'gone')).toBe(false);
  });
});
