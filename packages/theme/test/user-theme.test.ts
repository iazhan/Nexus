import { describe, it, expect } from 'vitest';
import {
  isUserThemeId,
  newUserThemeId,
  parseUserTheme,
  serializeUserTheme,
  USER_THEME_PREFIX,
  type UserTheme,
} from '../src/user-theme.js';
import { nexusDarkSeeds, type NexusThemeScheme } from '../src/seeds.js';

const scheme = (overrides?: Record<string, string>): NexusThemeScheme => ({
  ...nexusDarkSeeds,
  palette: { ...nexusDarkSeeds.palette },
  ...(overrides ? { overrides } : {}),
});

const userTheme = (overrides?: Record<string, string>): UserTheme => ({
  id: 'user:test',
  scheme: scheme(overrides),
});

/** 造一份存档：把 `id` / `scheme` 之外的东西也塞进去，模拟手改过的 localStorage。 */
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
    expect(parsed?.scheme.name).toBe(nexusDarkSeeds.name);
    expect(parsed?.scheme.palette).toEqual(nexusDarkSeeds.palette);
    expect(parsed?.scheme.overrides).toBeUndefined();
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
    expect(parseUserTheme(raw({ id: 'nexus-light', scheme: scheme() }))).toBeNull();
    expect(parseUserTheme(raw({ id: 'user:', scheme: scheme() }))).toBeNull();
  });

  it('缺一个槽位就拒收 —— 缺了只能猜，猜出来的配色用户看不懂为什么是这样', () => {
    const { base0F: _dropped, ...rest } = nexusDarkSeeds.palette;
    expect(parseUserTheme(raw({ id: 'user:test', scheme: { ...scheme(), palette: rest } }))).toBeNull();
  });

  it('槽位值不是颜色', () => {
    const palette = { ...nexusDarkSeeds.palette, base00: 'not-a-colour' };
    expect(parseUserTheme(raw({ id: 'user:test', scheme: { ...scheme(), palette } }))).toBeNull();
  });

  it('variant 不是 light/dark', () => {
    expect(parseUserTheme(raw({ id: 'user:test', scheme: { ...scheme(), variant: 'sepia' } }))).toBeNull();
  });

  it('name 为空', () => {
    expect(parseUserTheme(raw({ id: 'user:test', scheme: { ...scheme(), name: '' } }))).toBeNull();
  });

  it('版本号高于当前格式 —— 不猜未来格式', () => {
    expect(parseUserTheme(raw({ version: 99, id: 'user:test', scheme: scheme() }))).toBeNull();
  });

  it('版本号不是数字', () => {
    expect(parseUserTheme(raw({ version: '1', id: 'user:test', scheme: scheme() }))).toBeNull();
  });

  it('没有版本号时按当前格式读（手写的存档）', () => {
    expect(parseUserTheme(raw({ id: 'user:test', scheme: scheme() }))?.id).toBe('user:test');
  });
});

describe('用户主题解析 · 可选部分坏项丢掉、不拒整份', () => {
  it('坏掉的覆盖项被丢掉，好的保留', () => {
    const parsed = parseUserTheme(
      raw({
        id: 'user:test',
        scheme: { ...scheme(), overrides: { 'bg-canvas': '#101010', 'bg-surface': 'nope' } },
      }),
    );

    expect(parsed?.scheme.overrides).toEqual({ 'bg-canvas': '#101010' });
  });

  it('覆盖项全坏时整个字段消失', () => {
    const parsed = parseUserTheme(
      raw({ id: 'user:test', scheme: { ...scheme(), overrides: { 'bg-canvas': 'nope' } } }),
    );

    expect(parsed?.scheme.overrides).toBeUndefined();
  });

  it('tuning 里非有限数被丢掉', () => {
    const parsed = parseUserTheme(
      raw({
        id: 'user:test',
        scheme: { ...scheme(), tuning: { surfaceHover: 0.2, surfaceActive: 'x', quote: NaN } },
      }),
    );

    expect(parsed?.scheme.tuning).toEqual({ surfaceHover: 0.2 });
  });

  it('author 不是字符串时整个字段消失', () => {
    const parsed = parseUserTheme(raw({ id: 'user:test', scheme: { ...scheme(), author: 7 } }));
    expect(parsed?.scheme.author).toBeUndefined();
  });
});
