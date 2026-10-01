import { describe, it, expect, afterEach } from 'vitest';
import {
  EDITOR_FONT_CANDIDATES,
  EDITOR_FONT_FAMILIES,
  EDITOR_FONT_FAMILY_DEFAULT,
  editorFontStack,
  parseEditorFontFamily,
  sanitizeFontFamily
} from '../src/settings/preference-specs.js';
import {
  localFontFamilies,
  normalizeFamilies,
  resetLocalFontCache
} from '../src/settings/system-fonts.js';

/**
 * 编辑器字体这一项的值域是**开放**的（三档预设 + 任意家族名），所以纯逻辑层的重点不是
 * 「认不认得出合法值」，而是两件别处测不到的事：
 *
 * 1. **清洗**：值来自自由输入框，最后会被拼进一段 CSS（`editorFontStack` 给它加引号）。
 *    清洗不彻底不会报错，只会静默变成「选了字体没生效」。
 * 2. **栈的兜底链**：用户挑的字体常常只有拉丁字形，后面那截 `var(--font-family)` 是中文
 *    不落到浏览器默认衬线字体的唯一原因。
 */
describe('字体家族 · 清洗', () => {
  it('去掉能改变 CSS 字符串边界的字符（引号与反斜杠）', () => {
    expect(sanitizeFontFamily('a"b')).toBe('ab');
    expect(sanitizeFontFamily("a'b")).toBe('ab');
    expect(sanitizeFontFamily('a\\b')).toBe('ab');
  });

  it('去掉能开始新声明 / 新块的字符，以及逗号', () => {
    expect(sanitizeFontFamily('x; y{}()z, w')).toBe('x yz w');
  });

  it('去掉控制字符 —— CSS 字符串里不许有裸换行', () => {
    expect(sanitizeFontFamily('a\nb\tc')).toBe('abc');
  });

  it('首尾空白去掉，长度截到 64', () => {
    expect(sanitizeFontFamily('  KaiTi  ')).toBe('KaiTi');
    expect(sanitizeFontFamily('x'.repeat(200))).toHaveLength(64);
  });

  it('正常的家族名原样通过 —— 中英文都是', () => {
    expect(sanitizeFontFamily('Microsoft YaHei')).toBe('Microsoft YaHei');
    expect(sanitizeFontFamily('楷体')).toBe('楷体');
    expect(sanitizeFontFamily('Noto Sans SC')).toBe('Noto Sans SC');
  });
});

describe('字体家族 · 值 → 字体栈', () => {
  it('三档预设各自查表，不在这一层重写字体列表', () => {
    for (const preset of EDITOR_FONT_FAMILIES) {
      expect(editorFontStack(preset.value)).toBe(preset.stack);
    }
  });

  it('任意家族名被引号包起来，后面接界面的字体栈兜底', () => {
    // 兜底链是必需的：Inter / JetBrains Mono 这类只有拉丁字形，没有它中文会掉到默认衬线。
    expect(editorFontStack('Georgia')).toBe('"Georgia", var(--font-family)');
    expect(editorFontStack('楷体')).toBe('"楷体", var(--font-family)');
  });

  it('空串与「只剩非法字符」都回落等宽档 —— 与「没有值」的语义一致', () => {
    expect(editorFontStack('')).toBe('var(--font-mono)');
    expect(editorFontStack('   ')).toBe('var(--font-mono)');
    expect(editorFontStack('";{}')).toBe('var(--font-mono)');
  });

  it('**注入尝试跳不出那对引号** —— 引号与逗号都被吃掉，兜底链仍在原位', () => {
    expect(editorFontStack('x", sans-serif')).toBe('"x sans-serif", var(--font-family)');
    // 反斜杠能转义引号，也是同一个洞，一并堵上。
    expect(editorFontStack('x\\", monospace')).toBe('"x monospace", var(--font-family)');
  });
});

