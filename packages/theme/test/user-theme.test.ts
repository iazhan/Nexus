import { describe, it, expect } from 'vitest';
import {
  isUserThemeId,
  mergeUserThemes,
  newUserThemeId,
  parseUserTheme,
  parseUserThemes,
  serializeUserTheme,
  serializeUserThemes,
  userThemeBaseName,
  userThemeMergeTarget,
  userThemeName,
  userThemeVariants,
  USER_THEME_PREFIX,
  type UserTheme,
} from '../src/user-theme.js';
import { nexusDarkSeeds, nexusLightSeeds, type NexusThemeScheme } from '../src/seeds.js';

const scheme = (overrides?: Record<string, string>): NexusThemeScheme => ({
  ...nexusDarkSeeds,
  palette: { ...nexusDarkSeeds.palette },
  ...(overrides ? { overrides } : {}),
});

const lightScheme = (): NexusThemeScheme => ({
  ...nexusLightSeeds,
  palette: { ...nexusLightSeeds.palette },
});

const userTheme = (overrides?: Record<string, string>): UserTheme => ({
  id: 'user:test',
  variants: { dark: scheme(overrides) },
});

/** 造一份存档：把该有的字段之外的东西也塞进去，模拟手改过的 localStorage。 */
const raw = (payload: unknown): string => JSON.stringify(payload);

describe('用户主题 id', () => {
  it('认 `user:` 前缀，空后缀不算', () => {
    expect(isUserThemeId('user:abc')).toBe(true);
    expect(isUserThemeId(USER_THEME_PREFIX)).toBe(false);
    expect(isUserThemeId('nexus-light')).toBe(false);
    expect(isUserThemeId('userish:abc')).toBe(false);
  });

  it('新 id 带前缀，两次不相同', () => {
    const a = newUserThemeId();
    expect(isUserThemeId(a)).toBe(true);
    expect(a).not.toBe(newUserThemeId());
  });
});

describe('用户主题序列化', () => {
  it('往返一致', () => {
    const theme = userTheme({ 'bg-canvas': '#101010' });
    expect(parseUserTheme(serializeUserTheme(theme))).toEqual(theme);
  });

  it('往返丢掉 undefined 的可选字段，值仍等价', () => {
    const parsed = parseUserTheme(serializeUserTheme(userTheme()));
    expect(parsed?.variants.dark?.name).toBe(nexusDarkSeeds.name);
    expect(parsed?.variants.dark?.palette).toEqual(nexusDarkSeeds.palette);
    expect(parsed?.variants.dark?.overrides).toBeUndefined();
  });

  /** 明暗两版都要能往返 —— 只用 id 做键的话第二版会被第一版盖掉。 */
  it('明暗两版一起往返', () => {
    const theme: UserTheme = {
      id: 'user:both',
      variants: { light: lightScheme(), dark: scheme() },
    };
    const parsed = parseUserTheme(serializeUserTheme(theme));

    expect(parsed?.variants.light?.variant).toBe('light');
    expect(parsed?.variants.dark?.variant).toBe('dark');
    expect(parsed?.variants.light?.palette).toEqual(nexusLightSeeds.palette);
  });
});

describe('用户主题解析 · 坏数据一律回落 null', () => {
  it('null 与空串', () => {
    expect(parseUserTheme(null)).toBeNull();
    expect(parseUserTheme('')).toBeNull();
  });

  it('不是 JSON', () => {
    expect(parseUserTheme('{ not json')).toBeNull();
  });

  it('JSON 但不是对象', () => {
    expect(parseUserTheme('[]')).toBeNull();
    expect(parseUserTheme('"user:abc"')).toBeNull();
  });

  it('id 不是 user: 前缀 —— 内置主题不可被写成用户主题', () => {
    expect(parseUserTheme(raw({ id: 'nexus-light', variants: { dark: scheme() } }))).toBeNull();
    expect(parseUserTheme(raw({ id: 'user:', variants: { dark: scheme() } }))).toBeNull();
  });

  it('缺一个槽位就拒收 —— 缺了只能猜，猜出来的配色用户看不懂为什么是这样', () => {
    const { base0F: _dropped, ...rest } = nexusDarkSeeds.palette;
    expect(
      parseUserTheme(raw({ id: 'user:test', variants: { dark: { ...scheme(), palette: rest } } }))
    ).toBeNull();
  });

  it('槽位值不是颜色', () => {
    const palette = { ...nexusDarkSeeds.palette, base00: 'not-a-colour' };
    expect(
      parseUserTheme(raw({ id: 'user:test', variants: { dark: { ...scheme(), palette } } }))
    ).toBeNull();
  });

  it('variant 不是 light/dark', () => {
    expect(
      parseUserTheme(raw({ id: 'user:test', variants: { dark: { ...scheme(), variant: 'sepia' } } }))
    ).toBeNull();
  });

  it('name 为空', () => {
    expect(
      parseUserTheme(raw({ id: 'user:test', variants: { dark: { ...scheme(), name: '' } } }))
    ).toBeNull();
  });

  it('版本号高于当前格式 —— 不猜未来格式', () => {
    expect(parseUserTheme(raw({ version: 99, id: 'user:test', variants: { dark: scheme() } }))).toBeNull();
  });

  it('版本号不是数字', () => {
    expect(parseUserTheme(raw({ version: '2', id: 'user:test', variants: { dark: scheme() } }))).toBeNull();
  });

  /** 一边读坏了就整份拒收 —— 静默丢掉那一边，用户会以为深色那版还在。 */
  it('两版里有一版坏掉 → 整份拒收，不静默丢一边', () => {
    expect(
      parseUserTheme(
        raw({
          version: 2,
          id: 'user:test',
          variants: { light: lightScheme(), dark: { ...scheme(), name: '' } },
        })
      )
    ).toBeNull();
  });

  it('variants 为空对象 / 缺失 → 拒收（一个「主题」没有任何一版）', () => {
    expect(parseUserTheme(raw({ version: 2, id: 'user:test', variants: {} }))).toBeNull();
    expect(parseUserTheme(raw({ version: 2, id: 'user:test' }))).toBeNull();
  });
});

