import { describe, it, expect } from 'vitest';
import { DICTIONARIES, hasMessage, translate } from '../src/index.js';

const EN = DICTIONARIES['en-US'] ?? {};
const ZH = DICTIONARIES['zh-CN'] ?? {};

/** 取一条文案里的 `{var}` 占位符名，排序后比较。 */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
}

describe('i18n 字典一致性', () => {
  /**
   * 这四条此前一条都不存在 —— 键集不等、某边漏填、占位符写岔，都不会有任何东西报错，
   * 只会在切到那个语言时露出一个英文键名或一个没被替换的 `{count}`。
   */
  it('两本字典的键集合相等', () => {
    expect(Object.keys(ZH).sort()).toEqual(Object.keys(EN).sort());
  });

  it('没有空值', () => {
    for (const [locale, dict] of Object.entries(DICTIONARIES)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.trim(), `${locale} 的 ${key} 是空的`).not.toBe('');
      }
    }
  });

  it('同一个键的占位符两边一致', () => {
    for (const key of Object.keys(EN)) {
      expect(placeholders(ZH[key] ?? ''), `${key} 的占位符不一致`).toEqual(
        placeholders(EN[key] ?? '')
      );
    }
  });

  it('未知语言回落到 en-US，未知键回落到键名本身', () => {
    expect(translate('fr-FR', 'menu.file')).toBe(EN['menu.file']);
    expect(translate('en-US', 'no.such.key')).toBe('no.such.key');
  });

  /**
   * 缺键时 `t()` 把键名原样返回，所以**可选文案不能靠 `t()` 自己判存在** ——
   * 每套主题的一句话描述就是这么用的（用户主题与将来新增的出厂主题都可能没有），
   * 少了这道判断，界面上会漏出 `theme.description.user:xxx` 这种噪音。
   */
  it('hasMessage 能分辨缺键', () => {
    expect(hasMessage('zh-CN', 'theme.description.gruvbox')).toBe(true);
    expect(hasMessage('en-US', 'theme.description.gruvbox')).toBe(true);
    expect(hasMessage('zh-CN', 'theme.description.user:abc')).toBe(false);
  });

  /**
   * 文案是**纯文本渲染**的（`FieldRow` 直接把 `description` 放进 `<p>`，不解析 Markdown），
   * 所以文案里写 `**强调**` 只会在界面上露出两个星号。
   *
   * 这条是补的哨兵：中文侧 `settings.general.autoSaveDelayDescription` 曾经写着
   * 「它是**延迟**不是间隔」，一直显示成字面的星号，而**没有任何东西会发现** ——
   * 它不是缺键、不是空值、占位符也对得上。星号在注释里写惯了，顺手带进文案是很自然的事。
   *
   * 只禁 `**`：单独一个 `*` 在中文文案里可能是有意为之（比如「*必填」）。
   */
  it('文案里不出现 Markdown 强调标记 —— 描述是纯文本渲染的', () => {
    for (const [locale, dict] of Object.entries(DICTIONARIES)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value, `${locale} 的 ${key} 含 Markdown 强调标记`).not.toContain('**');
      }
    }
  });
});