describe('字体家族 · 存档解析的失败方向', () => {
  it('null / 空串 / 全空白都回落到默认档', () => {
    expect(parseEditorFontFamily(null)).toBe(EDITOR_FONT_FAMILY_DEFAULT);
    expect(parseEditorFontFamily('')).toBe(EDITOR_FONT_FAMILY_DEFAULT);
    expect(parseEditorFontFamily('   ')).toBe(EDITOR_FONT_FAMILY_DEFAULT);
  });

  it('三档预设的**键**原样保留 —— 它们是老存档里已有的值', () => {
    for (const preset of EDITOR_FONT_FAMILIES) {
      expect(parseEditorFontFamily(preset.value)).toBe(preset.value);
    }
  });

  it('家族名原样保留 —— 这一项**不校验白名单**，用户装了什么字体只有他知道', () => {
    expect(parseEditorFontFamily('KaiTi')).toBe('KaiTi');
    expect(parseEditorFontFamily('  楷体  ')).toBe('楷体');
  });

  it('归一化就在这一层：带引号的写法与不带引号的写法落到同一个值', () => {
    // 不在这里收口的话，输入框里多一个引号就会让同一个字体出现两种存档写法，
    // 而 `store` 判「值变了没有」比的正是这个字符串。
    expect(parseEditorFontFamily('Kai"Ti')).toBe('KaiTi');
    expect(parseEditorFontFamily('KaiTi')).toBe('KaiTi');
  });

  it('全是非法字符时回落默认档，而不是留一个空串', () => {
    expect(parseEditorFontFamily('";{}')).toBe(EDITOR_FONT_FAMILY_DEFAULT);
  });
});

describe('字体家族 · 候选清单', () => {
  it('没有重复项（大小写不敏感）', () => {
    const keys = EDITOR_FONT_CANDIDATES.map((name) => name.toLocaleLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('**每一项都不含会被清洗掉的字符** —— 否则「选中的」与「存下来的」不是一个东西', () => {
    for (const name of EDITOR_FONT_CANDIDATES) {
      expect(sanitizeFontFamily(name)).toBe(name);
    }
  });
});

describe('本机字体枚举', () => {
  afterEach(() => {
    resetLocalFontCache();
    delete (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts;
  });

  it('去重（大小写不敏感）、丢空项、按名排序', () => {
    expect(normalizeFamilies(['Georgia', '  ', 'GEORGIA', 'Arial', 'B Font'])).toEqual([
      'Arial',
      'B Font',
      'Georgia'
    ]);
  });

  it('中文名不会被丢掉或改写 —— 排序按当前语言，所以只断言成员', () => {
    const families = normalizeFamilies(['楷体', '宋体', '楷体']);

    expect(families).toHaveLength(2);
    expect(families).toContain('楷体');
    expect(families).toContain('宋体');
  });

  it('没有这个 API 时返回空数组，而不是抛错 —— 候选表少一截不影响这一项能用', async () => {
    await expect(localFontFamilies()).resolves.toEqual([]);
  });

  it('有 API 时返回归一化后的家族名', async () => {
    (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts = () =>
      Promise.resolve([{ family: 'B Font' }, { family: 'A Font' }, { family: 'a font' }]);

    await expect(localFontFamilies()).resolves.toEqual(['A Font', 'B Font']);
  });

  it('**失败即清空缓存** —— 一次失败被永久记住的话，用户放开权限也再看不到候选表', async () => {
    let calls = 0;
    (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts = () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('denied'))
        : Promise.resolve([{ family: 'KaiTi' }]);
    };

    await expect(localFontFamilies()).resolves.toEqual([]);
    await expect(localFontFamilies()).resolves.toEqual(['KaiTi']);
    expect(calls).toBe(2);
  });

  it('成功之后只问一次 —— 设置窗口是短命窗口，字体列表在它开着的期间不会变', async () => {
    let calls = 0;
    (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts = () => {
      calls += 1;
      return Promise.resolve([{ family: 'KaiTi' }]);
    };

    await localFontFamilies();
    await localFontFamilies();
    expect(calls).toBe(1);
  });
});