describe('用户主题解析 · 可选部分坏项丢掉、不拒整份', () => {
  const withDark = (patch: Record<string, unknown>): string =>
    raw({ version: 2, id: 'user:test', variants: { dark: { ...scheme(), ...patch } } });

  it('坏掉的覆盖项被丢掉，好的保留', () => {
    const parsed = parseUserTheme(
      withDark({ overrides: { 'bg-canvas': '#101010', 'bg-surface': 'nope' } })
    );

    expect(parsed?.variants.dark?.overrides).toEqual({ 'bg-canvas': '#101010' });
  });

  it('覆盖项全坏时整个字段消失', () => {
    const parsed = parseUserTheme(withDark({ overrides: { 'bg-canvas': 'nope' } }));
    expect(parsed?.variants.dark?.overrides).toBeUndefined();
  });

  it('tuning 里非有限数被丢掉', () => {
    const parsed = parseUserTheme(
      withDark({ tuning: { surfaceHover: 0.2, surfaceActive: 'x', quote: NaN } })
    );

    expect(parsed?.variants.dark?.tuning).toEqual({ surfaceHover: 0.2 });
  });

  it('author 不是字符串时整个字段消失', () => {
    const parsed = parseUserTheme(withDark({ author: 7 }));
    expect(parsed?.variants.dark?.author).toBeUndefined();
  });
});

/**
 * v1 是 `{ id, scheme }`（用户主题还没有模式轴时）。**旧存档不能丢** —— 用户装过一次的主题
 * 不会因为升级而消失。
 */
describe('用户主题解析 · v1 存档迁移', () => {
  it('v1 的暗版归到 dark，浅版归到 light', () => {
    const dark = parseUserTheme(raw({ version: 1, id: 'user:old', scheme: scheme() }));
    expect(dark?.variants.dark?.variant).toBe('dark');
    expect(dark?.variants.light).toBeUndefined();

    const light = parseUserTheme(
      raw({ version: 1, id: 'user:old', scheme: { ...lightScheme() } })
    );
    expect(light?.variants.light?.variant).toBe('light');
    expect(light?.variants.dark).toBeUndefined();
  });

  /** 更早的存档里连 `version` 都没有，靠「有没有 `variants`」判形态。 */
  it('没有版本号的 v1 也认', () => {
    const parsed = parseUserTheme(raw({ id: 'user:old', scheme: scheme() }));
    expect(parsed?.variants.dark?.palette).toEqual(nexusDarkSeeds.palette);
  });

  it('v1 的覆盖项与 tuning 一起带过来', () => {
    const parsed = parseUserTheme(
      raw({
        version: 1,
        id: 'user:old',
        scheme: { ...scheme({ 'bg-canvas': '#101010' }), tuning: { surfaceHover: 0.3 } },
      })
    );

    expect(parsed?.variants.dark?.overrides).toEqual({ 'bg-canvas': '#101010' });
    expect(parsed?.variants.dark?.tuning).toEqual({ surfaceHover: 0.3 });
  });

  it('迁移结果就是 v2 —— 再序列化一次读回来还是它', () => {
    const migrated = parseUserTheme(raw({ version: 1, id: 'user:old', scheme: scheme() }))!;
    expect(parseUserTheme(serializeUserTheme(migrated))).toEqual(migrated);
  });
});

describe('用户主题的变体与名字', () => {
  it('变体顺序恒为 light → dark，与对象键序无关', () => {
    expect(userThemeVariants({ id: 'u', variants: { dark: scheme(), light: lightScheme() } })).toEqual([
      'light',
      'dark'
    ]);
    expect(userThemeVariants({ id: 'u', variants: { dark: scheme() } })).toEqual(['dark']);
  });

  it('名字取明版优先，只有暗版时取暗版', () => {
    expect(
      userThemeName({ id: 'u', variants: { light: lightScheme(), dark: scheme() } })
    ).toBe(nexusLightSeeds.name);
    expect(userThemeName({ id: 'u', variants: { dark: scheme() } })).toBe(nexusDarkSeeds.name);
  });
});

/** 一套只有一边的用户主题。`base` 用来造 `Ayu Dark` / `Ayu Light` 这类同名对。 */
const oneSided = (
  id: string,
  variant: 'light' | 'dark',
  base: string
): UserTheme => ({
  id,
  variants: {
    [variant]: {
      ...(variant === 'light' ? lightScheme() : scheme()),
      name: base
    }
  }
});

describe('用户主题列表的读写（v3）', () => {
  it('列表往返', () => {
    const list = [oneSided('user:a', 'light', 'A'), oneSided('user:b', 'dark', 'B')];
    expect(parseUserThemes(serializeUserThemes(list))).toEqual(list);
  });

  it('空串 / 坏 JSON / 非 JSON 一律回空列表', () => {
    expect(parseUserThemes(null)).toEqual([]);
    expect(parseUserThemes('')).toEqual([]);
    expect(parseUserThemes('{ not json')).toEqual([]);
    expect(parseUserThemes('"user:abc"')).toEqual([]);
  });

  /** v1 / v2 存档里只有一套（单个对象），读成单元素列表是迁移的全部意义。 */
  it('单个对象读成单元素列表', () => {
    const theme = oneSided('user:a', 'dark', 'A');
    expect(parseUserThemes(JSON.stringify(theme))).toEqual([theme]);
  });

  it('裸数组也认（手写过的存档）', () => {
    const theme = oneSided('user:a', 'dark', 'A');
    expect(parseUserThemes(JSON.stringify([theme]))).toEqual([theme]);
  });

  /** 坏项丢掉而不是拒整份 —— 一份存档里坏了一条，不该让其余几套主题一起消失。 */
  it('坏项丢掉，好的留下', () => {
    const good = oneSided('user:a', 'dark', 'A');
    const raw = JSON.stringify({ version: 3, themes: [{ id: 'user:bad' }, good] });
    expect(parseUserThemes(raw)).toEqual([good]);
  });

  it('重复 id 只留第一份 —— 后一份会让「哪份生效」不可预测', () => {
    const first = oneSided('user:a', 'dark', 'First');
    const second = oneSided('user:a', 'light', 'Second');
    expect(parseUserThemes(JSON.stringify({ version: 3, themes: [first, second] }))).toEqual([first]);
  });
});

describe('同名明暗两套的合并判据', () => {
  it('基名去掉结尾的模式词', () => {
    expect(userThemeBaseName('Ayu Dark')).toBe('Ayu');
    expect(userThemeBaseName('Ayu Light')).toBe('Ayu');
    expect(userThemeBaseName('Solarized Light')).toBe('Solarized');
    expect(userThemeBaseName('Ayu')).toBe('Ayu');
  });

  /** 整名就是一个模式词时不能剥成空串 —— 那会让所有叫 `Dark` 的主题互相当成同一套。 */
  it('整名就是模式词时原样返回', () => {
    expect(userThemeBaseName('Dark')).toBe('Dark');
    expect(userThemeBaseName('light')).toBe('light');
  });

  it('同基名 + 互补变体 → 找到候选', () => {
    const dark = oneSided('user:a', 'dark', 'Ayu Dark');
    const light = oneSided('user:b', 'light', 'Ayu Light');
    expect(userThemeMergeTarget(dark, [dark, light])?.id).toBe('user:b');
    expect(userThemeMergeTarget(light, [dark, light])?.id).toBe('user:a');
  });

  it('基名不同 → 没有候选', () => {
    const dark = oneSided('user:a', 'dark', 'Ayu Dark');
    const other = oneSided('user:b', 'light', 'Nord Light');
    expect(userThemeMergeTarget(dark, [dark, other])).toBeNull();
  });

  /** 两边都有浅色时合并必然丢掉一份，而丢哪一份没有好答案 —— 宁可不提。 */
  it('变体重叠 → 没有候选', () => {
    const a = oneSided('user:a', 'light', 'Ayu Light');
    const b = oneSided('user:b', 'light', 'Ayu');
    expect(userThemeMergeTarget(a, [a, b])).toBeNull();
  });

  it('只有自己时没有候选', () => {
    const only = oneSided('user:a', 'dark', 'Ayu Dark');
    expect(userThemeMergeTarget(only, [only])).toBeNull();
  });

  it('合并取并集，名字归一到 target 的', () => {
    const dark = oneSided('user:a', 'dark', 'Ayu Dark');
    const light = oneSided('user:b', 'light', 'Ayu Light');
    const merged = mergeUserThemes(dark, light);

    expect(merged.id).toBe('user:a');
    expect(userThemeVariants(merged)).toEqual(['light', 'dark']);
    expect(merged.variants.light?.name).toBe('Ayu Dark');
    expect(merged.variants.dark?.name).toBe('Ayu Dark');
  });

  it('同一边冲突时保留 target 的', () => {
    const target: UserTheme = {
      id: 'user:a',
      variants: { dark: { ...scheme(), name: 'Keep' } }
    };
    const source: UserTheme = {
      id: 'user:b',
      variants: { dark: { ...scheme(), name: 'Drop' } }
    };
    expect(mergeUserThemes(target, source).variants.dark?.name).toBe('Keep');
  });
});
